-- Phase 4: shoppers (PRD 9.3, 9.4). A shopper is a person who signed in at ONE business with a WhatsApp code or Google; the
-- same phone at two businesses is two rows that never meet (S-11). There is no password. Sellers and their staff stay in `users`.
-- A guest who buys has no row here: the order holds what the order needs.
CREATE TABLE shoppers (
  id                serial PRIMARY KEY,
  tenant_id         integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- International format, digits only after the plus. Null for a Google-only shopper, and after erasure (9.18).
  phone             text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  phone_verified_at timestamptz,
  google_sub        text CHECK (google_sub IS NULL OR length(google_sub) BETWEEN 1 AND 255),
  email             text NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  name              text NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  -- A Phase 0 account this shopper came from (5.16). Its password hash is never copied.
  legacy_user_id    integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz,
  -- Set when personal data was erased (9.18): phone, google_sub, email and name are then empty and stay so.
  erased_at         timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (erased_at IS NOT NULL OR phone IS NOT NULL OR google_sub IS NOT NULL),
  FOREIGN KEY (tenant_id, legacy_user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL (legacy_user_id)
);
CREATE UNIQUE INDEX shoppers_phone_idx ON shoppers (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX shoppers_google_idx ON shoppers (tenant_id, google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX shoppers_legacy_idx ON shoppers (tenant_id, legacy_user_id) WHERE legacy_user_id IS NOT NULL;
SELECT fence_tenant_table('shoppers');

-- A shopper's sign-in on one device. Only the hash of the token is stored. `method` records how they proved who they are.
CREATE TABLE shopper_sessions (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id   integer NOT NULL,
  token_hash   text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  method       text NOT NULL CHECK (method IN ('whatsapp_otp', 'google', 'shared')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shopper_sessions_shopper_idx ON shopper_sessions (tenant_id, shopper_id);
CREATE INDEX shopper_sessions_expiry_idx ON shopper_sessions (expires_at);
SELECT fence_tenant_table('shopper_sessions');

-- One-time codes (9.3, 9.5). The code and the phone number are stored only as keyed hashes; neither is ever logged.
-- 6 digits, 5 minutes, 3 wrong tries, 5 sends an hour per number: `attempts`, and the rows per phone_hash in the last hour.
CREATE TABLE shopper_otps (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose        text NOT NULL CHECK (purpose IN ('sign_in', 'cod')),
  phone_hash     text NOT NULL CHECK (length(phone_hash) = 64),
  code_hash      text NOT NULL CHECK (length(code_hash) = 64),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  -- What a cash-on-delivery code unlocks: the checkout attempt's idempotency key.
  checkout_key   text NOT NULL DEFAULT '' CHECK (length(checkout_key) <= 80),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  -- Wrong three times, or replaced by a newer code.
  invalidated_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX shopper_otps_phone_idx ON shopper_otps (tenant_id, phone_hash, created_at DESC);
CREATE INDEX shopper_otps_expiry_idx ON shopper_otps (expires_at);
SELECT fence_tenant_table('shopper_otps');

-- Saved delivery addresses (9.4). An order copies the one it used, so editing here never changes a past order (S-14).
CREATE TABLE shopper_addresses (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id integer NOT NULL,
  name       text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  phone      text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  line1      text NOT NULL CHECK (length(line1) BETWEEN 3 AND 200),
  line2      text NOT NULL DEFAULT '' CHECK (length(line2) <= 200),
  landmark   text NOT NULL DEFAULT '' CHECK (length(landmark) <= 120),
  city       text NOT NULL CHECK (length(city) BETWEEN 1 AND 60),
  -- A GST state code from INDIAN_STATES (src/contracts/orders.js).
  state_code text NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),
  pincode    text NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  kind       text NOT NULL DEFAULT 'home' CHECK (kind IN ('home', 'work', 'other')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shopper_addresses_shopper_idx ON shopper_addresses (tenant_id, shopper_id);
-- At most one default per shopper (S-13).
CREATE UNIQUE INDEX shopper_addresses_default_idx ON shopper_addresses (tenant_id, shopper_id) WHERE is_default;
SELECT fence_tenant_table('shopper_addresses');

-- Limits that must hold across every process (9.3 sends per IP, 9.5 order attempts: S-18). One row per thing being counted;
-- the key is a hash, so no address or number is stored. The window starts at the first hit and the count starts again once
-- it has passed. Platform only: reached through platform.rateLimit, never by business code.
CREATE TABLE rate_limit_hits (
  key          text PRIMARY KEY CHECK (length(key) = 64),
  window_start timestamptz NOT NULL DEFAULT now(),
  hits         integer NOT NULL DEFAULT 1
);
CREATE INDEX rate_limit_hits_age_idx ON rate_limit_hits (window_start);

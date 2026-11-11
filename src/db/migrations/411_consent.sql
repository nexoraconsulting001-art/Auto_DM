-- Phase 4: shopper data protection (PRD 9.18, India's DPDP Act 2023). Consent is per business and per purpose; marketing
-- needs its own yes per channel, and a yes at one business never counts at another (9.22).

-- The notice a shopper is shown, numbered. A new wording is a new version; old ones stay, so a record always names what was read.
-- Bilingual: English and Hindi. It names the business, never the platform.
CREATE TABLE consent_notices (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version    integer NOT NULL CHECK (version >= 1),
  body_en    text NOT NULL CHECK (length(body_en) BETWEEN 1 AND 4000),
  body_hi    text NOT NULL CHECK (length(body_hi) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);
SELECT fence_tenant_table('consent_notices', 'SELECT, INSERT');

-- The ledger: one row each time a person says yes or no to one purpose. The newest row for a person, purpose and channel is
-- what holds now, so taking consent back is one more row, as easy as giving it. Insert-only.
-- A person is a signed-in shopper, or a guest known only by keyed hashes of the phone or email they typed at checkout, or a
-- browser (visitor_id) for the analytics and ads choice (7.14).
CREATE TABLE consent_records (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id     integer,
  phone_hash     text CHECK (phone_hash IS NULL OR length(phone_hash) = 64),
  email_hash     text CHECK (email_hash IS NULL OR length(email_hash) = 64),
  visitor_id     uuid,
  purpose        text NOT NULL CHECK (purpose IN ('fulfilment', 'order_updates', 'marketing', 'analytics_ads')),
  -- The channel a marketing or order-update yes is for; '' where the purpose has none.
  channel        text NOT NULL DEFAULT '' CHECK (channel IN ('', 'whatsapp', 'email')),
  granted        boolean NOT NULL,
  notice_version integer NOT NULL,
  -- Where it was said: sign-in, checkout (guests too), the account page, the cookie choice, an unsubscribe link, a STOP reply.
  source         text NOT NULL CHECK (source IN ('sign_in', 'checkout', 'account', 'banner', 'unsubscribe', 'reply', 'seller', 'migration')),
  order_id       integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (shopper_id IS NOT NULL OR phone_hash IS NOT NULL OR email_hash IS NOT NULL OR visitor_id IS NOT NULL),
  CHECK (purpose IN ('marketing', 'order_updates') OR channel = ''),
  CHECK (purpose <> 'marketing' OR channel <> ''),
  FOREIGN KEY (tenant_id, notice_version) REFERENCES consent_notices(tenant_id, version),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE SET NULL (order_id)
);
CREATE INDEX consent_records_shopper_idx ON consent_records (tenant_id, shopper_id, purpose, channel, id DESC) WHERE shopper_id IS NOT NULL;
CREATE INDEX consent_records_phone_idx ON consent_records (tenant_id, phone_hash, purpose, channel, id DESC) WHERE phone_hash IS NOT NULL;
CREATE INDEX consent_records_email_idx ON consent_records (tenant_id, email_hash, purpose, channel, id DESC) WHERE email_hash IS NOT NULL;
CREATE INDEX consent_records_visitor_idx ON consent_records (tenant_id, visitor_id, id DESC) WHERE visitor_id IS NOT NULL;
-- Insert-only for business code. Erasing a shopper removes their rows through the foreign key.
SELECT fence_tenant_table('consent_records', 'SELECT, INSERT');

-- Each business's own privacy, terms, refund and shipping pages, on its own domain, readable logged out (S-61).
CREATE TABLE policy_pages (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('privacy', 'terms', 'refund', 'shipping')),
  body       text NOT NULL DEFAULT '' CHECK (length(body) <= 40000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);
SELECT fence_tenant_table('policy_pages');

-- The grievance contact the privacy page shows (S-62).
CREATE TABLE privacy_settings (
  tenant_id         integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  grievance_name    text NOT NULL DEFAULT '' CHECK (length(grievance_name) <= 120),
  grievance_email   text NOT NULL DEFAULT '' CHECK (length(grievance_email) <= 254),
  grievance_phone   text NOT NULL DEFAULT '' CHECK (length(grievance_phone) <= 20),
  grievance_address text NOT NULL DEFAULT '' CHECK (length(grievance_address) <= 400),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('privacy_settings');

-- A shopper asking for their data to be erased or shown (9.18). On erasure, personal data goes and tax records stay with
-- the personal data masked (S-63). The row itself holds no personal data, so it can stay as the record that it was done.
CREATE TABLE data_requests (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id   integer,
  kind         text NOT NULL CHECK (kind IN ('erasure', 'access')),
  status       text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'processing', 'completed', 'rejected')),
  -- How it arrived: the account page, or the seller acting on a request made another way.
  source       text NOT NULL DEFAULT 'account' CHECK (source IN ('account', 'seller', 'grievance')),
  -- Counts of what was erased or masked, by table. Numbers only.
  summary      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(summary) = 'object'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE SET NULL (shopper_id)
);
CREATE INDEX data_requests_open_idx ON data_requests (requested_at) WHERE status IN ('requested', 'processing');
SELECT fence_tenant_table('data_requests');

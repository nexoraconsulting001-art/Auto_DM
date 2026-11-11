-- Phase 5 (PRD 10.2): access tokens, rotating refresh tokens, devices, and the minimum app version.
-- Platform-only like 500: no tenant_id fence, no grant to bhava_app, reached only through db.platform.

-- One sign-in on one device. Every refresh token it ever had and every access session hang off it, so revoking the
-- family ends all of them at once. subject_kind lets the shopper app (Phase 6) use the same tables.
CREATE TABLE token_families (
  id            bigserial PRIMARY KEY,
  subject_kind  text NOT NULL CHECK (subject_kind IN ('user', 'shopper')),
  person_id     bigint REFERENCES people(id) ON DELETE CASCADE,
  shopper_id    bigint,
  -- A shopper family belongs to one business; a seller's follows the person across theirs.
  tenant_id     integer REFERENCES tenants(id) ON DELETE CASCADE,
  device_id     text NOT NULL DEFAULT '' CHECK (length(device_id) <= 64),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('signed_out', 'token_reuse', 'device_revoked', 'staff_removed', 'account_deleted', 'support')),
  CHECK ((subject_kind = 'user' AND person_id IS NOT NULL AND shopper_id IS NULL AND tenant_id IS NULL)
      OR (subject_kind = 'shopper' AND shopper_id IS NOT NULL AND tenant_id IS NOT NULL AND person_id IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX token_families_person_idx ON token_families (person_id) WHERE revoked_at IS NULL;
CREATE INDEX token_families_device_idx ON token_families (person_id, device_id) WHERE revoked_at IS NULL;
CREATE INDEX token_families_shopper_idx ON token_families (tenant_id, shopper_id) WHERE revoked_at IS NULL;

-- A refresh token is stored only as a hash and is used once: using it writes used_at and replaced_by in the same
-- transaction that creates the next one. A token presented with used_at already set was stolen or replayed, and the
-- whole family is revoked. tenant_id and user_id are the seller account the next access token opens.
CREATE TABLE refresh_tokens (
  id          bigserial PRIMARY KEY,
  family_id   bigint NOT NULL REFERENCES token_families(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  tenant_id   integer,
  user_id     integer,
  used_at     timestamptz,
  replaced_by bigint REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  CHECK (replaced_by IS NULL OR used_at IS NOT NULL)
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

-- The devices a person is signed in on (Settings > Devices). device_id is chosen by the app at install and sent with
-- every sign-in. reauth_secret_hash is the hash of the secret the app keeps behind fingerprint or face unlock.
CREATE TABLE auth_devices (
  id                 bigserial PRIMARY KEY,
  person_id          bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  device_id          text NOT NULL CHECK (device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  name               text NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  platform           text NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  app                text NOT NULL DEFAULT 'owner' CHECK (app IN ('owner', 'shopper')),
  app_version        text NOT NULL DEFAULT '' CHECK (length(app_version) <= 20),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  reauth_secret_hash text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, device_id)
);

-- A browser sign-in (Google) ends in the system browser, not in the app. The callback writes a single-use code here,
-- bound to the PKCE challenge the app sent at the start, and redirects to the app's scheme with it; the app swaps the
-- code and its verifier for a session. Lives 60 seconds. Only the hash of the code is stored.
CREATE TABLE auth_handoffs (
  id         bigserial PRIMARY KEY,
  code_hash  text NOT NULL UNIQUE,
  person_id  bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  challenge  text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  -- signin opens a session; link adds the identity to the person already signed in.
  purpose    text NOT NULL DEFAULT 'signin' CHECK (purpose IN ('signin', 'link')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_handoffs_expiry_idx ON auth_handoffs (expires_at);

-- The oldest app version the API still answers (PRD 10.2). The owner app has one row per platform and no business;
-- a shopper app's rows belong to its business.
CREATE TABLE app_min_versions (
  id          serial PRIMARY KEY,
  app         text NOT NULL CHECK (app IN ('owner', 'shopper')),
  tenant_id   integer REFERENCES tenants(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('android', 'ios')),
  min_version text NOT NULL CHECK (min_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'),
  store_url   text NOT NULL CHECK (store_url ~ '^https://'),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((app = 'owner') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX app_min_versions_key ON app_min_versions (app, COALESCE(tenant_id, 0), platform);

-- An access session is a row of sessions like the others, looked up on every request, so revoking is immediate.
-- family_id ties it to its refresh family, device_id to the device, and fresh_until is how long a re-auth lasts.
ALTER TABLE sessions DROP CONSTRAINT sessions_kind_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_kind_check CHECK (kind IN ('cookie', 'bearer', 'access'));
ALTER TABLE sessions ADD COLUMN family_id bigint REFERENCES token_families(id) ON DELETE CASCADE;
ALTER TABLE sessions ADD COLUMN device_id text;
ALTER TABLE sessions ADD COLUMN fresh_until timestamptz;
ALTER TABLE sessions ADD CONSTRAINT sessions_access_family CHECK (kind <> 'access' OR family_id IS NOT NULL);
CREATE INDEX sessions_family_idx ON sessions (family_id) WHERE family_id IS NOT NULL;

-- These four name a business in tenant_id but are the platform's alone. Row-level security with the usual policy and
-- no grant keeps the rule "every table with a tenant_id is fenced" true: bhava_app still cannot touch them at all.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['token_families', 'refresh_tokens', 'app_min_versions', 'review_logins'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_fence ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', tbl);
  END LOOP;
END $$;

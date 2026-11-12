-- Phase 6 (PRD 10.7): the branded shopper app's sessions. Owner: src/modules/app-api.
-- Every install holds an app session, a guest one included, so "in the app" always means "carries a valid app token",
-- never "sent a header". The refresh side reuses Phase 5's token_families and refresh_tokens with subject_kind = 'shopper'.

-- Sign in with Apple for shoppers (iOS): the subject, per business like Google's.
ALTER TABLE shoppers ADD COLUMN apple_sub text CHECK (apple_sub IS NULL OR length(apple_sub) BETWEEN 1 AND 255);
CREATE UNIQUE INDEX shoppers_apple_idx ON shoppers (tenant_id, apple_sub) WHERE apple_sub IS NOT NULL;
DO $$
DECLARE
  check_name text;
BEGIN
  SELECT c.conname INTO check_name FROM pg_constraint c
  WHERE c.conrelid = 'shoppers'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%erased_at IS NOT NULL%' AND pg_get_constraintdef(c.oid) LIKE '%google_sub IS NOT NULL%';
  IF check_name IS NULL THEN RAISE EXCEPTION 'the shoppers identity check was not found'; END IF;
  EXECUTE format('ALTER TABLE shoppers DROP CONSTRAINT %I', check_name);
END $$;
ALTER TABLE shoppers ADD CONSTRAINT shoppers_identity_check
  CHECK (erased_at IS NOT NULL OR phone IS NOT NULL OR google_sub IS NOT NULL OR apple_sub IS NOT NULL);

-- A shopper family belongs to one business; a null shopper_id is a guest install. The composite key makes a family that
-- names another business's shopper impossible, and erasing a shopper ends their families (and so their app sessions).
ALTER TABLE token_families ALTER COLUMN shopper_id TYPE integer;
ALTER TABLE token_families ADD COLUMN app_platform text CHECK (app_platform IS NULL OR app_platform IN ('android', 'ios'));
ALTER TABLE token_families ADD CONSTRAINT token_families_tenant_id_key UNIQUE (tenant_id, id);
DO $$
DECLARE
  check_name text;
BEGIN
  SELECT c.conname INTO check_name FROM pg_constraint c
  WHERE c.conrelid = 'token_families'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%person_id IS NOT NULL%';
  IF check_name IS NULL THEN RAISE EXCEPTION 'the token_families subject check was not found'; END IF;
  EXECUTE format('ALTER TABLE token_families DROP CONSTRAINT %I', check_name);
END $$;
ALTER TABLE token_families ADD CONSTRAINT token_families_subject_check CHECK (
     (subject_kind = 'user' AND person_id IS NOT NULL AND shopper_id IS NULL AND tenant_id IS NULL)
  OR (subject_kind = 'shopper' AND person_id IS NULL AND tenant_id IS NOT NULL));
ALTER TABLE token_families ADD CONSTRAINT token_families_shopper_fk
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE;
-- A shopper family's refresh_tokens rows carry tenant_id and a null user_id; their (tenant_id, user_id) key is MATCH SIMPLE.

-- One access token of one app install, looked up on every request. Written with its family and refresh token in one
-- db.platform transaction; read through the fenced db, so another business's token is never found.
CREATE TABLE shopper_app_sessions (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  family_id     bigint NOT NULL,
  shopper_id    integer,                                   -- NULL = a guest
  device_id     text NOT NULL CHECK (device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  platform      text NOT NULL CHECK (platform IN ('android', 'ios')),
  app_version   text NOT NULL DEFAULT '' CHECK (length(app_version) <= 20),
  method        text NOT NULL CHECK (method IN ('guest', 'whatsapp_otp', 'google', 'apple', 'review')),
  token_hash    text NOT NULL UNIQUE CHECK (length(token_hash) = 43),   -- tokenHash() of src/contracts/accounts.js
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, family_id) REFERENCES token_families(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE,
  CHECK ((method = 'guest') = (shopper_id IS NULL))
);
CREATE INDEX shopper_app_sessions_shopper_idx ON shopper_app_sessions (tenant_id, shopper_id);
CREATE INDEX shopper_app_sessions_family_idx ON shopper_app_sessions (family_id);
CREATE INDEX shopper_app_sessions_expiry_idx ON shopper_app_sessions (expires_at);
SELECT fence_tenant_table('shopper_app_sessions');

-- A browser sign-in (Google) handed back to the app: single use, 60 seconds, bound to the app's PKCE challenge. Hash only.
CREATE TABLE shopper_app_handoffs (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_hash   text NOT NULL UNIQUE,
  shopper_id  integer NOT NULL,
  method      text NOT NULL CHECK (method IN ('google')),
  challenge   text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shopper_app_handoffs_expiry_idx ON shopper_app_handoffs (expires_at);
SELECT fence_tenant_table('shopper_app_handoffs');

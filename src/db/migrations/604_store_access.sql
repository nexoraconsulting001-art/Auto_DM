-- Phase 6 (PRD 10.9): the business's own developer accounts and our access to them. Owner: src/modules/store-access.
-- The app is published under the business's own name, so each store account is the business's. We never ask for an Apple or
-- Google password: App Store Connect access is an API key the owner creates (the .p8 is stored encrypted, never returned),
-- and Play access is our one service account (PLAY_SERVICE_ACCOUNT) that the owner invites in their Play Console.
CREATE TABLE store_access (
  id                        serial PRIMARY KEY,
  tenant_id                 integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform                  text NOT NULL CHECK (platform IN ('android', 'ios')),
  account_type              text NOT NULL DEFAULT 'unknown' CHECK (account_type IN ('unknown', 'personal', 'organisation')),
  legal_name                text NOT NULL DEFAULT '' CHECK (length(legal_name) <= 200),
  duns_status               text NOT NULL DEFAULT 'unknown' CHECK (duns_status IN ('unknown', 'not_needed', 'waiting', 'have')),
  duns_requested_at         timestamptz,
  -- Android, personal account: made after 13 Nov 2023, so 14 days of closed testing come first. NULL = not answered.
  play_account_after_cutoff boolean,
  closed_test_status        text NOT NULL DEFAULT 'not_needed' CHECK (closed_test_status IN ('not_needed', 'required', 'running', 'done')),
  closed_test_started_at    timestamptz,
  closed_test_testers       integer CHECK (closed_test_testers IS NULL OR closed_test_testers >= 0),
  credential_kind           text NOT NULL DEFAULT 'none' CHECK (credential_kind IN ('none', 'asc_api_key', 'play_service_account')),
  key_id                    text NOT NULL DEFAULT '' CHECK (key_id = '' OR key_id ~ '^[A-Z0-9]{10}$'),         -- not a secret
  issuer_id                 text NOT NULL DEFAULT '' CHECK (issuer_id = '' OR issuer_id ~ '^[0-9a-f-]{36}$'),   -- not a secret
  key_enc                   text,                                                                              -- the .p8, platform.secrets.encrypt
  key_last4                 text NOT NULL DEFAULT '' CHECK (length(key_last4) <= 4),
  access_status             text NOT NULL DEFAULT 'not_checked' CHECK (access_status IN ('not_checked', 'ok', 'role_too_low', 'invalid', 'unreachable')),
  role_found                text NOT NULL DEFAULT '' CHECK (length(role_found) <= 60),
  role_needed               text NOT NULL DEFAULT '' CHECK (length(role_needed) <= 60),
  checked_at                timestamptz,
  updated_by                integer,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, platform),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (updated_by),
  CHECK (platform = 'ios' OR credential_kind IN ('none', 'play_service_account')),
  CHECK (platform = 'android' OR credential_kind IN ('none', 'asc_api_key')),
  CHECK (key_enc IS NULL OR credential_kind = 'asc_api_key'),
  CHECK (key_enc IS NULL OR key_enc LIKE 'v1.%')                -- only the encrypted form is ever stored
);
SELECT fence_tenant_table('store_access');

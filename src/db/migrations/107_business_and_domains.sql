-- Phase 1, foundation (PRD 5.1, 5.4, 5.5, 6.8): what the Platform Console's create form records, and custom domains.

ALTER TABLE tenants
  ADD COLUMN legal_name         text NOT NULL DEFAULT '',
  ADD COLUMN website            text NOT NULL DEFAULT '',
  ADD COLUMN expected_ig_handle text NOT NULL DEFAULT '',               -- what the form said; connecting proves the real one
  ADD COLUMN billing_cycle      text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
  ADD COLUMN timezone           text NOT NULL DEFAULT 'Asia/Kolkata';

-- Rows from before this migration were added by hand and already route, so they count as verified. New ones start 'pending'.
ALTER TABLE tenant_domains
  ADD COLUMN status          text NOT NULL DEFAULT 'verified' CHECK (status IN ('pending', 'verified', 'failed', 'stopped')),
  ADD COLUMN verify_token    text NOT NULL DEFAULT '',
  ADD COLUMN is_primary      boolean NOT NULL DEFAULT false,
  ADD COLUMN verified_at     timestamptz,
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN check_until     timestamptz,                               -- the DNS check stops after 72 hours
  ADD COLUMN redirect_to     text NOT NULL DEFAULT '',                  -- a replaced primary keeps a 301 here for 12 months
  ADD COLUMN redirect_until  timestamptz,
  ADD CONSTRAINT tenant_domains_tenant_key UNIQUE (tenant_id, domain);
CREATE UNIQUE INDEX tenant_domains_primary_idx ON tenant_domains (tenant_id) WHERE is_primary;
CREATE INDEX tenant_domains_pending_idx ON tenant_domains (check_until) WHERE status = 'pending';

-- The console signs in with an emailed code plus TOTP (PRD 5.5). The TOTP secret is encrypted by the secrets module.
ALTER TABLE platform_users
  ADD COLUMN totp_secret_enc  text NOT NULL DEFAULT '',
  ADD COLUMN totp_enrolled_at timestamptz;

-- Platform only, so no grant. Only a hash of the code is stored.
CREATE TABLE platform_login_codes (
  id               bigserial PRIMARY KEY,
  platform_user_id integer NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  code_hash        text NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_login_codes_user_idx ON platform_login_codes (platform_user_id, created_at DESC);

-- Raw event exports: super admins only, each with a reason, and the file deleted after a limited time (PRD 5.14). Platform only.
CREATE TABLE raw_exports (
  id          bigserial PRIMARY KEY,
  actor       text NOT NULL,
  reason      text NOT NULL,
  tables      text[] NOT NULL,
  tenant_ids  integer[] NOT NULL,
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  row_count   integer NOT NULL DEFAULT 0,
  storage_key text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  deleted_at  timestamptz
);
CREATE INDEX raw_exports_expiry_idx ON raw_exports (expires_at) WHERE deleted_at IS NULL;

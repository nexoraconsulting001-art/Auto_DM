-- Phase 1: the accounts a business connects and their tokens (PRD 4.2, 4.14, 6.10). A token is encrypted by
-- the secrets module. token_version is the compare-and-swap for refresh: a writer updates WHERE token_version = the
-- one it read and adds 1. An account or Page belongs to exactly one business, so webhooks route by its id alone.

ALTER TABLE ig_accounts
  ADD COLUMN app_scoped_id     text NOT NULL DEFAULT '',                  -- Instagram Login gives two ids; ig_user_id is the one webhooks carry
  ADD COLUMN login_kind        text NOT NULL DEFAULT 'instagram' CHECK (login_kind IN ('instagram', 'unified')),
  ADD COLUMN page_id           text NOT NULL DEFAULT '',                  -- Unified Login: the Page behind the account
  ADD COLUMN status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reconnect_needed', 'deauthorized')),
  ADD COLUMN status_reason     text NOT NULL DEFAULT '',
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN token_version     integer NOT NULL DEFAULT 0,
  ADD COLUMN token_issued_at   timestamptz,
  ADD COLUMN token_expires_at  timestamptz,                               -- null: Meta gave no expiry
  ADD COLUMN granted_scopes    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN subscribed_fields text[] NOT NULL DEFAULT '{}',
  ADD COLUMN subscribed_at     timestamptz,
  ADD COLUMN refresh_failures  integer NOT NULL DEFAULT 0,
  ADD COLUMN last_refresh_at   timestamptz,
  ADD COLUMN next_refresh_at   timestamptz,
  ADD COLUMN connected_by      integer,
  ADD COLUMN connected_at      timestamptz,
  ADD CONSTRAINT ig_accounts_tenant_key UNIQUE (tenant_id, ig_user_id),
  ADD CONSTRAINT ig_accounts_connected_by_fk FOREIGN KEY (tenant_id, connected_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (connected_by);
CREATE INDEX ig_accounts_connected_by_idx ON ig_accounts (tenant_id, connected_by);
CREATE INDEX ig_accounts_refresh_idx ON ig_accounts (next_refresh_at) WHERE access_token_enc <> '';

-- Facebook Pages (PRD 6.10, behind FACEBOOK_PAGES). Same token rules, and a Page problem never touches Instagram.
CREATE TABLE fb_pages (
  page_id           text PRIMARY KEY,
  tenant_id         integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              text NOT NULL DEFAULT '',
  linked_ig_user_id text NOT NULL DEFAULT '',
  access_token_enc  text NOT NULL DEFAULT '',
  token_version     integer NOT NULL DEFAULT 0,
  token_updated_at  timestamptz,
  token_expires_at  timestamptz,
  granted_scopes    text[] NOT NULL DEFAULT '{}',
  subscribed_fields text[] NOT NULL DEFAULT '{}',
  subscribed_at     timestamptz,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reconnect_needed', 'deauthorized')),
  status_reason     text NOT NULL DEFAULT '',
  status_changed_at timestamptz,
  connected_by      integer,
  connected_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, page_id),
  FOREIGN KEY (tenant_id, connected_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (connected_by)
);
CREATE INDEX fb_pages_connected_by_idx ON fb_pages (tenant_id, connected_by);
SELECT fence_tenant_table('fb_pages');

-- The OAuth `state` of a connect in progress. Meta redirects to one registered address with no business in it, so
-- the callback finds the business from this row through db.platform. Only a hash is stored, and a state works once.
CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider IN ('instagram', 'unified', 'facebook')),
  user_id    integer,
  return_to  text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL (user_id)
);
CREATE INDEX oauth_states_user_idx ON oauth_states (tenant_id, user_id);
CREATE INDEX oauth_states_expiry_idx ON oauth_states (expires_at);
SELECT fence_tenant_table('oauth_states');

-- One row per alert sent, so the daily job never repeats the 14, 7, 3 or 1 day warning for one token.
CREATE TABLE token_alerts (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  account_id    text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('expiry_14d', 'expiry_7d', 'expiry_3d', 'expiry_1d', 'rejected', 'deauthorized')),
  token_version integer NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, account_id, kind, token_version)
);
SELECT fence_tenant_table('token_alerts');

-- Meta's data deletion callback (PRD 4.14). tenant_id is null when no business has the account, and has no foreign
-- key because the record outlives a closed business. The public status page reads it by code through db.platform.
CREATE TABLE data_deletion_requests (
  id                bigserial PRIMARY KEY,
  confirmation_code text NOT NULL UNIQUE,
  tenant_id         integer,
  channel           text NOT NULL DEFAULT 'instagram' CHECK (channel IN ('instagram', 'facebook')),
  account_id        text NOT NULL,
  status            text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'completed')),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  due_at            timestamptz NOT NULL DEFAULT now() + interval '30 days',
  completed_at      timestamptz
);
CREATE INDEX data_deletion_tenant_idx ON data_deletion_requests (tenant_id, requested_at);
CREATE INDEX data_deletion_due_idx ON data_deletion_requests (due_at) WHERE status = 'requested';
SELECT fence_tenant_table('data_deletion_requests', 'SELECT');

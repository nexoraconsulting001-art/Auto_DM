-- Phase 2: the seller's own Meta Pixel and Google Analytics on their buyer pages (PRD 7.14). Off by default. Bhava never adds a tag of its own.
-- Nothing loads and nothing is sent until the shopper accepts "Analytics and ads": see platform.consent.

-- Tokens are encrypted by the secrets module (5.15) and never leave the server.
CREATE TABLE tag_settings (
  tenant_id           integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  meta_enabled        boolean NOT NULL DEFAULT false,
  meta_pixel_id       text NOT NULL DEFAULT '',
  meta_capi_token_enc text NOT NULL DEFAULT '',
  ga4_enabled         boolean NOT NULL DEFAULT false,
  ga4_measurement_id  text NOT NULL DEFAULT '',
  ga4_api_secret_enc  text NOT NULL DEFAULT '',
  updated_by          integer,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (updated_by)
);
CREATE INDEX tag_settings_updated_by_idx ON tag_settings (tenant_id, updated_by);
SELECT fence_tenant_table('tag_settings');

-- Server-side events waiting to go, sent from the queue with retries. event_id is shared with the browser hit so duplicates can be removed.
-- payload holds no IP, no user agent and no unhashed email or phone.
CREATE TABLE tag_outbox (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('meta', 'ga4')),
  event_id        text NOT NULL,
  event_name      text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  last_error      text NOT NULL DEFAULT '',                             -- a code or kind, never a token or a response body
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, event_name, event_id)
);
CREATE INDEX tag_outbox_due_idx ON tag_outbox (next_attempt_at) WHERE status = 'queued';
SELECT fence_tenant_table('tag_outbox');

-- The tag health panel (7.14). Raise the three-day alert with a dedupeKey, so it fires once per run of failures.
CREATE TABLE tag_health_daily (
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('meta', 'ga4')),
  day           date NOT NULL,
  sent          integer NOT NULL DEFAULT 0 CHECK (sent >= 0),
  failed        integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  last_error    text NOT NULL DEFAULT '',
  last_error_at timestamptz,
  PRIMARY KEY (tenant_id, provider, day)
);
SELECT fence_tenant_table('tag_health_daily');

-- Which plan has which Phase 2 feature. Exports are on every tier and need no row here. report.monthly is from migration 004.
WITH tiers (code, rank) AS (VALUES ('free', 0), ('t1', 1), ('t2', 2), ('t3', 3), ('t4', 4), ('t5', 5)),
ladder (feature, from_rank) AS (VALUES
  ('traffic.pages', 2), ('reports.scheduled', 2), ('reporting.api', 2), ('tags.pixels', 2),
  ('traffic.commerce', 3), ('tags.commerce', 3), ('funnels.commerce', 3), ('cohorts.buyers', 3), ('funnel.sales', 3)
)
INSERT INTO plan_features (plan_code, feature)
  SELECT tiers.code, ladder.feature FROM ladder JOIN tiers ON tiers.rank >= ladder.from_rank;

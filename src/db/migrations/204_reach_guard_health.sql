-- Phase 2: Reach Guard and Account Health (PRD 7.6, 7.7). Slow mode itself is compliance's (4.3); Reach Guard only asks for it.

CREATE TABLE reach_guard_state (
  tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref        integer NOT NULL,
  state              text NOT NULL DEFAULT 'learning' CHECK (state IN ('learning', 'normal', 'watch', 'tripped', 'permission_needed')),
  state_since        timestamptz NOT NULL DEFAULT now(),
  settled_days       integer NOT NULL DEFAULT 0 CHECK (settled_days >= 0),
  media_counted      integer NOT NULL DEFAULT 0 CHECK (media_counted >= 0),
  baseline_reach     bigint,
  reach_drop_percent smallint NOT NULL DEFAULT 60 CHECK (reach_drop_percent BETWEEN 40 AND 80),
  media_drop_percent smallint NOT NULL DEFAULT 50 CHECK (media_drop_percent BETWEEN 30 AND 70),
  clear_percent      smallint NOT NULL DEFAULT 80 CHECK (clear_percent BETWEEN 60 AND 95),
  evaluated_at       timestamptz,
  PRIMARY KEY (tenant_id, account_ref),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('reach_guard_state');

-- What was worked out each settled day. scope is 'account' for daily reach, or a content kind for the median 24h reach of its last 10 media.
CREATE TABLE reach_guard_baselines (
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref integer NOT NULL,
  day         date NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('account', 'feed', 'reel', 'carousel', 'story')),
  baseline    bigint,
  sample      integer NOT NULL DEFAULT 0 CHECK (sample >= 0),
  observed    bigint,
  PRIMARY KEY (tenant_id, account_ref, day, scope),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('reach_guard_baselines');

-- One row per trip. Each alert_*_at is filled once, so a repeat evaluation can never alert again (N-23).
CREATE TABLE reach_guard_trips (
  id              serial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref     integer NOT NULL,
  trigger         text NOT NULL CHECK (trigger IN ('reach_days', 'media_24h')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  cleared_at      timestamptz,
  baseline        bigint,
  drop_percent    smallint,
  observed        jsonb NOT NULL DEFAULT '[]',
  alert_push_at   timestamptz,
  alert_banner_at timestamptz,
  alert_email_at  timestamptz,
  override_at     timestamptz,
  override_by     integer,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, override_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (override_by)
);
CREATE UNIQUE INDEX reach_guard_trips_open_idx ON reach_guard_trips (tenant_id, account_ref) WHERE cleared_at IS NULL;
CREATE INDEX reach_guard_trips_account_idx ON reach_guard_trips (tenant_id, account_ref, started_at DESC);
CREATE INDEX reach_guard_trips_override_idx ON reach_guard_trips (tenant_id, override_by);
SELECT fence_tenant_table('reach_guard_trips');

-- Account Health now, and one row per day kept 90 days (7.7). deductions is [{ code, points, message, fix }].
CREATE TABLE account_health (
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref integer NOT NULL,
  score       smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  band        text NOT NULL CHECK (band IN ('good', 'watch', 'at_risk')),
  deductions  jsonb NOT NULL DEFAULT '[]',
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_ref),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX account_health_worst_idx ON account_health (score, computed_at);
SELECT fence_tenant_table('account_health');

CREATE TABLE account_health_history (
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref integer NOT NULL,
  day         date NOT NULL,
  score       smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  band        text NOT NULL CHECK (band IN ('good', 'watch', 'at_risk')),
  deductions  jsonb NOT NULL DEFAULT '[]',
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_ref, day),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX account_health_history_retention_idx ON account_health_history (day);
SELECT fence_tenant_table('account_health_history');

-- Calls to Meta per account and hour, for the error rate and throttling checks (7.7). Filled from a module's onMetaCall. excluded counts
-- what is not an API failure: story error 10 and empty data sets.
CREATE TABLE meta_call_stats (
  tenant_id         integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel           text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  account_id        text NOT NULL,
  hour              timestamptz NOT NULL,
  calls             integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  errors            integer NOT NULL DEFAULT 0 CHECK (errors >= 0),
  excluded          integer NOT NULL DEFAULT 0 CHECK (excluded >= 0),
  buc_throttles     integer NOT NULL DEFAULT 0 CHECK (buc_throttles >= 0),
  max_usage_percent integer NOT NULL DEFAULT 0 CHECK (max_usage_percent >= 0),
  PRIMARY KEY (tenant_id, channel, account_id, hour)
);
CREATE INDEX meta_call_stats_retention_idx ON meta_call_stats (hour);
SELECT fence_tenant_table('meta_call_stats');

-- Every cause of slow mode that is still in force, as { trigger: until }. slow_mode_trigger and slow_mode_until stay the summary the gate reads,
-- and one cause ending can no longer end slow mode for another that is still going.
ALTER TABLE account_rate_state ADD COLUMN slow_mode_holds jsonb NOT NULL DEFAULT '{}';

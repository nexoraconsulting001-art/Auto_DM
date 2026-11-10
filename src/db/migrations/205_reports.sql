-- Phase 2: Explore's saved views, custom funnels, downloads, scheduled reports and reporting API keys (PRD 7.9, 7.11 to 7.13).

CREATE TABLE saved_views (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by    integer,
  name          text NOT NULL,
  visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team')),
  definition    jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX saved_views_list_idx ON saved_views (tenant_id, visibility, id DESC);
CREATE INDEX saved_views_created_by_idx ON saved_views (tenant_id, created_by);
SELECT fence_tenant_table('saved_views');

-- A view pinned to one person's dashboard as a card.
CREATE TABLE saved_view_pins (
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  view_id   integer NOT NULL,
  user_id   integer NOT NULL,
  position  integer NOT NULL DEFAULT 0,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, view_id, user_id),
  FOREIGN KEY (tenant_id, view_id) REFERENCES saved_views(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX saved_view_pins_user_idx ON saved_view_pins (tenant_id, user_id, position);
SELECT fence_tenant_table('saved_view_pins');

CREATE TABLE custom_funnels (
  id             serial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  steps          jsonb NOT NULL,
  count_by       text NOT NULL DEFAULT 'session' CHECK (count_by IN ('session', 'visitor')),
  window_minutes integer NOT NULL DEFAULT 1440 CHECK (window_minutes BETWEEN 30 AND 10080),
  created_by     integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX custom_funnels_created_by_idx ON custom_funnels (tenant_id, created_by);
SELECT fence_tenant_table('custom_funnels');

-- A file a seller asked for. Summary data only: a seller can never get a raw event log (7.13). Past expires_at the file is gone.
CREATE TABLE report_downloads (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by integer,
  source       text NOT NULL CHECK (source IN ('explore', 'funnel', 'cohort', 'account_daily', 'media', 'story_finals', 'content_funnel', 'health_history')),
  format       text NOT NULL CHECK (format IN ('csv', 'xlsx')),
  definition   jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  background   boolean NOT NULL DEFAULT false,
  row_count    integer CHECK (row_count >= 0),
  storage_key  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  expires_at   timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (requested_by)
);
CREATE INDEX report_downloads_list_idx ON report_downloads (tenant_id, id DESC);
CREATE INDEX report_downloads_user_idx ON report_downloads (tenant_id, requested_by);
CREATE INDEX report_downloads_queue_idx ON report_downloads (created_at) WHERE status = 'queued';
CREATE INDEX report_downloads_expiry_idx ON report_downloads (expires_at) WHERE status = 'ready';
SELECT fence_tenant_table('report_downloads');

-- Any saved view, on a schedule (7.13). next_run_at is in UTC, worked out from the hour in the business's time zone.
CREATE TABLE scheduled_reports (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  view_id       integer NOT NULL,
  frequency     text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  hour_of_day   smallint NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),
  weekday       smallint CHECK (weekday BETWEEN 0 AND 6),
  day_of_month  smallint CHECK (day_of_month BETWEEN 1 AND 28),
  format        text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'xlsx')),
  enabled       boolean NOT NULL DEFAULT true,
  next_run_at   timestamptz NOT NULL,
  last_run_at   timestamptz,
  created_by    integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, view_id) REFERENCES saved_views(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX scheduled_reports_view_idx ON scheduled_reports (tenant_id, view_id);
CREATE INDEX scheduled_reports_created_by_idx ON scheduled_reports (tenant_id, created_by);
CREATE INDEX scheduled_reports_due_idx ON scheduled_reports (next_run_at) WHERE enabled;
SELECT fence_tenant_table('scheduled_reports');

-- Team members by default; the owner can add an outside address (7.13).
CREATE TABLE scheduled_report_recipients (
  id                  serial PRIMARY KEY,
  tenant_id           integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scheduled_report_id integer NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('team', 'outside')),
  user_id             integer,
  email               text NOT NULL DEFAULT '',
  added_by            integer,
  added_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((kind = 'team' AND user_id IS NOT NULL) OR (kind = 'outside' AND email <> '')),
  FOREIGN KEY (tenant_id, scheduled_report_id) REFERENCES scheduled_reports(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, added_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (added_by)
);
CREATE UNIQUE INDEX scheduled_report_recipients_user_idx ON scheduled_report_recipients (tenant_id, scheduled_report_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX scheduled_report_recipients_email_idx ON scheduled_report_recipients (tenant_id, scheduled_report_id, lower(email)) WHERE email <> '';
CREATE INDEX scheduled_report_recipients_report_idx ON scheduled_report_recipients (tenant_id, scheduled_report_id);
CREATE INDEX scheduled_report_recipients_user_fk_idx ON scheduled_report_recipients (tenant_id, user_id);
CREATE INDEX scheduled_report_recipients_added_by_idx ON scheduled_report_recipients (tenant_id, added_by);
SELECT fence_tenant_table('scheduled_report_recipients');

-- One row per report built. A rerun finds the row for that period and does not send again.
CREATE TABLE report_runs (
  id                  bigserial PRIMARY KEY,
  tenant_id           integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('weekly', 'monthly', 'scheduled')),
  scheduled_report_id integer,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  status              text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'sent', 'failed', 'skipped')),
  storage_key         text NOT NULL DEFAULT '',                         -- the monthly PDF kept in the admin
  summary             jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, scheduled_report_id) REFERENCES scheduled_reports(tenant_id, id) ON DELETE SET NULL (scheduled_report_id)
);
CREATE UNIQUE INDEX report_runs_period_idx ON report_runs (tenant_id, kind, COALESCE(scheduled_report_id, 0), period_start);
CREATE INDEX report_runs_scheduled_idx ON report_runs (tenant_id, scheduled_report_id);
CREATE INDEX report_runs_list_idx ON report_runs (tenant_id, kind, period_start DESC);
SELECT fence_tenant_table('report_runs');

-- The outbox: every report email and owner push waits here. Email is from Bhava, and push and email are sent from this table once
-- the notifications framework (PRD 5.13, 10.5) is built, the same way alerts are.
CREATE TABLE report_deliveries (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_run_id   bigint,
  download_id     bigint,
  channel         text NOT NULL CHECK (channel IN ('email', 'push')),
  user_id         integer,
  to_address      text NOT NULL DEFAULT '',
  subject         text NOT NULL,
  body            text NOT NULL,
  attachment_key  text NOT NULL DEFAULT '',
  attachment_name text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, report_run_id) REFERENCES report_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, download_id) REFERENCES report_downloads(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL (user_id)
);
CREATE INDEX report_deliveries_run_idx ON report_deliveries (tenant_id, report_run_id);
CREATE INDEX report_deliveries_download_idx ON report_deliveries (tenant_id, download_id);
CREATE INDEX report_deliveries_user_idx ON report_deliveries (tenant_id, user_id);
CREATE INDEX report_deliveries_queue_idx ON report_deliveries (created_at) WHERE status = 'queued';
SELECT fence_tenant_table('report_deliveries');

-- One row per person per business. token_hash is what a one-click unsubscribe link carries, hashed; found through db.platform.
CREATE TABLE report_preferences (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    integer NOT NULL,
  weekly     boolean NOT NULL DEFAULT true,
  monthly    boolean NOT NULL DEFAULT true,
  token_hash text NOT NULL UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('report_preferences');

-- Per business, owner only, shown once and stored as a hash (7.13). The hash is unique across businesses and found through db.platform,
-- since the key is the only thing that says which business a call is for.
CREATE TABLE reporting_api_keys (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_prefix   text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  scope        text NOT NULL DEFAULT 'analytics:read' CHECK (scope = 'analytics:read'),
  created_by   integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   integer,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (revoked_by)
);
CREATE INDEX reporting_api_keys_list_idx ON reporting_api_keys (tenant_id, id DESC);
CREATE INDEX reporting_api_keys_created_by_idx ON reporting_api_keys (tenant_id, created_by);
CREATE INDEX reporting_api_keys_revoked_by_idx ON reporting_api_keys (tenant_id, revoked_by);
SELECT fence_tenant_table('reporting_api_keys');

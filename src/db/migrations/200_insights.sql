-- Phase 2: Instagram and Facebook insights, cached per business (PRD 7.1 to 7.3, 7.8). Screens and reports read these tables and never
-- call Meta at page load. A NULL figure is an empty data set from Meta, shown as "No data", and is never 0.

-- One row per connected account Bhava collects for. Everything else in this file hangs off it.
CREATE TABLE analytics_accounts (
  id                  serial PRIMARY KEY,
  tenant_id           integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  ig_user_id          text,
  fb_page_id          text,
  account_id          text GENERATED ALWAYS AS (COALESCE(ig_user_id, fb_page_id)) STORED,
  collecting_since    date NOT NULL,                                    -- days before this show "Not collected"
  permission          text NOT NULL DEFAULT 'ok' CHECK (permission IN ('ok', 'denied')),
  permission_at       timestamptz,
  stories_edge        text NOT NULL DEFAULT 'unknown' CHECK (stories_edge IN ('unknown', 'available', 'unavailable')),
  online_followers    text NOT NULL DEFAULT 'unknown' CHECK (online_followers IN ('unknown', 'available', 'unavailable')),
  followers_count     integer CHECK (followers_count >= 0),
  followers_at        timestamptz,
  media_listed_at     timestamptz,
  last_refresh_at     timestamptz,                                      -- the newest figure this account has
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel, account_id),
  CONSTRAINT analytics_accounts_one_account CHECK (
    (channel = 'instagram' AND ig_user_id IS NOT NULL AND fb_page_id IS NULL)
    OR (channel = 'facebook' AND fb_page_id IS NOT NULL AND ig_user_id IS NULL)
  ),
  FOREIGN KEY (tenant_id, ig_user_id) REFERENCES ig_accounts(tenant_id, ig_user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, fb_page_id) REFERENCES fb_pages(tenant_id, page_id) ON DELETE CASCADE
);
CREATE INDEX analytics_accounts_ig_idx ON analytics_accounts (tenant_id, ig_user_id);
CREATE INDEX analytics_accounts_fb_idx ON analytics_accounts (tenant_id, fb_page_id);
SELECT fence_tenant_table('analytics_accounts');

-- Daily account metrics (7.1). A breakdown is its own row: breakdown = '' is the total. Days past Meta's 90 stay here.
CREATE TABLE insight_daily (
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref     integer NOT NULL,
  day             date NOT NULL,
  metric          text NOT NULL CHECK (metric <> 'impressions'),
  breakdown       text NOT NULL DEFAULT '',
  breakdown_value text NOT NULL DEFAULT '',
  value           bigint,                                               -- NULL: Meta returned nothing for this day
  estimated       boolean NOT NULL DEFAULT false,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_ref, day, metric, breakdown, breakdown_value),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('insight_daily');

-- follower_demographics and engaged_audience_demographics, replaced weekly (7.1, 7.8).
CREATE TABLE insight_demographics (
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref     integer NOT NULL,
  metric          text NOT NULL CHECK (metric IN ('follower_demographics', 'engaged_audience_demographics')),
  timeframe       text NOT NULL CHECK (timeframe IN ('this_week', 'this_month')),
  breakdown       text NOT NULL CHECK (breakdown IN ('age', 'gender', 'city', 'country')),
  breakdown_value text NOT NULL,
  value           bigint NOT NULL CHECK (value >= 0),
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_ref, metric, timeframe, breakdown, breakdown_value),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('insight_demographics');

-- online_followers by weekday and hour in the business's time zone, when Meta still gives it (7.5).
CREATE TABLE insight_online_followers (
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref integer NOT NULL,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  hour        smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  value       bigint NOT NULL CHECK (value >= 0),
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_ref, weekday, hour),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('insight_online_followers');

-- A post, reel, carousel (the album only) or story. `latest` is what screens show; a late revision from Meta overwrites it.
-- A story is a reference: its media is never downloaded (4.14). Deleted media keeps its figures and stops being polled.
CREATE TABLE insight_media (
  id                   bigserial PRIMARY KEY,
  tenant_id            integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref          integer NOT NULL,
  media_id             text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('feed', 'reel', 'carousel', 'story')),
  caption              text NOT NULL DEFAULT '',
  permalink            text NOT NULL DEFAULT '',
  thumbnail_url        text NOT NULL DEFAULT '',
  posted_at            timestamptz,
  deleted_at           timestamptz,                                     -- "Deleted on Instagram"
  latest               jsonb NOT NULL DEFAULT '{}',
  latest_breakdowns    jsonb NOT NULL DEFAULT '{}',
  latest_at            timestamptz,
  historic_impressions bigint,                                          -- before 2 July 2024 only; never merged into views
  story_expires_at     timestamptz,
  story_tracking       text NOT NULL DEFAULT 'edge' CHECK (story_tracking IN ('edge', 'seen_only', 'not_tracked')),
  story_final_state    text NOT NULL DEFAULT 'open' CHECK (story_final_state IN ('open', 'final', 'final_incomplete')),
  below_threshold      boolean NOT NULL DEFAULT false,                  -- error 10, "Not enough viewers": shown as <5
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, account_ref, media_id),
  CONSTRAINT insight_media_no_impressions CHECK (NOT latest ? 'impressions'),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX insight_media_list_idx ON insight_media (tenant_id, kind, posted_at DESC, id);
CREATE INDEX insight_media_media_idx ON insight_media (tenant_id, media_id);
SELECT fence_tenant_table('insight_media');

-- One row per media per poll, so growth at 1h, 24h and 7d can be drawn (7.2). `slot` is the poll's due time: a rerun after a worker
-- died lands on the same slot and changes nothing (N-38).
CREATE TABLE insight_snapshots (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  media_ref       bigint NOT NULL,
  slot            timestamptz NOT NULL,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  age_minutes     integer NOT NULL CHECK (age_minutes >= 0),
  metrics         jsonb NOT NULL DEFAULT '{}',
  breakdowns      jsonb NOT NULL DEFAULT '{}',
  below_threshold boolean NOT NULL DEFAULT false,
  is_final        boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, media_ref, slot),
  CONSTRAINT insight_snapshots_no_impressions CHECK (NOT metrics ? 'impressions'),
  FOREIGN KEY (tenant_id, media_ref) REFERENCES insight_media(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX insight_snapshots_age_idx ON insight_snapshots (tenant_id, media_ref, age_minutes);
SELECT fence_tenant_table('insight_snapshots');

-- The polling schedule (7.8). `next_due_at` already includes the jitter that spreads businesses across the hour. Workers claim across
-- businesses through db.platform with a 10-minute lease. stopped_at ends a poll for good: media deleted, or a story finished.
CREATE TABLE insight_polls (
  id               bigserial PRIMARY KEY,
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_ref      integer NOT NULL,
  job              text NOT NULL CHECK (job IN ('account_daily', 'demographics', 'media_list', 'media', 'story_list', 'story')),
  media_ref        bigint,
  call_class       text NOT NULL CHECK (call_class IN ('insights', 'story_insights', 'media_list')),
  next_due_at      timestamptz NOT NULL,
  jitter_seconds   integer NOT NULL DEFAULT 0 CHECK (jitter_seconds >= 0),
  lease_until      timestamptz,
  locked_by        text,
  attempts         integer NOT NULL DEFAULT 0,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_outcome     text NOT NULL DEFAULT '',
  last_error_code  integer,
  stopped_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((job IN ('media', 'story')) = (media_ref IS NOT NULL)),
  FOREIGN KEY (tenant_id, account_ref) REFERENCES analytics_accounts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, media_ref) REFERENCES insight_media(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX insight_polls_account_idx ON insight_polls (tenant_id, account_ref, job) WHERE media_ref IS NULL;
CREATE UNIQUE INDEX insight_polls_media_idx ON insight_polls (tenant_id, media_ref, job) WHERE media_ref IS NOT NULL;
CREATE INDEX insight_polls_account_ref_idx ON insight_polls (tenant_id, account_ref);
CREATE INDEX insight_polls_media_ref_idx ON insight_polls (tenant_id, media_ref);
CREATE INDEX insight_polls_due_idx ON insight_polls (next_due_at) WHERE stopped_at IS NULL;
SELECT fence_tenant_table('insight_polls');

-- One row per business: "Refresh now" is limited per business, not per account (7.8).
CREATE TABLE insight_settings (
  tenant_id       integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  refresh_now_at  timestamptz,
  poll_offset_sec integer NOT NULL DEFAULT 0 CHECK (poll_offset_sec BETWEEN 0 AND 3599)
);
SELECT fence_tenant_table('insight_settings');

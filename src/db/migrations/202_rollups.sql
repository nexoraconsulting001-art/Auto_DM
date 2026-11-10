-- Phase 2: the daily rollups (PRD 7.10, 7.11), kept 25 months. Only analytics.rollups in src/platform reads or writes these, so a separate
-- analytics database can take over without changing a caller. The catalogue is ROLLUP_STORES in src/contracts/analytics.js, and a test keeps
-- it equal to these tables. dims_hash is a hash of the row's dimensions, so a very long landing page can never overflow the key.

CREATE TABLE traffic_daily (
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day              date NOT NULL,
  dims_hash        text NOT NULL,
  hour             smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  source           text NOT NULL DEFAULT '',
  referrer_domain  text NOT NULL DEFAULT '',
  utm_source       text NOT NULL DEFAULT '',
  utm_medium       text NOT NULL DEFAULT '',
  utm_campaign     text NOT NULL DEFAULT '',
  utm_content      text NOT NULL DEFAULT '',
  media_id         text NOT NULL DEFAULT '',
  landing_page     text NOT NULL DEFAULT '',
  device           text NOT NULL DEFAULT '',
  os               text NOT NULL DEFAULT '',
  browser          text NOT NULL DEFAULT '',
  in_app           text NOT NULL DEFAULT '',
  city             text NOT NULL DEFAULT '',
  state            text NOT NULL DEFAULT '',
  visitor_type     text NOT NULL DEFAULT '',
  sessions         integer NOT NULL DEFAULT 0,
  bounces          integer NOT NULL DEFAULT 0,
  page_views       integer NOT NULL DEFAULT 0,
  landing_views    integer NOT NULL DEFAULT 0,
  category_views   integer NOT NULL DEFAULT 0,
  product_views    integer NOT NULL DEFAULT 0,
  product_taps     integer NOT NULL DEFAULT 0,
  outbound_taps    integer NOT NULL DEFAULT 0,
  whatsapp_taps    integer NOT NULL DEFAULT 0,
  add_to_cart      integer NOT NULL DEFAULT 0,
  checkout_started integer NOT NULL DEFAULT 0,
  payment_success  integer NOT NULL DEFAULT 0,
  orders           integer NOT NULL DEFAULT 0,
  revenue_paise    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, dims_hash)
);
CREATE INDEX traffic_daily_retention_idx ON traffic_daily (day);
SELECT fence_tenant_table('traffic_daily');

CREATE TABLE traffic_items_daily (
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day              date NOT NULL,
  dims_hash        text NOT NULL,
  hour             smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  item_kind        text NOT NULL DEFAULT '',                            -- landing, category, product, or any other page
  item_ref         text NOT NULL DEFAULT '',
  source           text NOT NULL DEFAULT '',
  referrer_domain  text NOT NULL DEFAULT '',
  utm_source       text NOT NULL DEFAULT '',
  utm_medium       text NOT NULL DEFAULT '',
  utm_campaign     text NOT NULL DEFAULT '',
  utm_content      text NOT NULL DEFAULT '',
  media_id         text NOT NULL DEFAULT '',
  landing_page     text NOT NULL DEFAULT '',
  device           text NOT NULL DEFAULT '',
  os               text NOT NULL DEFAULT '',
  browser          text NOT NULL DEFAULT '',
  in_app           text NOT NULL DEFAULT '',
  city             text NOT NULL DEFAULT '',
  state            text NOT NULL DEFAULT '',
  visitor_type     text NOT NULL DEFAULT '',
  sessions         integer NOT NULL DEFAULT 0,
  views            integer NOT NULL DEFAULT 0,
  taps             integer NOT NULL DEFAULT 0,
  outbound_taps    integer NOT NULL DEFAULT 0,
  whatsapp_taps    integer NOT NULL DEFAULT 0,
  add_to_cart      integer NOT NULL DEFAULT 0,
  checkout_started integer NOT NULL DEFAULT 0,
  orders           integer NOT NULL DEFAULT 0,
  revenue_paise    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, dims_hash)
);
CREATE INDEX traffic_items_daily_retention_idx ON traffic_items_daily (day);
CREATE INDEX traffic_items_daily_ref_idx ON traffic_items_daily (tenant_id, item_kind, item_ref, day);
SELECT fence_tenant_table('traffic_items_daily');

CREATE TABLE funnel_daily (
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day            date NOT NULL,
  dims_hash      text NOT NULL,
  channel        text NOT NULL DEFAULT '',
  media_id       text NOT NULL DEFAULT '',
  content_kind   text NOT NULL DEFAULT '',
  link_type      text NOT NULL DEFAULT '',
  link_mode      text NOT NULL DEFAULT '',
  origin         text NOT NULL DEFAULT '',
  source_label   text NOT NULL DEFAULT '',
  comments       integer NOT NULL DEFAULT 0,
  dms_queued     integer NOT NULL DEFAULT 0,
  dms_sent       integer NOT NULL DEFAULT 0,
  dms_failed     integer NOT NULL DEFAULT 0,
  dms_paced      integer NOT NULL DEFAULT 0,
  seen           integer NOT NULL DEFAULT 0,
  taps           integer NOT NULL DEFAULT 0,
  visits         integer NOT NULL DEFAULT 0,
  orders         integer NOT NULL DEFAULT 0,
  revenue_paise  bigint NOT NULL DEFAULT 0,
  earnings_paise bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, dims_hash)
);
CREATE INDEX funnel_daily_retention_idx ON funnel_daily (day);
CREATE INDEX funnel_daily_media_idx ON funnel_daily (tenant_id, media_id, day);
SELECT fence_tenant_table('funnel_daily');

CREATE TABLE meta_account_daily (
  tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day                date NOT NULL,
  dims_hash          text NOT NULL,
  account_id         text NOT NULL DEFAULT '',
  views              bigint,
  reach              bigint,
  accounts_engaged   bigint,
  total_interactions bigint,
  likes              bigint,
  comments           bigint,
  shares             bigint,
  saves              bigint,
  replies            bigint,
  reposts            bigint,
  follows            bigint,
  unfollows          bigint,
  profile_links_taps bigint,
  followers_count    bigint,
  PRIMARY KEY (tenant_id, day, dims_hash)
);
CREATE INDEX meta_account_daily_retention_idx ON meta_account_daily (day);
SELECT fence_tenant_table('meta_account_daily');

CREATE TABLE meta_content_daily (
  tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day                date NOT NULL,
  dims_hash          text NOT NULL,
  media_id           text NOT NULL DEFAULT '',
  content_kind       text NOT NULL DEFAULT '',
  views              bigint,
  reach              bigint,
  likes              bigint,
  comments           bigint,
  shares             bigint,
  saved              bigint,
  total_interactions bigint,
  reposts            bigint,
  follows            bigint,
  profile_visits     bigint,
  link_clicks        bigint,
  avg_watch_ms       bigint,
  total_watch_ms     bigint,
  skip_rate_bp       bigint,                                            -- basis points: 1234 is 12.34%
  PRIMARY KEY (tenant_id, day, dims_hash)
);
CREATE INDEX meta_content_daily_retention_idx ON meta_content_daily (day);
CREATE INDEX meta_content_daily_media_idx ON meta_content_daily (tenant_id, media_id, day);
SELECT fence_tenant_table('meta_content_daily');

-- Phase 2: the Bhava funnel per reel, post and story (PRD 7.4) and where every figure comes from (7.15).

-- One row per thing that happened. subject_hash is the only form of a person here (compliance repo's subjectHash). dedupe_key is what makes
-- five taps by one person one row (N-15), and a rerun change nothing. voided_at takes a cancelled or refunded order out (N-18).
CREATE TABLE funnel_events (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel      text NOT NULL DEFAULT 'instagram' CHECK (channel IN ('instagram', 'facebook')),
  media_id     text NOT NULL,
  content_kind text NOT NULL DEFAULT '',
  stage        text NOT NULL CHECK (stage IN ('comments', 'dms', 'seen', 'taps_or_visits', 'sales')),
  origin       text NOT NULL DEFAULT 'automation' CHECK (origin IN ('automation', 'two_tap', 'bhava_page', 'utm', 'shopify', 'amazon', 'affiliate', 'discount_code', 'bhava_store')),
  source_label text NOT NULL DEFAULT 'bhava' CHECK (source_label IN ('bhava', 'platform', 'destination')),
  subject_hash text NOT NULL DEFAULT '',
  amount_paise bigint NOT NULL DEFAULT 0 CHECK (amount_paise >= 0),
  order_id     integer,
  dedupe_key   text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  voided_at    timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, stage, dedupe_key),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE SET NULL (order_id)
);
CREATE INDEX funnel_events_media_idx ON funnel_events (tenant_id, media_id, stage, occurred_at);
CREATE INDEX funnel_events_order_idx ON funnel_events (tenant_id, order_id);
CREATE INDEX funnel_events_retention_idx ON funnel_events (occurred_at);
SELECT fence_tenant_table('funnel_events');

-- Which destinations a business has connected, so a step can say why it has nothing to show (7.15).
CREATE TABLE destination_connections (
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('ga4', 'site_tag', 'shopify', 'amazon', 'affiliate', 'discount_code')),
  enabled      boolean NOT NULL DEFAULT false,
  connected_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source)
);
SELECT fence_tenant_table('destination_connections');

-- An uploaded earnings report: Amazon's, or another network's where it reports by sub-ID (7.15, N-74).
CREATE TABLE destination_uploads (
  id             serial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('amazon', 'affiliate')),
  network        text NOT NULL DEFAULT '',
  period_from    date,
  period_to      date,
  rows_imported  integer NOT NULL DEFAULT 0 CHECK (rows_imported >= 0),
  rows_unmatched integer NOT NULL DEFAULT 0 CHECK (rows_unmatched >= 0),
  storage_key    text NOT NULL DEFAULT '',
  uploaded_by    integer,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (uploaded_by)
);
CREATE INDEX destination_uploads_user_idx ON destination_uploads (tenant_id, uploaded_by);
SELECT fence_tenant_table('destination_uploads');

-- What the destination reported, per reel and day where it can be tied to one. NULL: not reported, which is different from 0.
CREATE TABLE destination_figures (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('ga4', 'site_tag', 'shopify', 'amazon', 'affiliate', 'discount_code')),
  network        text NOT NULL DEFAULT '',
  media_id       text NOT NULL DEFAULT '',
  day            date NOT NULL,
  visits         integer CHECK (visits >= 0),
  orders         integer CHECK (orders >= 0),
  earnings_paise bigint CHECK (earnings_paise >= 0),
  measurement_id integer,
  upload_id      integer,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source, network, media_id, day),
  FOREIGN KEY (tenant_id, measurement_id) REFERENCES measurement_ids(tenant_id, id) ON DELETE SET NULL (measurement_id),
  FOREIGN KEY (tenant_id, upload_id) REFERENCES destination_uploads(tenant_id, id) ON DELETE SET NULL (upload_id)
);
CREATE INDEX destination_figures_media_idx ON destination_figures (tenant_id, media_id, day);
CREATE INDEX destination_figures_measurement_idx ON destination_figures (tenant_id, measurement_id);
CREATE INDEX destination_figures_upload_idx ON destination_figures (tenant_id, upload_id);
SELECT fence_tenant_table('destination_figures');

-- The labels, the same for every business. SOURCE_LABELS and EXPLORE_METRICS in src/contracts/analytics.js hold the same lists; a test keeps them equal.
CREATE TABLE measurement_labels (
  code  text PRIMARY KEY CHECK (code IN ('bhava', 'platform', 'destination')),
  label text NOT NULL
);
GRANT SELECT ON measurement_labels TO bhava_app;
INSERT INTO measurement_labels (code, label) VALUES
  ('bhava', 'Measured by Bhava'),
  ('platform', 'From Instagram/Facebook'),
  ('destination', 'From the destination');

CREATE TABLE metric_labels (
  metric text PRIMARY KEY,
  code   text NOT NULL REFERENCES measurement_labels(code)
);
GRANT SELECT ON metric_labels TO bhava_app;
INSERT INTO metric_labels (metric, code)
SELECT unnest(metrics), code FROM (VALUES
  ('bhava', ARRAY['sessions', 'visitors', 'page_views', 'landing_views', 'category_views', 'product_views', 'product_taps', 'outbound_taps', 'whatsapp_taps', 'add_to_cart', 'checkout_started', 'orders', 'revenue_paise', 'median_engaged_ms', 'bounce_rate', 'tap_rate', 'add_to_cart_rate', 'conversion_rate', 'revenue_per_session', 'dms', 'comments_received', 'taps_or_visits']),
  ('platform', ARRAY['ig_views', 'ig_reach', 'ig_accounts_engaged', 'ig_total_interactions', 'ig_likes', 'ig_comments', 'ig_shares', 'ig_saves', 'ig_replies', 'ig_reposts', 'ig_follows', 'ig_unfollows', 'ig_profile_links_taps', 'ig_followers', 'ig_media_views', 'ig_media_reach', 'ig_link_clicks', 'ig_avg_watch_ms', 'ig_skip_rate_bp'])
) AS groups(code, metrics);

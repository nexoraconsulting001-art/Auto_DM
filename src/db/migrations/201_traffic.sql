-- Phase 2: traffic on the seller's own pages and links (PRD 7.10). There is deliberately no column for an IP address or a full user agent:
-- only what was derived from them at ingest is kept. Sellers read aggregates only; visitor ids never leave the server.

-- A visitor is a random first-party id on the seller's domain, per business, kept 13 months.
CREATE TABLE traffic_visitors (
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id      uuid NOT NULL,
  first_seen_at   timestamptz NOT NULL,
  first_source    text NOT NULL DEFAULT 'direct',
  last_seen_at    timestamptz NOT NULL,
  last_session_id uuid,
  PRIMARY KEY (tenant_id, visitor_id)
);
CREATE INDEX traffic_visitors_cohort_idx ON traffic_visitors (tenant_id, first_seen_at);
CREATE INDEX traffic_visitors_retention_idx ON traffic_visitors (last_seen_at);
SELECT fence_tenant_table('traffic_visitors');

-- One row per session. Written through analytics.rollups ('traffic_sessions'), so it alone can count distinct visitors and a median.
-- visitor_id is NULL when cookies are blocked: counted per session and left out of cohorts (7.12).
CREATE TABLE traffic_sessions (
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL,
  visitor_id       uuid,
  day              date NOT NULL,                                       -- in the business's time zone, as are hour and weekday
  hour             smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  started_at       timestamptz,
  last_hit_at      timestamptz,
  referrer_domain  text NOT NULL DEFAULT '',
  source           text NOT NULL DEFAULT '',
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
  engaged_ms       integer NOT NULL DEFAULT 0,
  bounced          smallint NOT NULL DEFAULT 0 CHECK (bounced IN (0, 1)),
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, visitor_id) REFERENCES traffic_visitors(tenant_id, visitor_id) ON DELETE SET NULL (visitor_id)
);
CREATE INDEX traffic_sessions_day_idx ON traffic_sessions (tenant_id, day);
CREATE INDEX traffic_sessions_visitor_idx ON traffic_sessions (tenant_id, visitor_id);
CREATE INDEX traffic_sessions_live_idx ON traffic_sessions (tenant_id, last_hit_at);
SELECT fence_tenant_table('traffic_sessions');

-- Every hit on a buyer page, and each two-tap link tap (7.4, 7.10). Raw events are kept 13 months and never shown to a seller.
-- `path` has no query string. event_key makes a repeated beacon or backfill a no-op.
CREATE TABLE traffic_events (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id    uuid,
  visitor_id    uuid,
  at            timestamptz NOT NULL DEFAULT now(),
  surface       text NOT NULL DEFAULT 'buyer_page' CHECK (surface IN ('buyer_page', 'link')),
  name          text NOT NULL CHECK (name IN ('page_view', 'landing_view', 'category_view', 'product_view', 'product_tap', 'outbound_tap', 'whatsapp_tap', 'add_to_cart', 'checkout_started', 'payment_success', 'order', 'link_tap')),
  page_kind     text NOT NULL DEFAULT 'other' CHECK (page_kind IN ('landing', 'category', 'product', 'store', 'link_in_bio', 'creator', 'checkout', 'other')),
  page_ref      text NOT NULL DEFAULT '',
  path          text NOT NULL DEFAULT '',
  media_id      text NOT NULL DEFAULT '',
  product_id    integer,
  category_id   integer,
  order_id      integer,
  outbound_host text NOT NULL DEFAULT '',
  value_paise   bigint NOT NULL DEFAULT 0 CHECK (value_paise >= 0),
  event_key     text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE SET NULL (product_id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id) ON DELETE SET NULL (category_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE SET NULL (order_id)
);
CREATE UNIQUE INDEX traffic_events_key_idx ON traffic_events (tenant_id, event_key) WHERE event_key <> '';
CREATE INDEX traffic_events_time_idx ON traffic_events (tenant_id, at);
CREATE INDEX traffic_events_session_idx ON traffic_events (tenant_id, session_id, at);
CREATE INDEX traffic_events_visitor_idx ON traffic_events (tenant_id, visitor_id, at);
CREATE INDEX traffic_events_product_idx ON traffic_events (tenant_id, product_id);
CREATE INDEX traffic_events_category_idx ON traffic_events (tenant_id, category_id);
CREATE INDEX traffic_events_order_idx ON traffic_events (tenant_id, order_id);
CREATE INDEX traffic_events_retention_idx ON traffic_events (at);
SELECT fence_tenant_table('traffic_events');

-- Excluded from every count, and counted here separately: owner previews, signed-in team members, bots and link-preview crawlers (7.10).
CREATE TABLE traffic_previews (
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       date NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('owner_preview', 'team', 'bot', 'crawler')),
  page_kind text NOT NULL DEFAULT 'other',
  n         bigint NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (tenant_id, day, kind, page_kind)
);
SELECT fence_tenant_table('traffic_previews');

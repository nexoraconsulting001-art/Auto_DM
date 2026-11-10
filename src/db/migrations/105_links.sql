-- Phase 1: direct links and what measures them (PRD 4.11, 6.6, 6.13). There is no redirect table, by design.

-- Per reel, and never per send. Two live reels may share a value (the builder warns), so the value is not unique.
CREATE TABLE measurement_ids (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  media_id   text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('amazon_tag', 'affiliate_sub_id', 'discount_code')),
  network    text NOT NULL DEFAULT '',
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, media_id, kind, network)
);
CREATE INDEX measurement_ids_value_idx ON measurement_ids (tenant_id, kind, value);
SELECT fence_tenant_table('measurement_ids');

-- Two-tap mode: one row per person per reel per automation, so a repeat tap adds to tap_count and not to the count of people.
CREATE TABLE link_taps (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id   integer NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  media_id        text NOT NULL DEFAULT '',
  subject_hash    text NOT NULL,
  comment_id      text NOT NULL DEFAULT '',
  variant_id      integer,
  tap_count       integer NOT NULL DEFAULT 1 CHECK (tap_count >= 1),
  is_test         boolean NOT NULL DEFAULT false,
  first_tapped_at timestamptz NOT NULL DEFAULT now(),
  last_tapped_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, automation_id, channel, media_id, subject_hash),
  FOREIGN KEY (tenant_id, automation_id) REFERENCES automations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES template_variants(tenant_id, id) ON DELETE SET NULL (variant_id)
);
CREATE INDEX link_taps_media_idx ON link_taps (tenant_id, media_id, first_tapped_at);
CREATE INDEX link_taps_variant_idx ON link_taps (tenant_id, variant_id);
SELECT fence_tenant_table('link_taps');

CREATE TABLE link_checks (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id integer NOT NULL,
  url           text NOT NULL,
  ok            boolean NOT NULL,
  reason        text NOT NULL DEFAULT '',
  http_status   integer,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, automation_id) REFERENCES automations(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX link_checks_automation_idx ON link_checks (tenant_id, automation_id, checked_at DESC);
SELECT fence_tenant_table('link_checks');

-- Hosts no DM may link to, about no single business. shortener and redirector give link.shortener, the rest link.blocked.
CREATE TABLE link_blocked_hosts (
  host       text PRIMARY KEY CHECK (host = lower(host)),
  category   text NOT NULL CHECK (category IN ('shortener', 'redirector', 'malware', 'phishing', 'adult')),
  source     text NOT NULL DEFAULT 'bhava' CHECK (source IN ('bhava', 'feed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON link_blocked_hosts TO bhava_app;

INSERT INTO link_blocked_hosts (host, category) VALUES
  ('bit.ly', 'shortener'), ('tinyurl.com', 'shortener'), ('t.co', 'shortener'), ('goo.gl', 'shortener'), ('ow.ly', 'shortener'),
  ('is.gd', 'shortener'), ('buff.ly', 'shortener'), ('cutt.ly', 'shortener'), ('rebrand.ly', 'shortener'), ('rb.gy', 'shortener'),
  ('shorturl.at', 'shortener'), ('tiny.cc', 'shortener'), ('amzn.to', 'shortener'), ('l.instagram.com', 'redirector'), ('lm.facebook.com', 'redirector');

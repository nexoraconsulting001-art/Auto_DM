-- Phase 3: categories with reel sequences (PRD 8.13). The catalog's categories (8.1) each keep one ordered list of landing
-- pages (reels, posts). Every buyer surface reads this one order; none keeps a copy.

-- position is the reel's place among the unpinned reels, and is kept while it is pinned, so unpinning returns it there (K-45).
-- Pinned reels sit above the rest in pin_position order. A window (starts_at, ends_at) hides it in this category only (K-46).
CREATE TABLE category_reels (
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id  integer NOT NULL,
  page_id      integer NOT NULL,
  position     integer NOT NULL CHECK (position >= 0),
  pinned       boolean NOT NULL DEFAULT false,
  pin_position integer CHECK (pin_position IS NULL OR pin_position >= 0),
  starts_at    timestamptz,
  ends_at      timestamptz,
  joined_by    text NOT NULL DEFAULT 'owner' CHECK (joined_by IN ('owner', 'rule')),
  rule_id      integer,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, category_id, page_id),
  UNIQUE (tenant_id, category_id, position) DEFERRABLE INITIALLY DEFERRED,
  CHECK (pinned = (pin_position IS NOT NULL)),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, page_id) REFERENCES reels(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX category_reels_page_idx ON category_reels (tenant_id, page_id);
SELECT fence_tenant_table('category_reels');

-- Auto-join rules: a caption keyword, a hashtag, or a linked product's category. A matching new reel joins at the top or the
-- bottom. A changed rule applies to new reels only (applies_from), unless the owner applies it to existing reels.
CREATE TABLE category_rules (
  id                 serial PRIMARY KEY,
  tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id        integer NOT NULL,
  match              text NOT NULL CHECK (match IN ('caption_keyword', 'hashtag', 'product_category')),
  value              text NOT NULL DEFAULT '' CHECK (length(value) <= 100),
  product_category_id integer,
  join_at            text NOT NULL DEFAULT 'bottom' CHECK (join_at IN ('top', 'bottom')),
  active             boolean NOT NULL DEFAULT true,
  applies_from       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((match = 'product_category') = (product_category_id IS NOT NULL)),
  CHECK (match = 'product_category' OR value <> ''),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_category_id) REFERENCES categories(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX category_rules_category_idx ON category_rules (tenant_id, category_id);
CREATE INDEX category_rules_product_category_idx ON category_rules (tenant_id, product_category_id);
SELECT fence_tenant_table('category_rules');

ALTER TABLE category_reels ADD CONSTRAINT category_reels_rule_fk
  FOREIGN KEY (tenant_id, rule_id) REFERENCES category_rules(tenant_id, id) ON DELETE SET NULL (rule_id);
CREATE INDEX category_reels_rule_idx ON category_reels (tenant_id, rule_id);

-- A reel the owner removed from a category: no rule adds it back there (8.13).
CREATE TABLE category_reel_removals (
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id integer NOT NULL,
  page_id     integer NOT NULL,
  removed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, category_id, page_id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, page_id) REFERENCES reels(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX category_reel_removals_page_idx ON category_reel_removals (tenant_id, page_id);
SELECT fence_tenant_table('category_reel_removals');

-- Phase 4: coupons (PRD 9.14). One coupon per order, validated at checkout and again inside the order's transaction.
CREATE TABLE coupons (
  id                    serial PRIMARY KEY,
  tenant_id             integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Stored in capitals; a code is the same whatever case the shopper types.
  code                  text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  kind                  text NOT NULL CHECK (kind IN ('percent', 'flat', 'free_shipping')),
  -- percent: hundredths of a percent (10% is 1000), with an optional cap. flat: paise.
  percent_bp            integer CHECK (percent_bp IS NULL OR percent_bp BETWEEN 1 AND 10000),
  amount_paise          bigint CHECK (amount_paise IS NULL OR amount_paise > 0),
  max_discount_paise    bigint CHECK (max_discount_paise IS NULL OR max_discount_paise > 0),
  min_order_paise       bigint NOT NULL DEFAULT 0 CHECK (min_order_paise >= 0),
  starts_at             timestamptz,
  ends_at               timestamptz,
  max_uses              integer CHECK (max_uses IS NULL OR max_uses > 0),
  max_uses_per_customer integer CHECK (max_uses_per_customer IS NULL OR max_uses_per_customer > 0),
  -- Counted in the order's transaction. The check below is what stops simultaneous checkouts going over the limit (S-47).
  used_count            integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  first_order_only      boolean NOT NULL DEFAULT false,
  scope                 text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'products', 'categories')),
  scope_ids             integer[] NOT NULL DEFAULT '{}' CHECK (cardinality(scope_ids) <= 500),
  -- The reel or post it was made for, so its revenue shows against that content (7.4).
  page_id               integer,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (max_uses IS NULL OR used_count <= max_uses),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK (CASE kind WHEN 'percent' THEN percent_bp IS NOT NULL AND amount_paise IS NULL WHEN 'flat' THEN amount_paise IS NOT NULL AND percent_bp IS NULL
    ELSE percent_bp IS NULL AND amount_paise IS NULL END),
  CHECK (scope = 'all' OR cardinality(scope_ids) > 0),
  FOREIGN KEY (tenant_id, page_id) REFERENCES reels(tenant_id, id) ON DELETE SET NULL (page_id)
);
CREATE INDEX coupons_page_idx ON coupons (tenant_id, page_id) WHERE page_id IS NOT NULL;
SELECT fence_tenant_table('coupons');

-- One row per order that used a coupon. `customer_key` is a keyed hash of the buyer's phone, so the per-customer limit
-- counts guests too (S-46) without a second copy of the number. A cancelled order's row is released and stops counting.
CREATE TABLE coupon_redemptions (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  coupon_id      integer NOT NULL,
  order_id       integer NOT NULL,
  shopper_id     integer,
  customer_key   text NOT NULL CHECK (length(customer_key) = 64),
  discount_paise bigint NOT NULL CHECK (discount_paise >= 0),
  status         text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'released')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  UNIQUE (tenant_id, order_id),
  FOREIGN KEY (tenant_id, coupon_id) REFERENCES coupons(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE SET NULL (shopper_id)
);
CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions (tenant_id, coupon_id, customer_key) WHERE status = 'applied';
SELECT fence_tenant_table('coupon_redemptions');

ALTER TABLE orders ADD CONSTRAINT orders_coupon_fk FOREIGN KEY (tenant_id, coupon_id) REFERENCES coupons(tenant_id, id) ON DELETE SET NULL (coupon_id);
CREATE INDEX orders_coupon_idx ON orders (tenant_id, coupon_id) WHERE coupon_id IS NOT NULL;

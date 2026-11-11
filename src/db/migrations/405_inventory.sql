-- Phase 4: stock with reservations (PRD 9.12), and what a product needs to ship (9.10) and be invoiced (9.13).
-- Stock is per variant; a product with no variants keeps its own `stock` (Phase 0). NULL stock means unlimited.
--   stock     units on hand
--   reserved  units held by orders that are placed but not yet paid
-- Available to sell is stock - reserved. Paying turns a hold into a sale (both go down); releasing it only frees the hold.
-- Neither can go below zero (products.stock has had that check since Phase 0), and a hold can never exceed what is on hand: the database refuses, so two shoppers racing
-- for the last unit cannot both get it (S-16).
ALTER TABLE products
  ADD COLUMN reserved            integer NOT NULL DEFAULT 0,
  ADD COLUMN low_stock_threshold integer CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  ADD COLUMN weight_grams        integer CHECK (weight_grams IS NULL OR weight_grams BETWEEN 1 AND 500000),
  ADD COLUMN length_cm           integer CHECK (length_cm IS NULL OR length_cm BETWEEN 1 AND 500),
  ADD COLUMN breadth_cm          integer CHECK (breadth_cm IS NULL OR breadth_cm BETWEEN 1 AND 500),
  ADD COLUMN height_cm           integer CHECK (height_cm IS NULL OR height_cm BETWEEN 1 AND 500),
  ADD COLUMN hsn_code            text NOT NULL DEFAULT '' CHECK (hsn_code = '' OR hsn_code ~ '^[0-9]{4,8}$'),
  -- GST rate in hundredths of a percent (5% is 500). Prices include it.
  ADD COLUMN gst_rate_bp         integer NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  -- (A Phase 0 row that somehow holds negative stock is left alone until someone corrects it.)
  ADD CONSTRAINT products_reserved_within_stock CHECK (reserved >= 0 AND (stock IS NULL OR stock < 0 OR reserved <= stock));

ALTER TABLE product_variants
  ADD COLUMN stock               integer CHECK (stock IS NULL OR stock >= 0),
  ADD COLUMN reserved            integer NOT NULL DEFAULT 0,
  ADD COLUMN low_stock_threshold integer CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  ADD COLUMN weight_grams        integer CHECK (weight_grams IS NULL OR weight_grams BETWEEN 1 AND 500000),
  ADD CONSTRAINT product_variants_reserved_within_stock CHECK (reserved >= 0 AND (stock IS NULL OR reserved <= stock));

CREATE TABLE inventory_settings (
  tenant_id           integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- The low-stock alert fires at or below this, unless a product or variant has its own.
  low_stock_threshold integer NOT NULL DEFAULT 3 CHECK (low_stock_threshold >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('inventory_settings');

-- One row per order line that holds or took stock. held: counted in `reserved`. committed: taken out of `stock`.
-- released: given back (cancel, failed payment, expiry). restocked: came back after shipping (RTO delivered, a good return).
CREATE TABLE stock_reservations (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id      integer NOT NULL,
  order_item_id integer NOT NULL,
  product_id    integer NOT NULL,
  variant_id    integer,
  qty           integer NOT NULL CHECK (qty > 0),
  status        text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'committed', 'released', 'restocked')),
  -- When a hold lapses (the order's hold_expires_at). Null once committed.
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_item_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES order_items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX stock_reservations_order_idx ON stock_reservations (tenant_id, order_id);
CREATE INDEX stock_reservations_item_idx ON stock_reservations (tenant_id, product_id, variant_id) WHERE status = 'held';
CREATE INDEX stock_reservations_expiry_idx ON stock_reservations (expires_at) WHERE status = 'held';
SELECT fence_tenant_table('stock_reservations');

-- Every change to stock on hand, and why. Insert-only; (reason, ref) is unique so an event handled twice moves stock once.
CREATE TABLE stock_movements (
  id         bigserial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id integer NOT NULL,
  variant_id integer,
  delta      integer NOT NULL CHECK (delta <> 0),
  reason     text NOT NULL CHECK (reason IN ('sale', 'cancel', 'rto', 'return', 'manual', 'import', 'shopify', 'correction')),
  -- 'order_item:41', 'return_item:5', 'user:12', 'shopify:inventory_level:99'.
  ref        text NOT NULL CHECK (length(ref) BETWEEN 1 AND 120),
  order_id   integer,
  actor      text NOT NULL DEFAULT 'system' CHECK (length(actor) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reason, ref),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE SET NULL (order_id)
);
CREATE INDEX stock_movements_product_idx ON stock_movements (tenant_id, product_id, id DESC);
SELECT fence_tenant_table('stock_movements', 'SELECT, INSERT');

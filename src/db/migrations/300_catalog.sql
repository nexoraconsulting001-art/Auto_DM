-- Phase 3: one catalog for every page, DM and tier (PRD 8.1). The Phase 0 products table grows rather than being
-- replaced, so orders, reels and the Phase 0 store keep working on the same rows. Money is integer paise in bigint.

-- Uploaded files get the business's composite key, so product images can point at them and never at another business's file.
ALTER TABLE media ADD CONSTRAINT media_tenant_id_key UNIQUE (tenant_id, id);

-- An MRP is shown only when it is above the price (8.1). The database refuses one below it; one equal to it is stored by the
-- Phase 0 store's forms and simply not shown (checkMrp in src/contracts/catalog.js stores none). Older rows below it lose the MRP.
UPDATE products SET mrp_paise = NULL WHERE mrp_paise IS NOT NULL AND mrp_paise < price_paise;
-- bigint holds any total, but one product's price above ₹100 crore (CATALOG_LIMITS.maxPricePaise) is a misread page, not a price:
-- it costs that product its import, never the business's whole import.

ALTER TABLE products
  ALTER COLUMN price_paise TYPE bigint,
  ALTER COLUMN mrp_paise TYPE bigint,
  ADD COLUMN external_url         text NOT NULL DEFAULT '' CHECK (external_url = '' OR external_url ~ '^https?://' AND length(external_url) <= 2000),
  ADD COLUMN in_stock             boolean NOT NULL DEFAULT true,
  ADD COLUMN source               text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'link', 'shopify', 'csv') OR source ~ '^adapter:[a-z0-9-]{1,40}$'),
  ADD COLUMN source_ref           text NOT NULL DEFAULT '' CHECK (length(source_ref) <= 500),
  -- none: never fetched (manual); ok; retrying: a timeout or 5xx, tried again next run; broken: 404 or 410, hidden from pages;
  -- missing: gone from the store's feed, archived to Needs attention.
  ADD COLUMN fetch_status         text NOT NULL DEFAULT 'none' CHECK (fetch_status IN ('none', 'ok', 'retrying', 'broken', 'missing')),
  ADD COLUMN fetched_at           timestamptz,
  ADD COLUMN next_check_at        timestamptz,
  ADD COLUMN check_failures       integer NOT NULL DEFAULT 0 CHECK (check_failures >= 0),
  ADD COLUMN last_check_error     text NOT NULL DEFAULT '' CHECK (length(last_check_error) <= 200),
  ADD COLUMN price_changed        boolean NOT NULL DEFAULT false,
  ADD COLUMN previous_price_paise bigint CHECK (previous_price_paise IS NULL OR previous_price_paise >= 0),
  -- The owner typed this price, so no import or re-check may change it (8.8).
  ADD COLUMN price_manual         boolean NOT NULL DEFAULT true,
  -- Fields the owner edited by hand; a re-import never overwrites them (8.5).
  ADD COLUMN owner_edited         text[] NOT NULL DEFAULT '{}'
    CHECK (owner_edited <@ ARRAY['name', 'description', 'images', 'categories', 'tags', 'options']::text[]),
  ADD COLUMN tags                 text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 50),
  -- NULL follows the business's WhatsApp order setting (8.11); true or false overrides it for this product.
  ADD COLUMN whatsapp_order       boolean,
  ADD CONSTRAINT products_mrp_not_below_price CHECK (mrp_paise IS NULL OR mrp_paise >= price_paise),
  ADD CONSTRAINT products_price_sane CHECK (price_paise <= 100000000000 AND (mrp_paise IS NULL OR mrp_paise <= 100000000000));

-- The same address is one product per business, never across businesses (K-01, K-11).
CREATE UNIQUE INDEX products_external_url_idx ON products (tenant_id, external_url) WHERE external_url <> '';
CREATE UNIQUE INDEX products_source_ref_idx ON products (tenant_id, source, source_ref) WHERE source_ref <> '' AND source <> 'manual';
CREATE INDEX products_attention_idx ON products (tenant_id, fetch_status) WHERE fetch_status IN ('broken', 'missing');
-- The re-check worker's queue across businesses (8.8). It runs outside any business, through db.platform.
CREATE INDEX products_due_idx ON products (next_check_at) WHERE next_check_at IS NOT NULL;

-- Up to three option names per product (Size, Colour, ...), each with its values in the owner's order.
CREATE TABLE product_options (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id integer NOT NULL,
  position   integer NOT NULL CHECK (position BETWEEN 0 AND 2),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  "values"   text[] NOT NULL DEFAULT '{}' CHECK (cardinality("values") <= 100),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, product_id, position) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (tenant_id, product_id, name),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('product_options');

-- One to six images in order. The file is in tenant media when it could be copied; the original address is kept either way.
CREATE TABLE product_images (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id integer NOT NULL,
  position   integer NOT NULL CHECK (position BETWEEN 0 AND 5),
  media_id   uuid,
  source_url text NOT NULL DEFAULT '' CHECK (source_url = '' OR source_url ~ '^https?://' AND length(source_url) <= 2000),
  alt        text NOT NULL DEFAULT '' CHECK (length(alt) <= 200),
  width      integer CHECK (width IS NULL OR width > 0),
  height     integer CHECK (height IS NULL OR height > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, product_id, position) DEFERRABLE INITIALLY DEFERRED,
  CHECK (media_id IS NOT NULL OR source_url <> ''),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, media_id) REFERENCES media(tenant_id, id) ON DELETE SET NULL (media_id)
);
CREATE INDEX product_images_media_idx ON product_images (tenant_id, media_id);
SELECT fence_tenant_table('product_images');

-- Variants are child rows (8.1). option_values follow product_options by position. The card shows the lowest in-stock price (K-03).
CREATE TABLE product_variants (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id    integer NOT NULL,
  position      integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  option_values text[] NOT NULL DEFAULT '{}' CHECK (cardinality(option_values) <= 3),
  sku           text NOT NULL DEFAULT '' CHECK (length(sku) <= 100),
  price_paise   bigint NOT NULL CHECK (price_paise BETWEEN 0 AND 100000000000),
  mrp_paise     bigint CHECK (mrp_paise IS NULL OR mrp_paise <= 100000000000),
  in_stock      boolean NOT NULL DEFAULT true,
  image_id      integer,
  source_ref    text NOT NULL DEFAULT '' CHECK (length(source_ref) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (mrp_paise IS NULL OR mrp_paise >= price_paise),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, image_id) REFERENCES product_images(tenant_id, id) ON DELETE SET NULL (image_id)
);
CREATE INDEX product_variants_product_idx ON product_variants (tenant_id, product_id, position);
CREATE INDEX product_variants_image_idx ON product_variants (tenant_id, image_id);
-- CSV upserts on sku first (8.6), so a SKU names one variant in a business.
CREATE UNIQUE INDEX product_variants_sku_idx ON product_variants (tenant_id, sku) WHERE sku <> '';
SELECT fence_tenant_table('product_variants');

-- Per business catalog settings. No row means the defaults.
CREATE TABLE catalog_settings (
  tenant_id     integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  recheck_hours integer NOT NULL DEFAULT 24 CHECK (recheck_hours BETWEEN 1 AND 720),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('catalog_settings');

-- Images already on products become rows, in order, so nothing the Phase 0 catalog held is lost.
INSERT INTO product_images (tenant_id, product_id, position, media_id, source_url)
  SELECT p.tenant_id, p.id, img.ord - 1,
         CASE WHEN img.link ~ '^/media/[0-9a-fA-F-]{36}$' AND EXISTS (SELECT 1 FROM media m WHERE m.tenant_id = p.tenant_id AND m.id::text = lower(substr(img.link, 8)))
              THEN lower(substr(img.link, 8))::uuid END,
         CASE WHEN img.link ~ '^https?://' THEN left(img.link, 2000) ELSE '' END
  FROM products p, jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.images) = 'array' THEN p.images ELSE '[]'::jsonb END) WITH ORDINALITY AS img(link, ord)
  WHERE img.ord <= 6 AND (img.link ~ '^https?://' OR img.link ~ '^/media/[0-9a-fA-F-]{36}$')
    AND (img.link ~ '^https?://' OR EXISTS (SELECT 1 FROM media m WHERE m.tenant_id = p.tenant_id AND m.id::text = lower(substr(img.link, 8))));

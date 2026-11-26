-- A product keeps the web link the owner typed (K-63: an Amazon link opens as written, "www." and all), and the form that makes two
-- pastes of one page the same product (K-11, canonicalProductUrl) moves to its own column, which the one-product-per-address rule uses.
ALTER TABLE products ADD COLUMN external_url_key text NOT NULL DEFAULT '';
UPDATE products SET external_url_key = external_url WHERE external_url <> '';
DROP INDEX products_external_url_idx;
CREATE UNIQUE INDEX products_external_url_idx ON products (tenant_id, external_url_key) WHERE external_url_key <> '';

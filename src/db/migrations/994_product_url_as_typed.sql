-- A product keeps the web link the owner typed (K-63: an Amazon link opens as written, "www." and all), and the form that makes two
-- pastes of one page the same product (K-11, canonicalProductUrl) moves to its own column, which the one-product-per-address rule uses.
ALTER TABLE products ADD COLUMN external_url_key text NOT NULL DEFAULT '';
UPDATE products SET external_url_key = external_url WHERE external_url <> '';
DROP INDEX products_external_url_idx;
CREATE UNIQUE INDEX products_external_url_idx ON products (tenant_id, external_url_key) WHERE external_url_key <> '';

-- The application always sets the key (canonicalProductUrl) when it writes an address. An insert that names only the address, as raw SQL does, still gets a key (the address itself),
-- so one business can't hold one address twice whoever writes it; clearing the address clears the key.
CREATE FUNCTION products_external_url_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.external_url = '' THEN
    NEW.external_url_key := '';
  ELSIF NEW.external_url_key = '' THEN
    NEW.external_url_key := NEW.external_url;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_external_url_key BEFORE INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION products_external_url_key();

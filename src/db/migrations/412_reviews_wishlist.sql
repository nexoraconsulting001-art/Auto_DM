-- Phase 4: ratings and reviews (PRD 9.19) and the wishlist (9.20). Both belong to one business and are never shown on another.

-- One review per product per order, by a shopper whose order of that product was delivered (the reviews module checks
-- that; the keys here make "one per product per order" true). The seller can approve, hide and reply, never edit the words.
CREATE TABLE reviews (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  integer NOT NULL,
  order_id    integer NOT NULL,
  shopper_id  integer,
  rating      integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text NOT NULL DEFAULT '' CHECK (length(body) <= 1000),
  -- New reviews wait for the owner (pending). Hidden ones stay listed in the admin and are left out of the average.
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden')),
  -- The first name shown beside it, copied when written so erasing the shopper can blank it.
  display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 40),
  reply       text NOT NULL DEFAULT '' CHECK (length(reply) <= 1000),
  replied_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_id, product_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE SET NULL (shopper_id)
);
CREATE INDEX reviews_product_idx ON reviews (tenant_id, product_id, status, id DESC);
CREATE INDEX reviews_status_idx ON reviews (tenant_id, status, id DESC);
SELECT fence_tenant_table('reviews');

-- Up to three photos per review, stored like any other upload of this business.
CREATE TABLE review_photos (
  id        serial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  review_id integer NOT NULL,
  position  integer NOT NULL CHECK (position BETWEEN 0 AND 2),
  media_id  uuid NOT NULL,
  UNIQUE (tenant_id, review_id, position),
  FOREIGN KEY (tenant_id, review_id) REFERENCES reviews(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, media_id) REFERENCES media(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX review_photos_media_idx ON review_photos (tenant_id, media_id);
SELECT fence_tenant_table('review_photos');

-- The average and count a product page shows, over approved reviews only. Kept by the reviews module whenever one is
-- approved, hidden or removed, so a page never counts reviews as it loads.
CREATE TABLE product_ratings (
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id   integer NOT NULL,
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  rating_sum   integer NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id),
  CHECK (rating_sum BETWEEN review_count AND review_count * 5),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('product_ratings');

-- A shopper's saved products. Owners see only how many saved each product, never who (S-86).
CREATE TABLE wishlist_items (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id integer NOT NULL,
  product_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, shopper_id, product_id),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX wishlist_items_product_idx ON wishlist_items (tenant_id, product_id);
SELECT fence_tenant_table('wishlist_items');

-- At most 200 saved items per shopper, whatever the code does.
CREATE FUNCTION wishlist_items_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM shoppers WHERE tenant_id = NEW.tenant_id AND id = NEW.shopper_id FOR UPDATE;
  IF (SELECT count(*) FROM wishlist_items WHERE tenant_id = NEW.tenant_id AND shopper_id = NEW.shopper_id) >= 200 THEN
    RAISE EXCEPTION 'A wishlist holds at most 200 items' USING ERRCODE = 'check_violation', CONSTRAINT = 'wishlist_items_cap';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wishlist_items_cap BEFORE INSERT ON wishlist_items FOR EACH ROW EXECUTE FUNCTION wishlist_items_cap();

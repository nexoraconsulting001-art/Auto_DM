-- Phase 4: the server cart (PRD 9.2). The bag lives in the browser; once a shopper signs in it is mirrored here, which is
-- what a second device (S-06) and reminders (9.15) read. A cart belongs to one business and one shopper. It holds no
-- prices: every line is priced again from the catalog whenever it is shown or checked out (S-05).
CREATE TABLE carts (
  id               serial PRIMARY KEY,
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id       integer NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ordered', 'emptied')),
  -- Counts up each time the cart is left again after a reminder cycle ended, so each cycle gets its own two reminders.
  episode          integer NOT NULL DEFAULT 1 CHECK (episode >= 1),
  -- Where the shopper came from, kept for the order's source (9.5) and the reminder's tracking (9.15).
  page_id          integer,
  source           text NOT NULL DEFAULT '' CHECK (length(source) <= 40),
  visitor_id       uuid,
  coupon_code      text NOT NULL DEFAULT '' CHECK (length(coupon_code) <= 40),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, page_id) REFERENCES reels(tenant_id, id) ON DELETE SET NULL (page_id)
);
-- One open cart per shopper.
CREATE UNIQUE INDEX carts_active_idx ON carts (tenant_id, shopper_id) WHERE status = 'active';
-- The reminder job's scan, across businesses (through db.platform).
CREATE INDEX carts_idle_idx ON carts (last_activity_at) WHERE status = 'active';
SELECT fence_tenant_table('carts');

CREATE TABLE cart_lines (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cart_id    integer NOT NULL,
  product_id integer NOT NULL,
  variant_id integer,
  qty        integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  added_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, cart_id) REFERENCES carts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id) ON DELETE CASCADE
);
-- The same product and option is one line (9.2).
CREATE UNIQUE INDEX cart_lines_item_idx ON cart_lines (tenant_id, cart_id, product_id, COALESCE(variant_id, 0));
SELECT fence_tenant_table('cart_lines');

-- At most 50 lines in a cart, whatever the code does.
CREATE FUNCTION cart_lines_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM carts WHERE tenant_id = NEW.tenant_id AND id = NEW.cart_id FOR UPDATE;
  IF (SELECT count(*) FROM cart_lines WHERE tenant_id = NEW.tenant_id AND cart_id = NEW.cart_id) >= 50 THEN
    RAISE EXCEPTION 'A cart holds at most 50 lines' USING ERRCODE = 'check_violation', CONSTRAINT = 'cart_lines_cap';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cart_lines_cap BEFORE INSERT ON cart_lines FOR EACH ROW EXECUTE FUNCTION cart_lines_cap();

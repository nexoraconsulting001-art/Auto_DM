-- Phase 4: orders (PRD 9.5, 9.9). The Phase 0 orders table grows rather than being replaced, so everything that already
-- reads it (home numbers, traffic, the funnel, the console) keeps working on the same rows.
--
-- An order now has two statuses kept apart (9.9): fulfilment_status and payment_status. The Phase 0 `status` column stays
-- and is derived from them, so no earlier reader changes. `flow` says which rules made the order:
--   manual    the Phase 0 store (manual UPI, "I've paid"). `status` is written as before and the two new columns follow it.
--   checkout  Phase 4 checkout. The two new columns are the truth, every change must be a move in status_transitions,
--             and the totals must match the lines. `status` follows.
-- Phase 4 code changes an order's status only through src/modules/orders/state.js; the triggers here are the second lock.

-- Every allowed move of every machine, the same list as TRANSITIONS in src/contracts/orders.js (a test keeps them in step).
CREATE TABLE status_transitions (
  machine     text NOT NULL CHECK (machine IN ('fulfilment', 'payment', 'payment_attempt', 'refund', 'shipment', 'return')),
  from_status text NOT NULL,
  to_status   text NOT NULL,
  guard       text NOT NULL DEFAULT '' CHECK (guard IN ('', 'confirmed_payment', 'late_payment', 'mode_prepaid', 'mode_cod', 'mode_part_advance')),
  PRIMARY KEY (machine, from_status, to_status)
);
GRANT SELECT ON status_transitions TO bhava_app;
INSERT INTO status_transitions (machine, from_status, to_status, guard) VALUES
  ('fulfilment', 'pending', 'new', 'confirmed_payment'),
  ('fulfilment', 'pending', 'cancelled', ''),
  ('fulfilment', 'new', 'packed', ''),
  ('fulfilment', 'new', 'ready_to_ship', ''),
  ('fulfilment', 'new', 'shipped', ''),
  ('fulfilment', 'new', 'cancelled', ''),
  ('fulfilment', 'packed', 'ready_to_ship', ''),
  ('fulfilment', 'packed', 'shipped', ''),
  ('fulfilment', 'packed', 'cancelled', ''),
  ('fulfilment', 'ready_to_ship', 'shipped', ''),
  ('fulfilment', 'ready_to_ship', 'cancelled', ''),
  ('fulfilment', 'shipped', 'out_for_delivery', ''),
  ('fulfilment', 'shipped', 'delivered', ''),
  ('fulfilment', 'shipped', 'rto_initiated', ''),
  ('fulfilment', 'out_for_delivery', 'delivered', ''),
  ('fulfilment', 'out_for_delivery', 'rto_initiated', ''),
  ('fulfilment', 'rto_initiated', 'rto_delivered', ''),
  ('fulfilment', 'rto_initiated', 'delivered', ''),
  ('fulfilment', 'cancelled', 'new', 'late_payment'),
  ('payment', 'unpaid', 'paid', 'mode_prepaid'),
  ('payment', 'unpaid', 'advance_paid', 'mode_part_advance'),
  ('payment', 'unpaid', 'cod_due', 'mode_cod'),
  ('payment', 'cod_due', 'paid', ''),
  ('payment', 'cod_due', 'voided', ''),
  ('payment', 'advance_paid', 'paid', ''),
  ('payment', 'advance_paid', 'partially_refunded', ''),
  ('payment', 'advance_paid', 'refunded', ''),
  ('payment', 'paid', 'partially_refunded', ''),
  ('payment', 'paid', 'refunded', ''),
  ('payment', 'partially_refunded', 'refunded', ''),
  ('payment_attempt', 'created', 'authorized', ''),
  ('payment_attempt', 'created', 'captured', ''),
  ('payment_attempt', 'created', 'failed', ''),
  ('payment_attempt', 'created', 'cancelled', ''),
  ('payment_attempt', 'authorized', 'captured', ''),
  ('payment_attempt', 'authorized', 'failed', ''),
  ('payment_attempt', 'failed', 'authorized', ''),
  ('payment_attempt', 'failed', 'captured', ''),
  ('refund', 'requested', 'processed', ''),
  ('refund', 'requested', 'failed', ''),
  ('refund', 'failed', 'processed', ''),
  ('shipment', 'created', 'awb_assigned', ''),
  ('shipment', 'created', 'cancelled', ''),
  ('shipment', 'awb_assigned', 'pickup_scheduled', ''),
  ('shipment', 'awb_assigned', 'picked_up', ''),
  ('shipment', 'awb_assigned', 'in_transit', ''),
  ('shipment', 'awb_assigned', 'cancelled', ''),
  ('shipment', 'pickup_scheduled', 'picked_up', ''),
  ('shipment', 'pickup_scheduled', 'in_transit', ''),
  ('shipment', 'pickup_scheduled', 'cancelled', ''),
  ('shipment', 'picked_up', 'in_transit', ''),
  ('shipment', 'picked_up', 'out_for_delivery', ''),
  ('shipment', 'picked_up', 'delivered', ''),
  ('shipment', 'picked_up', 'rto_initiated', ''),
  ('shipment', 'picked_up', 'lost', ''),
  ('shipment', 'in_transit', 'out_for_delivery', ''),
  ('shipment', 'in_transit', 'undelivered', ''),
  ('shipment', 'in_transit', 'delivered', ''),
  ('shipment', 'in_transit', 'rto_initiated', ''),
  ('shipment', 'in_transit', 'lost', ''),
  ('shipment', 'out_for_delivery', 'delivered', ''),
  ('shipment', 'out_for_delivery', 'undelivered', ''),
  ('shipment', 'out_for_delivery', 'rto_initiated', ''),
  ('shipment', 'out_for_delivery', 'lost', ''),
  ('shipment', 'undelivered', 'out_for_delivery', ''),
  ('shipment', 'undelivered', 'delivered', ''),
  ('shipment', 'undelivered', 'rto_initiated', ''),
  ('shipment', 'undelivered', 'lost', ''),
  ('shipment', 'rto_initiated', 'rto_delivered', ''),
  ('shipment', 'rto_initiated', 'delivered', ''),
  ('shipment', 'rto_initiated', 'lost', ''),
  ('return', 'requested', 'approved', ''),
  ('return', 'requested', 'rejected', ''),
  ('return', 'requested', 'cancelled', ''),
  ('return', 'approved', 'pickup_scheduled', ''),
  ('return', 'approved', 'received', ''),
  ('return', 'approved', 'cancelled', ''),
  ('return', 'pickup_scheduled', 'picked_up', ''),
  ('return', 'pickup_scheduled', 'received', ''),
  ('return', 'pickup_scheduled', 'cancelled', ''),
  ('return', 'picked_up', 'received', ''),
  ('return', 'received', 'refunded', ''),
  ('return', 'received', 'exchanged', '')
;

-- Money is bigint paise everywhere (an order above a 32-bit amount is an order, not a server error).
ALTER TABLE orders
  ALTER COLUMN subtotal_paise TYPE bigint,
  ALTER COLUMN shipping_paise TYPE bigint,
  ALTER COLUMN total_paise TYPE bigint,
  ADD COLUMN flow              text NOT NULL DEFAULT 'manual' CHECK (flow IN ('manual', 'checkout')),
  ADD COLUMN fulfilment_status text NOT NULL DEFAULT 'pending'
    CHECK (fulfilment_status IN ('pending', 'new', 'packed', 'ready_to_ship', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'rto_initiated', 'rto_delivered')),
  ADD COLUMN payment_status    text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'submitted', 'cod_due', 'advance_paid', 'paid', 'partially_refunded', 'refunded', 'voided')),
  ADD COLUMN payment_mode      text NOT NULL DEFAULT 'manual' CHECK (payment_mode IN ('prepaid', 'cod', 'part_advance', 'manual')),
  -- On hold for a person to look at, without changing either status (9.7 mismatch, 9.12 paid with no stock, 9.22 risk).
  ADD COLUMN hold_reason       text CHECK (hold_reason IN ('payment_mismatch', 'paid_out_of_stock', 'cod_risk', 'review')),
  ADD COLUMN cancel_reason     text CHECK (cancel_reason IN ('shopper', 'seller', 'hold_expired', 'payment_failed', 'out_of_stock', 'fraud', 'other')),
  ADD COLUMN shopper_id        integer,
  -- The traffic visitor who placed it (7.4): the order event carries the order, and traffic ties the two together.
  ADD COLUMN visitor_id        uuid,
  -- One per checkout attempt (9.5): the same key again answers with the same order (S-15).
  ADD COLUMN idempotency_key   text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 80),
  ADD COLUMN discount_paise    bigint NOT NULL DEFAULT 0,
  ADD COLUMN loyalty_paise     bigint NOT NULL DEFAULT 0,
  ADD COLUMN cod_fee_paise     bigint NOT NULL DEFAULT 0,
  -- GST inside the total (prices include tax), for display; the invoice is the record (9.13).
  ADD COLUMN tax_paise         bigint NOT NULL DEFAULT 0,
  -- As placed and never changed: what is paid online first, and what the courier collects at the door (the label's COD amount).
  ADD COLUMN advance_paise     bigint NOT NULL DEFAULT 0,
  ADD COLUMN balance_paise     bigint NOT NULL DEFAULT 0,
  -- Running totals of captured payments and of refunds, kept by the payments and refunds modules.
  ADD COLUMN paid_paise        bigint NOT NULL DEFAULT 0,
  ADD COLUMN refunded_paise    bigint NOT NULL DEFAULT 0,
  ADD COLUMN coupon_id         integer,
  ADD COLUMN coupon_code       text NOT NULL DEFAULT '' CHECK (length(coupon_code) <= 40),
  ADD COLUMN loyalty_points    integer NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  -- The delivery address as it was when the order was placed (S-14): { name, phone, line1, line2, landmark, city, stateCode, pincode }.
  ADD COLUMN shipping_address  jsonb CHECK (shipping_address IS NULL OR jsonb_typeof(shipping_address) = 'object'),
  -- Where it came from (9.5): the landing page, and the UTM tags as they arrived.
  ADD COLUMN page_id           integer,
  ADD COLUMN utm               jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(utm) = 'object'),
  -- Which gateway account took the money, fixed when the order was placed (S-72).
  ADD COLUMN gateway_mode      text CHECK (gateway_mode IN ('managed', 'own')),
  ADD COLUMN terms_accepted_at timestamptz,
  ADD COLUMN consent_notice_version integer,
  -- An unpaid order keeps its stock until this time (9.12).
  ADD COLUMN hold_expires_at   timestamptz,
  -- A label only, never where it came from (9.22).
  ADD COLUMN cod_risk          text CHECK (cod_risk IN ('none', 'elevated', 'high')),
  ADD COLUMN confirmed_at      timestamptz,
  ADD COLUMN paid_at           timestamptz,
  ADD COLUMN shipped_at        timestamptz,
  ADD COLUMN delivered_at      timestamptz,
  ADD COLUMN cancelled_at      timestamptz,
  -- Personal data masked on a deletion request; the order itself is a tax record and stays (9.18).
  ADD COLUMN erased_at         timestamptz,
  ADD CONSTRAINT orders_money_not_negative CHECK (subtotal_paise >= 0 AND shipping_paise >= 0 AND total_paise >= 0 AND discount_paise >= 0 AND loyalty_paise >= 0
    AND cod_fee_paise >= 0 AND tax_paise >= 0 AND advance_paise >= 0 AND balance_paise >= 0 AND paid_paise >= 0 AND refunded_paise >= 0),
  ADD CONSTRAINT orders_total_adds_up CHECK (total_paise = subtotal_paise - discount_paise - loyalty_paise + shipping_paise + cod_fee_paise),
  ADD CONSTRAINT orders_refund_within_paid CHECK (refunded_paise <= paid_paise),
  ADD CONSTRAINT orders_tax_within_total CHECK (tax_paise <= total_paise + loyalty_paise),
  ADD CONSTRAINT orders_checkout_complete CHECK (flow = 'manual' OR (idempotency_key IS NOT NULL AND shipping_address IS NOT NULL AND payment_mode <> 'manual')),
  ADD CONSTRAINT orders_split_adds_up CHECK (flow = 'manual' OR CASE payment_mode
    WHEN 'part_advance' THEN advance_paise > 0 AND balance_paise > 0 AND advance_paise + balance_paise = total_paise
    WHEN 'cod' THEN advance_paise = 0 AND balance_paise = total_paise
    ELSE advance_paise = 0 AND balance_paise = 0 END),
  ADD CONSTRAINT orders_shopper_fk FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE SET NULL (shopper_id),
  ADD CONSTRAINT orders_page_fk FOREIGN KEY (tenant_id, page_id) REFERENCES reels(tenant_id, id) ON DELETE SET NULL (page_id);

CREATE UNIQUE INDEX orders_idempotency_idx ON orders (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_shopper_idx ON orders (tenant_id, shopper_id) WHERE shopper_id IS NOT NULL;
CREATE INDEX orders_fulfilment_idx ON orders (tenant_id, fulfilment_status, id DESC);
CREATE INDEX orders_payment_idx ON orders (tenant_id, payment_status, id DESC);
CREATE INDEX orders_phone_idx ON orders (tenant_id, phone);
CREATE INDEX orders_created_idx ON orders (tenant_id, created_at DESC);
-- The hold-expiry and pending-payment jobs scan across businesses (through db.platform).
CREATE INDEX orders_hold_idx ON orders (hold_expires_at) WHERE fulfilment_status = 'pending' AND flow = 'checkout';

-- Lines hold what was sold as it was sold: price, tax rate and HSN are copies, so a later catalog edit changes no order.
ALTER TABLE order_items
  ALTER COLUMN price_paise TYPE bigint,
  ADD COLUMN variant_id     integer,
  ADD COLUMN sku            text NOT NULL DEFAULT '' CHECK (length(sku) <= 100),
  ADD COLUMN hsn_code       text NOT NULL DEFAULT '' CHECK (hsn_code = '' OR hsn_code ~ '^[0-9]{4,8}$'),
  -- GST rate in hundredths of a percent: 5% is 500.
  ADD COLUMN gst_rate_bp    integer NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  -- This line's share of the order's coupon discount, and the GST inside what is left (9.14: GST on the discounted value).
  ADD COLUMN discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  ADD COLUMN tax_paise      bigint NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  ADD COLUMN weight_grams   integer CHECK (weight_grams IS NULL OR weight_grams > 0),
  ADD CONSTRAINT order_items_tenant_id_key UNIQUE (tenant_id, id),
  ADD CONSTRAINT order_items_price_not_negative CHECK (price_paise >= 0),
  ADD CONSTRAINT order_items_discount_within_line CHECK (discount_paise <= price_paise * qty),
  ADD CONSTRAINT order_items_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id) ON DELETE SET NULL (variant_id);
CREATE INDEX order_items_tenant_order_idx ON order_items (tenant_id, order_id);
-- "How many sold" per product reads this business's lines only.
CREATE INDEX order_items_product_idx ON order_items (tenant_id, product_id);

-- The timeline (9.9): who changed what and when. Written by the trigger in migration 403 for every change, whoever made
-- it; the actor and reason come from the transaction (state.js sets them). Insert-only.
CREATE TABLE order_status_history (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id    integer NOT NULL,
  machine     text NOT NULL CHECK (machine IN ('created', 'fulfilment', 'payment', 'hold', 'note')),
  from_status text NOT NULL DEFAULT '',
  to_status   text NOT NULL DEFAULT '',
  -- 'user:12', 'shopper:7', 'system', 'webhook:razorpay', 'job:hold-expiry'. Never a name or a phone number.
  actor       text NOT NULL DEFAULT 'system' CHECK (length(actor) <= 80),
  reason      text NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
  note        text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX order_status_history_order_idx ON order_status_history (tenant_id, order_id, id);
SELECT fence_tenant_table('order_status_history', 'SELECT, INSERT');

CREATE FUNCTION order_guard_passes(guard text, payment_status text, payment_mode text, cancel_reason text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE guard
    WHEN '' THEN true
    WHEN 'confirmed_payment' THEN payment_status IN ('paid', 'advance_paid', 'cod_due')
    WHEN 'late_payment' THEN cancel_reason IS NOT DISTINCT FROM 'hold_expired' AND payment_status IN ('paid', 'advance_paid')
    WHEN 'mode_prepaid' THEN payment_mode = 'prepaid'
    WHEN 'mode_cod' THEN payment_mode = 'cod'
    WHEN 'mode_part_advance' THEN payment_mode = 'part_advance'
    ELSE false END
$$;

CREATE FUNCTION legacy_order_status(fulfilment text, payment text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN fulfilment IN ('cancelled', 'rto_initiated', 'rto_delivered') THEN 'cancelled'
    WHEN fulfilment = 'delivered' THEN 'delivered'
    WHEN fulfilment IN ('shipped', 'out_for_delivery') THEN 'shipped'
    WHEN fulfilment = 'pending' THEN CASE WHEN payment = 'submitted' THEN 'payment_submitted' ELSE 'awaiting_payment' END
    ELSE 'paid' END
$$;

CREATE FUNCTION orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id <> OLD.tenant_id OR NEW.flow <> OLD.flow) THEN
    RAISE EXCEPTION 'An order never changes its business or its flow' USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_fixed';
  END IF;

  IF NEW.flow = 'manual' THEN
    -- A Phase 0 order: `status` is what was written, and the two new columns follow it. Its one rule stays: cancelled is final.
    IF NEW.status NOT IN ('awaiting_payment', 'payment_submitted', 'paid', 'shipped', 'delivered', 'cancelled') THEN
      RAISE EXCEPTION 'Unknown order status %', NEW.status USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_status_known';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'A cancelled order cannot be reopened' USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_transition';
    END IF;
    NEW.fulfilment_status := CASE NEW.status WHEN 'awaiting_payment' THEN 'pending' WHEN 'payment_submitted' THEN 'pending' WHEN 'paid' THEN 'new' ELSE NEW.status END;
    NEW.payment_status := CASE NEW.status
      WHEN 'awaiting_payment' THEN 'unpaid'
      WHEN 'payment_submitted' THEN 'submitted'
      WHEN 'cancelled' THEN CASE WHEN TG_OP = 'UPDATE' THEN OLD.payment_status ELSE 'unpaid' END
      ELSE 'paid' END;
  ELSE
    IF TG_OP = 'INSERT' THEN
      IF NEW.fulfilment_status <> 'pending' OR NEW.payment_status <> 'unpaid' THEN
        RAISE EXCEPTION 'A new order starts pending and unpaid' USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_transition';
      END IF;
    ELSE
      IF NEW.payment_status <> OLD.payment_status THEN
        SELECT guard INTO g FROM status_transitions WHERE machine = 'payment' AND from_status = OLD.payment_status AND to_status = NEW.payment_status;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'An order''s payment cannot go from % to %', OLD.payment_status, NEW.payment_status USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_transition';
        END IF;
        IF NOT order_guard_passes(g, NEW.payment_status, NEW.payment_mode, OLD.cancel_reason) THEN
          RAISE EXCEPTION 'An order''s payment cannot go from % to % here (%)', OLD.payment_status, NEW.payment_status, g USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_guard';
        END IF;
      END IF;
      IF NEW.fulfilment_status <> OLD.fulfilment_status THEN
        SELECT guard INTO g FROM status_transitions WHERE machine = 'fulfilment' AND from_status = OLD.fulfilment_status AND to_status = NEW.fulfilment_status;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'An order cannot go from % to %', OLD.fulfilment_status, NEW.fulfilment_status USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_transition';
        END IF;
        IF NOT order_guard_passes(g, NEW.payment_status, NEW.payment_mode, OLD.cancel_reason) THEN
          RAISE EXCEPTION 'An order cannot go from % to % here (%)', OLD.fulfilment_status, NEW.fulfilment_status, g USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_guard';
        END IF;
      END IF;
      -- What was agreed at checkout is never rewritten afterwards.
      IF NEW.total_paise <> OLD.total_paise OR NEW.subtotal_paise <> OLD.subtotal_paise OR NEW.advance_paise <> OLD.advance_paise OR NEW.balance_paise <> OLD.balance_paise
         OR NEW.payment_mode <> OLD.payment_mode OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.order_number <> OLD.order_number THEN
        RAISE EXCEPTION 'An order''s totals, number and way of paying are fixed once it is placed' USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_fixed';
      END IF;
    END IF;
    NEW.status := legacy_order_status(NEW.fulfilment_status, NEW.payment_status);
  END IF;

  IF TG_OP = 'INSERT' OR NEW.fulfilment_status <> OLD.fulfilment_status THEN
    IF NEW.fulfilment_status = 'new' THEN
      NEW.confirmed_at := COALESCE(NEW.confirmed_at, now());
      NEW.cancelled_at := NULL;
      NEW.cancel_reason := NULL;
    ELSIF NEW.fulfilment_status = 'shipped' THEN NEW.shipped_at := COALESCE(NEW.shipped_at, now());
    ELSIF NEW.fulfilment_status = 'delivered' THEN NEW.delivered_at := COALESCE(NEW.delivered_at, now());
    ELSIF NEW.fulfilment_status = 'cancelled' THEN NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.payment_status <> OLD.payment_status) AND NEW.payment_status IN ('paid', 'advance_paid') THEN
    NEW.paid_at := COALESCE(NEW.paid_at, now());
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_guard BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION orders_guard();

-- Orders that were already here get their two statuses from the one they had.
UPDATE orders SET status = status;

-- A checkout order's money must match its lines (9.5): at least one line, the subtotal is the lines' prices times quantities,
-- and the discount is the lines' shares of it. Checked when the transaction commits, so an order and its lines go in together.
CREATE FUNCTION order_totals_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tid integer;
  oid integer;
  o record;
  s record;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    tid := NEW.tenant_id; oid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    tid := OLD.tenant_id; oid := OLD.order_id;
  ELSE
    tid := NEW.tenant_id; oid := NEW.order_id;
  END IF;
  SELECT flow, subtotal_paise, discount_paise, tax_paise INTO o FROM orders WHERE tenant_id = tid AND id = oid;
  IF NOT FOUND OR o.flow <> 'checkout' THEN RETURN NULL; END IF;
  SELECT count(*) AS n, COALESCE(sum(price_paise * qty), 0) AS gross, COALESCE(sum(discount_paise), 0) AS discount, COALESCE(sum(tax_paise), 0) AS tax
    INTO s FROM order_items WHERE tenant_id = tid AND order_id = oid;
  IF s.n = 0 THEN
    RAISE EXCEPTION 'Order % has no lines', oid USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_lines_match';
  END IF;
  IF s.gross <> o.subtotal_paise OR s.discount <> o.discount_paise OR s.tax > o.tax_paise THEN
    RAISE EXCEPTION 'Order % totals do not match its lines', oid USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_lines_match';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER orders_lines_match AFTER INSERT OR UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_totals_check();
CREATE CONSTRAINT TRIGGER order_items_lines_match AFTER INSERT OR UPDATE OR DELETE ON order_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_totals_check();

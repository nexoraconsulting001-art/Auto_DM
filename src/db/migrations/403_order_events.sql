-- Phase 4: the order event bus. An outbox row is written in the same transaction as every change to an order, a payment,
-- a refund, a shipment or a return, by a trigger, so no change can commit without its event and no event exists for a change
-- that rolled back. The worker hands each event to every listener at least once (src/modules/orders/events.js), in order per
-- order and listener. Listeners must be idempotent: the event id is the key.
--
-- An event carries ids and statuses only: never a name, phone number, address or message text.
CREATE TABLE order_events (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- One of ORDER_EVENTS in src/contracts/orders.js: 'order.paid', 'shipment.delivered', 'refund.processed', ...
  type          text NOT NULL CHECK (type ~ '^[a-z_]+\.[a-z_]+$' AND length(type) <= 60),
  order_id      integer NOT NULL,
  entity        text NOT NULL CHECK (entity IN ('order', 'payment', 'refund', 'shipment', 'return', 'invoice', 'stock')),
  entity_id     bigint NOT NULL,
  from_status   text NOT NULL DEFAULT '',
  to_status     text NOT NULL DEFAULT '',
  data          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 4096),
  -- For events a module emits itself: the same key again is dropped.
  dedupe_key    text CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set by the dispatcher once a delivery row exists for every listener.
  fanned_out_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX order_events_dedupe_idx ON order_events (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX order_events_new_idx ON order_events (id) WHERE fanned_out_at IS NULL;
CREATE INDEX order_events_order_idx ON order_events (tenant_id, order_id, id);
-- Business code adds events and reads its own; only the dispatcher, which works across businesses, marks them.
SELECT fence_tenant_table('order_events', 'SELECT, INSERT');

-- One row per event and listener. Pending rows are retried with backoff; after the last try a row is failed and ops are told.
CREATE TABLE order_event_deliveries (
  event_id        bigint NOT NULL REFERENCES order_events(id) ON DELETE CASCADE,
  listener        text NOT NULL CHECK (length(listener) BETWEEN 1 AND 80),
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id        integer NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text NOT NULL DEFAULT '' CHECK (length(last_error) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz,
  PRIMARY KEY (event_id, listener)
);
CREATE INDEX order_event_deliveries_due_idx ON order_event_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX order_event_deliveries_order_idx ON order_event_deliveries (listener, tenant_id, order_id, event_id) WHERE status = 'pending';
SELECT fence_tenant_table('order_event_deliveries', 'SELECT');

-- Every change to an order: its timeline row and its event, in the same transaction, whoever made the change.
-- The actor and reason come from the transaction's settings, which state.js sets; anything else is recorded as 'system'.
CREATE FUNCTION orders_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  who  text := COALESCE(NULLIF(current_setting('app.order_actor', true), ''), 'system');
  why  text := COALESCE(current_setting('app.order_reason', true), '');
  kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_status_history (tenant_id, order_id, machine, to_status, actor, reason) VALUES (NEW.tenant_id, NEW.id, 'created', NEW.fulfilment_status, left(who, 80), left(why, 200));
    INSERT INTO order_events (tenant_id, type, order_id, entity, entity_id, to_status) VALUES (NEW.tenant_id, 'order.created', NEW.id, 'order', NEW.id, NEW.fulfilment_status);
    RETURN NULL;
  END IF;

  -- Money first, so 'order.paid' is always before the 'order.confirmed' it causes.
  IF NEW.payment_status <> OLD.payment_status THEN
    INSERT INTO order_status_history (tenant_id, order_id, machine, from_status, to_status, actor, reason)
      VALUES (NEW.tenant_id, NEW.id, 'payment', OLD.payment_status, NEW.payment_status, left(who, 80), left(why, 200));
    kind := CASE NEW.payment_status
      WHEN 'paid' THEN 'order.paid' WHEN 'advance_paid' THEN 'order.advance_paid' WHEN 'cod_due' THEN 'order.cod_confirmed' WHEN 'voided' THEN 'order.cod_voided'
      WHEN 'partially_refunded' THEN 'order.partially_refunded' WHEN 'refunded' THEN 'order.refunded' END;
    IF kind IS NOT NULL THEN
      INSERT INTO order_events (tenant_id, type, order_id, entity, entity_id, from_status, to_status) VALUES (NEW.tenant_id, kind, NEW.id, 'order', NEW.id, OLD.payment_status, NEW.payment_status);
    END IF;
  END IF;

  IF NEW.fulfilment_status <> OLD.fulfilment_status THEN
    INSERT INTO order_status_history (tenant_id, order_id, machine, from_status, to_status, actor, reason)
      VALUES (NEW.tenant_id, NEW.id, 'fulfilment', OLD.fulfilment_status, NEW.fulfilment_status, left(who, 80), left(why, 200));
    kind := CASE
      WHEN NEW.fulfilment_status = 'pending' THEN NULL -- only a Phase 0 order can go back to waiting
      WHEN NEW.fulfilment_status = 'new' AND OLD.fulfilment_status = 'cancelled' THEN 'order.reinstated'
      WHEN NEW.fulfilment_status = 'new' THEN 'order.confirmed'
      ELSE 'order.' || NEW.fulfilment_status END;
    IF kind IS NOT NULL THEN
      INSERT INTO order_events (tenant_id, type, order_id, entity, entity_id, from_status, to_status) VALUES (NEW.tenant_id, kind, NEW.id, 'order', NEW.id, OLD.fulfilment_status, NEW.fulfilment_status);
    END IF;
  END IF;

  IF NEW.hold_reason IS DISTINCT FROM OLD.hold_reason THEN
    INSERT INTO order_status_history (tenant_id, order_id, machine, from_status, to_status, actor, reason)
      VALUES (NEW.tenant_id, NEW.id, 'hold', COALESCE(OLD.hold_reason, ''), COALESCE(NEW.hold_reason, ''), left(who, 80), left(why, 200));
    INSERT INTO order_events (tenant_id, type, order_id, entity, entity_id, from_status, to_status)
      VALUES (NEW.tenant_id, CASE WHEN NEW.hold_reason IS NULL THEN 'order.released' ELSE 'order.held' END, NEW.id, 'order', NEW.id, COALESCE(OLD.hold_reason, ''), COALESCE(NEW.hold_reason, ''));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER orders_record AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION orders_record();

-- The same two locks for the rows that hang off an order: payments, refunds, shipments and returns. Each has tenant_id, id,
-- order_id, status and updated_at. Attach with:
--   CREATE TRIGGER x_guard  BEFORE UPDATE ON x FOR EACH ROW EXECUTE FUNCTION status_machine_guard('<machine>');
--   CREATE TRIGGER x_record AFTER INSERT OR UPDATE ON x FOR EACH ROW EXECUTE FUNCTION status_machine_record('<entity>');
CREATE FUNCTION status_machine_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.order_id <> OLD.order_id THEN
    RAISE EXCEPTION 'A % never changes its business or its order', TG_ARGV[0] USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_fixed';
  END IF;
  IF NEW.status <> OLD.status AND NOT EXISTS (SELECT 1 FROM status_transitions WHERE machine = TG_ARGV[0] AND from_status = OLD.status AND to_status = NEW.status) THEN
    RAISE EXCEPTION 'A % cannot go from % to %', TG_ARGV[0], OLD.status, NEW.status USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_transition';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION status_machine_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_events (tenant_id, type, order_id, entity, entity_id, to_status) VALUES (NEW.tenant_id, TG_ARGV[0] || '.' || NEW.status, NEW.order_id, TG_ARGV[0], NEW.id, NEW.status);
  ELSIF NEW.status <> OLD.status THEN
    INSERT INTO order_events (tenant_id, type, order_id, entity, entity_id, from_status, to_status)
      VALUES (NEW.tenant_id, TG_ARGV[0] || '.' || NEW.status, NEW.order_id, TG_ARGV[0], NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NULL;
END $$;

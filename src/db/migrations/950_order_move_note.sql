-- A seller's note on a move is part of that move's timeline entry (S-32): "Packed from the app" is on the entry that says
-- new -> packed, so the app and the web admin show one entry with its note. state.js sets app.order_note with the actor and
-- the reason, for this transaction only, and clears it on every change, so a note never carries over to the next change.
-- Only the fulfilment move takes it: a payment move in the same statement is the gateway's or the system's, not the note's.
CREATE OR REPLACE FUNCTION orders_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  who  text := COALESCE(NULLIF(current_setting('app.order_actor', true), ''), 'system');
  why  text := COALESCE(current_setting('app.order_reason', true), '');
  said text := COALESCE(current_setting('app.order_note', true), '');
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
    INSERT INTO order_status_history (tenant_id, order_id, machine, from_status, to_status, actor, reason, note)
      VALUES (NEW.tenant_id, NEW.id, 'fulfilment', OLD.fulfilment_status, NEW.fulfilment_status, left(who, 80), left(why, 200), left(said, 1000));
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

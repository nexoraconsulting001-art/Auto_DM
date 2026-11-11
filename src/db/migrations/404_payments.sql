-- Phase 4: payments, gateway webhooks and refunds (PRD 9.6 to 9.8). Money is bigint paise. Card data is never stored.

-- How each business takes money (9.5, 9.6). No row means: managed mode, no online payment until KYC passes, COD off.
CREATE TABLE payment_settings (
  tenant_id            integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- managed: Bhava's Razorpay account with Route split settlement. own: the seller's connected account. A switch applies to new orders only (S-72).
  mode                 text NOT NULL DEFAULT 'managed' CHECK (mode IN ('managed', 'own')),
  provider             text NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay', 'cashfree')),
  -- Managed: the seller's Route linked account, and where its KYC stands. Online payment is off until 'verified'.
  linked_account_id    text CHECK (linked_account_id IS NULL OR length(linked_account_id) BETWEEN 1 AND 60),
  kyc_status           text NOT NULL DEFAULT 'not_started' CHECK (kyc_status IN ('not_started', 'pending', 'verified', 'rejected')),
  -- Own: the seller's account, connected by Partner OAuth (tokens encrypted with DATA_KEY) or by keys in gateway_keys (5.15).
  own_account_id       text CHECK (own_account_id IS NULL OR length(own_account_id) BETWEEN 1 AND 60),
  own_connection       text NOT NULL DEFAULT 'none' CHECK (own_connection IN ('none', 'oauth', 'keys')),
  oauth_access_enc     text NOT NULL DEFAULT '',
  oauth_refresh_enc    text NOT NULL DEFAULT '',
  oauth_expires_at     timestamptz,
  -- The secret this business's own webhook URL is verified with, encrypted. The URL carries webhook_key, not the business id.
  webhook_secret_enc   text NOT NULL DEFAULT '',
  webhook_key          text CHECK (webhook_key IS NULL OR webhook_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  -- Which ways to pay the owner has on (9.6).
  upi                  boolean NOT NULL DEFAULT true,
  card                 boolean NOT NULL DEFAULT true,
  netbanking           boolean NOT NULL DEFAULT true,
  wallet               boolean NOT NULL DEFAULT true,
  cod                  boolean NOT NULL DEFAULT false,
  part_advance         boolean NOT NULL DEFAULT false,
  cod_fee_paise        bigint NOT NULL DEFAULT 0 CHECK (cod_fee_paise >= 0),
  cod_max_order_paise  bigint CHECK (cod_max_order_paise IS NULL OR cod_max_order_paise > 0),
  -- PINs cash on delivery is offered to; empty means wherever the courier offers it.
  cod_pincodes         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(cod_pincodes) <= 20000),
  -- Refuse cash on delivery to a number with this many returns to origin here; null is off.
  cod_block_rto_count  integer CHECK (cod_block_rto_count IS NULL OR cod_block_rto_count BETWEEN 1 AND 20),
  advance_kind         text NOT NULL DEFAULT 'fixed' CHECK (advance_kind IN ('fixed', 'percent')),
  -- Paise when fixed; hundredths of a percent when percent (1000 is 10%).
  advance_value        bigint NOT NULL DEFAULT 0 CHECK (advance_value >= 0),
  hold_minutes         integer NOT NULL DEFAULT 30 CHECK (hold_minutes BETWEEN 5 AND 1440),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (advance_kind <> 'percent' OR advance_value BETWEEN 1 AND 9900 OR NOT part_advance)
);
-- A managed webhook is routed to its business by the linked account, and an own one by the key in its URL (9.7).
CREATE UNIQUE INDEX payment_settings_linked_idx ON payment_settings (linked_account_id) WHERE linked_account_id IS NOT NULL;
CREATE UNIQUE INDEX payment_settings_webhook_key_idx ON payment_settings (webhook_key) WHERE webhook_key IS NOT NULL;
SELECT fence_tenant_table('payment_settings');

-- One attempt to take money for an order. The gateway order is created with the exact amount, and the receipt is the order
-- number (9.6). An order can have several: a retry after a failure, an advance and later the cash at the door.
CREATE TABLE payments (
  id                 bigserial PRIMARY KEY,
  tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id           integer NOT NULL,
  -- full: the whole order online. advance: the online part of part-advance. cod: cash collected by the courier.
  purpose            text NOT NULL CHECK (purpose IN ('full', 'advance', 'cod')),
  provider           text NOT NULL CHECK (provider IN ('razorpay', 'cashfree', 'cod')),
  mode               text NOT NULL CHECK (mode IN ('managed', 'own', 'cod')),
  -- The gateway account it ran on: the linked account in managed mode, the seller's own account otherwise.
  account_ref        text NOT NULL DEFAULT '' CHECK (length(account_ref) <= 60),
  gateway_order_id   text CHECK (gateway_order_id IS NULL OR length(gateway_order_id) BETWEEN 1 AND 80),
  gateway_payment_id text CHECK (gateway_payment_id IS NULL OR length(gateway_payment_id) BETWEEN 1 AND 80),
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  currency           text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status             text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'authorized', 'captured', 'failed', 'cancelled')),
  method             text NOT NULL DEFAULT '' CHECK (method IN ('', 'upi', 'card', 'netbanking', 'wallet', 'cod', 'other')),
  -- What the gateway kept, at cost, and the GST on it (9.6). Known when the payment is captured or settled.
  fee_paise          bigint NOT NULL DEFAULT 0 CHECK (fee_paise >= 0),
  fee_tax_paise      bigint NOT NULL DEFAULT 0 CHECK (fee_tax_paise >= 0),
  refunded_paise     bigint NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  -- Managed mode: the Route transfer to the seller's linked account, and how much of it was reversed by refunds.
  transfer_id        text CHECK (transfer_id IS NULL OR length(transfer_id) BETWEEN 1 AND 80),
  transfer_status    text NOT NULL DEFAULT 'none' CHECK (transfer_status IN ('none', 'created', 'processed', 'settled', 'failed', 'reversed')),
  transfer_paise     bigint NOT NULL DEFAULT 0 CHECK (transfer_paise >= 0),
  reversed_paise     bigint NOT NULL DEFAULT 0 CHECK (reversed_paise >= 0),
  -- A transfer that failed or was reversed by the gateway waits here for a person (9.7).
  needs_review       boolean NOT NULL DEFAULT false,
  error_code         text NOT NULL DEFAULT '' CHECK (length(error_code) <= 80),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  captured_at        timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (refunded_paise <= amount_paise),
  CHECK (reversed_paise <= transfer_paise AND transfer_paise <= amount_paise),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX payments_order_idx ON payments (tenant_id, order_id);
-- A gateway order or payment id names one payment, so a webhook can find its business (through db.platform) and a retry can't make a second row.
CREATE UNIQUE INDEX payments_gateway_order_idx ON payments (provider, account_ref, gateway_order_id) WHERE gateway_order_id IS NOT NULL;
CREATE UNIQUE INDEX payments_gateway_payment_idx ON payments (provider, account_ref, gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;
CREATE INDEX payments_pending_idx ON payments (created_at) WHERE status IN ('created', 'authorized');
SELECT fence_tenant_table('payments');
CREATE TRIGGER payments_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION status_machine_guard('payment_attempt');
CREATE TRIGGER payments_record AFTER INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION status_machine_record('payment');

-- Every provider webhook, stored before it is answered and worked through from here (9.7): Razorpay payments, Route
-- transfers, Cashfree, Shiprocket tracking, Shopify and WhatsApp. Only a delivery whose signature passed is stored.
-- (provider, scope, event_id) is unique, so the same event again is a duplicate, not a second change (S-23, S-35).
-- Platform only: it is written before the business is known, and read through db.platform.
CREATE TABLE provider_webhook_events (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL CHECK (provider IN ('razorpay', 'cashfree', 'shiprocket', 'shopify', 'whatsapp')),
  -- 'managed' for Bhava's own account's URL, or 'tenant:<id>' for a business's own URL.
  scope         text NOT NULL CHECK (scope = 'managed' OR scope ~ '^tenant:[0-9]+$'),
  -- The provider's own id for the event. Where it sends none (Shiprocket), the AWB, status and time joined (9.10).
  event_id      text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  event_type    text NOT NULL DEFAULT '' CHECK (length(event_type) <= 100),
  payload       jsonb NOT NULL,
  -- The business it belongs to, once worked out. Null while unknown and for events that name none.
  tenant_id     integer REFERENCES tenants(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  -- Why it changed nothing: 'tenant_mismatch' (S-73), 'unknown_order', 'stale' (an older state arriving late, S-24), 'not_handled'.
  outcome       text NOT NULL DEFAULT '' CHECK (length(outcome) <= 60),
  -- An event naming an order or account that isn't this URL's business: stored, ignored, and ops are told (9.7).
  security      boolean NOT NULL DEFAULT false,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text NOT NULL DEFAULT '' CHECK (length(last_error) <= 300),
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (provider, scope, event_id)
);
CREATE INDEX provider_webhook_events_todo_idx ON provider_webhook_events (id) WHERE status = 'received';
CREATE INDEX provider_webhook_events_tenant_idx ON provider_webhook_events (tenant_id, id DESC);
CREATE INDEX provider_webhook_events_security_idx ON provider_webhook_events (id DESC) WHERE security;

-- Refunds (9.8): requested, processed or failed. Through the gateway for an online payment; 'manual' with a reference for
-- cash. Only the owner asks for one, and each is in the audit log.
CREATE TABLE refunds (
  id                bigserial PRIMARY KEY,
  tenant_id         integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id          integer NOT NULL,
  payment_id        bigint NOT NULL,
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
  status            text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'processed', 'failed')),
  method            text NOT NULL CHECK (method IN ('gateway', 'manual')),
  -- For a manual refund: the UTR or receipt the owner typed.
  reference         text NOT NULL DEFAULT '' CHECK (length(reference) <= 100),
  gateway_refund_id text CHECK (gateway_refund_id IS NULL OR length(gateway_refund_id) BETWEEN 1 AND 80),
  reason            text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  -- Managed mode: the matching part of the seller's Route transfer taken back. Own mode never has one (S-76).
  reversal_status   text NOT NULL DEFAULT 'none' CHECK (reversal_status IN ('none', 'pending', 'reversed', 'failed', 'recover')),
  reversal_paise    bigint NOT NULL DEFAULT 0 CHECK (reversal_paise >= 0 AND reversal_paise <= amount_paise),
  reversal_id       text CHECK (reversal_id IS NULL OR length(reversal_id) BETWEEN 1 AND 80),
  -- Who asked: 'user:12'. And the key that makes a repeated request the same refund.
  requested_by      text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 80),
  idempotency_key   text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 80),
  error_code        text NOT NULL DEFAULT '' CHECK (length(error_code) <= 80),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX refunds_order_idx ON refunds (tenant_id, order_id);
CREATE INDEX refunds_payment_idx ON refunds (tenant_id, payment_id);
CREATE UNIQUE INDEX refunds_gateway_idx ON refunds (tenant_id, gateway_refund_id) WHERE gateway_refund_id IS NOT NULL;
SELECT fence_tenant_table('refunds');
CREATE TRIGGER refunds_guard BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION status_machine_guard('refund');
CREATE TRIGGER refunds_record AFTER INSERT OR UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION status_machine_record('refund');

-- The total refunded never exceeds what was captured (S-28), whatever two requests at once do: the payment row is locked,
-- it must be captured, the refund must be for the payment's own order, and refunds not failed must fit inside its amount.
CREATE FUNCTION refunds_within_captured() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p record;
  total bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.amount_paise <> OLD.amount_paise OR NEW.payment_id <> OLD.payment_id) THEN
    RAISE EXCEPTION 'A refund''s amount and payment are fixed' USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_fixed';
  END IF;
  IF NEW.status = 'failed' THEN RETURN NEW; END IF;
  SELECT order_id, status, amount_paise INTO p FROM payments WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id FOR UPDATE;
  IF NOT FOUND OR p.order_id <> NEW.order_id OR p.status <> 'captured' THEN
    RAISE EXCEPTION 'A refund needs a captured payment of the same order' USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_payment_captured';
  END IF;
  SELECT COALESCE(sum(amount_paise), 0) INTO total FROM refunds WHERE tenant_id = NEW.tenant_id AND payment_id = NEW.payment_id AND status <> 'failed' AND id <> NEW.id;
  IF total + NEW.amount_paise > p.amount_paise THEN
    RAISE EXCEPTION 'Refunds would exceed the amount captured' USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_within_captured';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_within_captured BEFORE INSERT OR UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_within_captured();

-- The seller's settlement statement (9.6), one line per thing that moved money for an order, each at cost with no markup:
-- positive is owed to the seller, negative is taken from it. (kind, ref) is unique, so writing a line twice is harmless.
CREATE TABLE settlement_lines (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id     integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('sale', 'gateway_fee', 'gateway_fee_tax', 'shipping_charge', 'refund', 'transfer', 'transfer_reversal', 'cod_remittance', 'adjustment')),
  amount_paise bigint NOT NULL,
  -- What it came from: 'payment:12', 'refund:3', 'shipment:8'.
  ref          text NOT NULL CHECK (length(ref) BETWEEN 1 AND 80),
  status       text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'review')),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, ref),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX settlement_lines_order_idx ON settlement_lines (tenant_id, order_id);
CREATE INDEX settlement_lines_time_idx ON settlement_lines (tenant_id, occurred_at DESC);
SELECT fence_tenant_table('settlement_lines');

-- What the daily match of captured payments, transfers and settlements could not pair up (9.7), for the Platform Console.
CREATE TABLE reconciliation_gaps (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day         date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('payment_missing', 'transfer_missing', 'transfer_failed', 'settlement_missing', 'amount_mismatch', 'refund_mismatch')),
  ref         text NOT NULL CHECK (length(ref) BETWEEN 1 AND 80),
  details     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (tenant_id, day, kind, ref)
);
CREATE INDEX reconciliation_gaps_open_idx ON reconciliation_gaps (status, day DESC);
SELECT fence_tenant_table('reconciliation_gaps', 'SELECT, INSERT');

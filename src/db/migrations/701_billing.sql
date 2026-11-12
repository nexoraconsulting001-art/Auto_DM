-- Phase 7: what a business pays Bhava, what it used, and what it was told (PRD 5.7, 5.12, 5.20). Every table here has
-- tenant_id and the fence. Money is bigint paise. Bhava is the seller on these invoices; the store's own invoices are 408.

-- ---- The subscription ----

-- One per business. `plan` and `cycle` say what is being billed; tenants.plan stays what entitlements read, and the two
-- move together through plan_changes below. Free needs no row: a business with none is on its plan with nothing to pay.
CREATE TABLE subscriptions (
  id                       bigserial PRIMARY KEY,
  tenant_id                integer NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan                     text NOT NULL REFERENCES plans(code),
  cycle                    text NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly', 'yearly')),
  -- active; past_due (a charge failed, not yet in grace); grace (until grace_until); suspended (after grace: an
  -- owner-locked pause, data kept, 4.12); cancelled.
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'grace', 'suspended', 'cancelled')),
  provider                 text NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay')),
  provider_customer_id     text CHECK (provider_customer_id IS NULL OR length(provider_customer_id) BETWEEN 1 AND 80),
  provider_subscription_id text UNIQUE CHECK (provider_subscription_id IS NULL OR length(provider_subscription_id) BETWEEN 1 AND 80),
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  grace_until              timestamptz,
  offer_code               text REFERENCES offers(code),
  -- A downgrade or a cycle change asked for now and applied when the paid period ends.
  next_plan                text REFERENCES plans(code),
  next_cycle               text CHECK (next_cycle IS NULL OR next_cycle IN ('monthly', 'yearly')),
  suspended_at             timestamptz,
  cancelled_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (status <> 'grace' OR grace_until IS NOT NULL),
  CHECK (current_period_end IS NULL OR current_period_start IS NULL OR current_period_end > current_period_start)
);
CREATE INDEX subscriptions_grace_idx ON subscriptions (grace_until) WHERE status = 'grace';
SELECT fence_tenant_table('subscriptions', 'SELECT, INSERT, UPDATE');

-- What runs on top of the plan: an add-on, packs (quantity), a managed service, a one-time setup. The price is the one
-- on the day it was bought. ends_at empty means it is still running.
CREATE TABLE subscription_items (
  id               bigserial PRIMARY KEY,
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id  bigint,
  addon_code       text NOT NULL REFERENCES addons(code),
  kind             text NOT NULL CHECK (kind IN ('addon', 'pack', 'service', 'setup')),
  quantity         integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 1000),
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
  cycle            text NOT NULL CHECK (cycle IN ('monthly', 'one_time')),
  starts_at        timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz,
  -- The last period this item was put on an invoice for, so a line is never billed twice.
  billed_through   timestamptz,
  provider_item_id text CHECK (provider_item_id IS NULL OR length(provider_item_id) BETWEEN 1 AND 80),
  -- Who bought it: 'user:12', 'platform:3'. And the key that makes a repeated request the same item.
  created_by       text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 80),
  request_key      text NOT NULL CHECK (length(request_key) BETWEEN 8 AND 80),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_key),
  CHECK (ends_at IS NULL OR ends_at >= starts_at),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX subscription_items_running_idx ON subscription_items (tenant_id, addon_code) WHERE ends_at IS NULL;
SELECT fence_tenant_table('subscription_items', 'SELECT, INSERT, UPDATE');

-- Every change of plan or cycle, by whom and why (5.7). Business code only reads it. It is written through db.platform,
-- and inserting a row is what changes the plan: the trigger sets tenants.plan and tenants.billing_cycle in the same
-- transaction, and reads from_plan and from_cycle itself. A plan changed directly on tenants still gets its row
-- (actor 'system:direct'), so no change is ever unrecorded.
CREATE TABLE plan_changes (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_plan   text NOT NULL REFERENCES plans(code),
  to_plan     text NOT NULL REFERENCES plans(code),
  from_cycle  text NOT NULL CHECK (from_cycle IN ('monthly', 'yearly')),
  to_cycle    text NOT NULL CHECK (to_cycle IN ('monthly', 'yearly')),
  -- 'user:12' (the owner), 'platform:3' (an override in the console), 'billing' (a webhook, the end of grace), 'signup'.
  actor       text NOT NULL CHECK (length(actor) BETWEEN 1 AND 80),
  source      text NOT NULL CHECK (source IN ('owner', 'console', 'billing', 'signup', 'direct')),
  reason      text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX plan_changes_tenant_idx ON plan_changes (tenant_id, id DESC);
SELECT fence_tenant_table('plan_changes', 'SELECT');

CREATE FUNCTION plan_changes_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  was_plan text;
  was_cycle text;
BEGIN
  IF current_setting('bhava.plan_change', true) = 'direct' THEN
    RETURN NEW; -- written by tenants_plan_recorded below: tenants already holds the new plan
  END IF;
  SELECT plan, billing_cycle INTO was_plan, was_cycle FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;
  NEW.from_plan := was_plan;
  NEW.from_cycle := was_cycle;
  PERFORM set_config('bhava.plan_change', 'row', true);
  UPDATE tenants SET plan = NEW.to_plan, billing_cycle = NEW.to_cycle WHERE id = NEW.tenant_id;
  PERFORM set_config('bhava.plan_change', '', true);
  RETURN NEW;
END $$;
CREATE TRIGGER plan_changes_apply BEFORE INSERT ON plan_changes FOR EACH ROW EXECUTE FUNCTION plan_changes_apply();

CREATE FUNCTION tenants_plan_recorded() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('bhava.plan_change', true) = 'row' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('bhava.plan_change', 'direct', true);
  INSERT INTO plan_changes (tenant_id, from_plan, to_plan, from_cycle, to_cycle, actor, source)
    VALUES (NEW.id, OLD.plan, NEW.plan, OLD.billing_cycle, NEW.billing_cycle, 'system:direct', 'direct');
  PERFORM set_config('bhava.plan_change', '', true);
  RETURN NULL;
END $$;
CREATE TRIGGER tenants_plan_recorded AFTER UPDATE OF plan, billing_cycle ON tenants FOR EACH ROW
  WHEN (OLD.plan IS DISTINCT FROM NEW.plan OR OLD.billing_cycle IS DISTINCT FROM NEW.billing_cycle)
  EXECUTE FUNCTION tenants_plan_recorded();

-- Which business took which offer. Written only by claim_offer(), which counts the claim on the offer's row in the same
-- statement: when the count is full the check on offers refuses, and nothing is written (the 101st gets no offer).
CREATE TABLE offer_claims (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offer_code text NOT NULL REFERENCES offers(code),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, offer_code)
);
SELECT fence_tenant_table('offer_claims', 'SELECT');

-- True when the current business now holds the offer (it already did, or took one of the places left); false when the
-- offer is full, switched off or unknown. Safe to call twice: a business takes one place, once.
CREATE FUNCTION claim_offer(p_code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  business integer := current_tenant_id();
BEGIN
  IF business IS NULL THEN
    RAISE EXCEPTION 'claim_offer needs a current business';
  END IF;
  PERFORM 1 FROM offers WHERE code = p_code FOR UPDATE;
  IF EXISTS (SELECT 1 FROM offer_claims WHERE tenant_id = business AND offer_code = p_code) THEN
    RETURN true;
  END IF;
  UPDATE offers SET claimed = claimed + 1 WHERE code = p_code AND active AND claimed < max_accounts;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO offer_claims (tenant_id, offer_code) VALUES (business, p_code);
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION claim_offer(text) TO bhava_app;

-- A flag staged for one business (5.7). A row wins over the flag's own default and percentage. Set in the Platform Console.
CREATE TABLE tenant_flags (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
SELECT fence_tenant_table('tenant_flags', 'SELECT');

-- ---- Bhava's invoices ----

-- The next number of each series. One series for all of Bhava per document type and financial year: Bhava is the one
-- seller. Platform table with no grant; only the numbering trigger touches it.
CREATE TABLE bhava_invoice_sequences (
  doc_type    text NOT NULL CHECK (doc_type IN ('invoice', 'credit_note')),
  fy          integer NOT NULL CHECK (fy BETWEEN 2000 AND 2999),
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (doc_type, fy)
);

-- An issued document. Its number, year, parties and amounts never change and it is never deleted; a mistake is corrected
-- by a credit note that names it. Only the file may be written afterwards.
CREATE TABLE bhava_invoices (
  id                  bigserial PRIMARY KEY,
  tenant_id           integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doc_type            text NOT NULL CHECK (doc_type IN ('invoice', 'credit_note')),
  -- Set by the database from issued_at and the series: never by the caller.
  fy                  integer NOT NULL,
  seq                 integer NOT NULL,
  number              text NOT NULL CHECK (length(number) <= 16),
  issued_at           timestamptz NOT NULL DEFAULT now(),
  -- What it is for, once: 'charge:<provider payment id>', 'period:2026-11', 'credit:<invoice id>:<n>'. A second document
  -- for the same thing is refused before a number is taken (F-51).
  source_ref          text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 120),
  period_start        date,
  period_end          date,
  original_invoice_id bigint,
  reason              text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  -- Bhava and the business as they were: { legalName, gstin, stateCode, address } each.
  seller              jsonb NOT NULL CHECK (jsonb_typeof(seller) = 'object'),
  buyer               jsonb NOT NULL CHECK (jsonb_typeof(buyer) = 'object'),
  place_of_supply     text NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  taxable_paise       bigint NOT NULL CHECK (taxable_paise >= 0),
  cgst_paise          bigint NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise          bigint NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise          bigint NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  total_paise         bigint NOT NULL CHECK (total_paise >= 0),
  -- The PDF in private storage.
  file_key            text NOT NULL DEFAULT '' CHECK (length(file_key) <= 300),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (doc_type, fy, seq),
  UNIQUE (number),
  UNIQUE (tenant_id, source_ref),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise),
  -- Bhava's state: CGST and SGST. Any other state: IGST. Never both (F-54).
  CHECK (igst_paise = 0 OR (cgst_paise = 0 AND sgst_paise = 0)),
  CHECK (cgst_paise = sgst_paise),
  CHECK ((doc_type = 'credit_note') = (original_invoice_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, original_invoice_id) REFERENCES bhava_invoices(tenant_id, id)
);
CREATE INDEX bhava_invoices_tenant_idx ON bhava_invoices (tenant_id, issued_at DESC);
SELECT fence_tenant_table('bhava_invoices', 'SELECT, INSERT, UPDATE');

-- One line per thing charged: the plan fee, each add-on, each pack, each service or setup, each pass-through charge with
-- its count. taxable is gross less discount (the launch offer). A line is never changed or removed.
CREATE TABLE bhava_invoice_lines (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id     bigint NOT NULL,
  position       integer NOT NULL CHECK (position >= 1),
  kind           text NOT NULL CHECK (kind IN ('plan', 'addon', 'pack', 'service', 'setup', 'pass_through')),
  -- The plan's code, the add-on's code, or the pass-through kind (gateway_fee, shipping, whatsapp, ai).
  code           text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  description    text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  sac            text NOT NULL DEFAULT '' CHECK (length(sac) <= 8),
  -- How many: packs, seats, or for a pass-through line the count behind it (messages, AI units, shipments).
  quantity       bigint NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit_paise     bigint NOT NULL DEFAULT 0 CHECK (unit_paise >= 0),
  gross_paise    bigint NOT NULL CHECK (gross_paise >= 0),
  discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  taxable_paise  bigint NOT NULL CHECK (taxable_paise >= 0),
  rate_bp        integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  cgst_paise     bigint NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise     bigint NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise     bigint NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  period_start   date,
  period_end     date,
  UNIQUE (tenant_id, invoice_id, position),
  CHECK (taxable_paise = gross_paise - discount_paise),
  CHECK (igst_paise = 0 OR (cgst_paise = 0 AND sgst_paise = 0)),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES bhava_invoices(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('bhava_invoice_lines', 'SELECT, INSERT');

-- Takes the next number of the series for the row being inserted; the caller's fy, seq and number are ignored. A second
-- document for the same source_ref is refused BEFORE a number is taken, as an error that ON CONFLICT cannot swallow, so a
-- number is only ever used up by a row that is really written. Never insert with ON CONFLICT and never choose a number.
CREATE FUNCTION bhava_invoices_number() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prefix text;
  n integer;
BEGIN
  PERFORM 1 FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM bhava_invoices WHERE tenant_id = NEW.tenant_id AND source_ref = NEW.source_ref) THEN
    RAISE EXCEPTION 'There is already a document for %', NEW.source_ref USING ERRCODE = 'unique_violation', CONSTRAINT = 'bhava_invoices_tenant_id_source_ref_key';
  END IF;
  NEW.fy := financial_year(NEW.issued_at);
  INSERT INTO bhava_invoice_sequences (doc_type, fy, next_number) VALUES (NEW.doc_type, NEW.fy, 2)
    ON CONFLICT (doc_type, fy) DO UPDATE SET next_number = bhava_invoice_sequences.next_number + 1
    RETURNING next_number - 1 INTO n;
  NEW.seq := n;
  SELECT CASE NEW.doc_type WHEN 'credit_note' THEN credit_note_prefix ELSE invoice_prefix END INTO prefix FROM billing_settings;
  NEW.number := COALESCE(prefix, 'BH') || '/' || lpad((NEW.fy % 100)::text, 2, '0') || '-' || lpad(((NEW.fy + 1) % 100)::text, 2, '0') || '/'
    || CASE WHEN n < 100000 THEN lpad(n::text, 5, '0') ELSE n::text END;
  RETURN NEW;
END $$;
CREATE TRIGGER bhava_invoices_number BEFORE INSERT ON bhava_invoices FOR EACH ROW EXECUTE FUNCTION bhava_invoices_number();

CREATE FUNCTION bhava_invoices_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'file_key') IS DISTINCT FROM (to_jsonb(OLD) - 'file_key') THEN
    RAISE EXCEPTION 'An issued invoice cannot be changed' USING ERRCODE = 'check_violation', CONSTRAINT = 'bhava_invoices_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bhava_invoices_frozen BEFORE UPDATE ON bhava_invoices FOR EACH ROW EXECUTE FUNCTION bhava_invoices_frozen();

-- At commit, an invoice's totals are the sum of its lines: write the invoice and all its lines in one transaction. A
-- line added to an invoice later breaks the sum and is refused the same way.
CREATE FUNCTION bhava_invoice_adds_up() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target bigint;
  doc record;
  sums record;
BEGIN
  IF TG_TABLE_NAME = 'bhava_invoices' THEN
    target := NEW.id;
  ELSE
    target := NEW.invoice_id;
  END IF;
  SELECT taxable_paise, cgst_paise, sgst_paise, igst_paise INTO doc FROM bhava_invoices WHERE id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS n, COALESCE(sum(taxable_paise), 0) AS taxable, COALESCE(sum(cgst_paise), 0) AS cgst, COALESCE(sum(sgst_paise), 0) AS sgst, COALESCE(sum(igst_paise), 0) AS igst
    INTO sums FROM bhava_invoice_lines WHERE invoice_id = target;
  IF sums.n = 0 OR sums.taxable <> doc.taxable_paise OR sums.cgst <> doc.cgst_paise OR sums.sgst <> doc.sgst_paise OR sums.igst <> doc.igst_paise THEN
    RAISE EXCEPTION 'Invoice % does not add up to its lines', target USING ERRCODE = 'check_violation', CONSTRAINT = 'bhava_invoice_adds_up';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bhava_invoice_adds_up AFTER INSERT ON bhava_invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bhava_invoice_adds_up();
CREATE CONSTRAINT TRIGGER bhava_invoice_line_adds_up AFTER INSERT ON bhava_invoice_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bhava_invoice_adds_up();

-- One row per provider payment id, whoever sends the event and however often (F-51). The id is unique across Bhava.
CREATE TABLE billing_payments (
  id                       bigserial PRIMARY KEY,
  tenant_id                integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider                 text NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay')),
  provider_payment_id      text NOT NULL CHECK (length(provider_payment_id) BETWEEN 1 AND 80),
  provider_subscription_id text CHECK (provider_subscription_id IS NULL OR length(provider_subscription_id) BETWEEN 1 AND 80),
  provider_invoice_id      text CHECK (provider_invoice_id IS NULL OR length(provider_invoice_id) BETWEEN 1 AND 80),
  amount_paise             bigint NOT NULL CHECK (amount_paise >= 0),
  status                   text NOT NULL CHECK (status IN ('captured', 'failed', 'refunded')),
  method                   text NOT NULL DEFAULT '' CHECK (length(method) <= 40),
  failure_code             text NOT NULL DEFAULT '' CHECK (length(failure_code) <= 80),
  invoice_id               bigint,
  paid_at                  timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES bhava_invoices(tenant_id, id)
);
CREATE INDEX billing_payments_tenant_idx ON billing_payments (tenant_id, id DESC);
SELECT fence_tenant_table('billing_payments', 'SELECT, INSERT, UPDATE');

-- ---- Metering ----

-- One row per thing counted. The idempotency key is unique per business, so a send is counted once however many times
-- it is reported: insert with ON CONFLICT (tenant_id, idempotency_key) DO NOTHING. `month` is set here (the calendar
-- month in India), and a row that is really written adds itself to usage_months in the same statement.
CREATE TABLE usage_events (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meter           text NOT NULL CHECK (meter IN ('dms', 'whatsapp_messages', 'ai_units')),
  quantity        integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- What Bhava was charged for it, for the meters billed at cost. 0 for DMs.
  cost_paise      bigint NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  month           date NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX usage_events_month_idx ON usage_events (tenant_id, meter, month);
SELECT fence_tenant_table('usage_events', 'SELECT, INSERT');

-- The live meter: one row per business, meter and month. `included` is the plan's number when the month's first event
-- arrived (null: no limit) and `pack_units` what packs add; the usage module keeps both current. The alert marks are set
-- once each, so the owner is told once at 80% and once at 100% (F-86).
CREATE TABLE usage_months (
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meter        text NOT NULL CHECK (meter IN ('dms', 'whatsapp_messages', 'ai_units')),
  month        date NOT NULL CHECK (extract(day FROM month) = 1),
  used         bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  cost_paise   bigint NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  included     bigint CHECK (included IS NULL OR included >= 0),
  packs        integer NOT NULL DEFAULT 0 CHECK (packs >= 0),
  pack_units   bigint NOT NULL DEFAULT 0 CHECK (pack_units >= 0),
  alert_80_at  timestamptz,
  alert_100_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, meter, month)
);
SELECT fence_tenant_table('usage_months', 'SELECT, INSERT, UPDATE');

CREATE FUNCTION usage_month_of(at timestamptz) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT date_trunc('month', at AT TIME ZONE 'Asia/Kolkata')::date
$$;
CREATE FUNCTION usage_events_month() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.month := usage_month_of(NEW.occurred_at);
  RETURN NEW;
END $$;
CREATE TRIGGER usage_events_month BEFORE INSERT ON usage_events FOR EACH ROW EXECUTE FUNCTION usage_events_month();
CREATE FUNCTION usage_events_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO usage_months (tenant_id, meter, month, used, cost_paise) VALUES (NEW.tenant_id, NEW.meter, NEW.month, NEW.quantity, NEW.cost_paise)
    ON CONFLICT (tenant_id, meter, month) DO UPDATE SET used = usage_months.used + EXCLUDED.used, cost_paise = usage_months.cost_paise + EXCLUDED.cost_paise, updated_at = now();
  RETURN NULL;
END $$;
CREATE TRIGGER usage_events_count AFTER INSERT ON usage_events FOR EACH ROW EXECUTE FUNCTION usage_events_count();

-- ---- Charges passed through at cost ----

-- What Bhava paid on a business's behalf, at cost, with the count behind it. Gateway fees are taken at payout; shipping
-- at payout or on the invoice, per business; WhatsApp and AI on the monthly invoice. A business on its own providers
-- has no rows for them (F-84). One row per source, so nothing is charged twice.
CREATE TABLE pass_through_charges (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('gateway_fee', 'shipping', 'whatsapp', 'ai')),
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  quantity     bigint NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  period       date NOT NULL CHECK (extract(day FROM period) = 1),
  collected_by text NOT NULL CHECK (collected_by IN ('payout', 'invoice')),
  -- 'payment:12', 'shipment:8', 'usage:whatsapp_messages:2026-11'.
  source_ref   text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 120),
  -- The invoice whose line carries it, once billed.
  invoice_id   bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, source_ref),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES bhava_invoices(tenant_id, id)
);
CREATE INDEX pass_through_charges_period_idx ON pass_through_charges (tenant_id, period, kind);
SELECT fence_tenant_table('pass_through_charges', 'SELECT, INSERT, UPDATE');

-- ---- Settlement statements ----

-- One per business and month on the default payment or shipping path: sales, refunds, gateway fees, shipping, payouts
-- with their transfer references, and the closing balance. Bhava takes no share of sales, and the column says so.
CREATE TABLE settlement_statements (
  id                     bigserial PRIMARY KEY,
  tenant_id              integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month                  date NOT NULL CHECK (extract(day FROM month) = 1),
  opening_balance_paise  bigint NOT NULL DEFAULT 0,
  sales_paise            bigint NOT NULL DEFAULT 0 CHECK (sales_paise >= 0),
  refunds_paise          bigint NOT NULL DEFAULT 0 CHECK (refunds_paise >= 0),
  gateway_fees_paise     bigint NOT NULL DEFAULT 0 CHECK (gateway_fees_paise >= 0),
  shipping_paise         bigint NOT NULL DEFAULT 0 CHECK (shipping_paise >= 0),
  commission_paise       bigint NOT NULL DEFAULT 0 CHECK (commission_paise = 0),
  payouts_paise          bigint NOT NULL DEFAULT 0 CHECK (payouts_paise >= 0),
  closing_balance_paise  bigint NOT NULL DEFAULT 0,
  counts                 jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
  -- [{ transferId, amountPaise, at }]: each payout with its Route transfer reference.
  payouts                jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(payouts) = 'array'),
  -- Against the gateway's settlement report and the courier's charges for this business.
  reconciliation         text NOT NULL DEFAULT 'pending' CHECK (reconciliation IN ('pending', 'matched', 'mismatch')),
  reconciliation_details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(reconciliation_details) = 'object'),
  pdf_key                text NOT NULL DEFAULT '' CHECK (length(pdf_key) <= 300),
  csv_key                text NOT NULL DEFAULT '' CHECK (length(csv_key) <= 300),
  sent_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, month),
  CHECK (closing_balance_paise = opening_balance_paise + sales_paise - refunds_paise - gateway_fees_paise - shipping_paise - payouts_paise)
);
SELECT fence_tenant_table('settlement_statements', 'SELECT, INSERT, UPDATE');

-- ---- Referrals between sellers ----

-- Each account's own code (5.20). Looked up by code with no business yet, through db.platform.
CREATE TABLE seller_referral_codes (
  tenant_id  integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  code       text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{6,20}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('seller_referral_codes', 'SELECT, INSERT');

-- tenant_id is the referrer, which is all a business sees of it: its own referrals and their state, never the other
-- business's data (the API answers counts and states only). A business is referred at most once, and never by itself.
-- Written through db.platform, at the referred account's sign-up and when it starts a paid plan. credited_at is set
-- once: the referrer is rewarded once (F-129).
CREATE TABLE seller_referrals (
  id                 bigserial PRIMARY KEY,
  tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  referred_tenant_id integer NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  state              text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'credited', 'blocked')),
  -- Why it was blocked: same_instagram, same_phone, same_payment_method.
  block_reason       text NOT NULL DEFAULT '' CHECK (length(block_reason) <= 40),
  reward_paise       bigint NOT NULL DEFAULT 0 CHECK (reward_paise >= 0),
  credited_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (referred_tenant_id <> tenant_id),
  CHECK ((state = 'credited') = (credited_at IS NOT NULL))
);
CREATE INDEX seller_referrals_referrer_idx ON seller_referrals (tenant_id, id DESC);
SELECT fence_tenant_table('seller_referrals', 'SELECT');

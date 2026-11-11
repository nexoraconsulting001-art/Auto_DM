-- Phase 4: GST invoices (PRD 9.13). Numbers run per business, per kind of document, per financial year, with no gaps.
CREATE TABLE invoice_settings (
  tenant_id      integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name     text NOT NULL DEFAULT '' CHECK (length(legal_name) <= 200),
  -- Empty means not registered: the document is then a bill of supply with no tax lines.
  gstin          text NOT NULL DEFAULT '' CHECK (gstin = '' OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  state_code     text NOT NULL DEFAULT '' CHECK (state_code = '' OR state_code ~ '^[0-9]{2}$'),
  address        text NOT NULL DEFAULT '' CHECK (length(address) <= 400),
  -- Up to 4 capitals or digits, so a whole number stays inside GST's 16 characters: PFX/26-27/00001.
  invoice_prefix text NOT NULL DEFAULT 'INV' CHECK (invoice_prefix ~ '^[A-Z0-9]{1,4}$'),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('invoice_settings');

-- The next number of each series. A row is locked while a number is taken and the invoice row is written in the same
-- transaction, so a rollback gives the number back and two invoices at once get consecutive numbers (S-43).
CREATE TABLE invoice_sequences (
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doc_type    text NOT NULL CHECK (doc_type IN ('invoice', 'bill_of_supply', 'credit_note')),
  -- The financial year by its first calendar year: 2026 is April 2026 to March 2027.
  fy          integer NOT NULL CHECK (fy BETWEEN 2000 AND 2999),
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (tenant_id, doc_type, fy)
);
SELECT fence_tenant_table('invoice_sequences', 'SELECT, INSERT, UPDATE');

-- An issued document. Its number, year and amounts never change and it is never deleted; only the file and the buyer's
-- details (masked on a deletion request, 9.18) may be written afterwards.
CREATE TABLE invoices (
  id                  bigserial PRIMARY KEY,
  tenant_id           integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id            integer NOT NULL,
  doc_type            text NOT NULL CHECK (doc_type IN ('invoice', 'bill_of_supply', 'credit_note')),
  -- Set by the database from issued_at and the series: never by the caller.
  fy                  integer NOT NULL,
  seq                 integer NOT NULL,
  number              text NOT NULL CHECK (length(number) <= 16),
  issued_at           timestamptz NOT NULL DEFAULT now(),
  -- A credit note names the refund it is for and the invoice it corrects.
  refund_id           bigint,
  original_invoice_id bigint,
  -- The seller and buyer as they were: { legalName, gstin, stateCode, address } and { name, phone, address, stateCode }.
  seller              jsonb NOT NULL CHECK (jsonb_typeof(seller) = 'object'),
  buyer               jsonb NOT NULL CHECK (jsonb_typeof(buyer) = 'object'),
  place_of_supply     text NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  -- [{ description, hsn, qty, grossPaise, discountPaise, taxablePaise, rateBp, cgstPaise, sgstPaise, igstPaise }]
  lines               jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) >= 1),
  taxable_paise       bigint NOT NULL CHECK (taxable_paise >= 0),
  cgst_paise          bigint NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise          bigint NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise          bigint NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  total_paise         bigint NOT NULL CHECK (total_paise >= 0),
  -- A part-advance order shows both parts (9.5).
  advance_paise       bigint NOT NULL DEFAULT 0 CHECK (advance_paise >= 0),
  balance_paise       bigint NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  -- The PDF in the business's storage.
  file_key            text NOT NULL DEFAULT '' CHECK (length(file_key) <= 300),
  buyer_masked_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, doc_type, fy, seq),
  UNIQUE (tenant_id, number),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise),
  -- Same state: CGST and SGST. Another state: IGST. Never both.
  CHECK (igst_paise = 0 OR (cgst_paise = 0 AND sgst_paise = 0)),
  CHECK (doc_type <> 'bill_of_supply' OR (cgst_paise = 0 AND sgst_paise = 0 AND igst_paise = 0)),
  CHECK ((doc_type = 'credit_note') = (original_invoice_id IS NOT NULL)),
  -- No ON DELETE: an order or refund with an invoice cannot be deleted on its own, only with its whole business.
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES refunds(tenant_id, id),
  FOREIGN KEY (tenant_id, original_invoice_id) REFERENCES invoices(tenant_id, id)
);
-- One invoice (or bill of supply) per order, and one credit note per refund: issuing twice for the same event is refused.
CREATE UNIQUE INDEX invoices_order_idx ON invoices (tenant_id, order_id) WHERE doc_type <> 'credit_note';
CREATE UNIQUE INDEX invoices_refund_idx ON invoices (tenant_id, refund_id) WHERE refund_id IS NOT NULL;
CREATE INDEX invoices_order_all_idx ON invoices (tenant_id, order_id, id);
SELECT fence_tenant_table('invoices', 'SELECT, INSERT, UPDATE');

-- The financial year in India for a moment: April to March.
CREATE FUNCTION financial_year(at timestamptz) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT (extract(year FROM ((at AT TIME ZONE 'Asia/Kolkata') - interval '3 months')))::integer
$$;

-- Takes the next number of the series for the row being inserted. The caller's fy, seq and number are ignored.
-- The order is locked and a second document for the same order or refund is refused BEFORE a number is taken, as an error
-- that ON CONFLICT cannot swallow: a number is only ever used up by a row that is really written.
CREATE FUNCTION invoices_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prefix text;
  n integer;
BEGIN
  PERFORM 1 FROM orders WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id FOR UPDATE;
  IF NEW.doc_type <> 'credit_note' AND EXISTS (SELECT 1 FROM invoices WHERE tenant_id = NEW.tenant_id AND order_id = NEW.order_id AND doc_type <> 'credit_note') THEN
    RAISE EXCEPTION 'Order % already has an invoice', NEW.order_id USING ERRCODE = 'unique_violation', CONSTRAINT = 'invoices_order_idx';
  END IF;
  IF NEW.refund_id IS NOT NULL AND EXISTS (SELECT 1 FROM invoices WHERE tenant_id = NEW.tenant_id AND refund_id = NEW.refund_id) THEN
    RAISE EXCEPTION 'Refund % already has a credit note', NEW.refund_id USING ERRCODE = 'unique_violation', CONSTRAINT = 'invoices_refund_idx';
  END IF;
  NEW.fy := financial_year(NEW.issued_at);
  INSERT INTO invoice_sequences (tenant_id, doc_type, fy, next_number) VALUES (NEW.tenant_id, NEW.doc_type, NEW.fy, 2)
    ON CONFLICT (tenant_id, doc_type, fy) DO UPDATE SET next_number = invoice_sequences.next_number + 1
    RETURNING next_number - 1 INTO n;
  NEW.seq := n;
  prefix := CASE NEW.doc_type
    WHEN 'credit_note' THEN 'CN'
    WHEN 'bill_of_supply' THEN 'BS'
    ELSE COALESCE((SELECT invoice_prefix FROM invoice_settings WHERE tenant_id = NEW.tenant_id), 'INV') END;
  NEW.number := prefix || '/' || lpad((NEW.fy % 100)::text, 2, '0') || '-' || lpad(((NEW.fy + 1) % 100)::text, 2, '0') || '/' || lpad(n::text, 5, '0');
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_number BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_number();

CREATE FUNCTION invoices_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'file_key' - 'buyer' - 'buyer_masked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'file_key' - 'buyer' - 'buyer_masked_at') THEN
    RAISE EXCEPTION 'An issued invoice cannot be changed' USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_frozen BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_frozen();

-- Final review (money-2, money-3): one path charges a pass-through cost at the provider and puts it on the invoice.
-- queued_at is when the renewal job asked the provider to add the charge to the next subscription charge, and
-- provider_charge_id the provider's add-on. A charge is invoiced only once it is queued, so the invoice always lists what
-- the provider takes; until then the hourly usage job may still change it. Charges already on an invoice were charged with it.
ALTER TABLE pass_through_charges ADD COLUMN queued_at timestamptz;
ALTER TABLE pass_through_charges ADD COLUMN provider_charge_id text CHECK (provider_charge_id IS NULL OR length(provider_charge_id) BETWEEN 1 AND 80);
UPDATE pass_through_charges SET queued_at = created_at WHERE invoice_id IS NOT NULL;

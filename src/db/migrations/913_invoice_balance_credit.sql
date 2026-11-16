-- Final review (money-9): a part-advance order is invoiced in full when its advance is paid. If it is then cancelled or
-- comes back to origin, the balance is never collected, and one credit note (with no refund behind it) takes that balance
-- off the invoice. One such credit note per order: a second is refused, like a second invoice or a second refund's note.
CREATE UNIQUE INDEX invoices_balance_credit_idx ON invoices (tenant_id, order_id) WHERE doc_type = 'credit_note' AND refund_id IS NULL;

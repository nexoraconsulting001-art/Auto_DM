-- Final money attack (atk-money-2): a shopper charged twice on one order. The second capture of a part of an order already
-- paid is kept as its own payment, purpose 'duplicate': captured, held for review, never counted in what the order was paid,
-- never a sale on the seller's statement and never sent to the seller by Route. A refund on the order gives it back first,
-- by its own gateway payment id, leaving the sale, its transfer and its GST documents as they are.
-- A duplicate shares the sale's gateway order (one gateway order can carry several payments), so the one-row-per-gateway-
-- order index leaves duplicates out; the gateway payment id stays unique for every row.
ALTER TABLE payments DROP CONSTRAINT payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check CHECK (purpose IN ('full', 'advance', 'cod', 'duplicate'));
DROP INDEX payments_gateway_order_idx;
CREATE UNIQUE INDEX payments_gateway_order_idx ON payments (provider, account_ref, gateway_order_id) WHERE gateway_order_id IS NOT NULL AND purpose <> 'duplicate';

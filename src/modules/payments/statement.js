import { tenantId } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';

/**
 * The seller's settlement statement (PRD 9.6) and an order's payments, as the console reads them. Every charge is shown at
 * cost. A line is a credit (owed to the seller) or a debit (taken from it). Transfer and reversal lines say where the money
 * went and are not part of what is payable: the sale, fee, shipping and refund lines are.
 */
const day = (d) => d.toISOString().slice(0, 10);

export const toPayment = (row) => ({
  id: Number(row.id), orderId: row.order_id, purpose: row.purpose, provider: row.provider, mode: row.mode, status: row.status, method: row.method,
  amountPaise: Number(row.amount_paise), feePaise: Number(row.fee_paise), feeTaxPaise: Number(row.fee_tax_paise), refundedPaise: Number(row.refunded_paise),
  transferStatus: row.transfer_status, transferPaise: Number(row.transfer_paise), reversedPaise: Number(row.reversed_paise), needsReview: row.needs_review,
  gatewayPaymentId: row.gateway_payment_id, createdAt: row.created_at, capturedAt: row.captured_at,
});

const toLine = (row) => {
  const amount = Number(row.amount_paise);
  return { id: Number(row.id), orderId: row.order_id, orderNumber: row.order_number, kind: row.kind, creditPaise: amount > 0 ? amount : 0, debitPaise: amount < 0 ? -amount : 0, status: row.status, at: row.occurred_at };
};

export function createStatement({ db }) {
  return {
    /** Null when the order isn't this business's. */
    async paymentsForOrder(orderId) {
      const [order] = await db.query('SELECT id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
      if (!order) return null;
      const rows = await db.query('SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenantId(), orderId]);
      return { items: rows.map(toPayment) };
    },

    /** Newest first. `from` and `to` are whole days, both included. */
    async list({ cursor, limit = 25, from, to, orderId } = {}) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] > 0)[0] : null;
      const rows = await db.query(
        `SELECT l.id, l.order_id, o.order_number, l.kind, l.amount_paise, l.status, l.occurred_at
         FROM settlement_lines l JOIN orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
         WHERE l.tenant_id = $1 AND ($2::bigint IS NULL OR l.id < $2) AND ($3::date IS NULL OR l.occurred_at >= $3::date)
           AND ($4::date IS NULL OR l.occurred_at < $4::date + 1) AND ($5::integer IS NULL OR l.order_id = $5)
         ORDER BY l.id DESC LIMIT $6`,
        [tenantId(), after, from ?? null, to ?? null, orderId ?? null, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [Number(row.id)]);
      return { items: page.items.map(toLine), nextCursor: page.nextCursor };
    },

    /** The period's totals. With no dates: the last 30 days. */
    async summary({ from, to } = {}) {
      const end = to ?? day(new Date());
      const start = from ?? day(new Date(new Date(`${end}T00:00:00Z`).getTime() - 29 * 86_400_000));
      const rows = await db.query(
        `SELECT kind, COALESCE(sum(amount_paise), 0) AS total, count(*) FILTER (WHERE status = 'review') AS review
         FROM settlement_lines WHERE tenant_id = $1 AND occurred_at >= $2::date AND occurred_at < $3::date + 1 GROUP BY kind`,
        [tenantId(), start, end],
      );
      const of = (kind) => Number(rows.find((r) => r.kind === kind)?.total ?? 0);
      const sales = of('sale');
      const fees = -(of('gateway_fee') + of('gateway_fee_tax'));
      const shipping = -of('shipping_charge');
      const refunds = -of('refund');
      const net = sales - fees - shipping - refunds + of('adjustment');
      return {
        from: start, to: end, salesPaise: Math.max(0, sales), gatewayFeesPaise: Math.max(0, fees), shippingChargesPaise: Math.max(0, shipping), refundsPaise: Math.max(0, refunds),
        payablePaise: Math.max(0, net), recoverablePaise: Math.max(0, -net), inReview: rows.reduce((n, r) => n + Number(r.review), 0),
      };
    },
  };
}

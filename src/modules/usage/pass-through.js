import { tenantId } from '../../tenancy.js';
import { monthBounds } from './meter.js';

/**
 * Charges Bhava passes through at cost, with no markup (PRD 5.12, F-84, F-113, F-114): one pass_through_charges row per
 * source, which the billing track charges at the provider and puts on the invoice (collected_by 'invoice': billing's
 * queuePassThrough is the only writer to the provider, for closed months) or which the payout already took (collected_by
 * 'payout', shown on the settlement statement). (kind, source_ref) is unique per business, so running this again never
 * charges twice; a row may still change until billing queues it at the provider (queued_at), and never after.
 *
 *   gateway_fee  one per payment on Bhava's default path (payments.mode 'managed'): the fee and its GST, from Phase 4's
 *                statement lines. Taken at payout.
 *   shipping     one per shipment on Bhava's courier account (only those have a shipping_charge line), less what the
 *                courier gave back for a cancelled one. Taken at payout or billed on the invoice: shipping_settings.charge_billing.
 *   whatsapp, ai one per meter and month, from usage_months: the count and what Bhava paid. On the invoice.
 *
 * A seller on its own Razorpay and own Shiprocket has no managed payment and no shipping_charge line, so no rows of those
 * kinds: it pays its providers directly (F-84).
 */
const PAYMENT_ID = `(CASE WHEN l.ref ~ '^payment:[0-9]{1,18}$' THEN substring(l.ref from 9)::bigint END)`;

export function createPassThrough({ db }) {
  /** Writes this business's charges for one usage month (YYYY-MM-01). Returns how many rows were added or changed. */
  async function collect(month) {
    const tid = tenantId();
    const { start, end } = monthBounds(month);
    const fees = await db.query(
      `INSERT INTO pass_through_charges (tenant_id, kind, amount_paise, quantity, period, collected_by, source_ref)
       SELECT l.tenant_id, 'gateway_fee', -sum(l.amount_paise), 1, $4::date, 'payout', l.ref
       FROM settlement_lines l JOIN payments p ON p.tenant_id = l.tenant_id AND p.id = ${PAYMENT_ID}
       WHERE l.tenant_id = $1 AND l.kind IN ('gateway_fee', 'gateway_fee_tax') AND p.mode = 'managed' AND l.occurred_at >= $2::timestamptz AND l.occurred_at < $3::timestamptz
       GROUP BY l.tenant_id, l.ref HAVING -sum(l.amount_paise) > 0
       ON CONFLICT (tenant_id, kind, source_ref) DO NOTHING RETURNING id`,
      [tid, start, end, month],
    );
    const shipping = await db.query(
      `INSERT INTO pass_through_charges (tenant_id, kind, amount_paise, quantity, period, collected_by, source_ref)
       SELECT l.tenant_id, 'shipping', GREATEST(0, -l.amount_paise - COALESCE(c.amount_paise, 0)), 1, $4::date,
              CASE WHEN s.charge_billing = 'monthly' THEN 'invoice' ELSE 'payout' END, l.ref
       FROM settlement_lines l
       LEFT JOIN settlement_lines c ON c.tenant_id = l.tenant_id AND c.kind = 'adjustment' AND c.ref = l.ref || ':cancelled'
       LEFT JOIN shipping_settings s ON s.tenant_id = l.tenant_id
       WHERE l.tenant_id = $1 AND l.kind = 'shipping_charge' AND l.occurred_at >= $2::timestamptz AND l.occurred_at < $3::timestamptz
       ON CONFLICT (tenant_id, kind, source_ref) DO UPDATE SET amount_paise = EXCLUDED.amount_paise, collected_by = EXCLUDED.collected_by
         WHERE pass_through_charges.invoice_id IS NULL AND pass_through_charges.queued_at IS NULL AND (pass_through_charges.amount_paise, pass_through_charges.collected_by) IS DISTINCT FROM (EXCLUDED.amount_paise, EXCLUDED.collected_by)
       RETURNING id`,
      [tid, start, end, month],
    );
    const usage = await db.query(
      `INSERT INTO pass_through_charges (tenant_id, kind, amount_paise, quantity, period, collected_by, source_ref)
       SELECT tenant_id, CASE meter WHEN 'whatsapp_messages' THEN 'whatsapp' ELSE 'ai' END, cost_paise, used, month, 'invoice', 'usage:' || meter || ':' || to_char(month, 'YYYY-MM')
       FROM usage_months WHERE tenant_id = $1 AND month = $2::date AND meter IN ('whatsapp_messages', 'ai_units') AND used > 0
       ON CONFLICT (tenant_id, kind, source_ref) DO UPDATE SET amount_paise = EXCLUDED.amount_paise, quantity = EXCLUDED.quantity
         WHERE pass_through_charges.invoice_id IS NULL AND pass_through_charges.queued_at IS NULL AND (pass_through_charges.amount_paise, pass_through_charges.quantity) IS DISTINCT FROM (EXCLUDED.amount_paise, EXCLUDED.quantity)
       RETURNING id`,
      [tid, month],
    );
    return fees.length + shipping.length + usage.length;
  }

  /** This business's charges for a month, grouped by kind and how they are collected, with counts (what an invoice line shows). */
  async function summary(month) {
    const rows = await db.query(
      `SELECT kind, collected_by, count(*)::int AS rows, COALESCE(sum(quantity), 0)::bigint AS quantity, COALESCE(sum(amount_paise), 0)::bigint AS amount
       FROM pass_through_charges WHERE tenant_id = $1 AND period = $2::date GROUP BY kind, collected_by ORDER BY kind, collected_by`,
      [tenantId(), month],
    );
    return rows.map((r) => ({ kind: r.kind, collectedBy: r.collected_by, rows: r.rows, quantity: Number(r.quantity), amountPaise: Number(r.amount) }));
  }

  return { collect, summary };
}

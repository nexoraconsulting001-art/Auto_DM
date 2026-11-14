import { ApiError } from '../../contracts/api/index.js';
import { usageMonthOf } from '../../contracts/billing.js';
import { reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { balanceOf } from './files.js';

/**
 * The monthly settlement statement (PRD 5.12, F-83, F-84, F-113), one per business and month on Bhava's default payment or
 * shipping path: sales, refunds, gateway fees and shipping at cost, payouts with their Route transfer references, and the
 * closing balance. Built from Phase 4's settlement_lines, reconciled against the gateway's settlement report for the
 * business's linked account, and written once (unique per business and month). There is no commission: the column is held
 * at 0 by the database. The gateway fees and shipping taken at payout are also recorded as pass-through charges, at cost,
 * with their counts; a business on its own gateway and courier has neither statement nor such charges.
 */
const nextMonth = (month) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};
const prevMonth = (month) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
};

export function createStatements(ctx, { at }) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;

  /** Which default paths the business is on. A business with no settings row is on Bhava's default. */
  async function paths() {
    const [pay] = await db.query('SELECT mode, linked_account_id FROM payment_settings WHERE tenant_id = $1', [tenantId()]);
    const [ship] = await db.query('SELECT mode FROM shipping_settings WHERE tenant_id = $1', [tenantId()]);
    return { payments: (pay?.mode ?? 'managed') === 'managed', shipping: (ship?.mode ?? 'managed') === 'managed', linkedAccount: pay?.linked_account_id ?? null };
  }

  /** What the gateway says it paid out to the linked account that month, or null when it can't be asked. */
  async function settledByGateway(linkedAccount, month) {
    const route = ctx.providers?.razorpay?.route;
    if (!linkedAccount || typeof route?.settlementReport !== 'function') return null;
    try {
      const [year, m] = month.split('-').map(Number);
      const items = await route.settlementReport({ linkedAccountId: linkedAccount }, { year, month: m });
      return items.reduce((sum, i) => sum + (i.kind === 'transfer' ? Number(i.amountPaise) : i.kind === 'reversal' ? -Number(i.amountPaise) : 0), 0);
    } catch (err) {
      reportError(err, { msg: 'billing.settlement_report_failed' });
      return null;
    }
  }

  /** Builds the current business's statement for `month` ('YYYY-MM-01'). Null when it is on no default path. Once only. */
  async function build(month) {
    const p = await paths();
    if (!p.payments && !p.shipping) return null;
    const [existing] = await db.query('SELECT * FROM settlement_statements WHERE tenant_id = $1 AND month = $2::date', [tenantId(), month]);
    if (existing) return existing;
    const range = [tenantId(), `${month} 00:00:00+05:30`, `${nextMonth(month)} 00:00:00+05:30`];
    const sums = await db.query(
      `SELECT kind, COALESCE(sum(amount_paise), 0) AS total, count(*) AS n, count(DISTINCT order_id) AS orders
       FROM settlement_lines WHERE tenant_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz GROUP BY kind`,
      range,
    );
    const of = (kind) => sums.find((r) => r.kind === kind) ?? { total: 0, n: 0, orders: 0 };
    const total = (kind) => Number(of(kind).total);
    const transfers = await db.query(
      `SELECT ref, amount_paise, occurred_at FROM settlement_lines WHERE tenant_id = $1 AND kind = 'transfer' AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz ORDER BY occurred_at, id`,
      range,
    );
    const [prev] = await db.query('SELECT closing_balance_paise FROM settlement_statements WHERE tenant_id = $1 AND month = $2::date', [tenantId(), prevMonth(month)]);
    const opening = Number(prev?.closing_balance_paise ?? 0);
    const sales = Math.max(0, total('sale'));
    const refunds = Math.max(0, -total('refund'));
    const fees = p.payments ? Math.max(0, -(total('gateway_fee') + total('gateway_fee_tax'))) : 0;
    const shipping = p.shipping ? Math.max(0, -total('shipping_charge')) : 0;
    const payouts = Math.max(0, total('transfer') + total('transfer_reversal'));
    const closing = opening + sales - refunds - fees - shipping - payouts;
    const gateway = p.payments ? await settledByGateway(p.linkedAccount, month) : null;
    const reconciliation = gateway === null ? 'pending' : gateway === payouts ? 'matched' : 'mismatch';
    const counts = { orders: Number(of('sale').orders), refunds: Number(of('refund').n), shipments: Number(of('shipping_charge').n) };
    const payoutList = transfers.map((r) => ({ transferId: String(r.ref).replace(/^[a-z_]+:/, ''), amountPaise: Number(r.amount_paise), at: new Date(r.occurred_at).toISOString() }));
    return db.tx(async (t) => {
      const [row] = await t.query(
        `INSERT INTO settlement_statements (tenant_id, month, opening_balance_paise, sales_paise, refunds_paise, gateway_fees_paise, shipping_paise, commission_paise, payouts_paise,
           closing_balance_paise, counts, payouts, reconciliation, reconciliation_details)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, 0, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb) ON CONFLICT (tenant_id, month) DO NOTHING RETURNING *`,
        [tenantId(), month, opening, sales, refunds, fees, shipping, payouts, closing, JSON.stringify(counts), JSON.stringify(payoutList), reconciliation, JSON.stringify({ gatewayPaise: gateway, payoutsPaise: payouts })],
      );
      const ref = `month:${month.slice(0, 7)}`;
      if (fees > 0) {
        await t.query(`INSERT INTO pass_through_charges (tenant_id, kind, amount_paise, quantity, period, collected_by, source_ref) VALUES ($1, 'gateway_fee', $2, $3, $4::date, 'payout', $5) ON CONFLICT DO NOTHING`,
          [tenantId(), fees, Number(of('gateway_fee').n), month, ref]);
      }
      if (shipping > 0) {
        await t.query(`INSERT INTO pass_through_charges (tenant_id, kind, amount_paise, quantity, period, collected_by, source_ref) VALUES ($1, 'shipping', $2, $3, $4::date, 'payout', $5) ON CONFLICT DO NOTHING`,
          [tenantId(), shipping, counts.shipments, month, ref]);
      }
      return row ?? (await t.query('SELECT * FROM settlement_statements WHERE tenant_id = $1 AND month = $2::date', [tenantId(), month]))[0];
    });
  }

  const toStatement = (s) => ({
    id: Number(s.id), month: new Date(s.month).toISOString().slice(0, 10), openingBalance: balanceOf(s.opening_balance_paise), salesPaise: Number(s.sales_paise), refundsPaise: Number(s.refunds_paise),
    gatewayFeesPaise: Number(s.gateway_fees_paise), shippingPaise: Number(s.shipping_paise), commissionPaise: 0, payoutsPaise: Number(s.payouts_paise), closingBalance: balanceOf(s.closing_balance_paise),
    counts: { orders: Number(s.counts?.orders ?? 0), refunds: Number(s.counts?.refunds ?? 0), shipments: Number(s.counts?.shipments ?? 0) },
    payouts: (s.payouts ?? []).map((p) => ({ transferId: String(p.transferId), amountPaise: Number(p.amountPaise), at: p.at })), reconciliation: s.reconciliation,
    hasPdf: Boolean(s.pdf_key), hasCsv: Boolean(s.csv_key), sentAt: s.sent_at ? new Date(s.sent_at).toISOString() : null,
  });

  async function list({ cursor, limit = 25 } = {}) {
    let after = null;
    if (cursor) {
      after = Buffer.from(cursor, 'base64url').toString();
      if (!/^\d{1,18}$/.test(after)) throw new ApiError('validation_failed', 'That page link has expired. Go back to the first page.', { fields: { cursor: 'Invalid cursor' } });
    }
    const rows = await db.query('SELECT * FROM settlement_statements WHERE tenant_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3', [tenantId(), after, limit + 1]);
    const shown = rows.slice(0, limit);
    return { items: shown.map(toStatement), nextCursor: rows.length > limit ? Buffer.from(String(shown.at(-1).id)).toString('base64url') : null };
  }

  /** The job: on or after billing_settings.statement_day, last month's statement for every business that has none yet. */
  async function monthly() {
    const [settings] = await platformDb.query('SELECT statement_day FROM billing_settings LIMIT 1');
    const today = at();
    const india = new Date(today.getTime() + 330 * 60_000);
    if (india.getUTCDate() < Number(settings?.statement_day ?? 5)) return { built: 0 };
    const month = prevMonth(usageMonthOf(today));
    const businesses = await platformDb.query(
      `SELECT t.id FROM tenants t WHERE t.status NOT IN ('closed', 'killed') AND NOT EXISTS (SELECT 1 FROM settlement_statements s WHERE s.tenant_id = t.id AND s.month = $1::date)
         AND EXISTS (SELECT 1 FROM settlement_lines l WHERE l.tenant_id = t.id) ORDER BY t.id`,
      [month],
    );
    let built = 0;
    for (const { id } of businesses) {
      await withTenant(Number(id), async () => {
        try {
          if (await build(month)) built += 1;
        } catch (err) {
          reportError(err, { msg: 'billing.statement_failed', tenantId: Number(id) });
        }
      });
    }
    return { built, month };
  }

  return { build, list, monthly, toStatement, paths };
}

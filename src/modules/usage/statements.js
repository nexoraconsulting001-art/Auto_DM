import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';
import { monthBounds, previousMonth } from './meter.js';
import { statementCsv, statementPdf } from './render.js';

/**
 * The monthly settlement statement (PRD 5.12, F-83, F-113) for a business on Bhava's default payment or shipping path: sales,
 * refunds, gateway fees, shipping, payouts with their Route transfer references, and the closing balance, built from
 * Phase 4's settlement_lines for the calendar month in India. Commission is always 0, and the table refuses anything else.
 *
 * Only the default path counts: a sale, fee, refund or payout of a payment on the seller's own gateway account (or cash on
 * delivery) is not money that passed through Bhava, and shipping_charge lines exist only for Bhava's courier account. A
 * business whose courier charges are billed on the invoice (shipping_settings.charge_billing 'monthly') sees them listed in
 * the CSV but not taken from the balance, so they are never charged twice.
 *
 * Reconciliation: the payouts, transfer by transfer, against Razorpay's settlement report for the business's linked
 * account and month, the fee on each, and each courier charge against what the courier charged for that shipment. Every
 * difference is kept in reconciliation_details and printed on both files; the statement says 'mismatch' and is never
 * adjusted to agree. A report that can't be fetched leaves it 'pending' and the job tries again.
 *
 * Until it is sent a statement is rebuilt each run, so late lines are picked up; once sent its figures are frozen (only a
 * 'pending' reconciliation is still retried). It is sent when it matches, or on billing_settings.statement_day of the
 * next month whatever it says.
 */
const DAY = 86_400_000;
const PAYMENT_ID = `(CASE WHEN l.ref ~ '^payment:[0-9]{1,18}$' THEN substring(l.ref from 9)::bigint ELSE r.payment_id END)`;
const REFUND_ID = `(CASE WHEN l.ref ~ '^refund:[0-9]{1,18}$' THEN substring(l.ref from 8)::bigint END)`;
const SHIPMENT = /^shipment:(\d{1,18})$/;
const CANCELLED = /^shipment:(\d{1,18}):cancelled$/;
const COLUMNS = `id, to_char(month, 'YYYY-MM-DD') AS month, opening_balance_paise, sales_paise, refunds_paise, gateway_fees_paise, shipping_paise, commission_paise, payouts_paise,
  closing_balance_paise, counts, payouts, reconciliation, reconciliation_details, pdf_key, csv_key, sent_at, created_at`;

const n = (v) => Number(v ?? 0);
const balance = (paise) => ({ amountPaise: Math.abs(n(paise)), owedTo: n(paise) >= 0 ? 'business' : 'bhava' });

/** A row as the seller API returns it (SettlementStatement). */
export const toStatement = (row) => ({
  id: Number(row.id), month: row.month, openingBalance: balance(row.opening_balance_paise), salesPaise: n(row.sales_paise), refundsPaise: n(row.refunds_paise),
  gatewayFeesPaise: n(row.gateway_fees_paise), shippingPaise: n(row.shipping_paise), commissionPaise: 0, payoutsPaise: n(row.payouts_paise), closingBalance: balance(row.closing_balance_paise),
  counts: { orders: n(row.counts?.orders), refunds: n(row.counts?.refunds), shipments: n(row.counts?.shipments) },
  payouts: (row.payouts ?? []).map((p) => ({ transferId: String(p.transferId ?? ''), amountPaise: n(p.amountPaise), at: new Date(p.at) })),
  reconciliation: row.reconciliation, hasPdf: Boolean(row.pdf_key), hasCsv: Boolean(row.csv_key), sentAt: row.sent_at ?? null,
});

export const statementFilePath = (id, format) => `/billing/statement-files/s${id}.${format}`;
export function parseStatementRef(ref) {
  const match = /^s([1-9]\d{0,17})\.(pdf|csv)$/.exec(String(ref ?? ''));
  return match ? { id: match[1], format: match[2] } : null;
}
const storageKey = (month, id, format) => `t/${tenantId()}/statements/${month.slice(0, 7)}-${id}.${format}`;

export function createStatements({ db, providers = {}, storage = null, queue = null, now = () => new Date() }) {
  async function settings() {
    const [row] = await db.query(
      `SELECT p.mode AS payment_mode, p.linked_account_id, s.mode AS shipping_mode, s.charge_billing, t.name AS business_name,
              COALESCE((SELECT statement_day FROM billing_settings LIMIT 1), 5) AS statement_day
       FROM tenants t LEFT JOIN payment_settings p ON p.tenant_id = t.id LEFT JOIN shipping_settings s ON s.tenant_id = t.id WHERE t.id = $1`,
      [tenantId()],
    );
    return row;
  }

  /** Every settlement line of the month, with the payment it belongs to (through its refund for a refund line). */
  async function linesOf(month) {
    const { start, end } = monthBounds(month);
    const rows = await db.query(
      `SELECT l.id, l.kind, l.amount_paise, l.ref, l.status, l.order_id, l.occurred_at, o.order_number, p.id AS payment_id, p.mode AS payment_mode, p.transfer_id, p.gateway_payment_id,
              p.fee_paise, p.fee_tax_paise
       FROM settlement_lines l
       JOIN orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
       LEFT JOIN refunds r ON r.tenant_id = l.tenant_id AND r.id = ${REFUND_ID}
       LEFT JOIN payments p ON p.tenant_id = l.tenant_id AND p.id = ${PAYMENT_ID}
       WHERE l.tenant_id = $1 AND l.occurred_at >= $2::timestamptz AND l.occurred_at < $3::timestamptz
       ORDER BY l.occurred_at, l.id`,
      [tenantId(), start, end],
    );
    return rows.map((r) => ({
      id: Number(r.id), kind: r.kind, amountPaise: n(r.amount_paise), ref: r.ref, status: r.status, orderId: r.order_id, orderNumber: r.order_number, at: r.occurred_at,
      paymentId: r.payment_id === null ? null : Number(r.payment_id), managed: r.payment_mode === 'managed', transferId: r.transfer_id ?? '', gatewayPaymentId: r.gateway_payment_id ?? '',
      feePaise: n(r.fee_paise) + n(r.fee_tax_paise), counted: false,
    }));
  }

  /** The figures, from the lines alone. Returns the totals and what could not be placed. */
  function figures(lines, { shippingOnPayout }) {
    const t = { sales: 0, refunds: 0, fees: 0, shippingCharges: 0, shippingCredits: 0, transfers: 0, reversals: 0 };
    const orders = new Set();
    const counts = { refunds: 0, shipments: 0, transfers: 0, reviewLines: 0 };
    const payouts = [];
    const unplaced = [];
    for (const l of lines) {
      if (l.status === 'review') counts.reviewLines++;
      const paymentLine = ['sale', 'gateway_fee', 'gateway_fee_tax', 'refund', 'transfer', 'transfer_reversal'].includes(l.kind);
      if (paymentLine && !l.managed) continue; // the seller's own gateway, or cash: not money through Bhava
      l.counted = true;
      if (l.kind === 'sale') {
        t.sales += l.amountPaise;
        orders.add(l.orderId);
      } else if (l.kind === 'gateway_fee' || l.kind === 'gateway_fee_tax') t.fees -= l.amountPaise;
      else if (l.kind === 'refund') {
        t.refunds -= l.amountPaise;
        counts.refunds++;
      } else if (l.kind === 'transfer') {
        t.transfers += l.amountPaise;
        counts.transfers++;
        payouts.push({ transferId: l.transferId, amountPaise: l.amountPaise, at: new Date(l.at).toISOString(), paymentId: l.paymentId });
      } else if (l.kind === 'transfer_reversal') t.reversals -= l.amountPaise;
      else if (l.kind === 'shipping_charge') {
        counts.shipments++;
        if (shippingOnPayout) t.shippingCharges -= l.amountPaise;
        else l.counted = false;
      } else if (l.kind === 'adjustment' && CANCELLED.test(l.ref)) {
        if (shippingOnPayout) t.shippingCredits += l.amountPaise;
        else l.counted = false;
      } else {
        l.counted = false;
        unplaced.push(l);
      }
    }
    // The columns are amounts that can't be negative. A reversal is money taken back from a payout; a month with more taken
    // back than paid out shows no payout and lets the reversal offset that month's refunds, which it always covers (a
    // reversal is written with its refund). A courier credit larger than the month's charges is a difference.
    const netPayouts = t.transfers - t.reversals;
    const payoutsPaise = Math.max(0, netPayouts);
    const refundsPaise = netPayouts >= 0 ? t.refunds : t.refunds + netPayouts;
    const shippingNet = t.shippingCharges - t.shippingCredits;
    return {
      t, orders: orders.size, counts, payouts, unplaced,
      salesPaise: t.sales, refundsPaise: Math.max(0, refundsPaise), gatewayFeesPaise: Math.max(0, t.fees), shippingPaise: Math.max(0, shippingNet),
      payoutsPaise, leftovers: { reversalsBeyondRefunds: Math.max(0, -refundsPaise), shippingCreditBeyondCharges: Math.max(0, -shippingNet), feeCredit: Math.max(0, -t.fees) },
    };
  }

  /** Our payouts and fees against the gateway's report, our courier charges against the courier's. Every difference, never a fix. */
  async function reconcile(month, lines, f, s) {
    const differences = [];
    const details = { checkedAt: now().toISOString() };
    let pending = false;
    const hasManagedPayments = lines.some((l) => l.managed);
    if (s.payment_mode === 'managed' && s.linked_account_id) {
      try {
        const [y, m] = month.split('-').map(Number);
        const report = await providers.razorpay.route.settlementReport({ linkedAccountId: s.linked_account_id }, { year: y, month: m });
        const settled = report.filter((r) => r.kind === 'transfer' && r.settled);
        const reportReversals = report.filter((r) => r.kind === 'reversal');
        const ours = new Map();
        for (const p of f.payouts) {
          const ref = p.transferId || `payment:${p.paymentId}`;
          ours.set(ref, (ours.get(ref) ?? 0) + p.amountPaise);
        }
        const theirs = new Map(settled.map((r) => [String(r.transferId ?? r.id), n(r.amountPaise)]));
        for (const [ref, ourPaise] of ours) {
          if (!theirs.has(ref)) differences.push({ kind: 'payout_not_in_report', ref, ourPaise, reportPaise: 0 });
          else if (theirs.get(ref) !== ourPaise) differences.push({ kind: 'payout_amount', ref, ourPaise, reportPaise: theirs.get(ref) });
        }
        for (const [ref, reportPaise] of theirs) if (!ours.has(ref)) differences.push({ kind: 'payout_missing_here', ref, ourPaise: 0, reportPaise });
        // The fee the gateway kept on each paid-out payment, ours (fee and its GST) against the report's.
        const feeOf = new Map(lines.filter((l) => l.kind === 'transfer' && l.managed).map((l) => [l.transferId, l.feePaise]));
        for (const r of settled) {
          const ourFee = feeOf.get(String(r.transferId ?? r.id));
          if (ourFee !== undefined && ourFee !== n(r.feePaise)) differences.push({ kind: 'gateway_fee', ref: String(r.transferId ?? r.id), ourPaise: ourFee, reportPaise: n(r.feePaise) });
        }
        const reportTransfers = settled.reduce((sum, r) => sum + n(r.amountPaise), 0);
        const reportReversed = reportReversals.reduce((sum, r) => sum + n(r.amountPaise), 0);
        details.payments = {
          ourTransfersPaise: f.t.transfers, reportTransfersPaise: reportTransfers, ourReversalsPaise: f.t.reversals, reportReversalsPaise: reportReversed,
          ourPayoutsPaise: f.t.transfers - f.t.reversals, reportPayoutsPaise: reportTransfers - reportReversed, unsettledInReport: report.filter((r) => r.kind === 'transfer' && !r.settled).length,
        };
        if (details.payments.ourPayoutsPaise !== details.payments.reportPayoutsPaise) {
          differences.push({ kind: 'payout_total', ourPaise: details.payments.ourPayoutsPaise, reportPaise: details.payments.reportPayoutsPaise });
        }
      } catch (err) {
        pending = true;
        details.payments = { error: String(err?.kind ?? err?.code ?? 'unavailable').slice(0, 40) };
      }
    } else if (hasManagedPayments) {
      differences.push({ kind: 'no_linked_account', ourPaise: f.t.transfers - f.t.reversals, reportPaise: 0 });
    }

    // Courier charges: each line against the shipment's own charge, and every charged shipment of the month has its line.
    const charged = lines.filter((l) => l.kind === 'shipping_charge' && SHIPMENT.test(l.ref));
    const ids = charged.map((l) => SHIPMENT.exec(l.ref)[1]);
    const { start, end } = monthBounds(month);
    const shipments = await db.query(
      `SELECT s.id, s.charge_paise, s.mode,
              EXISTS (SELECT 1 FROM settlement_lines x WHERE x.tenant_id = s.tenant_id AND x.kind = 'shipping_charge' AND x.ref = 'shipment:' || s.id::text) AS has_line
       FROM shipments s WHERE s.tenant_id = $1 AND (s.id = ANY($2::bigint[]) OR (s.mode = 'managed' AND s.charge_paise > 0 AND s.created_at >= $3::timestamptz AND s.created_at < $4::timestamptz))`,
      [tenantId(), ids, start, end],
    );
    const byId = new Map(shipments.map((s) => [String(s.id), s]));
    for (const l of charged) {
      const id = SHIPMENT.exec(l.ref)[1];
      const shipment = byId.get(id);
      const reportPaise = shipment && shipment.mode === 'managed' ? n(shipment.charge_paise) : 0;
      if (reportPaise !== -l.amountPaise) differences.push({ kind: 'shipping_charge', ref: l.ref, ourPaise: -l.amountPaise, reportPaise });
    }
    for (const sh of shipments) if (sh.mode === 'managed' && n(sh.charge_paise) > 0 && !sh.has_line) differences.push({ kind: 'shipping_line_missing', ref: `shipment:${sh.id}`, ourPaise: 0, reportPaise: n(sh.charge_paise) });
    details.shipping = { lines: charged.length, ourPaise: charged.reduce((sum, l) => sum - l.amountPaise, 0), courierPaise: charged.reduce((sum, l) => sum + n(byId.get(SHIPMENT.exec(l.ref)[1])?.charge_paise), 0) };

    for (const l of f.unplaced) differences.push({ kind: 'unplaced_line', ref: `${l.kind}:${l.ref}`, ourPaise: l.amountPaise, reportPaise: 0 });
    if (f.leftovers.shippingCreditBeyondCharges) differences.push({ kind: 'shipping_credit_beyond_charges', ourPaise: f.leftovers.shippingCreditBeyondCharges, reportPaise: 0 });
    if (f.leftovers.reversalsBeyondRefunds) differences.push({ kind: 'reversals_beyond_refunds', ourPaise: f.leftovers.reversalsBeyondRefunds, reportPaise: 0 });
    if (f.leftovers.feeCredit) differences.push({ kind: 'fee_credit', ourPaise: f.leftovers.feeCredit, reportPaise: 0 });
    if (f.counts.reviewLines) details.linesInReview = f.counts.reviewLines;
    details.differences = differences.slice(0, 500);
    details.differenceCount = differences.length;
    const reconciliation = pending ? 'pending' : differences.length ? 'mismatch' : 'matched';
    return { reconciliation, details };
  }

  const byMonth = async (month) => (await db.query(`SELECT ${COLUMNS} FROM settlement_statements WHERE tenant_id = $1 AND month = $2::date`, [tenantId(), month]))[0] ?? null;

  /** Builds (or rebuilds, until sent) the statement for one closed month, reconciles it and writes both files. */
  async function run(month, { at = now() } = {}) {
    if (!/^\d{4}-\d{2}-01$/.test(month)) throw new Error('A statement month is YYYY-MM-01');
    if (monthBounds(month).end > at) throw new Error('A statement is made after its month has ended');
    const s = await settings();
    if (!s) return null;
    const existing = await byMonth(month);
    if (existing?.sent_at && existing.reconciliation !== 'pending') return existing;

    const lines = await linesOf(month);
    const f = figures(lines, { shippingOnPayout: (s.charge_billing ?? 'payout') === 'payout' });
    const { reconciliation, details } = await reconcile(month, lines, f, s);
    let row;
    if (existing?.sent_at) {
      [row] = await db.query(`UPDATE settlement_statements SET reconciliation = $3, reconciliation_details = $4::jsonb WHERE tenant_id = $1 AND id = $2 RETURNING ${COLUMNS}`, [tenantId(), existing.id, reconciliation, JSON.stringify(details)]);
    } else {
      const [prev] = await db.query(`SELECT closing_balance_paise FROM settlement_statements WHERE tenant_id = $1 AND month < $2::date ORDER BY month DESC LIMIT 1`, [tenantId(), month]);
      const opening = n(prev?.closing_balance_paise);
      const closing = opening + f.salesPaise - f.refundsPaise - f.gatewayFeesPaise - f.shippingPaise - f.payoutsPaise;
      const counts = { orders: f.orders, refunds: f.counts.refunds, shipments: f.counts.shipments, transfers: f.counts.transfers };
      const payouts = f.payouts.map(({ transferId, amountPaise, at: when }) => ({ transferId, amountPaise, at: when }));
      [row] = await db.query(
        `INSERT INTO settlement_statements (tenant_id, month, opening_balance_paise, sales_paise, refunds_paise, gateway_fees_paise, shipping_paise, commission_paise, payouts_paise,
           closing_balance_paise, counts, payouts, reconciliation, reconciliation_details)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, 0, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb)
         ON CONFLICT (tenant_id, month) DO UPDATE SET opening_balance_paise = EXCLUDED.opening_balance_paise, sales_paise = EXCLUDED.sales_paise, refunds_paise = EXCLUDED.refunds_paise,
           gateway_fees_paise = EXCLUDED.gateway_fees_paise, shipping_paise = EXCLUDED.shipping_paise, payouts_paise = EXCLUDED.payouts_paise, closing_balance_paise = EXCLUDED.closing_balance_paise,
           counts = EXCLUDED.counts, payouts = EXCLUDED.payouts, reconciliation = EXCLUDED.reconciliation, reconciliation_details = EXCLUDED.reconciliation_details
           WHERE settlement_statements.sent_at IS NULL
         RETURNING ${COLUMNS}`,
        [tenantId(), month, opening, f.salesPaise, f.refundsPaise, f.gatewayFeesPaise, f.shippingPaise, f.payoutsPaise, closing, JSON.stringify(counts), JSON.stringify(payouts), reconciliation, JSON.stringify(details)],
      );
      row ??= await byMonth(month); // sent by another run meanwhile
    }

    if (storage) row = await writeFiles(row, lines, s);
    const due = new Date(+monthBounds(month).end + (n(s.statement_day) - 1) * DAY);
    if (!row.sent_at && row.reconciliation !== 'pending' && (row.reconciliation === 'matched' || at >= due) && row.pdf_key && row.csv_key) {
      const [sent] = await db.query(`UPDATE settlement_statements SET sent_at = $3::timestamptz WHERE tenant_id = $1 AND id = $2 AND sent_at IS NULL RETURNING ${COLUMNS}`, [tenantId(), row.id, at]);
      if (sent) row = sent;
    } else if (!row.sent_at && row.reconciliation === 'pending' && at >= due && row.pdf_key && row.csv_key) {
      // The report still can't be had on the statement day: the seller gets the statement saying so, and the check goes on.
      const [sent] = await db.query(`UPDATE settlement_statements SET sent_at = $3::timestamptz WHERE tenant_id = $1 AND id = $2 AND sent_at IS NULL RETURNING ${COLUMNS}`, [tenantId(), row.id, at]);
      if (sent) row = sent;
    }
    log.info('usage.statement', { tenantId: tenantId(), month, statement: Number(row.id), reconciliation: row.reconciliation, differences: n(row.reconciliation_details?.differenceCount), sent: Boolean(row.sent_at) });
    return row;
  }

  async function writeFiles(row, lines, s) {
    const statement = {
      month: row.month, openingBalancePaise: n(row.opening_balance_paise), salesPaise: n(row.sales_paise), refundsPaise: n(row.refunds_paise), gatewayFeesPaise: n(row.gateway_fees_paise),
      shippingPaise: n(row.shipping_paise), payoutsPaise: n(row.payouts_paise), closingBalancePaise: n(row.closing_balance_paise), counts: row.counts, payouts: row.payouts ?? [],
      reconciliation: row.reconciliation, differences: row.reconciliation_details?.differences ?? [],
    };
    const businessName = String(s.business_name ?? '');
    const csvKey = storageKey(row.month, row.id, 'csv');
    const pdfKey = storageKey(row.month, row.id, 'pdf');
    await storage.put(csvKey, statementCsv({ businessName, statement, lines, payoutsIncludeShipping: (s.charge_billing ?? 'payout') === 'payout' }), 'text/csv');
    await storage.put(pdfKey, await statementPdf({ businessName, statement }), 'application/pdf');
    const [updated] = await db.query(`UPDATE settlement_statements SET pdf_key = $3, csv_key = $4 WHERE tenant_id = $1 AND id = $2 RETURNING ${COLUMNS}`, [tenantId(), row.id, pdfKey, csvKey]);
    return updated ?? row;
  }

  /** billing.statements: newest month first. */
  async function list({ cursor, limit = 25 } = {}) {
    const after = cursor ? readCursor(cursor, (key) => key.length === 1 && /^\d{4}-\d{2}-01$/.test(key[0]))[0] : null;
    const rows = await db.query(
      `SELECT ${COLUMNS} FROM settlement_statements WHERE tenant_id = $1 AND ($2::date IS NULL OR month < $2::date) ORDER BY month DESC LIMIT $3`,
      [tenantId(), after, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (row) => [row.month]);
    return { items: page.items.map(toStatement), nextCursor: page.nextCursor };
  }

  const get = async (id) => (await db.query(`SELECT ${COLUMNS} FROM settlement_statements WHERE tenant_id = $1 AND id = $2`, [tenantId(), id]))[0] ?? null;

  /** billing.statementFile: where the file opens. Null for a statement that isn't this business's; a file still being made is a 409 and is queued. */
  async function fileLink(id, format = 'pdf') {
    const row = await get(id);
    if (!row) return null;
    if (!(format === 'pdf' ? row.pdf_key : row.csv_key)) {
      await queue?.enqueue('usage.statement', { month: row.month }, { tenantId: tenantId() });
      throw new ApiError('conflict', 'This statement is still being prepared. Try again in a minute.');
    }
    return { fileUrl: statementFilePath(row.id, format), fileName: `bhava-statement-${row.month.slice(0, 7)}.${format}`, expiresAt: new Date(+now() + 60 * 60_000) };
  }

  /** The file itself, for the download route: { buffer, type, name } or null. */
  async function file(id, format) {
    const row = await get(id);
    const key = row && (format === 'pdf' ? row.pdf_key : row.csv_key);
    if (!key || !storage) return null;
    const buffer = await storage.get(key);
    if (!buffer) return null;
    return { buffer, type: format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8', name: `bhava-statement-${row.month.slice(0, 7)}.${format}` };
  }

  return { run, list, get, fileLink, file, linesOf, previousMonth };
}

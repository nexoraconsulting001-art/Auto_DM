import { ApiError } from '../../contracts/api/index.js';
import { tenantId } from '../../tenancy.js';
import { alertsRepo } from '../alerts/index.js';

/** A payment that can't go ahead, with a sentence a person can read. `code` is one of the API's error codes. */
export class PaymentError extends Error {
  constructor(code, message, reason = '') {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.reason = reason;
  }
}

/** The API's answer for a PaymentError; anything else is thrown on as it is. */
export function asApiError(err) {
  if (err instanceof PaymentError) return new ApiError(err.code, err.message, err.reason ? { reason: err.reason } : {});
  return err;
}

/** The order's row, locked. Every payment and refund change takes this lock first, then the payment's, so two never wait on each other. */
export async function lockOrder(t, orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return null;
  const [order] = await t.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
  return order ?? null;
}

/** Tells the owner or ops, on the db or inside the caller's transaction. The same dedupeKey again does nothing. */
export const raiseAlert = (runner, alert) => alertsRepo(runner).raise(alert);

/**
 * An ops alert from the platform path, where there may be no business (an event no business owns). Deduplicated by key
 * whether or not it names a business.
 */
export async function opsAlert(platformDb, { tenantId: tid = null, kind, message, severity = 'critical', target = '', dedupeKey }) {
  await platformDb.query(
    `INSERT INTO alerts (tenant_id, audience, kind, severity, message, target, dedupe_key)
     SELECT $1::integer, 'ops', $2, $3, $4, $5, $6::text
     WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE tenant_id IS NOT DISTINCT FROM $1::integer AND audience = 'ops' AND dedupe_key = $6::text)
     ON CONFLICT DO NOTHING`,
    [tid, kind, severity, message, target, dedupeKey],
  );
}

/** One line of the statement. (kind, ref) is unique per business, so writing it again changes nothing. */
export async function writeLine(t, { orderId, kind, amountPaise, ref, status = 'ok', at = null }) {
  await t.query(
    `INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref, status, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (tenant_id, kind, ref) DO NOTHING`,
    [tenantId(), orderId, kind, amountPaise, ref, status, at],
  );
}

/** What the daily match or a webhook could not pair up, for the Platform Console. Numbers and ids only. Once per day per thing. */
export async function writeGap(runner, { kind, ref, details = {} }) {
  const [row] = await runner.query(
    `INSERT INTO reconciliation_gaps (tenant_id, day, kind, ref, details) VALUES ($1, current_date, $2, $3, $4::jsonb)
     ON CONFLICT (tenant_id, day, kind, ref) DO NOTHING RETURNING id`,
    [tenantId(), kind, ref, JSON.stringify(details)],
  );
  return Boolean(row);
}

/** acc_...1234: enough to recognise an account, never enough to use it. */
export const maskId = (id) => {
  const value = String(id ?? '');
  if (!value) return '';
  const prefix = /^[a-z]+_/i.exec(value)?.[0] ?? '';
  return `${prefix}...${value.slice(-4)}`;
};

/** ₹1,234 or ₹1,234.50, for a sentence a seller reads. */
export const rupees = (paise) => {
  const n = Number(paise);
  return `₹${n % 100 === 0 ? (n / 100).toLocaleString('en-IN') : (n / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const METHODS = new Set(['upi', 'card', 'netbanking', 'wallet']);
/** The gateway's name for how it was paid, as one of ours. Nothing about the card or account itself is kept. */
export const methodOf = (method) => (METHODS.has(method) ? method : method ? 'other' : '');

/** A gateway's id for an order, payment, refund, transfer or account: letters, digits and underscores, never anything else. */
export const GATEWAY_ID = /^[A-Za-z0-9_]{1,80}$/;
export const isGatewayId = (value) => typeof value === 'string' && GATEWAY_ID.test(value);

/** A whole number of paise the database can hold, or null. */
export const paiseOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

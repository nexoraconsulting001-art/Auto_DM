import crypto from 'node:crypto';
import { ProviderError } from '../../adapters/http.js';
import { INDIAN_STATES, TRANSITIONS } from '../../contracts/orders.js';

/**
 * What the shipping module's files share: statuses, the courier's times, the tracking link's token, and text from outside
 * made safe to store. Nothing here touches the database or the network.
 */
export const SHIPPING_FEATURE = 'store.shipping';

/** A shipment still on its way somewhere. A delivered, returned, cancelled or lost one is done. */
export const LIVE_STATUSES = Object.freeze(['created', 'awb_assigned', 'pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'rto_initiated']);
/** Before the courier has the parcel: it can still be cancelled at the courier. */
export const BEFORE_PICKUP = Object.freeze(['created', 'awb_assigned', 'pickup_scheduled']);

/** The order's fulfilment status a forward shipment's status moves it to (PRD 9.9: Shiprocket events drive the shipping statuses). */
export const ORDER_STATUS_OF = Object.freeze({
  picked_up: 'shipped',
  in_transit: 'shipped',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  rto_initiated: 'rto_initiated',
  rto_delivered: 'rto_delivered',
});

// Statuses a walk may only end on, never pass through: a parcel is not "lost on the way to delivered".
const END_ONLY = new Set(['cancelled', 'lost', 'undelivered']);
const RTO = new Set(['rto_initiated', 'rto_delivered']);

/**
 * The shortest list of moves from `from` to `to` through `machine`'s allowed moves, or null when there is none (it would be
 * a step backwards). [] when already there. Courier scans arrive late and out of order, so "delivered" can come while the
 * row still says "pickup scheduled": the row then walks through "picked up" rather than refusing the truth.
 */
export function walk(machine, from, to, { avoid = () => false } = {}) {
  if (from === to) return [];
  const moves = TRANSITIONS[machine] ?? [];
  const seen = new Set([from]);
  let frontier = [[from, []]];
  while (frontier.length) {
    const next = [];
    for (const [at, path] of frontier) {
      for (const move of moves) {
        if (move.from !== at || move.guard || seen.has(move.to)) continue;
        const route = [...path, move.to];
        if (move.to === to) return route;
        if (avoid(move.to, to)) continue;
        seen.add(move.to);
        next.push([move.to, route]);
      }
    }
    frontier = next;
  }
  return null;
}

/** A shipment's walk: never through cancelled, lost or undelivered, and through a return to origin only when that is where it ends. */
export const shipmentPath = (from, to) => walk('shipment', from, to, { avoid: (step, target) => END_ONLY.has(step) || (RTO.has(step) && !RTO.has(target)) });
/** An order's walk: never through cancelled or back to waiting for payment, and never by a guarded move. */
export const orderPath = (from, to) => walk('fulfilment', from, to, { avoid: (step, target) => step === 'cancelled' || step === 'pending' || (RTO.has(step) && !RTO.has(target)) });

const IST_MS = 5.5 * 3_600_000;
const STAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DMY = /^(\d{2}) (\d{2}) (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A courier time as a Date, or null. Shiprocket writes "2026-11-11 14:05:00" with no zone, in India time. The adapter's
 * track() has already turned that into a Date in the server's own zone, so a Date is read back by its wall clock: either way
 * the same scan gets the same instant, which is what dedupes a webhook against a poll.
 */
export function courierTime(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), value.getMinutes(), value.getSeconds()) - IST_MS);
  }
  const text = String(value ?? '').trim();
  // Shiprocket's webhooks have also been seen writing "23 05 2023 11:43:52": day, month, year.
  const dmy = DMY.exec(text);
  const m = STAMP.exec(text) ?? (dmy && [dmy[0], dmy[3], dmy[2], dmy[1], dmy[4], dmy[5], dmy[6]]);
  if (m) {
    const [y, mo, d, h, mi, s] = m.slice(1).map((n) => Number(n ?? 0));
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s) - IST_MS);
    return y >= 2000 && y <= 2100 ? at : null;
  }
  if (ZONED.test(text)) {
    const at = new Date(text);
    return Number.isNaN(at.getTime()) || at.getUTCFullYear() < 2000 || at.getUTCFullYear() > 2100 ? null : at;
  }
  return null;
}

/** Outside text made safe to store and show: no control characters or NUL, no broken characters, trimmed to `max`. */
export function cleanText(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).toWellFormed().replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const AWB = /^[A-Za-z0-9-]{4,40}$/;
export const isAwb = (value) => typeof value === 'string' && AWB.test(value);
/** The courier's own id for an order or shipment: digits, letters, dashes; never anything else. */
export const providerId = (value) => {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_-]{1,60}$/.test(text) ? text : null;
};

/** A ten-digit Indian mobile or landline as the courier wants it, or null. */
export function tenDigits(phone) {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[1-9][0-9]{9}$/.test(digits) ? digits : null;
}

export const stateName = (code) => INDIAN_STATES[String(code ?? '')] ?? (/^[0-9]$/.test(String(code)) ? INDIAN_STATES[`0${code}`] : null) ?? '';

/** "A", "A and B", "A, B and C". */
export function listOf(names) {
  const list = [...new Set(names)];
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

// ---- the tracking link ----

/**
 * The tracking page's token for an order: its id, then an HMAC keyed by the order's own unguessable public token. So the
 * link is unguessable, works only on its own business's address, survives a key rotation, and never reveals the token of
 * the order page (which can pay, retry and cancel).
 */
export function trackingToken(tenantId, orderId, publicToken) {
  if (!publicToken || !Number.isInteger(Number(orderId))) return null;
  const mac = crypto.createHmac('sha256', String(publicToken)).update(`track:${tenantId}:${orderId}`).digest('base64url').slice(0, 22);
  return `${Number(orderId).toString(36)}.${mac}`;
}

const TOKEN = /^([0-9a-z]{1,7})\.([A-Za-z0-9_-]{22})$/;
/** { orderId, mac } from a token, or null when it isn't one. */
export function readTrackingToken(token) {
  const m = TOKEN.exec(String(token ?? ''));
  if (!m) return null;
  const orderId = parseInt(m[1], 36);
  return Number.isSafeInteger(orderId) && orderId > 0 && orderId <= 2_147_483_647 ? { orderId, mac: m[2] } : null;
}

export function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- courier failures ----

/**
 * What a failed call to the courier means for what happens next:
 *   refused   the courier said no and did nothing (a 4xx): trying the same again won't help
 *   auth      the account's login was refused
 *   retry     it may work later; nothing was done (a 429, or no answer before anything was sent)
 *   unknown   it may have been done: never repeat a create blindly
 */
export function failureOf(err) {
  if (!(err instanceof ProviderError)) return 'unknown';
  if (err.kind === 'auth') return 'auth';
  if (err.delivery === 'none' && !err.retryable) return 'refused';
  if (err.delivery === 'none') return 'retry';
  return 'unknown';
}

/** For a log line: the kind and status of a failure, never its body. */
export const failureFields = (err) => (err instanceof ProviderError ? { kind: err.kind, status: err.status, code: err.code } : { kind: err?.name ?? 'Error' });

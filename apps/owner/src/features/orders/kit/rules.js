/**
 * The store screens' small rules, with no imports, so they are tested in Node as well as in jest: how money reads and
 * how a typed amount becomes paise, what a seller may do next with an order, a return or a review, what can still be
 * refunded, and which fields hold a key that is written and never read back.
 *
 * Shared by the store and account features of the owner app (orders, payments, refunds, shipping, inventory, coupons,
 * invoices, returns, reviews, loyalty, customers, privacy, store settings, Shopify, settings, team, audit log). Every
 * status, move and total is the server's: these rules only decide what to offer, and the server refuses again.
 */

// ---- money ----

/** Largest amount one money field takes (the API's PaiseInput). */
export const MAX_PAISE = 2_147_483_647;

/** ₹1,23,456.50 from integer paise, in Indian grouping. Whole rupees drop the paise. */
export function formatPaise(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(Math.round(n));
  const digits = String(Math.floor(abs / 100));
  const grouped = digits.length <= 3 ? digits : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
  const rest = abs % 100;
  return `${n < 0 ? '−' : ''}₹${grouped}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/**
 * What a person typed, in rupees ("499", "1,299.5", "₹ 20.05"), as integer paise; null when it is not an amount.
 * Worked out on the digits, never through a float, so 0.29 is 29 paise and not 28.
 */
export function parseRupees(text) {
  const clean = String(text ?? '').replace(/[₹,\s]/g, '');
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!match) return null;
  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return paise <= MAX_PAISE ? paise : null;
}

/** Paise as the text a rupee field starts with: "499" or "499.50"; '' for null. */
export function rupeesText(paise) {
  if (paise === null || paise === undefined || !Number.isFinite(Number(paise))) return '';
  const n = Math.round(Number(paise));
  return n % 100 ? `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}` : String(n / 100);
}

/** A whole number typed by a person, or null. `min` and `max` bound it. */
export function parseWhole(text, { min = 0, max = MAX_PAISE } = {}) {
  const clean = String(text ?? '').replace(/[,\s]/g, '');
  if (!/^-?\d{1,10}$/.test(clean)) return null;
  const n = Number(clean);
  return n >= min && n <= max ? n : null;
}

// ---- statuses: the badge tone for each, by group. Words are strings under orders.status.<group>.<status> ----

export const TONES = Object.freeze({
  legacy: { awaiting_payment: 'warn', payment_submitted: 'primary', paid: 'good', shipped: 'primary', delivered: 'good', cancelled: 'bad' },
  fulfilment: { pending: 'warn', new: 'primary', packed: 'primary', ready_to_ship: 'primary', shipped: 'primary', out_for_delivery: 'primary', delivered: 'good', cancelled: 'bad', rto_initiated: 'warn', rto_delivered: 'bad' },
  payment: { unpaid: 'warn', submitted: 'primary', cod_due: 'neutral', advance_paid: 'primary', paid: 'good', partially_refunded: 'warn', refunded: 'neutral', voided: 'neutral' },
  hold: { payment_mismatch: 'bad', paid_out_of_stock: 'bad', cod_risk: 'warn', review: 'warn' },
  attempt: { created: 'neutral', authorized: 'primary', captured: 'good', failed: 'bad', cancelled: 'neutral' },
  refund: { requested: 'primary', processed: 'good', failed: 'bad' },
  shipment: { created: 'neutral', awb_assigned: 'primary', pickup_scheduled: 'primary', picked_up: 'primary', in_transit: 'primary', out_for_delivery: 'primary', undelivered: 'warn', delivered: 'good', rto_initiated: 'warn', rto_delivered: 'bad', cancelled: 'neutral', lost: 'bad' },
  return: { requested: 'warn', approved: 'primary', rejected: 'neutral', pickup_scheduled: 'primary', picked_up: 'primary', received: 'primary', refunded: 'good', exchanged: 'good', cancelled: 'neutral' },
  review: { pending: 'warn', approved: 'good', hidden: 'neutral' },
  file: { queued: 'neutral', ready: 'good', failed: 'bad', expired: 'neutral' },
  dataRequest: { requested: 'warn', processing: 'primary', completed: 'good', rejected: 'neutral' },
  referral: { pending: 'neutral', rewarded: 'good', blocked: 'bad', void: 'neutral' },
  kyc: { not_started: 'neutral', pending: 'warn', verified: 'good', rejected: 'bad' },
  alert: { queued: 'neutral', sent: 'primary', delivered: 'good', failed: 'bad', skipped: 'warn' },
  shopify: { none: 'neutral', active: 'good', reconnect: 'bad', paused: 'warn' },
});

export const toneOf = (group, status) => TONES[group]?.[status] ?? 'neutral';

// ---- orders ----

/** The moves a seller makes by hand (OrderAdvance). */
export const HAND_MOVES = Object.freeze(['packed', 'shipped', 'delivered']);
/** What the seller may give as the reason when they cancel (OrderCancel). */
export const SELLER_CANCEL_REASONS = Object.freeze(['seller', 'out_of_stock', 'fraud', 'other']);
/** Phase 0 orders move by their one status; these are the next ones offered. The server decides. */
const LEGACY_NEXT = Object.freeze({ awaiting_payment: ['paid', 'cancelled'], payment_submitted: ['paid', 'cancelled'], paid: ['shipped', 'cancelled'], shipped: ['delivered'] });

export const isCheckout = (order) => order?.flow === 'checkout';

/** A cash on delivery order that is in and waiting for the seller to say yes: Confirm takes it to packed. */
export function codToConfirm(order) {
  return isCheckout(order) && order.paymentMode === 'cod' && order.fulfilmentStatus === 'new' && !order.holdReason && (order.nextFulfilment ?? []).includes('packed');
}

/** A cancelled order whose money came after its hold ran out (S-41): it may come back. */
export const canReinstate = (order) => isCheckout(order) && order.fulfilmentStatus === 'cancelled' && order.cancelReason === 'hold_expired' && ['paid', 'advance_paid'].includes(order.paymentStatus);

/**
 * What the seller may do next with an order, in the order shown, from what the server said is next (`nextFulfilment`,
 * `canCancel`). Each is { key, kind, to?, status? }; `key` names its words (orders.action.<key>).
 */
export function orderActions(order) {
  if (!order) return [];
  if (!isCheckout(order)) {
    return (LEGACY_NEXT[order.status] ?? []).map((status) => ({ key: status === 'paid' ? 'confirmPayment' : `status.${status}`, kind: 'setStatus', status }));
  }
  const actions = [];
  if (order.holdReason) actions.push({ key: order.holdReason === 'cod_risk' ? 'releaseCod' : 'release', kind: 'release' });
  for (const move of HAND_MOVES.filter((m) => (order.nextFulfilment ?? []).includes(m))) {
    actions.push(move === 'packed' && codToConfirm(order) ? { key: 'confirm', kind: 'advance', to: 'packed' } : { key: move, kind: 'advance', to: move });
  }
  if (canReinstate(order)) actions.push({ key: 'reinstate', kind: 'reinstate' });
  if (order.canCancel) actions.push({ key: 'cancel', kind: 'cancel' });
  return actions;
}

/** The one action a row of the orders list offers: Confirm for an order waiting on the seller, or nothing. */
export function quickAction(order) {
  if (codToConfirm(order)) return { key: 'confirm', kind: 'advance', to: 'packed' };
  if (!isCheckout(order) && order?.status === 'payment_submitted') return { key: 'confirmPayment', kind: 'setStatus', status: 'paid' };
  return null;
}

/**
 * The body an order action sends. Never an amount: what an order costs, what was paid and what is due are the server's.
 * `note` is what the person typed, if anything.
 */
export function actionBody(action, { note = '', reason = 'seller' } = {}) {
  const typed = String(note ?? '').trim();
  switch (action.kind) {
    case 'advance':
      return { to: action.to, ...(typed ? { note: typed } : {}) };
    case 'cancel':
      return { reason: SELLER_CANCEL_REASONS.includes(reason) ? reason : 'seller', ...(typed ? { note: typed } : {}) };
    case 'release':
      return typed ? { note: typed } : {};
    case 'setStatus':
      return { status: action.status, ...(typed ? { notes: typed } : {}) };
    default:
      return undefined;
  }
}

/** The badges an order shows: its status (or its two statuses and any hold, for a checkout order). [{ group, status }] */
export function orderBadges(order) {
  if (!order) return [];
  if (!isCheckout(order)) return [{ group: 'legacy', status: order.status }];
  return [
    { group: 'fulfilment', status: order.fulfilmentStatus },
    order.paymentStatus ? { group: 'payment', status: order.paymentStatus } : null,
    order.holdReason ? { group: 'hold', status: order.holdReason } : null,
  ].filter(Boolean);
}

/** Order list filters: what each chip asks orders.list for. */
export const ORDER_FILTERS = Object.freeze({
  all: {},
  new: { fulfilment: 'new' },
  held: { held: 'true' },
  packed: { fulfilment: 'packed' },
  shipped: { fulfilment: 'shipped' },
  delivered: { fulfilment: 'delivered' },
  cancelled: { fulfilment: 'cancelled' },
});

// ---- refunds ----

/** What can still go back to the customer: what was paid, less what has been refunded. */
export const refundable = (order) => Math.max(0, (order?.paidPaise ?? 0) - (order?.refundedPaise ?? 0));

/** A key that makes a second tap of the same refund the same refund. One per opening of the refund screen. */
export const newRefundKey = (now = Date.now(), random = Math.random) => `app-${now.toString(36)}-${random().toString(36).slice(2, 10).padEnd(8, '0')}`;

/**
 * Checks what a person typed for a refund and builds the body. Answers { body } or { problems: { field: key } }.
 * `most` is what can still be refunded; the server holds the refund inside what was captured again.
 */
export function refundBody({ amountText, reason = '', reference = '', paymentId = null, returnId = null, idempotencyKey, password = '' }, { most, byHand = false } = {}) {
  const problems = {};
  const amountPaise = parseRupees(amountText);
  if (!amountPaise) problems.amount = 'refunds.problem.amount';
  else if (Number.isFinite(most) && amountPaise > most) problems.amount = 'refunds.problem.tooMuch';
  if (byHand && !String(reference).trim()) problems.reference = 'refunds.problem.reference';
  // The contract still asks for the owner's own password on every refund (refunds.create), checked on the call.
  if (!password) problems.password = 'refunds.problem.password';
  if (Object.keys(problems).length) return { problems };
  return {
    body: {
      amountPaise,
      reason: String(reason).trim().slice(0, 300),
      idempotencyKey,
      ...(String(reference).trim() ? { reference: String(reference).trim().slice(0, 100) } : {}),
      ...(paymentId ? { paymentId: Number(paymentId) } : {}),
      ...(returnId ? { returnId: Number(returnId) } : {}),
      password,
    },
  };
}

// ---- shipping ----

const ENDED_SHIPMENTS = new Set(['cancelled', 'rto_delivered', 'lost']);
export const CANCELLABLE_SHIPMENTS = Object.freeze(['created', 'awb_assigned', 'pickup_scheduled']);

/** True when the order is going ahead, hasn't left, has no hold, and has no live parcel of its own. */
export function canBookCourier(order, shipments = []) {
  if (!isCheckout(order) || order.holdReason) return false;
  if (!['new', 'packed'].includes(order.fulfilmentStatus)) return false;
  return !shipments.some((s) => s.kind === 'forward' && !ENDED_SHIPMENTS.has(s.status));
}

/** A shipment's journey as the tracking page draws it: each step done, the latest one now. */
export function journey(shipment) {
  const events = [...(shipment?.events ?? [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return events.map((event, i) => ({ ...event, state: i === events.length - 1 ? 'now' : 'done' }));
}

// ---- returns and reviews ----

const RECEIVABLE = new Set(['approved', 'pickup_scheduled', 'picked_up']);
/** What the seller may do next with a return (9.17). */
export function returnMoves(ret) {
  if (!ret) return [];
  if (ret.status === 'requested') return ['approve', 'decline'];
  if (RECEIVABLE.has(ret.status)) return ['receive'];
  if (ret.status === 'received') return ['refund', 'exchange'];
  return [];
}

/** What the seller may do with a review: show or hide it, and reply once. The shopper's words are never edited. */
export function reviewMoves(review) {
  if (!review) return [];
  const moves = [];
  if (review.status !== 'approved') moves.push('approve');
  if (review.status !== 'hidden') moves.push('hide');
  if (!review.reply) moves.push('reply');
  return moves;
}

// ---- coupons ----

export const COUPON_KINDS = Object.freeze(['percent', 'flat', 'free_shipping']);
export const COUPON_SCOPES = Object.freeze(['all', 'products', 'categories']);
const COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A coupon as the form holds it: text a person edits. */
export function couponForm(coupon) {
  return {
    code: coupon?.code ?? '',
    kind: coupon?.kind ?? 'percent',
    percent: coupon?.percentBp ? String(coupon.percentBp / 100) : '',
    amount: rupeesText(coupon?.amountPaise),
    maxDiscount: rupeesText(coupon?.maxDiscountPaise),
    minOrder: coupon?.minOrderPaise ? rupeesText(coupon.minOrderPaise) : '',
    startsOn: coupon?.startsAt ? String(coupon.startsAt).slice(0, 10) : '',
    endsOn: coupon?.endsAt ? String(coupon.endsAt).slice(0, 10) : '',
    maxUses: coupon?.maxUses ? String(coupon.maxUses) : '',
    maxUsesPerCustomer: coupon?.maxUsesPerCustomer ? String(coupon.maxUsesPerCustomer) : '',
    firstOrderOnly: Boolean(coupon?.firstOrderOnly),
    scope: coupon?.scope ?? 'all',
    scopeIds: coupon?.scopeIds ?? [],
    active: coupon ? Boolean(coupon.active) : true,
  };
}

/** The form back as a CouponCreate body, or { problems }. Dates are whole days in India's time. */
export function couponBody(form) {
  const problems = {};
  const code = String(form.code ?? '').trim().toUpperCase();
  if (!COUPON_CODE.test(code)) problems.code = 'coupons.problem.code';
  const body = { code, kind: form.kind, firstOrderOnly: Boolean(form.firstOrderOnly), active: Boolean(form.active), scope: form.scope, scopeIds: form.scope === 'all' ? [] : [...(form.scopeIds ?? [])] };
  if (form.kind === 'percent') {
    const percent = Number(String(form.percent ?? '').trim());
    if (!(percent > 0 && percent <= 100) || !/^\d{1,3}(\.\d{1,2})?$/.test(String(form.percent).trim())) problems.percent = 'coupons.problem.percent';
    else body.percentBp = Math.round(percent * 100);
    body.amountPaise = null;
    const max = String(form.maxDiscount ?? '').trim();
    if (max) {
      const paise = parseRupees(max);
      if (!paise) problems.maxDiscount = 'coupons.problem.amount';
      else body.maxDiscountPaise = paise;
    } else body.maxDiscountPaise = null;
  } else if (form.kind === 'flat') {
    const paise = parseRupees(form.amount);
    if (!paise) problems.amount = 'coupons.problem.amount';
    else body.amountPaise = paise;
    body.percentBp = null;
    body.maxDiscountPaise = null;
  } else {
    body.percentBp = null;
    body.amountPaise = null;
    body.maxDiscountPaise = null;
  }
  const min = String(form.minOrder ?? '').trim();
  if (min) {
    const paise = parseRupees(min);
    if (paise === null) problems.minOrder = 'coupons.problem.amount';
    else body.minOrderPaise = paise;
  } else body.minOrderPaise = 0;
  for (const [field, key, end] of [['startsOn', 'startsAt', false], ['endsOn', 'endsAt', true]]) {
    const day = String(form[field] ?? '').trim();
    if (!day) body[key] = null;
    else if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00+05:30`))) problems[field] = 'coupons.problem.date';
    else body[key] = `${day}T${end ? '23:59:59' : '00:00:00'}+05:30`;
  }
  if (body.startsAt && body.endsAt && body.endsAt < body.startsAt) problems.endsOn = 'coupons.problem.dates';
  for (const [field, max] of [['maxUses', 10_000_000], ['maxUsesPerCustomer', 1000]]) {
    const text = String(form[field] ?? '').trim();
    if (!text) body[field] = null;
    else {
      const n = parseWhole(text, { min: 1, max });
      if (n === null) problems[field] = 'coupons.problem.count';
      else body[field] = n;
    }
  }
  if (form.scope !== 'all' && body.scopeIds.length === 0) problems.scope = 'coupons.problem.scope';
  return Object.keys(problems).length ? { problems } : { body };
}

// ---- keys that are written and never read back (P-17) ----

/**
 * Every field the app sends that holds a key, a password or a token. The screens keep each in a write-only field: masked,
 * never filled from the server, never kept in the query cache, cleared once sent. A test reads this list.
 */
export const WRITE_ONLY_FIELDS = Object.freeze(['razorpayKeySecret', 'ownPassword', 'accessToken', 'webhookSecret', 'password']);

/** Only the fields with something typed in them, trimmed when they are not secrets: a field left empty keeps what is saved. */
export function filledOnly(values, secrets = WRITE_ONLY_FIELDS) {
  const out = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof value !== 'string') continue;
    const kept = secrets.includes(key) ? value : value.trim();
    if (kept) out[key] = kept;
  }
  return out;
}

// ---- team ----

/** True when `member` is the business's only owner: they may not be demoted or removed (F-49). */
export const isOnlyOwner = (members, member) => member?.role === 'owner' && (members ?? []).filter((m) => m.role === 'owner').length <= 1;

/** What a role change sends: permissions count only for staff. */
export function teamBody({ role, permissions }) {
  return role === 'staff' ? { role, permissions: [...new Set(permissions ?? [])] } : { role, permissions: [] };
}

// ---- dates ----

const pad = (n) => String(n).padStart(2, '0');
/** The first and last day of a month (offset 0 is this one, -1 the last), as YYYY-MM-DD in India's time. */
export function monthRange(offset = 0, now = new Date()) {
  const india = new Date(now.getTime() + 330 * 60_000);
  const year = india.getUTCFullYear();
  const month = india.getUTCMonth() + offset;
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { from: fmt(first), to: fmt(last) };
}

// ---- the audit log ----

/** An audit entry's details as short "key: value" lines: plain values only, nothing nested, nothing long. */
export function detailLines(details, { max = 6 } = {}) {
  return Object.entries(details ?? {})
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, max)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 80)}`);
}

// ---- lists ----

/** Every row of an infinite query's pages. */
export const rowsOf = (data) => (data?.pages ?? []).flatMap((page) => page?.items ?? []);

import { tenantId } from '../../tenancy.js';
import {
  CANCEL_REASONS, FULFILMENT_STATUSES, HOLD_REASONS, PAYMENT_STATUSES, TRANSITIONS, findTransition, passesGuard,
} from '../../contracts/orders.js';

export * from '../../contracts/orders.js';

/**
 * The one order state machine (PRD 9.9). This file is the only place in the codebase that changes an order's status, and
 * the only place that changes the status of a payment, refund, shipment or return. The allowed moves are data, in
 * src/contracts/orders.js; migration 402 holds the same list and its triggers refuse anything else, so a query that goes
 * round this file still cannot make a move that isn't allowed. A test keeps this file the only writer.
 *
 * Every function takes `t`, an open transaction from db.tx() inside withTenant(): the status change, whatever else the
 * caller does with it (stock, coupon use, a payment row) and the order event the database writes for it commit together
 * or not at all. Nothing here sends a message or calls a provider: listeners on ctx.orderEvents do that, after commit.
 *
 *   changeOrder(t, orderId, { fulfilment?, payment?, actor, reason?, cancelReason?, set?, ifAllowed? })
 *       -> { order, changed: { fulfilment, payment }, skipped }
 *   holdOrder(t, orderId, holdReason, { actor, reason? })      releaseOrder(t, orderId, { actor, reason? })
 *   addOrderNote(t, orderId, { actor, note })
 *   changeRow(t, 'payments' | 'refunds' | 'shipments' | 'returns', id, toStatus, { set?, ifAllowed? }) -> { row, changed, skipped }
 *   setManualStatus(t, orderId, status, { notes?, onlyFrom? })   Phase 0 orders only
 *
 * `actor` is who did it, as an id: 'user:12', 'shopper:7', 'webhook:razorpay', 'job:hold-expiry'. It lands in the order's
 * timeline (order_status_history), which the database writes for every change. Never a name or a phone number.
 *
 * `ifAllowed: true` is for provider events, which arrive late, twice and out of order: a move that isn't allowed from where
 * the row now stands is skipped and reported, never thrown, and nothing moves backwards (S-23, S-24, S-35).
 * Asking for the status a row already has is never an error and changes nothing.
 */

export class OrderStateError extends Error {
  /** code: 'not_found' | 'not_allowed' | 'guard' | 'manual_order' | 'checkout_order' | 'invalid' */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OrderStateError';
    this.code = code;
    Object.assign(this, details);
  }
}

/** Columns a caller may write in the same statement as a status change. Totals, the order number and the way of paying are fixed at checkout. */
const ORDER_SET = new Set(['paid_paise', 'refunded_paise', 'hold_expires_at', 'cod_risk', 'notes', 'gateway_mode', 'shopper_id']);
const ROW_MACHINES = Object.freeze({ payments: 'payment_attempt', refunds: 'refund', shipments: 'shipment', returns: 'return' });
const COLUMN = /^[a-z][a-z0-9_]{0,40}$/;
const ROW_FIXED = new Set(['id', 'tenant_id', 'order_id', 'status', 'created_at']);
const MANUAL_STATUSES = Object.freeze(['awaiting_payment', 'payment_submitted', 'paid', 'shipped', 'delivered', 'cancelled']);

const cleanActor = (actor) => {
  const value = String(actor ?? '').trim();
  if (!/^[a-z][a-z0-9_-]*(:[A-Za-z0-9_.-]+)?$/.test(value) || value.length > 80) throw new OrderStateError('invalid', 'actor must be an id such as user:12 or job:hold-expiry');
  return value;
};

/** Tells the database who is making the change, for this transaction only. The timeline trigger reads it. */
async function stamp(t, actor, reason = '') {
  await t.query(`SELECT set_config('app.order_actor', $1, true), set_config('app.order_reason', $2, true)`, [cleanActor(actor), String(reason ?? '').slice(0, 200)]);
}

async function lockOrder(t, orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw new OrderStateError('not_found', 'Order not found');
  const [order] = await t.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
  if (!order) throw new OrderStateError('not_found', 'Order not found');
  return order;
}

function assignments(set, allowed, firstParam) {
  const columns = [];
  const values = [];
  for (const [column, value] of Object.entries(set ?? {})) {
    if (!COLUMN.test(column) || !allowed(column)) throw new OrderStateError('invalid', `"${column}" can't be written with a status change`);
    values.push(value);
    columns.push(`${column} = $${firstParam + values.length - 1}`);
  }
  return { columns, values };
}

/**
 * Moves a checkout order's fulfilment status, its payment status, or both in one statement (paying an order confirms it:
 * { payment: 'paid', fulfilment: 'new' }). The payment move is judged first, so a fulfilment guard sees the money as it will be.
 */
export async function changeOrder(t, orderId, { fulfilment, payment, actor, reason = '', cancelReason, set, ifAllowed = false } = {}) {
  if (fulfilment !== undefined && !FULFILMENT_STATUSES.includes(fulfilment)) throw new OrderStateError('invalid', `Unknown fulfilment status "${fulfilment}"`);
  if (payment !== undefined && !PAYMENT_STATUSES.includes(payment)) throw new OrderStateError('invalid', `Unknown payment status "${payment}"`);
  if (cancelReason !== undefined && !CANCEL_REASONS.includes(cancelReason)) throw new OrderStateError('invalid', `Unknown cancel reason "${cancelReason}"`);
  const order = await lockOrder(t, orderId);
  if (order.flow !== 'checkout') throw new OrderStateError('manual_order', 'This order was placed before checkout existed; change it with setManualStatus');

  const next = { payment_status: order.payment_status, fulfilment_status: order.fulfilment_status, payment_mode: order.payment_mode, cancel_reason: order.cancel_reason };
  const changed = { fulfilment: false, payment: false };
  const skipped = [];
  const refuse = (code, machine, from, to, guard) => {
    if (ifAllowed) return void skipped.push({ machine, from, to, guard: guard ?? '' });
    throw new OrderStateError(code, guard ? `An order can't go from ${from} to ${to} here (${guard})` : `An order can't go from ${from} to ${to}`, { machine, from, to, guard });
  };

  if (payment !== undefined && payment !== order.payment_status) {
    const move = findTransition('payment', order.payment_status, payment);
    if (!move) refuse('not_allowed', 'payment', order.payment_status, payment);
    else if (!passesGuard(move.guard, { ...next, payment_status: payment })) refuse('guard', 'payment', order.payment_status, payment, move.guard);
    else {
      next.payment_status = payment;
      changed.payment = true;
    }
  }
  if (fulfilment !== undefined && fulfilment !== order.fulfilment_status) {
    const move = findTransition('fulfilment', order.fulfilment_status, fulfilment);
    if (!move) refuse('not_allowed', 'fulfilment', order.fulfilment_status, fulfilment);
    else if (!passesGuard(move.guard, next)) refuse('guard', 'fulfilment', order.fulfilment_status, fulfilment, move.guard);
    else {
      next.fulfilment_status = fulfilment;
      changed.fulfilment = true;
    }
  }

  const extra = assignments(set, (column) => ORDER_SET.has(column), 5);
  if (!changed.fulfilment && !changed.payment && !extra.columns.length) return { order, changed, skipped };

  // The reason a cancelled order was cancelled stays with it; the database clears it if the order ever comes back.
  const reasonNow = changed.fulfilment && next.fulfilment_status === 'cancelled' ? cancelReason ?? 'other' : order.cancel_reason;
  await stamp(t, actor, reason);
  const [updated] = await t.query(
    `UPDATE orders SET fulfilment_status = $3, payment_status = $4${[...extra.columns.map((c) => `, ${c}`)].join('')}, cancel_reason = $${5 + extra.values.length}
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId(), order.id, next.fulfilment_status, next.payment_status, ...extra.values, reasonNow],
  );
  return { order: updated, changed, skipped };
}

/** Puts an order on hold for a person to look at (9.7 amount mismatch, 9.12 paid with no stock). Neither status changes. */
export async function holdOrder(t, orderId, holdReason, { actor, reason = '' } = {}) {
  if (!HOLD_REASONS.includes(holdReason)) throw new OrderStateError('invalid', `Unknown hold reason "${holdReason}"`);
  const order = await lockOrder(t, orderId);
  if (order.hold_reason === holdReason) return { order, changed: false };
  await stamp(t, actor, reason);
  const [updated] = await t.query('UPDATE orders SET hold_reason = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId(), order.id, holdReason]);
  return { order: updated, changed: true };
}

export async function releaseOrder(t, orderId, { actor, reason = '' } = {}) {
  const order = await lockOrder(t, orderId);
  if (order.hold_reason === null) return { order, changed: false };
  await stamp(t, actor, reason);
  const [updated] = await t.query('UPDATE orders SET hold_reason = NULL WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId(), order.id]);
  return { order: updated, changed: true };
}

/** A note on the timeline. The seller's own words: shown to the seller, never logged. */
export async function addOrderNote(t, orderId, { actor, note }) {
  const text = String(note ?? '').trim().slice(0, 1000);
  if (!text) throw new OrderStateError('invalid', 'Write a note first');
  const order = await lockOrder(t, orderId);
  const [row] = await t.query(
    `INSERT INTO order_status_history (tenant_id, order_id, machine, actor, note) VALUES ($1, $2, 'note', $3, $4) RETURNING id, created_at`,
    [tenantId(), order.id, cleanActor(actor), text],
  );
  return { id: Number(row.id), createdAt: row.created_at };
}

/**
 * Moves a payment, refund, shipment or return to `to`. `set` is other columns of the same row to write with it (a gateway
 * payment id, an AWB, a fee): any column except the row's id, business, order and status.
 */
export async function changeRow(t, table, id, to, { set, ifAllowed = false } = {}) {
  const machine = Object.hasOwn(ROW_MACHINES, table) ? ROW_MACHINES[table] : null;
  if (!machine) throw new OrderStateError('invalid', `"${table}" has no status machine`);
  if (!TRANSITIONS[machine].some((m) => m.from === to || m.to === to)) throw new OrderStateError('invalid', `Unknown ${machine} status "${to}"`);
  const [row] = await t.query(`SELECT * FROM ${table} WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId(), id]);
  if (!row) throw new OrderStateError('not_found', `No such row in ${table}`);

  const moving = row.status !== to;
  if (moving && !findTransition(machine, row.status, to)) {
    if (ifAllowed) return { row, changed: false, skipped: [{ machine, from: row.status, to, guard: '' }] };
    throw new OrderStateError('not_allowed', `A ${machine} can't go from ${row.status} to ${to}`, { machine, from: row.status, to });
  }
  const extra = assignments(set, (column) => !ROW_FIXED.has(column), 4);
  if (!moving && !extra.columns.length) return { row, changed: false, skipped: [] };
  const [updated] = await t.query(
    `UPDATE ${table} SET status = $3${extra.columns.map((c) => `, ${c}`).join('')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [tenantId(), row.id, to, ...extra.values],
  );
  return { row: updated, changed: moving, skipped: [] };
}

/**
 * A Phase 0 order (flow 'manual': manual UPI, "I've paid") keeps its one column and its one rule: a cancelled order is never
 * reopened. The database derives the two new statuses from it. `onlyFrom` makes the change only when the order is in that
 * status. Returns { order, changed, previous }.
 */
export async function setManualStatus(t, orderId, status, { notes, onlyFrom, actor = 'system' } = {}) {
  if (!MANUAL_STATUSES.includes(status)) throw new OrderStateError('invalid', 'Unknown status');
  const order = await lockOrder(t, orderId);
  if (order.flow !== 'manual') throw new OrderStateError('checkout_order', 'This order is changed from its own actions, not by setting a status');
  if (onlyFrom !== undefined && order.status !== onlyFrom) return { order, changed: false, previous: order.status };
  if (order.status === 'cancelled' && status !== 'cancelled') throw new OrderStateError('not_allowed', 'Cancelled orders can’t be reopened. Ask the customer to order again.', { from: 'cancelled', to: status });
  await stamp(t, actor);
  const [updated] = await t.query('UPDATE orders SET status = $3, notes = COALESCE($4, notes) WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId(), order.id, status, notes ?? null]);
  return { order: updated, changed: order.status !== status, previous: order.status };
}

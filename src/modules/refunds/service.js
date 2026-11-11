import { ProviderError } from '../../adapters/http.js';
import { ApiError } from '../../contracts/api/index.js';
import { log, reportError } from '../../platform/log.js';
import { checkPassword } from '../../repos/users.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { changeOrder, changeRow } from '../orders/state.js';
import { PaymentError, isGatewayId, lockOrder, paiseOf, raiseAlert, rupees, writeGap, writeLine } from '../payments/util.js';

/**
 * Refunds (PRD 9.8), built with the payments service (ctx.refunds).
 *
 *   create(orderId, { amountPaise, reason, paymentId?, reference?, returnId?, idempotencyKey, actor })
 *       The refund row is written first, inside what is left of the payment: the order and the payment are locked, the
 *       amount is checked against what the payment captured less every refund not failed, and the database checks the same
 *       again (S-28), so two refunds at the same moment can't both pass the limit. Then the gateway is asked, outside any
 *       transaction, with a key that makes a repeat the same refund. A cash-on-delivery payment is refunded by hand: 'manual',
 *       with the reference of how the money went back, and processed at once.
 *   createByOwner(orderId, body, user)   the API's: the owner's password is checked again on the call (5.11), then create.
 *   retry(refundId, actor)               a failed gateway refund, asked again with the same key.
 *   applyGatewayRefund({ paymentId, refund, type })   a refund webhook (9.7).
 *   onCancelled(orderId)                 order.cancelled: a shopper's own cancellation is refunded at once (S-56, S-69);
 *                                        any other cancellation of a paid order prompts the owner (S-31).
 *   sweep()                              refunds whose gateway answer was lost are asked about again with their key.
 *
 * Processing a refund moves the order to partially_refunded or refunded, adds to the running totals, writes the statement's
 * refund line, and in managed mode records the matching part of the seller's Route transfer taken back and its line (S-75).
 * In own mode nothing is reversed (S-76). Every refund is in the audit log.
 */
const RETRYING = 'retrying';
const REAUTH = Object.freeze({ limit: 5, windowMs: 15 * 60_000 });

export const toRefund = (row) => ({
  id: Number(row.id), orderId: row.order_id, paymentId: Number(row.payment_id), amountPaise: Number(row.amount_paise), status: row.status, method: row.method,
  reference: row.reference, reason: row.reason, reversalStatus: row.reversal_status, reversalPaise: Number(row.reversal_paise), createdAt: row.created_at, processedAt: row.processed_at,
});

/** The key the gateway knows a refund by. The managed account serves every business, so it names the business too. */
const gatewayKey = (row) => `t${row.tenant_id}-r${row.id}`;

const amountField = (message) => new ApiError('validation_failed', message, { fields: { amountPaise: message } });

export function createRefunds(ctx, payments) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;
  const kick = () => ctx.orderEvents?.kick?.();

  /** What other refunds already hold of a payment: every one not failed, and a failed one being tried again. */
  async function held(t, paymentId, exceptId = 0) {
    const [{ used }] = await t.query(
      `SELECT COALESCE(sum(amount_paise), 0) AS used FROM refunds WHERE tenant_id = $1 AND payment_id = $2 AND id <> $3 AND (status <> 'failed' OR error_code = $4)`,
      [tenantId(), paymentId, exceptId, RETRYING],
    );
    return Number(used);
  }

  /** Inside the caller's transaction, with the order locked: the refund processed and everything that follows from it. */
  async function markProcessed(t, refundId, { gatewayRefundId = null, reversal = null, actor = 'system' } = {}) {
    // The order, then the payment, then the refund: the same order every change here takes its locks in.
    const [found] = await t.query('SELECT order_id, payment_id FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), refundId]);
    if (!found) return null;
    const order = await lockOrder(t, found.order_id);
    const [payment] = await t.query('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), found.payment_id]);
    const [refund] = await t.query('SELECT * FROM refunds WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), refundId]);
    if (refund.status === 'processed') return refund;
    const amount = Number(refund.amount_paise);
    const set = { processed_at: new Date(), error_code: '' };
    if (gatewayRefundId && !refund.gateway_refund_id) set.gateway_refund_id = gatewayRefundId;

    // Managed: the same part of the seller's Route transfer comes back (S-75). Own mode never has one (S-76).
    let reversedPaise = 0;
    if (payment.mode === 'managed') {
      const room = Number(payment.transfer_paise) - Number(payment.reversed_paise);
      const got = paiseOf(reversal?.amountPaise);
      if (got && got > 0) {
        reversedPaise = Math.min(got, amount, Math.max(0, room));
        Object.assign(set, { reversal_status: 'reversed', reversal_paise: reversedPaise, reversal_id: isGatewayId(reversal.id) ? reversal.id : null });
      } else {
        // Not taken back with the refund: when the transfer has already settled it is recovered from the seller later.
        set.reversal_status = payment.transfer_status === 'settled' ? 'recover' : 'pending';
      }
    }
    const moved = await changeRow(t, 'refunds', refund.id, 'processed', { set, ifAllowed: true });
    if (!moved.changed) return moved.row;

    const paymentSet = { refunded_paise: Number(payment.refunded_paise) + amount };
    if (reversedPaise) {
      paymentSet.reversed_paise = Number(payment.reversed_paise) + reversedPaise;
      if (paymentSet.reversed_paise >= Number(payment.transfer_paise)) paymentSet.transfer_status = 'reversed';
    }
    await changeRow(t, 'payments', payment.id, payment.status, { set: paymentSet });

    const refunded = Number(order.refunded_paise) + amount;
    const target = refunded >= Number(order.paid_paise) ? 'refunded' : 'partially_refunded';
    await changeOrder(t, order.id, { payment: target, actor, reason: 'refund processed', set: { refunded_paise: refunded }, ifAllowed: true });

    const ref = `refund:${refund.id}`;
    await writeLine(t, { orderId: order.id, kind: 'refund', amountPaise: -amount, ref });
    if (reversedPaise) await writeLine(t, { orderId: order.id, kind: 'transfer_reversal', amountPaise: -reversedPaise, ref });
    if (set.reversal_status === 'recover') {
      await writeGap(t, { kind: 'refund_mismatch', ref, details: { reversal: 'recover' } });
      await raiseAlert(t, { kind: 'refund.recover', audience: 'ops', message: `A refund on order ${order.order_number} was made after the payout settled: ${rupees(amount)} is to be recovered from the seller.`, target: `order:${order.id}`, dedupeKey: `refund-recover:${refund.id}` });
    }
    await writeAudit(t, { actor, action: 'refund.processed', target: `order:${order.id}`, details: { refundId: Number(refund.id), amountPaise: amount, method: refund.method, reversedPaise } });
    return moved.row;
  }

  /** Inside the caller's transaction: the gateway refused the refund. A processed refund never becomes failed. */
  async function markFailed(t, refundId, code) {
    const [refund] = await t.query('SELECT order_id FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), refundId]);
    if (!refund) return null;
    const order = await lockOrder(t, refund.order_id);
    const moved = await changeRow(t, 'refunds', refundId, 'failed', { ifAllowed: true, set: { error_code: String(code || 'refused').replace(/[^A-Za-z0-9_]/g, '').slice(0, 80) || 'refused' } });
    if (moved.row.status === 'failed') {
      await raiseAlert(t, { kind: 'refund.failed', severity: 'critical', message: `A refund of ${rupees(moved.row.amount_paise)} on order ${order.order_number} didn’t go through. Try it again from the order.`, target: `order:${order.id}`, dedupeKey: `refund-failed:${refundId}:${Math.floor(Date.now() / 3_600_000)}` });
      await writeAudit(t, { actor: 'system', action: 'refund.failed', target: `order:${order.id}`, details: { refundId: Number(refundId), code: moved.row.error_code } });
    }
    return moved.row;
  }

  const reread = async (refundId) => (await db.query('SELECT * FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), refundId]))[0];

  /** Asks the gateway for one refund that is requested, or failed and being tried again. Outside any transaction. */
  async function submit(refundId, actor = 'system') {
    const [row] = await db.query(
      `SELECT r.*, p.mode, p.account_ref, p.gateway_payment_id FROM refunds r JOIN payments p ON p.tenant_id = r.tenant_id AND p.id = r.payment_id
       WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId(), refundId],
    );
    if (!row || row.method !== 'gateway' || !(row.status === 'requested' || (row.status === 'failed' && row.error_code === RETRYING))) return row;
    let answer;
    try {
      const creds = await payments.settings.credentials(row.mode, { accountRef: row.account_ref });
      answer = await creds.adapter.refund(creds.account, row.gateway_payment_id, { amountPaise: Number(row.amount_paise), idempotencyKey: gatewayKey(row), notes: { refund: String(row.id) } });
    } catch (err) {
      if (err instanceof PaymentError) return db.tx((t) => markFailed(t, row.id, 'account_unavailable'));
      if (!(err instanceof ProviderError)) throw err;
      if (err.delivery === 'none') return db.tx((t) => markFailed(t, row.id, err.code || err.kind));
      // The gateway may have made it: the sweep asks again with the same key, which can only ever make this one refund.
      log.warn('refunds.gateway_unanswered', { refundId: Number(row.id), kind: err.kind });
      return reread(row.id);
    }
    if (answer?.status === 'failed') return db.tx((t) => markFailed(t, row.id, 'gateway_failed'));
    if (answer?.status === 'processed') {
      const done = await db.tx((t) => markProcessed(t, row.id, { gatewayRefundId: isGatewayId(answer.id) ? answer.id : null, reversal: answer.reversal, actor }));
      kick();
      return done;
    }
    // Pending at the gateway: its webhook, or the sweep, finishes it.
    if (isGatewayId(answer?.id)) await db.query('UPDATE refunds SET gateway_refund_id = $3 WHERE tenant_id = $1 AND id = $2 AND gateway_refund_id IS NULL', [tenantId(), row.id, answer.id]);
    return reread(row.id);
  }

  async function create(orderId, { amountPaise, reason = '', paymentId, reference = '', returnId, idempotencyKey, actor }) {
    const amount = Number(amountPaise);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw amountField('Enter an amount to refund');
    let placed;
    try {
      placed = await db.tx(async (t) => {
        const order = await lockOrder(t, orderId);
        if (!order) throw new ApiError('not_found', 'We couldn’t find that order.');
        const [same] = await t.query('SELECT * FROM refunds WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId(), idempotencyKey]);
        if (same) {
          if (same.order_id !== order.id || Number(same.amount_paise) !== amount) throw new ApiError('conflict', 'That refund was already asked for with different details. Refresh and try again.');
          return { row: same, repeat: true };
        }
        if (order.flow !== 'checkout') throw new ApiError('conflict', 'This order was paid outside the store’s checkout. Refund it the way it was paid.');
        // Every captured payment of the order, locked in one order so two refunds never wait on each other.
        const captured = await t.query(`SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 AND status = 'captured' ORDER BY id FOR UPDATE`, [tenantId(), order.id]);
        if (!captured.length) throw new ApiError('conflict', 'Nothing has been paid on this order yet, so there is nothing to refund.');
        const left = new Map();
        for (const p of captured) left.set(Number(p.id), Number(p.amount_paise) - (await held(t, p.id)));
        const total = [...left.values()].reduce((a, b) => a + b, 0);
        if (amount > total) throw amountField(total > 0 ? `You can refund at most ${rupees(total)} on this order.` : 'This order has been refunded in full already.');
        // Online first, newest first; cash collected at the door last.
        const preferred = [...captured].sort((a, b) => (a.provider === 'cod') - (b.provider === 'cod') || Number(b.id) - Number(a.id));
        const payment = paymentId ? captured.find((p) => Number(p.id) === Number(paymentId)) : preferred.find((p) => left.get(Number(p.id)) >= amount);
        if (paymentId && !payment) throw new ApiError('validation_failed', 'That payment isn’t a captured payment of this order.', { fields: { paymentId: 'Pick a payment of this order' } });
        if (!payment || amount > left.get(Number(payment.id))) {
          const most = Math.max(...[...left.values()]);
          throw amountField(`This order was paid in parts: refund at most ${rupees(most)} at a time.`);
        }
        const manual = payment.provider === 'cod';
        const ref = String(reference ?? '').trim();
        if (manual && !ref) throw new ApiError('validation_failed', 'Enter how the money was paid back, such as the UPI reference.', { fields: { reference: 'Enter the UPI reference or receipt number' } });
        if (!manual && !payment.gateway_payment_id) throw new ApiError('conflict', 'This payment can’t be refunded through the gateway yet.');
        const [row] = await t.query(
          `INSERT INTO refunds (tenant_id, order_id, payment_id, amount_paise, method, reference, reason, requested_by, idempotency_key, reversal_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [tenantId(), order.id, payment.id, amount, manual ? 'manual' : 'gateway', manual ? ref.slice(0, 100) : '', String(reason ?? '').slice(0, 300), actor, idempotencyKey, payment.mode === 'managed' ? 'pending' : 'none'],
        );
        await writeAudit(t, { actor, action: 'refund.request', target: `order:${order.id}`, details: { refundId: Number(row.id), amountPaise: amount, method: row.method, paymentId: Number(payment.id), ...(returnId ? { returnId: Number(returnId) } : {}) } });
        if (manual) return { row: await markProcessed(t, row.id, { actor }), manual: true };
        return { row };
      });
    } catch (err) {
      // What the database itself refused: a refund past what was captured (another refund got there first), or the same key twice at once.
      if (err?.constraint === 'refunds_within_captured') throw amountField('That is more than is left to refund on this payment.');
      if (err?.code === '23505' && /idempotency/.test(err.constraint ?? '')) {
        const [same] = await db.query('SELECT * FROM refunds WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId(), idempotencyKey]);
        if (same) return toRefund(same);
      }
      throw err;
    }
    if (placed.manual) kick();
    if (placed.manual || placed.row.method !== 'gateway' || placed.row.status === 'processed') return toRefund(placed.row);
    // A repeat of a refund still with the gateway asks again with the same key: it can only ever be the one refund.
    return toRefund(await submit(placed.row.id, actor));
  }

  async function createByOwner(orderId, body, user) {
    const limit = await ctx.platform.rateLimit.hit('refund_reauth', `${tenantId()}:${user.id}`, REAUTH);
    if (!limit.allowed) throw new ApiError('rate_limited', 'Too many tries. Wait a few minutes and try again.');
    // The signed-in owner's own password, checked against their own row: nothing else a sign-in does happens here.
    const [me] = await db.query('SELECT id, role, password_hash FROM users WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(user.id)]);
    if (!me || me.role !== 'owner' || !(await checkPassword(body.password, me.password_hash))) {
      log.warn('refunds.reauth_failed', { userId: user.id });
      throw new ApiError('validation_failed', 'That password isn’t right.', { fields: { password: 'That password isn’t right' } });
    }
    await ctx.platform.rateLimit.reset('refund_reauth', `${tenantId()}:${user.id}`);
    return create(orderId, { ...body, actor: `user:${user.id}` });
  }

  async function retry(refundId, actor) {
    const id = Number(refundId);
    const ready = await db.tx(async (t) => {
      const [found] = await t.query('SELECT order_id FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      if (!found) return null;
      await lockOrder(t, found.order_id);
      const [refund] = await t.query('SELECT * FROM refunds WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
      if (refund.status === 'processed') return { row: refund, done: true };
      if (refund.method !== 'gateway') throw new ApiError('conflict', 'A refund paid back by hand isn’t sent to the gateway.');
      if (refund.status === 'requested' || refund.error_code === RETRYING) return { row: refund };
      const [payment] = await t.query('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), refund.payment_id]);
      if (payment.status !== 'captured' || (await held(t, payment.id, refund.id)) + Number(refund.amount_paise) > Number(payment.amount_paise)) {
        throw new ApiError('conflict', 'The rest of this payment has been refunded already, so this refund can’t be tried again.');
      }
      // Still failed, but holding its amount while the gateway is asked again.
      const moved = await changeRow(t, 'refunds', refund.id, 'failed', { set: { error_code: RETRYING } });
      await writeAudit(t, { actor, action: 'refund.retry', target: `order:${refund.order_id}`, details: { refundId: id } });
      return { row: moved.row };
    });
    if (!ready) return null;
    if (ready.done) return toRefund(ready.row);
    return toRefund(await submit(id, actor));
  }

  /**
   * A refund webhook. Ours is found by the gateway's id, or the id we put in its notes, or, when the gateway's answer to us
   * was lost, as the one refund of that amount still waiting on that payment. A refund made at the gateway itself (the
   * seller's own dashboard) is recorded, so the totals stay true; one that doesn't fit is a gap for ops.
   */
  async function applyGatewayRefund({ paymentId, refund: entity, type }) {
    const status = entity.status || type.slice('refund.'.length);
    const [ours] = await db.query(
      `SELECT * FROM refunds WHERE tenant_id = $1 AND payment_id = $2 AND (gateway_refund_id = $3 OR ($4::bigint IS NOT NULL AND id = $4::bigint AND gateway_refund_id IS NULL)) ORDER BY id LIMIT 1`,
      [tenantId(), paymentId, entity.id, entity.noteRefund],
    );
    let target = ours;
    if (!target && paiseOf(entity.amountPaise)) {
      const waiting = await db.query(
        `SELECT * FROM refunds WHERE tenant_id = $1 AND payment_id = $2 AND gateway_refund_id IS NULL AND method = 'gateway' AND amount_paise = $3 AND (status = 'requested' OR error_code = $4) ORDER BY id`,
        [tenantId(), paymentId, entity.amountPaise, RETRYING],
      );
      if (waiting.length === 1) target = waiting[0];
    }
    if (!target) {
      if (status !== 'processed' || !paiseOf(entity.amountPaise)) return 'unknown_refund';
      return recordOutside(paymentId, entity);
    }
    if (status === 'processed') {
      const before = target.status;
      await db.tx((t) => markProcessed(t, target.id, { gatewayRefundId: entity.id, actor: 'webhook:razorpay' }));
      if (before === 'processed') return 'stale';
      kick();
      return 'processed';
    }
    if (status === 'failed') {
      if (target.status !== 'requested') return 'stale';
      await db.tx((t) => markFailed(t, target.id, 'gateway_failed'));
      return 'processed';
    }
    if (!target.gateway_refund_id) await db.query('UPDATE refunds SET gateway_refund_id = $3 WHERE tenant_id = $1 AND id = $2 AND gateway_refund_id IS NULL', [tenantId(), target.id, entity.id]);
    return 'stale';
  }

  async function recordOutside(paymentId, entity) {
    try {
      await db.tx(async (t) => {
        const [payment] = await t.query('SELECT order_id, mode FROM payments WHERE tenant_id = $1 AND id = $2', [tenantId(), paymentId]);
        await lockOrder(t, payment.order_id);
        const [row] = await t.query(
          `INSERT INTO refunds (tenant_id, order_id, payment_id, amount_paise, method, reason, requested_by, idempotency_key, gateway_refund_id, reversal_status)
           VALUES ($1, $2, $3, $4, 'gateway', 'Refunded at the gateway', 'webhook:razorpay', $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
          [tenantId(), payment.order_id, paymentId, entity.amountPaise, `gw-${entity.id}`.slice(0, 80), entity.id, payment.mode === 'managed' ? 'pending' : 'none'],
        );
        if (row) await markProcessed(t, row.id, { gatewayRefundId: entity.id, actor: 'webhook:razorpay' });
      });
    } catch (err) {
      if (err?.constraint !== 'refunds_within_captured' && err?.constraint !== 'refunds_payment_captured') throw err;
      await writeGap(db, { kind: 'refund_mismatch', ref: `payment:${paymentId}`, details: { gatewayRefund: entity.id, amountPaise: entity.amountPaise } });
      return 'refund_mismatch';
    }
    kick();
    return 'processed';
  }

  /** order.cancelled (9.9, 9.17). */
  async function onCancelled(orderId) {
    const [order] = await db.query('SELECT id, order_number, flow, cancel_reason, paid_paise, refunded_paise FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
    if (!order || order.flow !== 'checkout') return;
    const due = Number(order.paid_paise) - Number(order.refunded_paise);
    if (due <= 0) return;
    if (order.cancel_reason !== 'shopper') {
      await raiseAlert(db, { kind: 'refund.due', severity: 'warning', message: `Order ${order.order_number} was cancelled after it was paid. Refund ${rupees(due)} to the shopper from the order.`, target: `order:${order.id}`, dedupeKey: `refund-due:${order.id}` });
      return;
    }
    // The shopper cancelled before shipment: what they paid online goes back by the way they paid.
    const online = await db.query(`SELECT id, amount_paise FROM payments WHERE tenant_id = $1 AND order_id = $2 AND status = 'captured' AND provider <> 'cod' ORDER BY id`, [tenantId(), order.id]);
    for (const p of online) {
      const [{ used }] = await db.query(`SELECT COALESCE(sum(amount_paise), 0) AS used FROM refunds WHERE tenant_id = $1 AND payment_id = $2 AND (status <> 'failed' OR error_code = $3)`, [tenantId(), p.id, RETRYING]);
      const left = Number(p.amount_paise) - Number(used);
      if (left <= 0) continue;
      try {
        await create(order.id, { amountPaise: left, reason: 'Cancelled by the shopper before shipment', paymentId: Number(p.id), idempotencyKey: `cancel-o${order.id}-p${p.id}`, actor: 'job:refund-on-cancel' });
      } catch (err) {
        // Another refund took what was left in the meantime: nothing more to give back from this payment.
        if (err instanceof ApiError && ['validation_failed', 'conflict'].includes(err.code)) continue;
        throw err;
      }
    }
  }

  /** Refunds whose gateway answer was lost, asked about again with their own key, a few minutes apart. */
  async function sweep({ limit = 100 } = {}) {
    const due = await platformDb.query(
      `SELECT tenant_id, id FROM refunds WHERE method = 'gateway' AND (status = 'requested' OR (status = 'failed' AND error_code = $1))
         AND updated_at < now() - interval '2 minutes' AND created_at > now() - interval '30 days' ORDER BY updated_at LIMIT $2`,
      [RETRYING, limit],
    );
    const results = [];
    for (const { tenant_id: tid, id } of due) {
      try {
        const row = await withTenant(tid, async () => {
          await db.query('UPDATE refunds SET error_code = error_code WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
          return submit(Number(id), 'job:refund-check');
        });
        results.push({ tenantId: tid, refundId: Number(id), status: row?.status ?? null });
      } catch (err) {
        reportError(err, { msg: 'refunds.sweep_failed', tenantId: tid, refundId: Number(id) });
      }
    }
    return results;
  }

  async function forOrder(orderId) {
    const [order] = await db.query('SELECT id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
    if (!order) return null;
    const rows = await db.query('SELECT * FROM refunds WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenantId(), orderId]);
    return { items: rows.map(toRefund) };
  }

  async function get(refundId) {
    const [row] = await db.query('SELECT * FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), refundId]);
    return row ? toRefund(row) : null;
  }

  return { create, createByOwner, retry, submit, applyGatewayRefund, onCancelled, sweep, forOrder, get, markProcessed, markFailed };
}

import { tenantId, withTenant } from '../../tenancy.js';
import { reportError } from '../../platform/log.js';
import { changeOrder, holdOrder } from '../orders/state.js';

/**
 * Stock with reservations (PRD 9.12). Stock is per variant; a product with no options keeps its own (see
 * src/modules/checkout/pricing.js for which row holds it). NULL is unlimited and is never held or counted.
 *
 *   reserve(t, { orderId, items, expiresAt })   holds each line's units inside the order's transaction, or throws OutOfStockError.
 *                                               items: [{ orderItemId, productId, variantId (the row holding stock, or null), qty }]
 *   commit(t, orderId, { actor, events })       paying turns a hold into a sale: stock and reserved both go down.
 *                                               Returns { committed, short, low }; pass `low` to raiseLowStock once committed.
 *   commitLate(t, orderId, ...)                 money arrived after the hold was given back: takes every line from what is on
 *                                               hand now, or none of them. Returns { ok, low }
 *   giveBack(t, orderId, kind, { events })      'cancel' frees a hold or puts sold units back; 'rto' puts returned units back
 *   restockReturn(t, returnId)                  a good return goes back on hand
 *   expireHolds(ctx, { now })                   the job: cancels unpaid orders whose hold ran out and frees their stock (S-39)
 *
 * Every write is a single UPDATE whose WHERE holds the rule (never more held than is on hand), and the database's own
 * checks are the second lock, so two checkouts racing for the last unit cannot both hold it (S-16). Every change to stock
 * on hand writes a stock_movements row whose (reason, ref) is unique, so an event handled twice moves stock once.
 */
export class OutOfStockError extends Error {
  constructor({ productId, variantId = null, available = 0 }) {
    super('Not enough stock');
    this.name = 'OutOfStockError';
    this.code = 'out_of_stock';
    Object.assign(this, { productId, variantId, available });
  }
}

/** The row that holds a line's stock. A reservation's variant_id is that row when it is a variant's. */
const target = (line) => {
  const variantId = line.variant_id ?? line.variantId ?? null;
  return variantId ? { table: 'product_variants', id: variantId } : { table: 'products', id: line.product_id ?? line.productId };
};

/** Units on hand that nobody holds, or null when the item is not counted. */
async function availableOf(t, { table, id }) {
  const [row] = await t.query(`SELECT stock, reserved FROM ${table} WHERE tenant_id = $1 AND id = $2`, [tenantId(), id]);
  if (!row) return 0;
  return row.stock === null ? null : Math.max(0, row.stock - row.reserved);
}

export async function reserve(t, { orderId, items, expiresAt = null }) {
  const tid = tenantId();
  // Always in the same order, so two orders for the same things never wait on each other in a circle.
  const ordered = [...items].sort((a, b) => a.productId - b.productId || (a.variantId ?? 0) - (b.variantId ?? 0));
  for (const item of ordered) {
    const where = target(item);
    const [held] = await t.query(
      `UPDATE ${where.table} SET reserved = reserved + $3 WHERE tenant_id = $1 AND id = $2 AND stock IS NOT NULL AND stock - reserved >= $3 RETURNING id`,
      [tid, where.id, item.qty],
    );
    if (!held) {
      const available = await availableOf(t, where);
      if (available === null) continue; // unlimited: nothing to hold
      throw new OutOfStockError({ productId: item.productId, variantId: item.variantId ?? null, available });
    }
    await t.query(
      `INSERT INTO stock_reservations (tenant_id, order_id, order_item_id, product_id, variant_id, qty, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'held', $7)`,
      [tid, orderId, item.orderItemId, item.productId, item.variantId ?? null, item.qty, expiresAt],
    );
  }
}

const move = (t, row, delta, reason, actor) => t.query(
  `INSERT INTO stock_movements (tenant_id, product_id, variant_id, delta, reason, ref, order_id, actor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   ON CONFLICT (tenant_id, reason, ref) DO NOTHING RETURNING id`,
  [tenantId(), row.product_id, row.variant_id, delta, reason, `order_item:${row.order_item_id}`, row.order_id, actor],
);

const lockReservations = (t, orderId) =>
  t.query('SELECT * FROM stock_reservations WHERE tenant_id = $1 AND order_id = $2 ORDER BY product_id, COALESCE(variant_id, 0), id FOR UPDATE', [tenantId(), orderId]);

const markReservation = (t, id, status) =>
  t.query(`UPDATE stock_reservations SET status = $3, expires_at = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId(), id, status]);

/** Turns an order's holds into sales. A line whose units are no longer there is left alone and `short` is true. */
export async function commit(t, orderId, { actor = 'system', events = null } = {}) {
  const tid = tenantId();
  const rows = await lockReservations(t, orderId);
  let committed = 0;
  let short = false;
  const touched = [];
  for (const row of rows) {
    if (row.status !== 'held') continue;
    const where = target(row);
    const [done] = await t.query(
      `UPDATE ${where.table} SET stock = stock - $3, reserved = reserved - $3 WHERE tenant_id = $1 AND id = $2 AND stock >= $3 AND reserved >= $3
       RETURNING stock, reserved, low_stock_threshold`,
      [tid, where.id, row.qty],
    );
    if (!done) {
      short = true;
      continue;
    }
    await move(t, row, -row.qty, 'sale', actor);
    await markReservation(t, row.id, 'committed');
    committed += 1;
    touched.push({ row, left: done });
  }
  if (committed && events) await events.emit(t, { type: 'stock.committed', orderId, entity: 'stock', entityId: orderId, dedupeKey: `stock.committed:${orderId}` });
  return { committed, short, low: await lowStock(t, touched) };
}

/**
 * The money arrived after the hold ran out and was given back (S-41). Every line is taken from what is on hand now, or none
 * is: the rows are locked first, so what was counted is still there when it is taken.
 */
export async function commitLate(t, orderId, { actor = 'system', events = null } = {}) {
  const tid = tenantId();
  const rows = (await lockReservations(t, orderId)).filter((row) => row.status === 'released');
  const stockRows = [];
  for (const row of rows) {
    const where = target(row);
    const [item] = await t.query(`SELECT stock, reserved FROM ${where.table} WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tid, where.id]);
    if (!item) return { ok: false, low: [] };
    if (item.stock !== null && item.stock - item.reserved < row.qty) return { ok: false, low: [] };
    stockRows.push({ row, where, counted: item.stock !== null });
  }
  const touched = [];
  for (const { row, where, counted } of stockRows) {
    if (counted) {
      const [left] = await t.query(
        `UPDATE ${where.table} SET stock = stock - $3 WHERE tenant_id = $1 AND id = $2 RETURNING stock, reserved, low_stock_threshold`,
        [tid, where.id, row.qty],
      );
      await move(t, row, -row.qty, 'sale', actor);
      touched.push({ row, left });
    }
    await markReservation(t, row.id, 'committed');
  }
  if (stockRows.length && events) await events.emit(t, { type: 'stock.committed', orderId, entity: 'stock', entityId: orderId, dedupeKey: `stock.committed:late:${orderId}` });
  return { ok: true, low: await lowStock(t, touched) };
}

/** The lines now at or below the threshold: the item's own, else the business's (default 3). Read inside the transaction. */
async function lowStock(t, touched) {
  if (!touched.length) return [];
  const [settings] = await t.query('SELECT low_stock_threshold FROM inventory_settings WHERE tenant_id = $1', [tenantId()]);
  const low = [];
  for (const { row, left } of touched) {
    if (left.stock === null) continue;
    const threshold = left.low_stock_threshold ?? settings?.low_stock_threshold ?? 3;
    const available = left.stock - left.reserved;
    if (available > threshold) continue;
    const [product] = await t.query('SELECT name FROM products WHERE tenant_id = $1 AND id = $2', [tenantId(), row.product_id]);
    low.push({ productId: row.product_id, variantId: row.variant_id, available, name: product?.name ?? 'A product' });
  }
  return low;
}

/** Tells the owner, after the sale has committed. Once per item and level: the same alert again does nothing. */
export async function raiseLowStock(alerts, low = []) {
  if (!alerts) return;
  for (const item of low) {
    await alerts.raise({
      kind: 'stock.low',
      severity: item.available <= 0 ? 'critical' : 'warning',
      message: item.available <= 0 ? `${item.name} is sold out.` : `${item.name} is running low: ${item.available} left.`,
      target: `product:${item.productId}`,
      dedupeKey: `stock.low:${item.productId}:${item.variantId ?? 0}:${item.available}`,
    }).catch((err) => reportError(err, { msg: 'inventory.low_stock_alert_failed', productId: item.productId }));
  }
}

/**
 * Gives an order's stock back. kind 'cancel': a hold is freed, sold units go back on hand. kind 'rto': the parcel came back, so
 * sold units go back on hand. Doing it twice changes nothing.
 */
export async function giveBack(t, orderId, kind = 'cancel', { actor = 'system', events = null } = {}) {
  const tid = tenantId();
  const rows = await lockReservations(t, orderId);
  let returned = 0;
  for (const row of rows) {
    const where = target(row);
    if (row.status === 'held') {
      await t.query(`UPDATE ${where.table} SET reserved = GREATEST(reserved - $3, 0) WHERE tenant_id = $1 AND id = $2`, [tid, where.id, row.qty]);
      await markReservation(t, row.id, 'released');
      returned += 1;
    } else if (row.status === 'committed') {
      const [moved] = await move(t, row, row.qty, kind === 'rto' ? 'rto' : 'cancel', actor);
      if (moved) await t.query(`UPDATE ${where.table} SET stock = stock + $3 WHERE tenant_id = $1 AND id = $2 AND stock IS NOT NULL`, [tid, where.id, row.qty]);
      await markReservation(t, row.id, kind === 'rto' ? 'restocked' : 'released');
      returned += 1;
    }
  }
  if (returned && events) {
    const type = kind === 'rto' ? 'stock.restocked' : 'stock.released';
    await events.emit(t, { type, orderId, entity: 'stock', entityId: orderId, dedupeKey: `${type}:${orderId}` });
  }
  return { returned };
}

/** A good return goes back on hand (S-58): each returned line once, by the return's own line id. */
export async function restockReturn(t, returnId, { actor = 'system', events = null } = {}) {
  const tid = tenantId();
  const [ret] = await t.query('SELECT id, order_id, condition FROM returns WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, returnId]);
  if (!ret || ret.condition !== 'good') return { restocked: 0 };
  const lines = await t.query(
    `SELECT ri.id, ri.qty, oi.product_id, r.variant_id
     FROM return_items ri JOIN order_items oi ON oi.tenant_id = ri.tenant_id AND oi.id = ri.order_item_id
     LEFT JOIN stock_reservations r ON r.tenant_id = oi.tenant_id AND r.order_item_id = oi.id
     WHERE ri.tenant_id = $1 AND ri.return_id = $2 AND oi.product_id IS NOT NULL ORDER BY ri.id`,
    [tid, returnId],
  );
  let restocked = 0;
  for (const line of lines) {
    const where = target(line);
    const [moved] = await t.query(
      `INSERT INTO stock_movements (tenant_id, product_id, variant_id, delta, reason, ref, order_id, actor) VALUES ($1, $2, $3, $4, 'return', $5, $6, $7)
       ON CONFLICT (tenant_id, reason, ref) DO NOTHING RETURNING id`,
      [tid, line.product_id, line.variant_id, line.qty, `return_item:${line.id}`, ret.order_id, actor],
    );
    if (!moved) continue;
    await t.query(`UPDATE ${where.table} SET stock = stock + $3 WHERE tenant_id = $1 AND id = $2 AND stock IS NOT NULL`, [tid, where.id, line.qty]);
    restocked += 1;
  }
  if (restocked) {
    await t.query('UPDATE returns SET restocked = true WHERE tenant_id = $1 AND id = $2', [tid, returnId]);
    if (events) await events.emit(t, { type: 'stock.restocked', orderId: ret.order_id, entity: 'stock', entityId: ret.order_id, dedupeKey: `stock.restocked:return:${returnId}` });
  }
  return { restocked };
}

/**
 * The hold-expiry job (S-39, S-68): an order still unpaid when its hold runs out is cancelled with reason hold_expired and its
 * stock comes back, in one transaction per order. The scan crosses businesses; each order is then worked as its own business.
 * A failure on one order is reported and the rest still run.
 */
export async function expireHolds({ db, orderEvents = null }, { now = new Date(), limit = 200 } = {}) {
  const due = await (db.platform ?? db).query(
    `SELECT tenant_id, id FROM orders WHERE flow = 'checkout' AND fulfilment_status = 'pending' AND hold_expires_at IS NOT NULL AND hold_expires_at <= $1
     ORDER BY hold_expires_at, id LIMIT $2`,
    [now, limit],
  );
  let cancelled = 0;
  for (const row of due) {
    try {
      await withTenant(row.tenant_id, () => db.tx(async (t) => {
        const [order] = await t.query('SELECT payment_status FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), row.id]);
        if (order?.payment_status !== 'unpaid') return; // the money arrived while this ran
        const result = await changeOrder(t, row.id, { fulfilment: 'cancelled', cancelReason: 'hold_expired', actor: 'job:hold-expiry', reason: 'Payment not received in time', ifAllowed: true });
        if (!result.changed.fulfilment) return;
        await giveBack(t, row.id, 'cancel', { actor: 'job:hold-expiry', events: orderEvents });
        cancelled += 1;
      }));
    } catch (err) {
      reportError(err, { msg: 'inventory.hold_expiry_failed', orderId: row.id });
    }
  }
  if (cancelled) orderEvents?.kick();
  return { due: due.length, cancelled };
}

/** What the listeners do, each in its own transaction as the event's business. */
export function stockListeners({ db, repos }) {
  return {
    /**
     * order.paid, order.advance_paid, order.cod_confirmed: a hold becomes a sale. Money that arrived after the hold ran out
     * brings the order back when every line is still there, and otherwise holds it as "Paid, out of stock" for the owner (S-41).
     */
    async commit(event, ctx) {
      const events = ctx?.orderEvents ?? null;
      const low = await db.tx(async (t) => {
        const [order] = await t.query('SELECT id, flow, fulfilment_status, payment_status, cancel_reason FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), event.orderId]);
        if (!order || order.flow !== 'checkout') return [];
        if (order.fulfilment_status === 'cancelled') {
          const late = order.cancel_reason === 'hold_expired' && ['paid', 'advance_paid'].includes(order.payment_status);
          if (!late) return []; // cancelled for another reason: the money is refunded, not the order revived
          const taken = await commitLate(t, order.id, { events });
          if (taken.ok) {
            await changeOrder(t, order.id, { fulfilment: 'new', actor: 'system', reason: 'Paid after the hold ran out; the stock was still there', ifAllowed: true });
            return taken.low;
          }
          await holdOrder(t, order.id, 'paid_out_of_stock', { actor: 'system', reason: 'Paid after the hold ran out and the stock is gone' });
          return [];
        }
        if (['rto_initiated', 'rto_delivered'].includes(order.fulfilment_status)) return [];
        const result = await commit(t, order.id, { events });
        // The payment itself may have brought back an order whose hold had just run out (cancelled -> new under the
        // late_payment guard): its lines were given back, so they are taken again from what is on hand, or the order waits.
        const late = await commitLate(t, order.id, { events });
        if (result.short || !late.ok) await holdOrder(t, order.id, 'paid_out_of_stock', { actor: 'system', reason: 'Paid, and the stock is no longer there' });
        return [...result.low, ...late.low];
      });
      await raiseLowStock(repos?.alerts, low);
    },
    /** order.cancelled and order.rto_delivered. */
    async giveBack(event, ctx) {
      await db.tx((t) => giveBack(t, event.orderId, event.type === 'order.rto_delivered' ? 'rto' : 'cancel', { events: ctx?.orderEvents ?? null }));
    },
    /** return.received. */
    async returned(event, ctx) {
      await db.tx((t) => restockReturn(t, event.entityId, { events: ctx?.orderEvents ?? null }));
    },
  };
}

import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { alertsRepo } from '../alerts/index.js';
import { writeAudit } from '../audit/index.js';
import { restockReturn } from '../inventory/stock.js';
import { changeRow } from '../orders/state.js';
import { returnForRefund } from './links.js';
import { bookPickup, reverseShipment } from './pickup.js';
import { ProofError, prepareProofs, proofKey, proofUrl } from './proofs.js';

/**
 * Returns (PRD 9.17), for one process's ctx.
 *
 *   settings.get() / settings.update(patch, actor)   on or off, the window in days after delivery, eligible categories, proof
 *   options(order)                       what of an order can be returned now: { ok, reason, message, lines }
 *   request({ order, shopper, fields, files })   the shopper's request, with its proof: one transaction, files in storage
 *   list(query) / get(id)                the console's, with short-lived proof links
 *   approve(id, user)                    requested -> approved, and the reverse pickup on the forward courier mode
 *   decline(id, note, user)              requested -> rejected, with the reason for the shopper
 *   receive(id, condition, user)         -> received; 'good' goes back into stock once, 'not_restockable' never (S-58)
 *   close(id, { resolution, refundPaise }, user)   received -> refunded (its refund processed) or exchanged
 *   onEvent(event)                       shipment.* of the reverse parcel moves the return; refund.* links and closes it
 *   closeWindows()                       the job: order.return_window_closed for each delivered order whose window has passed
 *
 * Every status change goes through src/modules/orders/state.js (changeRow), so the database writes its event and refuses a
 * move that isn't in TRANSITIONS. The refund itself is always the owner's (refunds.create with returnId, after a fresh
 * password): this module never starts one, it links it and closes the return when it is processed.
 */
export const OPEN_STATUSES = Object.freeze(['requested', 'approved', 'pickup_scheduled', 'picked_up', 'received']);
const DONE_FOR_QTY = ['rejected', 'cancelled'];
const SETTINGS_DEFAULTS = Object.freeze({ enabled: false, window_days: 7, eligible_category_ids: [], proof: 'either' });
const RECEIVABLE = ['approved', 'pickup_scheduled', 'picked_up'];

const toSettings = (row) => ({ enabled: row.enabled, windowDays: row.window_days, eligibleCategoryIds: (row.eligible_category_ids ?? []).map(Number), proof: row.proof });

const MESSAGES = Object.freeze({
  off: 'Returns aren’t offered by this store.',
  not_delivered: 'You can ask for a return once your order has been delivered.',
  window_closed: 'The return window for this order has closed.',
  nothing: 'Nothing in this order can be returned.',
});

const conflict = (message) => new ApiError('conflict', message);
const invalid = (message, field) => new ApiError('validation_failed', message, field ? { fields: { [field]: message } } : {});

export function createReturns(ctx) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;
  const secret = ctx.config?.sessionSecret || ctx.config?.dataKey || crypto.randomBytes(32).toString('hex');
  const kick = () => ctx.orderEvents?.kick?.();

  async function readSettings(q = db) {
    const [row] = await q.query('SELECT * FROM return_settings WHERE tenant_id = $1', [tenantId()]);
    return row ?? { ...SETTINGS_DEFAULTS };
  }

  const entitled = async () => {
    try {
      return Boolean(await ctx.repos.entitlements.can('store.returns'));
    } catch {
      return false;
    }
  };

  const settings = {
    get: async () => toSettings(await readSettings()),
    async update(patch, actor) {
      const current = await readSettings();
      const next = {
        enabled: patch.enabled ?? current.enabled,
        window_days: patch.windowDays ?? current.window_days,
        eligible_category_ids: patch.eligibleCategoryIds ?? (current.eligible_category_ids ?? []).map(Number),
        proof: patch.proof ?? current.proof,
      };
      if (next.enabled && !current.enabled && !(await entitled())) throw new ApiError('forbidden', 'Returns aren’t part of your plan.');
      const ids = [...new Set(next.eligible_category_ids.map(Number))];
      if (ids.length) {
        // Only this business's own categories: another business's id is refused, never stored.
        const found = await db.query('SELECT id FROM categories WHERE tenant_id = $1 AND id = ANY($2::int[])', [tenantId(), ids]);
        if (found.length !== ids.length) throw invalid('Pick categories from your own store.', 'eligibleCategoryIds');
      }
      const row = await db.tx(async (t) => {
        const [saved] = await t.query(
          `INSERT INTO return_settings (tenant_id, enabled, window_days, eligible_category_ids, proof, updated_at) VALUES ($1, $2, $3, $4::int[], $5, now())
           ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, window_days = EXCLUDED.window_days,
             eligible_category_ids = EXCLUDED.eligible_category_ids, proof = EXCLUDED.proof, updated_at = now()
           RETURNING *`,
          [tenantId(), next.enabled, next.window_days, ids, next.proof],
        );
        await writeAudit(t, { actor, action: 'return_settings.update', target: 'return_settings', details: { enabled: saved.enabled, windowDays: saved.window_days, categories: ids.length, proof: saved.proof } });
        return saved;
      });
      return toSettings(row);
    },
  };

  /**
   * What of `order` can be returned now, judged on `q` (the db, or the request's transaction with the order locked).
   * `plan` is whether the plan has returns, when already asked: the entitlements repo reads on its own connection, so it is
   * never asked inside a transaction.
   */
  async function options(order, q = db, plan = null) {
    const s = await readSettings(q);
    const fail = (reason) => ({ ok: false, reason, message: MESSAGES[reason], lines: [], settings: s });
    if (!s.enabled || order.flow !== 'checkout' || !(plan ?? (await entitled()))) return fail('off');
    if (order.fulfilment_status !== 'delivered') return fail('not_delivered');
    // The window is counted on the database's clock from the moment it was delivered (S-57).
    const [{ open }] = await q.query(
      `SELECT (delivered_at IS NOT NULL AND now() <= delivered_at + make_interval(days => $3)) AS open FROM orders WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), order.id, s.window_days],
    );
    if (!open) return fail('window_closed');
    const categories = (s.eligible_category_ids ?? []).map(Number);
    const lines = await q.query(
      `SELECT oi.id, oi.name, oi.option_value, oi.image, oi.qty, oi.price_paise, oi.product_id,
         COALESCE((SELECT sum(ri.qty) FROM return_items ri JOIN returns r ON r.tenant_id = ri.tenant_id AND r.id = ri.return_id
                   WHERE ri.tenant_id = oi.tenant_id AND ri.order_item_id = oi.id AND r.status <> ALL($3::text[])), 0)::int AS returned,
         (cardinality($4::int[]) = 0 OR EXISTS (SELECT 1 FROM product_categories pc WHERE pc.tenant_id = oi.tenant_id AND pc.product_id = oi.product_id AND pc.category_id = ANY($4::int[]))) AS eligible
       FROM order_items oi WHERE oi.tenant_id = $1 AND oi.order_id = $2 ORDER BY oi.id`,
      [tenantId(), order.id, DONE_FOR_QTY, categories],
    );
    const shaped = lines.map((l) => ({ ...l, left: l.eligible ? Math.max(0, l.qty - l.returned) : 0 }));
    if (!shaped.some((l) => l.left > 0)) return { ...fail('nothing'), lines: shaped };
    return { ok: true, reason: 'ok', message: '', lines: shaped, settings: s };
  }

  /** The shopper's request (S-57, S-80). `fields` are the form's text fields, `files` multer's. */
  async function request({ order: found, shopper, fields, files }) {
    const items = parseItems(fields.items);
    const resolution = fields.resolution === undefined || fields.resolution === '' ? 'refund' : fields.resolution;
    if (!['refund', 'exchange'].includes(resolution)) throw invalid('Choose a refund or an exchange.', 'resolution');
    const reason = String(fields.reason ?? '').trim();
    if (reason.length > 500) throw invalid('Use 500 characters or fewer.', 'reason');
    if (/\0/.test(reason)) throw invalid('Contains a character that isn’t allowed.', 'reason');

    const first = await options(found);
    if (!first.ok) throw conflict(first.message);
    checkLines(items, first.lines);
    let proofs;
    try {
      proofs = await prepareProofs(files, first.settings.proof, ctx.platform.images);
    } catch (err) {
      if (err instanceof ProofError) throw new ApiError(err.status === 413 ? 'payload_too_large' : 'validation_failed', err.message, { fields: { proof: err.message } });
      throw err;
    }

    const stored = [];
    try {
      const made = await db.tx(async (t) => {
        const [order] = await t.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), found.id]);
        // Again with the order locked, so two requests at once can't both take the last unit.
        const now = await options(order, t, true);
        if (!now.ok) throw conflict(now.message);
        checkLines(items, now.lines);
        const [ret] = await t.query(
          `INSERT INTO returns (tenant_id, order_id, shopper_id, resolution, reason) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [tenantId(), order.id, shopper.id, resolution, reason],
        );
        for (const item of items) {
          await t.query('INSERT INTO return_items (tenant_id, return_id, order_item_id, qty) VALUES ($1, $2, $3, $4)', [tenantId(), ret.id, item.orderItemId, item.qty]);
        }
        for (const proof of proofs) {
          const key = proofKey(proof.contentType);
          await ctx.platform.storage.put(key, proof.buffer, proof.contentType);
          stored.push(key);
          await t.query(
            'INSERT INTO return_proofs (tenant_id, return_id, kind, file_key, content_type, bytes) VALUES ($1, $2, $3, $4, $5, $6)',
            [tenantId(), ret.id, proof.kind, key, proof.contentType, proof.buffer.length],
          );
        }
        await alertsRepo(t).raise({ kind: 'return.requested', message: `Order ${order.order_number} has a new return request. Check the photos and approve or decline it.`, target: `order:${order.id}`, dedupeKey: `return-requested:${ret.id}` });
        return { ret, order };
      });
      kick();
      log.info('returns.requested', { returnId: Number(made.ret.id), orderId: made.order.id, lines: items.length, proofs: proofs.length });
      return {
        id: Number(made.ret.id),
        status: made.ret.status,
        orderNumber: made.order.order_number,
        items: items.map((i) => ({ orderItemId: i.orderItemId, name: first.lines.find((l) => l.id === i.orderItemId)?.name ?? '', qty: i.qty })),
      };
    } catch (err) {
      for (const key of stored) await ctx.platform.storage.remove(key).catch(() => {});
      throw err;
    }
  }

  async function shaped(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [items, proofs] = await Promise.all([
      db.query(
        `SELECT ri.return_id, ri.order_item_id, ri.qty, oi.name, oi.option_value FROM return_items ri
         JOIN order_items oi ON oi.tenant_id = ri.tenant_id AND oi.id = ri.order_item_id
         WHERE ri.tenant_id = $1 AND ri.return_id = ANY($2::bigint[]) ORDER BY ri.id`,
        [tenantId(), ids],
      ),
      db.query('SELECT id, return_id, kind FROM return_proofs WHERE tenant_id = $1 AND return_id = ANY($2::bigint[]) ORDER BY id', [tenantId(), ids]),
    ]);
    return rows.map((r) => ({
      id: Number(r.id),
      orderId: r.order_id,
      orderNumber: r.order_number,
      status: r.status,
      resolution: r.resolution,
      reason: r.reason,
      condition: r.condition,
      restocked: r.restocked,
      items: items.filter((i) => String(i.return_id) === String(r.id)).map((i) => ({ orderItemId: i.order_item_id, name: [i.name, i.option_value].filter(Boolean).join(' - '), qty: i.qty })),
      proofs: proofs.filter((p) => String(p.return_id) === String(r.id)).map((p) => ({ id: Number(p.id), kind: p.kind, fileUrl: proofUrl(secret, p.id) })),
      shipmentId: r.shipment_id === null ? null : Number(r.shipment_id),
      refundId: r.refund_id === null ? null : Number(r.refund_id),
      createdAt: r.created_at,
    }));
  }

  const SELECT = 'SELECT r.*, o.order_number FROM returns r JOIN orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id';

  async function list({ cursor, limit = 25, status } = {}) {
    const after = cursor && /^\d{1,19}$/.test(cursor) ? cursor : null;
    const rows = await db.query(
      `${SELECT} WHERE r.tenant_id = $1 AND ($2::text IS NULL OR r.status = $2) AND ($3::bigint IS NULL OR r.id < $3::bigint) ORDER BY r.id DESC LIMIT $4`,
      [tenantId(), status ?? null, after, limit + 1],
    );
    const items = await shaped(rows.slice(0, limit));
    return { items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null };
  }

  async function rowOf(id, q = db, lock = false) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const [row] = await q.query(`${SELECT} WHERE r.tenant_id = $1 AND r.id = $2${lock ? ' FOR UPDATE OF r' : ''}`, [tenantId(), n]);
    return row ?? null;
  }

  async function get(id) {
    const row = await rowOf(id);
    return row ? (await shaped([row]))[0] : null;
  }

  /** Runs `work(t, ret)` with the return locked; null when there is no such return here. */
  async function withReturn(id, work) {
    return db.tx(async (t) => {
      const ret = await rowOf(id, t, true);
      if (!ret) return null;
      return work(t, ret);
    });
  }

  async function approve(id, user) {
    const actor = `user:${user.id}`;
    const ready = await withReturn(id, async (t, ret) => {
      if (ret.status === 'requested') {
        const [order] = await t.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), ret.order_id]);
        const shipment = await reverseShipment(t, { ret, order });
        await changeRow(t, 'returns', ret.id, 'approved', { set: { decided_by: actor, shipment_id: shipment.id, updated_at: new Date() } });
        await writeAudit(t, { actor, action: 'return.approve', target: `order:${ret.order_id}`, details: { returnId: Number(ret.id), shipmentId: Number(shipment.id) } });
        return { ret, shipmentId: shipment.id };
      }
      // Approving again retries a pickup the courier didn't take.
      if (ret.status === 'approved' && ret.shipment_id) return { ret, shipmentId: ret.shipment_id };
      throw conflict(ret.status === 'rejected' ? 'This return was declined.' : 'This return was already approved.');
    });
    if (!ready) return null;
    kick();
    const booking = await bookPickup(ctx, ready.shipmentId, ready.ret);
    if (!booking.booked) {
      await alertsRepo(db).raise({
        kind: 'return.pickup_failed', severity: 'warning', target: `order:${ready.ret.order_id}`, dedupeKey: `return-pickup:${ready.ret.id}:${Math.floor(Date.now() / 3_600_000)}`,
        message: `The pickup for the return on order ${ready.ret.order_number} couldn’t be booked with the courier. Approve it again to retry, or arrange the pickup yourself.`,
      });
    }
    return get(id);
  }

  async function decline(id, note, user) {
    const actor = `user:${user.id}`;
    const done = await withReturn(id, async (t, ret) => {
      if (ret.status !== 'requested') throw conflict(ret.status === 'rejected' ? 'This return was already declined.' : 'Only a new request can be declined.');
      await changeRow(t, 'returns', ret.id, 'rejected', { set: { decided_by: actor, decline_note: note, updated_at: new Date() } });
      await writeAudit(t, { actor, action: 'return.decline', target: `order:${ret.order_id}`, details: { returnId: Number(ret.id) } });
      return true;
    });
    if (!done) return null;
    kick();
    return get(id);
  }

  /** received, and refunded at once when its refund was already processed. Inside `t`, with the return locked. */
  async function closeIfRefunded(t, ret) {
    const [now] = await t.query('SELECT status, refund_id FROM returns WHERE tenant_id = $1 AND id = $2', [tenantId(), ret.id]);
    if (now.status !== 'received' || !now.refund_id) return false;
    const [refund] = await t.query('SELECT status FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), now.refund_id]);
    if (refund?.status !== 'processed') return false;
    await changeRow(t, 'returns', ret.id, 'refunded', { ifAllowed: true, set: { resolution: 'refund', updated_at: new Date() } });
    return true;
  }

  async function receive(id, condition, user) {
    const actor = `user:${user.id}`;
    const done = await withReturn(id, async (t, ret) => {
      if (ret.condition) throw conflict('This return was already received and checked.');
      if (!(RECEIVABLE.includes(ret.status) || ret.status === 'received')) {
        throw conflict(ret.status === 'requested' ? 'Approve the return before marking it received.' : 'This return can’t be received now.');
      }
      await changeRow(t, 'returns', ret.id, 'received', { set: { condition, updated_at: new Date() } });
      // Only "received in good condition" goes back into stock, once (stock_movements is unique per returned line).
      const stock = condition === 'good' ? await restockReturn(t, ret.id, { actor, events: ctx.orderEvents ?? null }) : { restocked: 0 };
      await writeAudit(t, { actor, action: 'return.receive', target: `order:${ret.order_id}`, details: { returnId: Number(ret.id), condition, restockedLines: stock.restocked } });
      await closeIfRefunded(t, ret);
      return true;
    });
    if (!done) return null;
    kick();
    return get(id);
  }

  async function close(id, { resolution, refundPaise }, user) {
    const actor = `user:${user.id}`;
    const done = await withReturn(id, async (t, ret) => {
      if (ret.status === 'refunded' || ret.status === 'exchanged') {
        if (ret.status === (resolution === 'refund' ? 'refunded' : 'exchanged')) return true;
        throw conflict('This return is already closed.');
      }
      if (ret.status !== 'received') throw conflict('Mark the item received before closing the return.');
      if (resolution === 'exchange') {
        await changeRow(t, 'returns', ret.id, 'exchanged', { set: { resolution: 'exchange', updated_at: new Date() } });
      } else {
        let refundId = ret.refund_id;
        if (!refundId) {
          // A refund the owner made from the order, without naming the return: the one processed refund of that amount
          // that no other return claims.
          const candidates = await t.query(
            `SELECT f.id FROM refunds f WHERE f.tenant_id = $1 AND f.order_id = $2 AND f.status = 'processed' AND ($3::bigint IS NULL OR f.amount_paise = $3::bigint)
               AND NOT EXISTS (SELECT 1 FROM returns x WHERE x.tenant_id = f.tenant_id AND x.refund_id = f.id)`,
            [tenantId(), ret.order_id, refundPaise ?? null],
          );
          if (candidates.length !== 1) throw conflict('Refund the shopper from the order first, naming this return. The return closes when the refund goes through.');
          refundId = candidates[0].id;
          await t.query('UPDATE returns SET refund_id = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), ret.id, refundId]);
        }
        const [refund] = await t.query('SELECT status, amount_paise FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), refundId]);
        if (refund?.status !== 'processed') throw conflict('The refund for this return hasn’t gone through yet. It closes by itself when it does.');
        if (refundPaise !== undefined && Number(refund.amount_paise) !== refundPaise) throw conflict('That isn’t the amount refunded for this return.');
        await changeRow(t, 'returns', ret.id, 'refunded', { set: { resolution: 'refund', updated_at: new Date() } });
      }
      await writeAudit(t, { actor, action: 'return.close', target: `order:${ret.order_id}`, details: { returnId: Number(ret.id), resolution } });
      return true;
    });
    if (!done) return null;
    kick();
    return get(id);
  }

  /** shipment.* of a reverse parcel, and refund.*. Safe to hear twice and late: every move is ifAllowed. */
  async function onEvent(event) {
    if (event.entity === 'shipment') return onShipment(event);
    if (event.entity === 'refund') return onRefund(event);
    return null;
  }

  async function onShipment(event) {
    const to = event.to;
    const result = await db.tx(async (t) => {
      const [ret] = await t.query(`${SELECT} WHERE r.tenant_id = $1 AND r.shipment_id = $2 FOR UPDATE OF r`, [tenantId(), event.entityId]);
      if (!ret) return null;
      if (to === 'pickup_scheduled') {
        await changeRow(t, 'returns', ret.id, 'pickup_scheduled', { ifAllowed: true });
      } else if (['picked_up', 'in_transit', 'out_for_delivery', 'undelivered'].includes(to)) {
        if (ret.status === 'approved') await changeRow(t, 'returns', ret.id, 'pickup_scheduled', { ifAllowed: true });
        await changeRow(t, 'returns', ret.id, 'picked_up', { ifAllowed: true });
      } else if (to === 'delivered') {
        // Back with the seller: received, waiting for the seller to check it and say whether it can be sold again.
        const moved = await changeRow(t, 'returns', ret.id, 'received', { ifAllowed: true, set: { updated_at: new Date() } });
        if (moved.changed) {
          await alertsRepo(t).raise({ kind: 'return.arrived', target: `order:${ret.order_id}`, dedupeKey: `return-arrived:${ret.id}`, message: `The return on order ${ret.order_number} is back with you. Check it and mark whether it can be sold again.` });
        }
      } else if (['cancelled', 'lost', 'rto_initiated'].includes(to) && OPEN_STATUSES.includes(ret.status) && ret.status !== 'received') {
        await alertsRepo(t).raise({ kind: 'return.pickup_problem', severity: 'warning', target: `order:${ret.order_id}`, dedupeKey: `return-pickup-${to}:${ret.id}`, message: `The courier reports the return pickup on order ${ret.order_number} as ${to.replace(/_/g, ' ')}. Check with the courier or arrange it again.` });
      }
      return true;
    });
    if (result) kick();
    return result;
  }

  async function onRefund(event) {
    const result = await db.tx(async (t) => {
      const [refund] = await t.query('SELECT id, order_id, status, created_at FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), event.entityId]);
      if (!refund) return null;
      const found = await returnForRefund(t, refund);
      if (!found) return null;
      const [ret] = await t.query(`${SELECT} WHERE r.tenant_id = $1 AND r.id = $2 FOR UPDATE OF r`, [tenantId(), found.id]);
      if (ret.refund_id === null || Number(ret.refund_id) !== Number(refund.id)) {
        await t.query('UPDATE returns SET refund_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), ret.id, refund.id]);
      }
      const closed = refund.status === 'processed' ? await closeIfRefunded(t, ret) : false;
      return { returnId: Number(ret.id), closed };
    });
    if (result?.closed) {
      log.info('returns.refunded', { returnId: result.returnId, refundId: Number(event.entityId), orderId: event.orderId });
      kick();
    }
    return result;
  }

  /**
   * The return window closing (9.21 posts loyalty points then): one order.return_window_closed per delivered order, once,
   * across businesses. A business with returns off has no window, so it closes on delivery.
   */
  async function closeWindows({ limit = 500 } = {}) {
    const due = await platformDb.query(
      `SELECT o.tenant_id, o.id FROM orders o LEFT JOIN return_settings s ON s.tenant_id = o.tenant_id
       WHERE o.flow = 'checkout' AND o.fulfilment_status = 'delivered' AND o.delivered_at IS NOT NULL
         AND o.delivered_at + make_interval(days => CASE WHEN s.enabled THEN s.window_days ELSE 0 END) < now()
         AND o.delivered_at > now() - interval '120 days'
         AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.tenant_id = o.tenant_id AND e.dedupe_key = 'order.return_window_closed:' || o.id)
       ORDER BY o.delivered_at LIMIT $1`,
      [limit],
    );
    let emitted = 0;
    for (const row of due) {
      await withTenant(row.tenant_id, () => db.tx(async (t) => {
        await ctx.orderEvents.emit(t, { type: 'order.return_window_closed', orderId: row.id, entity: 'order', entityId: row.id, dedupeKey: `order.return_window_closed:${row.id}` });
      }));
      emitted += 1;
    }
    if (emitted) kick();
    return emitted;
  }

  return { settings, options, request, list, get, approve, decline, receive, close, onEvent, closeWindows, secret };
}

/** The form's `items`: JSON of [{ orderItemId, qty }], one entry per line. */
export function parseItems(value) {
  let list;
  try {
    list = typeof value === 'string' && value.length <= 4000 ? JSON.parse(value) : null;
  } catch {
    list = null;
  }
  const bad = () => invalid('Choose what you are returning.', 'items');
  if (!Array.isArray(list) || !list.length || list.length > 50) throw bad();
  const seen = new Set();
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw bad();
    const keys = Object.keys(entry);
    if (keys.some((k) => k !== 'orderItemId' && k !== 'qty')) throw bad();
    const orderItemId = entry.orderItemId;
    const qty = entry.qty;
    if (!Number.isInteger(orderItemId) || orderItemId <= 0 || orderItemId > 2147483647) throw bad();
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1000) throw invalid('Choose how many you are returning.', 'items');
    if (seen.has(orderItemId)) throw bad();
    seen.add(orderItemId);
    return { orderItemId, qty };
  });
}

/** Each asked-for line is in the order, can be returned, and no more than is left of it. */
function checkLines(items, lines) {
  for (const item of items) {
    const line = lines.find((l) => l.id === item.orderItemId);
    if (!line) throw invalid('That item isn’t part of this order.', 'items');
    if (!line.eligible) throw conflict(`${line.name} can’t be returned.`);
    if (item.qty > line.left) throw invalid(line.left ? `You can return at most ${line.left} of ${line.name}.` : `${line.name} has already been returned.`, 'items');
  }
}

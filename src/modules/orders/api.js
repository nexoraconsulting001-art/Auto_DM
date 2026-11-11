import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/errors.js';
import { STATUS_LABELS, canCancelBeforeShipment, nextStatuses } from '../../contracts/orders.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { readCursor, writeCursor } from '../admin-api/paging.js';
import { commitLate } from '../inventory/stock.js';
import { cancelOrder, refundDue } from './cancel.js';
import { OrderStateError, addOrderNote, changeOrder, releaseOrder } from './state.js';

/**
 * The console's orders (PRD 9.9), for this business only: the list with its filters, one order, its timeline, the moves a
 * seller makes by hand (pack, ship, deliver, cancel before shipment, release a hold, bring back a late-paid order), notes,
 * and orders as a CSV file. Every move goes through the state machine (state.js), so "new" can't jump to "delivered" (S-30)
 * and the console and the app read the same status and timeline (S-32). orders.list, .get and .setStatus replace admin-api's
 * Phase 0 handlers through takesOver, with the Phase 4 fields filled in; setStatus stays for Phase 0 orders only.
 */
const HAND_MOVES = Object.freeze(['packed', 'shipped', 'delivered']);
const money = (v) => (v === null || v === undefined ? 0 : Number(v));

export function toOrder(o) {
  const checkout = o.flow === 'checkout';
  return {
    id: o.id, orderNumber: o.order_number, status: o.status, customerName: o.customer_name, phone: o.phone, email: o.email, address: o.address, city: o.city,
    state: o.state, pincode: o.pincode, subtotalPaise: money(o.subtotal_paise), shippingPaise: money(o.shipping_paise), totalPaise: money(o.total_paise),
    reelId: o.reel_id, source: o.source, notes: o.notes, createdAt: o.created_at, updatedAt: o.updated_at,
    flow: o.flow, fulfilmentStatus: o.fulfilment_status, paymentStatus: o.payment_status, paymentMode: o.payment_mode, holdReason: o.hold_reason, cancelReason: o.cancel_reason,
    discountPaise: money(o.discount_paise), loyaltyPaise: money(o.loyalty_paise), codFeePaise: money(o.cod_fee_paise), taxPaise: money(o.tax_paise),
    advancePaise: money(o.advance_paise), balancePaise: money(o.balance_paise), paidPaise: money(o.paid_paise), refundedPaise: money(o.refunded_paise),
    couponCode: o.coupon_code ?? '', codRisk: o.cod_risk, gatewayMode: o.gateway_mode,
    nextFulfilment: checkout && !o.hold_reason ? nextStatuses('fulfilment', o.fulfilment_status).filter((s) => HAND_MOVES.includes(s)) : [],
    canCancel: checkout && canCancelBeforeShipment(o),
    refundDuePaise: refundDue(o),
    confirmedAt: o.confirmed_at, shippedAt: o.shipped_at, deliveredAt: o.delivered_at, cancelledAt: o.cancelled_at,
  };
}

const toItem = (i) => ({
  id: i.id, productId: i.product_id, name: i.name, image: i.image, pricePaise: money(i.price_paise), option: i.option_value, qty: i.qty,
  variantId: i.variant_id ?? null, sku: i.sku ?? '', hsnCode: i.hsn_code ?? '', gstRateBp: i.gst_rate_bp ?? 0, discountPaise: money(i.discount_paise), taxPaise: money(i.tax_paise),
});

/** Who changed something, as a role: never a shopper's or a team member's name (9.9). */
function actorLabel(actor, roles) {
  const [kind, id] = String(actor).split(':');
  if (kind === 'user') return { owner: 'Owner', manager: 'Manager', staff: 'Staff' }[roles.get(Number(id))] ?? 'Team';
  if (kind === 'shopper') return 'Customer';
  if (kind === 'webhook') return id === 'razorpay' || id === 'cashfree' ? 'Payment gateway' : id === 'shopify' ? 'Shopify' : 'Courier';
  return 'System';
}

const toEntry = (row, roles) => ({
  id: Number(row.id), kind: row.machine, from: row.from_status, to: row.to_status, actor: actorLabel(row.actor, roles), reason: row.reason, note: row.note, at: row.created_at,
});

/** A refusal from the state machine, in the seller's words. */
function refused(err) {
  if (!(err instanceof OrderStateError)) return err;
  if (err.code === 'not_found') return new ApiError('not_found', 'We couldn’t find that order.');
  if (err.code === 'manual_order') return new ApiError('conflict', 'This order was placed before checkout. Change its status instead.');
  if (err.code === 'checkout_order') return new ApiError('conflict', 'This order moves through its own steps: pack, ship, deliver or cancel.');
  if (err.code === 'invalid') return new ApiError('validation_failed', err.message);
  const label = (s) => STATUS_LABELS.fulfilment[s] ?? s;
  if (err.from && err.to && err.machine === 'fulfilment') return new ApiError('conflict', `An order can’t go from ${label(err.from)} to ${label(err.to)}.`);
  return new ApiError('conflict', err.message);
}

/** The dates of a filter as moments in India: from the start of `from` to the end of `to`. */
const dayStart = (date) => (date ? new Date(`${date}T00:00:00+05:30`) : null);
const dayEnd = (date) => (date ? new Date(new Date(`${date}T00:00:00+05:30`).getTime() + 86_400_000) : null);
const likeText = (value) => String(value ?? '').replace(/[\0-\x1f\x7f]/g, '').replace(/[\\%_]/g, (c) => `\\${c}`);

const LIST_WHERE = `o.tenant_id = $1
  AND ($2::text IS NULL OR o.status = $2) AND ($3::text IS NULL OR o.fulfilment_status = $3) AND ($4::text IS NULL OR o.payment_status = $4)
  AND ($5::boolean IS NULL OR (o.hold_reason IS NOT NULL) = $5) AND ($6::timestamptz IS NULL OR o.created_at >= $6) AND ($7::timestamptz IS NULL OR o.created_at < $7)
  AND ($8 = '' OR o.order_number ILIKE '%' || $8 || '%' OR o.customer_name ILIKE '%' || $8 || '%' OR o.phone LIKE '%' || $8 || '%')`;
const listParams = (q) => [
  tenantId(), q.status ?? null, q.fulfilment ?? null, q.payment ?? null, q.held === undefined ? null : q.held === 'true', dayStart(q.from), dayEnd(q.to), likeText(q.search),
];

// ---- the CSV file ----

const CSV_COLUMNS = [
  ['Order', (o) => o.order_number], ['Placed', (o) => new Date(o.created_at).toISOString()], ['Fulfilment', (o) => STATUS_LABELS.fulfilment[o.fulfilment_status] ?? o.fulfilment_status],
  ['Payment', (o) => STATUS_LABELS.payment[o.payment_status] ?? o.payment_status], ['Way of paying', (o) => o.payment_mode], ['Customer', (o) => o.customer_name], ['Phone', (o) => o.phone],
  ['Email', (o) => o.email], ['Address', (o) => o.address], ['City', (o) => o.city], ['State', (o) => o.state], ['PIN', (o) => o.pincode], ['Items', (o) => o.item_count],
  ['Subtotal', (o) => rupees(o.subtotal_paise)], ['Discount', (o) => rupees(o.discount_paise)], ['Delivery', (o) => rupees(o.shipping_paise)], ['COD fee', (o) => rupees(o.cod_fee_paise)],
  ['Total', (o) => rupees(o.total_paise)], ['GST inside', (o) => rupees(o.tax_paise)], ['Paid', (o) => rupees(o.paid_paise)], ['Refunded', (o) => rupees(o.refunded_paise)],
  ['Coupon', (o) => o.coupon_code], ['Source', (o) => o.source],
];
const rupees = (paise) => (money(paise) / 100).toFixed(2);
/** One CSV cell: quoted, and a cell a spreadsheet would run as a formula starts with an apostrophe. */
function cell(value) {
  let text = String(value ?? '').replace(/[\0\r]/g, '');
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export const MAX_DOWNLOAD_ROWS = 20000;
const DOWNLOAD_DAYS = 7;
export const downloadFilePath = (id) => `/orders/downloads/${id}/file`;

const toDownload = (row) => {
  const expired = row.status === 'ready' && row.expires_at && new Date(row.expires_at) <= new Date();
  return {
    id: row.id, status: expired ? 'expired' : row.status, rowCount: row.row_count, fileUrl: row.status === 'ready' && !expired ? downloadFilePath(row.id) : null,
    createdAt: row.created_at, expiresAt: row.expires_at,
  };
};

export function ordersApi({ db, repos, platform, orderEvents }) {
  const tx = (fn) => db.tx(fn).catch((err) => {
    throw refused(err);
  });
  const kick = () => orderEvents?.kick?.();

  async function detail(id, q = db) {
    const [order] = await q.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
    if (!order) return null;
    const items = await q.query('SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenantId(), order.id]);
    return { ...toOrder(order), items: items.map(toItem) };
  }

  async function checkoutOrder(t, id) {
    const [order] = await t.query('SELECT id, flow, hold_reason, fulfilment_status FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
    if (!order) return null;
    if (order.flow !== 'checkout') throw new ApiError('conflict', 'This order was placed before checkout. Change its status instead.');
    return order;
  }

  const actorOf = (user) => `user:${user.id}`;

  return {
    takesOver: {
      'orders.list': async ({ query }) => {
        const after = query.cursor ? readCursor(query.cursor, (key) => key.length === 1 && Number.isInteger(key[0]) && key[0] > 0)[0] : null;
        const rows = await db.query(
          `SELECT o.*, (SELECT COALESCE(sum(i.qty), 0)::int FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS item_count
           FROM orders o WHERE ${LIST_WHERE} AND ($9::int IS NULL OR o.id < $9) ORDER BY o.id DESC LIMIT $10`,
          [...listParams(query), after, query.limit + 1],
        );
        const items = rows.slice(0, query.limit);
        return { items: items.map((o) => ({ ...toOrder(o), itemCount: o.item_count })), nextCursor: rows.length > query.limit ? writeCursor([items.at(-1).id]) : null };
      },

      'orders.get': async ({ params }) => detail(params.id),

      /** Phase 0 orders only: a checkout order moves through advance, cancel, a shipment or a payment. */
      'orders.setStatus': async ({ params, body }) => {
        const [order] = await db.query('SELECT id, flow FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), params.id]);
        if (!order) return null;
        if (order.flow === 'checkout') throw new ApiError('conflict', 'This order moves through its own steps: pack, ship, deliver or cancel.');
        try {
          await repos.orders.setStatus(order.id, body.status, body.notes);
        } catch (err) {
          if (err instanceof ValidationError) throw new ApiError('conflict', err.message);
          throw err;
        }
        kick();
        return detail(order.id);
      },
    },

    'orders.timeline': async ({ params }) => {
      const [order] = await db.query('SELECT id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), params.id]);
      if (!order) return null;
      const rows = await db.query('SELECT * FROM order_status_history WHERE tenant_id = $1 AND order_id = $2 ORDER BY id LIMIT 500', [tenantId(), order.id]);
      const userIds = [...new Set(rows.map((r) => /^user:(\d+)$/.exec(r.actor)?.[1]).filter(Boolean).map(Number))];
      const users = userIds.length ? await db.query('SELECT id, role FROM users WHERE tenant_id = $1 AND id = ANY($2::int[])', [tenantId(), userIds]) : [];
      const roles = new Map(users.map((u) => [u.id, u.role]));
      return { items: rows.map((r) => toEntry(r, roles)) };
    },

    'orders.advance': async ({ params, body, user }) => {
      const done = await tx(async (t) => {
        const order = await checkoutOrder(t, params.id);
        if (!order) return null;
        if (order.hold_reason) throw new ApiError('conflict', 'This order is on hold. Release the hold first.');
        await changeOrder(t, order.id, { fulfilment: body.to, actor: actorOf(user), reason: body.note ? 'With a note' : '' });
        if (body.note) await addOrderNote(t, order.id, { actor: actorOf(user), note: body.note });
        return order;
      });
      if (!done) return null;
      kick();
      return detail(done.id);
    },

    /** Before shipment only. Stock and the coupon come back now; a paid order answers with refundDuePaise (S-31). */
    'orders.cancel': async ({ params, body, user }) => {
      const [order] = await db.query('SELECT id, flow FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), params.id]);
      if (!order) return null;
      if (order.flow !== 'checkout') {
        await repos.orders.setStatus(order.id, 'cancelled', body.note).catch((err) => {
          throw err instanceof ValidationError ? new ApiError('conflict', err.message) : err;
        });
      } else {
        await tx((t) => cancelOrder(t, order.id, { actor: actorOf(user), cancelReason: body.reason, note: body.note ?? '', events: orderEvents }));
      }
      kick();
      return detail(order.id);
    },

    'orders.releaseHold': async ({ params, body, user }) => {
      const done = await tx(async (t) => {
        const order = await checkoutOrder(t, params.id);
        if (!order) return null;
        // "Paid, out of stock" on an order that is going ahead: its lines are taken from stock before it can move on.
        if (order.hold_reason === 'paid_out_of_stock' && order.fulfilment_status !== 'cancelled') {
          const taken = await commitLate(t, order.id, { actor: actorOf(user), events: orderEvents });
          if (!taken.ok) throw new ApiError('conflict', 'There still isn’t enough stock for this order. Add stock first, or cancel and refund it.');
        }
        await releaseOrder(t, order.id, { actor: actorOf(user), reason: 'Hold released' });
        if (body?.note) await addOrderNote(t, order.id, { actor: actorOf(user), note: body.note });
        return order;
      });
      if (!done) return null;
      kick();
      return detail(done.id);
    },

    /** A cancelled order whose money came after its hold ran out, brought back when the stock is there after all (S-41). */
    'orders.reinstate': async ({ params, user }) => {
      const done = await tx(async (t) => {
        const order = await checkoutOrder(t, params.id);
        if (!order) return null;
        const [now] = await t.query('SELECT fulfilment_status, payment_status, cancel_reason FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), order.id]);
        if (now.fulfilment_status !== 'cancelled' || now.cancel_reason !== 'hold_expired' || !['paid', 'advance_paid'].includes(now.payment_status)) {
          throw new ApiError('conflict', 'Only an order cancelled for late payment, and then paid, can be brought back.');
        }
        const taken = await commitLate(t, order.id, { actor: actorOf(user), events: orderEvents });
        if (!taken.ok) throw new ApiError('conflict', 'There isn’t enough stock to bring this order back. Add stock first, or refund the payment.');
        await changeOrder(t, order.id, { fulfilment: 'new', actor: actorOf(user), reason: 'Brought back: paid after the hold ran out' });
        await releaseOrder(t, order.id, { actor: actorOf(user), reason: 'Stock found' });
        return order;
      });
      if (!done) return null;
      kick();
      return detail(done.id);
    },

    'orders.addNote': async ({ params, body, user }) => {
      const entry = await tx(async (t) => {
        const [order] = await t.query('SELECT id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), params.id]);
        if (!order) return null;
        const added = await addOrderNote(t, order.id, { actor: actorOf(user), note: body.note });
        return { id: added.id, kind: 'note', from: '', to: '', actor: actorLabel(actorOf(user), new Map([[user.id, user.role]])), reason: '', note: String(body.note).trim().slice(0, 1000), at: added.createdAt };
      });
      return entry;
    },

    'orderDownloads.list': async ({ query }) => {
      const after = query.cursor ? readCursor(query.cursor, (key) => key.length === 1 && Number.isInteger(key[0]) && key[0] > 0)[0] : null;
      const rows = await db.query('SELECT * FROM order_downloads WHERE tenant_id = $1 AND ($2::int IS NULL OR id < $2) ORDER BY id DESC LIMIT $3', [tenantId(), after, query.limit + 1]);
      const items = rows.slice(0, query.limit);
      return { items: items.map(toDownload), nextCursor: rows.length > query.limit ? writeCursor([items.at(-1).id]) : null };
    },

    /** Made at once, up to 20,000 orders, newest first. The file goes to private storage and is opened through downloadFilePath. */
    'orderDownloads.create': async ({ body, user }) => {
      const filters = { from: body.from ?? null, to: body.to ?? null, fulfilment: body.fulfilment ?? null, payment: body.payment ?? null };
      const rows = await db.query(
        `SELECT o.*, (SELECT COALESCE(sum(i.qty), 0)::int FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS item_count
         FROM orders o WHERE ${LIST_WHERE} ORDER BY o.id DESC LIMIT ${MAX_DOWNLOAD_ROWS}`,
        listParams({ fulfilment: body.fulfilment, payment: body.payment, from: body.from, to: body.to, search: '' }),
      );
      const csv = [CSV_COLUMNS.map(([name]) => cell(name)).join(','), ...rows.map((o) => CSV_COLUMNS.map(([, get]) => cell(get(o))).join(','))].join('\r\n');
      const [created] = await db.query(
        `INSERT INTO order_downloads (tenant_id, status, filters, row_count, created_by, expires_at) VALUES ($1, 'queued', $2::jsonb, $3, $4, now() + make_interval(days => $5)) RETURNING *`,
        [tenantId(), JSON.stringify(filters), rows.length, user?.id ?? null, DOWNLOAD_DAYS],
      );
      const key = `t/${tenantId()}/order-downloads/${created.id}-${crypto.randomBytes(8).toString('hex')}.csv`;
      try {
        await platform.storage.put(key, Buffer.from(`﻿${csv}`, 'utf8'), 'text/csv');
      } catch (err) {
        await db.query(`UPDATE order_downloads SET status = 'failed' WHERE tenant_id = $1 AND id = $2`, [tenantId(), created.id]);
        throw err;
      }
      const [ready] = await db.query(`UPDATE order_downloads SET status = 'ready', storage_key = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId(), created.id, key]);
      return toDownload(ready);
    },

    'orderDownloads.get': async ({ params }) => {
      const [row] = await db.query('SELECT * FROM order_downloads WHERE tenant_id = $1 AND id = $2', [tenantId(), params.id]);
      return row ? toDownload(row) : null;
    },
  };
}

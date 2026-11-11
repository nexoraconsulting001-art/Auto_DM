import { ApiError } from '../../contracts/api/index.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { buyerBaseUrl } from '../admin-api/urls.js';
import { writeAudit } from '../audit/index.js';
import { changeRow } from '../orders/state.js';
import { opsAlert, ownerAlert } from './alerts.js';
import { addressComplete, pickupReady } from './settings.js';
import { BEFORE_PICKUP, cleanText, failureFields, failureOf, isAwb, listOf, providerId, stateName, tenDigits, trackingToken } from './util.js';

/**
 * Shipments (PRD 9.10): "Ready to ship" makes the shipment at the courier, its AWB, the pickup and the label, on the account
 * the business ships with. A reverse shipment (a return's pickup, 9.17) runs the same steps on the same mode.
 *
 *   create(orderId, body, actor)       -> Shipment, or null when the order isn't this business's
 *   bookReturn({ orderId, returnId?, items?, actor })   the reverse pickup, for the returns track, on the mode the business
 *                                      ships with now; call it after your commit
 *   advance(id)                        runs whatever steps are left; the worker's resume() calls it for every unfinished one
 *   cancel(id, actor)                  before pickup only; cancelled at the courier first
 *   label(id)                          -> { url } of the courier's label, never shown to a shopper
 *   forOrder(orderId), get(id)         as the console reads them, with their tracking events
 *   cancelForOrder(orderId)            the order was cancelled: its parcel is called off at the courier if it can still be
 *   trackingUrl(orderId)               the seller's own tracking page for an order, on its own domain (S-78)
 *
 * Never twice at the courier. The shipments row is made first, in one transaction with the order locked, and an order has at
 * most one live forward shipment (a unique index), so two taps make one row. Each step's result is saved before the next
 * one starts, and a step that is done is never sent again. Making the courier's order is the one call that can't be looked
 * up afterwards, so it is claimed first (provider_order_id = '' while it is in flight or its answer was lost) and sent again
 * only after a lease runs out, which ops are told about: an order with no AWB costs nothing and books no courier, and
 * everything after it (the AWB, the pickup, the label) names the courier's shipment id, so repeating those is harmless.
 *
 * A failed step never fails the request with a server error: the shipment stays where it got to and the worker picks it up
 * again with backoff. Money is integer paise. Logs carry ids, statuses and the courier's error kind, never an address.
 */
const CONFIRMED = new Set(['paid', 'advance_paid', 'cod_due', 'partially_refunded']);
const SHIPPABLE = new Set(['new', 'packed', 'ready_to_ship']);
const COLLECT_AT_DOOR = new Set(['cod_due', 'advance_paid']);
const NOT_LIVE = "('cancelled', 'lost', 'rto_delivered')";
export const CREATE_LEASE_SECONDS = 55;
const MAX_WEIGHT_GRAMS = 500_000;
const MAX_SIDE_CM = 500;
const GIVE_UP_DAYS = 3;
const URL = /^https?:\/\/[^\s"'<>\\]{1,990}$/i;

const conflict = (message) => new ApiError('conflict', message);

export const toShipment = (row, { trackingUrl = '', events } = {}) => ({
  id: Number(row.id),
  orderId: row.order_id,
  kind: row.kind,
  mode: row.mode,
  status: row.status,
  awb: row.awb ?? null,
  courierName: row.courier_name ?? '',
  weightGrams: row.weight_grams,
  lengthCm: row.length_cm,
  breadthCm: row.breadth_cm,
  heightCm: row.height_cm,
  codPaise: Number(row.cod_paise),
  chargePaise: Number(row.charge_paise),
  trackingUrl,
  hasLabel: Boolean(row.label_url),
  ...(events ? { events: events.map((e) => ({ status: e.status, providerStatus: e.provider_status, location: e.location, at: e.occurred_at })) } : {}),
  createdAt: row.created_at,
  deliveredAt: row.delivered_at ?? null,
});

/** Why an order can't be shipped now, in the seller's words, or '' when it can. */
export function notShippable(order) {
  if (order.flow !== 'checkout') return 'This order was placed before the store’s checkout. Mark it shipped by hand.';
  if (order.fulfilment_status === 'cancelled') return 'This order was cancelled, so it can’t be shipped.';
  if (order.hold_reason) return 'This order is on hold. Sort out the hold before shipping it.';
  if (!CONFIRMED.has(order.payment_status)) return 'This order isn’t paid or confirmed yet, so it can’t be shipped.';
  if (!SHIPPABLE.has(order.fulfilment_status)) return 'This order has already left with a courier.';
  return '';
}

/** Where the parcel goes, from the address as the order was placed (S-14). */
export function deliveryAddress(order) {
  const a = order.shipping_address && typeof order.shipping_address === 'object' ? order.shipping_address : {};
  return {
    name: cleanText(a.name ?? order.customer_name, 80),
    phone: tenDigits(a.phone ?? order.phone) ?? '',
    line1: cleanText(a.line1 ?? order.address, 200),
    line2: cleanText([a.line2, a.landmark].filter(Boolean).join(', '), 200),
    city: cleanText(a.city ?? order.city, 60),
    state: stateName(a.stateCode) || cleanText(order.state, 60),
    pincode: /^[1-9][0-9]{5}$/.test(String(a.pincode ?? order.pincode ?? '')) ? String(a.pincode ?? order.pincode) : '',
  };
}

export function createShipments(ctx, { settings, kick = () => {} }) {
  const { db, repos, config } = ctx;
  const platformDb = db.platform ?? db;

  // ---- reading ----

  async function baseUrl() {
    const tenant = await repos.tenants.get(tenantId()).catch(() => null);
    return tenant ? buyerBaseUrl(tenant, config) || '' : '';
  }

  const pathFor = (orderId, publicToken) => {
    const token = trackingToken(tenantId(), orderId, publicToken);
    return token ? `/track/${token}` : '';
  };

  async function trackingUrl(orderId) {
    const [order] = await db.query('SELECT id, public_token FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
    const path = order ? pathFor(order.id, order.public_token) : '';
    return path ? `${await baseUrl()}${path}` : '';
  }

  async function present(rows, { withEvents = true } = {}) {
    if (!rows.length) return [];
    const base = await baseUrl();
    const ids = rows.map((r) => Number(r.id));
    const events = withEvents
      ? await db.query('SELECT * FROM shipment_events WHERE tenant_id = $1 AND shipment_id = ANY($2::bigint[]) ORDER BY occurred_at DESC, id DESC', [tenantId(), ids])
      : [];
    return rows.map((r) => {
      const path = r.kind === 'forward' ? pathFor(r.order_id, r.public_token) : '';
      return toShipment(r, { trackingUrl: path ? `${base}${path}` : '', events: withEvents ? events.filter((e) => Number(e.shipment_id) === Number(r.id)).slice(0, 50) : undefined });
    });
  }

  const SELECT = 'SELECT s.*, o.public_token, o.order_number FROM shipments s JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id';
  async function load(id, q = db) {
    const [row] = await q.query(`${SELECT} WHERE s.tenant_id = $1 AND s.id = $2`, [tenantId(), id]);
    return row ?? null;
  }

  // ---- what goes in the parcel ----

  /** The order's lines with each product's weight and size now: a weight added after the order was placed counts (S-34). */
  async function linesOf(q, orderId, only = null) {
    const rows = await q.query(
      `SELECT oi.id, oi.name, oi.qty, oi.sku, oi.hsn_code, oi.price_paise, oi.product_id, p.name AS product_name,
              COALESCE(v.weight_grams, p.weight_grams, oi.weight_grams) AS weight_grams, p.length_cm, p.breadth_cm, p.height_cm
       FROM order_items oi
       LEFT JOIN products p ON p.tenant_id = oi.tenant_id AND p.id = oi.product_id
       LEFT JOIN product_variants v ON v.tenant_id = oi.tenant_id AND v.id = oi.variant_id
       WHERE oi.tenant_id = $1 AND oi.order_id = $2 ORDER BY oi.id`,
      [tenantId(), orderId],
    );
    if (!only) return rows;
    const qty = new Map(only.map((i) => [Number(i.orderItemId), Number(i.qty)]));
    return rows.filter((r) => qty.has(Number(r.id))).map((r) => ({ ...r, qty: Math.min(Number(r.qty), Math.max(1, qty.get(Number(r.id)))) }));
  }

  /** Weight and size: what the seller typed, else worked out from the products. Refused by name when a product has none. */
  function parcelOf(lines, body = {}) {
    if (!lines.length) throw conflict('This order has nothing to ship.');
    const nameOf = (l) => cleanText(l.product_name || l.name, 120) || 'a product';
    let weight = body.weightGrams;
    if (weight === undefined) {
      const missing = lines.filter((l) => !(Number(l.weight_grams) > 0)).map(nameOf);
      if (missing.length) {
        const message = `Add weight to ${listOf(missing)}`;
        throw new ApiError('validation_failed', message, { fields: { weightGrams: message } });
      }
      weight = lines.reduce((sum, l) => sum + Number(l.weight_grams) * Number(l.qty), 0);
    }
    if (weight > MAX_WEIGHT_GRAMS) throw new ApiError('validation_failed', 'This parcel is heavier than a courier takes (500 kg).', { fields: { weightGrams: 'Too heavy for a courier' } });
    const side = (key, column, fold) => {
      if (body[key] !== undefined) return body[key];
      const missing = lines.filter((l) => !(Number(l[column]) > 0)).map(nameOf);
      if (missing.length) {
        const message = `Add the parcel’s size, or add size to ${listOf(missing)}`;
        throw new ApiError('validation_failed', message, { fields: { [key]: message } });
      }
      return Math.min(MAX_SIDE_CM, fold(lines.map((l) => [Number(l[column]), Number(l.qty)])));
    };
    // The box fits the longest and widest item, with the items stacked.
    const lengthCm = side('lengthCm', 'length_cm', (v) => Math.max(...v.map(([n]) => n)));
    const breadthCm = side('breadthCm', 'breadth_cm', (v) => Math.max(...v.map(([n]) => n)));
    const heightCm = side('heightCm', 'height_cm', (v) => v.reduce((sum, [n, qty]) => sum + n * qty, 0));
    return { weightGrams: weight, lengthCm, breadthCm, heightCm };
  }

  /** Everything checked before a row is made or the courier is called. -> { order, parcel, existing? } | null */
  async function prepare(q, orderId, body, { lock = false, kind = 'forward', items = null } = {}) {
    const [order] = await q.query(`SELECT * FROM orders WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [tenantId(), orderId]);
    if (!order) return null;
    const [existing] = await q.query(
      `SELECT * FROM shipments WHERE tenant_id = $1 AND order_id = $2 AND kind = $3 AND status NOT IN ${NOT_LIVE} ORDER BY id DESC LIMIT 1`,
      [tenantId(), orderId, kind],
    );
    if (existing && (kind === 'forward' || existing.status !== 'delivered')) return { order, existing };
    if (kind === 'forward') {
      const why = notShippable(order);
      if (why) throw conflict(why);
    } else if (order.fulfilment_status !== 'delivered') {
      throw conflict('A return can be picked up only after the order was delivered.');
    }
    const to = deliveryAddress(order);
    if (!to.name || !to.phone || !to.line1 || !to.city || !to.pincode) throw conflict('The order’s delivery address is incomplete, so the courier can’t take it.');
    const parcel = parcelOf(await linesOf(q, orderId, items), body);
    return { order, parcel };
  }

  async function readyPickup() {
    let s = await settings.row();
    if (!pickupReady(s)) s = await settings.ensurePickup();
    if (pickupReady(s)) return s;
    throw conflict(addressComplete(s) ? 'Your pickup address is still being set up with the courier. Try again in a few minutes.' : 'Add your pickup address in Shipping settings first.');
  }

  /** Makes the row, or finds the one a moment ago made. -> the row */
  async function makeRow({ orderId, body, kind, mode, items, returnId }) {
    const s = await readyPickup();
    try {
      return await db.tx(async (t) => {
        const again = await prepare(t, orderId, body, { lock: true, kind, items });
        if (!again) return null;
        if (again.existing) return again.existing;
        const { order, parcel } = again;
        const cod = kind === 'forward' && COLLECT_AT_DOOR.has(order.payment_status) ? Number(order.balance_paise) : 0;
        const [row] = await t.query(
          `INSERT INTO shipments (tenant_id, order_id, kind, mode, provider, weight_grams, length_cm, breadth_cm, height_cm, cod_paise, pickup_location)
           VALUES ($1, $2, $3, $4, 'shiprocket', $5, $6, $7, $8, $9, $10) RETURNING *`,
          [tenantId(), orderId, kind, mode ?? s.mode, parcel.weightGrams, parcel.lengthCm, parcel.breadthCm, parcel.heightCm, cod, s.pickup_location],
        );
        // A return names its reverse pickup in the same transaction, so asking again finds this one (returns.shipment_id).
        if (returnId) {
          await t.query(
            `UPDATE returns SET shipment_id = $3 WHERE tenant_id = $1 AND id = $2
               AND (shipment_id IS NULL OR shipment_id IN (SELECT id FROM shipments WHERE tenant_id = $1 AND status IN ('cancelled')))`,
            [tenantId(), returnId, row.id],
          );
        }
        log.info('shipping.shipment_made', { tenantId: tenantId(), shipment: Number(row.id), order: orderId, kind, mode: row.mode });
        return row;
      });
    } catch (err) {
      // Two taps at once: the unique index let one through, and the other uses it.
      if (err?.code !== '23505') throw err;
      const [row] = await db.query(`SELECT * FROM shipments WHERE tenant_id = $1 AND order_id = $2 AND kind = $3 AND status NOT IN ${NOT_LIVE} ORDER BY id DESC LIMIT 1`, [tenantId(), orderId, kind]);
      if (!row) throw err;
      return row;
    }
  }

  // ---- the courier's steps ----

  /** Bumps updated_at (the trigger sets it on every update): the time of the last try, which the lease and the backoff read. */
  const touch = (id) => db.query('UPDATE shipments SET label_url = label_url WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);

  /** The reference the courier keeps for this parcel: the order number, with a suffix for a second shipment or a return. */
  async function channelRef(s) {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM shipments WHERE tenant_id = $1 AND order_id = $2 AND kind = $3 AND id < $4', [tenantId(), s.order_id, s.kind, s.id]);
    const number = String(s.order_number ?? s.order_id);
    if (s.kind === 'reverse') return `${number}-R${n + 1}`;
    return n === 0 ? number : `${number}-${n + 1}`;
  }

  async function courierRequest(s, items) {
    const [order] = await db.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), s.order_id]);
    let only = items;
    if (!only && s.kind === 'reverse') {
      const rows = await db.query(
        `SELECT ri.order_item_id, ri.qty FROM return_items ri JOIN returns r ON r.tenant_id = ri.tenant_id AND r.id = ri.return_id
         WHERE r.tenant_id = $1 AND r.shipment_id = $2`,
        [tenantId(), s.id],
      );
      if (rows.length) only = rows.map((r) => ({ orderItemId: r.order_item_id, qty: r.qty }));
    }
    const lines = await linesOf(db, s.order_id, only);
    return {
      orderNumber: await channelRef({ ...s, order_number: order.order_number }),
      pickupLocation: s.pickup_location,
      shipTo: deliveryAddress(order),
      items: lines.map((l) => ({ id: l.id, name: cleanText(l.name, 200) || 'Item', sku: cleanText(l.sku, 100), qty: Number(l.qty), pricePaise: Number(l.price_paise), hsnCode: l.hsn_code || undefined })),
      weightGrams: s.weight_grams,
      lengthCm: s.length_cm,
      breadthCm: s.breadth_cm,
      heightCm: s.height_cm,
      codPaise: Number(s.cod_paise),
      subTotalPaise: s.kind === 'reverse' ? lines.reduce((sum, l) => sum + Number(l.price_paise) * Number(l.qty), 0) : Number(order.total_paise),
    };
  }

  /** Step 1: the courier's order and shipment. -> { state: 'ok' | 'busy' | 'retry' | 'unknown' | 'refused', shipment, failure? } */
  async function atCourier(s, courier, items) {
    const resend = s.provider_order_id === '';
    const [claimed] = await db.query(
      `UPDATE shipments SET provider_order_id = '' WHERE tenant_id = $1 AND id = $2 AND provider_shipment_id IS NULL AND status IN ('created')
         AND (provider_order_id IS NULL OR (provider_order_id = '' AND updated_at < now() - make_interval(secs => $3::int))) RETURNING *`,
      [tenantId(), s.id, CREATE_LEASE_SECONDS],
    );
    if (!claimed) {
      const now = await load(s.id);
      return { state: now?.provider_shipment_id ? 'ok' : 'busy', shipment: now ?? s };
    }
    let made;
    try {
      const request = await courierRequest(s, items);
      made = s.kind === 'reverse' ? await courier.createReturn(request) : await courier.createOrder(request);
    } catch (err) {
      const failure = failureOf(err);
      log.warn('shipping.create_failed', { tenantId: tenantId(), shipment: Number(s.id), failure, ...failureFields(err) });
      if (err?.name !== 'ProviderError') reportError(err, { msg: 'shipping.create_error', shipment: Number(s.id) });
      if (failure === 'refused' || failure === 'auth') {
        // The courier made nothing, and trying the same again won't help: the row is closed, so the seller can try again.
        const shipment = await db.tx(async (t) => {
          await t.query(`UPDATE shipments SET provider_order_id = NULL WHERE tenant_id = $1 AND id = $2 AND provider_order_id = ''`, [tenantId(), s.id]);
          return (await changeRow(t, 'shipments', s.id, 'cancelled', { ifAllowed: true })).row;
        });
        kick();
        if (failure === 'auth' && s.mode === 'managed') {
          await opsAlert(platformDb, { tenantId: tenantId(), kind: 'shipping.master_login', message: 'The master courier account refused its login while booking a shipment.', target: `shipment:${s.id}`, dedupeKey: 'shipping-master-login' });
        }
        return { state: 'refused', failure, shipment };
      }
      if (failure === 'retry') await db.query(`UPDATE shipments SET provider_order_id = NULL WHERE tenant_id = $1 AND id = $2 AND provider_order_id = ''`, [tenantId(), s.id]);
      else await touch(s.id); // the answer was lost: the claim stands until the lease runs out
      return { state: failure === 'retry' ? 'retry' : 'unknown', shipment: await load(s.id) };
    }
    const orderRef = providerId(made?.providerOrderId);
    const shipmentRef = providerId(made?.providerShipmentId);
    if (!orderRef || !shipmentRef) {
      log.warn('shipping.create_unreadable', { tenantId: tenantId(), shipment: Number(s.id) });
      await touch(s.id);
      return { state: 'unknown', shipment: await load(s.id) };
    }
    await db.query('UPDATE shipments SET provider_order_id = $3, provider_shipment_id = $4 WHERE tenant_id = $1 AND id = $2', [tenantId(), s.id, orderRef, shipmentRef]);
    if (resend) {
      await opsAlert(platformDb, {
        tenantId: tenantId(), kind: 'shipping.possible_duplicate', severity: 'warning',
        message: `A courier order was sent again after its first answer was lost (shipment ${s.id}). If the courier shows two orders for it, cancel the one with no AWB.`,
        target: `shipment:${s.id}`, dedupeKey: `shipping-resend:${s.id}`,
      });
    }
    return { state: 'ok', shipment: await load(s.id) };
  }

  /** The courier charge on the seller's statement, at cost, once (S-77). Managed mode only: on its own account the seller pays the courier. */
  async function chargeLine(t, s, chargePaise) {
    if (s.mode !== 'managed' || !(chargePaise > 0)) return;
    await t.query(
      `INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref) VALUES ($1, $2, 'shipping_charge', $3, $4) ON CONFLICT (tenant_id, kind, ref) DO NOTHING`,
      [tenantId(), s.order_id, -chargePaise, `shipment:${s.id}`],
    );
  }

  async function recordAwb(s, courier, { awb, courierName, chargePaise }) {
    const charge = Number.isSafeInteger(chargePaise) && chargePaise >= 0 && chargePaise < 100_000_000 ? chargePaise : 0;
    const out = await db.tx(async (t) => {
      const moved = await changeRow(t, 'shipments', s.id, 'awb_assigned', { ifAllowed: true, set: { awb, courier_name: cleanText(courierName, 80), charge_paise: charge } });
      if (moved.skipped.length) return moved;
      await chargeLine(t, moved.row, charge);
      return moved;
    });
    kick();
    if (out.skipped.length && out.row.status === 'cancelled') {
      // Cancelled while the AWB was being booked: call it off at the courier too.
      await courier.cancel({ awb }).catch((err) => log.warn('shipping.late_cancel_failed', { tenantId: tenantId(), shipment: Number(s.id), ...failureFields(err) }));
    }
    return load(s.id);
  }

  const failed = async (step, s, err) => {
    const failure = failureOf(err);
    log.warn(`shipping.${step}_failed`, { tenantId: tenantId(), shipment: Number(s.id), failure, ...failureFields(err) });
    if (err?.name !== 'ProviderError') reportError(err, { msg: `shipping.${step}_error`, shipment: Number(s.id) });
    await touch(s.id);
    if (failure === 'refused' && step === 'awb') {
      await ownerAlert(db, {
        kind: 'shipping.awb_refused', target: `order:${s.order_id}`, dedupeKey: `shipping-awb-refused:${s.id}`,
        message: `The courier couldn’t assign an AWB for order ${s.order_number ?? s.order_id}. Check the parcel’s weight and the delivery PIN code, or cancel the shipment and ship it yourself.`,
      });
    }
    return { state: failure === 'refused' ? 'stuck' : 'retry', step, failure, shipment: await load(s.id) };
  };

  /** Runs whatever steps are left, in order, stopping at the first that fails. -> { state, shipment, step?, failure? } */
  async function advance(id, { items = null } = {}) {
    let s = await load(id);
    if (!s || !BEFORE_PICKUP.includes(s.status)) return { state: 'ok', shipment: s };
    let courier;
    try {
      courier = settings.courierFor(s.mode, await settings.row());
    } catch (err) {
      await touch(s.id);
      return { state: 'stuck', step: 'account', failure: 'auth', message: err.message, shipment: s };
    }

    if (!s.provider_shipment_id) {
      const made = await atCourier(s, courier, items);
      if (made.state !== 'ok') return made;
      s = made.shipment;
    }
    if (!s.awb) {
      try {
        const got = await courier.assignAwb({ providerShipmentId: s.provider_shipment_id });
        if (!isAwb(got?.awb)) throw Object.assign(new Error('The courier answered with no usable AWB'), { name: 'UnreadableAnswer' });
        s = await recordAwb(s, courier, got);
      } catch (err) {
        return failed('awb', s, err);
      }
      if (s.status === 'cancelled') return { state: 'ok', shipment: s };
    }
    if (s.status === 'awb_assigned') {
      try {
        const done = await courier.requestPickup({ providerShipmentId: s.provider_shipment_id });
        if (!done?.scheduled) throw Object.assign(new Error('The courier did not confirm the pickup'), { name: 'PickupUnconfirmed' });
        await db.tx((t) => changeRow(t, 'shipments', s.id, 'pickup_scheduled', { ifAllowed: true }));
        kick();
        s = await load(s.id);
      } catch (err) {
        return failed('pickup', s, err);
      }
    }
    if (s.kind === 'forward' && !s.label_url && BEFORE_PICKUP.includes(s.status)) {
      try {
        const { url } = await courier.label({ providerShipmentId: s.provider_shipment_id });
        if (!URL.test(String(url ?? ''))) throw Object.assign(new Error('The courier has not made the label yet'), { name: 'LabelPending' });
        await db.query('UPDATE shipments SET label_url = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), s.id, url]);
        s = await load(s.id);
      } catch (err) {
        return failed('label', s, err);
      }
    }
    return { state: 'ok', shipment: s };
  }

  /** What the console is told after a try: the shipment once it has an AWB, otherwise why not yet. */
  async function answer(out) {
    const s = out.shipment;
    if (!s) return null;
    if (s.awb && s.status !== 'cancelled') return (await present([await load(s.id)]))[0];
    if (s.status === 'cancelled' && out.state !== 'refused') throw conflict('This shipment was cancelled. Make a new one when you’re ready.');
    if (out.state === 'refused') {
      throw conflict(out.failure === 'auth'
        ? (s.mode === 'own' ? 'Shiprocket didn’t accept your saved login. Update it in Shipping settings, then try again.' : 'Shipping isn’t available just now. Our team has been told; please try again later.')
        : 'The courier didn’t accept this shipment. Check the delivery address, your pickup address and the parcel’s weight and size, then try again.');
    }
    if (out.state === 'stuck' && out.step === 'account') throw conflict(out.message);
    if (out.state === 'stuck') throw conflict('The courier couldn’t assign an AWB. Check the parcel’s weight and the delivery PIN code, or cancel this shipment and ship it yourself.');
    if (out.state === 'busy') throw conflict('This shipment is being booked with the courier. Check back in a minute.');
    throw conflict('The courier didn’t answer in time. We’ll keep trying, and the AWB will show here once it’s booked.');
  }

  // ---- the console's actions ----

  async function create(orderId, body = {}, actor) {
    // Nothing reaches the courier until the order and the parcel pass (S-34).
    const checked = await prepare(db, orderId, body);
    if (!checked) return null;
    const row = checked.existing ?? await makeRow({ orderId, body, kind: 'forward' });
    if (!row) return null;
    if (!checked.existing) {
      await writeAudit(db, { actor, action: 'shipping.shipment_created', target: `shipment:${row.id}`, details: { orderId, mode: row.mode } }).catch((err) => reportError(err, { msg: 'shipping.audit_failed' }));
      kick();
    }
    return answer(await advance(row.id));
  }

  async function bookReturn({ orderId, returnId = null, items = null, actor = 'system' } = {}) {
    if (returnId) {
      const [linked] = await db.query(
        `SELECT s.id FROM returns r JOIN shipments s ON s.tenant_id = r.tenant_id AND s.id = r.shipment_id WHERE r.tenant_id = $1 AND r.id = $2 AND s.status NOT IN ('cancelled')`,
        [tenantId(), returnId],
      );
      if (linked) return answer(await advance(linked.id, { items }));
    }
    // On the mode the business ships with now (9.17): a reverse pickup is a new shipment, and its pickup location (where the
    // parcel goes back to) is registered on that account.
    const checked = await prepare(db, orderId, {}, { kind: 'reverse', items });
    if (!checked) return null;
    const row = checked.existing ?? await makeRow({ orderId, body: {}, kind: 'reverse', items, returnId });
    if (!row) return null;
    if (!checked.existing) await writeAudit(db, { actor, action: 'shipping.return_pickup_booked', target: `shipment:${row.id}`, details: { orderId, returnId, mode: row.mode } }).catch(() => {});
    kick();
    return answer(await advance(row.id, { items }));
  }

  async function cancel(id, actor, { reason = 'seller' } = {}) {
    const s = await load(id);
    if (!s) return null;
    if (s.status === 'cancelled') return (await present([s]))[0];
    if (!BEFORE_PICKUP.includes(s.status)) throw conflict('The courier already has this parcel, so it can’t be cancelled here.');
    const inFlight = s.provider_order_id === '' && !s.provider_shipment_id && Date.now() - new Date(s.updated_at).getTime() < CREATE_LEASE_SECONDS * 1000;
    if (inFlight) throw Object.assign(conflict('This shipment is being booked with the courier. Try again in a minute.'), { retryable: true });
    if (s.awb) {
      try {
        await settings.courierFor(s.mode, await settings.row()).cancel({ awb: s.awb });
      } catch (err) {
        const failure = failureOf(err);
        log.warn('shipping.cancel_failed', { tenantId: tenantId(), shipment: Number(s.id), failure, ...failureFields(err) });
        if (failure === 'refused') throw conflict('The courier wouldn’t cancel this shipment. It may already be on its way.');
        throw Object.assign(conflict('The courier didn’t answer. Please try again in a minute.'), { retryable: true });
      }
    } else if (s.provider_order_id === '') {
      await opsAlert(platformDb, { tenantId: tenantId(), kind: 'shipping.cancel_unconfirmed', severity: 'warning', message: `Shipment ${s.id} was cancelled while its courier order’s answer was lost. If the courier shows an order for it, cancel it there.`, target: `shipment:${s.id}`, dedupeKey: `shipping-cancel-unknown:${s.id}` });
    }
    await db.tx(async (t) => {
      const { row, changed } = await changeRow(t, 'shipments', s.id, 'cancelled', { ifAllowed: true });
      if (!changed) return;
      // The courier gives back the charge for a parcel it never picked up.
      if (row.mode === 'managed' && Number(row.charge_paise) > 0) {
        await t.query(
          `INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref) VALUES ($1, $2, 'adjustment', $3, $4) ON CONFLICT (tenant_id, kind, ref) DO NOTHING`,
          [tenantId(), row.order_id, Number(row.charge_paise), `shipment:${row.id}:cancelled`],
        );
      }
      await writeAudit(t, { actor, action: 'shipping.shipment_cancelled', target: `shipment:${row.id}`, details: { orderId: row.order_id, reason } });
    });
    kick();
    return (await present([await load(id)]))[0];
  }

  /** The order was cancelled (by the seller or the shopper): its parcel is called off if the courier doesn't have it yet. */
  async function cancelForOrder(orderId) {
    const rows = await db.query(`SELECT s.id, s.status, o.order_number FROM shipments s JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
      WHERE s.tenant_id = $1 AND s.order_id = $2 AND s.kind = 'forward' AND s.status NOT IN ${NOT_LIVE} AND s.status <> 'delivered'`, [tenantId(), orderId]);
    for (const r of rows) {
      if (BEFORE_PICKUP.includes(r.status)) {
        try {
          await cancel(r.id, 'job:shipping-order-cancelled', { reason: 'order_cancelled' });
        } catch (err) {
          // A passing failure is tried again by the event bus; a courier that refuses is the owner's to sort out.
          if (!(err instanceof ApiError) || err.retryable) throw err;
          await ownerAlert(db, {
            kind: 'shipping.cancel_refused', severity: 'critical', target: `order:${orderId}`, dedupeKey: `shipping-cancel-refused:${r.id}`,
            message: `Order ${r.order_number} was cancelled, but the courier wouldn’t cancel its shipment. Check with the courier.`,
          });
        }
      } else {
        await ownerAlert(db, {
          kind: 'shipping.cancelled_in_transit', severity: 'critical', target: `order:${orderId}`, dedupeKey: `shipping-cancelled-in-transit:${r.id}`,
          message: `Order ${r.order_number} was cancelled, but the courier already has the parcel. Ask the courier to return it.`,
        });
      }
    }
  }

  async function label(id) {
    const s = await load(id);
    if (!s) return null;
    if (s.label_url) return { url: s.label_url };
    if (!s.awb || !s.provider_shipment_id || s.status === 'cancelled') throw conflict('The label is ready once the courier has assigned an AWB.');
    let url = '';
    try {
      url = (await settings.courierFor(s.mode, await settings.row()).label({ providerShipmentId: s.provider_shipment_id }))?.url ?? '';
    } catch (err) {
      log.warn('shipping.label_failed', { tenantId: tenantId(), shipment: Number(s.id), ...failureFields(err) });
    }
    if (!URL.test(url)) throw conflict('The courier hasn’t made the label yet. Try again in a minute.');
    await db.query('UPDATE shipments SET label_url = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), s.id, url]);
    return { url };
  }

  async function forOrder(orderId) {
    const [order] = await db.query('SELECT id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
    if (!order) return null;
    return { items: await present(await db.query(`${SELECT} WHERE s.tenant_id = $1 AND s.order_id = $2 ORDER BY s.id DESC`, [tenantId(), orderId])) };
  }

  async function get(id) {
    const row = await load(id);
    return row ? (await present([row]))[0] : null;
  }

  /**
   * The worker's sweep for shipments that stopped part-way: each is tried again after a wait that grows with its age (a
   * minute, up to an hour), for three days. After that the seller and ops are told once, and it waits for a person.
   */
  async function resume({ limit = 50 } = {}, each) {
    const rows = await platformDb.query(
      `SELECT tenant_id, id FROM shipments
       WHERE provider = 'shiprocket' AND status IN ('created', 'awb_assigned', 'pickup_scheduled')
         AND (provider_shipment_id IS NULL OR awb IS NULL OR status IN ('awb_assigned') OR (kind = 'forward' AND label_url = ''))
         AND created_at > now() - make_interval(days => $2::int)
         AND updated_at < now() - least(interval '1 hour', greatest(interval '1 minute', (now() - created_at) / 10))
       ORDER BY updated_at LIMIT $1`,
      [limit, GIVE_UP_DAYS],
    );
    for (const r of rows) await each(r.tenant_id, () => advance(r.id));
    const given = await platformDb.query(
      `SELECT s.tenant_id, s.id, s.order_id, o.order_number FROM shipments s JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
       WHERE s.provider = 'shiprocket' AND s.status IN ('created', 'awb_assigned')
         AND s.created_at BETWEEN now() - make_interval(days => $1::int + 1) AND now() - make_interval(days => $1::int)
       LIMIT 100`,
      [GIVE_UP_DAYS],
    );
    for (const g of given) {
      await each(g.tenant_id, async () => {
        await ownerAlert(db, { kind: 'shipping.not_booked', severity: 'critical', target: `order:${g.order_id}`, dedupeKey: `shipping-not-booked:${g.id}`, message: `The courier booking for order ${g.order_number} didn’t finish. Cancel the shipment and try again, or ship it yourself.` });
        await opsAlert(platformDb, { tenantId: g.tenant_id, kind: 'shipping.not_booked', message: `Shipment ${g.id} stopped part-way for ${GIVE_UP_DAYS} days.`, target: `shipment:${g.id}`, dedupeKey: `shipping-not-booked:${g.id}` });
      });
    }
    return rows.length;
  }

  return { create, bookReturn, advance, cancel, cancelForOrder, label, forOrder, get, resume, trackingUrl, pathFor, load, present, touch };
}

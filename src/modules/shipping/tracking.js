import { mapStatus } from '../../adapters/shiprocket/index.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { changeOrder, changeRow } from '../orders/state.js';
import { ownerAlert } from './alerts.js';
import { ORDER_STATUS_OF, cleanText, courierTime, failureFields, orderPath, shipmentPath } from './util.js';

/**
 * Tracking (PRD 9.10): courier scans, from the webhook and from polling, applied to the shipment, and the shipment moving
 * the order (9.9: Shiprocket events drive the shipping statuses).
 *
 *   apply(shipmentId, scans)   scans: [{ providerStatus, location, at }]. Each is stored once (shipment_events is unique by
 *                              shipment, the courier's status and its time: S-35). One older than what the shipment
 *                              already shows is kept for the record and changes nothing, so a late "in transit" never
 *                              undoes "delivered". A scan that is ahead walks the shipment through the steps it skipped.
 *                              -> { result: 'processed' | 'recorded' | 'duplicate' | 'gone', shipment }
 *   poll({ limit })            the worker's look-up of every live parcel the courier hasn't told us about lately, which is
 *                              also how a seller's own account (with no webhook to us) is tracked
 *   moveOrder(event)           the order event listener: a forward shipment picked up, out for delivery, delivered or back
 *                              with the seller moves its order, through any steps it skipped, and never backwards
 *
 * A courier time in the future (a skewed clock, a forged body that passed the token) is held to ten minutes ahead, so it
 * can block later scans for no longer than that.
 */
const FUTURE_SLACK_MS = 10 * 60_000;
const POLL_AFTER_MINUTES = 15;
const POLLED = ['awb_assigned', 'pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'rto_initiated'];
const ACTOR = 'courier:shiprocket';

const READABLE = Object.freeze({ shipped: 'picked up', out_for_delivery: 'out for delivery', delivered: 'delivered', rto_initiated: 'returning to you', rto_delivered: 'returned to you' });

/** The scans as stored: a status the courier names, a time we can read; oldest first, each once. */
export function normaliseScans(scans) {
  const seen = new Set();
  const out = [];
  for (const scan of scans ?? []) {
    const providerStatus = cleanText(scan?.providerStatus, 80);
    const at = scan?.at instanceof Date && !Number.isNaN(scan.at.getTime()) ? scan.at : courierTime(scan?.at);
    if (!providerStatus || !at) continue;
    const key = `${providerStatus}\n${at.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerStatus, location: cleanText(scan?.location, 120), at });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function createTracking(ctx, { settings, shipments, kick = () => {} }) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;

  async function applyOne(t, s, scan) {
    const status = mapStatus(scan.providerStatus);
    const effective = new Date(Math.min(scan.at.getTime(), Date.now() + FUTURE_SLACK_MS));
    const last = s.last_event_at ? new Date(s.last_event_at) : null;
    const newer = !last || effective.getTime() >= last.getTime();
    const path = status && newer ? shipmentPath(s.status, status) : null;
    const applied = newer && (!status || path !== null);
    const [stored] = await t.query(
      `INSERT INTO shipment_events (tenant_id, shipment_id, status, provider_status, location, occurred_at, applied) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, shipment_id, provider_status, occurred_at) DO NOTHING RETURNING id`,
      [tenantId(), s.id, status, scan.providerStatus, scan.location, scan.at, applied],
    );
    if (!stored) return { row: s, changed: false, stored: false };
    if (!status || !path) return { row: s, changed: false, stored: true };
    if (!path.length) {
      // The same status again, later: remember when, so an older scan arriving after it can't move the shipment.
      const [row] = await t.query('UPDATE shipments SET last_event_at = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId(), s.id, effective]);
      return { row, changed: false, stored: true };
    }
    let row = s;
    for (const step of path) {
      const end = step === path.at(-1);
      const set = end ? { last_event_at: effective, ...(step === 'delivered' ? { delivered_at: effective } : {}) } : {};
      row = (await changeRow(t, 'shipments', s.id, step, { ifAllowed: true, set })).row;
    }
    return { row, changed: true, stored: true };
  }

  async function apply(shipmentId, scans) {
    const list = normaliseScans(scans);
    const out = await db.tx(async (t) => {
      const [s] = await t.query('SELECT * FROM shipments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), shipmentId]);
      if (!s) return { result: 'gone', shipment: null };
      let row = s;
      let changed = false;
      let stored = 0;
      for (const scan of list) {
        const one = await applyOne(t, row, scan);
        row = one.row;
        changed ||= one.changed;
        stored += one.stored ? 1 : 0;
      }
      return { result: changed ? 'processed' : stored ? 'recorded' : 'duplicate', shipment: row, from: s.status };
    });
    if (out.result === 'processed') {
      kick();
      log.info('shipping.tracked', { tenantId: tenantId(), shipment: Number(shipmentId), from: out.from, to: out.shipment.status });
    }
    return out;
  }

  async function pollOne(id) {
    const s = await shipments.load(id);
    if (!s?.awb || !POLLED.includes(s.status)) return 'skipped';
    let tracked;
    try {
      tracked = await settings.courierFor(s.mode, await settings.row()).track({ awb: s.awb });
    } catch (err) {
      log.warn('shipping.poll_failed', { tenantId: tenantId(), shipment: Number(s.id), ...failureFields(err) });
      await shipments.touch(s.id);
      return 'failed';
    }
    const scans = (tracked?.events ?? []).map((e) => ({ providerStatus: e.providerStatus, location: e.location, at: courierTime(e.at) }));
    const out = await apply(s.id, scans);
    // Whatever it found, this parcel now waits its turn for the next look.
    await shipments.touch(s.id);
    return out.result;
  }

  /** Every live parcel not heard of in the last 15 minutes, the longest-waiting first. */
  async function poll({ limit = 100 } = {}, each) {
    const rows = await platformDb.query(
      `SELECT tenant_id, id FROM shipments WHERE provider = 'shiprocket' AND awb IS NOT NULL AND status = ANY($2::text[])
         AND updated_at < now() - make_interval(mins => $3::int) ORDER BY updated_at LIMIT $1`,
      [limit, POLLED, POLL_AFTER_MINUTES],
    );
    for (const r of rows) await each(r.tenant_id, () => pollOne(r.id));
    return rows.length;
  }

  /** shipment.* -> the order's fulfilment status, for forward parcels only. Safe to hear twice: a move already made is skipped. */
  async function moveOrder(event) {
    const target = ORDER_STATUS_OF[event.to];
    if (!target) return;
    const out = await db.tx(async (t) => {
      const [s] = await t.query('SELECT kind FROM shipments WHERE tenant_id = $1 AND id = $2', [tenantId(), event.entityId]);
      if (!s || s.kind !== 'forward') return null;
      const [order] = await t.query('SELECT id, order_number, flow, fulfilment_status FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), event.orderId]);
      if (!order || order.flow !== 'checkout') return null;
      const path = orderPath(order.fulfilment_status, target);
      if (!path) return { order, target, stuck: true };
      for (const step of path) await changeOrder(t, order.id, { fulfilment: step, actor: ACTOR, reason: `The courier reports it ${READABLE[step] ?? step.replaceAll('_', ' ')}`, ifAllowed: true });
      return { order, target, moved: path.length > 0 };
    });
    if (out?.moved) kick();
    if (out?.stuck && out.order.fulfilment_status === 'cancelled' && ['shipped', 'out_for_delivery', 'delivered'].includes(out.target)) {
      await ownerAlert(db, {
        kind: 'shipping.cancelled_order_moving', severity: 'critical', target: `order:${out.order.id}`, dedupeKey: `shipping-cancelled-moving:${out.order.id}`,
        message: `Order ${out.order.order_number} is cancelled, but the courier reports its parcel ${READABLE[out.target]}.`,
      });
    }
  }

  /** A failed delivery or a lost parcel is the owner's to act on. Once per shipment and status. */
  async function tellOwner(event) {
    const [row] = await db.query('SELECT s.kind, o.order_number FROM shipments s JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id WHERE s.tenant_id = $1 AND s.id = $2', [tenantId(), event.entityId]);
    if (!row) return;
    const what = row.kind === 'reverse' ? 'The return pickup' : 'The parcel';
    const message = event.to === 'lost'
      ? `${what} for order ${row.order_number} is reported lost by the courier.`
      : `${what} for order ${row.order_number} couldn’t be delivered on this attempt. The courier will try again.`;
    await ownerAlert(db, { kind: `shipping.${event.to}`, severity: event.to === 'lost' ? 'critical' : 'warning', target: `order:${event.orderId}`, dedupeKey: `shipping-${event.to}:${event.entityId}:${event.id}`, message });
  }

  return { apply, poll, pollOne, moveOrder, tellOwner };
}

import { PINCODE, PINCODE_MESSAGE } from '../../contracts/orders.js';
import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { section } from '../../views/buyer/index.js';
import { html } from '../../views/html.js';
import { limited, storeCall, storeOn } from '../storefront/http.js';
import { sendStoreNotFound, sendStorePage } from '../storefront/shell.js';
import { readTrackingToken, sameToken, trackingToken } from './util.js';

/**
 * The shopper's side of shipping (PRD 9.10), on the seller's own address and in the seller's brand only:
 *
 *   GET /track/:token               the tracking page a message's tracking link opens (S-78). Never the courier's page, never
 *                                   a redirect or a frame, no courier aggregator's name and no platform name. The token is
 *                                   the order's own (util.js), so a link works only on its business's address; anything else
 *                                   is the store's branded 404. It shows where the parcel is, never who it is going to: a
 *                                   tracking link gets forwarded.
 *   GET /api/store/serviceability   { pincode, serviceable, cod, message } for a PIN code, before checkout (S-33)
 */
const LOOKUPS = Object.freeze({ limit: 60, windowMs: 10 * 60_000 });
const HIDDEN = /shiprocket|kartrocket|bhava/i;

const STEP_WORDS = Object.freeze({
  awb_assigned: 'Packed and booked with the courier', pickup_scheduled: 'Waiting for the courier to pick up', picked_up: 'Picked up', in_transit: 'In transit',
  out_for_delivery: 'Out for delivery', undelivered: 'Delivery attempted', delivered: 'Delivered', rto_initiated: 'Returning to the seller',
  rto_delivered: 'Returned to the seller', cancelled: 'Shipment cancelled', lost: 'Delayed with the courier',
});

const when = (at) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(at));
const titleCase = (text) => String(text).toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
/** A courier's own words, unless they name the aggregator: a hub, a courier company, a scan. */
const shown = (text) => (HIDDEN.test(String(text ?? '')) ? '' : String(text ?? ''));

/** The headline: where the parcel is, in the shopper's words. */
export function trackingState(order, shipment) {
  const status = shipment?.status;
  if (status === 'delivered' || (!shipment && order.fulfilment_status === 'delivered')) return { title: 'Delivered', body: 'Your order has been delivered. Thank you for shopping with us.' };
  if (status === 'out_for_delivery' || order.fulfilment_status === 'out_for_delivery') return { title: 'Out for delivery', body: 'The courier is bringing your order today.' };
  if (status === 'undelivered') return { title: 'Delivery attempted', body: 'The courier couldn’t deliver your order this time and will try again.' };
  if (status === 'rto_initiated' || status === 'rto_delivered' || ['rto_initiated', 'rto_delivered'].includes(order.fulfilment_status)) return { title: 'Returning to the seller', body: 'This parcel couldn’t be delivered and is going back to the seller.' };
  if (status === 'lost') return { title: 'Delayed', body: 'Your parcel is delayed with the courier. The seller has been told and will be in touch.' };
  if (status === 'picked_up' || status === 'in_transit' || order.fulfilment_status === 'shipped') return { title: 'On its way', body: 'Your order has been shipped and is on its way to you.' };
  if (order.fulfilment_status === 'cancelled') return { title: 'Order cancelled', body: 'This order was cancelled.' };
  if (status === 'awb_assigned' || status === 'pickup_scheduled') return { title: 'Packed', body: 'Your order is packed and waiting for the courier to pick it up.' };
  return { title: 'Getting your order ready', body: 'We’ll show where your parcel is as soon as it leaves.' };
}

function trackingMain({ order, shipment, events, items }) {
  const state = trackingState(order, shipment);
  const courier = shown(shipment?.courier_name);
  const steps = events
    .map((e) => ({ label: STEP_WORDS[e.status] ?? shown(titleCase(e.provider_status)), place: shown(e.location), at: e.occurred_at }))
    .filter((e) => e.label);
  return ({ theme }) => html`<div data-tracking-page>
${section({ theme, id: 'track-h', kicker: `Order ${order.order_number}`, title: state.title, body: html`<p>${state.body}</p>
${shipment?.awb ? html`<p class="muted small">${courier ? html`${courier} · ` : ''}Tracking number ${shipment.awb}</p>` : ''}
${steps.length ? html`<div class="panel"><h2>Updates</h2><ol class="lines">${steps.map((e) => html`<li><b>${e.label}</b><div class="muted small">${[e.place, when(e.at)].filter(Boolean).join(' · ')}</div></li>`)}</ol></div>` : ''}
${items.length ? html`<div class="panel"><h2>In this parcel</h2><ul class="lines">${items.map((i) => html`<li>${i.name}<span class="muted small"> · Qty ${i.qty}</span></li>`)}</ul></div>` : ''}
<a class="btn" href="/shop">Continue shopping</a>` })}
</div>`;
}

export function mountPages(app, ctx, service) {
  const { db } = ctx;

  app.get(STORE_ROUTES.tracking.path, async (req, res, next) => {
    try {
      const parsed = readTrackingToken(req.params.token);
      if (!parsed || !(await storeOn(ctx.repos))) return sendStoreNotFound(ctx, req, res, 'This tracking link isn’t valid.');
      const [order] = await db.query('SELECT id, order_number, public_token, fulfilment_status, flow FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), parsed.orderId]);
      const expected = order ? trackingToken(tenantId(), order.id, order.public_token) : null;
      if (!expected || !sameToken(req.params.token, expected)) {
        log.info('shipping.tracking_not_found', { tenantId: tenantId() });
        return sendStoreNotFound(ctx, req, res, 'This tracking link isn’t valid.');
      }
      const [shipment] = await db.query(
        `SELECT * FROM shipments WHERE tenant_id = $1 AND order_id = $2 AND kind = 'forward' ORDER BY (status NOT IN ('cancelled')) DESC, id DESC LIMIT 1`,
        [tenantId(), order.id],
      );
      const events = shipment && shipment.status !== 'cancelled'
        ? await db.query('SELECT status, provider_status, location, occurred_at FROM shipment_events WHERE tenant_id = $1 AND shipment_id = $2 ORDER BY occurred_at DESC, id DESC LIMIT 40', [tenantId(), shipment.id])
        : [];
      const items = await db.query('SELECT name, qty FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenantId(), order.id]);
      const live = shipment && shipment.status !== 'cancelled' ? shipment : null;
      return sendStorePage(ctx, req, res, {
        title: `Track order ${order.order_number}`,
        description: trackingState(order, live).title,
        main: trackingMain({ order, shipment: live, events, items }),
        kind: 'other',
        ref: 'tracking',
        indexable: false,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get(STORE_ROUTES.serviceability.path, storeCall(ctx, async (req) => {
    const pincode = typeof req.query.pincode === 'string' ? req.query.pincode : '';
    if (!PINCODE.test(pincode)) throw new ApiError('validation_failed', PINCODE_MESSAGE, { fields: { pincode: PINCODE_MESSAGE } });
    await limited(ctx.platform, 'serviceability_ip', `${tenantId()}:${req.ip ?? ''}`, LOOKUPS);
    const answer = await service.serviceability.check(pincode);
    return { body: { pincode, serviceable: answer.serviceable, cod: answer.cod, message: service.serviceability.message(answer) } };
  }));
}

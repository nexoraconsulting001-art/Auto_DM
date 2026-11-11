import { ApiError } from '../../contracts/api/index.js';
import { STORE_PROVIDER_PATHS } from '../../contracts/store-routes.js';
import { reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { mountPages } from './pages.js';
import { createServiceability } from './serviceability.js';
import { createSettings } from './settings.js';
import { createShipments } from './shipments.js';
import { createTracking } from './tracking.js';
import { ORDER_STATUS_OF, SHIPPING_FEATURE } from './util.js';
import { createWebhooks } from './webhooks.js';

/**
 * PRD 9.10: shipping on Shiprocket, on Bhava's master account by default (one pickup location per seller) or the seller's
 * own API user, switchable per business for new shipments only.
 *
 *   settings.js        shipping_settings: the mode, the pickup address registered with the courier, the own login (encrypted)
 *   shipments.js       "Ready to ship": the shipment, its AWB, the pickup and the label, never twice at the courier; cancel;
 *                      the courier charge on the seller's statement at cost; the reverse pickup for returns
 *   tracking.js        courier scans applied once, in time order, never backwards; the order moved by its parcel; polling
 *   webhooks.js        POST /webhooks/courier: token checked, stored, then worked from the table and routed by AWB
 *   serviceability.js  PIN codes and cash on delivery, cached, quick enough for checkout's transaction
 *   pages.js           GET /track/:token (the seller's own tracking page) and GET /api/store/serviceability
 *
 * Tables (migration 407): shipping_settings, shipments, shipment_events, serviceability_cache; provider_webhook_events for
 * shiprocket; settlement_lines (shipping_charge, adjustment).
 * Console routes: shippingSettings.*, shipping.serviceability, shipments.* (src/contracts/api/fulfilment.js).
 * Order events it listens to: shipment.picked_up, in_transit, out_for_delivery, delivered, rto_initiated, rto_delivered
 * (the order follows its parcel, always with ifAllowed), order.cancelled (the parcel is called off at the courier),
 * shipment.undelivered and shipment.lost (the owner is told).
 * Jobs: shipping.webhooks (whatever the web process left), shipping.resume (shipments that stopped part-way, every minute
 * with backoff), shipping.track (polling, and pickup addresses not yet registered, every 15 minutes).
 *
 * For other tracks, ctx.shipping (set in setup):
 *   serviceable(pincode, q?) -> { serviceable, cod, checked }  checkout's quote; safe inside its transaction, and exact
 *       there when the transaction is passed as `q` (otherwise it answers from memory or, after 400 ms, takes the PIN as served)
 *   trackingUrl(orderId) -> the seller's own tracking page, absolute, or ''   for "shipped" messages (S-78, F-89)
 *   bookReturn({ orderId, returnId?, items?: [{ orderItemId, qty }], actor }) -> Shipment   the reverse pickup, on the
 *       courier mode the business ships with (9.17). It calls the courier, so call it after your transaction commits. With
 *       returnId it sets returns.shipment_id in the same transaction as the shipment row (only when empty or pointing at a
 *       cancelled one), so asking again finds it. Refusals are ApiError (409 conflict, 400 for a product with no weight).
 */
export const SHIPPING_JOBS = Object.freeze({ webhooks: 'shipping.webhooks', resume: 'shipping.resume', track: 'shipping.track' });
const MINUTE = 60_000;

const built = new WeakMap();
/** The one shipping service of a process's context. */
export function shippingFor(ctx) {
  let service = built.get(ctx);
  if (!service) {
    const kick = () => ctx.orderEvents?.kick?.();
    const settings = createSettings(ctx);
    const shipments = createShipments(ctx, { settings, kick });
    const tracking = createTracking(ctx, { settings, shipments, kick });
    const webhooks = createWebhooks(ctx, { tracking });
    const serviceability = createServiceability(ctx, { settings });
    service = {
      settings, shipments, tracking, webhooks, serviceability,
      serviceable: (pincode, q = null) => serviceability.check(pincode, { q }),
      trackingUrl: (orderId) => shipments.trackingUrl(orderId),
      bookReturn: (input) => shipments.bookReturn(input),
    };
    built.set(ctx, service);
  }
  return service;
}

const actorOf = (user) => `user:${user.id}`;

async function needPlan(ctx) {
  if (!(await ctx.repos.entitlements.can(SHIPPING_FEATURE))) throw new ApiError('forbidden', 'Shipping isn’t on your plan.', { reason: 'plan' });
}

/** Runs `fn` as each business in turn; one business's failure never stops the rest. */
const asEach = (msg) => (tenant, fn) => withTenant(tenant, fn).catch((err) => reportError(err, { msg, tenantId: tenant }));

export const shipping = {
  name: 'shipping',

  setup(ctx) {
    const service = shippingFor(ctx);
    ctx.shipping = service;
    const events = ctx.orderEvents;
    if (!events) return;
    events.on(Object.keys(ORDER_STATUS_OF).map((s) => `shipment.${s}`), 'shipping.order-status', (event) => service.tracking.moveOrder(event));
    events.on('order.cancelled', 'shipping.order-cancelled', (event) => service.shipments.cancelForOrder(event.orderId));
    events.on(['shipment.undelivered', 'shipment.lost'], 'shipping.owner-alerts', (event) => service.tracking.tellOwner(event));
  },

  beforeTenant(app, ctx) {
    app.post(STORE_PROVIDER_PATHS.courier.path, (req, res) => shippingFor(ctx).webhooks.receive(req, res));
  },

  routes(app, ctx) {
    mountPages(app, ctx, shippingFor(ctx));
  },

  api: (ctx) => ({
    'shippingSettings.get': () => shippingFor(ctx).settings.get(),
    'shippingSettings.update': async ({ body, user }) => {
      await needPlan(ctx);
      return shippingFor(ctx).settings.update(body, actorOf(user));
    },
    'shipping.serviceability': async ({ query }) => {
      const { serviceability } = shippingFor(ctx);
      const answer = await serviceability.check(query.pincode, { budgetMs: 8000 });
      return { pincode: query.pincode, serviceable: answer.serviceable, cod: answer.cod, message: answer.checked ? serviceability.message(answer) : 'The courier didn’t answer just now, so this PIN code couldn’t be checked.' };
    },
    'shipments.forOrder': ({ params }) => shippingFor(ctx).shipments.forOrder(params.id),
    'shipments.create': async ({ params, body, user }) => {
      await needPlan(ctx);
      return shippingFor(ctx).shipments.create(params.id, body, actorOf(user));
    },
    'shipments.get': ({ params }) => shippingFor(ctx).shipments.get(params.id),
    'shipments.cancel': ({ params, user }) => shippingFor(ctx).shipments.cancel(params.id, actorOf(user)),
    'shipments.label': ({ params }) => shippingFor(ctx).shipments.label(params.id),
  }),

  jobs(ctx) {
    const { queue } = ctx.platform;
    const service = shippingFor(ctx);
    queue.work(SHIPPING_JOBS.webhooks, () => service.webhooks.drain());
    queue.work(SHIPPING_JOBS.resume, () => service.shipments.resume({}, asEach('shipping.resume_failed')));
    queue.work(SHIPPING_JOBS.track, async () => {
      await service.tracking.poll({}, asEach('shipping.poll_failed'));
      await service.settings.retryPickups({}, (tenant) => asEach('shipping.pickup_retry_failed')(tenant, () => service.settings.ensurePickup()));
    });
    return async function schedule() {
      await queue.every(SHIPPING_JOBS.webhooks, MINUTE);
      await queue.every(SHIPPING_JOBS.resume, MINUTE);
      await queue.every(SHIPPING_JOBS.track, 15 * MINUTE);
    };
  },
};

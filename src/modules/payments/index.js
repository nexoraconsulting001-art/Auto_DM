import { ApiError } from '../../contracts/api/index.js';
import { STORE_PROVIDER_PATHS } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { tenantBaseUrl } from '../admin-api/urls.js';
import { mountBuyerRoutes } from './buyer.js';
import { createPayments } from './service.js';
import { asApiError } from './util.js';

/**
 * PRD 9.6 and 9.7: payments on the Razorpay adapter, in both modes (managed: Bhava's account with Route split settlement;
 * own: the seller's account by Partner OAuth or its own keys), cash on delivery, the payment webhooks and reconciliation.
 * Refunds (9.8) are src/modules/refunds, built on the same service.
 *
 * Tables (migration 404): payment_settings, payments, settlement_lines, reconciliation_gaps, provider_webhook_events (razorpay
 * and cashfree rows).
 * Console routes: paymentSettings.*, paymentAccount.*, payments.forOrder, settlements.*.
 * Buyer routes: POST /api/store/payments/return, POST /api/store/orders/:token/retry (buyer.js).
 * Provider routes, in beforeTenant: POST /webhooks/razorpay, POST /webhooks/razorpay/:key, POST /webhooks/cashfree/:key,
 * GET /oauth/razorpay/callback (webhooks.js, settings.js).
 * Order events it listens to: payment.captured (statement lines, again harmlessly), order.delivered (the cash collected at
 * the door), order.cancelled and order.rto_delivered (nothing left to collect).
 * Jobs: payments.webhooks (whatever the web process left), payments.pending-check (S-26), payments.reconcile (daily).
 *
 * For other tracks: ctx.payments (set in setup) is the service in service.js. Checkout calls
 * ctx.payments.settings.checkout(...) for the quote and ctx.payments.start(orderId, { baseUrl }) after the order commits.
 */
export const PAYMENT_JOBS = Object.freeze({ webhooks: 'payments.webhooks', pending: 'payments.pending-check', daily: 'payments.reconcile' });
const MINUTE = 60_000;

const built = new WeakMap();
/** The one payments service of a process's context. */
export function paymentsFor(ctx) {
  let service = built.get(ctx);
  if (!service) {
    service = createPayments(ctx);
    built.set(ctx, service);
  }
  return service;
}

/** A PaymentError as the API's error; everything else as it was. */
const api = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    throw asApiError(err);
  }
};

const actorOf = (user) => `user:${user.id}`;

async function needPlan(ctx) {
  if (!(await ctx.repos.entitlements.can('store.payments'))) throw new ApiError('forbidden', 'Online payments aren’t on your plan.', { reason: 'plan' });
}

export const payments = {
  name: 'payments',

  setup(ctx) {
    const service = paymentsFor(ctx);
    ctx.payments = service;
    const events = ctx.orderEvents;
    if (!events) return;
    events.on('payment.captured', 'payments.statement', (event) => service.ensureLines(event.entityId));
    events.on('order.delivered', 'payments.cod-collected', (event) => service.recordCodCollected(event.orderId, { actor: 'job:cod-collected' }));
    events.on(['order.cancelled', 'order.rto_delivered'], 'payments.cod-void', (event) => service.voidCod(event.orderId, { actor: 'job:cod-void' }));
  },

  beforeTenant(app, ctx) {
    const { webhooks, settings } = paymentsFor(ctx);
    app.post(STORE_PROVIDER_PATHS.razorpayManaged.path, webhooks.managed);
    app.post(STORE_PROVIDER_PATHS.razorpayOwn.path, webhooks.own);
    app.post(STORE_PROVIDER_PATHS.cashfreeOwn.path, webhooks.cashfree);
    // Partner OAuth sends the owner back here; the signed state says which business, and the owner goes back to its console.
    app.get(STORE_PROVIDER_PATHS.razorpayOauth.path, async (req, res) => {
      const done = await settings.completeOauth({ state: req.query.state, code: req.query.code });
      if (!done.tenantId) return res.status(400).type('text').send('This link has expired. Start connecting your payment account again from your settings.');
      const tenant = await ctx.repos.tenants.get(done.tenantId).catch((err) => reportError(err, { msg: 'payments.oauth_tenant' }));
      const base = tenant ? tenantBaseUrl(tenant, ctx.config) : '';
      if (!base) return res.type('text').send(done.ok ? 'Your payment account is connected. You can close this page.' : 'Your payment account couldn’t be connected. Please try again.');
      log.info('payments.oauth_done', { tenantId: done.tenantId, ok: done.ok });
      res.redirect(303, `${base}/admin/settings?payments=${done.ok ? 'connected' : 'failed'}`);
    });
  },

  routes(app, ctx) {
    mountBuyerRoutes(app, ctx, paymentsFor(ctx));
  },

  api: (ctx) => ({
    'paymentSettings.get': api(() => paymentsFor(ctx).settings.options()),
    'paymentSettings.update': api(({ body, user }) => paymentsFor(ctx).settings.updateOptions(body, actorOf(user))),
    'paymentAccount.get': api(() => paymentsFor(ctx).settings.account()),
    'paymentAccount.startLinked': api(async ({ body, user }) => {
      await needPlan(ctx);
      return paymentsFor(ctx).settings.startLinked(body, actorOf(user));
    }),
    'paymentAccount.connectUrl': api(async ({ user }) => {
      await needPlan(ctx);
      return paymentsFor(ctx).settings.connectUrl(user);
    }),
    'paymentAccount.setMode': api(async ({ body, user }) => {
      await needPlan(ctx);
      return paymentsFor(ctx).settings.setMode(body.mode, actorOf(user));
    }),
    'paymentAccount.disconnect': api(async ({ user }) => {
      await paymentsFor(ctx).settings.disconnect(actorOf(user));
    }),
    'payments.forOrder': api(({ params }) => paymentsFor(ctx).statement.paymentsForOrder(params.id)),
    'settlements.list': api(({ query }) => paymentsFor(ctx).statement.list(query)),
    'settlements.summary': api(({ query }) => paymentsFor(ctx).statement.summary(query)),
  }),

  jobs(ctx) {
    const { queue } = ctx.platform;
    const service = paymentsFor(ctx);
    queue.work(PAYMENT_JOBS.webhooks, () => service.webhooks.drain());
    queue.work(PAYMENT_JOBS.pending, () => service.reconcile.pendingCheck());
    queue.work(PAYMENT_JOBS.daily, () => service.reconcile.daily());
    return async function schedule() {
      await queue.every(PAYMENT_JOBS.webhooks, MINUTE);
      await queue.every(PAYMENT_JOBS.pending, 2 * MINUTE);
      await queue.every(PAYMENT_JOBS.daily, 24 * 60 * MINUTE);
    };
  },
};

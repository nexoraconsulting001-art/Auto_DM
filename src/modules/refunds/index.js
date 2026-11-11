import { paymentsFor } from '../payments/index.js';
import { asApiError } from '../payments/util.js';

/**
 * PRD 9.8: refunds through the gateway, or by hand with a reference for cash on delivery, never more than was captured. The
 * service is service.js, built with the payments service and set as ctx.refunds.
 *
 * Tables (migration 404): refunds. The database holds refunds inside the captured amount (S-28), whatever two requests at
 * the same moment do.
 * Console routes: refunds.forOrder, refunds.create (owner only, with the owner's password checked again on the call, S-29),
 * refunds.get, refunds.retry. Every refund is in the audit log.
 * Order events it listens to: order.cancelled (a shopper's own cancellation is refunded, S-56, S-69; any other cancellation
 * of a paid order tells the owner a refund is due, S-31).
 * It writes refund.* events through the state machine; invoices (credit notes) and loyalty (S-89) listen to them.
 * Managed mode takes back the matching part of the Route transfer; own mode never does (S-75, S-76).
 * Job: refunds.sweep, for refunds whose gateway answer was lost.
 */
export const REFUND_JOBS = Object.freeze({ sweep: 'refunds.sweep' });

/** The refunds service of a process's context. */
export const refundsFor = (ctx) => paymentsFor(ctx).refunds;

const api = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    throw asApiError(err);
  }
};

export const refunds = {
  name: 'refunds',

  setup(ctx) {
    const service = refundsFor(ctx);
    ctx.refunds = service;
    ctx.orderEvents?.on('order.cancelled', 'refunds.on-cancel', (event) => service.onCancelled(event.orderId));
  },

  api: (ctx) => ({
    'refunds.forOrder': api(({ params }) => refundsFor(ctx).forOrder(params.id)),
    'refunds.create': api(({ params, body, user }) => refundsFor(ctx).createByOwner(params.id, body, user)),
    'refunds.get': api(({ params }) => refundsFor(ctx).get(params.id)),
    'refunds.retry': api(({ params, user }) => refundsFor(ctx).retry(params.id, `user:${user.id}`)),
  }),

  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(REFUND_JOBS.sweep, () => refundsFor(ctx).sweep());
    return async function schedule() {
      await queue.every(REFUND_JOBS.sweep, 2 * 60_000);
    };
  },
};

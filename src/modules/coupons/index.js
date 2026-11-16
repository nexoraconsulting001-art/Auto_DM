import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { couponCheck, couponsApi } from './api.js';
import { reapply, release } from './rules.js';

/**
 * PRD 9.14: coupons. Percentage (with an optional cap), flat and free delivery, limited by dates, a minimum order, total
 * uses, uses per customer, products or categories, and first order only. One per order, the same whatever the case.
 *
 *   rules.js   evaluate (a quote, the code check, and again inside the order's transaction with the row locked), redeem and
 *              release. used_count <= max_uses is a database check, so simultaneous checkouts can't go over (S-47).
 *   api.js     the console's routes (coupons.*) and POST /api/store/coupons/check.
 *
 * order.cancelled releases the order's use, once; order.reinstated takes it back.
 */
export const coupons = {
  name: 'coupons',
  api: (ctx) => couponsApi(ctx),
  setup(ctx) {
    ctx.orderEvents.on('order.cancelled', 'coupons.release', async (event) => {
      await ctx.db.tx((t) => release(t, event.orderId));
    });
    // A late payment brings a cancelled order back with its discount: its use counts again (never refused; the owner is told if the code ran out).
    ctx.orderEvents.on('order.reinstated', 'coupons.reapply', async (event) => {
      const { overLimit } = await ctx.db.tx((t) => reapply(t, event.orderId));
      if (!overLimit) return;
      await ctx.repos.alerts.raise({
        kind: 'coupon.over_limit', severity: 'warning',
        message: 'An order that was brought back used a coupon code that has since been used up. The order is kept with its discount.',
        target: `order:${event.orderId}`, dedupeKey: `coupon-over-limit:${event.orderId}`,
      });
    });
  },
  routes(app, ctx) {
    app.post(STORE_ROUTES.couponCheck.path, couponCheck(ctx));
  },
};

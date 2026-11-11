import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { couponCheck, couponsApi } from './api.js';
import { release } from './rules.js';

/**
 * PRD 9.14: coupons. Percentage (with an optional cap), flat and free delivery, limited by dates, a minimum order, total
 * uses, uses per customer, products or categories, and first order only. One per order, the same whatever the case.
 *
 *   rules.js   evaluate (a quote, the code check, and again inside the order's transaction with the row locked), redeem and
 *              release. used_count <= max_uses is a database check, so simultaneous checkouts can't go over (S-47).
 *   api.js     the console's routes (coupons.*) and POST /api/store/coupons/check.
 *
 * order.cancelled releases the order's use, once.
 */
export const coupons = {
  name: 'coupons',
  api: (ctx) => couponsApi(ctx),
  setup(ctx) {
    ctx.orderEvents.on('order.cancelled', 'coupons.release', async (event) => {
      await ctx.db.tx((t) => release(t, event.orderId));
    });
  },
  routes(app, ctx) {
    app.post(STORE_ROUTES.couponCheck.path, couponCheck(ctx));
  },
};

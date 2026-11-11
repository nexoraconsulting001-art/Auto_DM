import { notBuilt } from '../not-built.js';

/**
 * PRD 9.14. Not built yet: this folder is the coupons track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): coupons, coupon_redemptions.
 * Buyer routes (src/contracts/store-routes.js): POST /api/store/coupons/check.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): order.cancelled releases the redemption.
 * Checkout calls validate() for a quote and redeem(t, ...) inside the order’s transaction: redeem locks the coupon
 * row, and used_count <= max_uses is a database check (S-47).
 */
export const coupons = {
  name: 'coupons',
  api: () => notBuilt(
    'coupons.list',
    'coupons.create',
    'coupons.get',
    'coupons.update',
    'coupons.remove',
    'coupons.stats',
  ),
};

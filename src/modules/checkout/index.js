import { legacyCheckoutPages, legacyOrderApi } from './legacy.js';
import { checkoutPages } from './pages.js';
import { checkoutRoutes } from './routes.js';

/**
 * PRD 9.5: checkout and order creation, for a business with the Phase 4 store (`store.checkout`). A business without it
 * keeps the Phase 0 checkout (legacy.js): signed-in shoppers only, manual UPI, orders of flow 'manual'.
 *
 *   GET  /checkout                   the page (pages.js): guest by default, the default address chosen for a signed-in shopper
 *   POST /api/store/checkout/quote   every amount, worked out by the server (quote.js)
 *   POST /api/store/checkout         places the order (place.js)
 *   GET  /order/:token               the order's own page: paying, waiting, confirmed, failed, cancelled
 *
 * Placing an order is one transaction: every line priced from the catalog with the product rows locked (pricing.js, S-05),
 * the same idempotency key answered with the order it made (S-15), stock held (src/modules/inventory/stock.js, S-16), the
 * coupon counted (src/modules/coupons/rules.js, S-47), the order number taken, the lines written so the database's own
 * check that they add up holds, and cash on delivery confirmed through the state machine with its stock taken at once.
 * After commit the event bus is kicked and, for an online payment, ctx.payments.start makes the gateway order.
 *
 * What other tracks provide, read when present: ctx.payments.start(orderId, { baseUrl }) for the gateway order,
 * ctx.shoppers.otps.codVerified({ phone, checkoutKey }) for the cash-on-delivery code, ctx.shoppers.addresses.create to
 * save an address, ctx.shipping.serviceable(pincode), and ctx.loyalty.preview / redeem for points.
 */
export const checkout = {
  name: 'checkout',
  routes(app, ctx) {
    app.use(checkoutRoutes(ctx));
    app.use(checkoutPages(ctx));
    app.use('/api', legacyOrderApi(ctx));
    app.use('/', legacyCheckoutPages(ctx));
  },
};

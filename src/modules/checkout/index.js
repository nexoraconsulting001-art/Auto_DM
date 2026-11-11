import { legacyCheckoutPages, legacyOrderApi } from './legacy.js';

/**
 * PRD 9.5. This folder is the checkout track's. Until it is built, the Phase 0 checkout answers (legacy.js, moved from
 * src/routes/store.js): signed-in shoppers only, manual UPI, orders of flow 'manual'.
 *
 * Buyer routes to build (src/contracts/store-routes.js): GET /checkout, POST /api/store/checkout/quote,
 * POST /api/store/checkout and GET /order/:token. Bodies are CheckoutQuote, CheckoutPlace, Quote and PlacedOrder there.
 *
 * Placing an order is one transaction (db.tx inside the business):
 *   1. Price every line from the catalog, locking the product rows. No amount comes from the client (S-05).
 *   2. The same idempotency key again answers with the order it already made (orders_idempotency_idx, S-15).
 *   3. inventory.reserve, coupons.redeem and loyalty.redeem, each re-checked here and each able to refuse (S-16, S-47, S-88).
 *   4. Take the order number (tenants.next_order_number), insert the order with flow 'checkout' and its lines. The database
 *      checks the totals against the lines and each other when the transaction commits.
 *   5. Cash on delivery, once the phone is verified: changeOrder(t, id, { payment: 'cod_due', fulfilment: 'new' }).
 *      Prepaid and part-advance stay pending and unpaid until the payments module hears from the gateway (S-68).
 *   6. platform.consent.record(..., t) for the choices made on the page (S-59).
 * The database writes order.created in the same transaction; after commit call ctx.orderEvents.kick().
 * orders.visitor_id is visitorIdFrom(req) (src/platform/visitor.js): traffic ties the visit to the order from the event.
 * The limit on attempts is platform.rateLimit with STORE_LIMITS.orderAttempts, which holds across instances (S-18).
 * Money rules are orderTotal, taxInside and splitGst in src/contracts/orders.js.
 */
export const checkout = {
  name: 'checkout',
  routes(app, ctx) {
    app.use('/api', legacyOrderApi(ctx));
    app.use('/', legacyCheckoutPages(ctx));
  },
};

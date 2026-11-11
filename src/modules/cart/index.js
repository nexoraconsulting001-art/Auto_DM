/**
 * PRD 9.2. Not built yet: this folder is the cart track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): carts, cart_lines.
 * Buyer routes (src/contracts/store-routes.js): GET /cart, GET /api/store/cart, PUT /api/store/cart.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): order.created marks the shopper’s cart ordered.
 * The bag lives in the browser; the server cart mirrors it once signed in. It holds no prices: every line is priced
 * from the catalog each time (S-05). CartLine and PricedLine are in src/contracts/store-routes.js.
 */
export const cart = {
  name: 'cart',
};

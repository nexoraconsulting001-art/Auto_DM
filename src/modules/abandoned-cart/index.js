import { notBuilt } from '../not-built.js';

/**
 * PRD 9.15. Not built yet: this folder is the abandoned-cart track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): cart_reminders.
 * Buyer routes (src/contracts/store-routes.js): GET /cart/restore/:token.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): order.created cancels the reminders of that
 * shopper’s cart.
 * At most two per time a cart is left, through ctx.shopperMessages as marketing, which holds them outside 9 pm to 9
 * am. Never an Instagram DM (S-51).
 */
export const abandonedCart = {
  name: 'abandoned-cart',
  api: () => notBuilt(
    'cartReminders.get',
    'cartReminders.update',
    'cartReminders.stats',
  ),
};

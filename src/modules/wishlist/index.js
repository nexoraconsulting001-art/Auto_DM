import { notBuilt } from '../not-built.js';

/**
 * PRD 9.20. Not built yet: this folder is the wishlist track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): wishlist_items.
 * Buyer routes (src/contracts/store-routes.js): GET /wishlist, GET /api/store/wishlist, PUT /api/store/wishlist.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): none.
 * Owners see counts per product, never who saved (S-86).
 */
export const wishlist = {
  name: 'wishlist',
  api: () => notBuilt(
    'wishlist.counts',
  ),
};

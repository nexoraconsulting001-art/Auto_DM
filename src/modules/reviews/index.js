import { notBuilt } from '../not-built.js';

/**
 * PRD 9.19. Not built yet: this folder is the reviews track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): reviews, review_photos, product_ratings.
 * Buyer routes (src/contracts/store-routes.js): POST /api/store/reviews, GET /api/store/products/:id/reviews.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): order.delivered queues the review request, through
 * the gate, as marketing.
 * Only a shopper with a delivered order of that product; one per product per order.
 */
export const reviews = {
  name: 'reviews',
  api: () => notBuilt(
    'reviews.list',
    'reviews.approve',
    'reviews.hide',
    'reviews.reply',
  ),
};

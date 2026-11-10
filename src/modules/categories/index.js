import { notBuilt } from '../not-built.js';

/**
 * PRD 8.13: each category's ordered reels, pins, schedules and auto-join rules (migration 303), and the buyer pages that show
 * the order (/c/:slug and the Reels tab, BUYER_ROUTES in src/contracts/buyer-pages.js). One stored order per category; every
 * surface reads it through this module's repo, so none keeps a copy.
 *
 * categories.list, .create, .get, .update and .remove belong to admin-api (Phase 0); replace them with takesOver(ctx).
 */
export const categories = {
  name: 'categories',
  takesOver: () => ({}),
  api: () => notBuilt(
    'categories.reorder', 'categories.reels', 'categories.setReels', 'categories.addReel', 'categories.removeReel', 'categories.pin', 'categories.unpin',
    'categories.schedule', 'categories.rules', 'categories.addRule', 'categoryRules.update', 'categoryRules.remove', 'categoryRules.apply',
  ),
};

import { pagesApi } from './api.js';
import { landingPagesRepo, pageBlocksRepo, pageSettingsRepo, sharePreviewsRepo } from './repo.js';
import { mountBuyerRoutes } from './routes.js';

export { BLOCK_SETTINGS, blockStyles, checkBlocks, renderSharedBlock } from './blocks.js';

/**
 * PRD 8.10 to 8.12 and the block layout of 5.18: a landing page per automated reel, post or story (rows of `reels`, migration
 * 302), the WhatsApp order button, share previews and robots.txt. Buyer pages are BUYER_ROUTES in src/contracts/buyer-pages.js,
 * mounted in routes(app, ctx) and drawn with the shared layout in src/views/buyer. The reels.* routes stay with admin-api.
 *
 * For other modules: repos.pageBlocks.layout(surface) is a business's blocks for any surface, renderSharedBlock draws the
 * library's blocks on it, and a module that owns a block on the landing page (the lead form) lists it as
 * buyerBlocks: { lead_form: async ({ surface, page, theme, business, req }, ctx) => html }.
 */
export const pages = {
  name: 'pages',
  repos: (db, { storage } = {}) => ({
    landingPages: landingPagesRepo(db),
    pageSettings: pageSettingsRepo(db),
    pageBlocks: pageBlocksRepo(db),
    sharePreviews: sharePreviewsRepo(db, { storage }),
  }),
  routes: (app, ctx) => mountBuyerRoutes(app, ctx),
  api: (ctx) => pagesApi(ctx ?? {}),
};

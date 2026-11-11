import { legacyStoreApi, legacyStorePages } from './legacy.js';

/**
 * PRD 9.1. This folder is the storefront track's. Until its pages are built, the Phase 0 store's browsing pages answer
 * (legacy.js, moved from src/routes/store.js): home, shop, category, product, the reels tab, the reel store, about, and the
 * store's own 404 for anything nothing else answered.
 *
 * Buyer routes to build (src/contracts/store-routes.js): GET /, /shop, /p/:productSlug, /search, /about,
 * /manifest.webmanifest, /sw.js, /offline and GET /api/store/products. Category pages and the Reels tab are the categories
 * module's (Phase 3) and already follow each category's reel order (S-65, S-66). Render with src/views/buyer; a page names
 * the seller only.
 *
 * lastRoutes runs after every module's routes, so whatever is mounted here answers only what nothing else did. Replace a
 * Phase 0 page by mounting the new one in routes(app, ctx) and removing it from legacy.js; keep a branded 404 last.
 */
export const storefront = {
  name: 'storefront',
  routes(app, ctx) {
    app.use('/api', legacyStoreApi(ctx));
  },
  lastRoutes(app, ctx) {
    app.use('/', legacyStorePages(ctx));
  },
};

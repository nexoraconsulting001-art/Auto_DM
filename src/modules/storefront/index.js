import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { storeOn } from './http.js';
import { legacyStoreApi, legacyStorePages } from './legacy.js';
import { productsLookup, storeAssets, storePages } from './pages.js';
import { sendStoreNotFound } from './shell.js';

/**
 * PRD 9.1: the storefront. A business with the Phase 4 store (`store.checkout`, tier 3 and above) gets the store's own pages
 * (pages.js): home, shop with its price filter, sort and pages, category, product, search, about, the home-screen app's
 * manifest, service worker and offline page, and GET /api/store/products for a bag that moved browsers. Every page renders
 * with src/views/buyer in the seller's brand only (shell.js). Category pages and the Reels tab stay the categories module's
 * where the plan has category sequences.
 *
 * A business without the store keeps the Phase 0 store (legacy.js) as it was.
 *
 * lastRoutes runs after every module's routes, so whatever is mounted here answers only what nothing else did, ending with
 * the store's own 404.
 */
export const storefront = {
  name: 'storefront',
  routes(app, ctx) {
    app.get(STORE_ROUTES.productsLookup.path, productsLookup(ctx));
    app.use(storeAssets(ctx));
    app.use('/api', legacyStoreApi(ctx));
  },
  lastRoutes(app, ctx) {
    app.use(storePages(ctx));
    // A store call nothing answered is JSON, like every other store call.
    app.use('/api/store', (_req, res) => res.status(404).set('Cache-Control', 'no-store').json({ error: 'There is nothing here.', code: 'not_found' }));
    // The store's own 404 for a page nothing answered, in the seller's brand.
    app.use(async (req, res, next) => {
      try {
        if (!['GET', 'HEAD'].includes(req.method) || req.path.startsWith('/api/') || !(await storeOn(ctx.repos))) return next();
        return await sendStoreNotFound(ctx, req, res, 'This page doesn’t exist.');
      } catch (err) {
        return next(err);
      }
    });
    app.use('/', legacyStorePages(ctx));
  },
};

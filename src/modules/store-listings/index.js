import { APP_PLATFORMS } from '../../contracts/accounts.js';
import { MANAGERS, isAllowed } from '../../contracts/api/access.js';
import { routes as API_ROUTES } from '../../contracts/api/index.js';
import { listingProblems } from '../../contracts/apps.js';
import { currentTenant } from '../../tenancy.js';
import { storeListingsFor } from './service.js';

export { storeListingsFor, listingTemplate, dataSafetyOf, privacyLabelsOf } from './service.js';

/**
 * What each store shows (PRD 10.13): the listing text and the images. Track store-release. Owns store_listings and
 * listing_assets (605).
 *
 *   storeListingsFor(ctx) -> { get(platform), save(platform, patch, actor), assets(platform), putAsset(platform, kind, file, meta),
 *                              template(platform) }   made once per ctx (a WeakMap)
 *
 * save() runs listingProblems (src/contracts/apps.js). STORE_LIMITS there is the stores'; the cart's STORE_LIMITS is in
 * src/contracts/orders.js, so a file that needs both imports one with an alias, as import { STORE_LIMITS as LISTING_LIMITS }
 * (a test refuses both without one). putAsset() runs checkAsset and
 * stores the file in private storage, never /media. Screenshots come from the real build only (source build_capture). The
 * listing's seller is the business's legal name (store_access.legal_name); data safety and privacy labels are prefilled from
 * DATA_COLLECTED. Nothing names the platform.
 *
 * Two routes of its own, on the business's address:
 *   GET /app-listing-assets/:id/:sig   an image of the listing; the link carries a keyed signature of the file (assets() makes it)
 *   PUT /api/v1/app-listing/:id        only to refuse, before the seller API's router does: StoreListingUpdate's lengths are the
 *                                      loosest of both stores, and the router's refusal names neither the field nor the store's
 *                                      limit. A body over a limit is answered here with listingProblems' own words; anything
 *                                      else goes on to the router, which answers it.
 */
const API = ['appListing.get', 'appListing.save', 'appListing.assets'];
const SAVE = API_ROUTES['appListing.save'];
const LONGEST = Object.fromEntries(Object.entries(SAVE.body.shape).map(([field, schema]) => [field, schema.unwrap?.().maxLength ?? schema.maxLength ?? null]));
const lengthOf = (text) => String(text ?? '').trim().length;

/** listingProblems for the fields of `body` that the seller API's schema would refuse for their length, before it does. */
export function overLongProblems(platform, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const over = Object.keys(body).filter((field) => typeof body[field] === 'string' && LONGEST[field] && lengthOf(body[field]) > LONGEST[field]);
  if (!over.length) return [];
  return listingProblems(platform, body).filter((p) => over.includes(p.field) && p.code === 'too_long');
}

export const storeListings = {
  name: 'store-listings',
  owns: { migrations: ['605_store_listings.sql'], tables: ['store_listings', 'listing_assets'], api: API, store: [], platform: [], jobs: [] },
  routes(app, ctx) {
    app.get('/app-listing-assets/:id/:sig', async (req, res, next) => {
      try {
        if (!currentTenant()) return res.status(404).type('text').send('Not found.');
        const file = await storeListingsFor(ctx).assetFile(req.params.id, req.params.sig);
        if (!file) return res.status(404).set('Cache-Control', 'no-store').type('text').send('Not found.');
        return res.status(200).set({ 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Type': file.mime }).send(file.body);
      } catch (err) {
        return next(err);
      }
    });
    app.put(`/api/v1${SAVE.path}`, (req, res, next) => {
      const platform = req.params.id;
      if (!currentTenant() || !APP_PLATFORMS.includes(platform) || !isAllowed(req.user ?? null, MANAGERS)) return next();
      const problems = overLongProblems(platform, req.body);
      if (!problems.length) return next();
      const fields = {};
      for (const p of problems) fields[p.field] ??= p.message;
      return res.status(400).set('Cache-Control', 'no-store').json({ error: problems.map((p) => p.message).join(' '), code: 'validation_failed', fields });
    });
  },
  api: (ctx) => ({
    'appListing.get': ({ params }) => storeListingsFor(ctx).get(params.id),
    'appListing.save': ({ params, body, user }) => storeListingsFor(ctx).save(params.id, body, user),
    'appListing.assets': async ({ params }) => ({ items: await storeListingsFor(ctx).assets(params.id) }),
  }),
};

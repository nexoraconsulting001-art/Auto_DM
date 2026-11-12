import { notBuilt } from '../not-built.js';

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
 */
const API = ['appListing.get', 'appListing.save', 'appListing.assets'];

export const storeListings = {
  name: 'store-listings',
  owns: { migrations: ['605_store_listings.sql'], tables: ['store_listings', 'listing_assets'], api: API, store: [], platform: [], jobs: [] },
  api: () => notBuilt(...API),
};

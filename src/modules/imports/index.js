import { notBuilt } from '../not-built.js';

/**
 * PRD 8.3 to 8.8: import by link, site adapters, the Shopify public feed, CSV and bulk paste, the quality gate and the scheduled
 * re-check (tables in migration 301). Read everything outside through ctx.platform.fetcher (src/platform/safe-fetch.js) and store
 * images with ctx.platform.images.ingest then repos.media.save. Never fetch while a shopper waits. Reasons and limits are in
 * src/contracts/catalog.js. Test against tools/sim/sites and tools/sim/shopify (config.safeFetchTransport).
 *
 * Also answers platform.siteAdapters and platform.setSiteAdapter (src/contracts/api/platform.js) in platformRoutes(router, ctx).
 */
export const imports = {
  name: 'imports',
  api: () => notBuilt(
    'imports.link', 'imports.bulk', 'imports.csv', 'imports.shopify', 'imports.list', 'imports.adapters', 'imports.get', 'imports.items',
    'importItems.save',
  ),
};

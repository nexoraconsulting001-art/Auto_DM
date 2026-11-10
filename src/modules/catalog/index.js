import { notBuilt } from '../not-built.js';

/**
 * PRD 8.1: one catalog for every page, DM and tier: products with options, variants and 1 to 6 images (tables in migration
 * 300), money in bigint paise, external_url unique per business. Rules shared with other tracks are in src/contracts/catalog.js.
 *
 * products.list, .create, .get, .update and .remove belong to admin-api (Phase 0) and are answered there from src/repos/products
 * until this module replaces them: return them from takesOver(ctx) (see src/modules/admin-api/index.js), never from api().
 * Keep the legacy columns (products.images, option_label, option_values, stock) in step while the Phase 0 store reads them.
 */
export const catalog = {
  name: 'catalog',
  takesOver: () => ({}),
  api: () => notBuilt('products.recheck', 'catalogSettings.get', 'catalogSettings.update'),
};

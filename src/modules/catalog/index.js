import { catalogHandlers, productHandlers } from './api.js';
import { catalogRepo } from './repo.js';

export { RECHECK_ONE } from './api.js';
export { buyerVisibleSql, cardPrice, isBuyerVisible, isInStock, soldOutLast } from './rules.js';

/**
 * PRD 8.1: one catalog for every page, DM and tier: products with options, variants and 1 to 6 images (tables in migration
 * 300), money in bigint paise, external_url unique per business. Rules shared with other tracks are in src/contracts/catalog.js;
 * what a buyer page may show and what a card shows are in rules.js (isBuyerVisible, buyerVisibleSql, cardPrice, soldOutLast).
 *
 * products.list, .create, .get, .update and .remove belong to admin-api (Phase 0); this module answers them through takesOver,
 * from repos.catalog. The Phase 0 columns (products.images, option_label, option_values, stock) are written alongside the
 * Phase 3 tables while the Phase 0 store reads them. The re-check itself (8.8) is read by src/modules/imports.
 */
export const catalog = {
  name: 'catalog',
  repos: (db) => ({ catalog: catalogRepo(db) }),
  takesOver: (ctx) => productHandlers(ctx),
  api: (ctx) => catalogHandlers(ctx),
};

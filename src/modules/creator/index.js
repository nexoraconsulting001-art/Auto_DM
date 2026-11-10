import { notBuilt } from '../not-built.js';

/**
 * PRD 8.14: the creator page at /<slug> and its shelves at /<slug>/<category slug> (migration 305), searchable within this
 * business only, indexable, with the first 12 tiles server-rendered. Shelves read the category order and sequences from the
 * categories module. Slugs may not be RESERVED_PATHS. The Free plan's badge (entitlements badge.made_with) is the only place
 * the platform's name may appear on a buyer page, and only on the Free plan (K-64).
 */
export const creator = {
  name: 'creator',
  api: () => notBuilt('creator.get', 'creator.update', 'creator.checkSlug'),
};

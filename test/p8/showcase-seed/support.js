import { loadShowcase } from '../../../scripts/showcase.js';
import { danglingReferences } from '../../../src/contracts/seed.js';
import { namesFor } from '../../../tools/sim/activity/seed.mjs';

/** Every sample business of the manifest, as loadShowcase reads it, with no outside catalogue. */
export const loadBoth = () => loadShowcase({ env: {} });

/**
 * A smaller copy of one loaded business, for the tests that run the whole app: its first `reels` reels, the pages and
 * automations that belong to them, and only the products and categories those name. Same seed file, same rules, fewer rows.
 */
export function trimmed(business, { reels = 1, products = 6 } = {}) {
  const seed = structuredClone(business.seed);
  const catalogue = structuredClone(business.catalogue);
  seed.reels = seed.reels.slice(0, reels);
  const keys = new Set(seed.reels.map((r) => r.key));
  seed.landingPages = seed.landingPages.filter((p) => p.reel && keys.has(p.reel));
  seed.automations = seed.automations.filter((a) => a.reel && keys.has(a.reel));
  const wanted = new Set();
  for (const item of [...seed.reels, ...seed.landingPages]) for (const name of namesFor(item, catalogue)) wanted.add(name);
  catalogue.products = catalogue.products.filter((p) => wanted.has(p.name)).slice(0, Math.max(products, 1));
  const kept = new Set(catalogue.products.map((p) => p.name));
  for (const item of [...seed.reels, ...seed.landingPages]) {
    item.products = item.products.filter((n) => kept.has(n));
    item.fill = 0;
    if (item.products.length === 0) item.products = [catalogue.products[0].name];
  }
  const categories = new Set([...catalogue.products.flatMap((p) => p.categories), ...[...seed.reels, ...seed.landingPages].flatMap((i) => i.categories)]);
  catalogue.categories = catalogue.categories.filter((c) => categories.has(c.name));
  seed.categories = seed.categories.filter((c) => categories.has(c.name));
  if (danglingReferences(seed, catalogue).length) throw new Error('The trimmed copy points at something it no longer has');
  return { ...business, seed, catalogue };
}

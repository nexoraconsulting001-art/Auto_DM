import { discountPercent, formatRupees } from '../../contracts/catalog.js';
import { buyerTheme } from './theme.js';

/**
 * The shared buyer layout (PRD 5.18), for every Phase 3 buyer page and later the store. See layout.js for the document and its
 * sections and theme.js for how a brand kit becomes its stylesheet.
 *
 *   const { theme, business, settings } = await loadBuyerLayout(repos);
 *   sendBuyerPage(res, buyerPage({ theme, business, meta, main }), { page: { kind: 'creator', ref: slug } });
 */
export * from './layout.js';
export { FALLBACK_COLORS, buyerTheme, themeCss, themeFontsHref } from './theme.js';

/** The current business's theme, its name and logo for the header, and its settings. Reads the database only. */
export async function loadBuyerLayout(repos) {
  const [settings, kit] = await Promise.all([repos.settings.getAll(), repos.brandKit.get()]);
  const theme = buyerTheme(kit);
  return { theme, business: { name: settings.store_name, logoUrl: theme.logoUrl }, settings, kit };
}

/** A card's price as text (K-03): "₹599", the MRP struck through and "-N%", or Sold out. Takes displayPrice()'s answer. */
export function priceText({ pricePaise, mrpPaise = null, soldOut = false } = {}) {
  if (pricePaise === null || pricePaise === undefined) return { now: '', was: '', off: '', soldOut };
  const off = discountPercent(pricePaise, mrpPaise);
  return { now: formatRupees(pricePaise), was: off ? formatRupees(mrpPaise) : '', off: off ? `-${off}%` : '', soldOut };
}

const PAGE_KINDS = new Set(['landing', 'category', 'product', 'store', 'link_in_bio', 'creator', 'checkout', 'other']);

/**
 * Sends a buyer page. `page` { kind, ref } is what the traffic counter records for it (src/modules/traffic reads res.locals.page),
 * needed where the address alone can't tell, such as the creator page at /<slug>. Buyer pages are never cached by a shared cache.
 */
export function sendBuyerPage(res, view, { status = 200, page = null } = {}) {
  if (page && PAGE_KINDS.has(page.kind)) res.locals.page = { kind: page.kind, ref: String(page.ref ?? '').slice(0, 200) };
  res.set('Cache-Control', 'private, no-cache');
  return res.status(status).type('html').send(String(view));
}

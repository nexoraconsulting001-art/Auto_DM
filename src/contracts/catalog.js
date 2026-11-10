/**
 * Phase 3 (PRD 8): the catalog's numbers, names and the few pure rules every track shares, in one place. No database and no
 * network here, so the console, the importers, the pages and the tests can all import it.
 *
 * Money is integer paise everywhere. Text a buyer sees is in the seller's brand and never names Bhava.
 */

export const CATALOG_LIMITS = Object.freeze({
  images: 6, // 1 to 6 per product (8.1)
  options: 3,
  optionValues: 100,
  variants: 100,
  tags: 50,
  nameLength: 120,
  descriptionLength: 5000,
  landingProducts: 20, // tier 2 and above (8.10); tier 1 is entitlements.limit('reel.products'), which is 1
  bulkLinks: 25, // per submit (8.6, to confirm)
  csvRows: 2000,
  csvBytes: 2_000_000,
  csvInlineRows: 100, // more than this runs in the background (8.6)
  recheckHours: 24, // default per business (8.8)
  recheckPerRun: 50,
  shopifyPageSize: 250, // the feed is read page by page until an empty page (8.5; page size to confirm)
  shopifyMaxPages: 100,
  mediaRefreshHours: 6, // landing page media (8.10; CDN expiry to confirm)
  storyHours: 24,
  moreReels: 6,
  creatorFirstTiles: 12, // server-rendered; the rest load on scroll (8.14)
  creatorSearchResults: 40,
  orderChangeSeconds: 60, // a new order reaches buyer pages within this (8.13, our target)
  /** One product's price above ₹100 crore is a misread page, not a price; the database refuses it (migration 300). */
  maxPricePaise: 100_000_000_000,
});

export const PRODUCT_SOURCES = Object.freeze(['manual', 'link', 'shopify', 'csv']);
export const ADAPTER_SOURCE = /^adapter:[a-z0-9-]{1,40}$/;
export const isProductSource = (value) => PRODUCT_SOURCES.includes(value) || ADAPTER_SOURCE.test(String(value));

/** none: never fetched; ok; retrying: timeout or 5xx, again next run; broken: 404 or 410, hidden; missing: gone from the feed. */
export const FETCH_STATUSES = Object.freeze(['none', 'ok', 'retrying', 'broken', 'missing']);
/** What lands a product in "Needs attention" (8.5, 8.8). */
export const NEEDS_ATTENTION = Object.freeze(['broken', 'missing']);
/** Fields the owner edited by hand, which a re-import never overwrites (8.5). */
export const OWNER_EDITABLE = Object.freeze(['name', 'description', 'images', 'categories', 'tags', 'options']);

export const IMPORT_KINDS = Object.freeze(['link', 'bulk', 'csv', 'shopify', 'adapter']);
export const IMPORT_JOB_STATUSES = Object.freeze(['queued', 'running', 'done', 'failed']);
export const IMPORT_ITEM_STATUSES = Object.freeze(['pending', 'draft', 'created', 'updated', 'unchanged', 'existing', 'refused', 'failed', 'archived']);
/** Where a draft's data came from, in the 8.3 order: adapter, Shopify JSON, JSON-LD, Open Graph, then the page title. */
export const IMPORT_READ_FROM = Object.freeze(['adapter', 'shopify', 'json_ld', 'open_graph', 'title', 'csv', 'feed']);
export const CSV_COLUMNS = Object.freeze(['title', 'url', 'price', 'mrp', 'images', 'category', 'sku', 'in_stock', 'options']);

/**
 * Why an import item was refused or failed, with what the owner is told. The quality gate's reasons (8.7) first, then the
 * fetcher's (src/platform/safe-fetch.js FETCH_ERRORS has the same codes), then the importers'.
 */
export const IMPORT_REASONS = Object.freeze({
  homepage: 'This looks like the homepage, not a product.',
  title_only: 'Only the page title was found. Add the details yourself.',
  site_name: 'The title is just the shop’s name. Add the product details yourself.',
  no_title: 'We couldn’t find a product name on that page.',
  no_price_or_image: 'We found a name but no price or product photo.',
  blocked: 'That address isn’t a public website',
  too_many_redirects: 'Too many redirects',
  timeout: 'That site took too long to answer. Add the details yourself.',
  too_large: 'That page is too large to read.',
  wrong_type: 'That address didn’t give us a product page.',
  http_status: 'That page answered with an error.',
  network: 'We couldn’t reach that site.',
  host_busy: 'That site is busy; we’ll try again shortly.',
  adapter_error: 'That site’s product service didn’t answer properly.',
  feed_unavailable: 'We couldn’t read this store’s product list. Paste product links or upload a CSV instead.',
  too_many_links: `Paste up to ${CATALOG_LIMITS.bulkLinks} links at a time.`,
  bad_row: 'This row couldn’t be read.',
  bad_price: 'The price isn’t a valid amount.',
  negative_price: 'The price can’t be negative.',
  mrp_below_price: 'MRP can’t be lower than the price',
  duplicate: 'This product is already in your catalog.',
  too_many_rows: `Upload up to ${CATALOG_LIMITS.csvRows} rows at a time.`,
  file_too_large: 'Upload a file of 2 MB or less.',
  not_utf8: 'Save the file as UTF-8 and upload it again.',
});
export const IMPORT_REASON_CODES = Object.freeze(Object.keys(IMPORT_REASONS));

/** The refusal for a feature the plan lacks (K-41, K-59): an ApiError('forbidden', message, { reason: PLAN_REASON }). */
export const PLAN_REASON = 'plan.not_included';

export class CatalogRuleError extends Error {
  constructor(code, field) {
    super(IMPORT_REASONS[code] ?? code);
    this.name = 'CatalogRuleError';
    this.code = code;
    this.field = field;
  }
}

// ---- money ----------------------------------------------------------------------------------------------------------

/**
 * Rupees as people and sites write them, in paise: 1299, "1299", "1,299", "₹1,299.00", "Rs. 1,299", "INR 1299", "1299/-",
 * "1,29,900.50". Null for blank. Throws CatalogRuleError('negative_price') or ('bad_price') for anything else. No floating
 * point: the paise are read from the digits.
 */
export function parseRupees(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new CatalogRuleError('bad_price');
    if (input < 0) throw new CatalogRuleError('negative_price');
    return parseRupees(input.toFixed(2));
  }
  let text = String(input).trim().replace(/^﻿/, '');
  if (text === '') return null;
  text = text.replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/\s*\/-$/, '').replace(/\s+/g, '');
  if (/^-/.test(text) || /^\(.*\)$/.test(text)) throw new CatalogRuleError('negative_price');
  if (!/^\d{1,3}(,\d{2,3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(text)) throw new CatalogRuleError('bad_price');
  const [whole, fraction = ''] = text.replace(/,/g, '').split('.');
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(paise) || paise > CATALOG_LIMITS.maxPricePaise) throw new CatalogRuleError('bad_price');
  return paise;
}

/** "₹1,299" or "₹1,299.50", with Indian digit grouping. */
export function formatRupees(paise) {
  const value = Math.round(Number(paise));
  const rupees = Math.floor(Math.abs(value) / 100);
  const rest = Math.abs(value) % 100;
  const digits = String(rupees);
  const grouped = digits.length > 3 ? `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}` : digits;
  return `${value < 0 ? '-' : ''}₹${grouped}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/**
 * The MRP to store: null when there is none or it equals the price (an MRP is shown only above the price, struck through).
 * One below the price is refused (K-02).
 */
export function checkMrp(pricePaise, mrpPaise) {
  if (mrpPaise === null || mrpPaise === undefined) return null;
  if (mrpPaise < pricePaise) throw new CatalogRuleError('mrp_below_price', 'mrpPaise');
  return mrpPaise > pricePaise ? mrpPaise : null;
}

/** The whole-number percentage off, for the "-N%" beside a struck-through MRP; null when there is no discount. */
export function discountPercent(pricePaise, mrpPaise) {
  if (!mrpPaise || mrpPaise <= pricePaise) return null;
  return Math.round(((mrpPaise - pricePaise) * 100) / mrpPaise);
}

/**
 * The price a card shows (K-03): the lowest in-stock variant's, with that variant's MRP. With no variant in stock, the lowest
 * variant's and soldOut. With no variants, the product's own. `product` and `variants` use the database's column names.
 */
export function displayPrice(product, variants = []) {
  if (!variants.length) return { pricePaise: Number(product.price_paise), mrpPaise: product.mrp_paise === null || product.mrp_paise === undefined ? null : Number(product.mrp_paise), soldOut: product.in_stock === false };
  const inStock = variants.filter((v) => v.in_stock);
  const pool = inStock.length ? inStock : variants;
  const best = pool.reduce((a, b) => (Number(b.price_paise) < Number(a.price_paise) ? b : a));
  return { pricePaise: Number(best.price_paise), mrpPaise: best.mrp_paise === null || best.mrp_paise === undefined ? null : Number(best.mrp_paise), soldOut: inStock.length === 0 };
}

/** A bigint column as a number. Both database drivers give a number already; this keeps a stray string or BigInt honest. */
export function paiseFromDb(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError('A money amount is out of range');
  return n;
}

// ---- addresses ------------------------------------------------------------------------------------------------------

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|igshid|mc_[a-z]+|_ga|ref|ref_src|srsltid|variant)$/i;

/**
 * The form of a product address that makes two pastes of one page the same product (K-11): lower-case scheme and host, no
 * www, no default port, no fragment, no tracking parameters, no trailing slash. Null when it isn't an http(s) address.
 * `variant` is dropped too: a Shopify variant link opens its product.
 */
export function canonicalProductUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  let href = url.href;
  if (url.pathname !== '/' && href.endsWith('/') && !url.search) href = href.slice(0, -1);
  return href.length <= 2000 ? href : null;
}

/** True when the address is a site's root rather than a product (8.7: refused). */
export function isSiteRoot(input) {
  try {
    const url = new URL(String(input));
    return (url.pathname === '/' || url.pathname === '') && !url.search;
  } catch {
    return false;
  }
}

// ---- the WhatsApp order button (8.11) -------------------------------------------------------------------------------

/** A saved number in international digits: "+91 93200 01717" is 919320001717 (K-36). Null when it can't be one. */
export function whatsappDigits(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

const WHATSAPP_VARIABLES = Object.freeze(['product', 'price', 'url']);

/** The prefill with {product}, {price} and {url} filled in; any other {name} stays as written. */
export function fillWhatsappText(template, values) {
  return String(template).replace(/\{([a-z_]+)\}/gi, (whole, name) => (WHATSAPP_VARIABLES.includes(name) && Object.hasOwn(values, name) ? String(values[name]) : whole));
}

/**
 * The button's address, straight to wa.me with no redirect and no UTM (K-35 to K-37). `url` is the landing page address with no
 * token or tracking. Null when there is no usable number, so the button isn't shown.
 */
export function whatsappOrderLink({ number, template, productName, pricePaise, url }) {
  const digits = whatsappDigits(number);
  if (!digits) return null;
  const text = fillWhatsappText(template, { product: productName, price: pricePaise === null || pricePaise === undefined ? '' : formatRupees(pricePaise), url });
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** The click beacon's target for a WhatsApp tap on a product (8.11). */
export const whatsappTarget = (productId) => `wa-${productId}`;

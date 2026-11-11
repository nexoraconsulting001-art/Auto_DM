/**
 * The parts of the Phase 3 contract (src/contracts/catalog.js, themes.js, buyer-pages.js and the route files) the console's screens
 * need. The console may import nothing from outside console/src but the access rules, so these are the server's values written out
 * here, and test/p3/console/screens.test.js fails the moment one differs from the server's own copy. Change them there first.
 */
export const PLAN_REASON = 'plan.not_included';

export const CATALOG = Object.freeze({
  images: 6,
  options: 3,
  optionValues: 100,
  variants: 100,
  tags: 50,
  nameLength: 120,
  descriptionLength: 5000,
  landingProducts: 20,
  bulkLinks: 25,
  csvRows: 2000,
  csvBytes: 2_000_000,
  recheckHours: 24,
});

/** The largest amount one price field takes (the API's PaiseInput). */
export const MAX_PAISE = 2_147_483_647;

export const FETCH_STATUSES = Object.freeze(['none', 'ok', 'retrying', 'broken', 'missing']);
export const NEEDS_ATTENTION = Object.freeze(['broken', 'missing']);
export const PRODUCT_STATUSES = Object.freeze(['all', 'active', 'archived', 'featured', 'attention', 'sold_out', 'price_changed']);
export const PRODUCT_SOURCES = Object.freeze(['manual', 'link', 'shopify', 'csv', 'adapter']);

export const IMPORT_JOB_STATUSES = Object.freeze(['queued', 'running', 'done', 'failed']);
export const IMPORT_ITEM_STATUSES = Object.freeze(['pending', 'draft', 'created', 'updated', 'unchanged', 'existing', 'refused', 'failed', 'archived']);
export const CSV_COLUMNS = Object.freeze(['title', 'url', 'price', 'mrp', 'images', 'category', 'sku', 'in_stock', 'options']);
export const CSV_TYPES = Object.freeze(['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/csv', 'application/octet-stream']);

export const LANDING_KINDS = Object.freeze(['reel', 'post', 'story']);
export const PAGE_SURFACES = Object.freeze(['landing', 'creator', 'store_home']);
export const LEAD_SURFACES = Object.freeze(['landing', 'creator', 'store']);
export const LEAD_SOURCES = Object.freeze(['landing', 'creator', 'store', 'bio']);
export const CONSENT_CHANNELS = Object.freeze(['whatsapp', 'sms', 'email', 'call']);
export const RULE_MATCHES = Object.freeze(['caption_keyword', 'hashtag', 'product_category']);

/** Which block may sit on which page, and the settings it takes (BUYER_BLOCKS). */
export const BLOCKS = Object.freeze({
  hero: { surfaces: ['landing', 'creator', 'store_home'], settings: [] },
  ticker: { surfaces: ['landing', 'creator', 'store_home'], settings: [] },
  products: { surfaces: ['landing'], settings: [] },
  more_reels: { surfaces: ['landing'], settings: [] },
  shelves: { surfaces: ['creator', 'store_home'], settings: [] },
  lead_form: { surfaces: ['landing', 'creator', 'store_home'], settings: [] },
  trust: { surfaces: ['landing', 'store_home'], settings: ['items'] },
  banner: { surfaces: ['store_home', 'creator'], settings: ['text', 'imageUrl', 'linkUrl'] },
  countdown: { surfaces: ['store_home', 'landing'], settings: ['text', 'endsAt'] },
  testimonials: { surfaces: ['store_home'], settings: ['items'] },
  faq: { surfaces: ['store_home', 'landing'], settings: ['items'] },
  video: { surfaces: ['store_home'], settings: ['url'] },
  bulk_order: { surfaces: ['store_home'], settings: ['text'] },
  whatsapp: { surfaces: ['landing', 'creator', 'store_home'], settings: [] },
});
export const DEFAULT_BLOCKS = Object.freeze({
  landing: ['hero', 'ticker', 'products', 'lead_form', 'more_reels', 'trust', 'whatsapp'],
  creator: ['hero', 'shelves', 'lead_form', 'whatsapp'],
  store_home: ['hero', 'ticker', 'shelves', 'trust', 'whatsapp'],
});

export const THEME_TEXT = Object.freeze({ sealText: 60, tickerItems: 8, tickerItem: 40 });

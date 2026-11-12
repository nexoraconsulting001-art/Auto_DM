/**
 * Pure: the parts of the catalog contract (src/contracts/catalog.js and the route files) the owner app's catalog screens
 * need. The app may import nothing from src but the access rules, so these are the server's values written out, and
 * test/p5/app-insights-catalog fails the moment one differs from the server's own. Change them there first.
 */
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
  csvBytes: 2_000_000,
});

export const FETCH_STATUSES = Object.freeze(['none', 'ok', 'retrying', 'broken', 'missing']);
/** A product whose page or feed entry is gone: hidden from shoppers until the owner acts (8.5, 8.8). */
export const NEEDS_ATTENTION = Object.freeze(['broken', 'missing']);
export const PRODUCT_STATUSES = Object.freeze(['all', 'active', 'attention', 'price_changed', 'sold_out', 'featured', 'archived']);
export const PRODUCT_SOURCES = Object.freeze(['manual', 'link', 'shopify', 'csv', 'adapter']);

/** Categories (8.13): how a reel joins by rule, and why one shows nowhere right now. */
export const RULE_MATCHES = Object.freeze(['caption_keyword', 'hashtag', 'product_category']);
export const HIDDEN_REASONS = Object.freeze(['inactive', 'no_active_products', 'before_window', 'after_window']);

/** Landing pages (8.10) and the business's blocks per surface (5.18, F-105). */
export const LANDING_KINDS = Object.freeze(['reel', 'post', 'story']);
export const PAGE_SURFACES = Object.freeze(['landing', 'creator', 'store_home']);
export const BLOCK_SURFACES = Object.freeze({
  hero: ['landing', 'creator', 'store_home'],
  ticker: ['landing', 'creator', 'store_home'],
  products: ['landing'],
  more_reels: ['landing'],
  shelves: ['creator', 'store_home'],
  lead_form: ['landing', 'creator', 'store_home'],
  trust: ['landing', 'store_home'],
  banner: ['store_home', 'creator'],
  countdown: ['store_home', 'landing'],
  testimonials: ['store_home'],
  faq: ['store_home', 'landing'],
  video: ['store_home'],
  bulk_order: ['store_home'],
  whatsapp: ['landing', 'creator', 'store_home'],
});

/** Leads (8.15): the ways a lead may be contacted, and the surfaces a form can sit on. */
export const CONSENT_CHANNELS = Object.freeze(['whatsapp', 'sms', 'email', 'call']);
export const LEAD_SURFACES = Object.freeze(['landing', 'creator', 'store']);
export const LEAD_SOURCES = Object.freeze(['landing', 'creator', 'store', 'bio']);

/** Reports and downloads (7.9, 7.12). The fixed sheets need no query; explore, funnel and cohort files start on their screens. */
export const DOWNLOAD_FORMATS = Object.freeze(['csv', 'xlsx']);
export const FIXED_DOWNLOADS = Object.freeze(['account_daily', 'media', 'story_finals', 'content_funnel', 'health_history']);
export const REPORT_KINDS = Object.freeze(['weekly', 'monthly', 'scheduled']);
export const REPORT_FREQUENCIES = Object.freeze(['daily', 'weekly', 'monthly']);

/** The creator page's slug: 2 to 40 lower-case letters, numbers and dashes (creator.js); a landing page's up to 60. */
export const CREATOR_SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const PAGE_SLUG = /^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/;
/** A brand kit colour (brand-kit.js). */
export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
/** The theme's seal and ticker (themes.js): SEAL_TEXT_MAX, TICKER_ITEMS_MAX, TICKER_ITEM_LENGTH. */
export const THEME_TEXT = Object.freeze({ sealMax: 60, tickerItems: 8, tickerItemLength: 40 });

/** Imports (8.3 to 8.8): what a job and each of its lines can be. */
export const IMPORT_JOB_STATUSES = Object.freeze(['queued', 'running', 'done', 'failed']);
export const IMPORT_ITEM_STATUSES = Object.freeze(['pending', 'draft', 'created', 'updated', 'unchanged', 'existing', 'refused', 'failed', 'archived']);

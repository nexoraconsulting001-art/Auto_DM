/**
 * The buyer pages Phase 3 adds (PRD 8.10 to 8.15), on each business's own host. Server-rendered with the one shared layout
 * (src/views/buyer), in the seller's brand only, with no Bhava name, logo or link in the HTML or headers (5.18, K-34, K-52).
 * Each is mounted by its owner module in routes(app, ctx), which runs inside the business, after the traffic module (so
 * visits and taps are counted with no change to the page) and before the Phase 0 store. A path that finds nothing calls
 * next() only where the Phase 0 store still answers it; otherwise it answers the branded 404 (src/views/buyer notFoundPage).
 *
 * Every link a page renders is direct (4.11, 6.6): the landing page itself, a product or site URL, wa.me. There is no
 * redirect, shortener or /go/ hop, and /l/ and /go/ are retired.
 *
 *   id               method  path                          owner     page kind     indexable
 */
export const BUYER_ROUTES = Object.freeze({
  /** The DM link: 200, never a redirect (K-32). Knows the media from its UTM tags. */
  landing: Object.freeze({ method: 'GET', path: '/r/:slug', owner: 'pages', kind: 'landing', indexable: false }),
  /** A product inside a landing page (the Phase 0 store keeps answering it until tier 3 moves). */
  landingProduct: Object.freeze({ method: 'GET', path: '/r/:slug/p/:productSlug', owner: 'pages', kind: 'product', indexable: false }),
  /** The category page: that category's reels in its set order (8.13), then its products. */
  category: Object.freeze({ method: 'GET', path: '/c/:slug', owner: 'categories', kind: 'category', indexable: false }),
  /** The Reels tab: a chip per category in category order, "All" first (8.13). ?c=<category slug> picks a chip. */
  reels: Object.freeze({ method: 'GET', path: '/reels', owner: 'categories', kind: 'store', indexable: false }),
  /** The creator page and one of its shelves (8.14). Indexable, unlike every other page here. ?q= searches this page only. */
  creator: Object.freeze({ method: 'GET', path: '/:creator', owner: 'creator', kind: 'creator', indexable: true }),
  creatorShelf: Object.freeze({ method: 'GET', path: '/:creator/:shelf', owner: 'creator', kind: 'creator', indexable: true }),
  /** The tiles after the first 12, as HTML fragments for the page's own script (8.14). */
  creatorTiles: Object.freeze({ method: 'GET', path: '/:creator/_tiles', owner: 'creator', kind: 'other', indexable: false }),
  /** The lead form posts here and answers the branded thank-you page or the form again with its errors (8.15). */
  leadSubmit: Object.freeze({ method: 'POST', path: '/lead', owner: 'leads', kind: 'other', indexable: false }),
  leadThanks: Object.freeze({ method: 'GET', path: '/lead/thanks', owner: 'leads', kind: 'other', indexable: false }),
  /** A shopper withdrawing consent (9.18 owns the rules; 8.15 needs the door). */
  leadOptOut: Object.freeze({ method: 'GET', path: '/lead/opt-out', owner: 'leads', kind: 'other', indexable: false }),
  /** robots.txt: allows facebookexternalhit, and everything noindex by default except the creator page (8.12). */
  robots: Object.freeze({ method: 'GET', path: '/robots.txt', owner: 'pages', kind: 'other', indexable: false }),
});

/**
 * First path segments the app already uses, so no creator page can take one (the creator page is /<slug>). Lower case;
 * compare after lower-casing. Later phases add theirs here.
 */
export const RESERVED_PATHS = Object.freeze([
  'admin', 'api', 'login', 'logout', 'signup', 'account', 'static', 'media', 'webhook', 'health', 'healthz', 'readyz', 'metrics',
  'oauth', 'meta', 'tls', 'report-files', 'reporting', '_t', 'r', 'p', 'c', 'l', 'go', 'shop', 'reels', 'about', 'checkout', 'order',
  'orders', 'products', 'cart', 'bio', 'creator', 'lead', 'leads', 'robots.txt', 'favicon.ico', 'sitemap.xml', 'search', 'privacy',
  'terms', 'help', 'support', 'contact', 'bhava', 'www', 'app', 'edge', 'well-known', '.well-known',
]);
export const isReservedPath = (segment) => RESERVED_PATHS.includes(String(segment ?? '').toLowerCase());

/** The surfaces that share the layout and its blocks (5.18), as page_blocks.surface and lead_forms.surface use them. */
export const PAGE_SURFACES = Object.freeze(['landing', 'creator', 'store_home']);
export const LEAD_SURFACES = Object.freeze(['landing', 'creator', 'store']);

/**
 * The block library (5.18 level 3): code shared by every business, placed and ordered per business in page_blocks. Each block
 * lists the surfaces it may sit on and its settings, which the owning module validates before saving. A new block is code
 * once for all; a business turning it on is data (F-98, F-99).
 */
export const BUYER_BLOCKS = Object.freeze({
  hero: Object.freeze({ surfaces: ['landing', 'creator', 'store_home'], settings: [] }),
  ticker: Object.freeze({ surfaces: ['landing', 'creator', 'store_home'], settings: [] }),
  products: Object.freeze({ surfaces: ['landing'], settings: [] }),
  more_reels: Object.freeze({ surfaces: ['landing'], settings: [] }),
  shelves: Object.freeze({ surfaces: ['creator', 'store_home'], settings: [] }),
  lead_form: Object.freeze({ surfaces: ['landing', 'creator', 'store_home'], settings: [] }),
  trust: Object.freeze({ surfaces: ['landing', 'store_home'], settings: ['items'] }),
  banner: Object.freeze({ surfaces: ['store_home', 'creator'], settings: ['text', 'imageUrl', 'linkUrl'] }),
  countdown: Object.freeze({ surfaces: ['store_home', 'landing'], settings: ['text', 'endsAt'] }),
  testimonials: Object.freeze({ surfaces: ['store_home'], settings: ['items'] }),
  faq: Object.freeze({ surfaces: ['store_home', 'landing'], settings: ['items'] }),
  video: Object.freeze({ surfaces: ['store_home'], settings: ['url'] }),
  bulk_order: Object.freeze({ surfaces: ['store_home'], settings: ['text'] }),
  whatsapp: Object.freeze({ surfaces: ['landing', 'creator', 'store_home'], settings: [] }),
});

/** Each surface's sections when a business has placed none: the same order in every preset (F-105). */
export const DEFAULT_BLOCKS = Object.freeze({
  landing: Object.freeze(['hero', 'ticker', 'products', 'lead_form', 'more_reels', 'trust', 'whatsapp']),
  creator: Object.freeze(['hero', 'shelves', 'lead_form', 'whatsapp']),
  store_home: Object.freeze(['hero', 'ticker', 'shelves', 'trust', 'whatsapp']),
});

/** UTM the creator page adds to its own links (8.14): every visit from it counts as source bio. */
export const BIO_UTM = Object.freeze({ utm_source: 'instagram', utm_medium: 'bio' });

/** Crawlers that fetch a page to show its preview (8.12). Their fetch is never a visit (K-38, K-53). */
export const PREVIEW_CRAWLERS = /facebookexternalhit|facebookcatalog|meta-externalagent|twitterbot|whatsapp|linkedinbot|slackbot|telegrambot|discordbot|googlebot|bingbot/i;

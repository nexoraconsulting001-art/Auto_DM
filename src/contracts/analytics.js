/**
 * Analytics, traffic and Reach Guard (PRD 7): the numbers, names and catalogues every Phase 2 track shares. Plain data, so
 * the console can use it too. A value here is the only copy: a live check that corrects one changes one line.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Every figure carries exactly one of these (PRD 7.15), and figures from different sources are never summed. */
export const SOURCE_LABELS = Object.freeze({
  bhava: 'Measured by Bhava',
  platform: 'From Instagram/Facebook',
  destination: 'From the destination',
});
export const SOURCE_LABEL_CODES = Object.freeze(Object.keys(SOURCE_LABELS));

/** What a screen says instead of a number. Never an estimate, and never 0 in place of "we don't know". */
export const FIGURE_TEXT = Object.freeze({
  noData: 'No data',
  notCollected: 'Not collected',
  notAvailableForLink: 'not available for this link type',
  lowVolume: 'low volume',
  mayChange: 'may still change',
  belowFive: '<5',
  estimated: 'Figures from Instagram, may be revised',
  viewsColumn: 'Views (replaces impressions)',
  fewFollowers: 'Available once you reach 100 followers',
  notEnoughPosts: 'Not enough posts yet',
  ownerOnly: 'Owner only.',
  needsTier3: 'Needs tier 3',
  suggested: 'Suggested',
});

export const CONTENT_KINDS = Object.freeze(['feed', 'reel', 'carousel', 'story']);
export const STORY_FINAL_STATES = Object.freeze(['open', 'final', 'final_incomplete']);
export const STORY_TRACKING = Object.freeze(['edge', 'seen_only', 'not_tracked']);

/** PRD 7.1 to 7.3, 7.5 to 7.8, 7.9 to 7.13 and the 4.3 table row 20. */
export const ANALYTICS_LIMITS = Object.freeze({
  // What Meta keeps and how late it is (4.3 row 20).
  metaDataDelayMs: 48 * HOUR,
  accountRetentionDays: 90,
  mediaRetentionDays: 730,
  storyLifeMs: DAY,
  accountRangeDays: 30, // the longest since..until one account request may span (Meta's limit, to confirm)
  mediaHistoryDays: 730,

  // The cache (7.1).
  rangePresetsDays: Object.freeze([7, 28, 90]),
  mayChangeDays: 2,
  minFollowersForDemographics: 100,
  demographicsTimeframes: Object.freeze(['this_week', 'this_month']),

  // The schedule (7.3, 7.8).
  accountEveryMs: DAY,
  accountRefetchDays: 3,
  demographicsEveryMs: 7 * DAY,
  mediaYoungUnderMs: 48 * HOUR,
  mediaYoungEveryMs: 3 * HOUR,
  mediaMidUnderMs: 30 * DAY,
  mediaMidEveryMs: DAY,
  mediaOldEveryMs: 7 * DAY,
  storyEveryMs: 2 * HOUR,
  storyFinalFromMs: 22 * HOUR,
  storyFinalToMs: 23.5 * HOUR,
  refreshNowEveryMs: 15 * MINUTE,
  pollLeaseMs: 10 * MINUTE,
  maxJobStartsPerMinuteShare: 0.1,

  // The funnel and rankings (7.4, 7.5).
  lowVolumeDenominator: 20,
  orderAttributionWindowMs: 7 * DAY,
  bestTimeMinPosts: 20,
  bestTimeWindowDays: 90,

  // Reach Guard (7.6). Thresholds are percentages of baseline.
  settleDays: 2,
  baselineDays: 28,
  baselineMedia: 10,
  learningMinSettledDays: 14,
  learningMinMedia: 5,
  tripConsecutiveDays: 3,
  tripConsecutiveMedia: 3,
  clearConsecutiveDays: 3,
  reachDropPercent: Object.freeze({ default: 60, min: 40, max: 80 }),
  mediaDropPercent: Object.freeze({ default: 50, min: 30, max: 70 }),
  clearPercent: Object.freeze({ default: 80, min: 60, max: 95 }),

  // Account Health (7.7).
  healthHistoryDays: 90,
  healthGoodFrom: 80,
  healthWatchFrom: 50,

  // Traffic (7.10).
  sessionIdleMs: 30 * MINUTE,
  visitorCookieDays: 395,
  rawEventDays: 395,
  rollupDays: 762,
  realtimeWindowMs: 30 * MINUTE,
  realtimeRefreshMs: 15_000,

  // Explore and exports (7.11, 7.13).
  exploreMaxBreakdowns: 2,
  explorePageRows: 100,
  exploreTargetMs: 3000,
  downloadBackgroundOverRows: 50_000,
  downloadExpiryDays: 7,
  apiRequestsPerMinute: 60,

  // Funnels (7.12).
  funnelMinSteps: 2,
  funnelMaxSteps: 8,
  funnelMinWindowMinutes: 30,
  funnelMaxWindowMinutes: 7 * 24 * 60,
  cohortLowVolume: 20,

  // Tags (7.14).
  tagAlertAfterFailedDays: 3,
});

/** Reach Guard's states (7.6). 80002 sets watch; denied insights set permission_needed. */
export const REACH_GUARD_STATES = Object.freeze(['learning', 'normal', 'watch', 'tripped', 'permission_needed']);
export const REACH_TRIP_TRIGGERS = Object.freeze(['reach_days', 'media_24h']);
export const HEALTH_BANDS = Object.freeze(['good', 'watch', 'at_risk']);

/** Each deduction (7.7), with its points. score_zero means the score is 0 whatever else is true. */
export const HEALTH_DEDUCTIONS = Object.freeze({
  token_14d: -10,
  token_3d: -20,
  token_refresh_failed: -30,
  token_rejected: 'score_zero',
  api_errors_5: -15,
  api_errors_20: -30,
  usage_75: -10,
  buc_80002: -25,
  scope_missing: -30,
  no_webhooks_72h: -15,
  reach_guard_tripped: -20,
  messaging_policy: -30,
});

// ---- what is asked of Meta (7.1 to 7.3, 7.5) ---------------------------------------------------------------------------

/**
 * Meta's metric names, in one place so a live check changes one line. Never impressions, and do not build on profile_views or website_clicks.
 * A metric in `breakdowns` must be asked for alone, in its own request. Carousels ask on the album id only, with the feed set (to confirm).
 */
const MEDIA_BASE_METRICS = Object.freeze(['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'reposts', 'follows', 'profile_visits', 'profile_activity']);
export const META_METRICS = Object.freeze({
  accountDaily: Object.freeze(['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'reposts']),
  accountBreakdowns: Object.freeze({
    contact_button_type: Object.freeze(['profile_links_taps']),
    follow_type: Object.freeze(['follows_and_unfollows']),
    media_product_type: Object.freeze(['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'replies', 'total_interactions']),
  }),
  demographics: Object.freeze(['follower_demographics', 'engaged_audience_demographics']),
  demographicBreakdowns: Object.freeze(['age', 'gender', 'city', 'country']),
  feed: MEDIA_BASE_METRICS,
  carousel: MEDIA_BASE_METRICS,
  reel: Object.freeze([...MEDIA_BASE_METRICS, 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate', 'crossposted_views']),
  story: Object.freeze(['views', 'reach', 'replies', 'shares', 'follows', 'profile_visits', 'total_interactions', 'reposts', 'link_clicks', 'profile_activity', 'navigation']),
  breakdowns: Object.freeze({ profile_activity: 'action_type', navigation: 'story_navigation_action_type' }),
  estimated: Object.freeze(['views', 'reach', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate', 'crossposted_views']),
});

// ---- traffic (7.10) --------------------------------------------------------------------------------------------------

/** Where a session came from, in the order the first hit is read: UTM tags (6.6), src, referrer domain, then direct. */
export const TRAFFIC_SOURCES = Object.freeze([
  'instagram_comment_dm', 'story_reply', 'story_mention', 'dm_keyword', 'bio_link',
  'facebook_dm', 'facebook_comment', 'facebook_post', 'facebook_bio', 'whatsapp', 'direct', 'other_referrer',
]);
export const DEVICE_TYPES = Object.freeze(['mobile', 'tablet', 'desktop', 'other']);
export const IN_APP_BROWSERS = Object.freeze(['instagram', 'facebook', 'other_in_app', 'browser']);
export const VISITOR_TYPES = Object.freeze(['new', 'returning', 'unknown']);
export const PAGE_KINDS = Object.freeze(['landing', 'category', 'product', 'store', 'link_in_bio', 'creator', 'checkout', 'other']);
export const TRAFFIC_EVENT_NAMES = Object.freeze([
  'page_view', 'landing_view', 'category_view', 'product_view', 'product_tap', 'outbound_tap', 'whatsapp_tap',
  'add_to_cart', 'checkout_started', 'payment_success', 'order', 'link_tap',
]);
export const PREVIEW_KINDS = Object.freeze(['owner_preview', 'team', 'bot', 'crawler']);

/** The beacon and any script, on the seller's own domain (7.10). No platform name in a path, cookie or file name. */
export const TRAFFIC_PATHS = Object.freeze({ event: '/_t/e', script: '/_t/s.js' });
export const VISITOR_COOKIE = '_vid';

// ---- the Bhava funnel (7.4, 7.15) --------------------------------------------------------------------------------------

export const FUNNEL_STAGES = Object.freeze(['comments', 'dms', 'seen', 'taps_or_visits', 'sales']);
export const FUNNEL_ORIGINS = Object.freeze(['automation', 'two_tap', 'bhava_page', 'utm', 'shopify', 'amazon', 'affiliate', 'discount_code', 'bhava_store']);
export const LINK_TYPES_MEASURED = Object.freeze(['bhava_page', 'seller_site', 'amazon', 'affiliate', 'whatsapp']);
export const LINK_MODES = Object.freeze(['one_tap', 'two_tap']);
export const DESTINATION_SOURCES = Object.freeze(['ga4', 'site_tag', 'shopify', 'amazon', 'affiliate', 'discount_code']);

/**
 * The 7.15 table: what the "Taps or visits" and "Sales" steps can show, by link type and mode. A cell is the origin of the figure, or
 * null for "not available for this link type". `when` names what must also be connected, or the cell is null.
 */
export const FUNNEL_MEASUREMENT = Object.freeze({
  bhava_page: { one_tap: Object.freeze({ origin: 'bhava_page', source: 'bhava' }), two_tap: Object.freeze({ origin: 'two_tap', source: 'bhava' }), sales: Object.freeze(['bhava_store']) },
  seller_site: { one_tap: Object.freeze({ origin: 'utm', source: 'destination', when: Object.freeze(['ga4', 'site_tag']) }), two_tap: Object.freeze({ origin: 'two_tap', source: 'bhava' }), sales: Object.freeze(['shopify', 'discount_code']) },
  amazon: { one_tap: null, two_tap: Object.freeze({ origin: 'two_tap', source: 'bhava' }), sales: Object.freeze(['amazon']) },
  affiliate: { one_tap: null, two_tap: Object.freeze({ origin: 'two_tap', source: 'bhava' }), sales: Object.freeze(['affiliate']) },
  whatsapp: { one_tap: null, two_tap: Object.freeze({ origin: 'two_tap', source: 'bhava' }), sales: Object.freeze(['discount_code']) },
});

// ---- rollup stores: the shape of src/platform/analytics.js rollups --------------------------------------------------------

const SESSION_DIMENSIONS = Object.freeze(['source', 'referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'media_id', 'landing_page', 'device', 'os', 'browser', 'in_app', 'city', 'state', 'visitor_type']);
const WHEN = Object.freeze(['day', 'hour', 'weekday']);
const TRAFFIC_COUNTERS = Object.freeze(['page_views', 'landing_views', 'category_views', 'product_views', 'product_taps', 'outbound_taps', 'whatsapp_taps', 'add_to_cart', 'checkout_started', 'payment_success', 'orders', 'revenue_paise']);

const sum = (column) => Object.freeze({ fn: 'sum', column });
const max = (column) => Object.freeze({ fn: 'max', column });
const sums = (columns) => Object.fromEntries(columns.map((c) => [c, sum(c)]));
const maxes = (columns) => Object.fromEntries(columns.map((c) => [c, max(c)]));

function store(definition) {
  return Object.freeze({
    extras: Object.freeze([]),
    numericDimensions: Object.freeze([]),
    ...definition,
    key: Object.freeze(definition.key ?? ['day', 'dims_hash']),
    dimensions: Object.freeze([...definition.dimensions]),
    columns: Object.freeze([...new Set(definition.columns)]),
    measures: Object.freeze(definition.measures),
  });
}

/**
 * Everything rollups.write, read and clear know about. Each store is one table, with the same name, carrying tenant_id. key is what a write
 * replaces by; dims_hash is worked out by the driver from the row's dimensions, so a long landing page can't overflow an index.
 *   dimensions  columns a read may group or filter by
 *   columns     numeric columns a write fills; missing ones are 0, or null where the store says `nullable`
 *   extras      other columns a write may carry
 *   measures    what a read may ask for: { fn: sum | max | count | distinct | median, column }
 *   retainDays  how long rows stay (7.10); a purge removes older days for every business
 * traffic_sessions has one row per session, so it alone can count distinct visitors and a median, for as long as raw events are kept.
 */
export const ROLLUP_STORES = Object.freeze({
  traffic_sessions: store({
    key: ['session_id'],
    dimensions: [...WHEN, ...SESSION_DIMENSIONS],
    numericDimensions: ['hour', 'weekday'],
    columns: [...TRAFFIC_COUNTERS, 'engaged_ms', 'bounced'],
    extras: ['visitor_id', 'started_at', 'last_hit_at'],
    measures: { sessions: Object.freeze({ fn: 'count' }), visitors: Object.freeze({ fn: 'distinct', column: 'visitor_id' }), bounces: sum('bounced'), median_engaged_ms: Object.freeze({ fn: 'median', column: 'engaged_ms' }), ...sums(TRAFFIC_COUNTERS) },
    retainDays: ANALYTICS_LIMITS.rawEventDays,
  }),
  traffic_daily: store({
    dimensions: [...WHEN, ...SESSION_DIMENSIONS],
    numericDimensions: ['hour', 'weekday'],
    columns: ['sessions', 'bounces', ...TRAFFIC_COUNTERS],
    measures: sums(['sessions', 'bounces', ...TRAFFIC_COUNTERS]),
    retainDays: ANALYTICS_LIMITS.rollupDays,
  }),
  traffic_items_daily: store({
    dimensions: [...WHEN, 'item_kind', 'item_ref', ...SESSION_DIMENSIONS],
    numericDimensions: ['hour', 'weekday'],
    columns: ['sessions', 'views', 'taps', 'outbound_taps', 'whatsapp_taps', 'add_to_cart', 'checkout_started', 'orders', 'revenue_paise'],
    measures: sums(['sessions', 'views', 'taps', 'outbound_taps', 'whatsapp_taps', 'add_to_cart', 'checkout_started', 'orders', 'revenue_paise']),
    retainDays: ANALYTICS_LIMITS.rollupDays,
  }),
  funnel_daily: store({
    dimensions: ['day', 'channel', 'media_id', 'content_kind', 'link_type', 'link_mode', 'origin', 'source_label'],
    columns: ['comments', 'dms_queued', 'dms_sent', 'dms_failed', 'dms_paced', 'seen', 'taps', 'visits', 'orders', 'revenue_paise', 'earnings_paise'],
    measures: sums(['comments', 'dms_queued', 'dms_sent', 'dms_failed', 'dms_paced', 'seen', 'taps', 'visits', 'orders', 'revenue_paise', 'earnings_paise']),
    retainDays: ANALYTICS_LIMITS.rollupDays,
  }),
  meta_account_daily: store({
    dimensions: ['day', 'account_id'],
    columns: ['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'reposts', 'follows', 'unfollows', 'profile_links_taps', 'followers_count'],
    nullable: true,
    measures: { ...sums(['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'reposts', 'follows', 'unfollows', 'profile_links_taps']), ...maxes(['followers_count']) },
    retainDays: ANALYTICS_LIMITS.rollupDays,
  }),
  meta_content_daily: store({
    dimensions: ['day', 'media_id', 'content_kind'],
    columns: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'reposts', 'follows', 'profile_visits', 'link_clicks', 'avg_watch_ms', 'total_watch_ms', 'skip_rate_bp'],
    nullable: true,
    measures: maxes(['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'reposts', 'follows', 'profile_visits', 'link_clicks', 'avg_watch_ms', 'total_watch_ms', 'skip_rate_bp']),
    retainDays: ANALYTICS_LIMITS.rollupDays,
  }),
});

// ---- Explore (7.11) ------------------------------------------------------------------------------------------------------

const metric = (label, source, store_, measure, extra = {}) => Object.freeze({ label, source, store: store_, measure, ...extra });
const rate = (label, numerator, denominator, extra = {}) => Object.freeze({ label, source: 'bhava', rate: Object.freeze([numerator, denominator]), ...extra });

/**
 * Every metric Explore, exports and the reporting API can use, and its one source label. Meta's are prefixed ig_, so a Meta figure and a
 * Bhava figure with the same everyday name can't be added by accident. A rate has a numerator and denominator, and a denominator under
 * 20 shows "low volume". minTier and revenue say who may see one.
 */
export const EXPLORE_METRICS = Object.freeze({
  sessions: metric('Sessions', 'bhava', 'traffic_daily', 'sessions'),
  visitors: metric('Unique visitors', 'bhava', 'traffic_sessions', 'visitors'),
  page_views: metric('Page views', 'bhava', 'traffic_daily', 'page_views'),
  landing_views: metric('Landing page views', 'bhava', 'traffic_daily', 'landing_views', { minTier: 2 }),
  category_views: metric('Category views', 'bhava', 'traffic_daily', 'category_views', { minTier: 2 }),
  product_views: metric('Product views', 'bhava', 'traffic_daily', 'product_views', { minTier: 2 }),
  product_taps: metric('Product taps', 'bhava', 'traffic_daily', 'product_taps', { minTier: 2 }),
  outbound_taps: metric('Outbound link taps', 'bhava', 'traffic_daily', 'outbound_taps', { minTier: 2 }),
  whatsapp_taps: metric('WhatsApp taps', 'bhava', 'traffic_daily', 'whatsapp_taps', { minTier: 2 }),
  add_to_cart: metric('Add to cart', 'bhava', 'traffic_daily', 'add_to_cart', { minTier: 3 }),
  checkout_started: metric('Checkout started', 'bhava', 'traffic_daily', 'checkout_started', { minTier: 3 }),
  orders: metric('Orders', 'bhava', 'traffic_daily', 'orders', { minTier: 3, revenue: true }),
  revenue_paise: metric('Revenue', 'bhava', 'traffic_daily', 'revenue_paise', { minTier: 3, revenue: true }),
  median_engaged_ms: metric('Median engaged time', 'bhava', 'traffic_sessions', 'median_engaged_ms'),
  bounce_rate: rate('Bounce rate', 'bounces', 'sessions'),
  tap_rate: rate('Tap rate', 'product_taps', 'sessions', { minTier: 2 }),
  add_to_cart_rate: rate('Add-to-cart rate', 'add_to_cart', 'sessions', { minTier: 3 }),
  conversion_rate: rate('Conversion rate', 'orders', 'sessions', { minTier: 3, revenue: true }),
  revenue_per_session: rate('Revenue per session', 'revenue_paise', 'sessions', { minTier: 3, revenue: true }),

  dms: metric('DMs sent', 'bhava', 'funnel_daily', 'dms_sent'),
  comments_received: metric('Comments received', 'bhava', 'funnel_daily', 'comments'),
  taps_or_visits: metric('Taps or visits', 'bhava', 'funnel_daily', 'taps'),

  ig_views: metric('Views', 'platform', 'meta_account_daily', 'views'),
  ig_reach: metric('Reach', 'platform', 'meta_account_daily', 'reach'),
  ig_accounts_engaged: metric('Accounts engaged', 'platform', 'meta_account_daily', 'accounts_engaged'),
  ig_total_interactions: metric('Interactions', 'platform', 'meta_account_daily', 'total_interactions'),
  ig_likes: metric('Likes', 'platform', 'meta_account_daily', 'likes'),
  ig_comments: metric('Comments', 'platform', 'meta_account_daily', 'comments'),
  ig_shares: metric('Shares', 'platform', 'meta_account_daily', 'shares'),
  ig_saves: metric('Saves', 'platform', 'meta_account_daily', 'saves'),
  ig_replies: metric('Replies', 'platform', 'meta_account_daily', 'replies'),
  ig_reposts: metric('Reposts', 'platform', 'meta_account_daily', 'reposts'),
  ig_follows: metric('Follows', 'platform', 'meta_account_daily', 'follows'),
  ig_unfollows: metric('Unfollows', 'platform', 'meta_account_daily', 'unfollows'),
  ig_profile_links_taps: metric('Profile link taps', 'platform', 'meta_account_daily', 'profile_links_taps'),
  ig_followers: metric('Followers', 'platform', 'meta_account_daily', 'followers_count'),
  ig_media_views: metric('Views per post', 'platform', 'meta_content_daily', 'views'),
  ig_media_reach: metric('Reach per post', 'platform', 'meta_content_daily', 'reach'),
  ig_link_clicks: metric('Story link clicks', 'platform', 'meta_content_daily', 'link_clicks'),
  ig_avg_watch_ms: metric('Average watch time', 'platform', 'meta_content_daily', 'avg_watch_ms'),
  ig_skip_rate_bp: metric('Skip rate', 'platform', 'meta_content_daily', 'skip_rate_bp'),
});
export const EXPLORE_METRIC_NAMES = Object.freeze(Object.keys(EXPLORE_METRICS));

/** What an Explore breakdown or filter can use, and the store column each is. No visitor id, single path, IP or user agent is one of them. */
export const EXPLORE_DIMENSIONS = Object.freeze({
  date: 'day',
  hour: 'hour',
  weekday: 'weekday',
  source: 'source',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_content: 'utm_content',
  content: 'media_id',
  category: 'item_ref',
  landing_page: 'landing_page',
  product: 'item_ref',
  device: 'device',
  os: 'os',
  browser: 'browser',
  in_app: 'in_app',
  city: 'city',
  state: 'state',
  visitor_type: 'visitor_type',
});
export const EXPLORE_DIMENSION_NAMES = Object.freeze(Object.keys(EXPLORE_DIMENSIONS));

// ---- custom funnels (7.12), downloads and reports (7.9, 7.13) --------------------------------------------------------------

export const CUSTOM_FUNNEL_STEPS = Object.freeze(['landing_view', 'category_view', 'product_view', 'product_tap', 'outbound_click', 'whatsapp_tap', 'add_to_cart', 'checkout_started', 'payment_success', 'page_view']);
export const STEPS_NEEDING_TIER_3 = Object.freeze(['add_to_cart', 'checkout_started', 'payment_success']);
export const DOWNLOAD_SOURCES = Object.freeze(['explore', 'funnel', 'cohort', 'account_daily', 'media', 'story_finals', 'content_funnel', 'health_history']);
export const DOWNLOAD_FORMATS = Object.freeze(['csv', 'xlsx']);
export const DOWNLOAD_STATUSES = Object.freeze(['queued', 'running', 'ready', 'failed', 'expired']);
export const REPORT_KINDS = Object.freeze(['weekly', 'monthly', 'scheduled']);
export const REPORT_FREQUENCIES = Object.freeze(['daily', 'weekly', 'monthly']);

/** The file route for downloads and monthly PDFs. It is outside /api/v1 because the API answers only JSON; open it signed in. */
export const REPORT_FILE_PATH = '/report-files/:id';

/** The reporting API (7.13), outside /api/v1 and signed by key, never by session. */
export const REPORTING_BASE_PATH = '/reporting/v1';
export const REPORTING_KEY_PREFIX = 'bhv_';
export const REPORTING_SCOPE = 'analytics:read';

// ---- pixels and tags (7.14) ----------------------------------------------------------------------------------------------

export const TAG_PROVIDERS = Object.freeze(['meta', 'ga4']);

/** The hosts a buyer page's content security policy may allow, for a business with that tag on and only then. */
export const TAG_HOSTS = Object.freeze({
  meta: Object.freeze(['https://connect.facebook.net', 'https://www.facebook.com']),
  ga4: Object.freeze(['https://www.googletagmanager.com', 'https://www.google-analytics.com']),
});

/** Names on each side of one event (7.14). A browser hit and a server event share an event id, so duplicates can be removed. */
export const TAG_EVENTS = Object.freeze({
  page_view: Object.freeze({ meta: 'PageView', ga4: 'page_view', minTier: 2 }),
  view_content: Object.freeze({ meta: 'ViewContent', ga4: 'view_item', minTier: 2 }),
  add_to_cart: Object.freeze({ meta: 'AddToCart', ga4: 'add_to_cart', minTier: 3 }),
  initiate_checkout: Object.freeze({ meta: 'InitiateCheckout', ga4: 'begin_checkout', minTier: 3 }),
  purchase: Object.freeze({ meta: 'Purchase', ga4: 'purchase', minTier: 3 }),
});

/**
 * The parts of the Phase 2 catalogue (src/contracts/analytics.js) the console's screens need: labels, limits and the lists of codes.
 * The console may import nothing from outside console/src but the access rules, so these are the server's values written out here,
 * and test/p2/console/figures.test.js fails the moment one differs from the server's own copy. Change them there first.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SOURCE_LABELS = Object.freeze({
  bhava: 'Measured by Bhava',
  platform: 'From Instagram/Facebook',
  destination: 'From the destination',
});
export const SOURCE_LABEL_CODES = Object.freeze(Object.keys(SOURCE_LABELS));

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

export const ANALYTICS_LIMITS = Object.freeze({
  metaDataDelayMs: 48 * HOUR,
  accountRetentionDays: 90,
  mediaRetentionDays: 730,
  storyLifeMs: DAY,
  accountRangeDays: 30,
  mediaHistoryDays: 730,
  rangePresetsDays: Object.freeze([7, 28, 90]),
  mayChangeDays: 2,
  minFollowersForDemographics: 100,
  demographicsTimeframes: Object.freeze(['this_week', 'this_month']),
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
  lowVolumeDenominator: 20,
  orderAttributionWindowMs: 7 * DAY,
  bestTimeMinPosts: 20,
  bestTimeWindowDays: 90,
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
  healthHistoryDays: 90,
  healthGoodFrom: 80,
  healthWatchFrom: 50,
  sessionIdleMs: 30 * MINUTE,
  visitorCookieDays: 395,
  rollupDays: 762,
  realtimeWindowMs: 30 * MINUTE,
  realtimeRefreshMs: 15_000,
  exploreMaxBreakdowns: 2,
  explorePageRows: 100,
  exploreTargetMs: 3000,
  downloadBackgroundOverRows: 50_000,
  downloadExpiryDays: 7,
  apiRequestsPerMinute: 60,
  funnelMinSteps: 2,
  funnelMaxSteps: 8,
  funnelMinWindowMinutes: 30,
  funnelMaxWindowMinutes: 7 * 24 * 60,
  cohortLowVolume: 20,
  tagAlertAfterFailedDays: 3,
});

export const REACH_GUARD_STATES = Object.freeze(['learning', 'normal', 'watch', 'tripped', 'permission_needed']);
export const REACH_TRIP_TRIGGERS = Object.freeze(['reach_days', 'media_24h']);
export const HEALTH_BANDS = Object.freeze(['good', 'watch', 'at_risk']);

export const TRAFFIC_SOURCES = Object.freeze([
  'instagram_comment_dm', 'story_reply', 'story_mention', 'dm_keyword', 'bio_link',
  'facebook_dm', 'facebook_comment', 'facebook_post', 'facebook_bio', 'whatsapp', 'direct', 'other_referrer',
]);
export const DEVICE_TYPES = Object.freeze(['mobile', 'tablet', 'desktop', 'other']);
export const IN_APP_BROWSERS = Object.freeze(['instagram', 'facebook', 'other_in_app', 'browser']);
export const VISITOR_TYPES = Object.freeze(['new', 'returning', 'unknown']);
export const PAGE_KINDS = Object.freeze(['landing', 'category', 'product', 'store', 'link_in_bio', 'creator', 'checkout', 'other']);

export const FUNNEL_STAGES = Object.freeze(['comments', 'dms', 'seen', 'taps_or_visits', 'sales']);
export const FUNNEL_ORIGINS = Object.freeze(['automation', 'two_tap', 'bhava_page', 'utm', 'shopify', 'amazon', 'affiliate', 'discount_code', 'bhava_store']);
export const LINK_TYPES_MEASURED = Object.freeze(['bhava_page', 'seller_site', 'amazon', 'affiliate', 'whatsapp']);
export const LINK_MODES = Object.freeze(['one_tap', 'two_tap']);

/** Explore's metrics that are rates (a fraction of one figure over another), and the ones in paise. */
export const EXPLORE_RATE_METRICS = Object.freeze(['bounce_rate', 'tap_rate', 'add_to_cart_rate', 'conversion_rate', 'revenue_per_session']);
export const EXPLORE_DIMENSION_NAMES = Object.freeze(['date', 'hour', 'weekday', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'content', 'category', 'landing_page', 'product', 'device', 'os', 'browser', 'in_app', 'city', 'state', 'visitor_type']);

export const CUSTOM_FUNNEL_STEPS = Object.freeze(['landing_view', 'category_view', 'product_view', 'product_tap', 'outbound_click', 'whatsapp_tap', 'add_to_cart', 'checkout_started', 'payment_success', 'page_view']);
export const STEPS_NEEDING_TIER_3 = Object.freeze(['add_to_cart', 'checkout_started', 'payment_success']);
export const DOWNLOAD_SOURCES = Object.freeze(['explore', 'funnel', 'cohort', 'account_daily', 'media', 'story_finals', 'content_funnel', 'health_history']);
export const DOWNLOAD_FORMATS = Object.freeze(['csv', 'xlsx']);
export const DOWNLOAD_STATUSES = Object.freeze(['queued', 'running', 'ready', 'failed', 'expired']);
export const REPORT_KINDS = Object.freeze(['weekly', 'monthly', 'scheduled']);
export const REPORT_FREQUENCIES = Object.freeze(['daily', 'weekly', 'monthly']);
export const REPORTING_BASE_PATH = '/reporting/v1';
export const REPORTING_SCOPE = 'analytics:read';
export const TAG_PROVIDERS = Object.freeze(['meta', 'ga4']);

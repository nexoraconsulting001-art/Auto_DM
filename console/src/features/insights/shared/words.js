import { ANALYTICS_LIMITS, FIGURE_TEXT, SOURCE_LABELS } from './catalog.js';

/**
 * Pure: the words and number formats every analytics screen shares. Lookups go through `wordFor`, so a code the console doesn't know
 * yet (or a name every object inherits, such as "constructor") shows as itself instead of as a property of the table.
 */
export const wordFor = (table, code, fallback = code) => (typeof code === 'string' && Object.hasOwn(table, code) ? table[code] : String(fallback ?? ''));

export const sourceLabel = (code) => wordFor(SOURCE_LABELS, code, '');

const INDIA = 'en-IN';

/** A whole count or figure. null and undefined are not numbers: callers say why there is no figure instead. */
export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return Math.round(value).toLocaleString(INDIA);
}

/** 12,400 as 12.4K, for tiles on a small screen. */
export function formatCompact(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const size = Math.abs(value);
  if (size >= 10_000_000) return `${trim(value / 10_000_000)} Cr`;
  if (size >= 100_000) return `${trim(value / 100_000)} L`;
  if (size >= 10_000) return `${trim(value / 1000)}K`;
  return formatCount(value);
}
const trim = (n) => (Math.round(n * 10) / 10).toLocaleString(INDIA);

/** A rate the API sends as a fraction (0.45) as "45%". */
export function formatRate(rate, places = 1) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '';
  const percent = rate * 100;
  const rounded = Number(percent.toFixed(places));
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(places)}%`;
}

/** A percent the API already sends as a percent (changePercent, dropPercent). */
export function formatPercent(percent, places = 0) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return '';
  return `${Number(percent.toFixed(places))}%`;
}

/** Integer paise as rupees. Money never passes through a rupee float anywhere else. */
export function formatMoney(paise) {
  if (typeof paise !== 'number' || !Number.isFinite(paise)) return '';
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString(INDIA, { minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Milliseconds as "1 min 20 s" or "45 s". */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-04" as "4 Nov". The day is a calendar day, so no time zone can move it. */
export function formatDay(day, { year = false } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!match) return '';
  const text = `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
  return year ? `${text} ${match[1]}` : text;
}

export const WEEKDAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
export const WEEKDAY_SHORT = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
/** Rows of a week, Monday first, as an Indian seller reads a calendar. Weekday numbers are the API's: 0 is Sunday. */
export const WEEK_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

/** 0 to 23 as "12 am", "1 pm". */
export function formatHour(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return '';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'am' : 'pm'}`;
}

/** A difference as "Up 12%" or "Down 3%". The API's changePercent is null when there is nothing to compare with. */
export function changeWords(changePercent, { previousLabel = 'the previous period' } = {}) {
  if (typeof changePercent !== 'number' || !Number.isFinite(changePercent)) return '';
  const rounded = Math.round(Math.abs(changePercent));
  if (rounded === 0) return `Same as ${previousLabel}`;
  return `${changePercent > 0 ? 'Up' : 'Down'} ${rounded}% vs ${previousLabel}`;
}

// ---- names of things ---------------------------------------------------------------------------------------------------

export const KIND_WORDS = Object.freeze({ feed: 'Post', reel: 'Reel', carousel: 'Carousel', story: 'Story' });
export const LINK_TYPE_WORDS = Object.freeze({ bhava_page: 'Your store page', seller_site: 'Your own site', amazon: 'Amazon', affiliate: 'Affiliate link', whatsapp: 'WhatsApp chat' });
export const LINK_MODE_WORDS = Object.freeze({ one_tap: 'One tap', two_tap: 'Two taps' });
export const STAGE_WORDS = Object.freeze({ comments: 'Comments', dms: 'DMs', seen: 'Seen', taps_or_visits: 'Taps or visits', sales: 'Sales (₹)' });
export const ORIGIN_WORDS = Object.freeze({
  automation: 'Automation', two_tap: 'Two-tap taps', bhava_page: 'Store page visits', utm: 'UTM visits', shopify: 'Shopify orders',
  amazon: 'Amazon earnings', affiliate: 'Affiliate earnings', discount_code: 'Discount code orders', bhava_store: 'Store orders',
});
export const CHANNEL_WORDS = Object.freeze({ instagram: 'Instagram', facebook: 'Facebook' });

export const TRAFFIC_SOURCE_WORDS = Object.freeze({
  instagram_comment_dm: 'Instagram comment DM', story_reply: 'Story reply', story_mention: 'Story mention', dm_keyword: 'DM keyword', bio_link: 'Bio link',
  facebook_dm: 'Facebook DM', facebook_comment: 'Facebook comment', facebook_post: 'Facebook post', facebook_bio: 'Facebook bio', whatsapp: 'WhatsApp',
  direct: 'Direct', other_referrer: 'Other site',
});
export const DEVICE_WORDS = Object.freeze({ mobile: 'Phone', tablet: 'Tablet', desktop: 'Computer', other: 'Other' });
export const IN_APP_WORDS = Object.freeze({ instagram: 'Instagram app', facebook: 'Facebook app', other_in_app: 'Other app', browser: 'Web browser' });
export const VISITOR_WORDS = Object.freeze({ new: 'New', returning: 'Returning', unknown: 'Cookies off' });
export const PAGE_KIND_WORDS = Object.freeze({ landing: 'Landing page', category: 'Category', product: 'Product', store: 'Store', link_in_bio: 'Link in bio', creator: 'Creator page', checkout: 'Checkout', other: 'Other page' });

/** A breakdown value as a seller reads it. Empty means the visit didn't say. */
export function breakdownValue(by, key) {
  const text = String(key ?? '');
  if (text === '') return 'Not known';
  if (by === 'source') return wordFor(TRAFFIC_SOURCE_WORDS, text);
  if (by === 'device') return wordFor(DEVICE_WORDS, text);
  if (by === 'in_app') return wordFor(IN_APP_WORDS, text);
  if (by === 'visitor_type') return wordFor(VISITOR_WORDS, text);
  if (by === 'weekday' && /^[0-6]$/.test(text)) return WEEKDAY_NAMES[Number(text)];
  if (by === 'hour' && /^\d{1,2}$/.test(text)) return formatHour(Number(text)) || text;
  if (by === 'date') return formatDay(text, { year: true }) || text;
  return text;
}

/** A code from Meta such as "BOOK_NOW" or "CAROUSEL_CONTAINER" as "Book now". */
export function humanize(code) {
  const text = String(code ?? '').trim();
  if (!text) return 'Not known';
  const words = text.replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const META_VALUE_WORDS = Object.freeze({ REEL: 'Reels', POST: 'Posts', FEED: 'Posts', STORY: 'Stories', CAROUSEL_CONTAINER: 'Carousels', AD: 'Ads', FOLLOWER: 'Follows', NON_FOLLOWER: 'Unfollows', FOLLOW: 'Follows', UNFOLLOW: 'Unfollows' });
export const metaValue = (code) => wordFor(META_VALUE_WORDS, code, humanize(code));
export const BREAKDOWN_WORDS = Object.freeze({ media_product_type: 'By type of post', contact_button_type: 'By button tapped', follow_type: 'Follows and unfollows', action_type: 'Profile actions', story_navigation_action_type: 'How people moved through it' });

/** Meta's names for a post's or story's figures, in the order a seller reads them (7.2, 7.3). */
export const MEDIA_METRIC_WORDS = Object.freeze({
  views: FIGURE_TEXT.viewsColumn,
  reach: 'Reach',
  total_interactions: 'Interactions',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
  saved: 'Saves',
  reposts: 'Reposts',
  replies: 'Replies',
  follows: 'Follows',
  profile_visits: 'Profile visits',
  link_clicks: 'Link sticker taps',
  ig_reels_avg_watch_time: 'Average watch time',
  ig_reels_video_view_total_time: 'Total watch time',
  reels_skip_rate: 'Skip rate',
  crossposted_views: 'Views on Facebook',
});
export const MEDIA_METRIC_ORDER = Object.freeze(Object.keys(MEDIA_METRIC_WORDS));

/** A post's figure as text: watch times arrive in milliseconds, and the skip rate as a percentage. */
export function mediaMetricText(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return FIGURE_TEXT.noData;
  if (name === 'ig_reels_avg_watch_time' || name === 'ig_reels_video_view_total_time') return formatDuration(value);
  if (name === 'reels_skip_rate') return formatPercent(value, 1);
  return formatCount(value);
}

/** Every figure the post has, known names first, then anything newer Meta added, by its own name. */
export function mediaMetricRows(metrics) {
  const names = Object.keys(metrics ?? {});
  const known = MEDIA_METRIC_ORDER.filter((name) => names.includes(name));
  const rest = names.filter((name) => !Object.hasOwn(MEDIA_METRIC_WORDS, name)).sort();
  return [...known, ...rest].map((name) => ({ name, label: wordFor(MEDIA_METRIC_WORDS, name, humanize(name)), value: mediaMetricText(name, metrics[name]) }));
}

export const TIMEFRAME_WORDS = Object.freeze({ this_week: 'This week', this_month: 'This month' });
export const DEMOGRAPHIC_WORDS = Object.freeze({ age: 'Age', gender: 'Gender', city: 'City', country: 'Country' });
export const GENDER_WORDS = Object.freeze({ F: 'Women', M: 'Men', U: 'Not said' });

// ---- figures that are not numbers ----------------------------------------------------------------------------------------

/** What a day of a metric says instead of a number (7.1). "No data" is never 0, and a day before connecting was never collected. */
export const STATE_WORDS = Object.freeze({
  no_data: FIGURE_TEXT.noData,
  not_collected: FIGURE_TEXT.notCollected,
  below_threshold: FIGURE_TEXT.belowFive,
  not_available: 'Beyond your plan’s history',
});

/** A figure as text: the number, or the reason there isn't one. */
export function figureText(value, state = 'ok', format = formatCount) {
  if (state && state !== 'ok') return wordFor(STATE_WORDS, state, FIGURE_TEXT.noData);
  if (typeof value !== 'number' || !Number.isFinite(value)) return FIGURE_TEXT.noData;
  return format(value);
}

/** "1 day with no data" for a total that has gaps (N-03). */
export function gapNote(gapDays) {
  if (!Number.isInteger(gapDays) || gapDays <= 0) return '';
  return `Total leaves out ${gapDays} ${gapDays === 1 ? 'day' : 'days'} with no data`;
}

/** How long ago, from the server's clock where it gave one, so a phone with the wrong time still reads right. */
export function agoWords(at, now = Date.now()) {
  const then = typeof at === 'string' || at instanceof Date ? +new Date(at) : NaN;
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export const MAY_CHANGE_NOTE = `The last ${ANALYTICS_LIMITS.mayChangeDays} days ${FIGURE_TEXT.mayChange}: Instagram can take up to two days to settle a day’s figures.`;

import { z } from 'zod';
import { APP_HEADERS, APP_PLATFORMS, APP_VERSION } from './accounts.js';

/**
 * The branded shopper app (PRD 10.7 to 10.14): the numbers, the moves and the pure rules every Phase 6 track reads. Nothing here
 * reads the database, a provider's clock or the network. The shopper app carries the seller's brand only, so no wording here
 * that can reach a shopper names the platform; namesPlatform() below is the one place the word is tested for.
 *
 *   APP_ENTITLEMENTS              which plan feature opens each platform's app, and what an app brings with it
 *   SHOPPER_APP_HEADERS, ...      the headers and the token scheme of an app request (module app-api)
 *   APP_LIMITS                    per-address and per-device limits, counted with platform.rateLimit
 *   APP_LINK_PATHS                the one list of paths the app opens (well-known files, intent filters, the app's parser)
 *   APP_TRANSITIONS, canMove      every allowed move of builds, submissions and over-the-air releases; the rows of app_transitions
 *   STORE_LIMITS, listingProblems the stores' text lengths and image sizes, and the check a listing is saved through
 *   ASSET_SPECS, checkAsset       icon, adaptive icon, splash, feature graphic and screenshot specs
 *   PRESUBMIT_CHECKS              what must pass before a build goes to review, each with the guideline it guards
 *   PLAYBOOKS, playbookFor        a rejection's guideline to its fix
 *   SHOPPER_PUSH_RULES, ...KINDS  the weekly cap, quiet hours and the wording of every shopper push; shopperPushProblem()
 *   DATA_COLLECTED                what the app collects, for the data safety form and the privacy labels
 *   BrandFile, brandFileProblems  what one build is made from, and the check `validate` and the pipeline run first
 */

const freeze = (value) => Object.freeze(value);
const PLATFORM_WORD = /bhava/i;

/** True when the text names the platform. The one place in code this word is tested for. */
export const namesPlatform = (text) => PLATFORM_WORD.test(String(text ?? ''));

// ---- entitlements, headers and tokens ----

/** app.android from tier 4, app.ios from tier 5 (plan_features, migration 004). Either one brings loyalty with it. */
export const APP_ENTITLEMENTS = freeze({ android: 'app.android', ios: 'app.ios', includes: freeze(['loyalty']) });
export const appFeatureOf = (platform) => (APP_PLATFORMS.includes(platform) ? APP_ENTITLEMENTS[platform] : null);

/** X-App: shopper, X-App-Tenant (the business id written into the build), X-App-Version, X-App-Platform. */
export const SHOPPER_APP_HEADERS = freeze({ ...APP_HEADERS, tenant: 'x-app-tenant' });
/** Authorization: Shopper <access token>. Never Bearer: the seller's bearer check never reads this scheme. */
export const SHOPPER_AUTH_SCHEME = 'Shopper';
export const SHOPPER_TOKEN_PREFIX = freeze({ access: 'sa_', refresh: 'sr_' });
/** How a shopper app session was opened (shopper_app_sessions.method). */
export const APP_SESSION_METHODS = freeze(['guest', 'whatsapp_otp', 'google', 'apple', 'review']);

/** Counted in the database by platform.rateLimit.hit(scope, subject, { limit, windowMs }). */
export const APP_LIMITS = freeze({
  guestSessionsPerAddress: freeze({ scope: 'app_guest_sessions_ip', limit: 30, windowMs: 3_600_000 }),
  signInsPerAddress: freeze({ scope: 'app_signins_ip', limit: 30, windowMs: 900_000 }),
  refreshesPerAddress: freeze({ scope: 'app_refreshes_ip', limit: 120, windowMs: 900_000 }),
  /** Per release, device and event: one install counts once an hour, so it can neither cause nor hide a roll back. */
  healthPerDevice: freeze({ scope: 'app_health_device', limit: 1, windowMs: 3_600_000 }),
});

// ---- deep links (10.12) ----

/**
 * The paths the app opens, and the ones it never takes from the browser. Both well-known files, the brand file's intent filters
 * and the app's own link parser use this list. `*` is one or more path segments. The app opens the same direct link a DM
 * carries: it adds no parameter and no token and calls no click route. An unknown path opens home.
 */
export const APP_LINK_PATHS = freeze({
  open: freeze(['/', '/shop', '/reels', '/cart', '/r/*', '/p/*', '/c/*', '/order/*', '/track/*', '/account/orders/*', '/refer/*']),
  exclude: freeze([
    '/auth/*', '/login', '/logout', '/checkout', '/policies/*', '/unsubscribe/*', '/cart/restore/*', '/account/shared-profile',
    '/admin', '/admin/*', '/api/*', '/media/*', '/webhooks/*', '/.well-known/*', '/lead', '/lead/*',
  ]),
});

const SAFE_PATH = /^\/[A-Za-z0-9/_.~-]*$/;
const matchesPattern = (path, pattern) => (pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) && path.length > pattern.length - 1 : path === pattern);

/** True for a path the app opens: a plain path (no query, no '//', no '..') under `open` and under no `exclude`. */
export function isAppLinkPath(path) {
  if (typeof path !== 'string' || !SAFE_PATH.test(path) || path.includes('//') || path.split('/').includes('..') || path.length > 200) return false;
  if (APP_LINK_PATHS.exclude.some((p) => matchesPattern(path, p))) return false;
  return APP_LINK_PATHS.open.some((p) => matchesPattern(path, p));
}

// ---- builds, submissions, over-the-air releases ----

export const BUILD_STATUSES = freeze(['queued', 'building', 'built', 'failed', 'submitted']);
/** Where a build stopped: loading the config, validating it, the assets, writing the brand file, or the build itself. */
export const BUILD_STEPS = freeze(['load', 'validate', 'assets', 'brand_file', 'build']);
export const BUILD_DRIVERS = freeze(['local', 'eas']);
export const BUILD_PROFILES = freeze(['production', 'preview', 'simulator']);
/** One brand, or a native change that rebuilds every brand. */
export const BUILD_REASONS = freeze(['brand', 'native_change']);
export const SUBMISSION_STATES = freeze(['draft', 'in_review', 'rejected', 'approved', 'live']);
export const OTA_STATUSES = freeze(['publishing', 'live', 'rolling_back', 'rolled_back', 'superseded', 'blocked', 'failed']);
export const OTA_ROLLOUT = freeze([10, 50, 100]);
export const APP_MACHINES = freeze(['app_build', 'app_submission', 'ota_release']);
/** presubmit: the newest presubmit run of the submission's build passed. presubmit_no_task: that, and no open review task. */
export const APP_GUARDS = freeze(['', 'presubmit', 'presubmit_no_task']);

const move = (from, to, guard = '') => freeze({ from, to, guard });

/** Every allowed move, as data. The same rows are in app_transitions (602), and triggers refuse anything else. */
export const APP_TRANSITIONS = freeze({
  app_build: freeze([move('queued', 'building'), move('queued', 'failed'), move('building', 'built'), move('building', 'failed'), move('built', 'submitted')]),
  app_submission: freeze([
    move('draft', 'in_review', 'presubmit'), move('in_review', 'rejected'), move('in_review', 'approved'), move('rejected', 'in_review', 'presubmit_no_task'),
    move('approved', 'live'), move('approved', 'in_review', 'presubmit'), move('live', 'in_review', 'presubmit'),
  ]),
  ota_release: freeze([move('publishing', 'live'), move('publishing', 'failed'), move('live', 'rolling_back'), move('rolling_back', 'rolled_back'), move('live', 'superseded')]),
});

/** The move from `from` to `to` on `machine`, or null. */
export const findAppMove = (machine, from, to) => APP_TRANSITIONS[machine]?.find((m) => m.from === from && m.to === to) ?? null;
export const canMove = (machine, from, to) => findAppMove(machine, from, to) !== null;
/** 10 to 50 to 100, and nothing after. */
export const nextRollout = (current) => ({ 10: 50, 50: 100 })[current] ?? null;

// ---- store listings (10.13) ----

/**
 * Each store's text lengths and image sizes. These are the stores' published rules as known when this was written; they were
 * not re-read from the stores' own pages in this build (no outside traffic), so verifiedOn stays null until someone checks
 * both pages and writes the date here.
 */
export const STORE_LIMITS = freeze({
  verifiedOn: null,
  play: freeze({
    title: 30, shortDescription: 80, fullDescription: 4000, whatsNew: 500,
    screenshots: freeze({ min: 2, max: 8, minSide: 320, maxSide: 3840, maxRatio: 2, mimes: freeze(['image/png', 'image/jpeg']), alpha: false }),
    featureGraphic: freeze({ width: 1024, height: 500, alpha: false }),
    icon: freeze({ size: 512, maxBytes: 1_048_576 }),
  }),
  appStore: freeze({
    title: 30, shortDescription: 30, fullDescription: 4000, keywords: 100, whatsNew: 4000,
    screenshots: freeze({
      min: 1, max: 10, alpha: false,
      sizes: freeze({ iphone_6_9: freeze([[1320, 2868], [1290, 2796], [1260, 2736]]), iphone_6_5: freeze([[1284, 2778], [1242, 2688]]) }),
    }),
    icon: freeze({ size: 1024, alpha: false }),
  }),
});

export const storeOf = (platform) => (platform === 'ios' ? 'appStore' : platform === 'android' ? 'play' : null);
const STORE_NAMES = freeze({ play: 'Google Play', appStore: 'The App Store' });
const FIELD_LABELS = freeze({
  play: freeze({ title: 'Title', shortDescription: 'Short description', fullDescription: 'Full description', whatsNew: 'Release notes' }),
  appStore: freeze({ title: 'Name', shortDescription: 'Subtitle', fullDescription: 'Description', keywords: 'Keywords', whatsNew: 'What’s New' }),
});
const REQUIRED_FIELDS = freeze({ play: freeze(['title', 'shortDescription', 'fullDescription']), appStore: freeze(['title', 'fullDescription']) });
/** The text fields of a listing each store has, with its limit. */
export const listingLimits = (platform) => {
  const store = storeOf(platform);
  return store ? Object.fromEntries(Object.keys(FIELD_LABELS[store]).map((field) => [field, STORE_LIMITS[store][field]])) : {};
};
const lengthOf = (text) => [...String(text ?? '')].length;

/**
 * A listing's problems for one store, each naming its field: [{ field, code, limit?, length?, message }]. [] passes.
 * code is too_long ("Short description is 92 characters. Google Play allows 80."), required, or names_platform.
 */
export function listingProblems(platform, listing = {}) {
  const store = storeOf(platform);
  if (!store) return [{ field: 'platform', code: 'required', message: 'Choose Android or iOS.' }];
  const problems = [];
  for (const [field, label] of Object.entries(FIELD_LABELS[store])) {
    const value = String(listing[field] ?? '');
    const limit = STORE_LIMITS[store][field];
    const length = lengthOf(value.trim());
    if (!length && REQUIRED_FIELDS[store].includes(field)) problems.push({ field, code: 'required', message: `${label} is required by ${STORE_NAMES[store].replace(/^The/, 'the')}.` });
    else if (length > limit) problems.push({ field, code: 'too_long', limit, length, message: `${label} is ${length} characters. ${STORE_NAMES[store]} allows ${limit}.` });
    if (namesPlatform(value)) problems.push({ field, code: 'names_platform', message: `${label} must name your business only.` });
  }
  return problems;
}

// ---- listing assets ----

const PNG = 'image/png';
const JPEG = 'image/jpeg';
/** The spec of every image the stores and the build take. */
export const ASSET_SPECS = freeze({
  source_icon: freeze({ minSize: 1024, square: true, mimes: freeze([PNG, JPEG]) }),
  icon_ios: freeze({ width: 1024, height: 1024, mime: PNG, alpha: false }),
  icon_play: freeze({ width: 512, height: 512, mime: PNG, maxBytes: STORE_LIMITS.play.icon.maxBytes }),
  adaptive_foreground: freeze({ width: 1024, height: 1024, mime: PNG, alpha: true, safeZone: 0.66 }),
  /** Or a plain colour (app_configs.splash_background or the brand kit's primary). */
  adaptive_background: freeze({ width: 1024, height: 1024, mime: PNG, alpha: false }),
  notification_icon: freeze({ width: 96, height: 96, mime: PNG, alpha: true, monochrome: true }),
  splash: freeze({ width: 1024, height: 1024, mime: PNG }),
  feature_graphic: freeze({ width: STORE_LIMITS.play.featureGraphic.width, height: STORE_LIMITS.play.featureGraphic.height, mimes: freeze([PNG, JPEG]), alpha: false }),
  screenshot_phone: STORE_LIMITS.play.screenshots,
  screenshot_iphone_6_9: freeze({ sizes: STORE_LIMITS.appStore.screenshots.sizes.iphone_6_9, mimes: freeze([PNG, JPEG]), alpha: false }),
  screenshot_iphone_6_5: freeze({ sizes: STORE_LIMITS.appStore.screenshots.sizes.iphone_6_5, mimes: freeze([PNG, JPEG]), alpha: false }),
});
const ASSET_NAMES = freeze({
  source_icon: 'The app icon', icon_ios: 'The App Store icon', icon_play: 'The Google Play icon', adaptive_foreground: 'The adaptive icon’s foreground',
  adaptive_background: 'The adaptive icon’s background', notification_icon: 'The notification icon', splash: 'The splash image',
  feature_graphic: 'The feature graphic', screenshot_phone: 'A phone screenshot', screenshot_iphone_6_9: 'A 6.9-inch iPhone screenshot',
  screenshot_iphone_6_5: 'A 6.5-inch iPhone screenshot',
});

/** The ASSET_SPECS key of a listing_assets row: icon on ios is icon_ios, a screenshot on iphone_6_9 is screenshot_iphone_6_9. */
export function assetSpecKey(platform, kind, device = '') {
  if (kind === 'icon') return platform === 'ios' ? 'icon_ios' : 'icon_play';
  if (kind === 'screenshot') return device ? `screenshot_${device}` : null;
  return Object.hasOwn(ASSET_SPECS, kind) ? kind : null;
}

const typeName = (mime) => (mime === PNG ? 'PNG' : mime === JPEG ? 'JPEG' : 'image');
const sizeText = ([w, h]) => `${w} x ${h}`;

/** An image's problems against its spec: [{ code, message }], [] when it passes. The message is the store's rule in plain words. */
export function checkAsset(kind, { width, height, mime, hasAlpha = false, bytes = 0, monochrome } = {}) {
  const spec = ASSET_SPECS[kind];
  if (!spec) return [{ code: 'unknown_kind', message: 'This is not an image the stores take.' }];
  const name = ASSET_NAMES[kind];
  const problems = [];
  const w = Number(width);
  const h = Number(height);
  const mimes = spec.mimes ?? (spec.mime ? [spec.mime] : null);
  if (mimes && !mimes.includes(mime)) problems.push({ code: 'wrong_type', message: `${name} must be a ${mimes.map(typeName).join(' or ')} file.` });
  if (spec.width && (w !== spec.width || h !== spec.height)) {
    problems.push({ code: 'wrong_size', message: `${name} must be ${spec.width} x ${spec.height} pixels; this one is ${w} x ${h}.` });
  }
  if (spec.minSize && (w < spec.minSize || h < spec.minSize)) problems.push({ code: 'too_small', message: `${name} must be at least ${spec.minSize} x ${spec.minSize} pixels; this one is ${w} x ${h}.` });
  if (spec.square && w !== h) problems.push({ code: 'not_square', message: `${name} must be square; this one is ${w} x ${h}.` });
  if (spec.sizes) {
    const portrait = spec.sizes.some(([sw, sh]) => sw === w && sh === h);
    const landscape = spec.sizes.some(([sw, sh]) => sh === w && sw === h);
    if (!portrait && !landscape) problems.push({ code: 'wrong_size', message: `${name} must be one of ${spec.sizes.map(sizeText).join(', ')} pixels (or turned on its side); this one is ${w} x ${h}.` });
  }
  if (spec.minSide) {
    const short = Math.min(w, h);
    const long = Math.max(w, h);
    if (short < spec.minSide || long > spec.maxSide) problems.push({ code: 'wrong_size', message: `${name} must be between ${spec.minSide} and ${spec.maxSide} pixels on each side; this one is ${w} x ${h}.` });
    else if (long > short * spec.maxRatio) problems.push({ code: 'wrong_ratio', message: `${name}’s long side can be at most ${spec.maxRatio} times its short side; this one is ${w} x ${h}.` });
  }
  if (spec.alpha === false && hasAlpha) problems.push({ code: 'has_alpha', message: `${name} can’t be transparent. Use a solid background.` });
  if (spec.alpha === true && hasAlpha === false && kind === 'notification_icon') problems.push({ code: 'needs_alpha', message: `${name} needs a transparent background.` });
  if (spec.monochrome && monochrome === false) problems.push({ code: 'not_monochrome', message: `${name} must be one colour on a transparent background.` });
  if (spec.maxBytes && Number(bytes) > spec.maxBytes) problems.push({ code: 'too_large', message: `${name} must be ${Math.round(spec.maxBytes / 1024)} KB or less.` });
  return problems;
}

// ---- the pre-submit gate (10.14) ----

export const ANDROID_TARGET_SDK_MIN = 36;
export const IOS_XCODE_MIN = 26;
export const IOS_SDK_MIN = '26.0';

/** What must pass before a build goes to review. presubmit_runs.checks holds one { code, guideline, passed, detail } per code. */
export const PRESUBMIT_CHECKS = freeze([
  freeze({ code: 'native_screens', guideline: '4.2', platforms: APP_PLATFORMS, title: 'The nine screens are native; no WebView library in the build' }),
  freeze({ code: 'account_deletion', guideline: '5.1.1(v)', platforms: APP_PLATFORMS, title: 'The account screen offers Delete my account and the server route answers' }),
  freeze({ code: 'gateway_payments', guideline: '3.1.3(e)', platforms: APP_PLATFORMS, title: 'No in-app purchase library or entitlement; payment is the gateway’s' }),
  freeze({ code: 'demo_access', guideline: '2.1(a)', platforms: APP_PLATFORMS, title: 'Review access is on and signs in against this store' }),
  freeze({ code: 'push_opt_in_out', guideline: '4.5.4', platforms: APP_PLATFORMS, title: 'Three toggles; offers and new reels off by default; no permission request at launch' }),
  freeze({ code: 'target_api', guideline: 'play:target_api', platforms: freeze(['android']), title: `targetSdkVersion is at least ${ANDROID_TARGET_SDK_MIN}` }),
  freeze({ code: 'ios_sdk', guideline: 'ios:sdk', platforms: freeze(['ios']), title: `Built with Xcode ${IOS_XCODE_MIN} or later and the iOS ${IOS_SDK_MIN} SDK` }),
  freeze({ code: 'privacy_manifest', guideline: 'ios:privacy_manifest', platforms: freeze(['ios']), title: 'PrivacyInfo.xcprivacy is present with every required-reason API declared' }),
  freeze({ code: 'brand_only', guideline: '', platforms: APP_PLATFORMS, title: 'Only the business’s brand in the bundle’s strings, config and hosts' }),
]);
export const presubmitChecksFor = (platform) => PRESUBMIT_CHECKS.filter((check) => check.platforms.includes(platform));

/** True when every check for that platform is present in `checks` and passed. */
export function presubmitPassed(platform, checks = []) {
  const wanted = presubmitChecksFor(platform);
  if (!wanted.length || !Array.isArray(checks)) return false;
  return wanted.every((check) => checks.some((c) => c?.code === check.code && c.passed === true));
}

// ---- rejections and playbooks ----

const playbook = (code, guideline, title, autoResubmit = false) => freeze({ code, guideline, title, doc: `docs/playbooks/${code}.md`, autoResubmit });
/** A rejection's guideline to what to do about it. autoResubmit: the fix is data (metadata, review access), so it can go back without a new build. */
export const PLAYBOOKS = freeze({
  '4.2': playbook('4.2', '4.2', 'Minimum functionality'),
  '4.2.6': playbook('4.2.6', '4.2.6', 'Apps made from a template'),
  '4.3': playbook('4.3', '4.3', 'Spam and duplicate apps'),
  '2.1': playbook('2.1', '2.1', 'App completeness and demo access', true),
  '2.3': playbook('2.3', '2.3', 'Accurate metadata', true),
  '2.5.2': playbook('2.5.2', '2.5.2', 'Code downloaded after review'),
  '3.1.3': playbook('3.1.3', '3.1.3', 'Payments outside in-app purchase'),
  '4.5.4': playbook('4.5.4', '4.5.4', 'Push notifications'),
  '4.8': playbook('4.8', '4.8', 'Sign in with Apple'),
  '5.1.1': playbook('5.1.1', '5.1.1', 'Data collection and account deletion'),
  '5.1.2': playbook('5.1.2', '5.1.2', 'Data use and sharing', true),
  play_target_api: playbook('play_target_api', 'play:target_api', 'Target API level'),
  play_data_safety: playbook('play_data_safety', 'play:data_safety', 'Data safety form', true),
  play_closed_testing: playbook('play_closed_testing', 'play:closed_testing', 'Closed testing before production'),
  unknown: playbook('unknown', '', 'Something else the store asked for'),
});

/** The guideline without its bracket: '4.3(a)' and '4.3' are one guideline (app_rejections.guideline_key). */
export const guidelineKey = (guideline) => String(guideline ?? '').replace(/\(.*$/, '');

/** Exact; then without its bracket ('5.1.1(v)' to '5.1.1'); then its parents ('4.2.3' to '4.2'); else 'unknown'. */
export function playbookFor(guideline) {
  const raw = String(guideline ?? '').trim().replace(/:/g, '_');
  if (Object.hasOwn(PLAYBOOKS, raw)) return PLAYBOOKS[raw];
  let key = guidelineKey(raw);
  while (key) {
    if (Object.hasOwn(PLAYBOOKS, key)) return PLAYBOOKS[key];
    const cut = key.lastIndexOf('.');
    if (cut <= 0) break;
    key = key.slice(0, cut);
  }
  return PLAYBOOKS.unknown;
}

// ---- shopper push (10.11) ----

/** weeklyCap is the default; config.shopperPushWeeklyCap (SHOPPER_PUSH_WEEKLY_CAP) is what the code reads. */
export const SHOPPER_PUSH_RULES = freeze({
  weeklyCap: 2, cappedKinds: freeze(['offer', 'new_reel']), weekStartsOn: 'monday', timezone: 'Asia/Kolkata',
  quietFromHour: 21, quietToHour: 9, mergeMs: 60_000, titleMax: 65, bodyMax: 178, ttlSeconds: 21_600, maxAttempts: 3,
});
export const SHOPPER_PUSH_TOGGLES = freeze(['order_updates', 'offers', 'new_reels']);
export const SHOPPER_PUSH_LOG_KINDS = freeze(['order_update', 'offer', 'new_reel']);

const orderLink = '/account/orders/{orderNumber}';
/** The wording of every shopper push, in the seller's voice and brand. Order kinds are order events (ORDER_EVENTS); new_reel is the category outbox. */
export const SHOPPER_PUSH_KINDS = freeze({
  'order.confirmed': freeze({ title: 'Order confirmed', body: 'Order {orderNumber} is confirmed.', link: orderLink }),
  'order.shipped': freeze({ title: 'On its way', body: 'Order {orderNumber} has shipped. Tap to track it.', link: orderLink }),
  'order.out_for_delivery': freeze({ title: 'Arriving today', body: 'Order {orderNumber} is out for delivery.', link: orderLink }),
  'order.delivered': freeze({ title: 'Delivered', body: 'Order {orderNumber} was delivered.', link: orderLink }),
  'order.cancelled': freeze({ title: 'Order cancelled', body: 'Order {orderNumber} was cancelled.', link: orderLink }),
  'refund.processed': freeze({ title: 'Refund sent', body: 'Your refund for order {orderNumber} is on its way.', link: orderLink }),
  new_reel: freeze({ title: 'New in {category}', body: 'Tap to watch.', link: '/r/{slug}' }),
});

/** Fills {name} placeholders; a missing value leaves nothing behind. */
export const fillPush = (template, values = {}) => String(template).replace(/\{(\w+)\}/g, (_m, name) => (values[name] === undefined || values[name] === null ? '' : String(values[name]))).replace(/\s{2,}/g, ' ').trim();

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const istParts = (date) => new Date(new Date(date).getTime() + IST_OFFSET_MS);

/** The Monday that starts the week of `date`, in Asia/Kolkata, as 'YYYY-MM-DD' (shopper_push_log.week_start). */
export function weekStart(date = new Date()) {
  const ist = istParts(date);
  const back = (ist.getUTCDay() + 6) % 7;
  return new Date(ist.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

/** True between 21:00 and 09:00 in Asia/Kolkata: offers and new-reel pushes wait; order updates never do. */
export function inQuietHours(date = new Date()) {
  const hour = istParts(date).getUTCHours();
  return hour >= SHOPPER_PUSH_RULES.quietFromHour || hour < SHOPPER_PUSH_RULES.quietToHour;
}

const PERSONAL_RULES = [
  ['email', /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ['payment', /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/], // a card number
  ['phone', /(?<![\w-])\+?\d(?:[ -]?\d){9,13}(?![\w-])/],
  ['payment', /(?<![\w.-])[\w.-]{2,}@[a-z][a-z0-9]+(?![\w.@-])/i], // a UPI id
  ['payment', /\b(?:ifsc|utr|upi|a\/c|acct|account (?:no|number)|txn|transaction (?:id|ref)|ref(?:erence)? (?:no|number)|cvv|card ending)\b/i],
  ['payment', /\b[A-Z]{4}0[A-Z0-9]{6}\b/], // an IFSC code
  ['address', /(?<![\w-])[1-9]\d{5}(?![\w-])/], // a PIN code; an order number like MM-100234 is not one
  ['address', /\b\d+[\w/-]*,?\s+(?:[A-Za-z]+\s+){0,3}(?:road|rd|street|st|lane|marg|nagar|colony|sector|block|apartments?|society|chowk)\b/i],
  ['address', /\b(?:flat|house|plot|h)\.? ?no\b|\bpin ?code\b|\blandmark\b/i],
];

/**
 * Why a shopper push may not be sent, or null. Run on the final title, body and data of every push. Refuses an empty title,
 * either length over its limit, a phone number, an email address, a PIN code or address words, a card number, a UPI id or a
 * bank or transaction reference, the platform's name, data keys other than link and kind, and a link that is not a path the
 * app opens (APP_LINK_PATHS).
 */
export function shopperPushProblem({ title, body = '', data = {} } = {}) {
  const t = String(title ?? '').trim();
  const b = String(body ?? '');
  if (!t) return 'empty_title';
  if (lengthOf(t) > SHOPPER_PUSH_RULES.titleMax) return 'title_too_long';
  if (lengthOf(b) > SHOPPER_PUSH_RULES.bodyMax) return 'body_too_long';
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'data_keys';
  if (Object.keys(data).some((key) => !['link', 'kind'].includes(key))) return 'data_keys';
  if (!isAppLinkPath(data.link)) return 'link';
  if (data.kind !== undefined && !SHOPPER_PUSH_LOG_KINDS.includes(data.kind)) return 'data_keys';
  const text = `${t}\n${b}`;
  if (namesPlatform(text) || namesPlatform(data.link)) return 'names_platform';
  for (const [reason, pattern] of PERSONAL_RULES) if (pattern.test(text)) return reason;
  return null;
}

// ---- what the app collects (data safety, privacy labels) ----

/** Payment details are the gateway's and crash counts hold no identity: neither is listed. */
export const DATA_COLLECTED = freeze([
  freeze({ type: 'name', purposes: freeze(['app_functionality']), linked: true, tracking: false, optional: true }),
  freeze({ type: 'phone', purposes: freeze(['app_functionality']), linked: true, tracking: false, optional: false }),
  freeze({ type: 'email', purposes: freeze(['app_functionality']), linked: true, tracking: false, optional: true }),
  freeze({ type: 'address', purposes: freeze(['app_functionality']), linked: true, tracking: false, optional: false }),
  freeze({ type: 'purchase_history', purposes: freeze(['app_functionality']), linked: true, tracking: false, optional: false }),
  freeze({ type: 'device_id', purposes: freeze(['app_functionality']), linked: true, tracking: false, optional: false }),
]);

// ---- the brand file ----

const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const Version = z.string().regex(APP_VERSION);
const AssetPath = z.string().regex(/^[A-Za-z0-9_-]{1,60}\.(png|jpg)$/);

/**
 * What one build is made from, written beside its images. No key, token, password or signing-key fingerprint: those come from
 * the build service's own store. The update channel is 't<tenantId>', never a name.
 */
export const BrandFile = z.strictObject({
  schema: z.literal(1),
  tenantId: z.number().int().positive(),
  name: z.string().min(1).max(30),
  shortName: z.string().min(1).max(12),
  scheme: z.string().regex(/^[a-z][a-z0-9]{2,30}$/),
  appVersion: Version,
  runtimeVersion: z.string().min(1).max(40),
  shopDomain: z.string().min(1).max(253),
  apiBaseUrl: z.string().regex(/^https:\/\/[^/]+$/),
  supportEmail: z.string().min(3).max(254),
  privacyUrl: z.string().regex(/^https:\/\//).max(500),
  android: z.strictObject({ package: z.string().max(150), versionCode: z.number().int().positive() }).nullable(),
  ios: z.strictObject({ bundleId: z.string().max(155), buildNumber: z.number().int().positive(), teamId: z.string().regex(/^[A-Z0-9]{10}$/) }).nullable(),
  associatedDomains: z.array(z.string().max(260)).max(10),
  linkHosts: z.array(z.string().max(253)).max(10),
  linkPaths: z.strictObject({ open: z.array(z.string()), exclude: z.array(z.string()) }),
  colors: z.record(z.string().regex(/^[a-z_]{1,20}$/), Hex),
  fonts: z.strictObject({ heading: z.string().max(80), body: z.string().max(80) }),
  splashBackground: Hex,
  assets: z.strictObject({ icon: AssetPath, adaptiveForeground: AssetPath, adaptiveBackground: AssetPath, notificationIcon: AssetPath, splash: AssetPath }),
  payDriver: z.enum(['hosted', 'native']),
  push: z.strictObject({ android: z.boolean(), ios: z.boolean() }),
  updates: z.strictObject({ channel: z.string().regex(/^t[1-9][0-9]{0,9}$/) }),
});

const ANDROID_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$/;
const IOS_BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+){1,5}$/;
const URL_SCHEME = /^[a-z][a-z0-9]{2,30}$/;
const SHA256_FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Fields of the route shape the server works out (links to images, the last check, per-platform status): not the seller's words. */
const DERIVED_FIELDS = freeze(['validation', 'iconUrl', 'splashUrl', 'android', 'ios']);
const blank = (value) => value === undefined || value === null || String(value).trim() === '';

/**
 * Everything that stops a build of this business's app, each naming its field (P-33): [{ field, code, message, platform }].
 * `config` is the app config in its route shape (AppConfig); `kit` the brand kit (repos.brandKit.get()); `hosts` this business's
 * own hosts (appConfigFor(ctx).hosts()), of which shopDomain must be one. Per platform: androidPackage and at least one Play
 * signing fingerprint (for verified links), or iosBundleId and appleTeamId. No value may name the platform.
 */
export function brandFileProblems(config = {}, kit = {}, { platforms = APP_PLATFORMS, hosts } = {}) {
  const problems = [];
  const add = (field, code, message, platform = null) => problems.push({ field, code, message, platform });
  const need = (field, message, platform = null) => {
    if (blank(config[field])) {
      add(field, 'required', message, platform);
      return false;
    }
    return true;
  };

  if (need('appName', 'Give your app a name.') && lengthOf(config.appName) > 30) add('appName', 'too_long', 'The app name can be at most 30 characters.');
  if (need('shortName', 'Give the short name shown under the icon.') && lengthOf(config.shortName) > 12) add('shortName', 'too_long', 'The short name can be at most 12 characters.');
  if (need('shopDomain', 'Choose the web address the app opens links for.') && Array.isArray(hosts) && !hosts.map((h) => String(h).toLowerCase()).includes(String(config.shopDomain).toLowerCase())) {
    add('shopDomain', 'not_own_host', 'Use one of your own store addresses.');
  }
  if (need('supportEmail', 'Add an email address shoppers can write to.') && !EMAIL.test(String(config.supportEmail))) add('supportEmail', 'invalid', 'Enter a valid email address.');
  if (need('privacyUrl', 'Add the link to your privacy policy. Both stores need it.') && !/^https:\/\//.test(String(config.privacyUrl))) add('privacyUrl', 'not_https', 'The privacy policy link must start with https://.');
  need('iconMediaId', 'Upload the app icon: a square image of at least 1024 x 1024 pixels.');
  if (need('urlScheme', 'Choose the app’s link name: lower-case letters and digits, starting with a letter.') && !URL_SCHEME.test(String(config.urlScheme))) {
    add('urlScheme', 'invalid', 'Use 3 to 31 lower-case letters and digits, starting with a letter.');
  }
  const colors = { ...(kit?.colors ?? {}), ...(config.colorOverrides ?? config.colors ?? {}) };
  if (!/^#[0-9A-Fa-f]{6}$/.test(String(colors.primary ?? ''))) add('colors', 'required', 'Set your brand’s main colour in the brand kit.');

  for (const platform of platforms) {
    if (platform === 'android') {
      if (need('androidPackage', 'Choose the Android package name, like com.yourbrand.shop.', 'android') && !ANDROID_PACKAGE.test(String(config.androidPackage))) {
        add('androidPackage', 'invalid', 'Use lower-case words joined by dots, like com.yourbrand.shop.', 'android');
      }
      const prints = Array.isArray(config.playSigningSha256) ? config.playSigningSha256 : [];
      if (!prints.length) add('playSigningSha256', 'required', 'Add the app signing certificate’s SHA-256 fingerprint from Google Play, so links open the app.', 'android');
      else if (!prints.every((p) => SHA256_FINGERPRINT.test(String(p)))) add('playSigningSha256', 'invalid', 'A fingerprint is 32 pairs of capital hex digits joined by colons.', 'android');
    } else if (platform === 'ios') {
      if (need('iosBundleId', 'Choose the iOS bundle ID, like com.yourbrand.shop.', 'ios') && !IOS_BUNDLE_ID.test(String(config.iosBundleId))) {
        add('iosBundleId', 'invalid', 'Use words joined by dots, like com.yourbrand.shop.', 'ios');
      }
      if (need('appleTeamId', 'Add your Apple Developer team ID (10 letters and digits).', 'ios') && !/^[A-Z0-9]{10}$/.test(String(config.appleTeamId))) {
        add('appleTeamId', 'invalid', 'The team ID is 10 capital letters and digits.', 'ios');
      }
    }
  }

  const seen = new Set();
  const visit = (field, value) => {
    if (seen.has(field)) return;
    if (typeof value === 'string' && namesPlatform(value)) {
      seen.add(field);
      add(field, 'names_platform', 'Use your own brand here, not the platform’s name.');
    } else if (Array.isArray(value)) value.forEach((v) => visit(field, v));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => visit(field, v));
  };
  for (const [field, value] of Object.entries(config)) if (!DERIVED_FIELDS.includes(field)) visit(field, value);
  return problems;
}

/**
 * The rules behind "My app" (PRD 10.7 to 10.14), with no React, so node's test runner reads them and the owner app carries the same
 * file (apps/owner/src/features/app-publishing/rules.js; a test fails if the two differ). The console may import only the access rules
 * from the contract, so these are the server's own values written out; test/p6/console-apps/rules.test.js fails the moment one differs
 * from src/contracts/apps.js and src/contracts/api/apps.js. Every message names the field it is about.
 */

export const PLATFORMS = Object.freeze(['android', 'ios']);
export const PLATFORM_LABELS = Object.freeze({ android: 'Android', ios: 'iPhone and iPad' });
export const STORE_LABELS = Object.freeze({ android: 'Google Play', ios: 'the App Store' });
export const PLATFORM_FEATURES = Object.freeze({ android: 'app.android', ios: 'app.ios' });
export const isPlatform = (value) => PLATFORMS.includes(value);

/** A 403 for a feature the plan lacks (the long reason and the short one). */
export const PLAN_REASONS = Object.freeze(['plan', 'plan.not_included']);
export const isPlanRefusal = (error) => error?.status === 403 && PLAN_REASONS.includes(error?.reason);

const PLATFORM_WORD = /bhava/i;
export const namesPlatform = (text) => PLATFORM_WORD.test(String(text ?? ''));
const count = (text) => [...String(text ?? '')].length;
const blank = (value) => !String(value ?? '').trim();

// ---- the app's own fields (AppConfigUpdate) ----

/** In the order they are shown. `max` is the contract's limit; `nullable` fields are sent as null when emptied. */
export const APP_FIELDS = Object.freeze({
  appName: { label: 'App name', max: 30, required: true, hint: 'Shown on the shopper’s home screen and in the store.' },
  shortName: { label: 'Short name', max: 12, required: true, hint: 'Shown under the icon, so keep it short.' },
  shopDomain: { label: 'Store web address', max: 253, required: true, hint: 'One of your own store addresses, like shop.yourbrand.in. Links to it open the app.' },
  supportEmail: { label: 'Support email', max: 254, required: true, hint: 'Where shoppers can write to you.' },
  privacyUrl: { label: 'Privacy policy link', max: 500, required: true, hint: 'Both stores need it. It must start with https://' },
  urlScheme: { label: 'App link name', max: 31, required: true, nullable: true, hint: '3 to 31 lower-case letters and digits, starting with a letter.' },
  androidPackage: { label: 'Android package name', max: 150, platform: 'android', nullable: true, hint: 'Like com.yourbrand.shop. It cannot change after the app is published.' },
  playAccountId: { label: 'Google Play developer account ID', max: 25, platform: 'android', hint: 'Digits only. Find it in your Play Console under Settings.' },
  playSigningSha256: { label: 'Play app signing fingerprint', platform: 'android', hint: 'The SHA-256 fingerprint from Play Console. One per line.' },
  iosBundleId: { label: 'iOS bundle ID', max: 155, platform: 'ios', nullable: true, hint: 'Like com.yourbrand.shop. It cannot change after the app is published.' },
  appleTeamId: { label: 'Apple Developer team ID', max: 10, platform: 'ios', hint: '10 capital letters and digits, from your Apple Developer account.' },
  splashBackground: { label: 'Splash background colour', max: 7, hint: 'Optional. A colour like #234D33. Left empty, your brand colour is used.' },
});
export const APP_FIELD_NAMES = Object.freeze(Object.keys(APP_FIELDS));

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ANDROID_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$/;
const IOS_BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+){1,5}$/;
const URL_SCHEME = /^[a-z][a-z0-9]{2,30}$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** The lines of a fingerprints box: trimmed, capitalised, blanks dropped. */
export const fingerprintLines = (text) => String(text ?? '').split(/[\r\n,]+/).map((line) => line.trim().toUpperCase()).filter(Boolean);

/** What is wrong with one field's text, in words that name the field; '' when it is fine. Used as you type and again on save. */
export function appFieldProblem(name, value) {
  const spec = APP_FIELDS[name];
  if (!spec) return '';
  const text = String(value ?? '').trim();
  const { label } = spec;
  if (name === 'playSigningSha256') {
    const lines = fingerprintLines(value);
    if (lines.length > 5) return `${label}: add at most 5 fingerprints.`;
    const bad = lines.findIndex((line) => !FINGERPRINT.test(line));
    return bad >= 0 ? `${label}: line ${bad + 1} is not a fingerprint. A fingerprint is 32 pairs of hex digits joined by colons.` : '';
  }
  if (!text) return spec.required ? `${label} is needed before we can build your app.` : '';
  if (spec.max && count(text) > spec.max) return `${label} is ${count(text)} characters. The most is ${spec.max}.`;
  if (namesPlatform(text)) return `${label}: use your own brand here, not the platform’s name.`;
  switch (name) {
    case 'shopDomain': return /^[a-z0-9.-]+$/i.test(text) && text.includes('.') ? '' : `${label}: use a web address like shop.yourbrand.in, without https://.`;
    case 'supportEmail': return EMAIL.test(text) ? '' : `${label}: enter a valid email address.`;
    case 'privacyUrl': return /^https:\/\/\S+$/.test(text) ? '' : `${label}: use a link that starts with https://`;
    case 'urlScheme': return URL_SCHEME.test(text) ? '' : `${label}: use 3 to 31 lower-case letters and digits, starting with a letter.`;
    case 'androidPackage': return ANDROID_PACKAGE.test(text) ? '' : `${label}: use lower-case words joined by dots, like com.yourbrand.shop.`;
    case 'iosBundleId': return IOS_BUNDLE_ID.test(text) ? '' : `${label}: use words joined by dots, like com.yourbrand.shop.`;
    case 'appleTeamId': return /^[A-Z0-9]{10}$/.test(text) ? '' : `${label}: the team ID is 10 capital letters and digits.`;
    case 'playAccountId': return /^[0-9]{6,25}$/.test(text) ? '' : `${label}: digits only, 6 to 25 of them.`;
    case 'splashBackground': return HEX.test(text) ? '' : `${label}: use a colour like #234D33.`;
    default: return '';
  }
}

/** The editable form's starting values from the server's AppConfig. */
export function configToForm(config = {}) {
  const form = {};
  for (const name of APP_FIELD_NAMES) form[name] = name === 'playSigningSha256' ? (config.playSigningSha256 ?? []).join('\n') : String(config[name] ?? '');
  return form;
}

/**
 * { body, errors }: only the fields that changed (a save leaves out what it does not mention), emptied nullable fields as null,
 * and every field's problem by name. A field is checked only when it is filled or was changed, so a half-set-up app can still save.
 */
export function formToUpdate(form, config = {}) {
  const before = configToForm(config);
  const body = {};
  const errors = {};
  for (const name of APP_FIELD_NAMES) {
    const now = form[name] ?? '';
    const changed = name === 'playSigningSha256' ? fingerprintLines(now).join('\n') !== fingerprintLines(before[name]).join('\n') : String(now).trim() !== before[name].trim();
    const problem = appFieldProblem(name, now);
    if (problem && (changed || !blank(now))) errors[name] = problem;
    if (!changed || problem) continue;
    if (name === 'playSigningSha256') body[name] = fingerprintLines(now);
    else if (name === 'shopDomain') body[name] = String(now).trim().toLowerCase();
    else body[name] = blank(now) && APP_FIELDS[name].nullable ? null : String(now).trim();
  }
  return { body, errors };
}

/** The fields a platform needs, for showing only that platform's boxes. */
export const fieldsFor = (platform) => APP_FIELD_NAMES.filter((name) => !APP_FIELDS[name].platform || APP_FIELDS[name].platform === platform);

// ---- builds ----

export const BUILD_STATUS = Object.freeze({
  queued: ['Waiting', 'neutral'], building: ['Building', 'neel'], built: ['Ready', 'good'], failed: ['Failed', 'bad'], submitted: ['Sent to the store', 'good'],
});
export const BUILD_STEP_LABELS = Object.freeze({ load: 'Reading your app details', validate: 'Checking your app details', assets: 'Preparing the images', brand_file: 'Writing your brand into the app', build: 'Building the app' });
export const buildActive = (build) => build?.status === 'queued' || build?.status === 'building';

// ---- store accounts (10.9) ----

export const ACCOUNT_TYPES = Object.freeze([['personal', 'Personal'], ['organisation', 'Organisation']]);
export const DUNS_OPTIONS = Object.freeze([['not_needed', 'Not needed'], ['waiting', 'I applied and am waiting'], ['have', 'I have the number']]);
export const ACCESS_STATUS = Object.freeze({
  not_checked: ['Not checked yet', 'neutral'], ok: ['Working', 'good'], role_too_low: ['Role too low', 'warn'], invalid: ['Key not accepted', 'bad'], unreachable: ['Could not reach the store', 'warn'],
});

/** Text that would be a store password or sign-in. The pages never have a box for one; this refuses one pasted into a key box. */
export const looksLikeStorePassword = (text) => /\b(?:password|passcode|passwd|app[- ]specific)\b\s*[:=]/i.test(String(text ?? ''));

const PEM_KEY = /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----[\s\S]+-----END (?:EC |RSA )?PRIVATE KEY-----/;

/** A .p8 key pasted into a one-line box loses its line breaks; this puts them back (64 characters a line) so the server can read it. */
export function normalisePem(text) {
  const raw = String(text ?? '').trim();
  const match = /^(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]+?)(-----END [A-Z ]*PRIVATE KEY-----)$/.exec(raw);
  if (!match) return raw;
  const body = match[2].replace(/\s+/g, '');
  return `${match[1]}\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n${match[3]}`;
}

/** The App Store Connect key form. Returns { body, errors } by field. The key must be a .p8 key, never a password. */
export function ascKeyProblems(values) {
  const errors = {};
  const keyId = String(values.keyId ?? '').trim();
  const issuerId = String(values.issuerId ?? '').trim().toLowerCase();
  const key = String(values.privateKey ?? '');
  if (!keyId) errors.keyId = 'Key ID is needed.';
  else if (!/^[A-Z0-9]{10}$/.test(keyId)) errors.keyId = 'Key ID is 10 capital letters and digits.';
  if (!issuerId) errors.issuerId = 'Issuer ID is needed.';
  else if (!/^[0-9a-f-]{36}$/.test(issuerId)) errors.issuerId = 'Issuer ID looks like 57246542-96fe-1a63-e053-0824d011072a.';
  if (!key.trim()) errors.privateKey = 'Private key (.p8) is needed.';
  else if (looksLikeStorePassword(key) || !PEM_KEY.test(key)) errors.privateKey = 'Private key: paste the contents of the .p8 file, from BEGIN PRIVATE KEY to END PRIVATE KEY. We never ask for your Apple password.';
  else if (key.length > 5000) errors.privateKey = 'Private key is too long. Paste only the .p8 file.';
  return { body: Object.keys(errors).length ? null : { keyId, issuerId, privateKey: normalisePem(key) }, errors };
}

/** The closed-test numbers for the Play steps. */
export const CLOSED_TEST = Object.freeze({ testers: 12, days: 14 });
export const closedTestSummary = (test) => {
  if (!test || test.status === 'not_needed') return '';
  if (test.status === 'done') return `Done: ${test.testers ?? CLOSED_TEST.testers} testers for ${test.daysDone} days.`;
  if (test.status === 'running') return `Day ${test.daysDone} of ${test.daysNeeded}, with ${test.testers ?? 0} of ${test.testersNeeded} testers.`;
  return `Google needs ${test.testersNeeded} testers for ${test.daysNeeded} days in a row before you can publish.`;
};

// ---- store listing (10.13) ----

export const LISTING_LIMITS = Object.freeze({
  android: Object.freeze({ title: 30, shortDescription: 80, fullDescription: 4000, whatsNew: 500 }),
  ios: Object.freeze({ title: 30, shortDescription: 30, fullDescription: 4000, keywords: 100, whatsNew: 4000 }),
});
export const LISTING_LABELS = Object.freeze({
  android: Object.freeze({ title: 'Title', shortDescription: 'Short description', fullDescription: 'Full description', whatsNew: 'Release notes' }),
  ios: Object.freeze({ title: 'Name', shortDescription: 'Subtitle', fullDescription: 'Description', keywords: 'Keywords', whatsNew: 'What’s New' }),
});
export const LISTING_REQUIRED = Object.freeze({ android: Object.freeze(['title', 'shortDescription', 'fullDescription']), ios: Object.freeze(['title', 'fullDescription']) });
export const LISTING_LONG = Object.freeze(['fullDescription', 'whatsNew']);
export const listingFieldNames = (platform) => Object.keys(LISTING_LABELS[platform] ?? {});

/** One field as you type: how many characters, how many are left, and the problem (naming the field and the store), if any. */
export function listingField(platform, name, value, limits = LISTING_LIMITS[platform]) {
  const label = LISTING_LABELS[platform]?.[name] ?? name;
  const limit = limits?.[name] ?? LISTING_LIMITS[platform]?.[name] ?? 0;
  const length = count(String(value ?? '').trim());
  const store = STORE_LABELS[platform] ?? '';
  let problem = '';
  if (!length && LISTING_REQUIRED[platform]?.includes(name)) problem = `${label} is required by ${store}.`;
  else if (limit && length > limit) problem = `${label} is ${length} characters. ${store.charAt(0).toUpperCase()}${store.slice(1)} allows ${limit}.`;
  else if (namesPlatform(value)) problem = `${label} must name your business only.`;
  return { label, length, limit, left: limit - length, over: Boolean(limit) && length > limit, problem };
}

/** Every field's problem by name; {} when the listing can be saved. */
export function listingProblems(platform, values, limits) {
  const found = {};
  for (const name of listingFieldNames(platform)) {
    const { problem } = listingField(platform, name, values[name], limits);
    if (problem) found[name] = problem;
  }
  return found;
}

export const listingToForm = (platform, listing = {}) => Object.fromEntries(listingFieldNames(platform).map((name) => [name, String(listing[name] ?? '')]));

/** { body, errors }; the body carries only the fields this store has, trimmed. A required field that is empty blocks saving. */
export function formToListing(platform, values, limits) {
  const errors = listingProblems(platform, values, limits);
  const body = Object.fromEntries(listingFieldNames(platform).map((name) => [name, String(values[name] ?? '').trim()]));
  return { body: Object.keys(errors).length ? null : body, errors };
}

// ---- submissions and rejections (10.10) ----

export const SUBMISSION_STATE = Object.freeze({
  draft: ['Not sent yet', 'neutral'], in_review: ['In review', 'neel'], rejected: ['Rejected', 'bad'], approved: ['Approved', 'good'], live: ['Live', 'good'],
});

/** What to do about a rejection, by playbook code. Plain words for the owner; the team does the work, the owner supplies what is theirs. */
export const PLAYBOOK_ADVICE = Object.freeze({
  '4.2': 'The store thinks the app does too little. We add your shop’s own content and screens and send it again.',
  '4.2.6': 'The store thinks the app is a template. We show what is yours (brand, products, reels) and send it again.',
  '4.3': 'The store thinks this is a copy of another app. We explain that it is your own brand’s shop and send it again.',
  '2.1': 'The reviewer could not use the app. Check that review access is on, then it goes back without a new build.',
  '2.3': 'Something in the listing did not match the app. Fix the wording under Store listing; it goes back without a new build.',
  '2.5.2': 'The app must not download code after review. We change the build and send it again.',
  '3.1.3': 'Payments in the app go through your payment gateway. We explain this to the reviewer and send it again.',
  '4.5.4': 'The reviewer found an issue with push notifications. We check the three switches and send it again.',
  '4.8': 'The reviewer asked about Sign in with Apple. We check the sign-in options and send it again.',
  '5.1.1': 'The store needs account deletion and clear data collection. We check both and send it again.',
  '5.1.2': 'The store asked about how data is used. Fix the privacy answers; it goes back without a new build.',
  play_target_api: 'Google needs a newer Android version in the build. We rebuild and send it again.',
  play_data_safety: 'Google needs the data safety form fixed. We update it; it goes back without a new build.',
  play_closed_testing: 'Google needs a closed test first: 12 testers for 14 days in a row. See Store accounts.',
  unknown: 'The store asked for something else. Read its message below, then ask the Bhava team to help.',
});
export const adviceFor = (code) => PLAYBOOK_ADVICE[code] ?? PLAYBOOK_ADVICE.unknown;

// ---- offers by push (10.11) ----

export const PUSH_LIMITS = Object.freeze({ titleMax: 65, bodyMax: 178, weeklyCap: 2 });
const SAFE_PATH = /^\/[A-Za-z0-9/_.~-]*$/;
const OPEN_PATHS = ['/', '/shop', '/reels', '/cart', '/r/*', '/p/*', '/c/*', '/order/*', '/track/*', '/account/orders/*', '/refer/*'];
const EXCLUDED_PATHS = ['/auth/*', '/login', '/logout', '/checkout', '/policies/*', '/unsubscribe/*', '/cart/restore/*', '/account/shared-profile', '/admin', '/admin/*', '/api/*', '/media/*', '/webhooks/*', '/.well-known/*', '/lead', '/lead/*'];
const matches = (path, pattern) => (pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) && path.length > pattern.length - 1 : path === pattern);
export function isAppLinkPath(path) {
  if (typeof path !== 'string' || !SAFE_PATH.test(path) || path.includes('//') || path.split('/').includes('..') || path.length > 200) return false;
  if (EXCLUDED_PATHS.some((p) => matches(path, p))) return false;
  return OPEN_PATHS.some((p) => matches(path, p));
}

const PERSONAL_RULES = [
  ['email', /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ['payment', /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/],
  ['phone', /(?<![\w-])\+?\d(?:[ -]?\d){9,13}(?![\w-])/],
  ['payment', /(?<![\w.-])[\w.-]{2,}@[a-z][a-z0-9]+(?![\w.@-])/i],
  ['payment', /\b(?:ifsc|utr|upi|a\/c|acct|account (?:no|number)|txn|transaction (?:id|ref)|ref(?:erence)? (?:no|number)|cvv|card ending)\b/i],
  ['payment', /\b[A-Z]{4}0[A-Z0-9]{6}\b/],
  ['address', /(?<![\w-])[1-9]\d{5}(?![\w-])/],
  ['address', /\b\d+[\w/-]*,?\s+(?:[A-Za-z]+\s+){0,3}(?:road|rd|street|st|lane|marg|nagar|colony|sector|block|apartments?|society|chowk)\b/i],
  ['address', /\b(?:flat|house|plot|h)\.? ?no\b|\bpin ?code\b|\blandmark\b/i],
];
const PERSONAL_WORDS = Object.freeze({ email: 'an email address', phone: 'a phone number', payment: 'a payment detail', address: 'an address' });

/** The offer's problems by field, as you type. {} means it can be sent. Mirrors shopperPushProblem and the PushCampaignSend schema. */
export function offerProblems({ title = '', body = '', linkPath = '/' } = {}) {
  const found = {};
  const t = String(title).trim();
  const b = String(body);
  if (!t) found.title = 'Title is needed: give the offer a title.';
  else if (count(t) > PUSH_LIMITS.titleMax) found.title = `Title is ${count(t)} characters. The most is ${PUSH_LIMITS.titleMax}.`;
  if (!b.trim()) found.body = 'Message is needed: write the offer.';
  else if (count(b) > PUSH_LIMITS.bodyMax) found.body = `Message is ${count(b)} characters. The most is ${PUSH_LIMITS.bodyMax}.`;
  const link = String(linkPath ?? '').trim() || '/';
  if (!isAppLinkPath(link)) found.linkPath = 'Link: use a page of your store that the app opens, like /c/sale or /shop.';
  const text = `${t}\n${b}`;
  const where = found.title ? 'body' : 'title';
  if (namesPlatform(text)) found[where] ??= 'Title and message must name your business only.';
  else {
    const personal = PERSONAL_RULES.find(([, pattern]) => pattern.test(text));
    if (personal) found[where] ??= `Title and message cannot contain ${PERSONAL_WORDS[personal[0]]}. Offers go to many shoppers.`;
  }
  return found;
}

export const CAMPAIGN_STATUS = Object.freeze({
  queued: ['Waiting', 'neutral'], sending: ['Sending', 'neel'], sent: ['Sent', 'good'], blocked: ['Not sent', 'warn'], failed: ['Failed', 'bad'],
});

/** A different key for each composed offer, so a double tap sends once. */
export const newRequestKey = (prefix = 'offer') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// ---- push credentials (10.11) ----

/** Reads a pasted Firebase service account without keeping or showing it: '' when it is fine, else the problem. */
export function fcmProblem(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return 'Firebase service account is needed: paste the JSON file you downloaded from Firebase.';
  if (raw.length > 10000) return 'Firebase service account is too long. Paste only the JSON file.';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'Firebase service account is not valid JSON. Paste the whole file you downloaded from Firebase.';
  }
  if (!parsed || parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key || !parsed.project_id) {
    return 'Firebase service account must be the service account key file: it has a project_id, client_email and private_key.';
  }
  return '';
}

/** The APNs key form: { body, errors } by field. */
export function apnsProblems(values) {
  const errors = {};
  const keyId = String(values.keyId ?? '').trim();
  const teamId = String(values.teamId ?? '').trim();
  const key = String(values.key ?? '');
  if (!keyId) errors.keyId = 'APNs key ID is needed.';
  else if (!/^[A-Z0-9]{10}$/.test(keyId)) errors.keyId = 'APNs key ID is 10 capital letters and digits.';
  if (!teamId) errors.teamId = 'Apple team ID is needed.';
  else if (!/^[A-Z0-9]{10}$/.test(teamId)) errors.teamId = 'Apple team ID is 10 capital letters and digits.';
  if (!key.trim()) errors.key = 'APNs key (.p8) is needed.';
  else if (looksLikeStorePassword(key) || !PEM_KEY.test(key)) errors.key = 'APNs key: paste the contents of the .p8 file, from BEGIN PRIVATE KEY to END PRIVATE KEY.';
  else if (key.length > 5000) errors.key = 'APNs key is too long. Paste only the .p8 file.';
  const env = values.env === 'sandbox' ? 'sandbox' : 'production';
  return { body: Object.keys(errors).length ? null : { keyId, teamId, key: normalisePem(key), env }, errors };
}

export const CREDENTIAL_STATUS = Object.freeze({ not_set: ['Not set', 'neutral'], ok: ['Working', 'good'], invalid: ['Not accepted', 'bad'] });

/** One line from a server refusal: its sentence plus the fields it names. */
export function failureText(error) {
  const fields = Object.values(error?.fields ?? {}).filter((m) => typeof m === 'string' && m && m !== error.message);
  return [error?.message, ...fields].filter(Boolean).join(' ');
}

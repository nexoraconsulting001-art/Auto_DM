import { z } from 'zod';
import { APP_PLATFORMS } from '../accounts.js';
import { BUILD_REASONS, BUILD_STATUSES, BUILD_STEPS, SUBMISSION_STATES } from '../apps.js';
import { COLOR_KEYS, FONTS } from '../../modules/brand/theme.js';
import { MANAGERS, OWNER_ONLY } from './access.js';
import { Count, Id, ListQuery, Timestamp, page, text } from './common.js';

/**
 * The seller's side of the branded shopper app (PRD 10.7 to 10.14), in the console and the owner app: the app's details, its
 * builds and store review, each store's listing and our access to the business's developer accounts, and offers by push.
 * Answered by src/modules/{app-config, app-builds, app-submissions, store-listings, store-access, shopper-push}. Every handler
 * checks the plan first: 403 forbidden without app.android and app.ios, and a call for one platform needs that platform's.
 *
 * In these routes :id is the platform ('android' or 'ios'), so the client keeps one path parameter, named :id.
 * The store passwords are never asked for: StoreAccessUpdate is strict, so a body with a password, a passcode or an Apple or
 * Google sign-in name is refused, never stored. Keys and credentials are written encrypted and only ever answered masked.
 */
export const PlatformParams = z.object({ id: z.enum(APP_PLATFORMS) });
const Platform = z.enum(APP_PLATFORMS);
const RequestKey = z.string().regex(/^[\w-]{8,80}$/, 'Use 8 to 80 letters, digits, - or _');
const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #234D33');
const Font = z.string().refine((name) => Object.hasOwn(FONTS, name), 'Choose a font from the list');
const HttpsUrl = z.string().trim().max(500).regex(/^https:\/\/\S+$/, 'Use a link that starts with https://');
const Fingerprint = z.string().trim().toUpperCase().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'A fingerprint is 32 pairs of hex digits joined by colons');
const Problem = z.object({ field: z.string(), code: z.string(), message: z.string(), platform: Platform.nullable() });

export const AppValidation = z.object({ ok: z.boolean(), checkedAt: Timestamp, problems: z.array(Problem) });

const PlatformState = z.object({ entitled: z.boolean(), minVersion: z.string(), storeUrl: z.string(), locked: z.boolean() });
export const AppConfig = z.object({
  appName: z.string(),
  shortName: z.string(),
  androidPackage: z.string().nullable(),
  iosBundleId: z.string().nullable(),
  urlScheme: z.string().nullable(),
  iconMediaId: z.string().nullable(),
  iconUrl: z.string(),
  splashMediaId: z.string().nullable(),
  splashUrl: z.string(),
  splashBackground: z.string(),
  /** The colours the app uses: the overrides over the brand kit. */
  colors: z.record(z.string(), z.string()),
  colorOverrides: z.record(z.string(), z.string()),
  headingFont: z.string(),
  bodyFont: z.string(),
  fontOverrides: z.object({ heading: z.string(), body: z.string() }),
  shopDomain: z.string(),
  supportEmail: z.string(),
  privacyUrl: z.string(),
  appleTeamId: z.string(),
  playAccountId: z.string(),
  playSigningSha256: z.array(z.string()),
  android: PlatformState,
  ios: PlatformState,
  validation: AppValidation.nullable(),
});

/** Every field optional; left out stays as it is. No minimum version, store link, lock or review access: those are the console's. */
export const AppConfigUpdate = z.strictObject({
  appName: text(30),
  shortName: text(12),
  androidPackage: z.string().trim().max(150).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$/, 'Use lower-case words joined by dots, like com.yourbrand.shop').nullable(),
  iosBundleId: z.string().trim().max(155).regex(/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+){1,5}$/, 'Use words joined by dots, like com.yourbrand.shop').nullable(),
  urlScheme: z.string().trim().regex(/^[a-z][a-z0-9]{2,30}$/, 'Use 3 to 31 lower-case letters and digits, starting with a letter').nullable(),
  iconMediaId: z.uuid().nullable(),
  splashMediaId: z.uuid().nullable(),
  splashBackground: z.union([z.literal(''), Hex]),
  /** By brand-kit colour key; null clears every override. */
  colors: z.partialRecord(z.enum(COLOR_KEYS), Hex).nullable(),
  headingFont: z.union([z.literal(''), Font]),
  bodyFont: z.union([z.literal(''), Font]),
  shopDomain: z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9.-]*$/, 'Use a web address like shop.yourbrand.in'),
  supportEmail: z.union([z.literal(''), z.email('Enter a valid email').max(254)]),
  privacyUrl: z.union([z.literal(''), HttpsUrl]),
  appleTeamId: z.string().trim().regex(/^([A-Z0-9]{10})?$/, 'The team ID is 10 capital letters and digits'),
  playAccountId: z.string().trim().regex(/^([0-9]{6,25})?$/, 'The developer account ID is digits only'),
  playSigningSha256: z.array(Fingerprint).max(5),
}).partial();

export const AppBuild = z.object({
  id: Id,
  platform: Platform,
  appVersion: z.string(),
  buildNumber: z.number().int(),
  runtimeVersion: z.string(),
  status: z.enum(BUILD_STATUSES),
  reason: z.enum(BUILD_REASONS),
  failedStep: z.union([z.literal(''), z.enum(BUILD_STEPS)]),
  failedField: z.string(),
  failedMessage: z.string(),
  submitError: z.string(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  submittedAt: Timestamp.nullable(),
});
export const AppBuildQuery = ListQuery.extend({ platform: Platform.optional() });
export const AppBuildRequest = z.strictObject({ platforms: z.array(Platform).min(1).max(2), requestKey: RequestKey });

const PlaybookRef = z.object({ code: z.string(), title: z.string(), doc: z.string() });
export const AppSubmission = z.object({
  platform: Platform,
  state: z.enum(SUBMISSION_STATES),
  appVersion: z.string(),
  buildNumber: z.number().int().nullable(),
  liveVersion: z.string(),
  storeUrl: z.string(),
  submittedAt: Timestamp.nullable(),
  decidedAt: Timestamp.nullable(),
  /** The newest five. */
  rejections: z.array(z.object({ guideline: z.string(), message: z.string(), rejectedAt: Timestamp, playbook: PlaybookRef })).max(5),
  reviewTask: z.object({ guideline: z.string() }).nullable(),
  presubmit: z.object({ passed: z.boolean(), ranAt: Timestamp, checks: z.array(z.object({ code: z.string(), guideline: z.string(), passed: z.boolean(), detail: z.string() })) }).nullable(),
});

export const StoreListing = z.object({
  platform: Platform,
  title: z.string(),
  shortDescription: z.string(),
  fullDescription: z.string(),
  keywords: z.string(),
  category: z.string(),
  whatsNew: z.string(),
  /** Each field's limit on this store (STORE_LIMITS in src/contracts/apps.js). */
  limits: z.record(z.string(), z.number().int()),
  dataSafety: z.record(z.string(), z.unknown()),
  privacyLabels: z.record(z.string(), z.unknown()),
  validation: AppValidation.nullable(),
});
/** The database holds the loosest of both stores; the module checks this store's own limits and names the one passed. */
export const StoreListingUpdate = z.strictObject({
  title: text(30),
  shortDescription: text(80),
  fullDescription: text(4000),
  keywords: text(100),
  category: text(40),
  whatsNew: text(4000),
}).partial();
export const ListingAsset = z.object({
  kind: z.string(),
  device: z.string(),
  position: z.number().int(),
  url: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  source: z.enum(['generated', 'build_capture', 'upload']),
  specOk: z.boolean(),
  problems: z.array(z.object({ code: z.string(), message: z.string() })),
});

export const StoreAccess = z.object({
  platform: Platform,
  accountType: z.enum(['unknown', 'personal', 'organisation']),
  legalName: z.string(),
  dunsStatus: z.enum(['unknown', 'not_needed', 'waiting', 'have']),
  dunsLookupUrl: z.string(),
  closedTest: z.object({ status: z.enum(['not_needed', 'required', 'running', 'done']), startedAt: Timestamp.nullable(), testers: z.number().int().nullable(), testersNeeded: z.literal(12), daysNeeded: z.literal(14), daysDone: z.number().int() }),
  credential: z.object({ kind: z.enum(['none', 'asc_api_key', 'play_service_account']), keyId: z.string(), issuerId: z.string(), keyLast4: z.string(), set: z.boolean() }),
  /** Our Play service account, for the owner to invite in their Play Console. Empty on iOS. */
  serviceAccountEmail: z.string(),
  access: z.object({ status: z.enum(['not_checked', 'ok', 'role_too_low', 'invalid', 'unreachable']), roleFound: z.string(), roleNeeded: z.string(), checkedAt: Timestamp.nullable() }),
  steps: z.array(z.object({ code: z.string(), done: z.boolean(), title: z.string(), warning: z.string() })),
});
export const StoreAccessUpdate = z.strictObject({
  accountType: z.enum(['personal', 'organisation']),
  legalName: text(200),
  dunsStatus: z.enum(['not_needed', 'waiting', 'have']),
  playAccountAfterCutoff: z.boolean(),
  closedTest: z.strictObject({ startedAt: z.iso.datetime({ offset: true }).nullable().optional(), testers: z.number().int().min(0).max(1000).nullable().optional() }),
  /** The App Store Connect API key the owner made (iOS). null removes it. */
  ascKey: z.strictObject({
    keyId: z.string().trim().regex(/^[A-Z0-9]{10}$/, 'The key ID is 10 capital letters and digits'),
    issuerId: z.string().trim().toLowerCase().regex(/^[0-9a-f-]{36}$/, 'The issuer ID looks like 57246542-96fe-1a63-e053-0824d011072a'),
    privateKey: z.string().min(1).max(5000),
  }).nullable(),
}).partial();

export const PushCampaign = z.object({
  id: Id,
  title: z.string(),
  body: z.string(),
  couponCode: z.string().nullable(),
  linkPath: z.string(),
  status: z.enum(['queued', 'sending', 'sent', 'blocked', 'failed']),
  blockReason: z.string(),
  audienceCount: Count,
  sentCount: Count,
  cappedCount: Count,
  failedCount: Count,
  createdAt: Timestamp,
  sentAt: Timestamp.nullable(),
});
/** An offer to everyone who turned Offers on. It names no device and no shopper. */
export const PushCampaignSend = z.strictObject({
  title: text(65).min(1, 'Give the offer a title'),
  body: text(178).min(1, 'Write the offer'),
  couponId: Id.optional(),
  linkPath: z.string().trim().max(200).regex(/^\/[A-Za-z0-9/_.-]*$/, 'Use a page of your store, like /c/sale').refine((p) => !p.includes('//'), 'Use a page of your store').default('/'),
  requestKey: RequestKey,
});
export const PushSummary = z.object({
  weeklyCap: z.number().int(),
  optedIn: z.object({ orderUpdates: Count, offers: Count, newReels: Count }),
  reachableNow: Count,
  credentials: z.object({ android: z.boolean(), ios: z.boolean() }),
});
export const PushCredentials = z.object({
  fcm: z.object({ set: z.boolean(), projectId: z.string(), clientEmailMasked: z.string(), status: z.enum(['not_set', 'ok', 'invalid']) }),
  apns: z.object({ set: z.boolean(), keyId: z.string(), teamId: z.string(), topic: z.string(), env: z.enum(['production', 'sandbox']), status: z.enum(['not_set', 'ok', 'invalid']) }),
});
export const PushCredentialsUpdate = z.strictObject({
  /** The brand's own Firebase service account JSON. null removes it. */
  fcm: z.strictObject({ serviceAccount: z.string().min(1).max(10000) }).nullable().optional(),
  /** The brand's own APNs key (.p8). null removes it. */
  apns: z.strictObject({
    keyId: z.string().trim().regex(/^[A-Z0-9]{10}$/, 'The key ID is 10 capital letters and digits'),
    teamId: z.string().trim().regex(/^[A-Z0-9]{10}$/, 'The team ID is 10 capital letters and digits'),
    key: z.string().min(1).max(5000),
    env: z.enum(['production', 'sandbox']).default('production'),
  }).nullable().optional(),
});

export const appPublishingRoutes = {
  'appPublishing.get': { method: 'GET', path: '/app-publishing', access: MANAGERS, response: AppConfig },
  'appPublishing.save': { method: 'PUT', path: '/app-publishing', access: MANAGERS, body: AppConfigUpdate, response: AppConfig },
  'appPublishing.validate': { method: 'POST', path: '/app-publishing/validate', access: MANAGERS, response: AppValidation },
  'appPublishing.builds': { method: 'GET', path: '/app-publishing/builds', access: MANAGERS, query: AppBuildQuery, response: page(AppBuild) },
  'appPublishing.requestBuild': { method: 'POST', path: '/app-publishing/builds', access: OWNER_ONLY, body: AppBuildRequest, status: 202, response: z.object({ builds: z.array(AppBuild) }) },
  'appPublishing.submissions': { method: 'GET', path: '/app-publishing/submissions', access: MANAGERS, response: z.object({ items: z.array(AppSubmission) }) },
  'appListing.get': { method: 'GET', path: '/app-listing/:id', access: MANAGERS, params: PlatformParams, response: StoreListing },
  'appListing.save': { feature: ['app.android', 'app.ios'], method: 'PUT', path: '/app-listing/:id', access: MANAGERS, params: PlatformParams, body: StoreListingUpdate, response: StoreListing },
  'appListing.assets': { method: 'GET', path: '/app-listing/:id/assets', access: MANAGERS, params: PlatformParams, response: z.object({ items: z.array(ListingAsset) }) },
  'storeAccess.get': { feature: ['app.android', 'app.ios'], method: 'GET', path: '/store-access', access: MANAGERS, response: z.object({ items: z.array(StoreAccess) }) },
  'storeAccess.save': { feature: ['app.android', 'app.ios'], method: 'PUT', path: '/store-access/:id', access: OWNER_ONLY, fresh: true, params: PlatformParams, body: StoreAccessUpdate, response: StoreAccess },
  'storeAccess.check': { feature: ['app.android', 'app.ios'], method: 'POST', path: '/store-access/:id/check', access: OWNER_ONLY, params: PlatformParams, response: StoreAccess },
  'pushCampaigns.list': { method: 'GET', path: '/push-campaigns', access: MANAGERS, query: ListQuery, response: page(PushCampaign) },
  'pushCampaigns.summary': { method: 'GET', path: '/push-campaigns/summary', access: MANAGERS, response: PushSummary },
  /** 409 conflict "Weekly offer limit reached" when no opted-in device is under the weekly cap; the row is kept as blocked. */
  'pushCampaigns.send': { method: 'POST', path: '/push-campaigns', access: MANAGERS, body: PushCampaignSend, status: 202, response: PushCampaign },
  'pushCredentials.get': { method: 'GET', path: '/push-credentials', access: OWNER_ONLY, response: PushCredentials },
  'pushCredentials.save': { method: 'PUT', path: '/push-credentials', access: OWNER_ONLY, fresh: true, body: PushCredentialsUpdate, response: PushCredentials },
};


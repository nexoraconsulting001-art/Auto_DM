import { z } from 'zod';
import { APP_PLATFORMS, APP_VERSION } from '../accounts.js';
import { BUILD_REASONS, OTA_STATUSES, SUBMISSION_STATES } from '../apps.js';
import { Channel } from '../compliance.js';
import { AppBuild, AppBuildRequest, AppSubmission } from './apps.js';
import { BILLING_CYCLES, SIGNUP_MODES, SUBSCRIPTION_STATUSES } from '../billing.js';
import { BhavaInvoice, BillingItem } from './billing.js';
import { PresetSlots } from '../themes.js';
import { ImpersonationStarted, opsPlatformRoutes } from './platform-ops.js';
import { Count, Id, IdParams, IdText, ListQuery, Paise, PaiseInput, Timestamp, page, required, text } from './common.js';

/**
 * The Platform Console's routes, on its own host and not under /api/v1. Not part of `routes`, so the seller client
 * never sees them. Same shape as a seller route, with `platformRoles` for access; guard each with requirePlatformRole.
 */
const anyone = Object.freeze(['super_admin', 'support']);
const superAdmin = Object.freeze(['super_admin']);
/** Creating a business and reading it back is also the onboarding team's work (5.5, 5.6). */
const onboardingTeam = Object.freeze(['super_admin', 'support', 'onboarding']);

const Reason = required(500, 'Give a reason');
export const TIERS = Object.freeze(['free', 't1', 't2', 't3', 't4', 't5']);

export const BusinessCreate = z.object({
  name: required(120, 'Enter the business name'),
  website: text(500).default(''),
  igHandle: text(60).default(''),
  plan: z.enum(TIERS).default('free'),
  cycle: z.enum(['monthly', 'yearly']).default('monthly'),
  ownerName: required(120, 'Enter the owner’s name'),
  ownerPhone: required(20, 'Enter the owner’s phone'),
  ownerEmail: text(200).default(''),
});
export const BusinessSummary = z.object({ id: Id, slug: z.string(), name: z.string(), status: z.string(), plan: z.string(), createdAt: Timestamp });
export const BusinessDetail = BusinessSummary.extend({
  website: z.string(),
  legalName: z.string(),
  paused: z.boolean(),
  pausedBy: z.string().nullable(),
  accessLevel: z.enum(['standard', 'advanced']),
  reconnectNeeded: z.boolean(),
  breaker: z.enum(['closed', 'open', 'half_open']),
  score: z.number().nullable(),
});
export const BusinessCreated = z.object({
  tenant: BusinessSummary,
  draftKit: z.object({ colors: z.record(z.string(), z.string()), logoUrl: z.string() }).nullable(),
  import: z.object({ adapter: z.string().optional(), canRetry: z.boolean().optional() }).nullable(),
});

export const PauseBusiness = z.object({ reason: Reason, billing: z.boolean().default(false), pauseStore: z.boolean().default(false) });
export const ResumeBusiness = z.object({ reason: Reason });
export const MetaAccess = z.object({ accessLevel: z.enum(['standard', 'advanced']), appRoleOk: z.boolean().optional() });
export const UnblockPerson = z.object({ channel: Channel, subjectHash: z.string().regex(/^[0-9a-f]{64}$/), reason: Reason });
export const Impersonate = z.object({ reason: Reason });

export const KillSwitchEngage = z.object({ scope: z.literal('global'), reason: Reason });
export const KillSwitchRelease = z.object({ reason: Reason });
export const PlatformSwitch = z.object({ key: z.string(), engaged: z.boolean(), reason: z.string(), engagedBy: z.string(), engagedAt: Timestamp.nullable(), releaseRequestedBy: z.string(), releaseRequestedAt: Timestamp.nullable() });
export const PlatformSwitches = z.object({ items: z.array(PlatformSwitch) });
export const KillSwitchResult = z.object({ engaged: z.boolean(), affected: Count });

export const RawExportBody = z.object({
  reason: Reason,
  tables: z.array(z.enum(['audit_log', 'compliance_events', 'events', 'traffic_events'])).min(1),
  tenantIds: z.array(Id).min(1).max(1000),
  from: z.iso.date(),
  to: z.iso.date(),
});
export const RawExportResult = z.object({ rowCount: Count, expiresAt: Timestamp });

/** The checks of PRD 7.7, as a business's owner sees them (5.9). Worst score first. */
export const PlatformAccountHealth = z.object({ tenantId: Id, tenantName: z.string(), score: z.number().int().min(0).max(100).nullable(), band: z.enum(['good', 'watch', 'at_risk']).nullable(), deductions: z.array(z.object({ code: z.string(), points: z.number().int(), message: z.string(), fix: z.string() })), computedAt: Timestamp.nullable() });

export const PlatformAlert = z.object({ id: z.string(), kind: z.string(), message: z.string(), tenantId: Id.nullable(), at: Timestamp });

// ---- Phase 3 ----

/** Site adapters (PRD 8.4) are code for every business; which business may use one is set here. */
export const PlatformSiteAdapters = z.object({ items: z.array(z.object({ name: z.string(), label: z.string(), enabled: z.boolean() })) });
export const SiteAdapterSet = z.object({ adapter: z.string().regex(/^[a-z0-9-]{1,40}$/), enabled: z.boolean() });

/**
 * A theme preset as data (5.19, F-107): saving one with a new code adds it to "Pick a look" for every seller at once. Colours
 * are the brand kit's slots as #RRGGBB, fonts from the allow-list, and the slots are names, never CSS. The handler refuses a
 * preset whose text or button pairs miss 4.5:1.
 */
export const ThemePresetSave = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: required(40, 'Name the look'),
  madeFor: text(80).default(''),
  position: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
  colors: z.record(z.enum(['ground', 'card', 'ink', 'muted', 'line', 'primary', 'on_primary', 'accent', 'on_accent', 'eyebrow']), z.string().regex(/^#[0-9A-Fa-f]{6}$/)),
  headingFont: required(80),
  bodyFont: required(80),
  slots: PresetSlots,
});
export const PlatformThemePreset = ThemePresetSave.extend({ code: z.string(), madeFor: z.string(), position: z.number().int(), active: z.boolean() });

/** A client's customisation request, triaged to the lowest level of the 5.18 ladder that meets it. */
export const CustomisationRequest = z.object({
  id: Id,
  tenantId: Id,
  tenantName: z.string(),
  summary: z.string(),
  level: z.number().int().min(1).max(5).nullable(),
  othersWant: z.boolean().nullable(),
  decision: z.enum(['open', 'accepted', 'alternative', 'declined']),
  alternative: z.string(),
  feature: z.string(),
  createdAt: Timestamp,
  decidedAt: Timestamp.nullable(),
});
export const CustomisationRequestCreate = z.object({ summary: required(1000, 'Describe the request'), level: z.number().int().min(1).max(5).nullable().default(null) });
/** Refusing with an alternative must say what was offered (F-100). A level 5 feature names the flag it is built behind. */
export const CustomisationDecision = z.object({
  decision: z.enum(['accepted', 'alternative', 'declined']),
  level: z.number().int().min(1).max(5),
  othersWant: z.boolean(),
  alternative: text(1000).default(''),
  feature: z.string().regex(/^([a-z][a-z0-9_.]{1,79})?$/).default(''),
}).refine((d) => d.decision !== 'alternative' || d.alternative !== '', { message: 'Say what was offered instead', path: ['alternative'] });
export const CustomisationListQuery = ListQuery.extend({ tenantId: IdText.optional(), decision: z.enum(['all', 'open', 'accepted', 'alternative', 'declined']).default('all') });

// ---- Phase 6: the branded shopper apps ----
const AppRequestKey = z.string().regex(/^[\w-]{8,80}$/, 'Use 8 to 80 letters, digits, - or _');
const AppVersionText = z.string().regex(APP_VERSION, 'Use a version like 1.2.0');
export const AppBatch = z.object({
  id: Id,
  reason: z.enum(BUILD_REASONS),
  tenantId: Id.nullable(),
  appVersion: z.string(),
  runtimeVersion: z.string(),
  note: z.string(),
  status: z.enum(['open', 'finished']),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  counts: z.object({ total: Count, built: Count, failed: Count, submitted: Count }),
});
export const AppBatchDetail = AppBatch.extend({ builds: z.array(AppBuild.extend({ tenantId: Id, tenantName: z.string() })) });
/** A native change rebuilds every entitled brand on the new runtime. A failed brand never stops the batch. */
export const AppBatchCreate = z.object({
  reason: z.literal('native_change'),
  note: Reason,
  appVersion: AppVersionText,
  runtimeVersion: z.string().trim().min(1).max(40),
  fingerprint: z.string().trim().min(8).max(80),
  platforms: z.array(z.enum(APP_PLATFORMS)).min(1).max(2).default(['android', 'ios']),
  requestKey: AppRequestKey,
});
const AppMinimum = z.object({ minVersion: z.string(), storeUrl: z.string() });
export const AppMinimums = z.object({ android: AppMinimum, ios: AppMinimum });
/** Empty minVersion or storeUrl takes the minimum away. */
export const AppMinimumSet = z.object({
  platform: z.enum(APP_PLATFORMS),
  minVersion: z.union([z.literal(''), AppVersionText]),
  storeUrl: z.union([z.literal(''), z.string().trim().max(500).regex(/^https:\/\/(play\.google\.com\/store\/apps\/details\?id=|apps\.apple\.com\/)\S+$/, 'Use the app’s Google Play or App Store link')]),
});
/** Demo access for store review (2.1(a)): the review number and its code, which is stored only as a hash. */
export const AppReviewAccessSet = z.object({
  phone: z.string().trim().regex(/^\+[1-9][0-9]{7,14}$/, 'Use the number with its country code, like +919876543210').nullable().default(null),
  code: z.string().regex(/^[0-9]{6}$/, 'Use a 6-digit code').nullable().default(null),
  enabled: z.boolean(),
}).refine((b) => !b.enabled || (b.phone && b.code), 'Give the review number and its code to turn review access on');
export const PlatformSubmission = AppSubmission.extend({ id: Id, tenantId: Id, tenantName: z.string() });
export const SubmissionMove = z.object({
  to: z.enum(SUBMISSION_STATES),
  reason: Reason,
  storeUrl: z.string().trim().max(500).regex(/^https:\/\/\S+$/, 'Use the app’s store link').optional(),
  rejection: z.object({ guideline: z.string().trim().regex(/^[0-9A-Za-z_.:() -]{1,40}$/, 'Use the guideline number, like 4.2.6'), message: z.string().max(4000).default('') }).optional(),
}).superRefine((b, issue) => {
  if (b.to === 'rejected' && !b.rejection) issue.addIssue({ code: 'custom', path: ['rejection'], message: 'Give the guideline the store named' });
  if (b.to === 'live' && !b.storeUrl) issue.addIssue({ code: 'custom', path: ['storeUrl'], message: 'Give the app’s store link' });
});
export const Playbook = z.object({ code: z.string(), guideline: z.string(), title: z.string(), doc: z.string(), autoResubmit: z.boolean() });
export const PlatformRejection = z.object({ id: Id, tenantId: Id, tenantName: z.string(), platform: z.enum(APP_PLATFORMS), guideline: z.string(), message: z.string(), playbook: Playbook, rejectedAt: Timestamp });
export const ReviewTask = z.object({
  id: Id,
  tenantId: Id,
  tenantName: z.string(),
  platform: z.enum(APP_PLATFORMS),
  guideline: z.string(),
  status: z.enum(['open', 'resolved']),
  openedAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  resolvedBy: z.string(),
  resolution: z.string(),
});
export const OtaRelease = z.object({
  id: Id,
  runtimeVersion: z.string(),
  bundleFingerprint: z.string(),
  bundleId: z.string(),
  message: z.string(),
  rollout: z.union([z.literal(10), z.literal(50), z.literal(100)]),
  status: z.enum(OTA_STATUSES),
  blockReason: z.string(),
  rollbackReason: z.string(),
  channelsTotal: Count,
  channelsDone: Count,
  publishedBy: z.string(),
  createdAt: Timestamp,
  advancedAt: Timestamp.nullable(),
  rolledBackAt: Timestamp.nullable(),
});
export const OtaPublish = z.object({
  runtimeVersion: z.string().trim().min(1).max(40),
  bundleFingerprint: z.string().trim().min(8).max(80),
  bundleId: z.string().trim().min(1).max(120),
  bundleHash: z.string().regex(/^[0-9a-f]{64}$/, 'The bundle hash is 64 lower-case hex digits'),
  message: z.string().max(500).default(''),
  requestKey: AppRequestKey,
});
export const OtaHealth = z.object({
  hours: z.array(z.object({ hour: Timestamp, launches: Count, crashes: Count })),
  launches: Count,
  crashes: Count,
  crashRate: z.number().nullable(),
  baseline: z.number().nullable(),
  threshold: z.number(),
});

// ---- Phase 7: billing, flags and sign-up ----

/** A business's plan as support sees it: what it is billed, what was overridden, and every change with its actor and reason. */
export const PlatformBilling = z.object({
  tenantId: Id,
  plan: z.enum(TIERS),
  cycle: z.enum(BILLING_CYCLES),
  status: z.enum(SUBSCRIPTION_STATUSES).nullable(),
  graceUntil: Timestamp.nullable(),
  periodEnd: Timestamp.nullable(),
  offerCode: z.string().nullable(),
  items: z.array(BillingItem),
  overrides: z.array(z.object({ feature: z.string(), enabled: z.boolean(), limit: Count.nullable() })),
  changes: z.array(z.object({ fromPlan: z.string(), toPlan: z.string(), fromCycle: z.string(), toCycle: z.string(), actor: z.string(), source: z.string(), reason: z.string(), at: Timestamp })),
});
/** Changes the plan without a payment. Audited, and the owner is told (5.7). */
export const PlanOverride = z.object({ plan: z.enum(TIERS), cycle: z.enum(BILLING_CYCLES).optional(), reason: Reason });
/** Corrects an issued invoice. Without taxablePaise it reverses the whole invoice; never more than what is left of it. */
export const CreditNoteCreate = z.object({ invoiceId: Id, taxablePaise: PaiseInput.optional(), reason: Reason });
export const BillingHold = z.object({ reason: Reason });
export const PlatformBillingSettings = z.object({
  legalName: z.string(), gstin: z.string(), stateCode: z.string(), address: z.string(), sac: z.string(), taxRateBp: z.number().int(),
  statementDay: z.number().int(), graceDays: z.number().int(), afterGrace: z.enum(['suspend', 'move_to_free']), proration: z.enum(['none', 'daily']),
  yearlyMonths: z.number().int(), freeCanBuyPacks: z.boolean(), referralRewardPaise: Paise,
});
export const BillingSettingsSave = z.object({
  legalName: text(200).optional(),
  gstin: z.union([z.literal(''), z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'Enter a valid GSTIN')]).optional(),
  stateCode: z.union([z.literal(''), z.string().regex(/^[0-9]{2}$/, 'Use the two-digit state code')]).optional(),
  address: text(400).optional(),
  sac: z.union([z.literal(''), z.string().regex(/^[0-9]{4,8}$/, 'Enter the SAC')]).optional(),
  taxRateBp: z.number().int().min(0).max(10000).optional(),
  statementDay: z.number().int().min(1).max(28).optional(),
  graceDays: z.number().int().min(0).max(60).optional(),
  afterGrace: z.enum(['suspend', 'move_to_free']).optional(),
  proration: z.enum(['none', 'daily']).optional(),
  freeCanBuyPacks: z.boolean().optional(),
  referralRewardPaise: PaiseInput.optional(),
  reason: Reason,
});

const FlagKey = z.string().regex(/^[a-z][a-z0-9_.]{1,59}$/, 'Use lower-case letters, digits, dots and underscores');
export const FeatureFlag = z.object({ key: z.string(), description: z.string(), enabled: z.boolean(), percent: z.number().int().min(0).max(100), businesses: Count, updatedAt: Timestamp });
export const FeatureFlagSave = z.object({ key: FlagKey, description: text(300).default(''), enabled: z.boolean().default(false), percent: z.number().int().min(0).max(100).default(0), reason: Reason });
/** enabled null removes the business's own setting, so the flag's default and percentage decide again. */
export const TenantFlagSet = z.object({ key: FlagKey, enabled: z.boolean().nullable(), reason: Reason });
export const TenantFlags = z.object({ items: z.array(z.object({ key: z.string(), on: z.boolean(), own: z.boolean().nullable() })) });

export const PlatformSignup = z.object({ mode: z.enum(SIGNUP_MODES), freePerInstagram: z.number().int(), updatedAt: Timestamp });
export const SignupModeSet = z.object({ mode: z.enum(SIGNUP_MODES), reason: Reason });
export const SignupInvite = z.object({ id: Id, note: z.string(), maxUses: Count, uses: Count, expiresAt: Timestamp.nullable(), revokedAt: Timestamp.nullable(), createdBy: z.string(), createdAt: Timestamp });
export const SignupInviteCreate = z.object({ note: text(200).default(''), maxUses: z.number().int().min(1).max(10000).default(1), expiresInDays: z.number().int().min(1).max(365).optional() });
/** The code is in this answer and nowhere else: only its hash is stored. */
export const SignupInviteCreated = z.object({ invite: SignupInvite, code: z.string() });

export const platformRoutes = {
  'platform.businesses': { method: 'GET', path: '/tenants', platformRoles: onboardingTeam, query: ListQuery, response: page(BusinessSummary) },
  'platform.createBusiness': { method: 'POST', path: '/tenants', platformRoles: onboardingTeam, body: BusinessCreate, status: 201, response: BusinessCreated },
  'platform.business': { method: 'GET', path: '/tenants/:id', platformRoles: onboardingTeam, params: IdParams, response: BusinessDetail },
  'platform.pauseBusiness': { method: 'POST', path: '/tenants/:id/pause', platformRoles: anyone, params: IdParams, body: PauseBusiness, response: BusinessDetail },
  'platform.resumeBusiness': { method: 'POST', path: '/tenants/:id/resume', platformRoles: anyone, params: IdParams, body: ResumeBusiness, response: BusinessDetail },
  'platform.setMetaAccess': { method: 'POST', path: '/tenants/:id/meta-access', platformRoles: superAdmin, params: IdParams, body: MetaAccess, response: BusinessDetail },
  'platform.unblockPerson': { method: 'POST', path: '/tenants/:id/unblock', platformRoles: anyone, params: IdParams, body: UnblockPerson, status: 204, response: null },
  'platform.retryImport': { method: 'POST', path: '/tenants/:id/import/retry', platformRoles: onboardingTeam, params: IdParams, status: 202, response: null },
  'platform.impersonate': { method: 'POST', path: '/tenants/:id/impersonate', platformRoles: anyone, params: IdParams, body: Impersonate, response: ImpersonationStarted },
  'platform.switches': { method: 'GET', path: '/switches', platformRoles: anyone, response: PlatformSwitches },
  'platform.engageKill': { method: 'POST', path: '/kill-switch', platformRoles: anyone, body: KillSwitchEngage, response: KillSwitchResult },
  'platform.requestRelease': { method: 'POST', path: '/kill-switch/release', platformRoles: anyone, body: KillSwitchRelease, response: KillSwitchResult },
  'platform.approveRelease': { method: 'POST', path: '/kill-switch/release/approve', platformRoles: anyone, body: KillSwitchRelease, response: KillSwitchResult },
  'platform.unfreezeActivations': { method: 'POST', path: '/activations/unfreeze', platformRoles: superAdmin, body: KillSwitchRelease, status: 204, response: null },
  'platform.rawExport': { method: 'POST', path: '/raw-export', platformRoles: superAdmin, body: RawExportBody, status: 201, response: RawExportResult },
  'platform.accountHealthList': { method: 'GET', path: '/account-health', platformRoles: anyone, query: ListQuery, response: page(PlatformAccountHealth) },
  'platform.alerts': { method: 'GET', path: '/alerts', platformRoles: anyone, query: ListQuery, response: page(PlatformAlert) },
  // Phase 3: answered by src/modules/imports (adapters) and src/modules/themes (presets, customisation requests).
  'platform.siteAdapters': { method: 'GET', path: '/tenants/:id/site-adapters', platformRoles: anyone, params: IdParams, response: PlatformSiteAdapters },
  'platform.setSiteAdapter': { method: 'PUT', path: '/tenants/:id/site-adapters', platformRoles: superAdmin, params: IdParams, body: SiteAdapterSet, response: PlatformSiteAdapters },
  'platform.themePresets': { method: 'GET', path: '/theme-presets', platformRoles: anyone, response: z.object({ items: z.array(PlatformThemePreset) }) },
  'platform.saveThemePreset': { method: 'PUT', path: '/theme-presets', platformRoles: superAdmin, body: ThemePresetSave, response: PlatformThemePreset },
  'platform.customisationRequests': { method: 'GET', path: '/customisation-requests', platformRoles: anyone, query: CustomisationListQuery, response: page(CustomisationRequest) },
  'platform.createCustomisationRequest': { method: 'POST', path: '/tenants/:id/customisation-requests', platformRoles: anyone, params: IdParams, body: CustomisationRequestCreate, status: 201, response: CustomisationRequest },
  'platform.decideCustomisationRequest': { method: 'POST', path: '/customisation-requests/:id/decision', platformRoles: anyone, params: IdParams, body: CustomisationDecision, response: CustomisationRequest },
  // Phase 6: the branded shopper apps. Answered by src/modules/app-builds (batches, a business's build), app-config (minimum
  // version, review access), app-submissions (store states, rejections, playbooks, review tasks) and ota (releases).
  'platform.appBatches': { method: 'GET', path: '/app-build-batches', platformRoles: anyone, query: ListQuery, response: page(AppBatch) },
  'platform.appBatch': { method: 'GET', path: '/app-build-batches/:id', platformRoles: anyone, params: IdParams, response: AppBatchDetail },
  'platform.createAppBatch': { method: 'POST', path: '/app-build-batches', platformRoles: superAdmin, body: AppBatchCreate, status: 201, response: AppBatch },
  'platform.buildBusinessApp': { method: 'POST', path: '/tenants/:id/app-builds', platformRoles: anyone, params: IdParams, body: AppBuildRequest, status: 202, response: z.object({ builds: z.array(AppBuild) }) },
  'platform.setAppMinimum': { method: 'PUT', path: '/tenants/:id/app-minimum', platformRoles: superAdmin, params: IdParams, body: AppMinimumSet, response: AppMinimums },
  'platform.setAppReviewAccess': { method: 'PUT', path: '/tenants/:id/app-review-access', platformRoles: superAdmin, params: IdParams, body: AppReviewAccessSet, status: 204, response: null },
  'platform.appSubmissions': { method: 'GET', path: '/app-submissions', platformRoles: anyone, query: ListQuery.extend({ state: z.enum(SUBMISSION_STATES).optional(), platform: z.enum(APP_PLATFORMS).optional() }), response: page(PlatformSubmission) },
  'platform.setSubmissionState': { method: 'POST', path: '/app-submissions/:id/state', platformRoles: anyone, params: IdParams, body: SubmissionMove, response: PlatformSubmission },
  'platform.appRejections': { method: 'GET', path: '/app-rejections', platformRoles: anyone, query: ListQuery.extend({ tenantId: IdText.optional(), guideline: z.string().max(40).optional() }), response: page(PlatformRejection) },
  'platform.appPlaybooks': { method: 'GET', path: '/app-playbooks', platformRoles: anyone, response: z.object({ items: z.array(Playbook) }) },
  'platform.appReviewTasks': { method: 'GET', path: '/app-review-tasks', platformRoles: anyone, query: ListQuery.extend({ status: z.enum(['open', 'resolved']).optional() }), response: page(ReviewTask) },
  'platform.resolveAppReviewTask': { method: 'POST', path: '/app-review-tasks/:id/resolve', platformRoles: anyone, params: IdParams, body: z.object({ resolution: Reason }), response: ReviewTask },
  'platform.otaReleases': { method: 'GET', path: '/ota-releases', platformRoles: anyone, query: ListQuery, response: page(OtaRelease) },
  /** A fingerprint that is not the runtime's is recorded as blocked (native_change) and answers 409; nothing is published. */
  'platform.publishOta': { method: 'POST', path: '/ota-releases', platformRoles: superAdmin, body: OtaPublish, status: 201, response: OtaRelease },
  'platform.advanceOta': { method: 'POST', path: '/ota-releases/:id/advance', platformRoles: superAdmin, params: IdParams, response: OtaRelease },
  'platform.rollBackOta': { method: 'POST', path: '/ota-releases/:id/roll-back', platformRoles: anyone, params: IdParams, body: z.object({ reason: Reason }), response: OtaRelease },
  'platform.otaHealth': { method: 'GET', path: '/ota-releases/:id/health', platformRoles: anyone, params: IdParams, response: OtaHealth },
  // Phase 7: answered by src/modules/billing (a business's plan, credit notes, billing holds, Bhava's own details),
  // entitlements (flags) and signup (mode and invites).
  'platform.billing': { method: 'GET', path: '/tenants/:id/billing', platformRoles: anyone, params: IdParams, response: PlatformBilling },
  'platform.overridePlan': { method: 'POST', path: '/tenants/:id/plan', platformRoles: superAdmin, params: IdParams, body: PlanOverride, response: PlatformBilling },
  'platform.createCreditNote': { method: 'POST', path: '/tenants/:id/credit-notes', platformRoles: superAdmin, params: IdParams, body: CreditNoteCreate, status: 201, response: BhavaInvoice },
  'platform.suspendBilling': { method: 'POST', path: '/tenants/:id/billing/suspend', platformRoles: anyone, params: IdParams, body: BillingHold, response: PlatformBilling },
  'platform.resumeBilling': { method: 'POST', path: '/tenants/:id/billing/resume', platformRoles: anyone, params: IdParams, body: BillingHold, response: PlatformBilling },
  'platform.billingSettings': { method: 'GET', path: '/billing-settings', platformRoles: anyone, response: PlatformBillingSettings },
  'platform.saveBillingSettings': { method: 'PUT', path: '/billing-settings', platformRoles: superAdmin, body: BillingSettingsSave, response: PlatformBillingSettings },
  'platform.flags': { method: 'GET', path: '/flags', platformRoles: anyone, response: z.object({ items: z.array(FeatureFlag) }) },
  'platform.saveFlag': { method: 'PUT', path: '/flags', platformRoles: superAdmin, body: FeatureFlagSave, response: FeatureFlag },
  'platform.tenantFlags': { method: 'GET', path: '/tenants/:id/flags', platformRoles: anyone, params: IdParams, response: TenantFlags },
  'platform.setTenantFlag': { method: 'PUT', path: '/tenants/:id/flags', platformRoles: anyone, params: IdParams, body: TenantFlagSet, response: TenantFlags },
  'platform.signup': { method: 'GET', path: '/signup', platformRoles: anyone, response: PlatformSignup },
  'platform.setSignupMode': { method: 'PUT', path: '/signup', platformRoles: superAdmin, body: SignupModeSet, response: PlatformSignup },
  'platform.signupInvites': { method: 'GET', path: '/signup/invites', platformRoles: anyone, query: ListQuery, response: page(SignupInvite) },
  'platform.createSignupInvite': { method: 'POST', path: '/signup/invites', platformRoles: anyone, body: SignupInviteCreate, status: 201, response: SignupInviteCreated },
  'platform.revokeSignupInvite': { method: 'POST', path: '/signup/invites/:id/revoke', platformRoles: anyone, params: IdParams, response: SignupInvite },
};

/** Which module answers each Phase 7 Platform Console route. */
/** Phase 7: sign-in, pauses, health, impersonation, onboarding and managed services (platform-ops.js). */
Object.assign(platformRoutes, opsPlatformRoutes);

export const BILLING_PLATFORM_OWNERS = Object.freeze({
  billing: Object.freeze(['platform.billing', 'platform.overridePlan', 'platform.createCreditNote', 'platform.suspendBilling', 'platform.resumeBilling', 'platform.billingSettings', 'platform.saveBillingSettings']),
  entitlements: Object.freeze(['platform.flags', 'platform.saveFlag', 'platform.tenantFlags', 'platform.setTenantFlag']),
  signup: Object.freeze(['platform.signup', 'platform.setSignupMode', 'platform.signupInvites', 'platform.createSignupInvite', 'platform.revokeSignupInvite']),
});

export const platformRouteList = Object.freeze(Object.entries(platformRoutes).map(([id, route]) => Object.freeze({ id, ...route })));

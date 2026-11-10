import { z } from 'zod';
import { Channel } from '../compliance.js';
import { PresetSlots } from '../themes.js';
import { Count, Id, IdParams, IdText, ListQuery, Timestamp, page, required, text } from './common.js';

/**
 * The Platform Console's routes, on its own host and not under /api/v1. Not part of `routes`, so the seller client
 * never sees them. Same shape as a seller route, with `platformRoles` for access; guard each with requirePlatformRole.
 */
const anyone = Object.freeze(['super_admin', 'support']);
const superAdmin = Object.freeze(['super_admin']);

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

export const platformRoutes = {
  'platform.businesses': { method: 'GET', path: '/tenants', platformRoles: anyone, query: ListQuery, response: page(BusinessSummary) },
  'platform.createBusiness': { method: 'POST', path: '/tenants', platformRoles: anyone, body: BusinessCreate, status: 201, response: BusinessCreated },
  'platform.business': { method: 'GET', path: '/tenants/:id', platformRoles: anyone, params: IdParams, response: BusinessDetail },
  'platform.pauseBusiness': { method: 'POST', path: '/tenants/:id/pause', platformRoles: anyone, params: IdParams, body: PauseBusiness, response: BusinessDetail },
  'platform.resumeBusiness': { method: 'POST', path: '/tenants/:id/resume', platformRoles: anyone, params: IdParams, body: ResumeBusiness, response: BusinessDetail },
  'platform.setMetaAccess': { method: 'POST', path: '/tenants/:id/meta-access', platformRoles: superAdmin, params: IdParams, body: MetaAccess, response: BusinessDetail },
  'platform.unblockPerson': { method: 'POST', path: '/tenants/:id/unblock', platformRoles: anyone, params: IdParams, body: UnblockPerson, status: 204, response: null },
  'platform.retryImport': { method: 'POST', path: '/tenants/:id/import/retry', platformRoles: anyone, params: IdParams, status: 202, response: null },
  'platform.impersonate': { method: 'POST', path: '/tenants/:id/impersonate', platformRoles: anyone, params: IdParams, body: Impersonate, response: z.object({ url: z.string() }) },
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
};

export const platformRouteList = Object.freeze(Object.entries(platformRoutes).map(([id, route]) => Object.freeze({ id, ...route })));

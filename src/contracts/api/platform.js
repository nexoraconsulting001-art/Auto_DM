import { z } from 'zod';
import { Channel } from '../compliance.js';
import { Count, Id, IdParams, ListQuery, Timestamp, page, required, text } from './common.js';

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
  tables: z.array(z.enum(['audit_log', 'compliance_events', 'events'])).min(1),
  tenantIds: z.array(Id).min(1).max(1000),
  from: z.iso.date(),
  to: z.iso.date(),
});
export const RawExportResult = z.object({ rowCount: Count, expiresAt: Timestamp });

export const PlatformAlert = z.object({ id: z.string(), kind: z.string(), message: z.string(), tenantId: Id.nullable(), at: Timestamp });

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
  'platform.alerts': { method: 'GET', path: '/alerts', platformRoles: anyone, query: ListQuery, response: page(PlatformAlert) },
};

export const platformRouteList = Object.freeze(Object.entries(platformRoutes).map(([id, route]) => Object.freeze({ id, ...route })));

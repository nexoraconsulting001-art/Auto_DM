import { z } from 'zod';
import { HEALTH_STATUSES } from '../health.js';
import { KYC_STATES, OPERATOR_STEPS, STEP_NAMES, STEP_STATUSES } from '../onboarding.js';
import { CHANGE_STATES, SERVICES, SERVICE_MODES, TASK_REF_MAX } from '../services.js';
import { IMPERSONATION_MODES, IMPERSONATION_ROLES, PLATFORM_ROLES } from './access.js';
import { Count, Id, IdParams, IdText, ListQuery, Timestamp, page, required, text } from './common.js';

/**
 * The Platform Console's Phase 7 routes for PRD 5.5, 5.6, 5.8, 5.9, 5.10 and 5.17. platform.js spreads them into
 * `platformRoutes`; the format is the same, with one addition: `public: true` on the three sign-in routes, which is the
 * only way a platform route is answered with nobody signed in.
 */
const everyone = PLATFORM_ROLES;
const helpers = IMPERSONATION_ROLES;
const superAdmin = Object.freeze(['super_admin']);
const onboardingTeam = Object.freeze(['super_admin', 'support', 'onboarding']);
const serviceTeam = Object.freeze(['super_admin', 'service_operator']);
const Reason = required(500, 'Give a reason');
const Email = z.string().trim().toLowerCase().max(200).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email');

// ---- Sign-in (5.5): an emailed code, then TOTP -------------------------------------------------------------------------

export const PLATFORM_LOGIN = Object.freeze({
  codeDigits: 6,
  codeMinutes: 10,
  codeAttempts: 5,
  /** How long the answer to the emailed code is good for while the person types their TOTP. */
  ticketMinutes: 5,
  totpDigits: 6,
  totpPeriodSeconds: 30,
  /** One step either side, for a phone whose clock is a little off. A code is accepted once: the last step used is remembered. */
  totpWindow: 1,
  recoveryCodes: 10,
  issuer: 'Bhava Console',
});
export const PlatformUser = z.object({ id: Id, email: z.string(), name: z.string(), role: z.enum(PLATFORM_ROLES) });
export const PlatformSession = z.object({ user: PlatformUser, csrf: z.string() });
export const SignInStart = z.object({ email: Email });
export const SignInVerify = z.object({ email: Email, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });
/**
 * `next` is `totp` for someone with an authenticator and `enrol` for a first sign-in, which carries the secret to add
 * (shown once, as text and as an otpauth:// address for a QR code drawn in the browser). The ticket is good for one try at a time.
 */
export const SignInTicket = z.object({ ticket: z.string(), next: z.enum(['totp', 'enrol']), enrol: z.object({ secret: z.string(), otpauthUrl: z.string() }).nullable() });
/** `code` is the authenticator's 6 digits, or one recovery code (spent by this). */
export const SignInTotp = z.object({ ticket: required(200), code: z.string().trim().regex(/^(\d{6}|[a-z0-9]{4}(-[a-z0-9]{4}){2})$/i, 'Enter the 6-digit code from your authenticator') });
/** `recoveryCodes` is present once, straight after enrolling: they are shown then and never again. */
export const SignedIn = PlatformSession.extend({ recoveryCodes: z.array(z.string()).optional() });

export const PlatformTeamMember = PlatformUser.extend({ totpEnrolled: z.boolean(), disabled: z.boolean(), createdAt: Timestamp });
export const PlatformTeamAdd = z.object({ email: Email, name: text(80).default(''), role: z.enum(PLATFORM_ROLES) });
export const PlatformTeamUpdate = z.object({ role: z.enum(PLATFORM_ROLES).optional(), disabled: z.boolean().optional(), resetTotp: z.literal(true).optional(), reason: Reason });

// ---- Pauses and switches (5.8) -----------------------------------------------------------------------------------------

/** Every scope a pause can have (PRD 4.12), with who set it, why and when. `releasePending` is a global release waiting for its second approval. */
export const PAUSE_SCOPES = Object.freeze(['global', 'activations', 'business', 'account', 'automation']);
export const PauseState = z.object({
  scope: z.enum(PAUSE_SCOPES),
  tenantId: Id.nullable(),
  tenantName: z.string(),
  /** What is paused inside the business: an account or automation id as text, empty for the business itself or a platform switch. */
  target: z.string(),
  engaged: z.boolean(),
  actor: z.string(),
  reason: z.string(),
  at: Timestamp.nullable(),
  /** `owner` when the business paused itself; `platform` when Bhava did, which the owner cannot lift. */
  by: z.enum(['owner', 'platform', 'system']),
  pauseStore: z.boolean().default(false),
  releasePending: z.object({ requestedBy: z.string(), requestedAt: Timestamp }).nullable().default(null),
});
export const PauseQuery = ListQuery.extend({ scope: z.enum(PAUSE_SCOPES).optional(), tenantId: IdText.optional(), engaged: z.enum(['true', 'false']).optional() });

// ---- Health (5.9) ------------------------------------------------------------------------------------------------------

export const HealthCheckResult = z.object({ check: z.string(), label: z.string(), status: z.enum(HEALTH_STATUSES), lastRanAt: Timestamp.nullable(), detail: z.record(z.string(), z.unknown()).default({}) });
export const TenantHealth = z.object({
  tenantId: Id,
  tenantName: z.string(),
  /** The worst of its checks: the list is sorted by this, then by score, lowest first. */
  worst: z.enum(HEALTH_STATUSES),
  score: z.number().int().min(0).max(100).nullable(),
  checks: z.array(HealthCheckResult),
});

// ---- Impersonation (5.10) ----------------------------------------------------------------------------------------------

export const ImpersonationSession = z.object({
  id: Id,
  tenantId: Id,
  tenantName: z.string(),
  operatorId: Id,
  operatorName: z.string(),
  reason: z.string(),
  mode: z.enum(IMPERSONATION_MODES),
  startedAt: Timestamp,
  expiresAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
/**
 * `url` opens the business's console in a session that is already this impersonation: a one-time address on the
 * business's own host, good for a minute, that sets the session cookie there and nothing else.
 */
export const ImpersonationStarted = z.object({ url: z.string(), session: ImpersonationSession.optional() });
/** The second confirmation: the operator types the business's name, and says why they need to change something. */
export const ImpersonationWrite = z.object({ confirm: required(120, 'Type the business name to confirm'), reason: Reason });

// ---- Done-for-you onboarding (5.6) -------------------------------------------------------------------------------------

export const OnboardingInvite = z.object({ id: Id, createdAt: Timestamp, expiresAt: Timestamp, usedAt: Timestamp.nullable(), revokedAt: Timestamp.nullable(), createdBy: z.string() });
/** `url` holds the token and is answered once, when the invite is made. Only its hash is stored. */
export const OnboardingInviteSent = z.object({ invite: OnboardingInvite, url: z.string() });
export const OnboardingInviteSend = z.object({ via: z.array(z.enum(['whatsapp', 'email'])).max(2).default([]) });
export const OnboardingStep = z.object({
  step: z.enum(STEP_NAMES),
  label: z.string(),
  required: z.boolean(),
  status: z.enum(STEP_STATUSES),
  checkedAt: Timestamp.nullable(),
  code: z.string().default(''),
  reason: z.string().default(''),
});
export const OnboardingWorkspace = z.object({
  tenantId: Id,
  tenantName: z.string(),
  plan: z.string(),
  done: z.boolean(),
  checkoutOpen: z.boolean(),
  kyc: z.object({ status: z.enum(KYC_STATES), reason: z.string() }).nullable(),
  steps: z.array(OnboardingStep),
  invite: OnboardingInvite.nullable(),
  /** The operator's active time so far, in all and per step, against the 10-minute target. */
  activeMs: Count,
  timings: z.array(z.object({ step: z.enum(OPERATOR_STEPS), activeMs: Count })),
});
export const OnboardingSummary = z.object({ tenantId: Id, tenantName: z.string(), plan: z.string(), done: z.boolean(), stepsDone: Count, stepsRequired: Count, inviteState: z.enum(['none', 'sent', 'used', 'expired', 'revoked']), activeMs: Count });
/** What the console reports as the operator works: a step and how long they were actively on it. Gaps over ACTIVE_GAP_MS are left out by the console and capped by the server. */
export const OnboardingTiming = z.object({ step: z.enum(OPERATOR_STEPS), activeMs: z.number().int().min(0).max(3_600_000), startedAt: Timestamp, endedAt: Timestamp });

// ---- Managed services (5.17) -------------------------------------------------------------------------------------------

export const ServiceEngagement = z.object({ tenantId: Id, tenantName: z.string(), service: z.enum(SERVICES), mode: z.enum(SERVICE_MODES), active: z.boolean(), activeFrom: Timestamp, activeTo: Timestamp.nullable(), changesThisMonth: Count });
export const ServiceSession = z.object({ id: Id, tenantId: Id, tenantName: z.string(), operatorId: Id, operatorName: z.string(), service: z.enum(SERVICES), taskRef: z.string(), mode: z.enum(SERVICE_MODES), startedAt: Timestamp, expiresAt: Timestamp, endedAt: Timestamp.nullable() });
/** No session without a task reference. 403 `service.ended` when the business does not have the service active. */
export const ServiceSessionStart = z.object({ service: z.enum(SERVICES), taskRef: required(TASK_REF_MAX, 'Give the task reference') });
/** `url` opens the business's console in the service session, as an impersonation's does. */
export const ServiceSessionStarted = z.object({ url: z.string(), session: ServiceSession });
export const ServiceChange = z.object({
  id: Id,
  tenantId: Id,
  sessionId: Id,
  service: z.enum(SERVICES),
  operatorName: z.string(),
  taskRef: z.string(),
  routeId: z.string(),
  target: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  state: z.enum(CHANGE_STATES),
  undoneBy: z.string(),
  createdAt: Timestamp,
});
export const ServiceQuery = ListQuery.extend({ service: z.enum(SERVICES).optional(), tenantId: IdText.optional(), active: z.enum(['true', 'false']).optional() });
export const ServiceChangeQuery = ListQuery.extend({ service: z.enum(SERVICES).optional(), tenantId: IdText.optional(), sessionId: IdText.optional(), state: z.enum(CHANGE_STATES).optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

export const opsPlatformRoutes = {
  // Sign-in. Passwords stay only behind PASSWORD_LOGIN, at POST /login, which is not in this table.
  /** Always 204, whether or not the email is one of ours: nothing is learned from asking. */
  'platform.signInStart': { method: 'POST', path: '/sign-in/code', public: true, platformRoles: Object.freeze([]), body: SignInStart, status: 204, response: null },
  'platform.signInVerify': { method: 'POST', path: '/sign-in/verify', public: true, platformRoles: Object.freeze([]), body: SignInVerify, response: SignInTicket },
  'platform.signInTotp': { method: 'POST', path: '/sign-in/totp', public: true, platformRoles: Object.freeze([]), body: SignInTotp, response: SignedIn },
  'platform.me': { method: 'GET', path: '/me', platformRoles: everyone, response: PlatformSession },
  'platform.signOut': { method: 'POST', path: '/logout', platformRoles: everyone, status: 204, response: null },
  'platform.team': { method: 'GET', path: '/team', platformRoles: superAdmin, response: z.object({ items: z.array(PlatformTeamMember) }) },
  'platform.addTeamMember': { method: 'POST', path: '/team', platformRoles: superAdmin, body: PlatformTeamAdd, status: 201, response: PlatformTeamMember },
  'platform.updateTeamMember': { method: 'PATCH', path: '/team/:id', platformRoles: superAdmin, params: IdParams, body: PlatformTeamUpdate, response: PlatformTeamMember },

  // Pauses and switches (5.8): platform.switches, engageKill, requestRelease, approveRelease, pauseBusiness and resumeBusiness are Phase 1's.
  'platform.pauses': { method: 'GET', path: '/pauses', platformRoles: helpers, query: PauseQuery, response: page(PauseState) },

  /** What Bhava's team did, newest first: in one business, or everywhere. Details hold ids only, as every audit row does. */
  'platform.auditLog': { method: 'GET', path: '/audit-log', platformRoles: helpers, query: ListQuery.extend({ tenantId: IdText.optional(), actor: text(80).optional(), action: text(80).optional() }), response: page(z.object({ id: Id, tenantId: Id.nullable(), actor: z.string(), action: z.string(), target: z.string(), details: z.record(z.string(), z.unknown()), at: Timestamp })) },

  // Health (5.9), worst first.
  'platform.health': { method: 'GET', path: '/tenant-health', platformRoles: helpers, query: ListQuery, response: page(TenantHealth) },
  'platform.businessHealth': { method: 'GET', path: '/tenants/:id/health', platformRoles: onboardingTeam, params: IdParams, response: TenantHealth },
  /** Runs the checks that have not run in the last 10 minutes and answers all of them. Never slower than one check's timeout. */
  'platform.runHealth': { method: 'POST', path: '/tenants/:id/health/run', platformRoles: helpers, params: IdParams, response: TenantHealth },

  // Impersonation (5.10). platform.impersonate (POST /tenants/:id/impersonate) starts one, read-only.
  'platform.impersonations': { method: 'GET', path: '/impersonations', platformRoles: helpers, query: ListQuery.extend({ tenantId: IdText.optional(), live: z.enum(['true', 'false']).optional() }), response: page(ImpersonationSession) },
  'platform.confirmImpersonationWrite': { method: 'POST', path: '/impersonations/:id/write', platformRoles: helpers, params: IdParams, body: ImpersonationWrite, response: ImpersonationSession },
  'platform.endImpersonation': { method: 'POST', path: '/impersonations/:id/end', platformRoles: helpers, params: IdParams, response: ImpersonationSession },

  // Done-for-you onboarding (5.6).
  'platform.onboardingList': { method: 'GET', path: '/onboarding', platformRoles: onboardingTeam, query: ListQuery.extend({ done: z.enum(['true', 'false']).optional() }), response: page(OnboardingSummary) },
  'platform.onboarding': { method: 'GET', path: '/tenants/:id/onboarding', platformRoles: onboardingTeam, params: IdParams, response: OnboardingWorkspace },
  'platform.checkOnboarding': { method: 'POST', path: '/tenants/:id/onboarding/check', platformRoles: onboardingTeam, params: IdParams, response: OnboardingWorkspace },
  /** Sends the owner's link. A live one is revoked first, so there is only ever one. Works for a business that signed up itself too (F-108). */
  'platform.sendOnboardingInvite': { method: 'POST', path: '/tenants/:id/onboarding/invite', platformRoles: onboardingTeam, params: IdParams, body: OnboardingInviteSend, status: 201, response: OnboardingInviteSent },
  'platform.revokeOnboardingInvite': { method: 'POST', path: '/tenants/:id/onboarding/invite/revoke', platformRoles: onboardingTeam, params: IdParams, status: 204, response: null },
  'platform.recordOnboardingTime': { method: 'POST', path: '/tenants/:id/onboarding/timings', platformRoles: onboardingTeam, params: IdParams, body: OnboardingTiming, status: 204, response: null },

  // Managed services (5.17).
  'platform.services': { method: 'GET', path: '/services', platformRoles: serviceTeam, query: ServiceQuery, response: page(ServiceEngagement) },
  'platform.serviceSessions': { method: 'GET', path: '/service-sessions', platformRoles: serviceTeam, query: ServiceQuery, response: page(ServiceSession) },
  'platform.startServiceSession': { method: 'POST', path: '/tenants/:id/service-sessions', platformRoles: serviceTeam, params: IdParams, body: ServiceSessionStart, status: 201, response: ServiceSessionStarted },
  'platform.endServiceSession': { method: 'POST', path: '/service-sessions/:id/end', platformRoles: serviceTeam, params: IdParams, response: ServiceSession },
  'platform.serviceChanges': { method: 'GET', path: '/service-changes', platformRoles: serviceTeam, query: ServiceChangeQuery, response: page(ServiceChange) },
};

/** Which module answers which of these. platform.impersonate moves from platform-console to impersonation when that track builds it. */
export const OPS_PLATFORM_OWNERS = Object.freeze({
  'platform-console': Object.freeze(['platform.signInStart', 'platform.signInVerify', 'platform.signInTotp', 'platform.me', 'platform.signOut', 'platform.team', 'platform.addTeamMember', 'platform.updateTeamMember', 'platform.pauses', 'platform.auditLog']),
  'tenant-health': Object.freeze(['platform.health', 'platform.businessHealth', 'platform.runHealth']),
  impersonation: Object.freeze(['platform.impersonations', 'platform.confirmImpersonationWrite', 'platform.endImpersonation']),
  onboarding: Object.freeze(['platform.onboardingList', 'platform.onboarding', 'platform.checkOnboarding', 'platform.sendOnboardingInvite', 'platform.revokeOnboardingInvite', 'platform.recordOnboardingTime']),
  'managed-services': Object.freeze(['platform.services', 'platform.serviceSessions', 'platform.startServiceSession', 'platform.endServiceSession', 'platform.serviceChanges']),
});

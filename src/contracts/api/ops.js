import { z } from 'zod';
import { KYC_STATES, OWN_KEY_PROVIDERS, STEP_NAMES, STEP_STATUSES } from '../onboarding.js';
import { CHANGE_STATES, SERVICES, SERVICE_MODES } from '../services.js';
import { IMPERSONATION_MODES, MANAGERS, OWNER_ONLY, PUBLIC } from './access.js';
import { Id, IdParams, ListQuery, Timestamp, page, required, text } from './common.js';

/**
 * What a seller sees of Bhava's team at work (PRD 5.6, 5.10, 5.17): the done-for-you checklist, the "Done by Bhava team"
 * feed, and the service settings. The Platform Console's side is in platform.js.
 */

// ---- Who is behind this session (5.10, 5.17) ---------------------------------------------------------------------------

/**
 * Present on auth.me when the session was opened by Bhava's team. The seller console's banner reads it: it names the
 * business and the operator, and counts down to `expiresAt`. `consoleUrl` is where ending the session returns to.
 */
export const SessionOperator = z.object({
  kind: z.enum(['impersonation', 'service']),
  operatorName: z.string(),
  mode: z.enum([...IMPERSONATION_MODES, ...SERVICE_MODES]),
  service: z.enum(SERVICES).nullable().default(null),
  taskRef: z.string().nullable().default(null),
  expiresAt: Timestamp,
  consoleUrl: z.string().default(''),
});

// ---- Managed services (5.17) -------------------------------------------------------------------------------------------

/**
 * Which services may call which seller routes, and for a write, the route that returns the thing it changes. The route
 * table (index.js) carries these as each route's `service`, `reads` and `undo` fields; they are kept here, in one table,
 * so the whole reach of Bhava's team inside a business can be read at once. A route not listed has no service.
 *
 *   service  one of SERVICES, or a list
 *   reads    a GET route answering the thing this write changes. The router calls it before and after an operator's write
 *            (with the write's own path values, and its query read from the write's query and body) and records both
 *   undo     the route `before` is written back through when it is not the route itself (a pin is undone by saving the order)
 */
const CATALOG = 'catalog_management';
const REELS = Object.freeze(['reel_management', 'reel_backlog']);
const MERCH = 'merchandising';
export const SERVICE_ROUTES = Object.freeze({
  // Catalog management: products and categories.
  'products.list': { service: [CATALOG, MERCH] },
  'products.get': { service: [CATALOG, MERCH] },
  'products.create': { service: CATALOG, reads: 'products.get' },
  'products.update': { service: CATALOG, reads: 'products.get' },
  'products.remove': { service: CATALOG, reads: 'products.get' },
  'categories.list': { service: [CATALOG, ...REELS, MERCH] },
  'categories.get': { service: [CATALOG, ...REELS, MERCH] },
  'categories.create': { service: CATALOG, reads: 'categories.get' },
  'categories.update': { service: CATALOG, reads: 'categories.get' },
  'categories.remove': { service: CATALOG, reads: 'categories.get' },
  'categories.reorder': { service: CATALOG, reads: 'categories.list' },
  // Reel management and the backlog: automations, reel categories and reel order.
  'automations.list': { service: REELS },
  'automations.get': { service: REELS },
  'automations.stats': { service: REELS },
  'automations.create': { service: REELS, reads: 'automations.get' },
  'automations.update': { service: REELS, reads: 'automations.get' },
  'automations.remove': { service: REELS, reads: 'automations.get' },
  'automations.setState': { service: REELS, reads: 'automations.get' },
  'reels.list': { service: REELS },
  'reels.get': { service: REELS },
  'reels.instagramPosts': { service: REELS },
  'reels.save': { service: REELS, reads: 'reels.get' },
  'reels.remove': { service: REELS, reads: 'reels.get' },
  'categories.reels': { service: REELS },
  'categories.rules': { service: REELS },
  'categories.setReels': { service: REELS, reads: 'categories.reels' },
  'categories.addReel': { service: REELS, reads: 'categories.reels', undo: 'categories.setReels' },
  'categories.removeReel': { service: REELS, reads: 'categories.reels', undo: 'categories.setReels' },
  'categories.pin': { service: REELS, reads: 'categories.reels', undo: 'categories.setReels' },
  'categories.unpin': { service: REELS, reads: 'categories.reels', undo: 'categories.setReels' },
  'categories.schedule': { service: REELS, reads: 'categories.reels' },
  // Merchandising: collections, banners and page order.
  'pages.list': { service: MERCH },
  'pages.media': { service: MERCH },
  'pages.get': { service: MERCH },
  'pages.create': { service: MERCH, reads: 'pages.get' },
  'pages.update': { service: MERCH, reads: 'pages.get' },
  'pages.remove': { service: MERCH, reads: 'pages.get' },
  'pageBlocks.get': { service: MERCH },
  'pageBlocks.save': { service: MERCH, reads: 'pageBlocks.get' },
});

/** Adds SERVICE_ROUTES to a route table. A row for a route that does not exist, or one that already has a field, does not load. */
export function withServices(table) {
  const out = { ...table };
  for (const [id, fields] of Object.entries(SERVICE_ROUTES)) {
    if (!out[id]) throw new Error(`SERVICE_ROUTES names "${id}", which is not a route`);
    if ('service' in out[id] || 'reads' in out[id] || 'undo' in out[id]) throw new Error(`Route "${id}" names its service twice`);
    out[id] = { ...out[id], ...fields };
  }
  return out;
}

/** What the router answers an operator whose service is on "approve first": nothing changed, and the seller has a draft to decide. */
export const ServiceDraft = z.object({ draft: z.literal(true), changeId: Id });

/** One line of the feed. `before` and `after` are the thing itself, secrets masked; `canUndo` is false for something created or removed. */
export const TeamChange = z.object({
  id: Id,
  service: z.enum(SERVICES),
  taskRef: z.string(),
  routeId: z.string(),
  target: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  state: z.enum(CHANGE_STATES),
  canUndo: z.boolean(),
  createdAt: Timestamp,
  decidedAt: Timestamp.nullable(),
  undoneAt: Timestamp.nullable(),
});
export const TeamFeedQuery = ListQuery.extend({ service: z.enum(SERVICES).optional(), state: z.enum(CHANGE_STATES).optional() });
export const ServiceSetting = z.object({ service: z.enum(SERVICES), scope: z.string(), active: z.boolean(), mode: z.enum(SERVICE_MODES), activeFrom: Timestamp.nullable(), activeTo: Timestamp.nullable() });
export const ServiceSettings = z.object({ items: z.array(ServiceSetting) });
export const ServiceSettingSave = z.object({ service: z.enum(SERVICES), mode: z.enum(SERVICE_MODES) });

export const teamFeedRoutes = {
  'teamFeed.list': { method: 'GET', path: '/team-feed', access: MANAGERS, query: TeamFeedQuery, response: page(TeamChange) },
  /** Writes the change's `before` back through the route that made it, as the seller. 409 `service.cannot_undo` when it has no before or after, or was undone already. */
  'teamFeed.undo': { method: 'POST', path: '/team-feed/:id/undo', access: MANAGERS, params: IdParams, response: TeamChange },
  /** Applies a draft through its route, as the seller, so every check the route makes runs then (the Compliance Engine for an automation). */
  'teamFeed.approve': { method: 'POST', path: '/team-feed/:id/approve', access: MANAGERS, params: IdParams, response: TeamChange },
  'teamFeed.reject': { method: 'POST', path: '/team-feed/:id/reject', access: MANAGERS, params: IdParams, response: TeamChange },
  'services.settings': { method: 'GET', path: '/services', access: MANAGERS, response: ServiceSettings },
  'services.saveSettings': { method: 'PUT', path: '/services', access: OWNER_ONLY, body: ServiceSettingSave, response: ServiceSettings },
};

// ---- Done-for-you onboarding (5.6) -------------------------------------------------------------------------------------

export const SetupStep = z.object({
  step: z.enum(STEP_NAMES),
  label: z.string(),
  required: z.boolean(),
  status: z.enum(STEP_STATUSES),
  checkedAt: Timestamp.nullable(),
  /** A stable reason such as gate.scope_missing, the provider's own words when it gave any, and the action the screen offers. */
  code: z.string().default(''),
  reason: z.string().default(''),
  fix: z.enum(['', 'reconnect', 'kyc', 'pickup', 'keys', 'dns', 'terms']).default(''),
});
export const SetupChecklist = z.object({
  plan: z.string(),
  done: z.boolean(),
  /** False until Razorpay reports the Route linked account active (or the business's own keys pass their test call). */
  checkoutOpen: z.boolean(),
  kyc: z.object({ status: z.enum(KYC_STATES), reason: z.string() }).nullable(),
  steps: z.array(SetupStep),
});
export const SetupCheck = z.object({ step: z.enum(STEP_NAMES).optional() });
export const SetupTerms = z.object({ version: required(40, 'Say which terms') });
const Pincode = z.string().regex(/^\d{6}$/, 'Enter a 6-digit pincode');
export const PickupAddress = z.object({
  name: required(80, 'Enter a contact name'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number'),
  email: text(200).default(''),
  line1: required(190, 'Enter the address'),
  line2: text(190).default(''),
  city: required(80, 'Enter the city'),
  state: required(80, 'Enter the state'),
  pincode: Pincode,
});
/** Razorpay's own page for the linked account's KYC: no KYC detail passes through Bhava. */
export const KycLink = z.object({ url: z.string(), status: z.enum(KYC_STATES), reason: z.string().default('') });
/** `keySecret` is a password for Shiprocket (with `keyId` the login email). Never echoed: the answer shows it masked. */
export const OwnKeys = z.object({ provider: z.enum(OWN_KEY_PROVIDERS), keyId: required(200, 'Enter the key id'), keySecret: required(500, 'Enter the secret') });
export const OwnKeysSaved = z.object({ provider: z.enum(OWN_KEY_PROVIDERS), keyId: z.string(), masked: z.string(), checklist: SetupChecklist });
export const InviteOpen = z.object({ token: z.string().regex(/^[\w-]{20,200}$/, 'This link isn’t valid') });
export const InviteOpened = z.object({ tenantId: Id, businessName: z.string(), expiresAt: Timestamp });

export const setupRoutes = {
  'setup.get': { method: 'GET', path: '/setup', access: MANAGERS, response: SetupChecklist },
  /** Runs the live checks now, for one step or for all, and answers what they found. */
  'setup.check': { method: 'POST', path: '/setup/check', access: MANAGERS, body: SetupCheck, response: SetupChecklist },
  'setup.acceptTerms': { method: 'POST', path: '/setup/terms', access: OWNER_ONLY, body: SetupTerms, response: SetupChecklist },
  /** Adds the address as this business's pickup location on Bhava's master Shiprocket account. */
  'setup.pickupAddress': { method: 'PUT', path: '/setup/pickup-address', access: OWNER_ONLY, body: PickupAddress, response: SetupChecklist },
  /** Creates the Route linked account if there is none, and answers where the owner completes its KYC. */
  'setup.kycLink': { method: 'POST', path: '/setup/kyc-link', access: OWNER_ONLY, response: KycLink },
  /** The test call runs first: keys that fail it are not saved, and the Bhava default path stays active (F-79). */
  'setup.ownKeys': { method: 'PUT', path: '/setup/own-keys', access: OWNER_ONLY, fresh: true, body: OwnKeys, response: OwnKeysSaved },
  /**
   * The owner's link, on the host that belongs to no business, after signing in there. Spends the invite and makes the
   * signed-in person the owner of the business it names; an old, used or revoked link is 410-like `conflict` with
   * INVITE_EXPIRED_MESSAGE. The handler finds the signed-in person itself, as sign-up does.
   */
  'setup.openInvite': { method: 'POST', path: '/setup/invite', access: PUBLIC, noBusiness: true, body: InviteOpen, response: InviteOpened },
};

/** Which module answers which of these. */
export const OPS_ROUTE_OWNERS = Object.freeze({
  onboarding: Object.freeze(Object.keys(setupRoutes)),
  'managed-services': Object.freeze(Object.keys(teamFeedRoutes)),
});

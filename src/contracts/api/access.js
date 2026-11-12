/**
 * Who may call a route. Plain data with no imports, so the server's guard and the console's navigation
 * read the same rules. Every route in the contract names one of these.
 *
 *   PUBLIC        anyone, signed in or not
 *   SIGNED_IN     any signed-in person of this business, shoppers included
 *   OWNER_ONLY    the owner
 *   MANAGERS      owner and manager
 *   staffWith(p)  owner, manager, and staff holding permission p
 */
export const SELLER_ROLES = Object.freeze(['owner', 'manager', 'staff']);
export const PERMISSIONS = Object.freeze(['catalog', 'orders', 'automations', 'analytics', 'customers', 'inbox']);

export const PUBLIC = Object.freeze({ public: true });
export const SIGNED_IN = Object.freeze({ signedIn: true });
/** `denied` is what a signed-in person who isn't the owner is told, instead of the general refusal. */
export const OWNER_ONLY = Object.freeze({ roles: Object.freeze(['owner']), denied: 'Owner only.' });
export const MANAGERS = Object.freeze({ roles: Object.freeze(['owner', 'manager']) });
export const staffWith = (permission) => Object.freeze({ roles: SELLER_ROLES, permission });

/**
 * Who may see revenue and order counts in analytics (PRD 7.11). Staff need the orders permission: analytics alone isn't enough.
 */
export const canSeeRevenue = (user) => ['owner', 'manager'].includes(user?.role) || (user?.role === 'staff' && (user.permissions ?? []).includes('orders'));

/**
 * True when `user` (null for nobody) passes `access`. Staff get a route only through its named permission,
 * so staff with no permissions recorded can do nothing here.
 */
export function isAllowed(user, access) {
  if (access.public) return true;
  if (!user) return false;
  if (access.signedIn) return true;
  if (!access.roles?.includes(user.role)) return false;
  if (user.role !== 'staff') return true;
  return Boolean(access.permission) && (user.permissions ?? []).includes(access.permission);
}

// ---- Bhava's own team (PRD 5.5, 5.10, 5.17) ------------------------------------------------------------------------

/**
 * Platform roles. super_admin does everything; support helps a business (impersonation, pauses, health); onboarding runs
 * done-for-you setup; service_operator works a seller's paid services and nothing else. They sign in only on the console
 * host, with an emailed code plus TOTP: seller credentials are refused there and platform credentials on a business host.
 */
export const PLATFORM_ROLES = Object.freeze(['super_admin', 'support', 'onboarding', 'service_operator']);
/** Who may open a business as its owner. */
export const IMPERSONATION_ROLES = Object.freeze(['super_admin', 'support']);
export const IMPERSONATION_MINUTES = 30;
export const IMPERSONATION_MODES = Object.freeze(['read', 'write']);

/**
 * An operator inside a business uses a normal seller session of the owner's account that names what it was opened for:
 * req.session.operator is
 *
 *   { kind: 'impersonation', id, operatorId, ownerId, mode: 'read' | 'write', expiresAt }
 *   { kind: 'service', id, operatorId, service, taskRef, mode: 'direct' | 'approve_first' }
 *
 * and the API router applies the rules below to every request of such a session, before the handler runs.
 */

/**
 * What nobody impersonating may call, in read or write mode (PRD 5.10): the owner's phone, email and other credentials,
 * owner and team changes, closing the business, and everything under billing. Three parts, all checked by impersonationBlocked:
 * every route marked `fresh` (keys, credentials, roles, deletion: an operator can never re-auth as the owner), whole groups,
 * and single routes.
 */
export const IMPERSONATION_BLOCKED = Object.freeze({
  fresh: true,
  groups: Object.freeze(['billing', 'referrals', 'team', 'setup', 'services', 'signup', 'apiKeys', 'dataRequests']),
  routes: Object.freeze([
    'auth.login', 'auth.start', 'auth.verify', 'auth.exchange', 'auth.apple', 'auth.refresh', 'auth.businesses', 'auth.devices', 'auth.revokeDevice', 'auth.reauthStart', 'auth.reauthVerify',
    'auth.enableDeviceUnlock', 'auth.linkIdentity', 'auth.deleteAccount', 'customers.resetPassword', 'settings.updatePayment', 'teamFeed.undo', 'teamFeed.approve', 'teamFeed.reject',
  ]),
});
export const impersonationBlocked = (route) =>
  Boolean(route.fresh) || IMPERSONATION_BLOCKED.groups.includes(String(route.id).split('.')[0]) || IMPERSONATION_BLOCKED.routes.includes(route.id);

/** A request that changes nothing. Everything else is a write, and is refused in read mode. */
export const isReadMethod = (method) => method === 'GET' || method === 'HEAD';

/**
 * Shopper contact fields. In an impersonated session the router masks every one of these, at any depth of any answer,
 * except on the routes of CONTACTS_SHOWN_ON (order detail, where support needs them to help with a delivery).
 */
export const SHOPPER_CONTACT_FIELDS = Object.freeze([
  'phone', 'email', 'whatsapp', 'customerPhone', 'customerEmail', 'shopperPhone', 'shopperEmail', 'contactPhone', 'contactEmail', 'recipientPhone',
  'address', 'line1', 'line2', 'addressLine1', 'addressLine2', 'landmark', 'username', 'igUsername', 'handle',
]);
export const CONTACTS_SHOWN_ON = Object.freeze(['orders.get']);

/** `98••••••21`, `r•••@example.com`; anything else keeps nothing. Never the whole value. */
export function maskContact(value) {
  const text = String(value ?? '');
  if (!text) return text;
  const at = text.indexOf('@');
  if (at > 0 && at === text.lastIndexOf('@')) return `${text[0]}•••${text.slice(at)}`;
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length >= text.replace(/\s/g, '').length - 3) return `${digits.slice(0, 2)}${'•'.repeat(digits.length - 4)}${digits.slice(-2)}`;
  return '•••';
}

/** A copy of an answer with the shopper contact fields masked. Applied by the router after the response schema, never by a handler. */
export function maskShopperContacts(routeId, value, depth = 0) {
  if (CONTACTS_SHOWN_ON.includes(routeId) || value === null || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => maskShopperContacts(routeId, item, depth + 1));
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SHOPPER_CONTACT_FIELDS.includes(key) && (typeof inner === 'string' || typeof inner === 'number')) out[key] = maskContact(inner);
    else if (SHOPPER_CONTACT_FIELDS.includes(key) && inner && typeof inner === 'object') out[key] = Array.isArray(inner) ? inner.map(() => '•••') : maskAll(inner);
    else out[key] = maskShopperContacts(routeId, inner, depth + 1);
  }
  return out;
}
const maskAll = (object) => Object.fromEntries(Object.entries(object).map(([key, inner]) => [key, inner && typeof inner === 'object' ? '•••' : inner === null || inner === '' ? inner : maskContact(inner)]));

/**
 * Why an operator's request is refused before anything runs, as { code, message }, or null when it may go on.
 * `route` is a row of routeList; `operator` is req.session.operator. The same answer for a route whether or not the
 * thing it names exists, so nothing is learned from the refusal.
 */
export function operatorRefusal(route, operator) {
  if (!operator) return null;
  if (operator.kind === 'impersonation') {
    if (impersonationBlocked(route)) return { code: 'impersonation.blocked', message: 'Support can’t do this for an owner. Ask the owner to do it themselves.' };
    if (!isReadMethod(route.method) && route.id !== 'auth.logout' && operator.mode !== 'write') return { code: 'impersonation.read_only', message: 'This session is read-only. Turn on write mode in the console to change something.' };
    return null;
  }
  if (operator.kind === 'service') {
    if (route.id === 'auth.me' || route.id === 'auth.logout') return null;
    if (![route.service ?? []].flat().includes(operator.service)) return { code: 'service.out_of_scope', message: 'This isn’t part of the service you are working on.' };
    return null;
  }
  return { code: 'forbidden', message: undefined };
}

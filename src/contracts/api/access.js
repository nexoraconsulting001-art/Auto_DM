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

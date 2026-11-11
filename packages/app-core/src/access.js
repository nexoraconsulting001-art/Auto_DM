/**
 * Who may open a screen: the same rules, from the same file, as the server's guard and the console's menu
 * (src/contracts/api/access.js). An app feature names an `access` from here and, when its plan must include it, a
 * `feature` (an entitlement such as 'automations' or 'store.checkout').
 *
 * Hiding a screen is a courtesy. The server refuses the call again, by role, permission and plan.
 */
import { isAllowed } from '../../../src/contracts/api/access.js';

export { MANAGERS, OWNER_ONLY, PERMISSIONS, PUBLIC, SELLER_ROLES, SIGNED_IN, canSeeRevenue, isAllowed, staffWith } from '../../../src/contracts/api/access.js';

/**
 * True when this person, in this business, may open the feature. `entitlements` is { [feature]: boolean } for the
 * business in use, or null while it is not known: an unknown entitlement shows the screen and lets the server decide.
 */
export function canOpen(feature, { user, entitlements = null } = {}) {
  if (!feature || !isAllowed(user ?? null, feature.access)) return false;
  if (!feature.feature || !entitlements) return true;
  return entitlements[feature.feature] !== false;
}

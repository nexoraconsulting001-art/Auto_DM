import { notBuilt } from '../not-built.js';

/**
 * A business's team (PRD 5.11): owners, managers, and staff with chosen permissions. One track owns this folder and
 * edits nothing outside it. Routes and shapes are src/contracts/api/team.js; invitations are `team_invites`
 * (migration 502, a tenant table); roles and permissions are the columns `users` already has.
 *
 * Rules the tests will hold this folder to:
 *
 * - Owner only, and every change needs a fresh session: the router already enforces both from the contract.
 * - Nobody joins by having their number typed in. team.invite stores a keyed hash of the phone or email
 *   (subjectHash in src/contracts/accounts.js) and a hashed token, for INVITE_DAYS. The account is made, with
 *   users.person_id set, when a person signs in with that identity verified: src/modules/accounts asks this module
 *   for the open invitations that match a verified identity, in every business, through `acceptInvites`.
 * - A business always has at least one owner: the last owner cannot be demoted or removed, by themselves or anyone
 *   (F-49). Check and change in one transaction, with the owners' rows locked.
 * - team.remove sets users.removed_at, deletes the memberships rows that name the account, and revokes every session
 *   the account has and every refresh family of its person, in one transaction: web and app both answer 401 on their
 *   next request (F-47). The row itself stays, for the audit trail and the orders it touched.
 * - team.update changes role and permissions only. Permissions count only for staff and are cleared for any other role.
 * - Every change writes an audit row (writeAudit from src/modules/audit) with ids, roles and permissions: never a
 *   number or an email.
 * - Staff reach a route only through its named permission, a manager is refused what is owner only (F-46, F-48):
 *   that is src/contracts/api/access.js, already enforced by the router. This module adds no second rule.
 */
export const team = {
  name: 'team',
  api: () => notBuilt('team.list', 'team.invite', 'team.update', 'team.remove'),
};

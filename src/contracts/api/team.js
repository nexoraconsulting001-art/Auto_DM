import { z } from 'zod';
import { OWNER_ONLY, PERMISSIONS } from './access.js';
import { Id, IdParams, ListQuery, Timestamp, page, text } from './common.js';

/**
 * A business's team (PRD 5.11): owners, managers and staff with chosen permissions. Owner only, and every change
 * needs a fresh re-auth. The work is in src/modules/team; the invitations are `team_invites` (migration 502).
 *
 * Nobody is added by typing their number, and nobody joins without doing so themselves: the owner invites a phone or
 * an email and gets, once, an invitation code to pass on; the account appears only when the person, signed in with that
 * identity verified, accepts with that code (auth.acceptInvite). Until then the business sees nothing about them, not
 * even whether they use Bhava. A business always keeps at least one owner (F-49). Removing someone ends every session
 * they have, on web and app, at once (F-47).
 */
const Role = z.enum(['owner', 'manager', 'staff']);
const Permissions = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

export const TeamMember = z.object({
  id: Id,
  name: z.string(),
  /** Masked. */
  phone: z.string(),
  role: Role,
  permissions: Permissions,
  /** The person signed in as this request. */
  you: z.boolean(),
  /** False for an account from before Phase 5 that nobody has proved is theirs yet. */
  verified: z.boolean(),
  joinedAt: Timestamp,
});

export const TeamInvite = z.object({
  id: Id,
  /** Masked: the invitation holds only a hash of the contact. */
  contact: z.string(),
  role: Role,
  permissions: Permissions,
  expiresAt: Timestamp,
  createdAt: Timestamp,
});

/**
 * What team.invite answers: the invitation, and its code, given this once and never again (only its hash is kept).
 * The owner passes the code to the person; it works only for someone signed in with the invited phone or email verified.
 */
export const TeamInviteCreated = TeamInvite.extend({ code: z.string() });

/** `contact` is a phone number or an email address. Permissions count only for staff. */
export const TeamInviteInput = z.object({
  contact: text(200).min(3, 'Enter a phone number or an email'),
  role: Role,
  permissions: Permissions.default([]),
});

export const TeamUpdate = z.object({ role: Role.optional(), permissions: Permissions.optional() }).refine((v) => v.role !== undefined || v.permissions !== undefined, { message: 'Nothing to change' });

export const teamRoutes = {
  /** A page of members, with every open invitation beside it. */
  'team.list': { method: 'GET', path: '/team', access: OWNER_ONLY, query: ListQuery, response: page(TeamMember).extend({ invites: z.array(TeamInvite) }) },
  'team.invite': { limit: { feature: 'staff.seats', counts: 'team.seats' }, method: 'POST', path: '/team/invites', access: OWNER_ONLY, fresh: true, body: TeamInviteInput, status: 201, response: TeamInviteCreated },
  'team.update': { method: 'PATCH', path: '/team/:id', access: OWNER_ONLY, fresh: true, params: IdParams, body: TeamUpdate, response: TeamMember },
  'team.remove': { method: 'DELETE', path: '/team/:id', access: OWNER_ONLY, fresh: true, params: IdParams, status: 204, response: null },
};

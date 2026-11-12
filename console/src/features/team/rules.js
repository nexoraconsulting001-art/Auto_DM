/**
 * The team's rules as the screen applies them (PRD 5.11; F-49), with no React, so node's test runner reads them. The
 * server makes every one of these checks again and is the one that counts: the screen only avoids offering what it
 * would refuse, and shows the server's own words when it refuses anyway.
 */
import { toE164 } from '../account/signin.js';

export const ROLES = Object.freeze(['owner', 'manager', 'staff']);
/** PERMISSIONS in src/contracts/api/access.js, in the same order; a test keeps the two equal. */
export const PERMISSIONS = Object.freeze(['catalog', 'orders', 'automations', 'analytics', 'customers', 'inbox']);

export const ROLE_LABELS = Object.freeze({ owner: 'Owner', manager: 'Manager', staff: 'Staff' });
export const ROLE_HELP = Object.freeze({
  owner: 'Everything, including billing, the team and payment keys.',
  manager: 'Everything except billing, the team, payment and integration keys, refunds and Reach Guard settings.',
  staff: 'Only the parts you choose below.',
});
export const PERMISSION_LABELS = Object.freeze({
  catalog: 'Products and catalog',
  orders: 'Orders',
  automations: 'Automations',
  analytics: 'Insights',
  customers: 'Customers',
  inbox: 'Inbox',
});

/** The server's sentence for the last owner (src/modules/team), so the screen says the same thing before it is tried. */
export const LAST_OWNER = 'A business needs at least one owner. Make someone else an owner first.';

export const ownerCount = (members) => members.filter((member) => member.role === 'owner').length;

/**
 * Why this member's role cannot be changed away from owner, or why they cannot be removed, on this screen: they are
 * the only owner. `complete` is false while the list may be missing people, and then nothing is ruled out here.
 */
export function lastOwnerLock(member, members, { complete = true } = {}) {
  if (!complete || member.role !== 'owner') return '';
  return ownerCount(members) <= 1 ? LAST_OWNER : '';
}

/** The body of team.update for a change from `member` to `next`, holding only what changed, or null when nothing did. */
export function changeOf(member, next) {
  const body = {};
  if (next.role !== member.role) body.role = next.role;
  const wanted = next.role === 'staff' ? sortPermissions(next.permissions) : [];
  const had = member.role === 'staff' ? sortPermissions(member.permissions) : [];
  if (next.role === 'staff' && wanted.join(',') !== had.join(',')) body.permissions = wanted;
  return Object.keys(body).length ? body : null;
}

export const sortPermissions = (list = []) => PERMISSIONS.filter((permission) => list.includes(permission));

/** What staff can do, in words: "Orders, Inbox", or a warning that they can do nothing yet. */
export function permissionSummary(member) {
  if (member.role !== 'staff') return ROLE_HELP[member.role] ?? '';
  const names = sortPermissions(member.permissions).map((permission) => PERMISSION_LABELS[permission]);
  return names.length ? names.join(', ') : 'No permissions yet: they can sign in but open nothing.';
}

/** The server's email rule for an invitation (src/modules/team), read on the lower-cased contact. */
export const INVITE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

/**
 * The contact an invitation is for, read the way the server reads it: a phone number first (toE164: ten digits starting
 * 6 to 9 are Indian, anything else needs its country code), else an email. Null when it is neither.
 */
export function inviteContact(value) {
  const raw = String(value ?? '').trim();
  const phone = toE164(raw);
  if (phone) return { kind: 'phone', subject: phone };
  const email = raw.toLowerCase();
  return INVITE_EMAIL.test(email) ? { kind: 'email', subject: email } : null;
}

/** Field errors for an invitation before it is sent, as { contact?, role?, permissions? }. The server checks again. */
export function inviteProblems({ contact, role, permissions }) {
  const problems = {};
  if (!inviteContact(contact)) problems.contact = 'Enter a phone number or an email';
  if (!ROLES.includes(role)) problems.role = 'Choose a role';
  if (role === 'staff' && !(permissions ?? []).length) problems.permissions = 'Choose at least one thing they can do';
  return problems;
}

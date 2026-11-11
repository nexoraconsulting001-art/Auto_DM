import { INVITE_DAYS, newToken, subjectHash, toE164, tokenHash } from '../../contracts/accounts.js';
import { ApiError, SELLER_ROLES } from '../../contracts/api/index.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { pageOfFetched, readCursor, isRowId } from '../admin-api/paging.js';
import { accountsFor } from '../accounts/index.js';
import { maskedAccountPhone } from '../accounts/shared.js';
import { revokeFamilies } from '../accounts/tokens.js';
import { acceptInvites, linkMemberships } from './invites.js';

export { acceptInvites, linkMemberships } from './invites.js';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const LAST_OWNER = 'A business needs at least one owner. Make someone else an owner first.';
const CONTACT_LABEL = { phone: 'Phone number', email: 'Email address' };

/** The contact an invitation is for, as { kind, subject }: a number in E.164, or an email in lower case. */
function readContact(value) {
  const raw = String(value ?? '').trim();
  const phone = toE164(raw);
  if (phone) return { kind: 'phone', subject: phone };
  const email = raw.toLowerCase();
  if (EMAIL.test(email)) return { kind: 'email', subject: email };
  throw new ApiError('validation_failed', 'Enter a phone number or an email', { fields: { contact: 'Enter a phone number or an email' } });
}

const unique = (list) => [...new Set(list ?? [])];

const member = (row, me) => ({
  id: row.id,
  name: row.name,
  phone: maskedAccountPhone(row.phone),
  role: row.role,
  permissions: row.role === 'staff' ? row.permissions ?? [] : [],
  you: row.id === me.id,
  verified: row.person_id !== null && row.person_id !== undefined,
  joinedAt: row.created_at,
});

const invitation = (row) => ({
  id: row.id,
  contact: CONTACT_LABEL[row.contact_kind] ?? 'Invitation',
  role: row.role,
  permissions: row.permissions ?? [],
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

/**
 * A business's team (PRD 5.11): owners, managers, and staff with chosen permissions. Owner only, and every change needs
 * a fresh re-auth; the router enforces both from the contract (src/contracts/api/team.js), and staff reach any other
 * route only through its named permission (src/contracts/api/access.js). This module adds no second rule.
 *
 * - Nobody joins by having their number typed in. team.invite stores a keyed hash of the phone or email and a hashed
 *   token, for INVITE_DAYS; the account appears when a person proves that identity (acceptInvites, called by
 *   src/modules/accounts at every sign-in, and here at once for someone who already has).
 * - A business always has at least one owner: the last owner cannot be demoted or removed, by themselves or anyone
 *   (F-49). The owners' rows are locked while the check and the change are made.
 * - team.remove sets removed_at, deletes the switcher pairs naming the account, and revokes every session it has and
 *   every refresh family of its person, in one transaction: web and app both answer 401 on their next request (F-47).
 * - team.update changes role and permissions only. Permissions count only for staff and are cleared for any other role.
 * - Every change writes an audit row with ids, roles and permissions: never a number or an email.
 */
export const team = {
  name: 'team',
  api(ctx) {
    const secret = () => ctx.config.sessionSecret;
    const platform = () => ctx.db.platform ?? ctx.db;

    async function lockOwners(t) {
      return t.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY id FOR UPDATE`, [tenantId()]);
    }

    async function lockMember(t, id) {
      const [row] = await t.query(
        'SELECT id, name, phone, role, permissions, person_id, created_at FROM users WHERE tenant_id = $1 AND id = $2 AND role = ANY($3) AND removed_at IS NULL FOR UPDATE',
        [tenantId(), id, SELLER_ROLES],
      );
      if (!row) throw new ApiError('not_found');
      return row;
    }

    /** Someone who has already proved this identity joins at once; anyone else when they sign in with it. */
    async function takeUpNow(contact) {
      const people = accountsFor(ctx).people;
      // An email two people have each proved is left for whichever of them signs in with it.
      const owners = contact.kind === 'phone'
        ? await platform().query(`SELECT person_id FROM person_identities WHERE kind = 'phone' AND subject = $1`, [contact.subject])
        : await platform().query(`SELECT DISTINCT person_id FROM person_identities WHERE kind <> 'phone' AND lower(email) = $1 LIMIT 2`, [contact.subject]);
      if (owners.length !== 1) return;
      const [owner] = owners;
      const personId = Number(owner.person_id);
      const me = await people.person(personId);
      if (!me) return;
      const phones = await people.phonesOf(personId);
      await acceptInvites(ctx, { personId, name: me.name, phones, emails: contact.kind === 'email' ? [contact.subject] : [], onlyTenant: tenantId() });
      await linkMemberships(ctx.db, personId);
    }

    return {
      'team.list': async ({ query, user }) => {
        const after = query.cursor ? readCursor(query.cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : 0;
        const rows = await ctx.db.query(
          `SELECT id, name, phone, role, permissions, person_id, created_at FROM users
           WHERE tenant_id = $1 AND role = ANY($2) AND removed_at IS NULL AND id > $3 ORDER BY id LIMIT $4`,
          [tenantId(), SELLER_ROLES, after, query.limit + 1],
        );
        const invites = await ctx.db.query(
          `SELECT id, contact_kind, role, permissions, expires_at, created_at FROM team_invites
           WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY id`,
          [tenantId()],
        );
        const listed = pageOfFetched(rows, query.limit, (row) => [row.id]);
        return { items: listed.items.map((row) => member(row, user)), nextCursor: listed.nextCursor, invites: invites.map(invitation) };
      },

      'team.invite': async ({ body, user }) => {
        const contact = readContact(body.contact);
        const permissions = body.role === 'staff' ? unique(body.permissions) : [];
        const contactHash = subjectHash(secret(), contact.kind, contact.subject);
        const token = newToken(32);
        const row = await ctx.db.tx(async (t) => {
          // A new invitation to the same contact replaces the one before, taken up or not yet.
          await t.query(
            'UPDATE team_invites SET revoked_at = now() WHERE tenant_id = $1 AND contact_kind = $2 AND contact_hash = $3 AND accepted_at IS NULL AND revoked_at IS NULL',
            [tenantId(), contact.kind, contactHash],
          );
          const [made] = await t.query(
            `INSERT INTO team_invites (tenant_id, contact_kind, contact_hash, role, permissions, token_hash, invited_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8::int))
             RETURNING id, contact_kind, role, permissions, expires_at, created_at`,
            [tenantId(), contact.kind, contactHash, body.role, permissions, tokenHash(token), user.id, INVITE_DAYS],
          );
          await writeAudit(t, { actor: `user:${user.id}`, action: 'team.invite', target: `invite:${made.id}`, details: { inviteId: made.id, contactKind: contact.kind, role: body.role, permissions } });
          return made;
        });
        log.info('team.invited', { inviteId: row.id, role: body.role });
        // The invitation is saved either way: if this fails, it is taken up at the person's next sign-in.
        await takeUpNow(contact).catch((err) => reportError(err, { msg: 'team.take_up_failed', inviteId: row.id }));
        return invitation(row);
      },

      'team.update': async ({ params, body, user }) => {
        const row = await ctx.db.tx(async (t) => {
          const owners = await lockOwners(t);
          const target = await lockMember(t, params.id);
          const role = body.role ?? target.role;
          if (target.role === 'owner' && role !== 'owner' && owners.length <= 1) throw new ApiError('conflict', LAST_OWNER);
          const permissions = role === 'staff' ? unique(body.permissions ?? (target.role === 'staff' ? target.permissions : [])) : [];
          const [updated] = await t.query(
            'UPDATE users SET role = $3, permissions = $4 WHERE tenant_id = $1 AND id = $2 RETURNING id, name, phone, role, permissions, person_id, created_at',
            [tenantId(), target.id, role, permissions],
          );
          await writeAudit(t, {
            actor: `user:${user.id}`, action: 'team.update', target: `user:${target.id}`,
            details: { userId: target.id, from: { role: target.role, permissions: target.role === 'staff' ? target.permissions : [] }, to: { role, permissions } },
          });
          return updated;
        });
        log.info('team.updated', { userId: row.id, role: row.role });
        return member(row, user);
      },

      'team.remove': async ({ params, user }) => {
        const removed = await platform().tx(async (t) => {
          const owners = await lockOwners(t);
          const target = await lockMember(t, params.id);
          if (target.role === 'owner' && owners.length <= 1) throw new ApiError('conflict', LAST_OWNER);
          await t.query('UPDATE users SET removed_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), target.id]);
          await t.query('DELETE FROM memberships WHERE (tenant_id = $1 AND user_id = $2) OR (member_tenant_id = $1 AND member_user_id = $2)', [tenantId(), target.id]);
          await t.query('UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL', [tenantId(), target.id]);
          const families = target.person_id ? await revokeFamilies(t, { personId: Number(target.person_id), reason: 'staff_removed' }) : [];
          await writeAudit(t, { actor: `user:${user.id}`, action: 'team.remove', target: `user:${target.id}`, details: { userId: target.id, role: target.role, families: families.length } });
          return target;
        });
        log.info('team.removed', { userId: removed.id });
      },
    };
  },
};

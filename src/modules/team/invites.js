import { localPhone, subjectHash } from '../../contracts/accounts.js';
import { SELLER_ROLES } from '../../contracts/api/access.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';

const NO_PASSWORD = '!';
const placeholderPhone = (personId) => `person:${Number(personId)}`;

/**
 * Taking up invitations (PRD 5.11). src/modules/accounts calls this whenever a person proves an identity: with the
 * numbers and emails they have verified, it finds every open invitation in every business whose contact hashes to one
 * of them, and gives the person an account there. Nobody joins because someone typed their number: the invitation holds
 * only a hash, and only a verified identity reaches it.
 *
 * In a business where the person already has an account on the team, the invitation is simply marked taken; their role
 * stays what it is (team.update changes roles). A row there with the same verified number that is a shopper's, or an
 * account removed earlier, becomes the team account with the invitation's role, and every session it had ends first:
 * a session opened as a shopper never turns into a team member's.
 *
 * Returns [{ tenantId, userId }] for the invitations taken.
 */
export async function acceptInvites({ db, config }, { personId, name = '', phones = [], emails = [], onlyTenant = null }) {
  const platform = db.platform ?? db;
  const contacts = [
    ...phones.map((p) => ['phone', subjectHash(config.sessionSecret, 'phone', p)]),
    ...emails.filter(Boolean).map((e) => ['email', subjectHash(config.sessionSecret, 'email', e)]),
  ];
  if (!contacts.length || !personId) return [];
  const open = await platform.query(
    `SELECT i.id, i.tenant_id FROM team_invites i JOIN unnest($1::text[], $2::text[]) AS c(kind, hash) ON c.kind = i.contact_kind AND c.hash = i.contact_hash
     WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND ($3::int IS NULL OR i.tenant_id = $3::int)
     ORDER BY i.id`,
    [contacts.map((c) => c[0]), contacts.map((c) => c[1]), onlyTenant],
  );
  const taken = [];
  for (const invite of open) {
    // A sign-in never fails because one invitation could not be taken up: it stays open for the next one.
    const userId = await withTenant(invite.tenant_id, () => acceptOne(db, { inviteId: invite.id, tenantId: invite.tenant_id, personId, name, phones }))
      .catch((err) => reportError(err, { msg: 'team.invite_not_taken', inviteId: invite.id }));
    if (userId) taken.push({ tenantId: invite.tenant_id, userId });
  }
  return taken;
}

async function acceptOne(db, { inviteId, tenantId, personId, name, phones }) {
  return db.tx(async (t) => {
    const [invite] = await t.query(
      `SELECT id, contact_kind, role, permissions FROM team_invites
       WHERE tenant_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
      [tenantId, inviteId],
    );
    if (!invite) return null;
    const candidates = phones.map((p) => localPhone(p) ?? p);
    let [account] = await t.query(
      'SELECT id, role, removed_at FROM users WHERE tenant_id = $1 AND person_id = $2 ORDER BY removed_at NULLS FIRST, id LIMIT 1 FOR UPDATE',
      [tenantId, personId],
    );
    if (!account && candidates.length) {
      [account] = await t.query(
        'SELECT id, role, removed_at FROM users WHERE tenant_id = $1 AND phone = ANY($2) AND (person_id IS NULL OR person_id = $3) ORDER BY id LIMIT 1 FOR UPDATE',
        [tenantId, candidates, personId],
      );
    }
    let userId;
    if (account && account.removed_at === null && SELLER_ROLES.includes(account.role)) {
      await t.query('UPDATE users SET person_id = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, account.id, personId]);
      userId = account.id;
    } else if (account) {
      await t.query(
        'UPDATE users SET role = $3, permissions = $4, removed_at = NULL, person_id = $5 WHERE tenant_id = $1 AND id = $2',
        [tenantId, account.id, invite.role, invite.role === 'staff' ? invite.permissions : [], personId],
      );
      await t.query('UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL', [tenantId, account.id]);
      userId = account.id;
    } else {
      const taken = new Set((await t.query('SELECT phone FROM users WHERE tenant_id = $1 AND phone = ANY($2)', [tenantId, candidates])).map((r) => r.phone));
      const phone = candidates.find((c) => !taken.has(c)) ?? placeholderPhone(personId);
      const [row] = await t.query(
        `INSERT INTO users (tenant_id, name, phone, email, password_hash, role, permissions, person_id) VALUES ($1, $2, $3, '', $4, $5, $6, $7) RETURNING id`,
        [tenantId, String(name || 'Team member').slice(0, 80), phone, NO_PASSWORD, invite.role, invite.role === 'staff' ? invite.permissions : [], personId],
      );
      userId = row.id;
    }
    await t.query('UPDATE team_invites SET accepted_at = now(), accepted_user_id = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, invite.id, userId]);
    await writeAudit(t, { actor: `user:${userId}`, action: 'team.invite_accepted', target: `invite:${invite.id}`, details: { inviteId: invite.id, userId, role: invite.role, contactKind: invite.contact_kind } });
    log.info('team.invite_accepted', { inviteId: invite.id, userId });
    return userId;
  });
}

/**
 * The business switcher's pairs (memberships) between every two seller accounts of one person, written on the
 * platform path because a pair spans two businesses. Only accounts the person has proved are theirs carry person_id.
 */
export async function linkMemberships(db, personId) {
  if (!personId) return;
  await (db.platform ?? db).query(
    `INSERT INTO memberships (tenant_id, user_id, member_tenant_id, member_user_id)
     SELECT a.tenant_id, a.id, b.tenant_id, b.id
     FROM users a JOIN users b ON b.person_id = a.person_id AND b.tenant_id <> a.tenant_id
     WHERE a.person_id = $1 AND a.role = ANY($2) AND b.role = ANY($2) AND a.removed_at IS NULL AND b.removed_at IS NULL
     ON CONFLICT DO NOTHING`,
    [personId, SELLER_ROLES],
  );
}

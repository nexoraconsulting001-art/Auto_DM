import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { INVITE_DAYS, INVITE_EXPIRED_MESSAGE } from '../../contracts/onboarding.js';
import { platformAppHostOf } from '../../config.js';
import { log } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';

/**
 * The owner's link (PRD 5.6, F-26, F-27, F-108). A random token is answered once, in the address the console shows; only
 * its SHA-256 is stored. It works once and for INVITE_DAYS; sending again revokes the live one first, so a business has one
 * live link at most (a unique index holds that too). Opening it spends it in one statement, so two people opening it at the
 * same moment cannot both get in. The token never reaches a log: the address carries it after '#', which browsers do not send.
 * onboarding_invites is the platform's alone, so all of this runs on db.platform.
 */
export const hashInviteToken = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');
export const newInviteToken = () => crypto.randomBytes(32).toString('base64url');

const toInvite = (r, createdBy = '') => ({
  id: Number(r.id), createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at ?? null, revokedAt: r.revoked_at ?? null, createdBy: createdBy || r.created_by_name || '',
});

export const inviteStateOf = (r) => {
  if (!r) return 'none';
  if (r.used_at) return 'used';
  if (r.revoked_at) return 'revoked';
  if (new Date(r.expires_at) <= new Date()) return 'expired';
  return 'sent';
};

const tenDigits = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

export function createInvites(ctx) {
  const platform = ctx.db.platform ?? ctx.db;

  const latestSql = `SELECT i.*, coalesce(nullif(p.name, ''), 'Bhava team') AS created_by_name FROM onboarding_invites i
    LEFT JOIN platform_users p ON p.id = i.created_by WHERE i.tenant_id = $1 ORDER BY i.id DESC LIMIT 1`;

  return {
    toInvite,

    async latest(tenantIdValue) {
      const [row] = await platform.query(latestSql, [tenantIdValue]);
      return row ?? null;
    },

    /** Revokes the live link and makes a new one, for the business `tenant` ({ id, slug, name }). -> { invite, url } */
    async send(tenant, { operatorId, actor, via = [] }) {
      const token = newInviteToken();
      const row = await platform.tx(async (t) => {
        await t.query('UPDATE onboarding_invites SET revoked_at = now() WHERE tenant_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [tenant.id]);
        const [made] = await t.query(
          `INSERT INTO onboarding_invites (tenant_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING *`,
          [tenant.id, hashInviteToken(token), operatorId || null, INVITE_DAYS],
        );
        await withTenant(tenant, () => writeAudit(t, { actor, action: 'onboarding.invite_sent', target: 'onboarding_invite', details: { inviteId: Number(made.id), via } }));
        return made;
      });
      const [full] = await platform.query(latestSql, [tenant.id]);
      const host = platformAppHostOf(ctx.config);
      const url = `${host ? `https://${host}` : ''}/setup#invite=${token}`;
      log.info('onboarding.invite_sent', { tenantId: tenant.id, inviteId: Number(row.id) });
      return { invite: toInvite(full ?? row), url };
    },

    async revoke(tenant, { actor }) {
      await platform.tx(async (t) => {
        const revoked = await t.query('UPDATE onboarding_invites SET revoked_at = now() WHERE tenant_id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id', [tenant.id]);
        if (revoked.length) await withTenant(tenant, () => writeAudit(t, { actor, action: 'onboarding.invite_revoked', target: 'onboarding_invite', details: { inviteId: Number(revoked[0].id) } }));
      });
    },

    /**
     * Spends the invite named by `token` and answers the business. `user` is whoever is signed in on the sign-in host, if
     * anyone: that person must be the business's owner (same person, or the owner's own phone number), and an owner account
     * with no person yet is joined to them. Somebody else signed in is refused before the link is spent. An old, used,
     * revoked or unknown link answers INVITE_EXPIRED_MESSAGE and names no business.
     */
    async open(token, user = null) {
      const expired = () => new ApiError('conflict', INVITE_EXPIRED_MESSAGE);
      const hash = hashInviteToken(token);
      const personId = Number(user?.person_id) > 0 ? Number(user.person_id) : null;
      const opened = await platform.tx(async (t) => {
        const [invite] = await t.query(
          `SELECT id, tenant_id FROM onboarding_invites WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
          [hash],
        );
        if (!invite) return null;
        const [owner] = await t.query(`SELECT id, phone, person_id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY id LIMIT 1`, [invite.tenant_id]);
        let usedBy = null;
        if (personId && owner) {
          if (Number(owner.person_id) !== personId) {
            const phones = await t.query(`SELECT subject FROM person_identities WHERE person_id = $1 AND kind = 'phone'`, [personId]);
            const samePhone = phones.some((p) => tenDigits(p.subject) === tenDigits(owner.phone) && tenDigits(owner.phone).length === 10);
            if (owner.person_id || !samePhone) return { refused: true };
            await t.query('UPDATE users SET person_id = $3 WHERE tenant_id = $1 AND id = $2 AND person_id IS NULL', [invite.tenant_id, owner.id, personId]);
          }
          usedBy = Number(owner.id);
        }
        const [spent] = await t.query(
          `UPDATE onboarding_invites SET used_at = now(), used_by = $2 WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id, tenant_id, expires_at`,
          [invite.id, usedBy],
        );
        if (!spent) return null;
        const [tenant] = await t.query('SELECT id, slug, name FROM tenants WHERE id = $1', [spent.tenant_id]);
        await withTenant({ id: Number(tenant.id), slug: tenant.slug, name: tenant.name }, () => writeAudit(t, {
          actor: usedBy ? `user:${usedBy}` : 'invite', action: 'onboarding.invite_opened', target: 'onboarding_invite', details: { inviteId: Number(spent.id), attached: Boolean(usedBy) },
        }));
        return { tenantId: Number(tenant.id), businessName: tenant.name, expiresAt: spent.expires_at };
      });
      if (opened?.refused) {
        log.warn('onboarding.invite_wrong_person', {});
        throw new ApiError('forbidden', 'This link is for another account. Sign in with the owner’s phone number.');
      }
      if (!opened) {
        log.info('onboarding.invite_refused', {});
        throw expired();
      }
      log.info('onboarding.invite_opened', { tenantId: opened.tenantId });
      return opened;
    },
  };
}

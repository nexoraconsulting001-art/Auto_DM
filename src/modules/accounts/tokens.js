import { newToken, tokenHash } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { SELLER_ROLES } from '../../contracts/api/access.js';
import { log } from '../../platform/log.js';
import { insertSession } from '../../repos/sessions.js';
import { platformOf } from './shared.js';

/**
 * Ends refresh families and every session in them, on an open platform transaction `t`. Name the families by id, or
 * every live family of a person (on one device, when `deviceId` is given). Returns the ids it ended.
 */
export async function revokeFamilies(t, { familyIds = null, personId = null, deviceId = null, reason }) {
  if (!familyIds && !personId) throw new Error('Name the families to revoke');
  const rows = familyIds
    ? await t.query('UPDATE token_families SET revoked_at = now(), revoke_reason = $2 WHERE id = ANY($1::bigint[]) AND revoked_at IS NULL RETURNING id', [familyIds, reason])
    : await t.query(
      `UPDATE token_families SET revoked_at = now(), revoke_reason = $2
       WHERE subject_kind = 'user' AND person_id = $1 AND ($3::text IS NULL OR device_id = $3::text) AND revoked_at IS NULL RETURNING id`,
      [personId, reason, deviceId],
    );
  const ids = rows.map((r) => Number(r.id));
  const all = familyIds ? [...new Set([...familyIds.map(Number), ...ids])] : ids;
  if (all.length) await t.query('UPDATE sessions SET revoked_at = now() WHERE family_id = ANY($1::bigint[]) AND revoked_at IS NULL', [all]);
  return ids;
}

/**
 * A person's push registrations stop, on one device or all of them (signing out, revoking a device, deleting the
 * account): the token is wiped and the row says why, as the notifications module expects.
 */
export async function dropPushDevices(t, { personId, deviceId = null, reason }) {
  if (!personId) return;
  await t.query(
    `UPDATE push_devices SET deleted_at = now(), delete_reason = $3, token_enc = NULL
     WHERE person_id = $1 AND ($2::text IS NULL OR device_id = $2::text) AND deleted_at IS NULL`,
    [personId, deviceId, reason],
  );
}

/**
 * Refresh families (PRD 10.2). One family per sign-in on one device; every refresh token it ever had and every access
 * session hang off it. A refresh token is a long random value stored only as its hash, used once: spending it and
 * writing the next one, and the next access session, are one transaction. A token presented again, by a thief or by
 * two requests racing, revokes the family and everything in it (P-05).
 */
export function tokensService(ctx) {
  const db = () => platformOf(ctx.db);
  const accessMinutes = () => Number(ctx.config.accessTokenMinutes) || 15;
  const refreshDays = () => Number(ctx.config.refreshTokenDays) || 60;

  async function openFamily(t, { personId, deviceId = '' }) {
    const [family] = await t.query(`INSERT INTO token_families (subject_kind, person_id, device_id) VALUES ('user', $1, $2) RETURNING id`, [personId, deviceId || '']);
    return Number(family.id);
  }

  async function writeRefresh(t, { familyId, tenantId, userId }) {
    const token = newToken(32);
    const [row] = await t.query(
      `INSERT INTO refresh_tokens (family_id, token_hash, tenant_id, user_id, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int)) RETURNING id`,
      [familyId, tokenHash(token), tenantId, userId, refreshDays()],
    );
    return { token, id: Number(row.id) };
  }

  /** A new sign-in for the app: family, refresh token and a fresh access session, together. */
  async function issueApp({ personId, tenantId, userId, deviceId = '' }) {
    return db().tx(async (t) => {
      const familyId = await openFamily(t, { personId, deviceId });
      const refresh = await writeRefresh(t, { familyId, tenantId, userId });
      const accessToken = await insertSession(t, { tenantId, userId, kind: 'access', seconds: accessMinutes() * 60, familyId, deviceId: deviceId || null, fresh: true });
      return { familyId, accessToken, refreshToken: refresh.token, accessExpiresInSeconds: accessMinutes() * 60 };
    });
  }

  /** auth.refresh: spends the token, or refuses it; a second use ends the family. */
  async function rotate(token) {
    const outcome = await db().tx(async (t) => {
      const [spent] = await t.query(
        `UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL
         RETURNING id, family_id, tenant_id, user_id, expires_at > now() AS live`,
        [tokenHash(token)],
      );
      if (!spent) {
        const [seen] = await t.query('SELECT family_id FROM refresh_tokens WHERE token_hash = $1', [tokenHash(token)]);
        if (!seen) return { refused: 'unknown' };
        await revokeFamilies(t, { familyIds: [Number(seen.family_id)], reason: 'token_reuse' });
        return { refused: 'token_reuse', familyId: Number(seen.family_id) };
      }
      const familyId = Number(spent.family_id);
      const [family] = await t.query('SELECT person_id, device_id FROM token_families WHERE id = $1 AND revoked_at IS NULL', [familyId]);
      if (!family) return { refused: 'revoked', familyId };
      if (!spent.live) return { refused: 'expired', familyId };
      const [account] = await t.query(
        'SELECT id FROM users WHERE tenant_id = $1 AND id = $2 AND person_id = $3 AND role = ANY($4) AND removed_at IS NULL',
        [spent.tenant_id, spent.user_id, family.person_id, SELLER_ROLES],
      );
      if (!account) {
        await revokeFamilies(t, { familyIds: [familyId], reason: 'staff_removed' });
        return { refused: 'removed', familyId };
      }
      const next = await writeRefresh(t, { familyId, tenantId: spent.tenant_id, userId: spent.user_id });
      await t.query('UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1', [spent.id, next.id]);
      const deviceId = family.device_id || null;
      const accessToken = await insertSession(t, { tenantId: spent.tenant_id, userId: spent.user_id, kind: 'access', seconds: accessMinutes() * 60, familyId, deviceId, fresh: false });
      if (deviceId) await t.query('UPDATE auth_devices SET last_seen_at = now() WHERE person_id = $1 AND device_id = $2', [family.person_id, deviceId]);
      return { accessToken, refreshToken: next.token, accessExpiresInSeconds: accessMinutes() * 60, familyId };
    });
    if (outcome.refused) {
      log.warn('accounts.refresh_refused', { reason: outcome.refused, familyId: outcome.familyId ?? null });
      throw new ApiError('unauthorized');
    }
    return { accessToken: outcome.accessToken, accessExpiresInSeconds: outcome.accessExpiresInSeconds, refreshToken: outcome.refreshToken };
  }

  /** A family for a web console session: no refresh token, but revoking the device or the person ends it like the app's. */
  async function webFamily({ personId, deviceId = '' }) {
    return db().tx((t) => openFamily(t, { personId, deviceId }));
  }

  async function purge() {
    await db().query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day'`);
  }

  return { issueApp, rotate, webFamily, purge };
}

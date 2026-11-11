import crypto from 'node:crypto';
import { FRESH_MINUTES } from '../contracts/accounts.js';
import { tenantId } from '../tenancy.js';

export const hashSessionToken = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');
const hash = hashSessionToken;
const readable = (token) => typeof token === 'string' && token.length > 0 && token.length <= 100;

/**
 * Login sessions kept in the database, so every web server sees the same sessions and any of them
 * can be revoked. The client holds a random token; only its hash is stored. Each token works only as its own kind:
 *
 *   cookie  the web console (30 days, with a CSRF token)
 *   access  the owner app's access token (PRD 10.2): ACCESS_TOKEN_MINUTES, tied to a refresh family and a device
 *   bearer  the Phase 0 30-day token, accepted only while PASSWORD_LOGIN is on
 *
 * A session is looked up on every request, so revoking one, its family, or removing the person from the team counts
 * at once. `fresh_until` is how long the last re-auth lasts: a sign-in counts as one, so every new session starts fresh.
 */
export function sessionsRepo(db) {
  // A refresh family is about a person, not one business, so it is only reachable on the platform path.
  const platform = db.platform ?? db;

  return {
    /** Starts a session and returns its token. */
    async create(userId, days, kind = 'cookie', { fresh = true } = {}) {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO sessions (id, tenant_id, user_id, kind, expires_at, fresh_until)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), CASE WHEN $6 THEN now() + make_interval(mins => $7) END)`,
        [hash(token), tenantId(), Number(userId), kind, days, Boolean(fresh), FRESH_MINUTES],
      );
      return token;
    },
    /**
     * Starts an access session for the current business's `userId` and returns its token. `familyId` is the refresh
     * family it belongs to (token_families), `deviceId` the device. `fresh` is true after a sign-in or a re-auth and
     * false after a plain refresh, which proves only that the device still holds its token.
     */
    async createAccess(userId, { familyId, deviceId = null, minutes, fresh = false }) {
      if (!familyId) throw new Error('An access session belongs to a refresh family');
      if (!(Number(minutes) > 0)) throw new Error('An access session needs its lifetime in minutes');
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO sessions (id, tenant_id, user_id, kind, family_id, device_id, expires_at, fresh_until)
         VALUES ($1, $2, $3, 'access', $4, $5, now() + make_interval(secs => $6), CASE WHEN $7 THEN now() + make_interval(mins => $8) END)`,
        [hash(token), tenantId(), Number(userId), familyId, deviceId, Number(minutes) * 60, Boolean(fresh), FRESH_MINUTES],
      );
      return token;
    },
    /** A live cookie session in the current business: { userId, fresh, freshUntil }, or null. An account removed from the team has none. */
    async find(token) {
      if (!readable(token)) return null;
      const [row] = await db.query(
        `SELECT s.user_id, s.fresh_until, COALESCE(s.fresh_until > now(), false) AS fresh
         FROM sessions s JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
         WHERE s.id = $1 AND s.tenant_id = $2 AND s.kind = 'cookie' AND s.revoked_at IS NULL AND s.expires_at > now() AND u.removed_at IS NULL`,
        [hash(token), tenantId()],
      );
      return row ? { userId: row.user_id, fresh: row.fresh, freshUntil: row.fresh_until } : null;
    },
    /** The user id for a live cookie session in the current business, or null. */
    async userIdFor(token) {
      return (await this.find(token))?.userId ?? null;
    },
    /** A re-auth just succeeded: this session may use routes marked fresh for FRESH_MINUTES. Returns when that ends, or null for no such session. */
    async markFresh(token) {
      if (!readable(token)) return null;
      const [row] = await db.query(
        `UPDATE sessions SET fresh_until = now() + make_interval(mins => $3)
         WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL AND expires_at > now() RETURNING fresh_until`,
        [hash(token), tenantId(), FRESH_MINUTES],
      );
      return row?.fresh_until ?? null;
    },
    /** Ends this session. An app's access session takes its whole refresh family with it: signing out is signing out of the device. */
    async revoke(token) {
      const [row] = await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING family_id', [hash(token), tenantId()]);
      if (!row?.family_id) return;
      await platform.tx(async (t) => {
        await t.query(`UPDATE token_families SET revoked_at = now(), revoke_reason = 'signed_out' WHERE id = $1 AND revoked_at IS NULL`, [row.family_id]);
        await t.query('UPDATE sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
      });
    },
    /** Logs a user out everywhere, e.g. after a password change. */
    async revokeAllForUser(userId) {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL', [
        tenantId(), Number(userId),
      ]);
    },
  };
}

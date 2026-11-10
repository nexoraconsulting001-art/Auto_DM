import crypto from 'node:crypto';
import { tenantId } from '../tenancy.js';

export const hashSessionToken = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');
const hash = hashSessionToken;

/**
 * Login sessions kept in the database, so every web server sees the same sessions and any of them
 * can be revoked. The client holds a random token; only its hash is stored. A session is either a
 * cookie session (web) or a bearer session (API and mobile app), and each token works only as its own kind.
 */
export function sessionsRepo(db) {
  return {
    /** Starts a session and returns its token. */
    async create(userId, days, kind = 'cookie') {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO sessions (id, tenant_id, user_id, kind, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
        [hash(token), tenantId(), Number(userId), kind, days],
      );
      return token;
    },
    /** The user id for a live cookie session in the current business, or null. */
    async userIdFor(token) {
      if (!token || token.length > 100) return null;
      const [row] = await db.query(
        `SELECT user_id FROM sessions WHERE id = $1 AND tenant_id = $2 AND kind = 'cookie' AND revoked_at IS NULL AND expires_at > now()`,
        [hash(token), tenantId()],
      );
      return row?.user_id ?? null;
    },
    async revoke(token) {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND tenant_id = $2', [hash(token), tenantId()]);
    },
    /** Logs a user out everywhere, e.g. after a password change. */
    async revokeAllForUser(userId) {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL', [
        tenantId(), Number(userId),
      ]);
    },
  };
}

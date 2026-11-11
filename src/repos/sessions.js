import crypto from 'node:crypto';
import { FRESH_MINUTES } from '../contracts/accounts.js';
import { tenantId } from '../tenancy.js';

export const hashSessionToken = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');
const hash = hashSessionToken;
const readable = (token) => typeof token === 'string' && token.length > 0 && token.length <= 100;
const KINDS = ['cookie', 'bearer', 'access'];

/**
 * Writes one session row on `runner` (the db, or an open transaction) and returns its token. `tenantId` and `userId`
 * name the account it opens; `seconds` is how long it lives; `fresh` starts it fresh for FRESH_MINUTES. The repo below
 * uses it, and so does the refresh rotation in src/modules/accounts, which writes the next access session in the same
 * transaction that spends the refresh token.
 */
export async function insertSession(runner, { tenantId: business, userId, kind, seconds, familyId = null, deviceId = null, fresh = false }) {
  if (!KINDS.includes(kind)) throw new Error(`A session is one of ${KINDS.join(', ')}`);
  if (kind === 'access' && !familyId) throw new Error('An access session belongs to a refresh family');
  if (!(Number(seconds) > 0)) throw new Error('A session needs its lifetime');
  const token = crypto.randomBytes(32).toString('base64url');
  await runner.query(
    `INSERT INTO sessions (id, tenant_id, user_id, kind, family_id, device_id, expires_at, fresh_until)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::float), CASE WHEN $8::boolean THEN now() + make_interval(mins => $9::int) END)`,
    [hash(token), Number(business), Number(userId), kind, familyId, deviceId || null, Number(seconds), Boolean(fresh), FRESH_MINUTES],
  );
  return token;
}

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
 * A cookie session opened by a sign-in without a password belongs to a refresh family too, so revoking a device or a
 * person's families ends the console's session as well as the app's.
 */
export function sessionsRepo(db) {
  // A refresh family is about a person, not one business, so it is only reachable on the platform path.
  const platform = db.platform ?? db;

  return {
    /** Starts a session in the current business and returns its token. */
    async create(userId, days, kind = 'cookie', { fresh = true, familyId = null, deviceId = null } = {}) {
      return insertSession(db, { tenantId: tenantId(), userId, kind, seconds: Number(days) * 86_400, familyId, deviceId, fresh });
    },
    /**
     * Starts an access session for the current business's `userId` and returns its token. `familyId` is the refresh
     * family it belongs to (token_families), `deviceId` the device. `fresh` is true after a sign-in or a re-auth and
     * false after a plain refresh, which proves only that the device still holds its token.
     */
    async createAccess(userId, { familyId, deviceId = null, minutes, fresh = false }) {
      if (!familyId) throw new Error('An access session belongs to a refresh family');
      if (!(Number(minutes) > 0)) throw new Error('An access session needs its lifetime in minutes');
      return insertSession(db, { tenantId: tenantId(), userId, kind: 'access', seconds: Number(minutes) * 60, familyId, deviceId, fresh });
    },
    /**
     * A live cookie session in the current business: { userId, familyId, deviceId, fresh, freshUntil }, or null. An account
     * removed from the team has none, and neither has a session whose refresh family was revoked. Families are the
     * platform's, so the lookup runs there, held to the current business by its own WHERE.
     */
    async find(token) {
      if (!readable(token)) return null;
      const [row] = await platform.query(
        `SELECT s.user_id, s.family_id, s.device_id, s.fresh_until, COALESCE(s.fresh_until > now(), false) AS fresh
         FROM sessions s
         JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
         LEFT JOIN token_families f ON f.id = s.family_id
         WHERE s.id = $1 AND s.tenant_id = $2 AND s.kind = 'cookie' AND s.revoked_at IS NULL AND s.expires_at > now()
           AND u.removed_at IS NULL AND (s.family_id IS NULL OR f.revoked_at IS NULL)`,
        [hash(token), tenantId()],
      );
      return row ? { userId: row.user_id, familyId: row.family_id ?? null, deviceId: row.device_id ?? null, fresh: row.fresh, freshUntil: row.fresh_until } : null;
    },
    /** The user id for a live cookie session in the current business, or null. */
    async userIdFor(token) {
      return (await this.find(token))?.userId ?? null;
    },
    /**
     * A re-auth just succeeded: this session may use routes marked fresh for FRESH_MINUTES. Returns when that ends, or
     * null for no such session. Found by its token alone: a seller working in another business with X-Tenant-Id is
     * still in the session of the business they signed in to. A Phase 0 bearer token is never made fresh this way.
     */
    async markFresh(token) {
      if (!readable(token)) return null;
      const [row] = await platform.query(
        `UPDATE sessions SET fresh_until = now() + make_interval(mins => $2::int)
         WHERE id = $1 AND kind IN ('cookie', 'access') AND revoked_at IS NULL AND expires_at > now() RETURNING fresh_until`,
        [hash(token), FRESH_MINUTES],
      );
      return row?.fresh_until ?? null;
    },
    /** Ends this session. A session in a refresh family takes the whole family with it: signing out is signing out of the device. */
    async revoke(token) {
      if (!readable(token)) return;
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

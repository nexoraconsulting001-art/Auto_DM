import crypto from 'node:crypto';
import { checkPassword, hashPassword, validatePassword } from '../../repos/users.js';
import { hashSessionToken } from '../../repos/sessions.js';
import { ValidationError } from '../../util.js';

export const PLATFORM_ROLES = ['super_admin', 'support'];
const PUBLIC = 'id, email, name, role, created_at';
const cleanEmail = (email) => String(email ?? '').trim().toLowerCase();

/** Bhava's own team. Platform-level like the tenants repo: there is no current business here, by design. */
export function platformUsersRepo(handle) {
  const db = handle.platform ?? handle;
  return {
    async create({ email, password, role, name = '' }) {
      const address = cleanEmail(email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new ValidationError('Enter a valid email');
      if (!PLATFORM_ROLES.includes(role)) throw new ValidationError('Role must be super_admin or support');
      validatePassword(password);
      const rows = await db.query(
        `INSERT INTO platform_users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING RETURNING ${PUBLIC}`,
        [address, String(name).slice(0, 80), await hashPassword(password), role],
      );
      if (!rows.length) throw new ValidationError('A platform user with this email already exists');
      return rows[0];
    },
    /** Returns the user when email + password match, otherwise null. */
    async verify(email, password) {
      const [row] = await db.query('SELECT * FROM platform_users WHERE email = $1', [cleanEmail(email)]);
      if (!row || !(await checkPassword(password, row.password_hash))) return null;
      delete row.password_hash;
      return row;
    },
    async list() {
      return db.query(`SELECT ${PUBLIC} FROM platform_users ORDER BY created_at`);
    },

    async createSession(userId, days) {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO platform_sessions (id, platform_user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
        [hashSessionToken(token), Number(userId), days],
      );
      return token;
    },
    /** The platform user for a live session token, or null. */
    async userForSession(token) {
      if (!token || token.length > 100) return null;
      const [row] = await db.query(
        `SELECT u.id, u.email, u.name, u.role, u.created_at FROM platform_sessions s JOIN platform_users u ON u.id = s.platform_user_id
         WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [hashSessionToken(token)],
      );
      return row ?? null;
    },
    async revokeSession(token) {
      await db.query('UPDATE platform_sessions SET revoked_at = now() WHERE id = $1', [hashSessionToken(token)]);
    },
  };
}

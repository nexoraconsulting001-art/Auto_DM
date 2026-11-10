import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { ValidationError, normalizePhone } from '../util.js';
import { tenantId } from '../tenancy.js';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = await scrypt(String(password), salt, 32);
  return `scrypt$${salt}$${key.toString('base64url')}`;
}

export async function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(String(password ?? ''), salt, 32);
  const want = Buffer.from(hash, 'base64url');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

export function validatePassword(password) {
  if (String(password ?? '').length < 6) throw new ValidationError('Use a password of at least 6 characters');
}

const PUBLIC = 'id, name, phone, email, role, address, created_at';
export const BUSINESS_ROLES = ['owner', 'staff', 'customer'];

export function usersRepo(db) {
  return {
    async get(id) {
      const [row] = await db.query(`SELECT ${PUBLIC} FROM users WHERE tenant_id = $1 AND id = $2`, [tenantId(), Number(id) || 0]);
      return row || null;
    },
    async findByPhone(phone) {
      const p = normalizePhone(phone);
      if (!p) return null;
      const [row] = await db.query(`SELECT ${PUBLIC} FROM users WHERE tenant_id = $1 AND phone = $2`, [tenantId(), p]);
      return row || null;
    },
    async create({ name, phone, email = '', password, role = 'customer' }) {
      const n = String(name ?? '').trim();
      if (n.length < 2) throw new ValidationError('Enter your name');
      const p = normalizePhone(phone);
      if (!p) throw new ValidationError('Enter a 10-digit Indian mobile number');
      const e = String(email ?? '').trim();
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ValidationError('Enter a valid email, or leave it empty');
      validatePassword(password);
      const [exists] = await db.query('SELECT 1 FROM users WHERE tenant_id = $1 AND phone = $2', [tenantId(), p]);
      if (exists) throw new ValidationError('An account with this number already exists. Log in instead.');
      const [row] = await db.query(
        `INSERT INTO users (tenant_id, name, phone, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PUBLIC}`,
        [tenantId(), n.slice(0, 80), p, e.slice(0, 120), await hashPassword(password), BUSINESS_ROLES.includes(role) ? role : 'customer'],
      );
      return row;
    },
    /** Returns the user when phone + password match, otherwise null. */
    async verify(phone, password) {
      const p = normalizePhone(phone);
      if (!p) return null;
      const [row] = await db.query('SELECT * FROM users WHERE tenant_id = $1 AND phone = $2', [tenantId(), p]);
      if (!row || !(await checkPassword(password, row.password_hash))) return null;
      delete row.password_hash;
      return row;
    },
    async setPassword(id, password) {
      validatePassword(password);
      const hashed = await hashPassword(password);
      await db.tx(async (t) => {
        await t.query('UPDATE users SET password_hash = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(id), hashed]);
        // A new password logs the account out everywhere.
        await t.query('UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL', [
          tenantId(), Number(id),
        ]);
      });
    },
    /** Only the server command (scripts/role.js) and ensureOwner change roles; signup always makes customers. */
    async setRole(id, role) {
      if (!BUSINESS_ROLES.includes(role)) throw new ValidationError('Role must be owner, staff or customer');
      await db.query('UPDATE users SET role = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(id), role]);
      return this.get(id);
    },
    /** The business's own people: owners and staff. */
    async listTeam() {
      return db.query(`SELECT ${PUBLIC} FROM users WHERE tenant_id = $1 AND role IN ('owner', 'staff') ORDER BY created_at`, [tenantId()]);
    },
    async saveAddress(id, address) {
      await db.query('UPDATE users SET address = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(id), JSON.stringify(address)]);
    },
    /**
     * Makes sure the owner account from .env exists and has the owner role.
     * An existing account with that phone is promoted; its password is reset to the .env one.
     */
    async ensureOwner({ phone, password, name = 'Store owner' }) {
      const p = normalizePhone(phone);
      if (!p || !password) return null;
      const [row] = await db.query('SELECT id FROM users WHERE tenant_id = $1 AND phone = $2', [tenantId(), p]);
      if (row) {
        await db.query("UPDATE users SET role = 'owner', password_hash = $3 WHERE tenant_id = $1 AND id = $2", [tenantId(), row.id, await hashPassword(password)]);
        return this.get(row.id);
      }
      return this.create({ name, phone: p, password, role: 'owner' });
    },
    async listCustomers({ search = '' } = {}) {
      return db.query(
        `SELECT u.id, u.name, u.phone, u.email, u.role, u.created_at,
           (SELECT count(*)::int FROM orders o WHERE o.tenant_id = u.tenant_id AND o.user_id = u.id) AS order_count,
           (SELECT coalesce(sum(total_paise), 0)::bigint FROM orders o WHERE o.tenant_id = u.tenant_id AND o.user_id = u.id AND o.status <> 'cancelled') AS spent
         FROM users u
         WHERE u.tenant_id = $2 AND ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.phone LIKE '%' || $1 || '%')
         ORDER BY u.role = 'owner' DESC, u.created_at DESC LIMIT 500`,
        [search.trim(), tenantId()],
      );
    },
  };
}

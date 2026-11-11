import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { PERMISSIONS, SELLER_ROLES } from '../contracts/api/access.js';
import { reportError } from '../platform/log.js';
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

// person_id says which person has proved this account is theirs (null until someone has): sign-in, devices and re-auth follow it.
const PUBLIC = 'id, name, phone, email, role, permissions, address, created_at, person_id';
export const BUSINESS_ROLES = ['owner', 'manager', 'staff', 'customer'];
const MAX_LINKED_BUSINESSES = 20;

export function usersRepo(db) {
  // Memberships are about one person across businesses, so these lookups can't be inside one business's fence.
  const platform = db.platform ?? db;

  /**
   * Sign-in with a password proves this account is yours. The same phone on an account at another business proves
   * nothing, because owners type in staff phone numbers unverified. So the two are linked only when this password
   * also opens that account. This runs only while PASSWORD_LOGIN is on. Without passwords (Phase 5) the proof is a
   * verified identity: src/modules/accounts writes the same pair of rows when a person's verified phone equals a seller
   * account's phone in another business, and never for a phone nobody has verified.
   */
  async function linkMyOtherBusinesses(me, password) {
    const others = await platform.query(
      `SELECT u.tenant_id, u.id, u.password_hash FROM users u
       WHERE u.phone = $1 AND u.tenant_id <> $2 AND u.role = ANY($3) AND u.removed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = $2 AND m.user_id = $4 AND m.member_tenant_id = u.tenant_id)
       LIMIT ${MAX_LINKED_BUSINESSES}`,
      [me.phone, me.tenant_id, SELLER_ROLES, me.id],
    );
    for (const other of others) {
      if (!(await checkPassword(password, other.password_hash))) continue;
      await platform.query(
        `INSERT INTO memberships (tenant_id, user_id, member_tenant_id, member_user_id) VALUES ($1, $2, $3, $4), ($3, $4, $1, $2)
         ON CONFLICT DO NOTHING`,
        [me.tenant_id, me.id, other.tenant_id, other.id],
      );
    }
  }

  return {
    async get(id) {
      // An account removed from the team (removed_at) is nobody: its row stays only for the audit trail.
      const [row] = await db.query(`SELECT ${PUBLIC} FROM users WHERE tenant_id = $1 AND id = $2 AND removed_at IS NULL`, [tenantId(), Number(id) || 0]);
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
      const [row] = await db.query('SELECT * FROM users WHERE tenant_id = $1 AND phone = $2 AND removed_at IS NULL', [tenantId(), p]);
      if (!row || !(await checkPassword(password, row.password_hash))) return null;
      delete row.password_hash;
      if (SELLER_ROLES.includes(row.role)) {
        // A sign-in must not fail because a business switcher couldn't be updated.
        await linkMyOtherBusinesses(row, password).catch((err) => reportError(err, { msg: 'users.link_failed', userId: row.id }));
      }
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
      if (!BUSINESS_ROLES.includes(role)) throw new ValidationError('Role must be manager, owner, staff or customer');
      await db.query(
        `UPDATE users SET role = $3, permissions = CASE WHEN $3 = 'staff' THEN permissions ELSE '{}' END WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), Number(id), role],
      );
      return this.get(id);
    },
    /** What a staff member may use: replaces the whole list. Owners and managers don't need one. */
    async setPermissions(id, permissions) {
      const wanted = [...new Set(Array.isArray(permissions) ? permissions.map(String) : [])];
      const unknown = wanted.find((p) => !PERMISSIONS.includes(p));
      if (unknown) throw new ValidationError(`Unknown permission “${unknown}”`);
      const [row] = await db.query(
        `UPDATE users SET permissions = $3 WHERE tenant_id = $1 AND id = $2 AND role = 'staff' RETURNING ${PUBLIC}`,
        [tenantId(), Number(id), wanted],
      );
      if (!row) throw new ValidationError('Only a staff member can be given permissions');
      return row;
    },
    /** The seller's account at another business, or null when they aren't a member there. Read on every call, so a removal counts at once. */
    async memberOf(user, otherTenantId) {
      if (!SELLER_ROLES.includes(user.role)) return null;
      const [row] = await platform.query(
        `SELECT t.id, t.slug, t.name, t.status, t.plan, t.created_at, t.account_type, u.id AS member_user_id
         FROM memberships m
         JOIN users u ON u.tenant_id = m.member_tenant_id AND u.id = m.member_user_id
         JOIN tenants t ON t.id = m.member_tenant_id
         WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.member_tenant_id = $3 AND u.role = ANY($4) AND u.removed_at IS NULL`,
        [tenantId(), Number(user.id), Number(otherTenantId), SELLER_ROLES],
      );
      if (!row) return null;
      const { member_user_id: userId, ...tenant } = row;
      return { tenant, userId };
    },
    /** Every business this seller can switch to, this one first, for the business switcher. Shoppers have none. */
    async businesses(user) {
      if (!SELLER_ROLES.includes(user.role)) return [];
      return platform.query(
        `SELECT t.id, t.slug, t.name, u.role, COALESCE(k.logo_url, '') AS logo_url, t.id = $1 AS current
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
         LEFT JOIN brand_kits k ON k.tenant_id = t.id
         WHERE u.role = ANY($3) AND u.removed_at IS NULL AND ((u.tenant_id = $1 AND u.id = $2) OR EXISTS (
           SELECT 1 FROM memberships m WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.member_tenant_id = u.tenant_id AND m.member_user_id = u.id))
         ORDER BY current DESC, t.name`,
        [tenantId(), Number(user.id), SELLER_ROLES],
      );
    },
    /** The business's own people: owners, managers and staff. */
    async listTeam() {
      return db.query(`SELECT ${PUBLIC} FROM users WHERE tenant_id = $1 AND role = ANY($2) AND removed_at IS NULL ORDER BY created_at`, [tenantId(), SELLER_ROLES]);
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

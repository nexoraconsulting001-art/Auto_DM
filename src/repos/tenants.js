import { ValidationError, slugify } from '../util.js';
import { normalizeHost } from '../tenancy.js';
import { RELEASED_BY_OWNER, isLiveAccountClash } from './connections.js';
import { hashSessionToken, operatorRef } from './sessions.js';

const COLS = 'id, slug, name, status, plan, created_at';
/** The verified primary domain goes with the business, because the links a DM carries are built on it. */
export const WITH_PRIMARY = `t.id, t.slug, t.name, t.status, t.plan, t.created_at, t.account_type, t.signup_held,
  (SELECT p.domain FROM tenant_domains p WHERE p.tenant_id = t.id AND p.is_primary AND p.status = 'verified') AS primary_domain`;

/** Addresses Bhava keeps for itself; no business can take one. */
export const RESERVED_SLUGS = new Set(['bhava', 'www', 'app', 'api', 'admin']);

/**
 * Platform-level repo: businesses, their domains and Instagram accounts. It is the only repo that
 * works without a current business, so only platform code (domain lookup, webhook routing,
 * onboarding, the Platform Console) uses it.
 */
export function tenantsRepo(handle) {
  const db = handle.platform ?? handle; // about no single business, so never inside one's fence
  return {
    async create({ slug, name, plan = 'free' }) {
      const s = slugify(slug || name).slice(0, 40).replace(/-+$/, '');
      const n = String(name ?? '').trim();
      if (!n) throw new ValidationError('Business name is required');
      if (!s) throw new ValidationError('Add a business name with letters or numbers');
      if (RESERVED_SLUGS.has(s)) throw new ValidationError(`The address name “${s}” is reserved. Choose another one.`);
      const [taken] = await db.query('SELECT 1 FROM tenants WHERE slug = $1', [s]);
      if (taken) throw new ValidationError(`The address name “${s}” is already used by another business`);
      const [row] = await db.query(`INSERT INTO tenants (slug, name, plan) VALUES ($1, $2, $3) RETURNING ${COLS}`, [s, n.slice(0, 80), plan]);
      return row;
    },
    /** Returns the business with this slug, creating it when missing. */
    async ensure({ slug, name }) {
      return (await this.getBySlug(slug)) || this.create({ slug, name: name || slug });
    },
    async get(id) {
      const [row] = await db.query(`SELECT ${WITH_PRIMARY} FROM tenants t WHERE t.id = $1`, [Number(id) || 0]);
      return row || null;
    },
    async getBySlug(slug) {
      const [row] = await db.query(`SELECT ${WITH_PRIMARY} FROM tenants t WHERE t.slug = $1`, [String(slug)]);
      return row || null;
    },
    async getByDomain(host) {
      const [row] = await db.query(
        `SELECT ${WITH_PRIMARY} FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
         WHERE d.domain = $1 AND d.status = 'verified'`,
        [normalizeHost(host)],
      );
      return row || null;
    },
    async addDomain(tenantId, host) {
      const domain = normalizeHost(host);
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        throw new ValidationError(`“${host}” is not a valid domain`);
      }
      // Added by hand, so verified at once (the column default). One verified row per name (migration 940): a name another business
      // has verified is refused, and a name this business already has is left as it is.
      const [held] = await db.query(`SELECT tenant_id FROM tenant_domains WHERE domain = $1 AND (status = 'verified' OR tenant_id = $2) ORDER BY (tenant_id = $2) LIMIT 1`, [domain, Number(tenantId)]);
      if (held && held.tenant_id !== Number(tenantId)) throw new ValidationError(`${domain} already belongs to another business`);
      if (held) return domain;
      try {
        await db.query('INSERT INTO tenant_domains (domain, tenant_id) VALUES ($1, $2)', [domain, Number(tenantId)]);
      } catch (err) {
        if (err?.code === '23505') throw new ValidationError(`${domain} already belongs to another business`);
        throw err;
      }
      return domain;
    },
    /**
     * A live session by its token alone, of one of `kinds` ('access', 'bearer', 'cookie'), or null. Runs before any business
     * is known, so it lives here: the session names its business. Read on every request, so each of these ends it at once:
     * the session or its refresh family revoked, the account removed from the team, the token expired.
     * Returns { tenant, userId, kind, familyId, deviceId, fresh, freshUntil }.
     */
    async findSession(token, kinds) {
      if (typeof token !== 'string' || !token || token.length > 100 || !kinds?.length) return null;
      const [row] = await db.query(
        `SELECT s.user_id, s.kind AS session_kind, s.family_id, s.device_id, s.fresh_until, COALESCE(s.fresh_until > now(), false) AS fresh, s.impersonation_id, s.service_session_id, ${WITH_PRIMARY}
         FROM sessions s
         JOIN tenants t ON t.id = s.tenant_id
         JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
         LEFT JOIN token_families f ON f.id = s.family_id
         WHERE s.id = $1 AND s.kind = ANY($2) AND s.revoked_at IS NULL AND s.expires_at > now()
           AND u.removed_at IS NULL AND (s.family_id IS NULL OR f.revoked_at IS NULL)`,
        [hashSessionToken(token), kinds],
      );
      if (!row) return null;
      const { user_id: userId, session_kind: kind, family_id: familyId, device_id: deviceId, fresh, fresh_until: freshUntil, impersonation_id, service_session_id, ...tenant } = row;
      return { tenant, userId, kind, familyId, deviceId, fresh, freshUntil, ...operatorRef({ impersonation_id, service_session_id }) };
    },
    /** A live Phase 0 bearer session's business and user id, or null. */
    async findBearerSession(token) {
      const session = await this.findSession(token, ['bearer']);
      return session ? { tenant: session.tenant, userId: session.userId } : null;
    },
    /**
     * The business that holds this Instagram account, or null. Each business keeps its own row (tenancy-1) and at most one is
     * live; a row its owner released by disconnecting is only chosen when no business holds the account now.
     */
    async getByIgAccount(igUserId) {
      const [row] = await db.query(
        `SELECT ${WITH_PRIMARY} FROM ig_accounts a JOIN tenants t ON t.id = a.tenant_id
         WHERE a.ig_user_id = $1
         ORDER BY (a.access_token_enc = '' AND a.status_reason = $2), a.status_changed_at DESC NULLS LAST LIMIT 1`,
        [String(igUserId), RELEASED_BY_OWNER],
      );
      return row || null;
    },
    /** Puts an account on a business. Refused while another business holds it live; a row another business released stays theirs. */
    async linkIgAccount(tenantId, igUserId, username = '') {
      try {
        await db.query(
          `INSERT INTO ig_accounts (ig_user_id, tenant_id, username) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, ig_user_id) DO UPDATE SET username = EXCLUDED.username`,
          [String(igUserId), Number(tenantId), String(username)],
        );
      } catch (err) {
        if (isLiveAccountClash(err)) throw new ValidationError('This Instagram account is already connected to another business');
        throw err;
      }
    },
    async list() {
      return db.query(`SELECT ${COLS} FROM tenants ORDER BY created_at`);
    },
  };
}

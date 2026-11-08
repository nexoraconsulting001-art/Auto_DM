import { ValidationError, slugify } from '../util.js';
import { normalizeHost } from '../tenancy.js';

const COLS = 'id, slug, name, status, plan, created_at';

/**
 * Platform-level repo: businesses, their domains and Instagram accounts. It is the only repo that
 * works without a current business, so only platform code (domain lookup, webhook routing,
 * onboarding, the Platform Console) uses it.
 */
export function tenantsRepo(db) {
  return {
    async create({ slug, name, plan = 'free' }) {
      const s = slugify(slug || name).slice(0, 40).replace(/-+$/, '');
      const n = String(name ?? '').trim();
      if (!n) throw new ValidationError('Business name is required');
      if (!s) throw new ValidationError('Add a business name with letters or numbers');
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
      const [row] = await db.query(`SELECT ${COLS} FROM tenants WHERE id = $1`, [Number(id) || 0]);
      return row || null;
    },
    async getBySlug(slug) {
      const [row] = await db.query(`SELECT ${COLS} FROM tenants WHERE slug = $1`, [String(slug)]);
      return row || null;
    },
    async getByDomain(host) {
      const [row] = await db.query(
        `SELECT t.id, t.slug, t.name, t.status, t.plan, t.created_at FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
         WHERE d.domain = $1`,
        [normalizeHost(host)],
      );
      return row || null;
    },
    async addDomain(tenantId, host) {
      const domain = normalizeHost(host);
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        throw new ValidationError(`“${host}” is not a valid domain`);
      }
      const [row] = await db.query(
        `INSERT INTO tenant_domains (domain, tenant_id) VALUES ($1, $2)
         ON CONFLICT (domain) DO UPDATE SET tenant_id = tenant_domains.tenant_id RETURNING tenant_id`,
        [domain, Number(tenantId)],
      );
      if (row.tenant_id !== Number(tenantId)) throw new ValidationError(`${domain} already belongs to another business`);
      return domain;
    },
    /** The business that owns this Instagram account, or null. */
    async getByIgAccount(igUserId) {
      const [row] = await db.query(
        `SELECT t.id, t.slug, t.name, t.status, t.plan, t.created_at FROM ig_accounts a JOIN tenants t ON t.id = a.tenant_id
         WHERE a.ig_user_id = $1`,
        [String(igUserId)],
      );
      return row || null;
    },
    async linkIgAccount(tenantId, igUserId, username = '') {
      const [row] = await db.query(
        `INSERT INTO ig_accounts (ig_user_id, tenant_id, username) VALUES ($1, $2, $3)
         ON CONFLICT (ig_user_id) DO UPDATE SET username = EXCLUDED.username
         WHERE ig_accounts.tenant_id = EXCLUDED.tenant_id RETURNING tenant_id`,
        [String(igUserId), Number(tenantId), String(username)],
      );
      if (!row) throw new ValidationError('This Instagram account is already connected to another business');
    },
    async list() {
      return db.query(`SELECT ${COLS} FROM tenants ORDER BY created_at`);
    },
  };
}

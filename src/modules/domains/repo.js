import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';

const COLS = `domain, status, verify_token, is_primary, verified_at, last_checked_at, created_at, check_until, redirect_to, redirect_until,
  (status = 'pending' AND now() >= LEAST(COALESCE(check_until, 'infinity'::timestamptz), created_at + interval '72 hours')) AS expired`;

/**
 * Custom domains. A domain is one row in tenant_domains, so two businesses can never both hold it. Everything is about the current
 * business and runs inside its fence, except what must look across businesses: claiming a name and routing a host.
 */
export function domainsRepo(handle) {
  const db = handle;
  const platform = handle.platform ?? handle;
  const get = async (domain) => (await db.query(`SELECT ${COLS} FROM tenant_domains WHERE tenant_id = $1 AND domain = $2`, [tenantId(), domain]))[0] ?? null;

  return {
    get,

    async list() {
      return db.query(`SELECT ${COLS} FROM tenant_domains WHERE tenant_id = $1 ORDER BY domain`, [tenantId()]);
    },

    async countOthers(domain) {
      const [{ n }] = await db.query('SELECT count(*)::int AS n FROM tenant_domains WHERE tenant_id = $1 AND domain <> $2', [tenantId(), domain]);
      return n;
    },

    /**
     * Starts verification, restarting the 72 hours if it had stopped. Until a domain is verified the latest claim holds the row: no one can
     * squat on a name by adding it first, and only the business whose TXT token is really in DNS can win. A verified domain is
     * exclusive unless its business is closed. Returns false when the name is held.
     */
    async claim(domain, token, audit) {
      return platform.tx(async (t) => {
        const claimed = await t.query(
          `INSERT INTO tenant_domains AS d (domain, tenant_id, status, verify_token, check_until)
           VALUES ($1, $2, 'pending', $3, now() + interval '72 hours')
           ON CONFLICT (domain) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, status = 'pending', verify_token = EXCLUDED.verify_token,
             created_at = now(), check_until = EXCLUDED.check_until, verified_at = NULL, last_checked_at = NULL,
             is_primary = false, redirect_to = '', redirect_until = NULL
           WHERE d.status <> 'verified' OR (SELECT b.status FROM tenants b WHERE b.id = d.tenant_id) = 'closed'
           RETURNING domain`,
          [domain, tenantId(), token],
        );
        if (!claimed.length) return false;
        await writeAudit(t, audit);
        return true;
      });
    },

    async recordCheck(domain, verified) {
      await db.query(
        `UPDATE tenant_domains SET last_checked_at = now(), status = CASE WHEN $3 THEN 'verified' ELSE status END, verified_at = CASE WHEN $3 THEN now() ELSE verified_at END
         WHERE tenant_id = $1 AND domain = $2 AND status = 'pending'`,
        [tenantId(), domain, verified],
      );
      return get(domain);
    },

    async markStopped(domain) {
      await db.query(`UPDATE tenant_domains SET status = 'stopped', last_checked_at = now() WHERE tenant_id = $1 AND domain = $2 AND status = 'pending'`, [tenantId(), domain]);
      return get(domain);
    },

    /**
     * Makes `domain` the primary, or with `domain` empty leaves `moveTo` (the fallback host) as the address links use. The old primary answers
     * with a 301 for 12 months and anything that pointed at it moves on, so there are no chains.
     * Returns { result: 'ok', hosts }, hosts being every host whose routing changed, or { result: 'not_found' | 'not_verified' }.
     */
    async setPrimary(domain, moveTo, audit) {
      const tenant = tenantId();
      return db.tx(async (t) => {
        const rows = await t.query('SELECT domain, status, is_primary FROM tenant_domains WHERE tenant_id = $1 ORDER BY domain FOR UPDATE', [tenant]);
        const target = rows.find((r) => r.domain === domain);
        if (domain && !target) return { result: 'not_found' };
        if (domain && target.status !== 'verified') return { result: 'not_verified' };
        const old = rows.find((r) => r.is_primary);
        if (domain ? old?.domain === domain : !old) return { result: 'ok', hosts: [] };

        if (old) {
          await t.query(
            `UPDATE tenant_domains SET is_primary = false, redirect_to = $3, redirect_until = now() + interval '12 months' WHERE tenant_id = $1 AND domain = $2`,
            [tenant, old.domain, moveTo],
          );
        }
        await t.query(`UPDATE tenant_domains SET redirect_to = $2 WHERE tenant_id = $1 AND redirect_to <> '' AND redirect_to <> $2`, [tenant, moveTo]);
        if (domain) await t.query(`UPDATE tenant_domains SET is_primary = true, redirect_to = '', redirect_until = NULL WHERE tenant_id = $1 AND domain = $2`, [tenant, domain]);
        await writeAudit(t, audit(old?.domain ?? ''));
        return { result: 'ok', hosts: rows.map((r) => r.domain) };
      });
    },

    /** Removes a domain. Redirects only ever point at the primary, which can't be removed. Returns { result }: 'ok', 'not_found' or 'primary'. */
    async remove(domain, audit) {
      const tenant = tenantId();
      return db.tx(async (t) => {
        const [target] = await t.query('SELECT is_primary FROM tenant_domains WHERE tenant_id = $1 AND domain = $2 FOR UPDATE', [tenant, domain]);
        if (!target) return { result: 'not_found' };
        if (target.is_primary) return { result: 'primary' };
        await t.query('DELETE FROM tenant_domains WHERE tenant_id = $1 AND domain = $2', [tenant, domain]);
        await writeAudit(t, audit);
        return { result: 'ok' };
      });
    },

    // ---- Across businesses: routing a host, and the scheduled check. ----

    /** The facts that decide whether a host redirects. Null when it isn't a verified custom domain. */
    async routeOf(host) {
      const [row] = await platform.query(
        `SELECT d.is_primary, d.redirect_to, COALESCE(d.redirect_until > now(), false) AS redirect_live, p.domain AS primary_domain
         FROM tenant_domains d LEFT JOIN tenant_domains p ON p.tenant_id = d.tenant_id AND p.is_primary
         WHERE d.domain = $1 AND d.status = 'verified'`,
        [host],
      );
      return row ?? null;
    },

    async heldByAnother(domain) {
      const rows = await platform.query('SELECT 1 FROM tenant_domains WHERE domain = $1 AND tenant_id <> $2', [domain, tenantId()]);
      return rows.length > 0;
    },

    async servesCustomDomain(host) {
      const rows = await platform.query(
        `SELECT 1 FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id WHERE d.domain = $1 AND d.status = 'verified' AND t.status <> 'closed'`,
        [host],
      );
      return rows.length > 0;
    },

    async servesFallback(slug) {
      return (await platform.query(`SELECT 1 FROM tenants WHERE slug = $1 AND status <> 'closed'`, [slug])).length > 0;
    },

    /** Pending domains whose 5-minute check has come round, with the business each one belongs to. */
    dueForCheck(limit = 500) {
      return platform.query(
        `SELECT d.domain, t.id, t.slug, t.name, t.status, t.plan, t.created_at FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
         WHERE d.status = 'pending' AND t.status <> 'closed' AND (d.last_checked_at IS NULL OR d.last_checked_at <= now() - interval '4 minutes')
         ORDER BY d.last_checked_at NULLS FIRST LIMIT $1`,
        [limit],
      );
    },
  };
}

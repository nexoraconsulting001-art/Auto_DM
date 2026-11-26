import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';

const COLS = `domain, status, verify_token, is_primary, verified_at, last_checked_at, created_at, check_until, redirect_to, redirect_until,
  (status = 'pending' AND now() >= LEAST(COALESCE(check_until, 'infinity'::timestamptz), created_at + interval '72 hours')) AS expired`;

/**
 * Custom domains. Each business has its own row for a name it claims, and only one row per name can be verified, so two businesses
 * can never both hold it (migration 940). Everything is about the current
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
     * Starts verification, restarting the 72 hours if it had stopped. Each business keeps its own claim until the name is verified, so
     * no one can squat on a name by adding it first, and no later claim can take it from a business whose TXT token is already in
     * DNS (atk-tenancy-2): whichever claimant's token is really there verifies. A verified domain is exclusive unless its business
     * is closed. Returns false when the name is held, by another business or already by this one.
     */
    async claim(domain, token, audit) {
      return platform.tx(async (t) => {
        const claimed = await t.query(
          `INSERT INTO tenant_domains AS d (domain, tenant_id, status, verify_token, check_until)
           SELECT $1, $2, 'pending', $3, now() + interval '72 hours'
           WHERE NOT EXISTS (SELECT 1 FROM tenant_domains v JOIN tenants b ON b.id = v.tenant_id
                             WHERE v.domain = $1 AND v.tenant_id <> $2 AND v.status = 'verified' AND b.status <> 'closed')
           ON CONFLICT (tenant_id, domain) DO UPDATE SET status = 'pending', verify_token = EXCLUDED.verify_token,
             created_at = now(), check_until = EXCLUDED.check_until, verified_at = NULL, last_checked_at = NULL,
             is_primary = false, redirect_to = '', redirect_until = NULL
           WHERE d.status <> 'verified'
           RETURNING domain`,
          [domain, tenantId(), token],
        );
        if (!claimed.length) return false;
        await writeAudit(t, audit);
        return true;
      });
    },

    /**
     * Records a check of this business's pending claim. When its proof was found the claim becomes the one verified row for the
     * name: every other business's pending claim on it is dropped, and a closed business's verified row gives way. While another
     * open business holds the name verified, this claim stays pending.
     */
    async recordCheck(domain, verified) {
      const tenant = tenantId();
      if (verified) {
        const won = await platform.tx(async (t) => {
          const [mine] = await t.query(`SELECT 1 FROM tenant_domains WHERE tenant_id = $1 AND domain = $2 AND status = 'pending' FOR UPDATE`, [tenant, domain]);
          if (!mine) return false;
          const [held] = await t.query(
            `SELECT 1 FROM tenant_domains v JOIN tenants b ON b.id = v.tenant_id
             WHERE v.domain = $1 AND v.tenant_id <> $2 AND v.status = 'verified' AND b.status <> 'closed'`,
            [domain, tenant],
          );
          if (held) return false;
          await t.query('DELETE FROM tenant_domains WHERE domain = $1 AND tenant_id <> $2', [domain, tenant]);
          await t.query(`UPDATE tenant_domains SET last_checked_at = now(), status = 'verified', verified_at = now() WHERE tenant_id = $1 AND domain = $2`, [tenant, domain]);
          return true;
        }).catch((err) => {
          if (err?.code === '23505') return false; // another business's claim was verified at the same moment
          throw err;
        });
        if (won) return get(domain);
      }
      await db.query(`UPDATE tenant_domains SET last_checked_at = now() WHERE tenant_id = $1 AND domain = $2 AND status = 'pending'`, [tenant, domain]);
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
      const rows = await platform.query(`SELECT 1 FROM tenant_domains WHERE domain = $1 AND tenant_id <> $2 AND status = 'verified'`, [domain, tenantId()]);
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

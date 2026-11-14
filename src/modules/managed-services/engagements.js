import { serviceFeature } from '../../contracts/services.js';
import { tenantId } from '../../tenancy.js';

/**
 * Which services the current business has, kept in step with what it pays for (the entitlement `service.<name>`, which
 * billing turns on and off). service_engagements is written by the platform only (business code may change `mode` and
 * nothing else), so these writes go through db.platform with the business id named explicitly.
 *
 *   sync(service)        the engagement as the entitlement says it is today: a service paid for again starts a new period
 *                        (active_from moves, active_to clears), one no longer paid for ends now. -> { active, row }
 *   setMode(service, m)  the seller's choice of direct or approve-first
 */
export function engagementsFor(ctx) {
  const db = ctx.db;
  const platform = db.platform ?? db;

  async function current(service) {
    const [found] = await db.query('SELECT * FROM service_engagements WHERE tenant_id = $1 AND service = $2', [tenantId(), service]);
    return found ?? null;
  }

  const isActive = (r) => Boolean(r) && new Date(r.active_from) <= new Date() && (r.active_to === null || new Date(r.active_to) > new Date());

  return {
    current,
    isActive,

    async entitled(service) {
      return Boolean(await ctx.repos?.entitlements?.can(serviceFeature(service)));
    },

    async sync(service) {
      const on = await this.entitled(service);
      if (on) {
        const [r] = await platform.query(
          `INSERT INTO service_engagements AS e (tenant_id, service) VALUES ($1, $2)
           ON CONFLICT (tenant_id, service) DO UPDATE SET
             active_from = CASE WHEN e.active_to IS NOT NULL AND e.active_to <= now() THEN now() ELSE e.active_from END,
             active_to = CASE WHEN e.active_to IS NOT NULL AND e.active_to <= now() THEN NULL ELSE e.active_to END,
             updated_at = CASE WHEN e.active_to IS NOT NULL AND e.active_to <= now() THEN now() ELSE e.updated_at END
           RETURNING *`,
          [tenantId(), service],
        );
        return { active: isActive(r), row: r };
      }
      const [r] = await platform.query(
        `UPDATE service_engagements SET active_to = greatest(now(), active_from), updated_at = now()
         WHERE tenant_id = $1 AND service = $2 AND (active_to IS NULL OR active_to > now()) RETURNING *`,
        [tenantId(), service],
      );
      return { active: false, row: r ?? (await current(service)) };
    },

    async setMode(service, mode) {
      const [r] = await platform.query(
        `INSERT INTO service_engagements AS e (tenant_id, service, mode) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, service) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now() RETURNING *`,
        [tenantId(), service, mode],
      );
      return r;
    },
  };
}

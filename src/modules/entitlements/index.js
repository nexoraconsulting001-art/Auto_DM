import { tenantId } from '../../tenancy.js';

/**
 * What the current business may use: its plan's rows in plan_features, with any row in tenant_features
 * replacing the plan's row for that feature (add-ons, extra limits, or switching something off).
 * Nothing is cached, so a plan change takes effect on the next call.
 *
 *   await repos.entitlements.can('store.checkout')    true or false
 *   await repos.entitlements.limit('dms.monthly')     a number, Infinity for no limit, 0 when not included
 *
 * An unknown feature name is simply not included.
 */
export function entitlementsRepo(db) {
  async function lookup(feature) {
    const [row] = await db.query(
      `SELECT CASE WHEN o.feature IS NOT NULL THEN o.enabled ELSE f.feature IS NOT NULL END AS enabled,
              CASE WHEN o.feature IS NOT NULL THEN o.limit_value ELSE f.limit_value END AS limit_value
       FROM tenants t
       LEFT JOIN plan_features f ON f.plan_code = t.plan AND f.feature = $2
       LEFT JOIN tenant_features o ON o.tenant_id = t.id AND o.feature = $2
       WHERE t.id = $1`,
      [tenantId(), String(feature)],
    );
    return row ?? { enabled: false, limit_value: null };
  }

  return {
    async can(feature) {
      return (await lookup(feature)).enabled;
    },
    async limit(feature) {
      const { enabled, limit_value: limit } = await lookup(feature);
      if (!enabled) return 0;
      return limit ?? Infinity;
    },
    /** Overrides the plan for this business. `limit` null means no limit. */
    async setOverride(feature, { enabled = true, limit = null } = {}) {
      await db.query(
        `INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled, limit_value = EXCLUDED.limit_value`,
        [tenantId(), String(feature), Boolean(enabled), limit],
      );
    },
    async clearOverride(feature) {
      await db.query('DELETE FROM tenant_features WHERE tenant_id = $1 AND feature = $2', [tenantId(), String(feature)]);
    },
  };
}

export const entitlements = {
  name: 'entitlements',
  repos: (db) => ({ entitlements: entitlementsRepo(db) }),
};

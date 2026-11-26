import { BILLING_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { APP_ENTITLEMENTS } from '../../contracts/apps.js';
import { tenantId } from '../../tenancy.js';
import { automationLimitHook } from './plan-changes.js';
import { flagsRepo, flagRoutes } from './flags.js';

export { flagsRepo } from './flags.js';

/**
 * What the current business may use: its plan's rows in plan_features, with any row in tenant_features
 * replacing the plan's row for that feature (add-ons, extra limits, or switching something off).
 * Nothing is cached, so a plan change takes effect on the next call.
 *
 *   await repos.entitlements.can('store.checkout')    true or false
 *   await repos.entitlements.limit('dms.monthly')     a number, Infinity for no limit, 0 when not included
 *
 * An unknown feature name is simply not included.
 *
 * Phase 7 (PRD 5.7, 5.20):
 *
 *   await repos.entitlements.lowestPlan(['store.checkout'])                 { code, name } of the lowest plan that includes any of
 *                                                                           them, or null when only an add-on or an override can
 *   await repos.entitlements.lowestPlan(['automations'], { moreThan: 3 })   the lowest plan whose limit is higher (or none at all)
 *   await repos.entitlements.all()                                          { plan, features: { name: { on, limit } } }: the plan's
 *                                                                           rows with this business's overrides, for billing.features
 *
 * The api-v1 router asks can() and limit() for every route that names `feature` or `limit` in the route table, so a route's
 * check cannot be forgotten. Jobs and buyer routes have no route table and keep asking here themselves (JOB_ENTITLEMENTS in
 * src/contracts/billing.js lists which).
 *
 * What a plan change does to what exists is held by the database (migration 740, run from the plan_changes row whoever
 * writes it): a downgrade keeps all data and pauses the live and test automations above the new limit, newest first; an
 * upgrade resumes what a plan change paused; each change but a direct one is audited and the owner is told (an alert,
 * kind plan.changed). Checkout, one tap, story triggers and the creator page's badge follow tenants.plan on the next
 * request. plan-changes.js has the friendly refusal for switching on an automation above the limit; the database holds
 * the same limit when two requests race (automations_within_plan).
 *
 * Feature flags (flags.js): repos.flags.on(key) with flagOn from the contract (the business's own row, else the
 * default, else a stable percentage bucket), and their four Platform Console routes.
 */
export function entitlementsRepo(db) {
  async function lookup(feature) {
    const [row] = await db.query(
      `SELECT CASE WHEN o.feature IS NOT NULL THEN o.enabled ELSE f.feature IS NOT NULL END AS enabled,
              CASE WHEN o.feature IS NOT NULL THEN o.limit_value ELSE f.limit_value END AS limit_value,
              o.feature IS NOT NULL AS overridden
       FROM tenants t
       LEFT JOIN plan_features f ON f.plan_code = t.plan AND f.feature = $2
       LEFT JOIN tenant_features o ON o.tenant_id = t.id AND o.feature = $2
       WHERE t.id = $1`,
      [tenantId(), String(feature)],
    );
    return row ?? { enabled: false, limit_value: null, overridden: false };
  }

  /**
   * A feature an app brings with it (APP_ENTITLEMENTS.includes: loyalty) is on whenever either app is, by plan or by override,
   * unless this business has its own row for the feature itself: a tenant_features row switching it off wins over the plan
   * and over the app that would bring it (S-91), as it does for every other feature.
   */
  async function resolve(feature) {
    const { overridden, ...row } = await lookup(feature);
    if (row.enabled || overridden || !APP_ENTITLEMENTS.includes.includes(String(feature))) return row;
    for (const app of [APP_ENTITLEMENTS.android, APP_ENTITLEMENTS.ios]) if ((await lookup(app)).enabled) return { enabled: true, limit_value: row.limit_value };
    return row;
  }

  return {
    async can(feature) {
      return (await resolve(feature)).enabled;
    },
    async limit(feature) {
      const { enabled, limit_value: limit } = await resolve(feature);
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
    /** The lowest plan that includes any of `features`; with moreThan, the lowest whose limit for it is higher or absent. Null when no plan does. */
    async lowestPlan(features, { moreThan } = {}) {
      const [row] = await db.query(
        `SELECT p.code, p.name FROM plan_features f JOIN plans p ON p.code = f.plan_code
         WHERE f.feature = ANY($1::text[]) AND ($2::integer IS NULL OR f.limit_value IS NULL OR f.limit_value > $2)
         ORDER BY p.rank LIMIT 1`,
        [[features].flat().map(String), Number.isFinite(moreThan) ? moreThan : null],
      );
      return row ? { code: row.code, name: row.name } : null;
    },
    /** Everything this business has: its plan's features with its own overrides on top. A feature switched off by an override is listed as off. */
    async all() {
      const [{ plan }] = await db.query('SELECT plan FROM tenants WHERE id = $1', [tenantId()]);
      const included = await db.query('SELECT feature, true AS enabled, limit_value FROM plan_features WHERE plan_code = $1', [plan]);
      const own = await db.query('SELECT feature, enabled, limit_value FROM tenant_features WHERE tenant_id = $1', [tenantId()]);
      const rows = [...included, ...own]; // a business's own row comes last, so it replaces the plan's
      const features = {};
      for (const row of rows) if (row.feature) features[row.feature] = { on: Boolean(row.enabled), limit: row.enabled ? row.limit_value ?? null : null };
      for (const app of [APP_ENTITLEMENTS.android, APP_ENTITLEMENTS.ios]) {
        if (features[app]?.on) for (const brought of APP_ENTITLEMENTS.includes) features[brought] = { on: true, limit: features[brought]?.limit ?? null };
      }
      return { plan, features };
    },
  };
}

export const entitlements = {
  name: 'entitlements',
  owns: { migrations: ['740_plan_effects.sql'], tables: ['plans', 'plan_features', 'tenant_features', 'feature_flags', 'tenant_flags'], api: ['billing.features'], store: [], platform: BILLING_PLATFORM_OWNERS.entitlements, jobs: [] },
  repos: (db) => ({ entitlements: entitlementsRepo(db), flags: flagsRepo(db) }),
  api: (ctx) => ({
    'billing.features': () => ctx.repos.entitlements.all(),
  }),
  /** Switching an automation on (Test or Live) counts against the plan's automations limit (F-35, F-123). */
  beforeAutomationLaunch: automationLimitHook,
  platformRoutes(router, ctx) {
    flagRoutes(router, ctx);
  },
};

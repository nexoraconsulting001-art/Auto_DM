import { requirePlatformRole } from '../../auth.js';
import { ApiError } from '../../contracts/api/index.js';
import { platformRoutes as ROUTES } from '../../contracts/api/platform.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { reachGuardRepo } from './repo.js';
import { createReachGuard } from './service.js';

const MINUTE = 60_000;
export const SWEEP = 'reach-guard.sweep';

const services = new WeakMap();

/** One service per app. Built when first used: the module's api() is also called with an empty ctx, to read the route ids. */
function service(ctx) {
  if (!services.has(ctx)) services.set(ctx, createReachGuard(ctx));
  return services.get(ctx);
}

/** Every business's Account Health, worst first (5.9). A business with no score yet comes last, and its row says so. */
function registerHealthList(router, ctx) {
  const definition = ROUTES['platform.accountHealthList'];
  router.get(definition.path, requirePlatformRole(...definition.platformRoles), async (req, res, next) => {
    try {
      const query = definition.query.safeParse(req.query);
      if (!query.success) return res.status(400).json({ error: query.error.issues[0]?.message ?? 'Check the details and try again.' });
      const { cursor, limit } = query.data;
      const after = cursor ? readCursor(cursor, (key) => key.length === 2 && Number.isInteger(key[0]) && isRowId(key[1])) : null;
      const rows = await ctx.db.platform.query(
        `WITH worst AS (
           SELECT DISTINCT ON (tenant_id) tenant_id, score, band, deductions, computed_at FROM account_health ORDER BY tenant_id, score, computed_at DESC
         ), listed AS (
           SELECT t.id, t.name, w.score, w.band, w.deductions, w.computed_at, COALESCE(w.score, 101)::integer AS sort_score
           FROM tenants t LEFT JOIN worst w ON w.tenant_id = t.id WHERE t.status NOT IN ('closed', 'killed')
         )
         SELECT * FROM listed WHERE $1::integer IS NULL OR (sort_score, id) > ($1::integer, $2::integer) ORDER BY sort_score, id LIMIT $3`,
        [after?.[0] ?? null, after?.[1] ?? null, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.sort_score, row.id]);
      return res.json(definition.response.parse({
        items: page.items.map((r) => ({ tenantId: r.id, tenantName: r.name, score: r.score, band: r.band, deductions: r.deductions ?? [], computedAt: r.computed_at })),
        nextCursor: page.nextCursor,
      }));
    } catch (err) {
      if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  });
}

/**
 * PRD 7.6 and 7.7: Reach Guard and Account Health. Slow mode is compliance's: this module calls compliance.slowMode and never sends anything itself.
 * The owner's override is compliance.slowModeOverride, which has the owner rule, the typed confirmation, the audit row and the reach-drop-only rule; the
 * trip records it at the next look. rules.js has the rules, service.js the flow, repo.js the tables.
 */
export const reachGuard = {
  name: 'reach-guard',
  repos: (db) => ({ reachGuard: reachGuardRepo(db) }),

  api: (ctx) => ({
    'reachGuard.status': () => service(ctx).status(),
    'reachGuard.setThresholds': ({ body, user }) => service(ctx).setThresholds(body, user),
    'reachGuard.trips': ({ query }) => service(ctx).trips(query),
    'accountHealth.get': () => service(ctx).health(),
    'accountHealth.history': ({ query }) => service(ctx).healthHistory(query),
  }),

  platformRoutes: registerHealthList,

  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(SWEEP, () => service(ctx).sweep());
    return async () => {
      await queue.every(SWEEP, MINUTE);
    };
  },

  onMetaCall: (call, ctx) => service(ctx).recordCall(call),
};

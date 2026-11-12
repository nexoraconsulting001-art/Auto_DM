import { requirePlatformRole } from '../../auth.js';
import { ApiError } from '../../contracts/api/index.js';
import { platformRoutes as ROUTES } from '../../contracts/api/platform.js';
import { reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { createAppConfig } from './service.js';

export { AppConfigProblem, BRAND_ASSET_FILES, textProblems } from './service.js';

/**
 * The business's own app: its name, ids, icon and splash, colours and fonts over the brand kit, links and store details (PRD 10.7,
 * 10.8). Track brand-pipeline. Owns app_configs (601); its trigger mirrors the minimum version into app_min_versions, which the
 * version gates read, and another locks the store ids after the first submitted build.
 *
 *   appConfigFor(ctx) -> { get(), save(patch, actor), validate({ platforms? }), brandFile({ platform, buildNumber, appVersion,
 *                          runtimeVersion }), hosts(), setMinimum({ platform, minVersion, storeUrl }), setReviewAccess({ phone,
 *                          code, enabled }), setStoreUrl(platform, url) }   made once per ctx (a WeakMap)
 *                          and, for the pipeline: read() (get with no plan check), entitledPlatforms(), imageProblems(details)
 *
 * get() merges the row over the brand kit; save() writes the audit row 'app.config_saved'; validate() runs brandFileProblems
 * (src/contracts/apps.js) with hosts() and stores the answer; brandFile() throws a ValidationError naming the field (P-33).
 * Every handler checks the entitlement first (403 forbidden without app.android and app.ios).
 *
 * A save is refused (400, naming the field) for markup or hidden characters in a name, the platform's name anywhere, a link name
 * a phone keeps for itself, an icon that fails the stores' source spec (P-34) or an image that is not this business's; it is a
 * 409 when another business already holds the package, bundle id or link name, or when the ids are locked.
 */
const API = ['appPublishing.get', 'appPublishing.save', 'appPublishing.validate'];
const PLATFORM = ['platform.setAppMinimum', 'platform.setAppReviewAccess'];

const built = new WeakMap();
/** The app details service of one app's or worker's context. */
export function appConfigFor(ctx) {
  let service = built.get(ctx);
  if (!service) {
    service = createAppConfig(ctx);
    built.set(ctx, service);
  }
  return service;
}

/** 'user:12' for a signed-in seller. */
export const actorOf = (user) => (Number.isSafeInteger(Number(user?.id)) && Number(user.id) > 0 ? `user:${Number(user.id)}` : 'user:unknown');

/**
 * Mounts one Platform Console route of the contract: the role check, the input checked by its schemas, the answer parsed by its
 * response schema, and refusals as { error, code }. `handler({ params, query, body, actor })`; actor is 'platform:<id>'.
 */
export function mountPlatform(router, id, handler) {
  const route = ROUTES[id];
  if (!route) throw new Error(`"${id}" is not a Platform Console route`);
  router[route.method.toLowerCase()](route.path, requirePlatformRole(...route.platformRoles), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const input = {};
    for (const part of ['params', 'query', 'body']) {
      if (!route[part]) continue;
      const parsed = route[part].safeParse(part === 'body' ? req.body ?? {} : req[part]);
      if (parsed.success) input[part] = parsed.data;
      else if (part === 'params') return res.status(404).json({ error: 'Not found.', code: 'not_found' });
      else return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the details and try again.', code: 'validation_failed' });
    }
    try {
      const result = await handler({ ...input, actor: `platform:${Number(req.platformUser?.id) || 0}` });
      if (route.response === null) return res.status(route.status ?? 204).end();
      if (result === null || result === undefined) return res.status(404).json({ error: 'Not found.', code: 'not_found' });
      return res.status(route.status ?? 200).json(route.response.parse(result));
    } catch (err) {
      if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) });
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message, code: 'validation_failed' });
      reportError(err, { msg: 'platform.route_failed', route: id });
      return res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'internal' });
    }
  });
}

/** Runs `fn` as business `id` (a number from the route), or answers 404 when there is no such business. */
export async function asBusiness(ctx, id, fn) {
  const db = ctx.db.platform ?? ctx.db;
  const [tenant] = await db.query('SELECT id, slug, name, status FROM tenants WHERE id = $1', [Number(id)]);
  if (!tenant) throw new ApiError('not_found', 'There is no such business.');
  return withTenant({ id: Number(tenant.id), slug: tenant.slug, name: tenant.name }, () => fn(tenant));
}

export const appConfig = {
  name: 'app-config',
  owns: { migrations: ['601_app_configs.sql'], tables: ['app_configs'], api: API, store: [], platform: PLATFORM, jobs: [] },

  api: (ctx) => {
    const service = () => appConfigFor(ctx);
    return {
      'appPublishing.get': () => service().get(),
      'appPublishing.save': ({ body, user }) => service().save(body, actorOf(user)),
      'appPublishing.validate': () => service().validate(),
    };
  },

  platformRoutes(router, ctx) {
    mountPlatform(router, 'platform.setAppMinimum', ({ params, body, actor }) => asBusiness(ctx, params.id, () => appConfigFor(ctx).setMinimum(body, actor)));
    mountPlatform(router, 'platform.setAppReviewAccess', ({ params, body, actor }) => asBusiness(ctx, params.id, () => appConfigFor(ctx).setReviewAccess(body, actor)));
  },
};

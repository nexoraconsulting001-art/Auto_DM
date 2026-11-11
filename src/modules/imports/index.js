import { requirePlatformRole } from '../../auth.js';
import { platformRoutes as ROUTES } from '../../contracts/api/platform.js';
import { reportError } from '../../platform/log.js';
import { RECHECK_ONE } from '../catalog/api.js';
import { RECHECK_SWEEP, createRecheck } from './recheck.js';
import { importsRepo } from './repo.js';
import { IMAGE, RUN, createImports } from './service.js';

export { IMAGE, RUN } from './service.js';
export { RECHECK_SWEEP } from './recheck.js';

const SWEEP_EVERY_MS = 5 * 60_000;
const RUN_ATTEMPTS = 5;

const services = new WeakMap();

/** One service per app or worker. Built when first used: api() is also called with an empty ctx, to read the route ids. */
function service(ctx) {
  if (!services.has(ctx)) {
    const imports = createImports(ctx);
    services.set(ctx, { imports, recheck: createRecheck(ctx, imports.reader) });
  }
  return services.get(ctx);
}

/** For tests and tools: the same service the routes and jobs use. */
export const importService = (ctx) => service(ctx);

/**
 * The module's background work, by queue name. Each handler runs as the job's business (the queue sets it), except the
 * re-check run, which is for every business and sets each one itself.
 *   imports.run          one step of a bulk, CSV or Shopify import
 *   imports.image        copies a product's first image into the business's media
 *   imports.recheck      the scheduled re-check, every five minutes (8.8)
 *   catalog.recheck-one  "Re-check now" on one product
 */
export function jobHandlers(ctx) {
  const { imports, recheck } = service(ctx);
  return {
    [RUN]: (job) => imports.run(job.payload, { lastTry: job.attempt >= RUN_ATTEMPTS }),
    [IMAGE]: (job) => imports.copyFirstImage(job.payload?.productId),
    [RECHECK_SWEEP]: async () => {
      const result = await recheck.sweep();
      await recheck.prune().catch((err) => reportError(err, { msg: 'catalog.prune_failed' }));
      return result;
    },
    [RECHECK_ONE]: (job) => recheck.one(job.payload?.productId),
  };
}

/** Site adapters per business, for our team (8.4): which adapters exist, and which this business may use. */
function registerPlatformRoutes(router, ctx) {
  const route = (id, handler) => {
    const definition = ROUTES[id];
    router[definition.method.toLowerCase()](definition.path, requirePlatformRole(...definition.platformRoles), async (req, res, next) => {
      try {
        const params = definition.params.safeParse(req.params);
        if (!params.success) return res.status(404).json({ error: 'Not found.' });
        const body = definition.body?.safeParse(req.body ?? {});
        if (body && !body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Check the details and try again.' });
        const result = await handler({ params: params.data, body: body?.data, actor: `platform:${req.platformUser.id}` });
        if (result === null) return res.status(404).json({ error: 'Not found.' });
        if (result.error) return res.status(400).json({ error: result.error });
        return res.json(definition.response.parse(result));
      } catch (err) {
        return next(err);
      }
    });
  };

  const switches = async (businessId) => {
    const enabled = await ctx.repos.imports.adaptersOf(businessId);
    if (!enabled) return null;
    return { items: service(ctx).imports.adapters.list().map((a) => ({ ...a, enabled: enabled.includes(a.name) })) };
  };

  route('platform.siteAdapters', ({ params }) => switches(params.id));

  route('platform.setSiteAdapter', async ({ params, body, actor }) => {
    if (!service(ctx).imports.adapters.get(body.adapter)) return { error: 'There is no adapter by that name.' };
    if (!(await ctx.repos.imports.adaptersOf(params.id))) return null;
    await ctx.repos.imports.setAdapterFor(params.id, body.adapter, body.enabled);
    await ctx.db.platform.query(
      'INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [params.id, actor, body.enabled ? 'site_adapter.enabled' : 'site_adapter.disabled', `adapter:${body.adapter}`, JSON.stringify({ adapter: body.adapter, enabled: body.enabled })],
    );
    return switches(params.id);
  });
}

/**
 * PRD 8.3 to 8.8: import by link, site adapters, the Shopify public feed, CSV and bulk paste, the quality gate and the scheduled
 * re-check (tables in migration 301). Everything outside is read through ctx.platform.fetcher (safeFetch); images are cleaned by
 * ctx.platform.images and stored with repos.media. Nothing is fetched while a shopper waits: a pasted link is read while the
 * seller waits for its card, everything else in the worker. Reasons and limits are in src/contracts/catalog.js.
 *
 *   read.js     one address: adapter, Shopify JSON, JSON-LD, Open Graph, title (8.3)      gate.js     the quality gate (8.7)
 *   service.js  the routes and the job steps                                              recheck.js  the scheduled re-check (8.8)
 *   adapters.js the adapter interface and registry (8.4)                                  csv.js      CSV in, and safe CSV out (8.6)
 *   extract.js, html.js, text.js, shopify.js: reading pages and feeds into plain text and paise
 */
export const imports = {
  name: 'imports',
  repos: (db) => ({ imports: importsRepo(db) }),

  api: (ctx) => ({
    'imports.link': ({ body, user }) => service(ctx).imports.link(body, user),
    'imports.bulk': ({ body, user }) => service(ctx).imports.bulk(body, user),
    'imports.csv': ({ file, user }) => service(ctx).imports.csv(file, user),
    'imports.shopify': ({ body, user }) => service(ctx).imports.shopify(body, user),
    'imports.list': ({ query }) => service(ctx).imports.list(query),
    'imports.adapters': () => service(ctx).imports.enabledAdapters(),
    'imports.get': ({ params }) => service(ctx).imports.get(params.id),
    'imports.items': ({ params, query }) => service(ctx).imports.items(params.id, query),
    'importItems.save': ({ params, body }) => service(ctx).imports.save(params.id, body),
  }),

  platformRoutes: registerPlatformRoutes,

  jobs(ctx) {
    const { queue } = ctx.platform;
    for (const [name, handler] of Object.entries(jobHandlers(ctx))) queue.work(name, handler);
    return async function schedule() {
      await queue.every(RECHECK_SWEEP, SWEEP_EVERY_MS);
    };
  },
};

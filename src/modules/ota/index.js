import { APP_ROUTES, AppHealthBody } from '../../contracts/store-routes.js';
import { reportError } from '../../platform/log.js';
import { appCall } from '../app-api/http.js';
import { mountConsoleRoute } from '../app-submissions/console.js';
import { parseBody } from '../storefront/http.js';
import { otaFor } from './service.js';

export { otaFor, wilsonLower, thresholdOf, PUBLISH_STALL_MS } from './service.js';

/**
 * Over-the-air updates of the shopper app's JavaScript (PRD 10.10). Track store-release. Platform tables (607): one release goes
 * to every brand's channel ('t<tenantId>') on its runtime, published only by our team, through ctx.eas.
 *
 *   otaFor(ctx) -> { publish(input, actor), advance(id, actor), rollBack(id, { reason, actor }), list(), health(id),
 *                    report({ updateId, runtimeVersion, event, deviceId }), watch() }   made once per ctx (a WeakMap)
 *
 * A bundle fingerprint that is not app_runtimes' for its runtime is recorded as blocked (native_change) and answers 409 "This
 * update changes native code. Start a store build instead."; nothing is published. Rollout goes 10, 50, 100 and never moves
 * during a roll back. watch() rolls back and alerts ops when the crash rate reaches config.otaCrashMultiplier times the baseline
 * (and at least config.otaCrashFloor) after config.otaMinLaunches launches in config.otaWindowMinutes. appHealth counts one
 * device once per hour per release and event (APP_LIMITS.healthPerDevice).
 *
 * Queue ota.publish; schedule ota.watch (every minute).
 *
 * publish() answers { release, created }; the console answers 201 for a new release and 200 for its request key again. The crash
 * verdict compares the 95% lower bound of the rate with the threshold (service.js), so one crash in the minimum launches is
 * not enough. appHealth answers 204, counted or not: an app learns nothing from it.
 */
const STORE = ['appHealth'];
const PLATFORM = ['platform.otaReleases', 'platform.publishOta', 'platform.advanceOta', 'platform.rollBackOta', 'platform.otaHealth'];
const WATCH = 'ota.watch';
const PUBLISH = 'ota.publish';

export const ota = {
  name: 'ota',
  owns: { migrations: ['607_ota.sql'], tables: ['ota_releases', 'ota_health'], api: [], store: STORE, platform: PLATFORM, jobs: [PUBLISH, WATCH] },
  routes(app, ctx) {
    app.post(APP_ROUTES.appHealth.path, appCall(async (req, res) => {
      const body = parseBody(AppHealthBody, req.body);
      await otaFor(ctx).report({ ...body, deviceId: req.appSession?.deviceId ?? '' });
      res.status(204).end();
    }));
  },
  platformRoutes(router, ctx) {
    const service = () => otaFor(ctx);
    mountConsoleRoute(router, 'platform.otaReleases', ({ query }) => service().list(query));
    mountConsoleRoute(router, 'platform.publishOta', async ({ body, actor, answer }) => {
      const { release, created } = await service().publish(body, actor);
      if (!created) answer.status = 200;
      return release;
    }, { strictBody: true });
    mountConsoleRoute(router, 'platform.advanceOta', ({ params, actor }) => service().advance(params.id, actor));
    mountConsoleRoute(router, 'platform.rollBackOta', ({ params, body, actor }) => service().rollBack(params.id, { reason: body.reason, actor, cause: 'manual' }));
    mountConsoleRoute(router, 'platform.otaHealth', ({ params }) => service().health(params.id));
  },
  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(PUBLISH, (job) => otaFor(ctx).publishChannels(Number(job.payload?.releaseId)));
    queue.work(WATCH, () => otaFor(ctx).watch().catch((err) => reportError(err, { msg: 'ota.watch_failed' })));
    return async function schedule() {
      await queue.every(WATCH, 60_000);
    };
  },
};

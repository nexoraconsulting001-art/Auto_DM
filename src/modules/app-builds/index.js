import { reportError } from '../../platform/log.js';
import { actorOf, asBusiness, mountPlatform } from '../app-config/index.js';
import { POLL_QUEUE, RUN_QUEUE, createAppBuilds } from './service.js';

export { POLL_QUEUE, RUN_QUEUE, buildOut, clip, createAppBuilds, shopperRuntime } from './service.js';

/**
 * Per-brand builds (PRD 10.8): one brand on request, or every brand after a native change. Track brand-pipeline. Owns 602:
 * app_transitions (every Phase 6 machine's moves), app_runtimes, app_build_batches (platform only) and app_builds.
 *
 *   appBuildsFor(ctx) -> { request({ platforms, requestKey, actor, reason?, batchId? }) -> AppBuild[], list({ platform?, cursor,
 *                          limit }), get(id), markStatus(t, id, to, { set?, ifAllowed? }), createBatch({ note, appVersion,
 *                          runtimeVersion, fingerprint, platforms, requestKey, actor }) -> AppBatch, batch(id) -> AppBatchDetail }
 *                          and batches({ cursor, limit }), run(id), check(id), poll(), submitBuilt(id), follow(ids)
 *
 * request() checks the entitlement and the validation, keeps one running build per platform, and takes the build number with
 * UPDATE app_configs SET <platform>_next_build = <platform>_next_build + 1 ... RETURNING ... - 1 in the transaction that inserts
 * the build, never max()+1; with no batchId it writes the 'brand' batch row through db.platform first. markStatus is the only
 * code that writes app_builds.status. Seller text reaches the build only as data inside the brand file: never a shell argument,
 * a path or code. A failed brand never stops a batch. Drivers: 'local' and 'eas' (ctx.eas, config.appBuildDriver).
 *
 * markStatus's `set` takes column names or their camelCase (failedStep, providerSubmissionId, ...); a move APP_TRANSITIONS does
 * not allow throws, or is skipped (null) with ifAllowed. A build that fails tells the owner (app.build_failed) in the same
 * transaction. A built production build is handed to appSubmissionsFor(ctx).submit(buildId, { actor }) and is then marked
 * submitted; a refusal there leaves it built with the reason in submit_error.
 *
 * Queue app-builds.run; schedule app-builds.poll (config.appBuildPollMs).
 */
const API = ['appPublishing.builds', 'appPublishing.requestBuild'];
const PLATFORM = ['platform.appBatches', 'platform.appBatch', 'platform.createAppBatch', 'platform.buildBusinessApp'];

const built = new WeakMap();
/** The builds service of one app's or worker's context. */
export function appBuildsFor(ctx) {
  let service = built.get(ctx);
  if (!service) {
    service = createAppBuilds(ctx);
    built.set(ctx, service);
  }
  return service;
}

export const appBuilds = {
  name: 'app-builds',
  owns: { migrations: ['602_app_builds.sql'], tables: ['app_transitions', 'app_runtimes', 'app_build_batches', 'app_builds'], api: API, store: [], platform: PLATFORM, jobs: ['app-builds.run', 'app-builds.poll'] },

  api: (ctx) => {
    const service = () => appBuildsFor(ctx);
    return {
      'appPublishing.builds': ({ query }) => service().list(query),
      'appPublishing.requestBuild': async ({ body, user }) => ({ builds: await service().request({ platforms: body.platforms, requestKey: body.requestKey, actor: actorOf(user) }) }),
    };
  },

  platformRoutes(router, ctx) {
    const service = () => appBuildsFor(ctx);
    mountPlatform(router, 'platform.appBatches', ({ query }) => service().batches(query));
    mountPlatform(router, 'platform.appBatch', ({ params }) => service().batch(params.id));
    mountPlatform(router, 'platform.createAppBatch', ({ body, actor }) => service().createBatch({ ...body, actor }));
    mountPlatform(router, 'platform.buildBusinessApp', ({ params, body, actor }) => asBusiness(ctx, params.id, async () => ({
      builds: await service().request({ platforms: body.platforms, requestKey: body.requestKey, actor }),
    })));
  },

  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(RUN_QUEUE, (job) => appBuildsFor(ctx).work(job.payload ?? {}));
    queue.work(POLL_QUEUE, () => appBuildsFor(ctx).poll());
    const everyMs = Math.max(20, Number(ctx.config?.appBuildPollMs) || 15_000);
    return async function schedule() {
      try {
        await queue.every(POLL_QUEUE, everyMs);
      } catch (err) {
        reportError(err, { msg: 'app_builds.schedule_failed' });
      }
    };
  },
};

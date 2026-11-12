import { notBuilt, platformNotBuilt } from '../not-built.js';

/**
 * Per-brand builds (PRD 10.8): one brand on request, or every brand after a native change. Track brand-pipeline. Owns 602:
 * app_transitions (every Phase 6 machine's moves), app_runtimes, app_build_batches (platform only) and app_builds.
 *
 *   appBuildsFor(ctx) -> { request({ platforms, requestKey, actor, reason?, batchId? }) -> AppBuild[], list({ platform?, cursor,
 *                          limit }), get(id), markStatus(t, id, to, { set?, ifAllowed? }), createBatch({ note, appVersion,
 *                          runtimeVersion, fingerprint, platforms, requestKey, actor }) -> AppBatch, batch(id) -> AppBatchDetail }
 *
 * request() checks the entitlement and the validation, keeps one running build per platform, and takes the build number with
 * UPDATE app_configs SET <platform>_next_build = <platform>_next_build + 1 ... RETURNING ... - 1 in the transaction that inserts
 * the build, never max()+1; with no batchId it writes the 'brand' batch row through db.platform first. markStatus is the only
 * code that writes app_builds.status. Seller text reaches the build only as data inside the brand file: never a shell argument,
 * a path or code. A failed brand never stops a batch. Drivers: 'local' and 'eas' (ctx.eas, config.appBuildDriver).
 *
 * Queue app-builds.run; schedule app-builds.poll (config.appBuildPollMs).
 */
const API = ['appPublishing.builds', 'appPublishing.requestBuild'];
const PLATFORM = ['platform.appBatches', 'platform.appBatch', 'platform.createAppBatch', 'platform.buildBusinessApp'];

export const appBuilds = {
  name: 'app-builds',
  owns: { migrations: ['602_app_builds.sql'], tables: ['app_transitions', 'app_runtimes', 'app_build_batches', 'app_builds'], api: API, store: [], platform: PLATFORM, jobs: ['app-builds.run', 'app-builds.poll'] },
  api: () => notBuilt(...API),
  platformRoutes(router) {
    platformNotBuilt(router, ...PLATFORM);
  },
};

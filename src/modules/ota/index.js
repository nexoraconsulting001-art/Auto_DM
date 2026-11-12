import { APP_ROUTES } from '../../contracts/store-routes.js';
import { platformNotBuilt, storeNotBuilt } from '../not-built.js';

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
 */
const STORE = ['appHealth'];
const PLATFORM = ['platform.otaReleases', 'platform.publishOta', 'platform.advanceOta', 'platform.rollBackOta', 'platform.otaHealth'];

export const ota = {
  name: 'ota',
  owns: { migrations: ['607_ota.sql'], tables: ['ota_releases', 'ota_health'], api: [], store: STORE, platform: PLATFORM, jobs: ['ota.publish', 'ota.watch'] },
  routes(app) {
    storeNotBuilt(app, APP_ROUTES, ...STORE);
  },
  platformRoutes(router) {
    platformNotBuilt(router, ...PLATFORM);
  },
};

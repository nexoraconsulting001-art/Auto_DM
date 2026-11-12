import { notBuilt, platformNotBuilt } from '../not-built.js';

/**
 * The business's own app: its name, ids, icon and splash, colours and fonts over the brand kit, links and store details (PRD 10.7,
 * 10.8). Track brand-pipeline. Owns app_configs (601); its trigger mirrors the minimum version into app_min_versions, which the
 * version gates read, and another locks the store ids after the first submitted build.
 *
 *   appConfigFor(ctx) -> { get(), save(patch, actor), validate({ platforms? }), brandFile({ platform, buildNumber, appVersion,
 *                          runtimeVersion }), hosts(), setMinimum({ platform, minVersion, storeUrl }), setReviewAccess({ phone,
 *                          code, enabled }), setStoreUrl(platform, url) }   made once per ctx (a WeakMap)
 *
 * get() merges the row over the brand kit; save() writes the audit row 'app.config_saved'; validate() runs brandFileProblems
 * (src/contracts/apps.js) with hosts() and stores the answer; brandFile() throws a ValidationError naming the field (P-33).
 * Every handler checks the entitlement first (403 forbidden without app.android and app.ios).
 */
const API = ['appPublishing.get', 'appPublishing.save', 'appPublishing.validate'];
const PLATFORM = ['platform.setAppMinimum', 'platform.setAppReviewAccess'];

export const appConfig = {
  name: 'app-config',
  owns: { migrations: ['601_app_configs.sql'], tables: ['app_configs'], api: API, store: [], platform: PLATFORM, jobs: [] },
  api: () => notBuilt(...API),
  platformRoutes(router) {
    platformNotBuilt(router, ...PLATFORM);
  },
};

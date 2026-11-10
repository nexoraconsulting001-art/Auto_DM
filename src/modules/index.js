import { adminApi } from './admin-api/index.js';
import { adminConsole } from './admin-console/index.js';
import { alerts } from './alerts/index.js';
import { apiAuth } from './api-auth/index.js';
import { apiV1 } from './api-v1/index.js';
import { audit } from './audit/index.js';
import { automations } from './automations/index.js';
import { brand } from './brand/index.js';
import { catalog } from './catalog/index.js';
import { categories } from './categories/index.js';
import { compliance } from './compliance/index.js';
import { creator } from './creator/index.js';
import { domains } from './domains/index.js';
import { entitlements } from './entitlements/index.js';
import { facebook } from './facebook/index.js';
import { gatewayKeys } from './gateway-keys/index.js';
import { igAccounts } from './ig-accounts/index.js';
import { igConnect } from './ig-connect/index.js';
import { imports } from './imports/index.js';
import { insights } from './insights/index.js';
import { leads } from './leads/index.js';
import { links } from './links/index.js';
import { pages } from './pages/index.js';
import { platformConsole } from './platform-console/index.js';
import { reachGuard } from './reach-guard/index.js';
import { reports } from './reports/index.js';
import { themes } from './themes/index.js';
import { traffic } from './traffic/index.js';

/**
 * Every feature area that plugs into the app. To add one, create src/modules/<name>/index.js and list it
 * here; createApp, createRepos and registerJobs pick it up, so nothing else needs editing. A module is an
 * object with a name and any of these:
 *
 *   repos(db, { storage, secrets })       -> { repoName: repo }. Merged into createRepos(). Business repos call tenantId().
 *   beforeTenant(app, ctx)                Routes with no business yet: provider webhooks and callbacks, the platform host.
 *   routes(app, ctx)                      Routes inside one business, after sign-in and CSRF, before the store's 404.
 *   platformRoutes(router, ctx)           Platform Console routes; guard them with requirePlatformRole from src/auth.js.
 *   api(ctx)                              -> { 'products.list': handler }. Answers routes of the /api/v1 contract (src/contracts/api).
 *   takesOver(ctx)                        -> { id: handler } for ids admin-api answers (Phase 0): replaces its handler there.
 *   jobs({ db, repos, platform, config, ig, meta, google, compliance, modules }) Calls platform.queue.work(...). May return an async schedule(), run every minute.
 *   onMetaCall(call, ctx)                 Told about every call to Meta, ids and numbers only. See meta-calls.js.
 *
 * ctx is { db, repos, ig, meta, google, compliance, auth, config, platform, modules }. meta is src/adapters/meta; google is src/adapters/google; compliance is the only path to Meta for a message.
 * platform.fetcher is safeFetch and platform.images is sharp (src/platform).
 *
 * Phase 3's buyer pages (catalog to leads) come after traffic, so traffic's page middleware counts them, and before admin-api,
 * whose routes they may take over.
 */
export const MODULES = [
  brand, entitlements, igAccounts, audit, alerts, gatewayKeys, apiAuth, platformConsole, igConnect, compliance, automations, links, facebook, domains,
  insights, reachGuard, traffic, reports,
  catalog, imports, categories, pages, themes, creator, leads,
  adminConsole, adminApi, apiV1,
];

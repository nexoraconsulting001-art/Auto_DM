import { apiAuth } from './api-auth/index.js';
import { brand } from './brand/index.js';
import { entitlements } from './entitlements/index.js';
import { igAccounts } from './ig-accounts/index.js';
import { platformConsole } from './platform-console/index.js';

/**
 * Every feature area that plugs into the app. To add one, create src/modules/<name>/index.js and list it
 * here; createApp, createRepos and registerJobs pick it up, so nothing else needs editing. A module is an
 * object with a name and any of these:
 *
 *   repos(db, { storage, secrets })       -> { repoName: repo }. Merged into createRepos(). Business repos call tenantId().
 *   beforeTenant(app, ctx)                Routes with no business yet: provider webhooks and callbacks, the platform host.
 *   routes(app, ctx)                      Routes inside one business, after sign-in and CSRF, before the store's 404.
 *   platformRoutes(router, ctx)           Platform Console routes; guard them with requirePlatformRole from src/auth.js.
 *   jobs({ db, repos, platform, config }) Calls platform.queue.work(...). May return an async schedule(), run every minute.
 *
 * ctx is { db, repos, ig, auth, config, platform, modules }.
 */
export const MODULES = [brand, entitlements, igAccounts, apiAuth, platformConsole];

import { APP_ROUTES } from '../../contracts/store-routes.js';
import { storeNotBuilt } from '../not-built.js';

/**
 * Deep links (PRD 10.12): the two verified-link files on every host of the business, and the install banner on its buyer pages.
 * Track links-push. Reads app_configs and app_submissions; owns no table.
 *
 *   /.well-known/assetlinks.json                200 when app.android is on, android_package is set and there is at least one
 *                                               Play signing fingerprint: [{ relation: ['delegate_permission/common.handle_all_urls'],
 *                                               target: { namespace: 'android_app', package_name, sha256_cert_fingerprints } }]
 *   /.well-known/apple-app-site-association     200 when app.ios is on and apple_team_id and ios_bundle_id are set:
 *                                               { applinks: { details: [{ appIDs: ['<team>.<bundle>'], components: [excluded paths as
 *                                               { '/': p, exclude: true }, then opened paths as { '/': p }] }] } } from APP_LINK_PATHS
 *
 * Both: Content-Type application/json, Cache-Control public, max-age=300, no redirect, no cookie, no session read, the same on
 * every host of the business, built per request from the current business's app_configs only. Otherwise the store's plain 404.
 *
 * Banner (only where app_submissions.state is live for the visitor's platform, from the user agent): iOS gets the
 * apple-itunes-app meta tag with app-argument this page's URL; Android one banner linking intent://<host><path>#Intent;
 * scheme=https;package=<android_package>;S.browser_fallback_url=<android_store_url>;end. On /order/:token?app=1 it reads "Back to
 * the app" and links <url_scheme>://order/<token>. Injected by wrapping HTML responses as the traffic module does; no view
 * changes, no script that calls home, no platform name. app-links sits after reports and before catalog in MODULES, so its
 * wrapper sees every buyer page.
 */
const STORE = ['assetLinks', 'appleAppSite'];

export const appLinks = {
  name: 'app-links',
  owns: { migrations: [], tables: [], api: [], store: STORE, platform: [], jobs: [] },
  routes(app) {
    storeNotBuilt(app, APP_ROUTES, ...STORE);
  },
};

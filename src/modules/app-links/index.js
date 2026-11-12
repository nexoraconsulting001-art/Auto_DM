import { APP_ROUTES } from '../../contracts/store-routes.js';
import { platformAppHostOf } from '../../config.js';
import { reportError } from '../../platform/log.js';
import { normalizeHost, withTenant } from '../../tenancy.js';
import { platformHostOf } from '../platform-console/host.js';
import { bannerMiddleware } from './banner.js';
import { appleSiteFile, assetLinksFile } from './files.js';

export { appleSiteFile, assetLinksFile } from './files.js';
export { bannerFor, inAppBrowser, platformOfAgent } from './banner.js';

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
 * every host of the business, built per request from the current business's app_configs only. Otherwise the plain 404 of a
 * business with no app ("Not found.", no-store).
 *
 * The two files mount in beforeTenant, ahead of the session, CSRF and traffic middleware, so nothing reads a session or sets a
 * cookie on them. The business is the one that owns the host (its custom domain or <slug>.<platform domain>); a host that
 * only falls back to the default business, and the platform's own hosts, are no business's, so they get the 404.
 *
 * Banner (banner.js): only where app_submissions.state is live for the visitor's platform, from the user agent. Injected by
 * wrapping HTML answers as the traffic module does; app-links sits after reports and before catalog in MODULES, so its
 * wrapper sees every buyer page.
 */
const STORE = ['assetLinks', 'appleAppSite'];
const FEATURE = Object.freeze({ android: 'app.android', ios: 'app.ios' });

function notFound(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(404).type('text').send('Not found.');
}

/** The file for `platform`, as the business that owns this request's host, or null. */
async function fileFor(ctx, req, platform) {
  const host = normalizeHost(req.hostname);
  if (!host || [platformAppHostOf(ctx.config), platformHostOf(ctx.config)].filter(Boolean).includes(host)) return null;
  const tenant = await ctx.tenantResolver?.owner(host);
  if (!tenant) return null;
  return withTenant(tenant, async () => {
    const [row] = await ctx.db.query(
      'SELECT android_package, play_signing_sha256, apple_team_id, ios_bundle_id FROM app_configs WHERE tenant_id = $1',
      [tenant.id],
    );
    if (!row) return null;
    const on = await ctx.repos.entitlements.can(FEATURE[platform]);
    return platform === 'android' ? assetLinksFile(row, { android: on }) : appleSiteFile(row, { ios: on });
  });
}

const wellKnown = (ctx, platform) => async (req, res) => {
  try {
    const body = await fileFor(ctx, req, platform);
    if (!body) return notFound(res);
    res.set('Cache-Control', 'public, max-age=300');
    return res.status(200).type('application/json').send(JSON.stringify(body));
  } catch (err) {
    // Never a 404 on a failure: a verifier that sees one may drop the link for days.
    reportError(err, { msg: 'app_links.file_failed', platform });
    res.set('Cache-Control', 'no-store');
    return res.status(503).type('text').send('Try again shortly.');
  }
};

export const appLinks = {
  name: 'app-links',
  owns: { migrations: [], tables: [], api: [], store: STORE, platform: [], jobs: [] },
  beforeTenant(app, ctx) {
    app.get(APP_ROUTES.assetLinks.path, wellKnown(ctx, 'android'));
    app.get(APP_ROUTES.appleAppSite.path, wellKnown(ctx, 'ios'));
  },
  routes(app, ctx) {
    app.use(bannerMiddleware(ctx));
  },
};

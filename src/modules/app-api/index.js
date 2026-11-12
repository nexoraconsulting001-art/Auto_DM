import { reportError } from '../../platform/log.js';
import { mountAuthRoutes } from './auth.js';
import { mountFeedRoutes } from './feeds.js';
import { appGate } from './gate.js';
import { mountOrderRoutes } from './orders.js';
import { appSessionsFor } from './sessions.js';

export { afterSignIn, appReviewCodeHash, appSessionsFor, createAppSessions } from './sessions.js';

/**
 * The shopper app's server (PRD 10.7, 10.12 to 10.14): its gate, its sessions, its feeds and its account, on the business's own
 * host. Track shopper-api.
 *
 *   gate.js       appGate(ctx), mounted first in routes(app, ctx), for paths under /api/store/ only. In order: no X-App is the
 *                 web's request (next); an X-App-Tenant that is not String(tenantId()), a wrong X-App or platform, no app_configs
 *                 row or no app.<platform> entitlement is a 404 with no body (Cache-Control: no-store, nothing else); below
 *                 repos.appVersions.minimum is 426 update_required with storeUrl (appBootstrap exempt); then the token
 *                 (Authorization: Shopper <token>, a live shopper_app_sessions row read through the fenced db: 401 otherwise,
 *                 and a guest session on an auth 'shopper' route is 401 too). It sets req.appRequest ({ platform, version,
 *                 config }), req.appSession, req.shopper (or null), req.user = null, req.csrf = '', res.cookie = () => res, and
 *                 continues inside withChannel('app', next) (src/platform/channel.js). POST /api/store/otp/verify with purpose
 *                 sign_in from the app is 400.
 *   sessions.js   createAppSessions(ctx) (appSessionsFor(ctx) makes it once): startGuest, startForShopper, rotate, end, find,
 *                 revokeForShopper, purge, afterSignIn. Family, refresh token and access session in one db.platform.tx, every
 *                 statement with tenant_id = tenantId() written out; a refresh token used twice ends its family and every app
 *                 session of it; one of another business or a seller's is unknown and changes nothing. afterSignIn(shopper,
 *                 { method, phone?, googleSub? }) records consent and links the shared profile. appReviewCodeHash(config,
 *                 { tenantId, phone, code }) is what app_configs.review_code_hash holds for the store reviewers' number.
 *   auth.js       the bootstrap, session start (guest, otp, handoff), refresh, end, Sign in with Apple, Google in the system
 *                 browser (/auth/app/google, a PKCE hand-off), me, and account deletion (createDataRequests from
 *                 src/modules/consent/erasure.js, as POST /api/store/data-requests runs it).
 *   feeds.js      home, catalog, product, categories, a category (pinned reels first, then the set order), reels, landing (records
 *                 nothing), policies. Today's prices; what is not live is absent.
 *   orders.js     orders, one order, an order by token, reorder (today's prices through the cart's pricing; fills the cart only),
 *                 rewards (loyaltyFor(ctx); the referral link is on this business's own host).
 * An app route called without the app's headers is a 404 with no body: these routes are the app's only.
 *
 * Owns migration 600 (shoppers.apple_sub, the token_families changes, shopper_app_sessions, shopper_app_handoffs) and 608
 * (coupons.app_only, orders.channel and their two triggers). Job: app-api.purge (hourly: expired sessions and hand-offs).
 * app-api sits directly before shoppers in MODULES, so the gate has set req.shopper before the shoppers module's routes run.
 */
const STORE = [
  'appBootstrap', 'appSessionStart', 'appSessionRefresh', 'appSessionEnd', 'appApple', 'appGoogleStart', 'appGoogleCallback', 'appMe', 'appAccountDelete',
  'appHome', 'appCatalog', 'appProduct', 'appCategories', 'appCategory', 'appReels', 'appLanding', 'appOrders', 'appOrder', 'appOrderByToken', 'appReorder',
  'appRewards', 'appPolicy',
];
const HOUR = 3_600_000;

export const appApi = {
  name: 'app-api',
  owns: {
    migrations: ['600_app_sessions.sql', '608_order_channel.sql'],
    tables: ['shopper_app_sessions', 'shopper_app_handoffs'],
    api: [],
    store: STORE,
    platform: [],
    jobs: ['app-api.purge'],
  },
  routes(app, ctx) {
    app.use(appGate(ctx));
    mountAuthRoutes(app, ctx);
    mountFeedRoutes(app, ctx);
    mountOrderRoutes(app, ctx);
  },
  jobs(ctx) {
    let nextRun = 0;
    return async function schedule() {
      if (Date.now() < nextRun) return;
      nextRun = Date.now() + HOUR;
      await appSessionsFor(ctx).purge().catch((err) => reportError(err, { msg: 'app-api.purge_failed' }));
    };
  },
};

import { APP_ROUTES } from '../../contracts/store-routes.js';
import { storeNotBuilt } from '../not-built.js';

/**
 * The shopper app's server (PRD 10.7, 10.12 to 10.14): its gate, its sessions, its feeds and its account, on the business's own
 * host. Track shopper-api. Read section 3 of the Phase 6 contract in HANDOFF.md first. Until each route is built it answers 501.
 *
 *   gate.js       appGate(ctx), mounted first with app.use in routes(app, ctx), for paths under /api/store/ only. In order: no X-App
 *                 is the web's request (next); an X-App-Tenant that is not String(tenantId()), a wrong X-App or platform, no
 *                 app_configs row or no app.<platform> entitlement is a 404 with no body (Cache-Control: no-store, nothing else);
 *                 below repos.appVersions.minimum is 426 update_required with storeUrl (appBootstrap exempt); then the token
 *                 (Authorization: Shopper <token>, a live shopper_app_sessions row read through the fenced db: 401 otherwise,
 *                 and a guest session on an auth 'shopper' route is 401 too). It sets req.appSession, req.shopper (or null),
 *                 req.user = null, req.csrf = '', res.cookie = () => res, and continues inside withChannel('app', next)
 *                 (src/platform/channel.js). POST /api/store/otp/verify with purpose sign_in from the app is 400.
 *   sessions.js   createAppSessions(ctx): startGuest, startForShopper, rotate, end, find, revokeForShopper, purge. Family, refresh
 *                 token and access session in one db.platform.tx, every statement with tenant_id = tenantId() written out; a
 *                 refresh token used twice ends its family and every app session of it; one of another business or a seller's
 *                 is unknown and changes nothing. afterSignIn(shopper, { method, phone?, googleSub? }) records consent and links
 *                 the shared profile as shoppers/routes.js does after its cookie, importing nothing from there.
 *   feeds         compose storeCatalog and SORTS (storefront/catalog.js), categorySequencesRepo (categories/repo.js),
 *                 landingPagesRepo and pageBlocksRepo (pages/repo.js), shopperServices(ctx).service.orders and .addresses,
 *                 trackingState and trackingToken (shipping), loyaltyFor(ctx), the consent module's policy pages, cartRepo and
 *                 the cart's pricing for reorder. Today's prices; what is not live is absent; appLanding records nothing.
 *   deletion      appAccountDelete calls createDataRequests(ctx).create({ shopperId, kind: 'erasure', source: 'account', actor })
 *                 from src/modules/consent/erasure.js, as POST /api/store/data-requests does.
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
  routes(app) {
    storeNotBuilt(app, APP_ROUTES, ...STORE);
  },
};

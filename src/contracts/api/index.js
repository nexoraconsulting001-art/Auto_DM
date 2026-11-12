import { activityRoutes } from './activity.js';
import { alertRoutes } from './alerts.js';
import { appRoutes } from './app.js';
import { appPublishingRoutes } from './apps.js';
import { auditRoutes } from './audit.js';
import { authRoutes } from './auth.js';
import { automationRoutes } from './automations.js';
import { billingRoutes, referralRoutes, signupRoutes } from './billing.js';
import { brandKitRoutes } from './brand-kit.js';
import { categoryRoutes } from './categories.js';
import { complianceRoutes } from './compliance.js';
import { creatorRoutes } from './creator.js';
import { customerRoutes } from './customers.js';
import { domainRoutes } from './domains.js';
import { facebookRoutes } from './facebook.js';
import { inventoryRoutes, invoiceRoutes, returnRoutes, shippingRoutes } from './fulfilment.js';
import { importRoutes } from './imports.js';
import { inboxRoutes } from './inbox.js';
import { insightRoutes } from './insights.js';
import { instagramRoutes } from './instagram.js';
import { leadRoutes } from './leads.js';
import { linkRoutes } from './links.js';
import { mediaRoutes } from './media.js';
import { notificationRoutes, pushRoutes } from './notifications.js';
import { orderRoutes } from './orders.js';
import { pageRoutes } from './pages.js';
import { paymentRoutes, refundRoutes } from './payments.js';
import { productRoutes } from './products.js';
import { reachGuardRoutes } from './reach-guard.js';
import { reelRoutes } from './reels.js';
import { reportRoutes } from './reports.js';
import { settingRoutes } from './settings.js';
import { teamRoutes } from './team.js';
import { statRoutes } from './stats.js';
import { cartReminderRoutes, couponRoutes, loyaltyRoutes, orderAlertRoutes, privacyRoutes, reviewRoutes, shopifyRoutes, shopperRoutes, wishlistRoutes } from './store.js';
import { themeRoutes } from './themes.js';
import { trafficRoutes } from './traffic.js';

/**
 * The seller API at /api/v1, as data. The router (src/modules/api-v1) is built from this table, the shared
 * client (shared/api-client) mirrors it, and a test keeps the two in step. Each route is:
 *
 *   id        'group.action', the key below; a module's api() answers routes by this id
 *   method    GET, POST, PUT, PATCH or DELETE
 *   path      under /api/v1, with :params
 *   access    who may call it: see access.js
 *   params    zod schema for the path. Not matching it is a 404
 *   query     zod schema for the query string
 *   body      zod schema for a JSON body
 *   upload    { field, maxBytes, mimeTypes } for a multipart file, instead of body
 *   status    the success status, 200 unless given
 *   response  zod schema for the result, or null for no body. Results are parsed through it, so unknown
 *             fields never leave the server
 *
 * Three optional flags (Phase 5), each true or absent:
 *
 *   fresh        the router answers 403 with code `reauth_required` unless this session had a re-auth in the last
 *                FRESH_MINUTES (a sign-in counts as one). On every route that writes payment keys, courier or
 *                Shopify credentials, integration keys or team roles, or deletes the account (PRD 5.11, 10.4)
 *   consoleOnly  an ops function that lives in the Platform Console: the one exemption from "every seller route has
 *                an app screen" (PRD 10.4). CONSOLE_ONLY_ROUTES lists them, and the parity check skips exactly those
 *   noBusiness   answered with no current business, before anyone is signed in: the sign-in routes and the app's
 *                requirements, on PLATFORM_APP_HOST. The handler works through db.platform and must be PUBLIC
 *
 * Two optional fields tie a route to the plan (Phase 7, PRD 5.7). The router checks them after access and before the handler:
 *
 *   feature      an entitlement name (plan_features, tenant_features): without it the answer is 403 `plan.feature_off` with the
 *                lowest plan that includes it. A list means any one of them is enough (the two app platforms)
 *   limit        { feature, counts }: `feature` is a limit (repos.entitlements.limit) and `counts` names the counter that says how
 *                many are in use (a module's counters(ctx)). At the limit the answer is 403 `plan.limit_reached`
 *
 * Every route names a feature or a limit, or is listed in plan.js as always on, checked in its handler, or not enforced yet;
 * a test keeps that true, so a new route cannot forget. The console and the owner app read ROUTE_FEATURES to hide screens.
 *
 * There is no web-only flag and there never will be: a route the app cannot reach is a bug in the app. A route with
 * any field not listed here does not load (assertRouteFields), so one cannot be added by accident.
 *
 * Lists take ListQuery and answer with page(item). Failures use the format in errors.js.
 */
export const ROUTE_FIELDS = Object.freeze(['method', 'path', 'access', 'params', 'query', 'body', 'upload', 'status', 'response', 'fresh', 'consoleOnly', 'noBusiness', 'feature', 'limit']);
const FEATURE_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const ROUTE_FLAGS = Object.freeze(['fresh', 'consoleOnly', 'noBusiness']);

/** Throws for a route that carries a field the format does not have (a web-only flag, a typo), or a flag used wrongly. */
export function assertRouteFields(id, route) {
  for (const field of Object.keys(route)) {
    if (!ROUTE_FIELDS.includes(field)) throw new Error(`Route "${id}" has the field "${field}", which the route format does not have`);
  }
  for (const flag of ROUTE_FLAGS) {
    if (flag in route && route[flag] !== true) throw new Error(`Route "${id}": ${flag} is true or absent`);
  }
  if (route.noBusiness && !route.access?.public) throw new Error(`Route "${id}" is answered with no business, so it must be PUBLIC`);
  if (route.fresh && route.access?.public) throw new Error(`Route "${id}" is PUBLIC, so there is no session to be fresh`);
  if ('feature' in route) {
    const names = Array.isArray(route.feature) ? route.feature : [route.feature];
    if (!names.length || !names.every((name) => typeof name === 'string' && FEATURE_NAME.test(name))) throw new Error(`Route "${id}": feature is an entitlement name, or a list of them`);
  }
  if ('limit' in route) {
    const { feature, counts, ...rest } = route.limit ?? {};
    if (typeof feature !== 'string' || !FEATURE_NAME.test(feature) || typeof counts !== 'string' || !FEATURE_NAME.test(counts) || Object.keys(rest).length) throw new Error(`Route "${id}": limit is { feature, counts }`);
  }
  if ((route.feature || route.limit) && route.noBusiness) throw new Error(`Route "${id}" is answered with no business, so it has no plan to check`);
  return route;
}

export const routes = Object.freeze({
  ...authRoutes,
  ...productRoutes,
  ...categoryRoutes,
  ...reelRoutes,
  ...orderRoutes,
  ...customerRoutes,
  ...settingRoutes,
  ...brandKitRoutes,
  ...activityRoutes,
  ...statRoutes,
  ...mediaRoutes,
  ...auditRoutes,
  ...instagramRoutes,
  ...complianceRoutes,
  ...automationRoutes,
  ...inboxRoutes,
  ...linkRoutes,
  ...facebookRoutes,
  ...domainRoutes,
  ...alertRoutes,
  ...reportRoutes,
  ...insightRoutes,
  ...reachGuardRoutes,
  ...trafficRoutes,
  // Phase 3
  ...importRoutes,
  ...pageRoutes,
  ...themeRoutes,
  ...creatorRoutes,
  ...leadRoutes,
  // Phase 4 (orders.* additions are in orderRoutes above)
  ...paymentRoutes,
  ...refundRoutes,
  ...shippingRoutes,
  ...inventoryRoutes,
  ...invoiceRoutes,
  ...returnRoutes,
  ...couponRoutes,
  ...reviewRoutes,
  ...wishlistRoutes,
  ...loyaltyRoutes,
  ...orderAlertRoutes,
  ...cartReminderRoutes,
  ...shopifyRoutes,
  ...shopperRoutes,
  ...privacyRoutes,
  // Phase 5 (auth.* additions are in authRoutes above)
  ...teamRoutes,
  ...appRoutes,
  ...notificationRoutes,
  ...pushRoutes,
  // Phase 6: the branded shopper app (apps.js)
  ...appPublishingRoutes,
  // Phase 7: the plan, billing, usage, referrals and sign-up (billing.js)
  ...billingRoutes,
  ...referralRoutes,
  ...signupRoutes,
});

export const routeList = Object.freeze(Object.entries(routes).map(([id, route]) => Object.freeze({ id, ...assertRouteFields(id, route) })));

/** Ops-only routes, exempt from app parity (PRD 10.4). Empty until one exists: nothing a seller uses belongs here. */
export const CONSOLE_ONLY_ROUTES = Object.freeze(routeList.filter((route) => route.consoleOnly).map((route) => route.id));
/** Routes that need a re-auth in the last FRESH_MINUTES. */
export const FRESH_ROUTES = Object.freeze(routeList.filter((route) => route.fresh).map((route) => route.id));
/** The feature (or features, any one of which is enough) each gated route needs, and the limit each limited route counts against. */
export const ROUTE_FEATURES = Object.freeze(Object.fromEntries(routeList.filter((route) => route.feature).map((route) => [route.id, Object.freeze([route.feature].flat())])));
export const ROUTE_LIMITS = Object.freeze(Object.fromEntries(routeList.filter((route) => route.limit).map((route) => [route.id, Object.freeze({ ...route.limit })])));

export * from './access.js';
export * from './activity.js';
export * from './alerts.js';
export * from './app.js';
export * from './apps.js';
export * from './audit.js';
export * from './auth.js';
export * from './automations.js';
export * from './billing.js';
export * from './brand-kit.js';
export * from './categories.js';
export * from './common.js';
export * from './compliance.js';
export * from './creator.js';
export * from './customers.js';
export * from './domains.js';
export * from './errors.js';
export * from './facebook.js';
export * from './fulfilment.js';
export * from './imports.js';
export * from './inbox.js';
export * from './insights.js';
export * from './instagram.js';
export * from './leads.js';
export * from './links.js';
export * from './media.js';
export * from './notifications.js';
export * from './orders.js';
export * from './pages.js';
export * from './payments.js';
export * from './plan.js';
export * from './platform.js';
export * from './provider.js';
export * from './products.js';
export * from './reach-guard.js';
export * from './reels.js';
export * from './reports.js';
export * from './settings.js';
export * from './stats.js';
export * from './team.js';
export * from './store.js';
export * from './themes.js';
export * from './traffic.js';

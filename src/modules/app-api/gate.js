import { APP_PLATFORMS, isBelowMinimum } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/errors.js';
import { SHOPPER_APP_HEADERS, SHOPPER_AUTH_SCHEME, SHOPPER_TOKEN_PREFIX, appFeatureOf } from '../../contracts/apps.js';
import { APP_ROUTES, STORE_ROUTES } from '../../contracts/store-routes.js';
import { withChannel } from '../../platform/channel.js';
import { currentTenant, tenantId } from '../../tenancy.js';
import { appSessionsFor } from './sessions.js';

/**
 * The shopper app's gate (PRD 10.7), for every request under /api/store/. In order:
 *   1. no X-App header: the web's request, left alone;
 *   2. X-App that is not 'shopper', an X-App-Tenant that is not this business (the id written into the build), an unknown
 *      platform, no app_configs row or no app.<platform> entitlement: 404 with no body, so an app of another business learns
 *      nothing about this one, not even whether it has an app;
 *   3. below the business's minimum version: 426 update_required with the store link (the bootstrap is exempt);
 *   4. the token, `Authorization: Shopper <access token>`, a live shopper_app_sessions row of this business read through the
 *      fenced db: 401 when it is missing or dead on any route but the few marked auth 'none', and for a guest on a route
 *      marked 'shopper'. The Phase 4 JSON the app calls (cart, checkout, coupons...) needs a session too.
 * Then it sets req.appRequest, req.appSession, req.shopper and req.user = null, takes cookies and CSRF out of the request, and
 * runs the rest inside withChannel('app'), so checkout writes orders.channel = 'app' from the session, never from a header.
 */
const compile = (path) => new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}/?$`);
const APP_JSON = Object.entries(APP_ROUTES)
  .filter(([, route]) => route.kind === 'json')
  .map(([id, route]) => ({ id, method: route.method, auth: route.auth, re: compile(route.path) }));

/** The APP_ROUTES row a request is for, or null (a Phase 4 route, or nothing). */
export const appRouteOf = (method, path) => APP_JSON.find((r) => r.method === method && r.re.test(path)) ?? null;

/** An answer that says nothing: no body, not cached. */
export const hidden = (res) => res.status(404).set('Cache-Control', 'no-store').end();

const SCHEME = new RegExp(`^${SHOPPER_AUTH_SCHEME} (\\S{1,200})$`);
export function shopperTokenOf(req) {
  const match = SCHEME.exec(String(req.get('authorization') ?? ''));
  return match && match[1].startsWith(SHOPPER_TOKEN_PREFIX.access) ? match[1] : '';
}

const refuse = (res, err) => res.status(err.status).set('Cache-Control', 'no-store').json({ error: err.message, code: err.code, ...(err.storeUrl ? { storeUrl: err.storeUrl } : {}) });

/** This business's app_configs row, or null. Read through the fenced db. */
export async function appConfigRow(db) {
  const [row] = await db.query('SELECT * FROM app_configs WHERE tenant_id = $1', [tenantId()]);
  return row ?? null;
}

export function appGate(ctx) {
  const sessions = appSessionsFor(ctx);
  const h = SHOPPER_APP_HEADERS;
  return async function appGateMiddleware(req, res, next) {
    if (!req.path.startsWith('/api/store/')) return next();
    const appHeader = req.get(h.app);
    if (appHeader === undefined) return next();
    try {
      if (!currentTenant()) return hidden(res);
      const platform = req.get(h.platform);
      if (appHeader !== 'shopper' || req.get(h.tenant) !== String(tenantId()) || !APP_PLATFORMS.includes(platform)) return hidden(res);
      const config = await appConfigRow(ctx.db);
      if (!config || !(await ctx.repos.entitlements.can(appFeatureOf(platform)))) return hidden(res);

      const route = appRouteOf(req.method, req.path);
      const version = String(req.get(h.version) ?? '');
      if (route?.id !== 'appBootstrap') {
        const minimum = await ctx.repos.appVersions.minimum({ app: 'shopper', platform, tenantId: tenantId() });
        if (minimum && isBelowMinimum(version, minimum.minVersion)) return refuse(res, new ApiError('update_required', undefined, { storeUrl: minimum.storeUrl }));
      }

      const auth = route?.auth ?? 'app';
      const token = shopperTokenOf(req);
      const found = token ? await sessions.find(token) : null;
      const session = found && found.platform === platform ? found : null;
      if (auth !== 'none' && !session) return refuse(res, new ApiError('unauthorized', 'Please sign in again.'));
      if (auth === 'shopper' && session.guest) return refuse(res, new ApiError('unauthorized', 'Sign in to continue.'));
      // A signed-in app never signs in again through the web's code check: its sign-in is POST /api/store/app/session.
      if (req.method === 'POST' && req.path === STORE_ROUTES.otpVerify.path && req.body?.purpose === 'sign_in') {
        return refuse(res, new ApiError('validation_failed', 'Sign in from the app’s sign-in screen.'));
      }

      req.appRequest = { platform, version, config };
      req.appSession = session ? { ...session.public, version: version || session.public.version } : null;
      req.shopper = session?.shopper ?? null;
      req.shopperToken = '';
      req.shopperCsrf = '';
      res.locals.shopper = req.shopper;
      req.user = null;
      req.csrf = '';
      res.cookie = () => res;
      return withChannel('app', next);
    } catch (err) {
      return next(err);
    }
  };
}

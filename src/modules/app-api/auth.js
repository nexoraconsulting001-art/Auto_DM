import express from 'express';
import { HANDOFF_SECONDS, PKCE_CHALLENGE, newToken, pkceMatches, tokenHash } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/errors.js';
import { APP_ENTITLEMENTS, APP_LIMITS } from '../../contracts/apps.js';
import { APP_ROUTES, AppDeleteBody, AppSessionStart, AppRefresh, AppleSignInBody } from '../../contracts/store-routes.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { loadBuyerLayout } from '../../views/buyer/index.js';
import { createDataRequests } from '../consent/erasure.js';
import { loyaltyFor } from '../loyalty/index.js';
import { shopperServices } from '../shoppers/index.js';
import { maskPhone, originOf, readCookie, readToken, safeEqual, signToken, toE164 } from '../shoppers/keys.js';
import { OtpError } from '../shoppers/service.js';
import { limited, parseBody } from '../storefront/http.js';
import { baseOf } from '../storefront/shell.js';
import { appConfigRow } from './gate.js';
import { appCall } from './http.js';
import { appSessionsFor, reviewCodeMatches } from './sessions.js';

/**
 * The app's sessions and account (PRD 10.7, 10.13): the bootstrap, a guest session at install, signing in with a WhatsApp code,
 * Google in the system browser (a single-use PKCE hand-off) or Sign in with Apple, refreshing, signing out, who is signed in,
 * and deleting the account through Phase 4's erasure flow. Every answer is the seller's brand.
 */
const GOOGLE_COOKIE = '_agst';
const GOOGLE_PATH = '/auth/app/google';
const SHOPPER_COLS = 'id, phone, phone_verified_at, google_sub, apple_sub, email, name';
const deletions = new WeakMap();

const deviceOf = (body) => ({ id: body.device.id, name: body.device.name ?? '' });
const appShopper = (row) => (row ? {
  id: row.id, name: row.name ?? '', phoneMasked: maskPhone(row.phone), email: row.email ?? '', phoneVerified: Boolean(row.phone_verified_at ?? row.phoneVerified),
  hasGoogle: Boolean(row.google_sub ?? row.hasGoogle), hasApple: Boolean(row.apple_sub ?? row.hasApple),
} : null);
const asSession = (tokens, shopper) => ({
  accessToken: tokens.accessToken, accessExpiresInSeconds: tokens.accessExpiresInSeconds, refreshToken: tokens.refreshToken, guest: !shopper, shopper: appShopper(shopper),
});
const ipOf = (req) => `${tenantId()}:${String(req.ip ?? '')}`;

export function mountAuthRoutes(app, ctx) {
  const sessions = appSessionsFor(ctx);
  const { config } = ctx;
  const services = () => shopperServices(ctx);
  const requestsOf = () => {
    let found = deletions.get(ctx);
    if (!found) deletions.set(ctx, (found = createDataRequests({ db: ctx.db, config: ctx.config, storage: ctx.platform.storage })));
    return found;
  };
  const shopperRow = async (id) => (await ctx.db.query(`SELECT ${SHOPPER_COLS} FROM shoppers WHERE tenant_id = $1 AND id = $2 AND erased_at IS NULL`, [tenantId(), id]))[0] ?? null;
  const own = (req) => ({ device: req.parsedDevice, platform: req.appRequest.platform, version: req.appRequest.version, previous: req.appSession });

  // ---- the bootstrap: everything the app needs before its first screen (no sign-in) ----
  app.get(APP_ROUTES.appBootstrap.path, appCall(async (req) => {
    const { platform, config: row } = req.appRequest;
    const { repos } = ctx;
    const [layout, minimum, push, payments, loyalty, notice] = await Promise.all([
      loadBuyerLayout(repos),
      repos.appVersions.minimum({ app: 'shopper', platform, tenantId: tenantId() }),
      ctx.db.query('SELECT fcm_status, apns_status FROM app_push_credentials WHERE tenant_id = $1', [tenantId()]).then((r) => r[0] ?? null),
      ctx.db.query('SELECT cod FROM payment_settings WHERE tenant_id = $1', [tenantId()]).then((r) => r[0] ?? null),
      loyaltyFor(ctx).active().catch(() => null),
      ctx.platform.consent?.built ? ctx.platform.consent.notice().catch(() => null) : null,
    ]);
    const [coupons, reviews, wishlist, returns] = await Promise.all(['store.coupons', 'store.reviews', 'store.wishlist', 'store.returns'].map((f) => repos.entitlements.can(f)));
    const base = baseOf(req);
    const colors = { ...layout.theme.colors };
    for (const [key, value] of Object.entries(row.colors ?? {})) if (typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)) colors[key] = value.toUpperCase();
    const link = (kind) => `${base}/policies/${kind}`;
    const logo = layout.theme.logoUrl;
    return {
      body: {
        name: row.app_name || layout.business.name,
        minVersion: minimum?.minVersion || row[`${platform}_min_version`] || '0.0.0',
        storeUrl: minimum?.storeUrl || row[`${platform}_store_url`] || '',
        signIn: { whatsapp: true, google: services().google.configured, apple: platform === 'ios' && Boolean(row.ios_bundle_id) },
        features: { coupons, loyalty: Boolean(loyalty), reviews, wishlist, returns, cod: Boolean(payments?.cod) },
        theme: { colors, headingFont: row.heading_font || layout.theme.headingFont, bodyFont: row.body_font || layout.theme.bodyFont, logoUrl: logo.startsWith('/') ? `${base}${logo}` : logo },
        links: { privacy: row.privacy_url || link('privacy'), terms: link('terms'), refund: link('refund'), shipping: link('shipping') },
        supportEmail: row.support_email || layout.settings.support_email || '',
        push: { android: push?.fcm_status === 'ok', ios: push?.apns_status === 'ok' },
        noticeVersion: notice?.version ?? null,
      },
    };
  }));

  // ---- a session: guest, a WhatsApp code, or the Google hand-off ----
  app.post(APP_ROUTES.appSessionStart.path, appCall(async (req) => {
    const body = parseBody(AppSessionStart, req.body);
    req.parsedDevice = deviceOf(body);
    if (body.grant === 'guest') {
      await limited(ctx.platform, APP_LIMITS.guestSessionsPerAddress.scope, ipOf(req), APP_LIMITS.guestSessionsPerAddress);
      return { status: 201, body: asSession(await sessions.startGuest(own(req)), null) };
    }
    await limited(ctx.platform, APP_LIMITS.signInsPerAddress.scope, ipOf(req), APP_LIMITS.signInsPerAddress);
    if (body.grant === 'otp') {
      const { service } = services();
      const phone = toE164(body.phone);
      let method = 'whatsapp_otp';
      if (phone && reviewCodeMatches(config, req.appRequest.config, { phone, code: body.code })) {
        method = 'review';
      } else {
        try {
          await service.otps.verify({ phone: body.phone, purpose: 'sign_in', code: body.code });
        } catch (err) {
          if (!(err instanceof OtpError)) throw err;
          throw new ApiError(err.status === 429 ? 'rate_limited' : 'validation_failed', err.message, { fields: { code: err.message } });
        }
      }
      const shopper = await service.shoppers.forVerifiedPhone(phone);
      const tokens = await sessions.startForShopper(shopper, { method, ...own(req) });
      await sessions.afterSignIn(shopper, { method, phone });
      return { status: 201, body: asSession(tokens, await shopperRow(shopper.id)) };
    }
    // grant 'handoff': the code the system browser brought back from Google, for the PKCE verifier only this app holds.
    const [handoff] = await ctx.db.query(
      `UPDATE shopper_app_handoffs SET used_at = now() WHERE tenant_id = $1 AND code_hash = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING shopper_id, challenge, method`,
      [tenantId(), tokenHash(body.code)],
    );
    if (!handoff || !pkceMatches(body.codeVerifier, handoff.challenge)) throw new ApiError('unauthorized', 'That sign-in expired. Please try again.');
    const row = await shopperRow(handoff.shopper_id);
    if (!row) throw new ApiError('unauthorized', 'That sign-in expired. Please try again.');
    const tokens = await sessions.startForShopper(row, { method: handoff.method, ...own(req) });
    await sessions.afterSignIn(row, { method: handoff.method, googleSub: row.google_sub });
    return { status: 201, body: asSession(tokens, row) };
  }));

  app.post(APP_ROUTES.appSessionRefresh.path, appCall(async (req) => {
    const body = parseBody(AppRefresh, req.body);
    await limited(ctx.platform, APP_LIMITS.refreshesPerAddress.scope, ipOf(req), APP_LIMITS.refreshesPerAddress);
    const outcome = await sessions.rotate(body.refreshToken, { version: req.appRequest.version });
    if (outcome.refused) throw new ApiError('unauthorized', 'Please sign in again.');
    return { body: { accessToken: outcome.accessToken, accessExpiresInSeconds: outcome.accessExpiresInSeconds, refreshToken: outcome.refreshToken } };
  }));

  app.post(APP_ROUTES.appSessionEnd.path, appCall(async (req) => {
    const tokens = await sessions.end(req.appSession, { version: req.appRequest.version });
    return { body: asSession(tokens, null) };
  }));

  // ---- Sign in with Apple (iOS, 4.8): the identity token is for this brand's own bundle id ----
  app.post(APP_ROUTES.appApple.path, appCall(async (req) => {
    const body = parseBody(AppleSignInBody, req.body);
    req.parsedDevice = deviceOf(body);
    const bundleId = req.appRequest.config.ios_bundle_id;
    if (req.appRequest.platform !== 'ios' || !bundleId || !ctx.apple?.signIn) throw new ApiError('not_found', 'This sign-in isn’t available here.');
    await limited(ctx.platform, APP_LIMITS.signInsPerAddress.scope, ipOf(req), APP_LIMITS.signInsPerAddress);
    let who;
    try {
      who = await ctx.apple.signIn.verify(body.identityToken, { nonce: body.nonce, audiences: [bundleId] });
    } catch (err) {
      log.warn('app.apple_refused', { kind: err?.kind ?? 'error' });
      throw new ApiError('unauthorized', 'Sign in with Apple didn’t work. Please try again.');
    }
    const [row] = await ctx.db.query(
      `INSERT INTO shoppers (tenant_id, apple_sub, email, name, last_seen_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, apple_sub) WHERE apple_sub IS NOT NULL DO UPDATE SET last_seen_at = now(),
         email = CASE WHEN shoppers.email = '' THEN EXCLUDED.email ELSE shoppers.email END,
         name = CASE WHEN shoppers.name = '' THEN EXCLUDED.name ELSE shoppers.name END
       RETURNING ${SHOPPER_COLS}`,
      [tenantId(), String(who.sub).slice(0, 255), who.email ?? '', String(body.name ?? '').slice(0, 80)],
    );
    const tokens = await sessions.startForShopper(row, { method: 'apple', ...own(req) });
    await sessions.afterSignIn(row, { method: 'apple' });
    return { status: 201, body: asSession(tokens, row) };
  }));

  // ---- who is signed in, and whether details saved at another store reach this one (9.22) ----
  app.get(APP_ROUTES.appMe.path, appCall(async (req) => {
    const { shared } = services();
    const row = req.appSession.guest ? null : await shopperRow(req.appSession.shopperId);
    const status = row && shared.available ? await shared.status(tenantId(), row.id) : { on: false, since: null };
    return { body: { shopper: appShopper(row), sharedProfile: { available: shared.available, linked: Boolean(status.on), consented: Boolean(status.on && status.since) } } };
  }));

  // ---- deleting the account (App Store 5.1.1(v)): Phase 4's erasure, exactly as the account page's ----
  app.post(APP_ROUTES.appAccountDelete.path, appCall(async (req) => {
    parseBody(AppDeleteBody, req.body);
    const shopperId = req.appSession.shopperId;
    const made = await requestsOf().create({ shopperId, kind: 'erasure', source: 'account', actor: `shopper:${shopperId}` });
    if (!made) throw new ApiError('not_found', 'We couldn’t find your account.');
    const done = made.request.status === 'completed';
    if (done) await sessions.revokeForShopper(shopperId, 'account_deleted');
    return {
      body: {
        status: done ? 'completed' : 'waiting',
        signedOut: done,
        message: done ? 'Your account and personal details were deleted. Tax records of your orders are kept with your details removed.'
          : 'We’ll delete your details as soon as your open orders are complete. Until then, they are only used for those orders.',
      },
    };
  }));

  mountGoogleHandoff(app, ctx);
}

/**
 * Google in the system browser (no app headers): GET /auth/app/google?challenge=<S256 of the app's verifier> sends the browser to
 * Google; the callback makes a single-use hand-off code (60 seconds, bound to that challenge) and sends the browser back to the
 * app's own scheme: <url_scheme>://auth?code=... The app trades the code and its verifier at POST /api/store/app/session.
 */
function mountGoogleHandoff(app, ctx) {
  const { config } = ctx;
  const r = express.Router();
  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const nothing = (res) => res.status(404).set('Cache-Control', 'no-store').type('text').send('Not found.');

  /** The app's scheme when this business has an app it may use; null otherwise. */
  async function schemeOf() {
    const row = await appConfigRow(ctx.db);
    if (!row?.url_scheme) return null;
    const on = await Promise.all([APP_ENTITLEMENTS.android, APP_ENTITLEMENTS.ios].map((f) => ctx.repos.entitlements.can(f)));
    return on.some(Boolean) ? row.url_scheme : null;
  }

  r.get(APP_ROUTES.appGoogleStart.path, route(async (req, res) => {
    const google = shopperServices(ctx).google;
    const challenge = typeof req.query.challenge === 'string' ? req.query.challenge : '';
    const scheme = await schemeOf();
    if (!scheme || !google.configured || !PKCE_CHALLENGE.test(challenge)) return nothing(res);
    const nonce = newToken(16);
    const state = signToken(config, 'app-google-state', { t: tenantId(), n: nonce, c: challenge }, 10 * 60_000);
    res.set('Cache-Control', 'no-store');
    res.cookie(GOOGLE_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: GOOGLE_PATH, maxAge: 10 * 60_000 });
    return res.redirect(302, google.authorizeUrl({ redirectUri: `${originOf(req)}${APP_ROUTES.appGoogleCallback.path}`, state, nonce }));
  }));

  r.get(APP_ROUTES.appGoogleCallback.path, route(async (req, res) => {
    const { google, service } = shopperServices(ctx);
    const scheme = await schemeOf();
    if (!scheme) return nothing(res);
    res.set('Cache-Control', 'no-store');
    const state = readToken(config, 'app-google-state', typeof req.query.state === 'string' ? req.query.state : '');
    const nonce = readCookie(req, GOOGLE_COOKIE);
    res.clearCookie(GOOGLE_COOKIE, { path: GOOGLE_PATH });
    const back = (problem) => res.redirect(303, `${scheme}://auth?error=${problem}`);
    if (!state || state.t !== tenantId() || !nonce || !safeEqual(nonce, state.n) || !PKCE_CHALLENGE.test(String(state.c ?? ''))) return back('expired');
    if (req.query.error || typeof req.query.code !== 'string') return back('cancelled');
    let who;
    try {
      who = await google.signIn({ code: req.query.code, redirectUri: `${originOf(req)}${APP_ROUTES.appGoogleCallback.path}`, nonce: state.n });
    } catch (err) {
      log.warn('app.google_failed', { kind: err?.kind ?? 'error' });
      return back('failed');
    }
    const shopper = await service.shoppers.forGoogle(who);
    const code = newToken(32);
    await ctx.db.query(
      `INSERT INTO shopper_app_handoffs (tenant_id, code_hash, shopper_id, method, challenge, expires_at) VALUES ($1, $2, $3, 'google', $4, now() + make_interval(secs => $5::int))`,
      [tenantId(), tokenHash(code), shopper.id, state.c, HANDOFF_SECONDS],
    );
    return res.redirect(303, `${scheme}://auth?code=${encodeURIComponent(code)}`);
  }));

  app.use(r);
}

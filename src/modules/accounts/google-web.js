import crypto from 'node:crypto';
import express from 'express';
import { newToken } from '../../contracts/accounts.js';
import { AUTH_PATHS, GoogleStartQuery, OAuthCallbackQuery, OWNER_APP_CALLBACK } from '../../contracts/api/index.js';
import { platformAppHostOf } from '../../config.js';
import { log } from '../../platform/log.js';
import { normalizeHost } from '../../tenancy.js';
import { signInPage } from './web.js';

const STATE_COOKIE = 'bhava_gstate';
const STATE_PATH = '/auth/google';
const STATE_MS = 10 * 60_000;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const mac = (secret, data) => crypto.createHmac('sha256', String(secret)).update(data).digest('base64url');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Seller sign-in in a browser (PRD 5.11, 10.3; AUTH_PATHS), on PLATFORM_APP_HOST only, outside /api/v1. Google's page
 * is the only page in the flow that is not ours.
 *
 * The state is signed with the server secret together with this browser's httpOnly cookie, set at the start, which
 * carries the target, purpose, challenge and the page to open next. It lives ten minutes and is spent by its first callback
 * (platform.rateLimit, so across every process). The ID token's nonce is derived from it. A refusal goes back the same
 * way with ?error=denied|failed|expired and never says whether an account exists.
 *
 *   target app   the callback writes a hand-off code bound to the challenge and sends the browser to the app's scheme
 *   target web   the callback opens the console's cookie session here and goes to /admin (or `next`)
 *   purpose link the callback writes a hand-off code for auth.linkIdentity, for either target (a challenge is needed)
 */
export function googleWebRoutes(app, ctx, { people, handoffs, opener }) {
  const appHost = platformAppHostOf(ctx.config);
  const secret = () => ctx.config.sessionSecret;
  const google = () => ctx.google.signIn;
  const nonceFor = (id) => mac(secret(), `google-nonce:${id}`);
  // The one redirect address registered with Google: the sign-in host's own callback.
  const callbackUrl = (req) => `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}${AUTH_PATHS.googleCallback}`;
  const onAppHost = (req) => Boolean(appHost) && normalizeHost(req.hostname) === appHost;

  // Google hands the state back in the address, and the callback takes at most 200 characters of it: the state is an id
  // and a MAC, and what it stands for rides in this browser's httpOnly cookie, covered by the same MAC.
  function sealState(payload) {
    const cookie = `${newToken(16)}~${b64(payload)}`;
    return { cookie, state: `${payload.i}.${mac(secret(), `${payload.i}.${cookie}`)}` };
  }

  function openState(state, cookie) {
    if (typeof state !== 'string' || !cookie) return null;
    const [id, signature] = state.split('.');
    if (!id || !signature) return null;
    const expected = mac(secret(), `${id}.${cookie}`);
    if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
    try {
      const payload = JSON.parse(Buffer.from(cookie.split('~')[1] ?? '', 'base64url').toString());
      return payload && payload.i === id && Number(payload.e) > Date.now() ? payload : null;
    } catch {
      return null;
    }
  }

  function back(res, state, error) {
    if (state?.t === 'app') return res.redirect(303, `${OWNER_APP_CALLBACK}?error=${error}`);
    return res.redirect(303, `${AUTH_PATHS.signIn}?error=${error}`);
  }

  const withQuery = (path, key, value) => `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;

  const r = express.Router();
  r.use((req, res, next) => (onAppHost(req) ? next() : next('router')));

  r.get(AUTH_PATHS.signIn, (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'" });
    res.type('html').send(signInPage({ google: google().configured, error: typeof req.query.error === 'string' ? req.query.error : '' }));
  });

  r.get(AUTH_PATHS.googleStart, (req, res) => {
    const query = GoogleStartQuery.safeParse(req.query);
    if (!query.success || (query.data.purpose === 'link' && !query.data.challenge)) {
      return res.status(400).type('text').send('That sign-in link is not complete. Go back and try again.');
    }
    const { target, purpose, challenge, next } = query.data;
    if (!google().configured) return back(res, { t: target }, 'failed');
    const id = newToken(16);
    const { cookie, state } = sealState({ i: id, t: target, p: purpose, c: challenge ?? '', n: next ?? '', e: Date.now() + STATE_MS });
    res.cookie(STATE_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: STATE_PATH, maxAge: STATE_MS });
    res.set('Cache-Control', 'no-store');
    return res.redirect(303, google().authorizeUrl({ redirectUri: callbackUrl(req), state, nonce: nonceFor(id) }));
  });

  r.get(AUTH_PATHS.googleCallback, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const query = OAuthCallbackQuery.safeParse(req.query);
      const state = openState(query.success ? query.data.state : '', readCookie(req, STATE_COOKIE));
      res.clearCookie(STATE_COOKIE, { path: STATE_PATH });
      if (!state) return back(res, null, 'expired');
      const once = await ctx.platform.rateLimit.hit('seller_google_state', state.i, { limit: 1, windowMs: 2 * STATE_MS });
      if (!once.allowed) return back(res, state, 'expired');
      if (query.data.error || !query.data.code) return back(res, state, 'denied');

      let who;
      try {
        who = await google().signIn({ code: query.data.code, redirectUri: callbackUrl(req), nonce: nonceFor(state.i) });
      } catch (err) {
        log.warn('accounts.google_refused', { kind: err?.kind ?? 'error' });
        return back(res, state, 'failed');
      }
      const { personId } = await people.findOrMake({ kind: 'google', subject: who.sub, email: who.emailVerified ? who.email : '', name: who.name });

      if (state.t === 'app' || state.p === 'link') {
        if (!state.c) return back(res, state, 'failed');
        const code = await handoffs.create({ personId, challenge: state.c, purpose: state.p });
        if (state.t === 'app') return res.redirect(303, `${OWNER_APP_CALLBACK}?code=${encodeURIComponent(code)}`);
        return res.redirect(303, withQuery(state.n || '/admin', 'linkCode', code));
      }
      try {
        await opener.open({ req, res, personId, transport: 'cookie', via: 'google', checkOrigin: false });
      } catch (err) {
        if (err?.name !== 'ApiError') throw err;
        log.warn('accounts.google_web_refused', { code: err.code });
        return back(res, state, 'failed');
      }
      return res.redirect(303, state.n || '/admin');
    } catch (err) {
      return next(err);
    }
  });

  app.use(r);
}

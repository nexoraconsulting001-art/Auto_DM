import crypto from 'node:crypto';
import { ApiError, isApiV1Url } from './contracts/api/index.js';
import { sendApiError } from './modules/api-v1/respond.js';
import { withTenant } from './tenancy.js';

const COOKIE = 'sid';
const PLATFORM_COOKIE = 'psid';
const SESSION_DAYS = 30;
const PLATFORM_SESSION_DAYS = 7;
const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES = 10;

const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    // A cookie that cannot be decoded is no session, never a server fault.
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return '';
    }
  }
  return '';
}

/** The token in "Authorization: Bearer <token>", or null when the request has none. */
const bearerToken = (req) => /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')?.[1] ?? null;

export const safeNext = (n, fallback = '/') =>
  typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(n) && !n.startsWith('/login') ? n : fallback;

/**
 * True when a request that opens a session came from this site: it names no origin (an app, a test, a form from an old
 * browser) or names this very host. A sign-in has no session yet, so this stands in for the CSRF token.
 */
export function isSameOrigin(req) {
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

/** Login forms have no session yet, so instead of a CSRF token they must come from this site. */
export function sameOriginOnly(req, res, next) {
  if (!isSameOrigin(req)) return res.status(403).send('Please log in from this website.');
  next();
}

/** Failed-login counting in the cache module, so the limit holds across several web servers. */
function loginLimiter(cache, prefix) {
  const key = (req) => `${prefix}:${req.ip}`;
  return {
    async tooManyAttempts(req) {
      return ((await cache.get(key(req)))?.n || 0) >= MAX_FAILURES;
    },
    async recordFailure(req) {
      const now = Date.now();
      const a = (await cache.get(key(req))) || { n: 0, reset: now + WINDOW_SECONDS * 1000 };
      a.n++;
      await cache.set(key(req), a, Math.max(1, (a.reset - now) / 1000));
    },
    clearFailures: (req) => cache.del(key(req)),
  };
}

/**
 * Sessions for a business's own people. How someone proves who they are is not decided here: sellers sign in without
 * passwords (src/modules/accounts), and the Phase 0 phone + password login exists only while PASSWORD_LOGIN is on.
 * The cookie holds a random session token; the session itself lives in the
 * database (see repos/sessions.js), so it works across web servers and can be revoked.
 * Every POST made with a cookie session must carry a CSRF token derived from the session.
 *
 * The API and mobile app send "Authorization: Bearer <token>" instead: the owner app's access token (PRD 10.2), or the
 * Phase 0 30-day token while PASSWORD_LOGIN is on. The token alone says which user and which business, before the web
 * address is looked at, and CSRF does not apply. The server then refuses a token that arrives on another business's
 * own address. Either way req.session says what kind of session it is and whether its last re-auth is still fresh.
 *
 * Sign-in methods (Google, WhatsApp code, Sign in with Apple) plug in by verifying the person and then
 * calling login(); nothing else here depends on how they proved who they are.
 */
export function createAuth({ secret, users, sessions, tenants, cache, passwordLogin = false }) {
  const limiter = loginLimiter(cache, 'login-attempts');
  const notLoggedIn = (res) => res.status(401).json({ error: 'Please log in again.', code: 'unauthorized' });
  // The app's access tokens always; the Phase 0 30-day token only while PASSWORD_LOGIN is on.
  const bearerKinds = passwordLogin ? ['access', 'bearer'] : ['access'];
  const csrfFor = (token) => hmac(secret, `csrf:${token}`);
  /** What the router reads for routes marked fresh, and what a handler needs to end or refresh this session. */
  const describe = (kind, found) => ({ kind, familyId: found.familyId ?? null, deviceId: found.deviceId ?? null, fresh: Boolean(found.fresh), freshUntil: found.freshUntil ?? null });

  return {
    ...limiter,
    notLoggedIn,

    /** Bearer sessions: sets the current business and user from the token. A bad token is refused, never treated as a guest. */
    async bearer(req, res, next) {
      const token = bearerToken(req);
      if (token === null) return next();
      const session = await tenants.findSession(token, bearerKinds);
      if (!session) return notLoggedIn(res);
      return withTenant(session.tenant, async () => {
        const user = await users.get(session.userId);
        if (!user) return notLoggedIn(res);
        Object.assign(req, { user, bearer: true, sessionToken: token, csrf: '', session: describe(session.kind, session) });
        Object.assign(res.locals, { user, csrf: '' });
        next();
      });
    },

    /** Loads the logged-in user (if any) into req.user / res.locals.user, and the CSRF token. */
    async load(req, res, next) {
      if (req.bearer) return next();
      const token = readCookie(req, COOKIE);
      const signedIn = (user, found) => {
        req.user = user;
        req.sessionToken = user ? token : '';
        req.csrf = user ? csrfFor(token) : '';
        req.session = user ? describe('cookie', found) : null;
        res.locals.user = req.user;
        res.locals.csrf = req.csrf;
        next();
      };
      // On the host that belongs to no business (PLATFORM_APP_HOST) the cookie session names its own business, as a token does.
      if (req.appHost) {
        const found = token ? await tenants.findSession(token, ['cookie']) : null;
        if (!found) return signedIn(null);
        return withTenant(found.tenant, async () => signedIn(await users.get(found.userId), found));
      }
      const found = token ? await sessions.find(token) : null;
      signedIn(found ? await users.get(found.userId) : null, found);
    },

    /** Rejects POSTs from a cookie session that lack the session's CSRF token. */
    checkCsrf(req, res, next) {
      if (req.method === 'GET' || req.method === 'HEAD' || !req.user || req.bearer) return next();
      const sent = req.get('x-csrf-token') || req.body?._csrf || '';
      if (safeEqual(sent, req.csrf)) return next();
      if (isApiV1Url(req.originalUrl)) return sendApiError(new ApiError('forbidden', 'This session expired. Refresh and try again.'), req, res);
      res.status(403).send('This form expired. Go back, refresh the page and try again.');
    },

    /**
     * Starts a cookie session for `user` in the current business and returns its CSRF token. A sign-in without a password
     * passes its refresh family and device, so revoking either ends this session too. Signing in never clears the
     * failed-password count: that count is per address, and one's own good password says nothing about guesses at another's.
     */
    async login(req, res, user, { familyId = null, deviceId = null } = {}) {
      const token = await sessions.create(user.id, SESSION_DAYS, 'cookie', { familyId, deviceId });
      res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        path: '/',
        maxAge: SESSION_DAYS * 86_400_000,
      });
      return csrfFor(token);
    },

    async logout(req, res) {
      if (req.sessionToken) await sessions.revoke(req.sessionToken);
      res.clearCookie(COOKIE, { path: '/' });
    },

    requireUser(req, res, next) {
      if (req.user) return next();
      if (req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return res.status(401).json({ error: 'Please log in again.' });
    },

    /** Lets through only these business roles; everyone else goes to their account or the login page. */
    requireRole(...roles) {
      return (req, res, next) => {
        if (roles.includes(req.user?.role)) return next();
        if (req.method !== 'GET') return res.status(req.user ? 403 : 401).json({ error: 'You don’t have access to this.' });
        if (req.user) return res.redirect('/account');
        return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      };
    },
  };
}

/**
 * Sessions for Bhava's own team, kept apart from business sessions: another table, another cookie.
 * Mounted only on the platform host. Sign-in methods (email OTP and TOTP, PRD 5.5) plug in as in createAuth.
 */
export function createPlatformAuth({ secret, platformUsers, cache }) {
  const limiter = loginLimiter(cache, 'platform-login-attempts');
  const csrfFor = (token) => hmac(secret, `platform-csrf:${token}`);

  return {
    ...limiter,

    async load(req, _res, next) {
      const token = readCookie(req, PLATFORM_COOKIE);
      req.platformUser = token ? await platformUsers.userForSession(token) : null;
      req.platformSessionToken = req.platformUser ? token : '';
      req.platformCsrf = req.platformUser ? csrfFor(token) : '';
      next();
    },

    checkCsrf(req, res, next) {
      if (req.method === 'GET' || req.method === 'HEAD' || !req.platformUser) return next();
      if (!safeEqual(req.get('x-csrf-token') || req.body?._csrf || '', req.platformCsrf)) return res.status(403).json({ error: 'This session expired. Refresh and try again.' });
      next();
    },

    /** Starts a session and returns its CSRF token. */
    async login(req, res, user) {
      await limiter.clearFailures(req);
      const token = await platformUsers.createSession(user.id, PLATFORM_SESSION_DAYS);
      res.cookie(PLATFORM_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure,
        path: '/',
        maxAge: PLATFORM_SESSION_DAYS * 86_400_000,
      });
      return csrfFor(token);
    },

    async logout(req, res) {
      if (req.platformSessionToken) await platformUsers.revokeSession(req.platformSessionToken);
      res.clearCookie(PLATFORM_COOKIE, { path: '/' });
    },
  };
}

/** Guards a platform route. Only the platform host loads a platform user, so anywhere else this always refuses. */
export const requirePlatformRole = (...roles) => (req, res, next) => {
  if (!req.platformUser) return res.status(401).json({ error: 'Please sign in.' });
  if (!roles.includes(req.platformUser.role)) return res.status(403).json({ error: 'You don’t have access to this.' });
  next();
};

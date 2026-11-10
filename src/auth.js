import crypto from 'node:crypto';
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
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

/** The token in "Authorization: Bearer <token>", or null when the request has none. */
const bearerToken = (req) => /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')?.[1] ?? null;

export const safeNext = (n, fallback = '/') =>
  typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(n) && !n.startsWith('/login') ? n : fallback;

/** Login forms have no session yet, so instead of a CSRF token they must come from this site. */
export function sameOriginOnly(req, res, next) {
  const origin = req.get('origin') || req.get('referer') || '';
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).send('Please log in from this website.');
    } catch {
      return res.status(403).send('Please log in from this website.');
    }
  }
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
 * One login per business site. Shoppers and the owner sign in with phone + password; business roles are
 * owner, staff and customer. The cookie holds a random session token; the session itself lives in the
 * database (see repos/sessions.js), so it works across web servers and can be revoked.
 * Every POST made with a cookie session must carry a CSRF token derived from the session.
 *
 * The API and mobile app send "Authorization: Bearer <token>" instead. The token alone says which user
 * and which business, before and regardless of the web address, and CSRF does not apply.
 *
 * Sign-in methods (Google, WhatsApp code, Sign in with Apple) plug in by verifying the person and then
 * calling login(); nothing else here depends on how they proved who they are.
 */
export function createAuth({ secret, users, sessions, tenants, cache }) {
  const limiter = loginLimiter(cache, 'login-attempts');
  const notLoggedIn = (res) => res.status(401).json({ error: 'Please log in again.' });

  return {
    ...limiter,

    /** Bearer sessions: sets the current business and user from the token. A bad token is refused, never treated as a guest. */
    async bearer(req, res, next) {
      const token = bearerToken(req);
      if (token === null) return next();
      const session = await tenants.findBearerSession(token);
      if (!session) return notLoggedIn(res);
      return withTenant(session.tenant, async () => {
        const user = await users.get(session.userId);
        if (!user) return notLoggedIn(res);
        Object.assign(req, { user, bearer: true, sessionToken: token, csrf: '' });
        Object.assign(res.locals, { user, csrf: '' });
        next();
      });
    },

    /** Loads the logged-in user (if any) into req.user / res.locals.user, and the CSRF token. */
    async load(req, res, next) {
      if (req.bearer) return next();
      const token = readCookie(req, COOKIE);
      const userId = token ? await sessions.userIdFor(token) : null;
      req.user = userId ? await users.get(userId) : null;
      req.sessionToken = req.user ? token : '';
      req.csrf = req.user ? hmac(secret, `csrf:${token}`) : '';
      res.locals.user = req.user;
      res.locals.csrf = req.csrf;
      next();
    },

    /** Rejects POSTs from a cookie session that lack the session's CSRF token. */
    checkCsrf(req, res, next) {
      if (req.method === 'GET' || req.method === 'HEAD' || !req.user || req.bearer) return next();
      const sent = req.get('x-csrf-token') || req.body?._csrf || '';
      if (!safeEqual(sent, req.csrf)) return res.status(403).send('This form expired. Go back, refresh the page and try again.');
      next();
    },

    async login(req, res, user) {
      await limiter.clearFailures(req);
      const token = await sessions.create(user.id, SESSION_DAYS);
      res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        path: '/',
        maxAge: SESSION_DAYS * 86_400_000,
      });
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

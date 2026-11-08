import crypto from 'node:crypto';

const COOKIE = 'sid';
const SESSION_DAYS = 30;

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

export const safeNext = (n, fallback = '/') =>
  typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(n) && !n.startsWith('/login') ? n : fallback;

/**
 * One login per business site. Shoppers and the owner sign in with phone + password; the owner's
 * account has role "admin". The cookie holds a random session token; the session itself lives in the
 * database (see repos/sessions.js), so it works across web servers and can be revoked.
 * Every POST made while logged in must carry a CSRF token derived from the session.
 *
 * Sign-in methods (Google, WhatsApp code, Sign in with Apple) plug in by verifying the person and then
 * calling login(); nothing else here depends on how they proved who they are.
 */
export function createAuth({ secret, users, sessions, cache }) {
  // Failed-login counts live in the cache module, so the limit holds across several web servers.
  const attemptsKey = (req) => `login-attempts:${req.ip}`;
  const WINDOW_SECONDS = 15 * 60;

  return {
    /** Loads the logged-in user (if any) into req.user / res.locals.user, and the CSRF token. */
    async load(req, res, next) {
      const token = readCookie(req, COOKIE);
      const userId = token ? await sessions.userIdFor(token) : null;
      req.user = userId ? await users.get(userId) : null;
      req.sessionToken = req.user ? token : '';
      req.csrf = req.user ? hmac(secret, `csrf:${token}`) : '';
      res.locals.user = req.user;
      res.locals.csrf = req.csrf;
      next();
    },

    /** Rejects logged-in POSTs that lack the session's CSRF token. */
    checkCsrf(req, res, next) {
      if (req.method === 'GET' || req.method === 'HEAD' || !req.user) return next();
      const sent = req.get('x-csrf-token') || req.body?._csrf || '';
      if (!safeEqual(sent, req.csrf)) return res.status(403).send('This form expired. Go back, refresh the page and try again.');
      next();
    },

    /** Login rate limit: 10 failed tries per IP per 15 minutes. */
    async tooManyAttempts(req) {
      return ((await cache.get(attemptsKey(req)))?.n || 0) >= 10;
    },
    async recordFailure(req) {
      const now = Date.now();
      const a = (await cache.get(attemptsKey(req))) || { n: 0, reset: now + WINDOW_SECONDS * 1000 };
      a.n++;
      await cache.set(attemptsKey(req), a, Math.max(1, (a.reset - now) / 1000));
    },

    async login(req, res, user) {
      await cache.del(attemptsKey(req));
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

    requireAdmin(req, res, next) {
      if (req.user?.role === 'admin') return next();
      if (req.method !== 'GET') return res.status(req.user ? 403 : 401).json({ error: 'Only the store owner can do this.' });
      if (req.user) return res.redirect('/account');
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    },
  };
}

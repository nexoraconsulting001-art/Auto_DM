import { SHOPPER_COOKIE } from '../../contracts/store-routes.js';
import { csrfFor, readCookie, safeEqual } from './keys.js';
import { SESSION_DAYS } from './service.js';

/**
 * The shopper's sign-in on a request (PRD 9.3). A shopper is never a seller: this reads only SHOPPER_COOKIE and the
 * shopper_sessions table, and sets only req.shopper. req.user (the seller's session, src/auth.js) is never touched, so no
 * shopper session can reach a seller route, an /api/v1 call or the console, whatever number it was opened with.
 *
 * What a later module reads:
 *   req.shopper        { id, name, phone, email, hasGoogle, phoneVerified, method } or null; also res.locals.shopper
 *   req.shopperCsrf    the CSRF token for this session ('' with none); also res.locals.shopperCsrf
 *
 * A POST, PUT, PATCH or DELETE that carries a shopper session must carry its CSRF token, as x-shopper-csrf (or
 * x-csrf-token, or a _shopper_csrf or _csrf form field), on the store's own JSON calls (/api/store/...) and on this
 * module's own forms. A page with both a seller and a shopper session sends both tokens: x-csrf-token for the seller's
 * check in src/auth.js and x-shopper-csrf for this one. Seller routes are left to src/auth.js, so an owner testing their
 * own store as a shopper can still use the console.
 */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const GUARDED = /^\/(api\/store\/|logout$|account(\/|$)|auth\/|unsubscribe\/)/;

export function sessionCookie(req, res, token) {
  res.cookie(SHOPPER_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: SESSION_DAYS * 86_400_000 });
}

export function clearSessionCookie(res) {
  res.clearCookie(SHOPPER_COOKIE, { path: '/' });
}

/** The token a request sent, by header or form field. */
function sentToken(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const pick = (v) => (typeof v === 'string' ? v : '');
  return [pick(req.get('x-shopper-csrf')), pick(req.get('x-csrf-token')), pick(body._shopper_csrf), pick(body._csrf)].filter(Boolean);
}

export function shopperSession({ config }, service) {
  return async (req, res, next) => {
    // The shopper app's gate (src/modules/app-api/gate.js) already decided who an app request is: no cookie replaces it and no CSRF applies.
    if (req.appSession) return next();
    try {
      req.shopper = null;
      req.shopperToken = '';
      req.shopperCsrf = '';
      const token = readCookie(req, SHOPPER_COOKIE);
      const shopper = token ? await service.sessions.shopperFor(token) : null;
      if (shopper) {
        req.shopper = shopper;
        req.shopperToken = token;
        req.shopperCsrf = csrfFor(config, token);
      }
      res.locals.shopper = req.shopper;
      res.locals.shopperCsrf = req.shopperCsrf;

      if (req.shopper && UNSAFE.has(req.method) && GUARDED.test(req.path)) {
        const ok = sentToken(req).some((sent) => safeEqual(sent, req.shopperCsrf));
        if (!ok) {
          if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'This page expired. Refresh it and try again.', code: 'forbidden' });
          return res.status(403).type('text').send('This form expired. Go back, refresh the page and try again.');
        }
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** For JSON calls made with no session yet (sending and checking a code): the request must come from this store's own pages. */
export function sameSiteOnly(req, res, next) {
  const origin = req.get('origin') || req.get('referer') || '';
  if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Please use the store’s own page.', code: 'forbidden' });
  if (origin) {
    try {
      const host = req.get('x-forwarded-host') || req.get('host');
      if (new URL(origin).host !== host) return res.status(403).json({ error: 'Please use the store’s own page.', code: 'forbidden' });
    } catch {
      return res.status(403).json({ error: 'Please use the store’s own page.', code: 'forbidden' });
    }
  }
  return next();
}

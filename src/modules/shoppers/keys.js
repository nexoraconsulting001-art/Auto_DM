import crypto from 'node:crypto';
import { normalizePhone } from '../../util.js';

/**
 * Hashes and signed tokens for shoppers and consent (PRD 9.3, 9.18, 9.22). A phone number, an email address, a one-time
 * code and a session token are stored only as keyed hashes: someone who reads the tables cannot work the value back, and
 * cannot test a guess without the key. The key comes from DATA_KEY (the long-lived secret that also encrypts tokens), so
 * the consent ledger still matches after SESSION_SECRET changes; without DATA_KEY it falls back to the session secret.
 *
 * A hash is scoped by what it is for and, for business data, by the business: the same number at two businesses hashes to
 * two values that cannot be joined (S-11, S-104).
 */
const keyCache = new WeakMap();
function keyOf(config) {
  let key = keyCache.get(config);
  if (!key) {
    const secret = config.dataKey || config.sessionSecret;
    if (!secret) throw new Error('Shopper hashing needs DATA_KEY or SESSION_SECRET');
    key = crypto.createHash('sha256').update(`shopper-hash-key\n${secret}`).digest();
    keyCache.set(config, key);
  }
  return key;
}

/** HMAC-SHA256 of `value`, as 64 hex characters. `scope` says what it is for, such as `phone:12` or `otp:12:881`. */
export const keyedHash = (config, scope, value) => crypto.createHmac('sha256', keyOf(config)).update(`${scope}\n${value}`).digest('hex');

/** A session token's stored form. The token itself is 32 random bytes, so a plain hash is enough. */
export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** "+919876543210" from what a person typed, or null. An Indian mobile number may come without its country code. */
export function toE164(value) {
  const typed = String(value ?? '').trim().replace(/[\s().-]/g, '');
  if (/^\+[1-9][0-9]{7,14}$/.test(typed)) return typed;
  const local = normalizePhone(typed);
  return local ? `+91${local}` : null;
}

export const normalEmail = (value) => String(value ?? '').trim().toLowerCase();

/** "+91 ••••• ••210": enough for a person to recognise their own number, and no use to anyone else. */
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '');
  return digits.length < 6 ? '' : `••••• ••${digits.slice(-3)}`;
}

/**
 * A short-lived signed value: base64url(JSON) + "." + HMAC. `kind` separates one use from another, so a ticket made for one
 * step is refused at any other. Returns null for anything that is not ours, was changed, or has expired.
 */
export function signToken(config, kind, payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', keyOf(config)).update(`token:${kind}\n${body}`).digest('base64url')}`;
}

export function readToken(config, kind, token) {
  const [body, mac, extra] = String(token ?? '').split('.');
  if (!body || !mac || extra !== undefined || body.length > 4000) return null;
  const expected = crypto.createHmac('sha256', keyOf(config)).update(`token:${kind}\n${body}`).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload && typeof payload === 'object' && Number(payload.exp) > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

/** The CSRF token of a shopper session: derived from its token, so it changes with every sign-in and means nothing without the cookie. */
export const csrfFor = (config, token) => crypto.createHmac('sha256', keyOf(config)).update(`shopper-csrf\n${token}`).digest('base64url');

/** The address the browser is on: scheme and host as the proxy passed them. Used for redirects that must come back here. */
export const originOf = (req) => `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;

/** A string field from a parsed body, or '' for anything else (an object, an array, a missing body). */
export const field = (body, name, max = 200) => {
  const value = body && typeof body === 'object' ? body[name] : undefined;
  return typeof value === 'string' ? value.slice(0, max) : '';
};

export function readCookie(req, name) {
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return '';
      }
    }
  }
  return '';
}

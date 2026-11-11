import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/errors.js';
import { SHOPPER_COOKIE } from '../../contracts/store-routes.js';
import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { OrderStateError } from '../orders/state.js';

/**
 * What the buyer's store shares (PRD 9.1 to 9.5): whether this business has the store, who the shopper is, one error shape
 * for the JSON calls under /api/store, and the check that a write came from this store's own page.
 *
 * The store is Tier 3 (`store.checkout`, plan data in migration 004): a business without it keeps the Phase 0 store pages,
 * which still answer from each module's legacy.js.
 *
 * The shopper. The shoppers module owns sign-in. Until it loads the shopper itself (it may set `req.shopper`), the session
 * cookie is looked up here: SHOPPER_COOKIE holds a random token, and shopper_sessions holds its SHA-256. A session of
 * another business never matches, because the lookup is inside the current one.
 */
export const STORE_FEATURE = 'store.checkout';

/** True when this business has the Phase 4 store. Read per request: a plan change applies at once. */
export async function storeOn(repos) {
  try {
    return Boolean(await repos.entitlements.can(STORE_FEATURE));
  } catch (err) {
    reportError(err, { msg: 'store.entitlement_failed' });
    return false;
  }
}

const readCookie = (req, name) => {
  for (const part of String(req?.headers?.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return ''; // a badly encoded cookie is no session, never a server error
      }
    }
  }
  return '';
};

const toShopper = (row) => ({ id: row.id, phone: row.phone ?? '', phoneVerified: Boolean(row.phone_verified_at), email: row.email ?? '', name: row.name ?? '' });

export async function shopperFrom(req, db) {
  if (req.shopper !== undefined) return req.shopper?.id ? req.shopper : null;
  req.shopper = null;
  const token = readCookie(req, SHOPPER_COOKIE);
  if (!token || token.length < 20 || token.length > 200) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const [row] = await db.query(
    `SELECT s.id, s.phone, s.phone_verified_at, s.email, s.name
     FROM shopper_sessions x JOIN shoppers s ON s.tenant_id = x.tenant_id AND s.id = x.shopper_id
     WHERE x.tenant_id = $1 AND x.token_hash = $2 AND x.revoked_at IS NULL AND x.expires_at > now() AND s.erased_at IS NULL`,
    [tenantId(), hash],
  );
  req.shopper = row ? toShopper(row) : null;
  return req.shopper;
}

/** A write must come from a page of this store: a browser says where a request came from, and another site's is refused. */
function fromThisStore(req) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).hostname.toLowerCase() !== String(req.hostname ?? '').toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  const site = req.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

/** Parses a body with its strict schema: an unknown field (a price, a total) is refused, never ignored (S-05). */
export function parseBody(schema, value) {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const fields = {};
  for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys') for (const key of issue.keys ?? []) fields[[...issue.path, key].join('.')] ??= 'This isn’t something the page may send';
    else fields[issue.path.join('.') || '_'] ??= issue.message;
  }
  const first = parsed.error.issues[0];
  throw new ApiError('validation_failed', first?.code === 'unrecognized_keys' || !first?.message ? 'Please check the details and try again.' : first.message, { fields });
}

/** An email longer than any real one is refused before a pattern ever looks at it. */
export function checkEmailLength(body) {
  if (typeof body?.email === 'string' && body.email.length > 254) throw new ApiError('validation_failed', 'Enter a valid email', { fields: { email: 'Enter a valid email' } });
}

export function sendStoreError(err, req, res) {
  if (err instanceof ApiError) {
    if (err.retryAfterMs) res.set('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}), ...(err.quote ? { quote: err.quote } : {}) });
  }
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message, code: 'validation_failed', ...(err.fields ? { fields: err.fields } : {}) });
  if (err instanceof OrderStateError) {
    const missing = err.code === 'not_found';
    return res.status(missing ? 404 : 409).json({ error: missing ? 'We couldn’t find that order.' : 'That can’t be done with this order now.', code: missing ? 'not_found' : 'conflict' });
  }
  reportError(err, { msg: 'store.call_failed', path: req.route?.path ?? '' });
  return res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'internal' });
}

/**
 * Wraps a JSON call: handler(req, res) returns { status?, body }, or null for "this business has no store here", which is a
 * 404 like any address that isn't there. Answers are never cached. The shopper is loaded before the handler runs.
 */
export const storeCall = (ctx, handler) => async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!req.is('application/json')) throw new ApiError('unsupported_media_type', 'Send this as JSON.');
      if (!fromThisStore(req)) throw new ApiError('forbidden', 'This request didn’t come from the store’s own page.');
    }
    if (!(await storeOn(ctx.repos))) throw new ApiError('not_found', 'There is nothing here.');
    await shopperFrom(req, ctx.db);
    const out = await handler(req, res);
    if (out) res.status(out.status ?? 200).json(out.body);
  } catch (err) {
    sendStoreError(err, req, res);
  }
};

/** One limit on a call, across every instance (platform.rateLimit). */
export async function limited(platform, scope, subject, limit) {
  const hit = await platform.rateLimit?.hit(scope, subject, limit);
  if (hit && !hit.allowed) {
    const err = new ApiError('rate_limited', 'Too many attempts. Please wait a few minutes and try again.');
    err.retryAfterMs = hit.retryAfterMs;
    throw err;
  }
}

/** The rest of a request's address after a leading `/`, safe to put in a link back. */
export const backTo = (req) => (String(req.originalUrl ?? '/').startsWith('/') && !String(req.originalUrl).startsWith('//') ? String(req.originalUrl).slice(0, 300) : '/');

import express from 'express';
import { ANALYTICS_LIMITS as L, REPORTING_BASE_PATH } from '../../contracts/analytics.js';
import { ApiError, ExploreFilter, ExploreRequest, IdParams, reportingRouteList } from '../../contracts/api/index.js';
import { currentRequestId, log } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { readCursor, writeCursor } from '../admin-api/paging.js';
import { sendApiError } from '../api-v1/respond.js';
import { servicesFor as trafficServices } from '../traffic/services.js';
import { REPORTING_STATUSES } from './business.js';
import { safeZone } from './clock.js';
import { findKey, touchKey } from './api-keys.js';

/**
 * The reporting API (7.13): read-only, summary figures only, the metrics, breakdowns and filters of Explore, cursor paging and ISO dates in the
 * business's time zone. A key, never a session, says who is calling; the key alone names the business, so a call for any other business id is
 * not found, and is logged. 60 calls a minute per key, then 429 with Retry-After.
 */
const MINUTE_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;
const OWNER_VIEW = Object.freeze({ role: 'owner' });

/**
 * At most `limit` calls in any 60 seconds, per key. Checked and counted in one synchronous step, so calls arriving together can't all slip past.
 * This holds per web process: the cache interface has no atomic increment to share it between servers.
 */
export function createRateLimiter({ limit = L.apiRequestsPerMinute, windowMs = MINUTE_MS, clock = Date.now } = {}) {
  const calls = new Map();
  return {
    take(id) {
      const at = clock();
      const recent = (calls.get(id) ?? []).filter((t) => t > at - windowMs);
      if (recent.length >= limit) {
        calls.set(id, recent);
        return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + windowMs - at) / 1000)) };
      }
      recent.push(at);
      calls.delete(id);
      calls.set(id, recent);
      if (calls.size > MAX_TRACKED_KEYS) calls.delete(calls.keys().next().value);
      return { ok: true, remaining: limit - recent.length };
    },
  };
}

const keyFrom = (req) => {
  const header = req.get('x-api-key');
  if (header) return header.trim();
  return /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')?.[1] ?? null;
};

function fieldErrors(issues) {
  const fields = {};
  for (const issue of issues) fields[issue.path.join('.') || '_'] ??= issue.message;
  return fields;
}

function invalid(issues) {
  const fields = fieldErrors(issues);
  const messages = Object.values(fields);
  return new ApiError('validation_failed', messages.length === 1 ? messages[0] : 'Please check the highlighted details.', { fields });
}

/** filter=source:exclude:direct, or dimension:include:a,b. Repeat the parameter for more than one; they are AND-ed. */
function parseFilters(raw) {
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.map((text) => {
    const first = text.indexOf(':');
    const second = first < 0 ? -1 : text.indexOf(':', first + 1);
    if (first < 0 || second < 0) throw new ApiError('validation_failed', 'Write a filter as dimension:include:value or dimension:exclude:value.', { fields: { filter: 'Invalid filter' } });
    const parsed = ExploreFilter.safeParse({ dimension: text.slice(0, first), op: text.slice(first + 1, second), values: text.slice(second + 1).split(',').map((v) => v.trim()).filter(Boolean) });
    if (!parsed.success) throw invalid(parsed.error.issues);
    return parsed.data;
  });
}

export function registerReportingApi(app, ctx) {
  const { db } = ctx;
  const limiter = createRateLimiter();
  const routes = Object.fromEntries(reportingRouteList.map((r) => [r.id, r]));
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET');
      const requestId = currentRequestId();
      return res.status(405).json({ error: 'The reporting API is read-only.', code: 'not_found', ...(requestId ? { requestId } : {}) });
    }
    next();
  });

  /** Who is calling: a live key of a business that is open. Everything after this runs as that business. */
  router.use(async (req, res, next) => {
    try {
      const key = keyFrom(req);
      const found = key ? await findKey(db, key) : null;
      if (!found || found.revoked_at) {
        log.warn('reporting.unauthorized', { reason: found ? 'revoked' : key ? 'unknown_key' : 'no_key', keyId: found?.id ?? null });
        throw new ApiError('unauthorized', 'Send a valid reporting API key.');
      }
      if (!REPORTING_STATUSES.includes(found.status)) throw new ApiError('forbidden', 'This business is not active.');
      const taken = limiter.take(found.id);
      if (!taken.ok) {
        res.set('Retry-After', String(taken.retryAfter));
        log.warn('reporting.rate_limited', { keyId: found.id, tenantId: found.tenant_id });
        throw new ApiError('rate_limited', `Too many requests. Try again in ${taken.retryAfter} seconds.`);
      }
      res.set('X-RateLimit-Remaining', String(taken.remaining));
      req.reportingKey = found;
      await touchKey(db, found.id);
      next();
    } catch (err) {
      sendApiError(err, req, res);
    }
  });

  const business = (req) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success || params.data.id !== req.reportingKey.tenant_id) {
      log.warn('reporting.not_found', { keyId: req.reportingKey.id, ownTenantId: req.reportingKey.tenant_id, requested: params.success ? params.data.id : null });
      throw new ApiError('not_found');
    }
    return { id: req.reportingKey.tenant_id, slug: req.reportingKey.slug, name: req.reportingKey.name };
  };

  const handle = (fn) => async (req, res) => {
    try {
      const tenant = business(req);
      await withTenant(tenant, async () => {
        const traffic = trafficServices(ctx);
        if (!(await ctx.repos.entitlements.can('reporting.api'))) throw new ApiError('forbidden', 'The reporting API is available from tier 2.');
        const result = await fn(req, traffic);
        res.json(result);
      });
    } catch (err) {
      sendApiError(err, req, res);
    }
  };

  const catalog = routes['reporting.catalog'];
  router.get(catalog.path, handle(async (_req, traffic) => catalog.response.parse(await traffic.explore.catalog(OWNER_VIEW))));

  const metrics = routes['reporting.query'];
  router.get(metrics.path, handle(async (req, traffic) => {
    const query = metrics.query.safeParse(req.query);
    if (!query.success) throw invalid(query.error.issues);
    const { cursor, limit, filter, ...rest } = query.data;
    const offset = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] >= 0 && key[0] < 1e9)[0] : 0;
    const definition = ExploreRequest.safeParse({ ...rest, filters: parseFilters(filter), page: String(offset), limit });
    if (!definition.success) throw invalid(definition.error.issues);
    // The key is the owner's, made by the owner: the plan, not a role, decides what it sees.
    const result = await traffic.explore.query(definition.data, { allowRevenue: true });
    const [zoneRow] = await db.query('SELECT timezone FROM tenants WHERE id = $1', [req.reportingKey.tenant_id]);
    return metrics.response.parse({
      columns: result.columns,
      data: result.rows,
      nextCursor: result.nextPage === null ? null : writeCursor([Number(result.nextPage)]),
      timeZone: safeZone(zoneRow?.timezone ?? req.reportingKey.timezone),
    });
  }));

  // Event-level rows are never served (N-82), whatever the key.
  const events = routes['reporting.events'];
  router.get(events.path, handle(async () => {
    throw new ApiError(events.refused, 'The reporting API serves summary figures only.');
  }));

  router.use((req, res) => sendApiError(new ApiError('not_found'), req, res));
  app.use(REPORTING_BASE_PATH, router);
}

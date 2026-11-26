import express from 'express';
import multer from 'multer';
import { APPS, APP_HEADERS, APP_PLATFORMS, isBelowMinimum } from '../../contracts/accounts.js';
import { ApiError, IdText, isAllowed, maskShopperContacts, planLimitMessage, planOffMessage, planRefusalReason, routeList, routes } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { currentTenant, tenantId, withTenant } from '../../tenancy.js';
import { auditImpersonated, checkOperator, isOperatorWrite, operatorSession, serviceWrite } from './operator.js';

/** What every module's api() says it answers, checked against the contract. */
function collectHandlers(ctx) {
  const known = new Set(routeList.map((route) => route.id));
  const handlers = new Map();
  for (const module of ctx.modules) {
    for (const [id, handler] of Object.entries(module.api?.(ctx) ?? {})) {
      if (!known.has(id)) throw new Error(`Module "${module.name}" answers "${id}", which is not in the API contract`);
      if (handlers.has(id)) throw new Error(`Two modules both answer "${id}"`);
      handlers.set(id, handler);
    }
  }
  return handlers;
}

/** What every module's counters() says it counts, by name: how many of a limited thing a business has in use. */
function collectCounters(ctx) {
  const counters = new Map();
  for (const module of ctx.modules) {
    for (const [name, count] of Object.entries(module.counters?.(ctx) ?? {})) {
      if (counters.has(name)) throw new Error(`Two modules both count "${name}"`);
      counters.set(name, count);
    }
  }
  return counters;
}

/**
 * The plan (PRD 5.7), from the route table: `feature` must be on for this business, and `limit` must have room. Read on
 * every call, so an upgrade or a downgrade applies to the next request with no restart (F-33). A limit whose counter no
 * loaded module supplies is left to the handler.
 */
async function checkPlan(route, { repos }, counters, call) {
  const entitlements = repos.entitlements;
  if (!entitlements) throw new Error(`Route "${route.id}" needs the entitlements module to check its plan`);
  if (route.feature) {
    const names = [route.feature].flat();
    let on = false;
    for (const name of names) on ||= await entitlements.can(name);
    if (!on) {
      const plan = await entitlements.lowestPlan(names);
      throw new ApiError('plan.feature_off', planOffMessage(plan?.name), { reason: planRefusalReason(route.id), feature: names[0], plan: plan?.code });
    }
  }
  if (route.limit) {
    const count = counters.get(route.limit.counts);
    const max = count ? await entitlements.limit(route.limit.feature) : Infinity;
    if (max !== Infinity) {
      const used = Number(await count(call)) || 0;
      if (used >= max) throw await limitReached(route, entitlements, max, used);
    }
  }
}

/** The plan.limit_reached answer for a route's limit: the router's own refusal, and the database's when requests raced. */
async function limitReached(route, entitlements, max, used) {
  const plan = await entitlements.lowestPlan([route.limit.feature], { moreThan: max });
  return new ApiError('plan.limit_reached', planLimitMessage(max, plan?.name), { reason: planRefusalReason(route.id), feature: route.limit.feature, plan: plan?.code, limit: max, used });
}

/**
 * The count checkPlan reads is a statement of its own, before the handler writes: requests sent at once all read the
 * same count. A limit the database also holds (team_invites_within_plan, migration 945) refuses the write that would go
 * past it with check_violation 'plan.limit_reached' and the feature as its detail; that is answered like checkPlan's.
 */
const isLimitError = (err, feature) => err?.code === '23514' && /plan\.limit_reached/.test(String(err?.message ?? '')) && String(err?.detail ?? '') === feature;

function fieldErrors(issues) {
  const fields = {};
  for (const issue of issues) fields[issue.path.join('.') || '_'] ??= issue.message;
  return fields;
}

function validated(schema, value) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields = fieldErrors(parsed.error.issues);
  const messages = Object.values(fields);
  throw new ApiError('validation_failed', messages.length === 1 ? messages[0] : 'Please check the highlighted details.', { fields });
}

function pathParams(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('not_found');
  return parsed.data;
}

function uploader({ field, maxBytes, mimeTypes, tooLarge }) {
  const receive = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter(_req, file, done) {
      if (mimeTypes.includes(file.mimetype)) done(null, true);
      else done(new ApiError('unsupported_media_type'));
    },
  }).single(field);
  // A route may say in its own words what to do about a file over the limit (the CSV import: "Upload a file of 2 MB or less.").
  const refused = (err) => (tooLarge && err?.code === 'LIMIT_FILE_SIZE' ? new ApiError('payload_too_large', tooLarge) : err);
  return (req, res) => new Promise((resolve, reject) => receive(req, res, (err) => (err ? reject(refused(err)) : resolve())));
}

/** Refused and missing lookups are logged with ids only: another business's id ends up here (PRD 11, R-01). */
function logRefusal(err, route, req) {
  if (err?.code !== 'not_found' && err?.code !== 'forbidden') return;
  const target = /^\d{1,40}$/.test(req.params.id ?? '') ? req.params.id : undefined;
  log.warn(`api.${err.code}`, { route: route.id, userId: req.user?.id ?? null, role: req.user?.role ?? null, target });
}

function serve(route, handler, ctx, counters, handlers) {
  const receiveFile = route.upload && uploader(route.upload);

  async function run(req, res) {
    // On the host that belongs to no business, only the routes that need none are answered before sign-in.
    if (!route.noBusiness && !currentTenant()) throw new ApiError('unauthorized');
    // A first sign-in while sign-up was not open made a held place, not a business (auth-2, PRD 5.20): the person may sign
    // in, manage their own sign-in and sign up, and nothing else, until signup.start adopts it.
    if (currentTenant()?.signup_held && !route.noBusiness && !route.id.startsWith('auth.')) {
      throw new ApiError('forbidden', 'Finish signing up to use your business.', { reason: 'signup.pending' });
    }
    // A session Bhava's team opened is held to its own rules first (PRD 5.10, 5.17): read-only, what is blocked, the route's service.
    await checkOperator(route, req, ctx);
    if (!isAllowed(req.user ?? null, route.access)) throw new ApiError(req.user ? 'forbidden' : 'unauthorized', req.user ? route.access.denied : undefined);
    // Keys, credentials, roles and account deletion need a re-auth in the last few minutes (PRD 5.11): the app re-auths and repeats the call.
    if (route.fresh && !req.session?.fresh) throw new ApiError('reauth_required');
    // The plan comes after who is asking and before what they sent: nobody learns a plan from a route they may not call.
    if (route.feature || route.limit) await checkPlan(route, ctx, counters, { params: req.params, body: req.body ?? {}, user: req.user ?? null });
    if (route.body && !req.is('application/json')) throw new ApiError('unsupported_media_type', 'Send this as JSON.');

    const params = route.params ? pathParams(route.params, req.params) : {};
    if (receiveFile) {
      await receiveFile(req, res);
      if (!req.file) throw new ApiError('validation_failed', 'Attach a file to upload.');
    }
    const query = route.query ? validated(route.query, req.query) : {};
    const body = route.body ? validated(route.body, req.body ?? {}) : {};
    if (!handler) throw new ApiError('not_implemented');

    const call = { params, query, body, file: req.file, user: req.user ?? null, req, res };
    /** Runs the handler and answers its result as the response schema allows it out; undefined for a route with no body. */
    const apply = async () => {
      let result;
      try {
        result = await handler(call);
      } catch (err) {
        if (!route.limit || !isLimitError(err, route.limit.feature)) throw err;
        const max = await ctx.repos.entitlements.limit(route.limit.feature);
        throw await limitReached(route, ctx.repos.entitlements, max, max);
      }
      if (route.response === null) return undefined;
      if (result === null || result === undefined) throw new ApiError('not_found');
      const output = route.response.safeParse(result);
      if (!output.success) {
        log.error('api.bad_response', { route: route.id, issues: output.error.issues.slice(0, 10).map((i) => i.path.join('.')) });
        throw new ApiError('internal');
      }
      return output.data;
    };

    let data;
    if (isOperatorWrite(route, req)) {
      // A service operator's write is recorded with before and after, or kept as a draft for the seller (PRD 5.17).
      const written = await serviceWrite(route, handlers, ctx, call, apply);
      if (written.draft) return res.status(202).json({ draft: true, changeId: written.changeId });
      data = written.output;
    } else {
      data = await apply();
    }
    if (route.response === null) return res.status(route.status ?? 204).end();
    // Shopper contact details are masked for support outside order detail (PRD 5.10).
    res.status(route.status ?? 200).json(req.session?.operator?.kind === 'impersonation' ? maskShopperContacts(route.id, data) : data);
  }

  return async (req, res) => {
    try {
      await run(req, res);
      await auditImpersonated(route, req, res.statusCode, ctx);
    } catch (err) {
      logRefusal(err, route, req);
      await auditImpersonated(route, req, err?.status ?? 500, ctx);
      throw err;
    }
  };
}

/**
 * X-Tenant-Id: a seller working in another of their businesses (PRD 5.2). It is checked against their membership on
 * every call and refused the same way whether the business is someone else's or doesn't exist. After this the
 * request is simply a request in that business, by that person's account there, with that account's permissions.
 * Sign-out always ends the session in the business it belongs to.
 */
function switchBusiness({ repos }) {
  return async (req, res, next) => {
    const wanted = req.get('x-tenant-id');
    if (wanted === undefined || !req.user || req.path.toLowerCase() === '/auth/logout' || wanted === String(tenantId())) return next();
    const id = IdText.safeParse(wanted);
    const member = id.success ? await repos.users.memberOf(req.user, id.data) : null;
    if (!member) {
      log.warn('api.forbidden', { route: 'x-tenant-id', userId: req.user.id, role: req.user.role, target: id.success ? id.data : undefined });
      throw new ApiError('forbidden');
    }
    return withTenant(member.tenant, async () => {
      const user = await repos.users.get(member.userId);
      if (!user) throw new ApiError('forbidden');
      req.user = user;
      res.locals.user = user;
      next();
    });
  };
}

/**
 * The minimum app version (PRD 10.2). A request from an app names itself in X-App, X-App-Version and X-App-Platform;
 * one older than the minimum gets 426 `update_required` with the store link, whatever it asked for. The web console
 * sends none of these and is never refused. app.requirements is exempt, so an old app can still learn where to update.
 */
function appVersionGate({ repos }) {
  return async (req, _res, next) => {
    const app = req.get(APP_HEADERS.app);
    if (app === undefined || req.path.toLowerCase() === '/app/requirements') return next();
    const platform = req.get(APP_HEADERS.platform);
    if (!APPS.includes(app) || !APP_PLATFORMS.includes(platform)) throw new ApiError('validation_failed', 'This app could not be recognised. Update it and try again.');
    const minimum = await repos.appVersions.minimum({ app, platform, tenantId: app === 'shopper' ? currentTenant()?.id ?? null : null });
    if (minimum && isBelowMinimum(req.get(APP_HEADERS.version), minimum.minVersion)) throw new ApiError('update_required', undefined, { storeUrl: minimum.storeUrl });
    return next();
  };
}

const routers = new WeakMap();
const handlerMaps = new WeakMap();
function apiHandlersFor(ctx) {
  if (!handlerMaps.has(ctx)) handlerMaps.set(ctx, collectHandlers(ctx));
  return handlerMaps.get(ctx);
}

/** The router for ctx, built once: mounted at /api/v1 inside a business, and by the server on the host that belongs to none. */
export function apiRouterFor(ctx) {
  if (routers.has(ctx)) return routers.get(ctx);
  const handlers = apiHandlersFor(ctx);
  const counters = collectCounters(ctx);
  const r = express.Router();
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  r.use(appVersionGate(ctx));
  r.use(operatorSession(ctx));
  r.use(switchBusiness(ctx));
  for (const route of routeList) r[route.method.toLowerCase()](route.path, serve(route, handlers.get(route.id), ctx, counters, handlers));
  r.use((_req, _res, next) => next(new ApiError('not_found')));
  routers.set(ctx, r);
  return r;
}

/**
 * Runs one route's handler from inside another handler, as `user`, with the input checked by the route's own schemas and
 * the answer by its response schema: what the seller's "Done by Bhava team" feed uses to apply a draft and to write a
 * change's `before` back (PRD 5.17), so every check the route makes runs again. No access or plan check is made here:
 * the caller's own route has passed both for the person asking. Throws ApiError as the route would.
 */
export async function runRoute(ctx, id, { params = {}, query = {}, body = {}, user, req, res }) {
  const route = routes[id];
  const handler = apiHandlersFor(ctx).get(id);
  if (!route) throw new Error(`"${id}" is not a route`);
  if (!handler) throw new ApiError('not_implemented');
  const input = { params: route.params ? pathParams(route.params, params) : {}, query: route.query ? validated(route.query, query) : {}, body: route.body ? validated(route.body, body) : {} };
  const result = await handler({ ...input, user, req, res });
  if (route.response === null) return null;
  if (result === null || result === undefined) throw new ApiError('not_found');
  const output = route.response.safeParse(result);
  if (!output.success) throw new ApiError('internal');
  return output.data;
}

/**
 * The seller API. Routes come from src/contracts/api; this router checks who is calling, validates the
 * input and the output, and answers errors in the one format. Modules supply the work:
 *
 *   api(ctx) -> { 'products.get': async ({ params, query, body, file, user, req, res }) => result }
 *
 * Returning null is a 404, so `repos.products.get(params.id)` is a complete handler for its lookup. Throw
 * ApiError (or let a repo's ValidationError through) to refuse. A route nobody answers yet is a 501.
 */
export const apiV1 = {
  name: 'api-v1',
  routes(app, ctx) {
    app.use('/api/v1', apiRouterFor(ctx));
  },
};

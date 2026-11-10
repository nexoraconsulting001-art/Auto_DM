import express from 'express';
import multer from 'multer';
import { ApiError, isAllowed, routeList } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';

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

function uploader({ field, maxBytes, mimeTypes }) {
  const receive = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter(_req, file, done) {
      if (mimeTypes.includes(file.mimetype)) done(null, true);
      else done(new ApiError('unsupported_media_type'));
    },
  }).single(field);
  return (req, res) => new Promise((resolve, reject) => receive(req, res, (err) => (err ? reject(err) : resolve())));
}

/** Refused and missing lookups are logged with ids only: another business's id ends up here (PRD 11, R-01). */
function logRefusal(err, route, req) {
  if (err?.code !== 'not_found' && err?.code !== 'forbidden') return;
  const target = /^\d{1,40}$/.test(req.params.id ?? '') ? req.params.id : undefined;
  log.warn(`api.${err.code}`, { route: route.id, userId: req.user?.id ?? null, role: req.user?.role ?? null, target });
}

function serve(route, handler) {
  const receiveFile = route.upload && uploader(route.upload);

  async function run(req, res) {
    if (!isAllowed(req.user ?? null, route.access)) throw new ApiError(req.user ? 'forbidden' : 'unauthorized');
    if (route.body && !req.is('application/json')) throw new ApiError('unsupported_media_type', 'Send this as JSON.');

    const params = route.params ? pathParams(route.params, req.params) : {};
    if (receiveFile) {
      await receiveFile(req, res);
      if (!req.file) throw new ApiError('validation_failed', 'Attach a file to upload.');
    }
    const query = route.query ? validated(route.query, req.query) : {};
    const body = route.body ? validated(route.body, req.body ?? {}) : {};
    if (!handler) throw new ApiError('not_implemented');

    const result = await handler({ params, query, body, file: req.file, user: req.user ?? null, req, res });
    if (route.response === null) return res.status(route.status ?? 204).end();
    if (result === null || result === undefined) throw new ApiError('not_found');
    const output = route.response.safeParse(result);
    if (!output.success) {
      log.error('api.bad_response', { route: route.id, issues: output.error.issues.slice(0, 10).map((i) => i.path.join('.')) });
      throw new ApiError('internal');
    }
    res.status(route.status ?? 200).json(output.data);
  }

  return async (req, res) => {
    try {
      await run(req, res);
    } catch (err) {
      logRefusal(err, route, req);
      throw err;
    }
  };
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
    const handlers = collectHandlers(ctx);
    const r = express.Router();
    r.use((_req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    });
    for (const route of routeList) r[route.method.toLowerCase()](route.path, serve(route, handlers.get(route.id)));
    r.use((_req, _res, next) => next(new ApiError('not_found')));
    app.use('/api/v1', r);
  },
};

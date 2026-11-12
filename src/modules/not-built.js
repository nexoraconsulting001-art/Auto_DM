import { requirePlatformRole } from '../auth.js';
import { ApiError } from '../contracts/api/index.js';
import { platformRoutes } from '../contracts/api/platform.js';

/**
 * Answers contract routes whose real handlers have not been written, so each route has exactly one module that owns it.
 * Replace an id with its handler as it is built. The answer is the 501 the router gives a route nobody answers.
 */
export const notBuilt = (...ids) =>
  Object.fromEntries(ids.map((id) => [id, () => { throw new ApiError('not_implemented'); }]));

const NOT_BUILT = Object.freeze({ error: new ApiError('not_implemented').message, code: 'not_implemented' });

/**
 * Mounts buyer routes of a route table (STORE_ROUTES or APP_ROUTES in src/contracts/store-routes.js) that are not built yet,
 * in a module's routes(app, ctx): a JSON route answers 501 { error, code: 'not_implemented' }, a page 501 as plain text, and a
 * well-known file 404, the answer of a business with no app. Every one is Cache-Control: no-store. Remove an id as its
 * handler is mounted.
 */
export function storeNotBuilt(app, table, ...ids) {
  for (const id of ids) {
    const route = table[id];
    if (!route) throw new Error(`"${id}" is not a route of this table`);
    app[route.method.toLowerCase()](route.path, (_req, res) => {
      res.set('Cache-Control', 'no-store');
      if (route.kind === 'wellknown') return res.status(404).type('text').send('Not found.');
      if (route.kind === 'page') return res.status(501).type('text').send(NOT_BUILT.error);
      return res.status(501).json(NOT_BUILT);
    });
  }
}

/** The same for Platform Console routes (platformRoutes in src/contracts/api/platform.js), behind requirePlatformRole. */
export function platformNotBuilt(router, ...ids) {
  for (const id of ids) {
    const route = platformRoutes[id];
    if (!route) throw new Error(`"${id}" is not a Platform Console route`);
    const guard = route.public ? (_req, _res, next) => next() : requirePlatformRole(...route.platformRoles);
    router[route.method.toLowerCase()](route.path, guard, (_req, res) => {
      res.set('Cache-Control', 'no-store').status(501).json(NOT_BUILT);
    });
  }
}

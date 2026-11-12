import { requirePlatformRole } from '../../auth.js';
import { ApiError } from '../../contracts/api/errors.js';
import { platformRoutes } from '../../contracts/api/platform.js';
import { reportError } from '../../platform/log.js';
import { ValidationError } from '../../util.js';

/**
 * Mounts one Platform Console route of the contract (src/contracts/api/platform.js) for the Phase 6 store-release modules
 * (app-submissions, ota): the role check, the inputs through the route's own schemas, the answer through its response schema,
 * and refusals as { error, code }. Never cached.
 *
 *   mountConsoleRoute(router, id, handler, { strictBody })   handler({ params, query, body, actor, answer }) -> result
 *
 * `answer.status` overrides the route's success status (a repeated publish is 200, not 201). With strictBody a key the body
 * schema does not name is refused, for routes whose schema would otherwise drop it unseen. A trigger's refusal (check_violation)
 * is a 409 with the trigger's own sentence, which names states and never a business's data.
 */
export function mountConsoleRoute(router, id, handler, { strictBody = false } = {}) {
  const route = platformRoutes[id];
  if (!route) throw new Error(`"${id}" is not a Platform Console route`);
  router[route.method.toLowerCase()](route.path, requirePlatformRole(...route.platformRoles), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const params = route.params ? route.params.safeParse(req.params) : { success: true, data: {} };
      if (!params.success) throw new ApiError('not_found');
      const query = route.query ? route.query.safeParse(req.query) : { success: true, data: {} };
      if (!query.success) throw new ApiError('validation_failed', query.error.issues[0]?.message ?? 'Check the details and try again.');
      let body = {};
      if (route.body) {
        const raw = req.body ?? {};
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('validation_failed', 'Send the details as a JSON object.');
        if (strictBody && route.body.shape) {
          const unknown = Object.keys(raw).filter((key) => !Object.hasOwn(route.body.shape, key));
          if (unknown.length) throw new ApiError('validation_failed', `This route does not take ${unknown.join(', ')}.`);
        }
        const parsed = route.body.safeParse(raw);
        if (!parsed.success) throw new ApiError('validation_failed', parsed.error.issues[0]?.message ?? 'Check the details and try again.');
        body = parsed.data;
      }
      const answer = { status: route.status ?? 200 };
      const result = await handler({ params: params.data, query: query.data, body, actor: `platform:${req.platformUser.id}`, answer });
      if (route.response === null) return res.status(answer.status ?? 204).end();
      if (result === null || result === undefined) throw new ApiError('not_found');
      return res.status(answer.status).json(route.response.parse(result));
    } catch (err) {
      if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, code: err.code });
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message, code: 'validation_failed' });
      if (err?.code === '23514' || err?.code === '23505') return res.status(409).json({ error: String(err.message ?? 'That change is not allowed.').slice(0, 300), code: 'conflict' });
      reportError(err, { msg: 'console.route_failed', route: id });
      return res.status(500).json({ error: 'Something went wrong. Try again.', code: 'internal' });
    }
  });
}

/** A whole-number cursor for an id-ordered page, or null. */
export const cursorId = (cursor) => (/^[1-9][0-9]{0,17}$/.test(String(cursor ?? '')) ? String(cursor) : null);

/** { items, nextCursor } from rows fetched with LIMIT limit + 1, newest id first. */
export function pageOf(rows, limit, map) {
  const items = rows.slice(0, limit);
  return { items: items.map(map), nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
}

import { requirePlatformRole, sameOriginOnly } from '../../auth.js';
import { platformRoutes } from '../../contracts/api/platform.js';
import { ValidationError } from '../../util.js';

/** A refusal a console route answers as { error, code? } with its status, instead of a server fault. */
export class Refusal extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Who did it, on every audit row of the console: the platform user's id, never their email or name. */
export const actorOf = (user) => (user ? `platform:${user.id}` : 'platform:anonymous');

/**
 * Mounts one route of the platform contract (platformRoutes): the role check, or for the three `public` sign-in routes a
 * same-site check instead, then the route's own schemas for path, query and body, then the handler, whose answer is parsed
 * by the response schema. A Refusal is the answer the person sees; anything else is a server fault. Console answers are
 * never cached.
 *
 * The handler gets { params, query, body, user, actor, req, res }.
 */
export function mountRoute(router, id, handler) {
  const route = platformRoutes[id];
  if (!route) throw new Error(`"${id}" is not a Platform Console route`);
  const guard = route.public ? sameOriginOnly : requirePlatformRole(...route.platformRoles);
  router[route.method.toLowerCase()](route.path, guard, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const input = {};
    for (const part of ['params', 'query', 'body']) {
      if (!route[part]) continue;
      const parsed = route[part].safeParse(part === 'body' ? req.body ?? {} : req[part]);
      if (parsed.success) input[part] = parsed.data;
      else if (part === 'params') return res.status(404).json({ error: 'Not found.' });
      else return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the details and try again.' });
    }
    try {
      const result = await handler({ ...input, user: req.platformUser ?? null, actor: actorOf(req.platformUser), req, res });
      if (res.headersSent) return undefined;
      if (route.response === null) return res.status(route.status ?? 204).end();
      return res.status(route.status ?? 200).json(route.response.parse(result));
    } catch (err) {
      if (err instanceof Refusal) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });
}

/** An opaque cursor for an ordered list read by position. */
export const offsetCursor = {
  read: (cursor) => {
    const n = Number(/^o(\d{1,9})$/.exec(cursor ?? '')?.[1] ?? 0);
    return Number.isSafeInteger(n) ? n : 0;
  },
  next: (offset, limit, total) => (offset + limit < total ? `o${offset + limit}` : null),
};

/** A cursor that is the last id seen, for lists read newest first. */
export const idCursor = (cursor) => (/^\d{1,18}$/.test(cursor ?? '') ? cursor : null);

/**
 * One audit row written by the platform, with or without a business (PRD 5.14). Through db.platform: these rows are the
 * platform's, and the business reads those with its id on its own audit screen. Details hold ids, codes and the reason the
 * operator typed; never a token, a phone number or a shopper's name.
 */
export async function platformAudit(db, { tenantId = null, actor, action, target = '', details = {} }) {
  await (db.platform ?? db).query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)', [
    tenantId === null ? null : Number(tenantId), String(actor), String(action), String(target), JSON.stringify(details),
  ]);
}

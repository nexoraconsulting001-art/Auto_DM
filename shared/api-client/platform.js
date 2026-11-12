/**
 * The client for the Platform Console's routes, built from the route table itself, so it cannot fall out of step with it:
 *
 *   const console = createPlatformClient();
 *
 *   await console.signInStart({ body: { email } });
 *   const { items, nextCursor } = await console.businesses({ query: { limit: 20 } });
 *   await console.pauseBusiness({ params: { id: 12 }, body: { reason: 'ticket 123' } });
 *
 * Every route `platform.<name>` is a method `<name>({ params, query, body })`. The table is PLATFORM_ROUTES in
 * platform-routes.js: the method, path and roles of every route as plain data, generated from src/contracts/api/platform.js
 * by `npm run gen:platform-routes` and kept in step with it by a test. So the page gets the whole table and none of the
 * server's schemas. Pass `routes` to use another table (the server's own, in a test).
 *
 * The console's session is a cookie on its own host. Its CSRF token comes back from `me` and from the last step of
 * sign-in, and is sent on every change. Failures are thrown as PlatformError with the status and the server's message.
 */
import { PLATFORM_ROUTES } from './platform-routes.js';

export { PLATFORM_ROUTES };

export class PlatformError extends Error {
  /** `status` is 0 when the server could not be reached. */
  constructor({ status, code, message, fields }) {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.code = code;
    this.fields = fields ?? {};
  }
}

const SERVER_FAULT = 'Something went wrong on our side. Please try again.';

function pathWith(path, params = {}) {
  return path.replace(/:([A-Za-z]\w*)/g, (_all, name) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') throw new Error(`This route needs "${name}"`);
    return encodeURIComponent(String(value));
  });
}

function withQuery(path, query) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

/**
 * @param {object} options
 * @param {Record<string, { method: string, path: string }>} [options.routes] the Platform Console's route table, keyed `platform.<name>`; PLATFORM_ROUTES unless given
 * @param {string} [options.baseUrl] the console's host; defaults to this site
 * @param {(error: PlatformError) => void} [options.onUnauthorized] called on any 401
 * @param {typeof fetch} [options.fetch] replaces the global fetch
 */
export function createPlatformClient({ routes = PLATFORM_ROUTES, baseUrl = '', onUnauthorized, fetch: send = (...args) => globalThis.fetch(...args) } = {}) {
  if (!routes || typeof routes !== 'object') throw new Error('createPlatformClient needs the route table');
  let csrf = '';

  async function request(method, path, json) {
    const headers = { accept: 'application/json' };
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    if (json !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await send(`${baseUrl}${path}`, { method, headers, credentials: 'same-origin', ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
    } catch {
      throw new PlatformError({ status: 0, code: 'network', message: 'We couldn’t reach the server. Check your connection and try again.' });
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const error = new PlatformError({ status: response.status, code: body?.code ?? (response.status === 501 ? 'not_implemented' : 'error'), message: body?.error ?? SERVER_FAULT, fields: body?.fields });
      if (response.status === 401) onUnauthorized?.(error);
      throw error;
    }
    if (response.status === 204 || response.status === 202) return response.json().catch(() => null);
    const data = await response.json();
    // me and the last step of sign-in carry the session's CSRF token; signing out forgets it.
    if (data && typeof data.csrf === 'string') csrf = data.csrf;
    return data;
  }

  const client = {};
  for (const [id, route] of Object.entries(routes)) {
    const [group, name, ...rest] = id.split('.');
    if (group !== 'platform' || !name || rest.length) throw new Error(`"${id}" is not a Platform Console route id`);
    if (name in client) throw new Error(`Two routes are both "${name}"`);
    client[name] = async ({ params, query, body } = {}) => {
      const hasBody = route.method !== 'GET' && route.method !== 'DELETE';
      const result = await request(route.method, withQuery(pathWith(route.path, params), query), hasBody ? body ?? {} : undefined);
      if (name === 'signOut') csrf = '';
      return result;
    };
  }
  return client;
}

/** Walks every page of a list: for await (const business of allPlatformPages(console.businesses, { limit: 50 })) ... */
export async function* allPlatformPages(list, query = {}) {
  let cursor;
  do {
    const page = await list({ query: { ...query, cursor } });
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor);
}

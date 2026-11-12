/**
 * The client for one store's own API at /api/store, on that store's own address. Used by the shopper app only: it knows
 * nothing of the seller API and has no dependencies. The routes are routes.js, kept equal to the server's contract by a test.
 *
 *   const store = createStoreClient({ origin: 'https://shop.example.com', tenantId: 12, version: '1.0.0', platform: 'android', getAccessToken });
 *   const home = await store.call('appHome');
 *   const product = await store.call('appProduct', { params: { slug: 'blue-pot' } });
 *   const page = await store.call('appCatalog', { query: { sort: 'newest', limit: 24 } });
 *   await store.call('cartPut', { body: { lines: [{ productId: 3, variantId: null, qty: 1 }] } });
 *   await store.call('returnCreate', { params: { orderNumber: 'A-1001' }, form });     // multipart: a FormData
 *   const url = store.pageUrl('order', { token });                                     // opened in a browser tab
 *
 * Every request carries the app's four headers and, when there is a session, Authorization: Shopper <access token>. No call
 * sends a price, a total or a channel: the server works those out. Every failure is thrown as a StoreError, whose message is
 * the server's own words or a plain fallback; nothing here names the platform.
 */
import { APP_NAME, AUTH_SCHEME, HEADERS, PAGES, ROUTES } from './routes.js';

export { APP_NAME, AUTH_SCHEME, HEADERS, PAGES, ROUTES, STORE_APP_CALLS } from './routes.js';

const FALLBACK = 'Something went wrong. Please try again.';
const OFFLINE = 'You seem to be offline. Check your connection and try again.';

export class StoreError extends Error {
  /** `status` is 0 when the store could not be reached; `code` is from the API's error format. */
  constructor({ status, code, message, fields, storeUrl }) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.code = code;
    this.fields = fields ?? {};
    /** With code `update_required` (426): where to get the newer app. */
    this.storeUrl = storeUrl;
  }
}

/** A route's path with its :params filled in. Throws when one is missing, so a call never goes to a half-made address. */
export function fillPath(path, params = {}) {
  return path.replace(/:([A-Za-z]+)/g, (_whole, name) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') throw new Error(`Missing ${name}`);
    return encodeURIComponent(String(value));
  });
}

function withQuery(path, query) {
  const pairs = Object.entries(query ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return pairs.length ? `${path}?${pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&')}` : path;
}

async function toError(response) {
  const body = await response.json().catch(() => null);
  const fallbackCode = { 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 426: 'update_required', 429: 'rate_limited' }[response.status] ?? 'internal';
  return new StoreError({ status: response.status, code: body?.code ?? fallbackCode, message: body?.error ?? FALLBACK, fields: body?.fields, storeUrl: body?.storeUrl });
}

/**
 * @param {object} options
 * @param {string} options.origin the store's own address, such as https://shop.example.com
 * @param {number} options.tenantId the business id written into the build, sent as X-App-Tenant
 * @param {string} options.version the app's version, sent as X-App-Version
 * @param {'android' | 'ios'} options.platform sent as X-App-Platform
 * @param {() => (string | null | Promise<string | null>)} [options.getAccessToken] the app session's access token
 * @param {(error: StoreError) => void} [options.onUnauthorized] called on any 401
 * @param {(error: StoreError) => void} [options.onUpdateRequired] called on 426; error.storeUrl is the store link
 * @param {typeof fetch} [options.fetch]
 */
export function createStoreClient({ origin, tenantId, version, platform, getAccessToken, onUnauthorized, onUpdateRequired, fetch: fetchFn = globalThis.fetch } = {}) {
  const base = String(origin ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(base)) throw new Error('The store client needs the store’s own address');
  if (!Number.isInteger(tenantId) || tenantId < 1) throw new Error('The store client needs the business id this build was made for');

  const url = (id, params, query) => {
    const route = ROUTES[id];
    if (!route) throw new Error(`Unknown store route ${id}`);
    return `${base}${withQuery(fillPath(route.path, params), query)}`;
  };

  async function call(id, { params, query, body, form, signal } = {}) {
    const route = ROUTES[id];
    if (!route) throw new Error(`Unknown store route ${id}`);
    const headers = { accept: 'application/json', [HEADERS.app]: APP_NAME, [HEADERS.tenant]: String(tenantId), [HEADERS.version]: String(version), [HEADERS.platform]: String(platform) };
    const token = getAccessToken ? await getAccessToken() : null;
    if (token) headers.authorization = `${AUTH_SCHEME} ${token}`;
    if (body !== undefined && !form) headers['content-type'] = 'application/json';
    const address = url(id, params, query);
    let response;
    try {
      response = await fetchFn(address, { method: route.method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined), signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new StoreError({ status: 0, code: 'network', message: OFFLINE });
    }
    if (!response.ok) {
      const error = await toError(response);
      if (response.status === 401) onUnauthorized?.(error);
      if (response.status === 426) onUpdateRequired?.(error);
      throw error;
    }
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }

  /** A page opened in a system browser tab, on the store's own address. */
  const pageUrl = (name, params, query) => {
    if (!PAGES[name]) throw new Error(`Unknown store page ${name}`);
    return `${base}${withQuery(fillPath(PAGES[name], params), query)}`;
  };

  return Object.freeze({ origin: base, call, url, pageUrl });
}

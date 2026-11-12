import { AUTH_SCHEME, HEADERS, ROUTES, STORE_APP_CALLS, StoreError, createStoreClient, fillPath } from './index.js';

const ORIGIN = 'http://localhost:4010';

function fakeFetch(answer = { status: 200, body: { ok: true } }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    if (answer instanceof Error) throw answer;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => (answer.body === undefined ? Promise.reject(new Error('no body')) : answer.body) };
  };
  return { fetch, calls };
}

const client = (extra = {}) => createStoreClient({ origin: `${ORIGIN}/`, tenantId: 41, version: '1.2.3', platform: 'android', ...extra });

test('every request carries the four app headers, and the session token under the Shopper scheme', async () => {
  const { fetch, calls } = fakeFetch();
  const store = client({ fetch, getAccessToken: async () => 'sa_token' });
  await store.call('appHome');
  expect(calls[0].url).toBe(`${ORIGIN}/api/store/app/home`);
  expect(calls[0].method).toBe('GET');
  expect(calls[0].headers).toMatchObject({ [HEADERS.app]: 'shopper', [HEADERS.tenant]: '41', [HEADERS.version]: '1.2.3', [HEADERS.platform]: 'android', authorization: `${AUTH_SCHEME} sa_token` });
  expect(calls[0].headers.authorization.startsWith('Bearer')).toBe(false);
});

test('with no session there is no Authorization header at all', async () => {
  const { fetch, calls } = fakeFetch();
  await client({ fetch }).call('appBootstrap');
  expect('authorization' in calls[0].headers).toBe(false);
});

test('params fill the path, a query is added, and a body goes as JSON', async () => {
  const { fetch, calls } = fakeFetch();
  const store = client({ fetch });
  await store.call('appProduct', { params: { slug: 'blue pot/1' } });
  await store.call('appCatalog', { query: { sort: 'newest', limit: 24, cursor: undefined, q: '' } });
  await store.call('cartPut', { body: { lines: [] } });
  expect(calls[0].url).toBe(`${ORIGIN}/api/store/app/products/blue%20pot%2F1`);
  expect(calls[1].url).toBe(`${ORIGIN}/api/store/app/catalog?sort=newest&limit=24`);
  expect(calls[2]).toMatchObject({ method: 'PUT', body: '{"lines":[]}' });
  expect(calls[2].headers['content-type']).toBe('application/json');
});

test('a form is sent as it is, without a JSON content type', async () => {
  const { fetch, calls } = fakeFetch();
  const form = { multipart: true };
  await client({ fetch }).call('returnCreate', { params: { orderNumber: 'A-1' }, form });
  expect(calls[0].body).toBe(form);
  expect('content-type' in calls[0].headers).toBe(false);
});

test('a missing param or an unknown route never reaches the network', async () => {
  const { fetch, calls } = fakeFetch();
  const store = client({ fetch });
  await expect(store.call('appProduct')).rejects.toThrow('Missing slug');
  await expect(store.call('sellerOrders')).rejects.toThrow('Unknown store route');
  expect(() => fillPath('/a/:id', { id: '' })).toThrow('Missing id');
  expect(calls).toHaveLength(0);
});

test('a failure is a StoreError with the server’s own words, and 401 and 426 are reported', async () => {
  const seen = [];
  const refused = fakeFetch({ status: 422, body: { error: 'Choose a size', code: 'invalid', fields: { variantId: 'Choose a size' } } });
  await expect(client({ fetch: refused.fetch }).call('cartPut', { body: {} })).rejects.toMatchObject({ name: 'StoreError', status: 422, code: 'invalid', message: 'Choose a size', fields: { variantId: 'Choose a size' } });

  const expired = fakeFetch({ status: 401, body: { error: 'Sign in again', code: 'unauthenticated' } });
  await expect(client({ fetch: expired.fetch, onUnauthorized: (e) => seen.push(e.status) }).call('appMe')).rejects.toBeInstanceOf(StoreError);
  const old = fakeFetch({ status: 426, body: { error: 'Update the app', code: 'update_required', storeUrl: 'https://store.example/app' } });
  await expect(client({ fetch: old.fetch, onUpdateRequired: (e) => seen.push(e.storeUrl) }).call('appHome')).rejects.toMatchObject({ code: 'update_required' });
  expect(seen).toEqual([401, 'https://store.example/app']);
});

test('an empty 404 and an unreachable store still give a plain message', async () => {
  const missing = fakeFetch({ status: 404, body: undefined });
  const error = await client({ fetch: missing.fetch }).call('appHome').catch((e) => e);
  expect(error).toMatchObject({ status: 404, code: 'not_found' });
  const down = await client({ fetch: fakeFetch(new TypeError('Network request failed')).fetch }).call('appHome').catch((e) => e);
  expect(down).toMatchObject({ status: 0, code: 'network' });
  for (const e of [error, down]) expect(e.message.length).toBeGreaterThan(10);
});

test('204 answers null', async () => {
  expect(await client({ fetch: fakeFetch({ status: 204 }).fetch }).call('pushDeviceRemove')).toBeNull();
});

test('pages open on the store’s own address', () => {
  const store = client({ fetch: fakeFetch().fetch });
  expect(store.pageUrl('order', { token: 'tok_1' })).toBe(`${ORIGIN}/order/tok_1`);
  expect(store.pageUrl('googleStart', {}, { code_challenge: 'abc' })).toBe(`${ORIGIN}/auth/app/google?code_challenge=abc`);
  expect(() => store.pageUrl('admin')).toThrow('Unknown store page');
});

test('the client refuses to start without the store’s address and the business id', () => {
  expect(() => createStoreClient({ origin: 'shop.example.com', tenantId: 1 })).toThrow('address');
  expect(() => createStoreClient({ origin: ORIGIN, tenantId: 0 })).toThrow('business id');
});

test('every route is under /api/store, and nothing is a seller route', () => {
  for (const [id, route] of Object.entries(ROUTES)) {
    expect(route.path.startsWith('/api/store/')).toBe(true);
    expect(route.path).not.toMatch(/^\/api\/v1/);
    expect(['none', 'app', 'shopper']).toContain(route.auth);
    expect(id).toMatch(/^[a-zA-Z]+$/);
  }
  for (const id of STORE_APP_CALLS) expect(ROUTES[id]).toBeDefined();
});

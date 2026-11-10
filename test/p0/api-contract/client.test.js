// The shared client: it must say exactly what the contract says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, allPages, createApiClient } from '@bhava/api-client';
import { routeList } from '../../../src/contracts/api/index.js';
import { OWNER, startApp } from '../../helpers.js';

function fake(respond = () => new Response('{}', { status: 200 })) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, ...options });
    return respond(url, options);
  };
  return { calls, fetch };
}
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const invoke = (client, route) => {
  const [group, name] = route.id.split('.');
  const method = client[group]?.[name];
  assert.equal(typeof method, 'function', `the client has no ${route.id}`);
  const args = route.path.includes(':') ? ['123'] : [];
  if (route.upload) args.push(new Blob(['x']));
  else if (route.body) args.push({ sample: true });
  else if (route.query) args.push({});
  return method(...args);
};

test('the client has every route in the contract, with the same method and path', async () => {
  const { calls, fetch } = fake((_url, options) => (options.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse({})));
  const client = createApiClient({ fetch });
  for (const route of routeList) {
    calls.length = 0;
    await invoke(client, route);
    assert.equal(calls.length, 1, route.id);
    assert.equal(calls[0].method, route.method, route.id);
    assert.equal(calls[0].url, `/api/v1${route.path.replace(':id', '123')}`, route.id);
    if (route.body) assert.equal(calls[0].headers['content-type'], 'application/json', route.id);
    if (route.upload) assert.ok(calls[0].body instanceof FormData, route.id);
  }
});

test('the client has nothing the contract does not', () => {
  const client = createApiClient({ fetch: fake().fetch });
  const inClient = Object.entries(client).flatMap(([group, methods]) => Object.keys(methods).map((name) => `${group}.${name}`)).sort();
  assert.deepEqual(inClient, routeList.map((r) => r.id).sort());
});

test('query strings leave out empty values and ids are escaped', async () => {
  const { calls, fetch } = fake();
  const client = createApiClient({ fetch });
  await client.products.list({ search: 'blue pot', status: '', category: undefined, cursor: null, limit: 5 });
  assert.equal(calls[0].url, '/api/v1/products?search=blue+pot&limit=5');
  await client.products.get('1/../2');
  assert.equal(calls[1].url, '/api/v1/products/1%2F..%2F2');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].headers['content-type'], undefined);
});

test('a bearer token is sent when there is one, and uploads keep the browser\'s content type', async () => {
  const { calls, fetch } = fake();
  let token = 'abc';
  const client = createApiClient({ baseUrl: 'https://shop.example/api/v1', getToken: () => token, fetch });
  await client.stats.dashboard();
  assert.equal(calls[0].url, 'https://shop.example/api/v1/stats/dashboard');
  assert.equal(calls[0].headers.authorization, 'Bearer abc');
  token = null;
  await client.media.upload(new Blob(['x']));
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers['content-type'], undefined);
});

test('the CSRF token is learned from the session, sent on changes only, and forgotten at sign-out', async () => {
  const { calls, fetch } = fake((url, options) => (url.endsWith('/auth/logout') ? new Response(null, { status: 204 }) : url.includes('/auth/') ? jsonResponse({ csrf: 'tok' }) : options.method === 'PATCH' ? jsonResponse({}) : jsonResponse({})));
  const client = createApiClient({ fetch });
  await client.settings.update({});
  assert.equal(calls[0].headers['x-csrf-token'], undefined);
  await client.auth.me();
  await client.settings.get();
  assert.equal(calls[2].headers['x-csrf-token'], undefined);
  await client.settings.update({});
  assert.equal(calls[3].headers['x-csrf-token'], 'tok');
  await client.auth.logout();
  assert.equal(calls[4].headers['x-csrf-token'], 'tok');
  await client.settings.update({});
  assert.equal(calls[5].headers['x-csrf-token'], undefined);
});

test('every failure arrives as an ApiError', async () => {
  const seen = [];
  const answers = [
    () => jsonResponse({ error: 'Name is required', code: 'validation_failed', fields: { name: 'Name is required' }, requestId: 'r1' }, 400),
    () => new Response('<html>Bad gateway</html>', { status: 502 }),
    () => jsonResponse({ error: 'Please log in again.', code: 'unauthorized' }, 401),
    () => { throw new TypeError('fetch failed'); },
  ];
  const client = createApiClient({ fetch: async () => answers.shift()(), onUnauthorized: (e) => seen.push(e) });

  const invalid = await client.products.create({}).catch((e) => e);
  assert.ok(invalid instanceof ApiError);
  assert.deepEqual([invalid.status, invalid.code, invalid.message, invalid.fields.name, invalid.requestId], [400, 'validation_failed', 'Name is required', 'Name is required', 'r1']);

  const gateway = await client.products.list().catch((e) => e);
  assert.deepEqual([gateway.status, gateway.code], [502, 'internal']);
  assert.deepEqual(gateway.fields, {});

  const expired = await client.products.list().catch((e) => e);
  assert.equal(expired.status, 401);
  assert.deepEqual(seen, [expired]);

  const offline = await client.products.list().catch((e) => e);
  assert.deepEqual([offline.status, offline.code], [0, 'network']);
});

test('allPages walks a list to its end', async () => {
  const cursors = [];
  const list = async ({ cursor, status }) => {
    cursors.push(cursor);
    assert.equal(status, 'active');
    if (!cursor) return { items: [1, 2], nextCursor: 'b' };
    if (cursor === 'b') return { items: [3], nextCursor: 'c' };
    return { items: [], nextCursor: null };
  };
  const out = [];
  for await (const item of allPages(list, { status: 'active' })) out.push(item);
  assert.deepEqual(out, [1, 2, 3]);
  assert.deepEqual(cursors, [undefined, 'b', 'c']);
});

test('the client works against the real server', async () => {
  const app = await startApp();
  try {
    let token = null;
    const client = createApiClient({ baseUrl: `${app.base}/api/v1`, getToken: () => token });
    const session = await client.auth.login(OWNER);
    token = session.token;
    assert.equal((await client.auth.me()).user.role, 'owner');
    const notBuilt = await client.products.list({ limit: 5 }).catch((e) => e);
    assert.equal(notBuilt.code, 'not_implemented');
    assert.equal(await client.auth.logout(), null);
    assert.equal((await client.auth.me().catch((e) => e)).status, 401);
  } finally {
    app.close();
  }
});

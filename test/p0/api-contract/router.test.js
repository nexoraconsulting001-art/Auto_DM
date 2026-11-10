// The /api/v1 router: who gets in, what input it takes, what leaves it, and the one error format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ErrorBody, routeList } from '../../../src/contracts/api/index.js';
import { MODULES } from '../../../src/modules/index.js';
import { setLogSink } from '../../../src/platform/log.js';
import { tenantId } from '../../../src/tenancy.js';
import { ValidationError } from '../../../src/util.js';
import { OWNER, startApp } from '../../helpers.js';
import { at, json } from '../backend-gaps/support.js';

const shopper = { name: 'Asha K', phone: '9876543210', password: 'secret1' };
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const expectError = async (res, status, code) => {
  assert.equal(res.status, status);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.equal(ErrorBody.safeParse(body).success, true, JSON.stringify(body));
  assert.equal(body.code, code);
  return body;
};

const product = {
  id: 7, name: 'Pot', slug: 'pot', description: '', pricePaise: 19900, mrpPaise: null, images: [], optionLabel: '', optionValues: [],
  stock: null, active: true, featured: false, createdAt: new Date(0), updatedAt: new Date(0), categoryIds: [],
};

async function appWith(api = () => ({}), overrides = {}) {
  const app = await startApp({ modules: [...MODULES, { name: 'probe', api }], overrides });
  const signIn = async (who) => (await (await fetch(`${app.base}/api/v1/auth/login`, json(who))).json()).token;
  return { ...app, signIn, owner: await signIn(OWNER) };
}

const sampled = (path) => path.replace(':id', '123');

test('a route nobody answers yet says so, in the error format, only to those allowed to call it', async () => {
  const app = await appWith();
  try {
    await expectError(await fetch(`${app.base}/api/v1/products`), 401, 'unauthorized');
    await expectError(await fetch(`${app.base}/api/v1/products`, { headers: bearer(app.owner) }), 501, 'not_implemented');
  } finally {
    app.close();
  }
});

test('every seller route refuses strangers, shoppers and staff with no permissions', async () => {
  const app = await appWith();
  try {
    await app.repos.users.create(shopper);
    const customer = await app.signIn(shopper);
    await app.repos.users.create({ name: 'Ravi S', phone: '9876543211', password: 'secret1', role: 'staff' });
    const staff = await app.signIn({ phone: '9876543211', password: 'secret1' });

    const sellerRoutes = routeList.filter((r) => r.access.roles);
    assert.ok(sellerRoutes.length >= 25);
    for (const route of sellerRoutes) {
      const url = `${app.base}/api/v1${sampled(route.path)}`;
      await expectError(await fetch(url, { method: route.method }), 401, 'unauthorized');
      await expectError(await fetch(url, { method: route.method, headers: bearer(customer) }), 403, 'forbidden');
      await expectError(await fetch(url, { method: route.method, headers: bearer(staff) }), 403, 'forbidden');
    }
  } finally {
    app.close();
  }
});

test('refusals and failed lookups are logged with ids only', async () => {
  const lines = [];
  setLogSink((line) => lines.push(JSON.parse(line)));
  const app = await appWith(() => ({ 'products.get': () => null }));
  try {
    await app.repos.users.create(shopper);
    const customer = await app.signIn(shopper);
    await fetch(`${app.base}/api/v1/products/123`, { headers: bearer(customer) });
    await fetch(`${app.base}/api/v1/products/456`, { headers: bearer(app.owner) });
    const refused = lines.find((l) => l.msg === 'api.forbidden');
    assert.equal(refused.route, 'products.get');
    assert.equal(refused.role, 'customer');
    const missing = lines.find((l) => l.msg === 'api.not_found');
    assert.equal(missing.route, 'products.get');
    assert.equal(missing.target, '456');
    assert.equal(missing.tenant, 'default');
    assert.ok(!JSON.stringify(lines).includes(shopper.phone));
    assert.ok(!JSON.stringify(lines).includes(OWNER.phone));
  } finally {
    setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`));
    app.close();
  }
});

test('bad input is a 400 that names the field, and the handler never sees it', async () => {
  let called = 0;
  const app = await appWith(() => ({ 'products.create': () => { called++; return product; }, 'products.list': () => { called++; return { items: [], nextCursor: null }; } }));
  try {
    const post = (body) => fetch(`${app.base}/api/v1/products`, json(body, bearer(app.owner)));
    const missing = await expectError(await post({ pricePaise: 100 }), 400, 'validation_failed');
    assert.ok(missing.fields.name);
    const several = await expectError(await post({ name: '', pricePaise: 1.5 }), 400, 'validation_failed');
    assert.equal(several.fields.name, 'Name is required');
    assert.ok(several.fields.pricePaise);
    for (const body of [[], { name: 'a\0b', pricePaise: 1 }, { name: 'x'.repeat(121), pricePaise: 1 }, { name: 'x', pricePaise: 2 ** 40 }, { name: 'x', pricePaise: '100' }, { name: 'x', pricePaise: 1, images: ['javascript:alert(1)'] }, { name: { a: 1 }, pricePaise: 1 }]) {
      await expectError(await post(body), 400, 'validation_failed');
    }
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'status=nope', 'category=99999999999', 'limit=1&limit=2', `search=${'x'.repeat(81)}`, 'search=a%00b', 'cursor=%27']) {
      await expectError(await fetch(`${app.base}/api/v1/products?${query}`, { headers: bearer(app.owner) }), 400, 'validation_failed');
    }
    assert.equal(called, 0);
  } finally {
    app.close();
  }
});

test('input reaches the handler parsed, with unknown fields gone', async () => {
  const seen = [];
  const app = await appWith(() => ({
    'products.list': ({ query }) => { seen.push(query); return { items: [], nextCursor: null }; },
    'products.create': ({ body, user }) => { seen.push({ body, role: user.role, business: tenantId() }); return product; },
  }));
  try {
    const list = await fetch(`${app.base}/api/v1/products?category=12&limit=5&extra=1`, { headers: bearer(app.owner) });
    assert.equal(list.status, 200);
    assert.deepEqual(seen[0], { category: 12, limit: 5, status: 'all' });
    const created = await fetch(`${app.base}/api/v1/products`, json({ name: '  Pot ', pricePaise: 100, tenant_id: 99, id: 5 }, bearer(app.owner)));
    assert.equal(created.status, 201);
    assert.deepEqual(seen[1].body, { name: 'Pot', pricePaise: 100 });
    assert.equal(seen[1].role, 'owner');
    assert.equal(seen[1].business, app.tenant.id);
  } finally {
    app.close();
  }
});

test('only JSON is accepted where a route takes a body, so a cross-site form can do nothing', async () => {
  let called = 0;
  const app = await appWith(() => ({ 'products.create': () => { called++; return product; } }));
  try {
    const form = await fetch(`${app.base}/api/v1/products`, { method: 'POST', headers: bearer(app.owner), body: new URLSearchParams({ name: 'x', pricePaise: '1' }) });
    await expectError(form, 415, 'unsupported_media_type');
    const login = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', body: new URLSearchParams({ phone: OWNER.phone, password: OWNER.password, transport: 'cookie' }) });
    await expectError(login, 415, 'unsupported_media_type');
    assert.equal(login.headers.get('set-cookie'), null);
    assert.equal(called, 0);
  } finally {
    app.close();
  }
});

test('an unreadable or oversized body gets the error format, not a 500', async () => {
  const app = await appWith();
  try {
    const headers = { 'content-type': 'application/json', ...bearer(app.owner) };
    await expectError(await fetch(`${app.base}/api/v1/products`, { method: 'POST', headers, body: '{"name":' }), 400, 'validation_failed');
    await expectError(await fetch(`${app.base}/api/v1/products`, { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(300 * 1024) }) }), 413, 'payload_too_large');
  } finally {
    app.close();
  }
});

test('a lookup that finds nothing is a 404, and so is an id that could never exist', async () => {
  const lookedUp = [];
  const app = await appWith(() => ({ 'products.get': ({ params }) => { lookedUp.push(params.id); return null; } }));
  try {
    const headers = bearer(app.owner);
    await expectError(await fetch(`${app.base}/api/v1/products/5`, { headers }), 404, 'not_found');
    for (const id of ['abc', '0', '-1', '99999999999', '1%2F2', '1.5']) {
      await expectError(await fetch(`${app.base}/api/v1/products/${id}`, { headers }), 404, 'not_found');
    }
    assert.deepEqual(lookedUp, [5]);
  } finally {
    app.close();
  }
});

test('nothing outside the response schema leaves the server', async () => {
  const app = await appWith(() => ({
    'products.get': () => ({ ...product, password_hash: 'scrypt$secret', tenant_id: 1 }),
    'categories.get': () => ({ wrong: 'shape', password_hash: 'scrypt$secret' }),
  }));
  try {
    const headers = bearer(app.owner);
    const good = await fetch(`${app.base}/api/v1/products/7`, { headers });
    const body = await good.json();
    assert.equal(body.name, 'Pot');
    assert.equal(body.createdAt, '1970-01-01T00:00:00.000Z');
    assert.equal('password_hash' in body, false);
    assert.equal('tenant_id' in body, false);

    const bad = await fetch(`${app.base}/api/v1/categories/7`, { headers });
    const error = await expectError(bad, 500, 'internal');
    assert.doesNotMatch(JSON.stringify(error), /scrypt|shape/);
  } finally {
    app.close();
  }
});

test('handlers refuse with ApiError, repos with ValidationError, and a crash tells the caller nothing', async () => {
  const lines = [];
  setLogSink((line) => lines.push(line));
  const app = await appWith(() => ({
    'products.remove': () => { throw new ApiError('conflict', 'This product is part of an order.'); },
    'products.get': () => { throw new ValidationError('That link name is taken'); },
    'categories.get': () => { throw new Error('connection string with a password in it'); },
    'categories.remove': () => undefined,
  }));
  try {
    const headers = bearer(app.owner);
    const conflict = await expectError(await fetch(`${app.base}/api/v1/products/1`, { method: 'DELETE', headers }), 409, 'conflict');
    assert.equal(conflict.error, 'This product is part of an order.');
    const invalid = await expectError(await fetch(`${app.base}/api/v1/products/1`, { headers }), 400, 'validation_failed');
    assert.equal(invalid.error, 'That link name is taken');
    const crash = await expectError(await fetch(`${app.base}/api/v1/categories/1`, { headers }), 500, 'internal');
    assert.doesNotMatch(crash.error, /password/);
    assert.ok(crash.requestId);
    assert.ok(lines.some((l) => l.includes('http.error')));

    const removed = await fetch(`${app.base}/api/v1/categories/1`, { method: 'DELETE', headers });
    assert.equal(removed.status, 204);
    assert.equal(await removed.text(), '');
  } finally {
    setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`));
    app.close();
  }
});

test('anything else under /api/v1 is the JSON 404, and the storefront is not reached', async () => {
  const app = await appWith(undefined, { defaultTenant: '' });
  try {
    await app.platform.tenants.addDomain(app.tenant.id, 'default.example');
    const onShop = at('default.example');
    await expectError(await fetch(`${app.base}/api/v1/no-such-thing`, { headers: onShop }), 404, 'not_found');
    await expectError(await fetch(`${app.base}/api/v1`, { headers: onShop }), 404, 'not_found');
    await expectError(await fetch(`${app.base}/api/v1/products`, { method: 'PUT', headers: onShop }), 404, 'not_found');
    await expectError(await fetch(`${app.base}/api/v1/auth/me`, { headers: at('nobody.example') }), 404, 'not_found');
    // A path with broken percent-encoding is the caller's mistake, not ours.
    await expectError(await fetch(`${app.base}/api/v1/products/%E0%A4%A`, { headers: onShop }), 400, 'validation_failed');
  } finally {
    app.close();
  }
});

test('API answers are never cached', async () => {
  const app = await appWith(() => ({ 'products.get': () => product }));
  try {
    assert.equal((await fetch(`${app.base}/api/v1/products/7`, { headers: bearer(app.owner) })).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${app.base}/api/v1/auth/me`)).headers.get('cache-control'), 'no-store');
  } finally {
    app.close();
  }
});

test('the web console signs in with a cookie and a CSRF token, and never sees a token', async () => {
  const app = await appWith(() => ({ 'products.create': () => product }));
  try {
    const res = await fetch(`${app.base}/api/v1/auth/login`, json({ ...OWNER, transport: 'cookie' }));
    assert.equal(res.status, 201);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const session = await res.json();
    assert.equal(session.user.role, 'owner');
    assert.equal(session.business.slug, 'default');
    assert.deepEqual(session.user.permissions, []);
    assert.ok(session.csrf);
    assert.equal('token' in session, false);

    const cookie = setCookie.split(';')[0];
    const me = await (await fetch(`${app.base}/api/v1/auth/me`, { headers: { cookie } })).json();
    assert.equal(me.csrf, session.csrf);

    const body = { name: 'Pot', pricePaise: 100 };
    const refused = await expectError(await fetch(`${app.base}/api/v1/products`, json(body, { cookie })), 403, 'forbidden');
    assert.match(refused.error, /expired/);
    assert.equal((await fetch(`${app.base}/api/v1/products`, json(body, { cookie, 'x-csrf-token': session.csrf }))).status, 201);

    await expectError(await fetch(`${app.base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie } }), 403, 'forbidden');
    const out = await fetch(`${app.base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie, 'x-csrf-token': session.csrf } });
    assert.equal(out.status, 204);
    assert.match(out.headers.get('set-cookie'), /sid=;/);
    await expectError(await fetch(`${app.base}/api/v1/auth/me`, { headers: { cookie } }), 401, 'unauthorized');
  } finally {
    app.close();
  }
});

test('a login on one business\'s address gives nothing on another\'s', async () => {
  const app = await appWith();
  try {
    await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf and Clay' });
    const res = await fetch(`${app.base}/api/v1/auth/login`, json({ ...OWNER, transport: 'cookie' }));
    const cookie = res.headers.get('set-cookie').split(';')[0];
    await expectError(await fetch(`${app.base}/api/v1/auth/me`, { headers: { cookie, ...at('leaf.bhava.test') } }), 401, 'unauthorized');
  } finally {
    app.close();
  }
});

test('login failures use the error format and the session names the seller\'s logo', async () => {
  const app = await appWith();
  try {
    await expectError(await fetch(`${app.base}/api/v1/auth/login`, json({ phone: OWNER.phone, password: 'wrong' })), 401, 'unauthorized');
    await app.repos.brandKit.save({ logoUrl: 'https://cdn.example/logo.png' });
    const me = await (await fetch(`${app.base}/api/v1/auth/me`, { headers: bearer(app.owner) })).json();
    assert.equal(me.business.logoUrl, 'https://cdn.example/logo.png');
    assert.equal('csrf' in me, false);
    for (let i = 0; i < 10; i++) await fetch(`${app.base}/api/v1/auth/login`, json({ phone: OWNER.phone, password: 'wrong' }));
    await expectError(await fetch(`${app.base}/api/v1/auth/login`, json(OWNER)), 429, 'rate_limited');
  } finally {
    app.close();
  }
});

test('an upload is checked for type and size before the handler runs', async () => {
  const received = [];
  const id = '3f0c2c1e-8f5b-4e8a-9a67-1d1c7f2a0b11';
  const app = await appWith(() => ({ 'media.upload': ({ file }) => { received.push(file); return { id, url: `/media/${id}` }; } }));
  try {
    const send = (blob, field = 'file', name = 'a.png') => {
      const form = new FormData();
      form.append(field, blob, name);
      return fetch(`${app.base}/api/v1/media`, { method: 'POST', headers: bearer(app.owner), body: form });
    };
    const png = new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const ok = await send(png);
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { id, url: `/media/${id}` });
    assert.equal(received[0].mimetype, 'image/png');
    assert.equal(received[0].buffer.length, 4);

    await expectError(await send(new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'file', 'a.svg'), 415, 'unsupported_media_type');
    await expectError(await send(new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/png' })), 413, 'payload_too_large');
    await expectError(await send(png, 'other'), 400, 'validation_failed');
    await expectError(await fetch(`${app.base}/api/v1/media`, { method: 'POST', headers: bearer(app.owner) }), 400, 'validation_failed');
    assert.equal(received.length, 1);
  } finally {
    app.close();
  }
});

test('a module cannot answer a route outside the contract, or one already answered', async () => {
  await assert.rejects(() => startApp({ modules: [...MODULES, { name: 'stray', api: () => ({ 'products.nope': () => null }) }] }), /not in the API contract/);
  await assert.rejects(() => startApp({ modules: [...MODULES, { name: 'twin', api: () => ({ 'auth.me': () => null }) }] }), /both answer "auth\.me"/);
});

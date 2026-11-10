import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTenant } from '../../../src/repos/index.js';
import { OWNER, login, seedReel, startApp } from '../../helpers.js';
import { at, json } from './support.js';

const customer = { name: 'Asha K', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' };
const bearer = (token) => ({ authorization: `Bearer ${token}` });

async function token(app, { phone = OWNER.phone, password = OWNER.password } = {}, headers = {}) {
  const res = await fetch(`${app.base}/api/v1/auth/login`, json({ phone, password }, headers));
  assert.equal(res.status, 201);
  return res.json();
}

async function withLeaf(app) {
  const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf and Clay' });
  const leaf = bindTenant(app.platform, other);
  await leaf.users.ensureOwner({ phone: '9000000009', password: 'leaf-owner' });
  return { other, leaf };
}

test('a login returns a token, and the token says who and which business', async () => {
  const app = await startApp();
  try {
    const session = await token(app);
    assert.equal(session.user.role, 'owner');
    assert.equal(session.business.slug, 'default');
    assert.equal('password_hash' in session.user, false);
    const me = await (await fetch(`${app.base}/api/v1/auth/me`, { headers: bearer(session.token) })).json();
    assert.equal(me.user.phone, OWNER.phone);
    assert.equal(me.business.slug, 'default');
  } finally {
    app.close();
  }
});

test('the business comes from the token, not the web address', async () => {
  const app = await startApp({ overrides: { defaultTenant: '' } });
  try {
    const { other } = await withLeaf(app);
    await app.platform.tenants.addDomain(app.tenant.id, 'default.example');
    const session = await token(app, undefined, at('default.example'));

    // An address with no business at all, and the address of a different business.
    for (const host of ['nobody.example', 'leaf.bhava.test']) {
      const res = await fetch(`${app.base}/api/v1/auth/me`, { headers: { ...bearer(session.token), ...at(host) } });
      assert.equal(res.status, 200, host);
      assert.equal((await res.json()).business.id, app.tenant.id, host);
    }
    // Without the token, those addresses mean what they always did.
    assert.equal((await fetch(`${app.base}/`, { headers: at('nobody.example') })).status, 404);
    assert.ok(other);
  } finally {
    app.close();
  }
});

test('one business\'s token finds nothing of another business, on any address', async () => {
  const app = await startApp();
  try {
    const { leaf } = await withLeaf(app);
    const product = await leaf.products.create({ name: 'SECRET Pot', price: '199', active: 'on' });
    const session = await token(app);
    for (const headers of [bearer(session.token), { ...bearer(session.token), ...at('leaf.bhava.test') }]) {
      const page = await fetch(`${app.base}/admin/products/${product.id}`, { headers, redirect: 'manual' });
      assert.equal(page.status, 302);
      assert.equal(page.headers.get('location'), '/admin/products');
      assert.doesNotMatch(await (await fetch(`${app.base}/admin/products`, { headers })).text(), /SECRET/);
      assert.deepEqual((await (await fetch(`${app.base}/api/products?ids=${product.id}`, { headers })).json()).products, []);
    }
  } finally {
    app.close();
  }
});

test('a bad token is refused everywhere, never treated as a guest', async () => {
  const app = await startApp();
  try {
    for (const path of ['/', '/shop', '/api/v1/auth/me', '/admin']) {
      const res = await fetch(`${app.base}${path}`, { headers: bearer('not-a-real-token'), redirect: 'manual' });
      assert.equal(res.status, 401, path);
    }
    assert.equal((await fetch(`${app.base}/`, { headers: bearer('x'.repeat(5000)) })).status, 401);
    // Other kinds of Authorization header are left alone.
    assert.equal((await fetch(`${app.base}/`, { headers: { authorization: 'Basic abc' } })).status, 200);
  } finally {
    app.close();
  }
});

test('expired, revoked and logged-out tokens stop working', async () => {
  const app = await startApp();
  try {
    const me = (t) => fetch(`${app.base}/api/v1/auth/me`, { headers: bearer(t) });

    const out = (await token(app)).token;
    assert.equal((await fetch(`${app.base}/api/v1/auth/logout`, { method: 'POST', headers: bearer(out) })).status, 204);
    assert.equal((await me(out)).status, 401);

    const expiring = (await token(app)).token;
    await app.db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE kind = 'bearer' AND revoked_at IS NULL`);
    assert.equal((await me(expiring)).status, 401);

    await app.repos.users.create({ name: 'Asha K', phone: customer.phone, password: 'secret1' });
    const before = (await token(app, { phone: customer.phone, password: 'secret1' })).token;
    const user = await app.repos.users.findByPhone(customer.phone);
    await app.repos.users.setPassword(user.id, 'secret2');
    assert.equal((await me(before)).status, 401, 'a new password ends every session');
  } finally {
    app.close();
  }
});

test('a deleted user\'s token stops working', async () => {
  const app = await startApp();
  try {
    await app.repos.users.create({ name: 'Asha K', phone: customer.phone, password: 'secret1' });
    const t = (await token(app, { phone: customer.phone, password: 'secret1' })).token;
    await app.db.query('DELETE FROM users WHERE phone = $1', [customer.phone]);
    assert.equal((await fetch(`${app.base}/api/v1/auth/me`, { headers: bearer(t) })).status, 401);
  } finally {
    app.close();
  }
});

test('a cookie token is not a bearer token, and a bearer token is not a cookie', async () => {
  const app = await startApp();
  try {
    const { cookie } = await login(app.base);
    const cookieToken = decodeURIComponent(cookie.split('=').slice(1).join('='));
    assert.equal((await fetch(`${app.base}/api/v1/auth/me`, { headers: bearer(cookieToken) })).status, 401);

    const session = await token(app);
    const res = await fetch(`${app.base}/admin`, { headers: { cookie: `sid=${encodeURIComponent(session.token)}` }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/login/);
  } finally {
    app.close();
  }
});

test('CSRF applies to cookie sessions only', async () => {
  const app = await startApp();
  try {
    const { products } = await seedReel(app.repos, { n: 1 });
    const body = { items: [{ productId: products[0].id, qty: 1 }], customer };
    await app.repos.users.create({ name: 'Asha K', phone: customer.phone, password: 'secret1' });

    const cookieSession = await login(app.base, { phone: customer.phone, password: 'secret1', csrfPage: '/checkout' });
    assert.equal((await fetch(`${app.base}/api/orders`, json(body, { cookie: cookieSession.cookie }))).status, 403);

    const session = await token(app, { phone: customer.phone, password: 'secret1' });
    assert.equal((await fetch(`${app.base}/api/orders`, json(body, bearer(session.token)))).status, 201);

    // A bearer token alongside a cookie: the token decides, so the cookie gets no CSRF-free ride of its own.
    const both = await fetch(`${app.base}/api/v1/auth/me`, { headers: { ...bearer(session.token), cookie: cookieSession.cookie } });
    assert.equal(both.status, 200);
    const badBearerWithCookie = await fetch(`${app.base}/api/orders`, json(body, { ...bearer('bad'), cookie: cookieSession.cookie }));
    assert.equal(badBearerWithCookie.status, 401);
  } finally {
    app.close();
  }
});

test('a shopper\'s token does not open the admin panel', async () => {
  const app = await startApp();
  try {
    await app.repos.users.create({ name: 'Asha K', phone: customer.phone, password: 'secret1' });
    const session = await token(app, { phone: customer.phone, password: 'secret1' });
    const res = await fetch(`${app.base}/admin`, { headers: bearer(session.token), redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/account');
    assert.equal((await fetch(`${app.base}/admin/products`, json({ name: 'X', price: '1' }, bearer(session.token)))).status, 403);
  } finally {
    app.close();
  }
});

test('API login checks the password, is rate limited, and works only for that business', async () => {
  const app = await startApp();
  try {
    await withLeaf(app);
    const wrongBusiness = await fetch(`${app.base}/api/v1/auth/login`, json({ phone: OWNER.phone, password: OWNER.password }, at('leaf.bhava.test')));
    assert.equal(wrongBusiness.status, 401);
    for (const body of [{}, { phone: OWNER.phone }, { phone: { x: 1 }, password: ['a'] }]) {
      assert.equal((await fetch(`${app.base}/api/v1/auth/login`, json(body))).status, 401);
    }
    for (let i = 0; i < 7; i++) await fetch(`${app.base}/api/v1/auth/login`, json({ phone: OWNER.phone, password: 'wrong' }));
    assert.equal((await fetch(`${app.base}/api/v1/auth/login`, json({ phone: OWNER.phone, password: OWNER.password }))).status, 429);
  } finally {
    app.close();
  }
});

test('/api/v1/auth/me without a session is 401', async () => {
  const app = await startApp();
  try {
    assert.equal((await fetch(`${app.base}/api/v1/auth/me`)).status, 401);
    assert.equal((await fetch(`${app.base}/api/v1/auth/logout`, { method: 'POST' })).status, 401);
  } finally {
    app.close();
  }
});

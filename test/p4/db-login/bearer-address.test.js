// A bearer token names its own business. Sent to another business's own address it is refused (401), so a
// token taken from one store cannot be replayed through another store's site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTenant } from '../../../src/repos/index.js';
import { createTenantResolver } from '../../../src/tenancy.js';
import { OWNER, startApp } from '../../helpers.js';

const LEAF_OWNER = { phone: '9000000009', password: 'leaf-owner' };
const at = (host) => ({ 'x-forwarded-host': host });
const bearer = (token) => ({ authorization: `Bearer ${token}` });

/** The default business on default.example and a second one, "leaf", on leaf.bhava.test and leafandclay.example. */
async function twoStores(overrides = {}) {
  const app = await startApp({ overrides });
  const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf and Clay' });
  await bindTenant(app.platform, other).users.ensureOwner(LEAF_OWNER);
  await app.platform.tenants.addDomain(app.tenant.id, 'default.example');
  await app.platform.tenants.addDomain(other.id, 'leafandclay.example');
  const token = async (who, host) => {
    const res = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...at(host) }, body: JSON.stringify(who) });
    assert.equal(res.status, 201);
    return (await res.json()).token;
  };
  const me = (t, host) => fetch(`${app.base}/api/v1/auth/me`, { headers: { ...bearer(t), ...(host ? at(host) : {}) } });
  return { app, other, token, me };
}

test('a token for one business is refused with 401 on another business\'s address', async () => {
  const { app, other, token, me } = await twoStores({ defaultTenant: '' });
  try {
    const mine = await token(OWNER, 'default.example');
    const theirs = await token(LEAF_OWNER, 'leaf.bhava.test');

    for (const host of ['leaf.bhava.test', 'leafandclay.example', 'LEAF.bhava.test', 'leaf.bhava.test:443']) {
      const res = await me(mine, host);
      assert.equal(res.status, 401, host);
      assert.deepEqual(await res.json(), { error: 'Please log in again.', code: 'unauthorized' }, 'the same answer as a bad token');
    }
    for (const host of ['default.example', 'default.bhava.test']) assert.equal((await me(theirs, host)).status, 401, host);

    // Every route, not only the API: nothing of either business is served.
    for (const path of ['/', '/shop', '/admin', '/api/v1/products', '/api/products']) {
      const res = await fetch(`${app.base}${path}`, { headers: { ...bearer(mine), ...at('leaf.bhava.test') }, redirect: 'manual' });
      assert.equal(res.status, 401, path);
    }
    const write = await fetch(`${app.base}/api/v1/auth/logout`, { method: 'POST', headers: { ...bearer(mine), ...at('leaf.bhava.test') } });
    assert.equal(write.status, 401);
    assert.equal((await me(mine, 'default.example')).status, 200, 'and the refused logout did not end the session');

    // On its own addresses each token works, and says its own business.
    for (const host of ['default.example', 'default.bhava.test']) {
      const res = await me(mine, host);
      assert.equal(res.status, 200, host);
      assert.equal((await res.json()).business.id, app.tenant.id);
    }
    for (const host of ['leaf.bhava.test', 'leafandclay.example']) {
      const res = await me(theirs, host);
      assert.equal(res.status, 200, host);
      assert.equal((await res.json()).business.id, other.id);
    }
  } finally {
    app.close();
  }
});

test('an address that belongs to no business takes any token, and the token still names the business', async () => {
  const { app, other, token, me } = await twoStores({ defaultTenant: '' });
  try {
    const mine = await token(OWNER, 'default.example');
    const theirs = await token(LEAF_OWNER, 'leaf.bhava.test');
    for (const host of ['nobody.example', 'api.bhava.test', undefined]) {
      const a = await me(mine, host);
      assert.equal(a.status, 200, String(host));
      assert.equal((await a.json()).business.id, app.tenant.id);
      const b = await me(theirs, host);
      assert.equal(b.status, 200, String(host));
      assert.equal((await b.json()).business.id, other.id);
    }
  } finally {
    app.close();
  }
});

test('an address that only falls back to the default business is not that business\'s own address', async () => {
  const { app, other, token, me } = await twoStores({ defaultTenant: 'default' });
  try {
    const theirs = await token(LEAF_OWNER, 'leaf.bhava.test');
    // With no token this address shows the default business, by fallback.
    assert.equal((await fetch(`${app.base}/`, { headers: at('anything.example') })).status, 200);
    const res = await me(theirs, 'anything.example');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).business.id, other.id);
    // The default business's own addresses still refuse it.
    assert.equal((await me(theirs, 'default.example')).status, 401);
    assert.equal((await me(theirs, 'default.bhava.test')).status, 401);
  } finally {
    app.close();
  }
});

test('the resolver tells an address a business owns from one it only falls back to', async () => {
  const stores = { a: { id: 1, slug: 'a' }, fallback: { id: 2, slug: 'fallback' }, custom: { id: 3, slug: 'custom' } };
  let lookups = 0;
  const tenants = {
    getByDomain: async (host) => (lookups++, host === 'custom.example' ? stores.custom : null),
    getBySlug: async (slug) => stores[slug] ?? null,
  };
  const resolver = createTenantResolver({ tenants, platformDomain: 'bhava.test', defaultTenant: 'fallback' });
  assert.equal((await resolver.owner('custom.example')).id, 3);
  assert.equal((await resolver.owner('A.bhava.test:8443')).id, 1);
  assert.equal(await resolver.owner('elsewhere.example'), null);
  assert.equal(await resolver.owner('nobody.bhava.test'), null);
  assert.equal(await resolver.owner('deep.a.bhava.test'), null);
  // resolve() is unchanged: the fallback still answers.
  assert.equal((await resolver.resolve('elsewhere.example')).id, 2);
  assert.equal((await resolver.resolve('custom.example')).id, 3);
  const before = lookups;
  await resolver.owner('custom.example');
  await resolver.resolve('custom.example');
  assert.equal(lookups, before, 'both answers come from one cached lookup');
});

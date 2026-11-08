// R-01 and friends: one business can never see, change or link to another business's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, runMigrations } from '../src/db/index.js';
import { bindTenant, createRepos } from '../src/repos/index.js';
import { NoTenantError, createTenantResolver } from '../src/tenancy.js';
import { OWNER, REEL_ID, login, seedReel, setup, startApp } from './helpers.js';

const form = (o) => new URLSearchParams(o);

async function twoBusinesses() {
  const { db, platform, repos: a, tenant } = await setup();
  const other = await platform.tenants.create({ slug: 'leaf-and-clay', name: 'Leaf and Clay' });
  return { db, platform, a, b: bindTenant(platform, other), tenantA: tenant, tenantB: other };
}

test('business data cannot be used without a current business', async () => {
  const { platform } = await setup();
  await assert.rejects(() => platform.products.list(), NoTenantError);
  await assert.rejects(() => platform.settings.getAll(), NoTenantError);
});

test('migrations run once and are safe to run again', async () => {
  const db = await openDb();
  assert.deepEqual(await runMigrations(db), []);
  const rows = await db.query('SELECT version FROM schema_migrations');
  assert.deepEqual(rows.map((r) => r.version), ['001', '002']);
});

test('one business cannot read, change or delete another business’s products', async () => {
  const { a, b } = await twoBusinesses();
  const p = await a.products.create({ name: 'Brass lamp', price: '499', active: 'on' });

  assert.equal(await b.products.get(p.id), null);
  assert.equal(await b.products.getActiveBySlug(p.slug), null);
  assert.deepEqual(await b.products.getActiveByIds([p.id]), []);
  assert.equal((await b.products.list()).length, 0);
  assert.equal((await b.products.listActive()).total, 0);
  await assert.rejects(() => b.products.update(p.id, { name: 'Hijacked', price: '1' }), /not found/);
  await b.products.remove(p.id);
  assert.equal((await a.products.get(p.id)).name, 'Brass lamp');
});

test('the same link names can be used by two businesses', async () => {
  const { a, b } = await twoBusinesses();
  const pa = await a.products.create({ name: 'Brass lamp', price: '499', active: 'on' });
  const pb = await b.products.create({ name: 'Brass lamp', price: '899', active: 'on' });
  assert.equal(pa.slug, pb.slug);
  await a.categories.save(null, { name: 'Lamps', visible: 'on' });
  await b.categories.save(null, { name: 'Lamps', visible: 'on' });
  assert.equal((await b.products.getActiveBySlug(pb.slug)).price_paise, 89900);
});

test('a reel cannot use another business’s products or Instagram post', async () => {
  const { a, b } = await twoBusinesses();
  const { products } = await seedReel(a);
  await assert.rejects(() => b.reels.save('999', { headline: 'Steal', keywords: 'LINK', productIds: [products[0].id] }), /no longer exists/);
  const own = await b.products.create({ name: 'Plant pot', price: '199', active: 'on' });
  await assert.rejects(() => b.reels.save(REEL_ID, { headline: 'Mine', keywords: 'LINK', productIds: [own.id] }), /another business/);
  assert.equal((await a.reels.get(REEL_ID)).headline, 'Brunch edit');
  assert.equal(await b.reels.get(REEL_ID), null);
});

test('the database refuses links between two businesses even if code forgot to check', async () => {
  const { db, a, tenantB } = await twoBusinesses();
  const p = await a.products.create({ name: 'Brass lamp', price: '499', active: 'on' });
  const [cat] = await db.query(`INSERT INTO categories (tenant_id, name, slug) VALUES ($1, 'X', 'x') RETURNING id`, [tenantB.id]);
  await assert.rejects(
    () => db.query('INSERT INTO product_categories (tenant_id, product_id, category_id) VALUES ($1, $2, $3)', [tenantB.id, p.id, cat.id]),
    /foreign key/,
  );
});

test('order numbers count up per business, and orders stay with their business', async () => {
  const { a, b } = await twoBusinesses();
  const customer = { name: 'Asha K', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' };
  const pa = await a.products.create({ name: 'Lamp', price: '100', active: 'on' });
  const pb = await b.products.create({ name: 'Pot', price: '100', active: 'on' });
  const oa = await a.orders.create({ items: [{ productId: pa.id, qty: 1 }], customer }, await a.settings.getAll());
  const ob = await b.orders.create({ items: [{ productId: pb.id, qty: 1 }], customer }, await b.settings.getAll());
  assert.match(oa.order_number, /-1001$/);
  assert.match(ob.order_number, /-1001$/);
  assert.equal(await b.orders.get(oa.id), null);
  assert.equal(await b.orders.getByToken(oa.public_token), null);
  assert.equal((await b.orders.list()).length, 1);
  await assert.rejects(() => b.orders.setStatus(oa.id, 'cancelled'), /not found/);
  await assert.rejects(
    () => b.orders.create({ items: [{ productId: pa.id, qty: 1 }], customer }, {}),
    /no longer available/,
  );
});

test('settings, users and activity are kept per business', async () => {
  const { a, b } = await twoBusinesses();
  await a.settings.update({ store_name: 'Kesar Home' });
  assert.notEqual((await b.settings.getAll()).store_name, 'Kesar Home');
  await a.users.create({ name: 'Asha', phone: '9876543210', password: 'secret1' });
  assert.equal(await b.users.findByPhone('9876543210'), null);
  await b.users.create({ name: 'Asha B', phone: '9876543210', password: 'other12' });
  assert.equal(await b.users.verify('9876543210', 'secret1'), null);
  await a.activity.log({ commentId: 'c-1', reelId: REEL_ID, result: 'skip:no-keyword' });
  assert.equal(await b.activity.count(), 0);
  // A comment id that belongs to business A can never be claimed by B.
  assert.equal(await b.activity.claim({ commentId: 'c-1', reelId: REEL_ID, userId: 'u', username: 'x', text: '' }), false);
});

test('the business is found from the web address', async () => {
  const { platform, tenant } = await setup();
  const other = await platform.tenants.create({ slug: 'leaf', name: 'Leaf' });
  await platform.tenants.addDomain(other.id, 'Shop.LeafAndClay.example');
  const strict = createTenantResolver({ tenants: platform.tenants, platformDomain: 'bhava.test', defaultTenant: '' });
  assert.equal((await strict.resolve('leaf.bhava.test')).id, other.id);
  assert.equal((await strict.resolve('shop.leafandclay.example:443')).id, other.id);
  assert.equal(await strict.resolve('nobody.bhava.test'), null);
  assert.equal(await strict.resolve('a.b.bhava.test'), null);
  assert.equal(await strict.resolve('example.org'), null);
  const withDefault = createTenantResolver({ tenants: platform.tenants, platformDomain: 'bhava.test', defaultTenant: 'default' });
  assert.equal((await withDefault.resolve('example.org')).id, tenant.id);
  await assert.rejects(() => platform.tenants.addDomain(tenant.id, 'shop.leafandclay.example'), /another business/);
});

test('each site shows only its own business, and a login works only on its own site', async () => {
  const app = await startApp();
  try {
    const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf and Clay' });
    const b = bindTenant(app.platform, other);
    await b.settings.update({ store_name: 'Leaf and Clay' });
    const lamp = await app.repos.products.create({ name: 'Brass lamp', price: '499', active: 'on' });

    const at = (host, path, init = {}) => fetch(`${app.base}${path}`, { ...init, headers: { 'x-forwarded-host': host, ...init.headers }, redirect: 'manual' });
    assert.match(await (await at('leaf.bhava.test', '/')).text(), /Leaf and Clay/);
    assert.equal((await at('leaf.bhava.test', `/p/${lamp.slug}`)).status, 404);
    assert.equal((await at('shop.test', `/p/${lamp.slug}`)).status, 200);

    // The default store's owner session is not a session on Leaf and Clay's site.
    const { cookie } = await login(app.base);
    assert.equal((await fetch(`${app.base}/admin`, { headers: { cookie }, redirect: 'manual' })).status, 200);
    const there = await at('leaf.bhava.test', '/admin', { headers: { cookie } });
    assert.equal(there.status, 302);
    assert.match(there.headers.get('location'), /^\/login/);
  } finally {
    app.close();
  }
});

test('webhooks are handled as the business that owns the Instagram account', async () => {
  const app = await startApp();
  try {
    const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf and Clay' });
    await app.platform.tenants.linkIgAccount(other.id, 'IG-LEAF', 'leafandclay');
    const b = bindTenant(app.platform, other);
    await seedReel(b);
    const body = JSON.stringify({ entry: [{ id: 'IG-LEAF', changes: [{ field: 'comments', value: { id: 'c9', text: 'LINK', media: { id: REEL_ID }, from: { id: 'u1', username: 'bob' } } }] }] });
    const sig = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
    await fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
    for (let i = 0; i < 50 && !app.ig.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(app.ig.calls.length, 1);
    assert.match(app.ig.calls[0][3], /^https:\/\/leaf\.bhava\.test\/r\//);
    assert.equal(await b.activity.count(), 1);
    assert.equal(await app.repos.activity.count(), 0);
    await assert.rejects(() => app.platform.tenants.linkIgAccount(app.tenant.id, 'IG-LEAF'), /another business/);
  } finally {
    app.close();
  }
});

test('logging out or changing the password ends sessions', async () => {
  const app = await startApp();
  try {
    await app.repos.users.create({ name: 'Asha K', phone: '9876543210', password: 'secret1' });
    const first = await login(app.base, { phone: '9876543210', password: 'secret1' });
    const second = await login(app.base, { phone: '9876543210', password: 'secret1' });
    const account = (cookie) => fetch(`${app.base}/account`, { headers: { cookie }, redirect: 'manual' });
    assert.equal((await account(first.cookie)).status, 200);

    await fetch(`${app.base}/logout`, { method: 'POST', headers: { cookie: first.cookie }, body: form({ _csrf: first.csrf }), redirect: 'manual' });
    assert.equal((await account(first.cookie)).status, 302);
    assert.equal((await account(second.cookie)).status, 200);

    const change = await fetch(`${app.base}/account/password`, {
      method: 'POST', headers: { cookie: second.cookie }, body: form({ _csrf: second.csrf, current: 'secret1', password: 'secret2' }), redirect: 'manual',
    });
    assert.equal(change.status, 303);
    assert.equal((await account(second.cookie)).status, 302, 'old session ends after a password change');
    const fresh = change.headers.get('set-cookie').split(';')[0];
    assert.equal((await account(fresh)).status, 200, 'the browser that changed it stays logged in');
    assert.ok(OWNER.phone);
  } finally {
    app.close();
  }
});

test('compliance and audit logs cannot be edited', async () => {
  const { db, tenant } = await setup();
  await db.query(`INSERT INTO compliance_events (tenant_id, kind, decision) VALUES ($1, 'dm', 'allow')`, [tenant.id]);
  await db.query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'test', 'login')`, [tenant.id]);
  await assert.rejects(() => db.query(`UPDATE compliance_events SET decision = 'deny'`), /insert-only/);
  await assert.rejects(() => db.query(`UPDATE audit_log SET action = 'x'`), /insert-only/);
  await assert.rejects(() => db.query('DELETE FROM compliance_events'), /retention/);
  await assert.rejects(() => db.query('DELETE FROM audit_log'), /retention/);
});

test('bindTenant keeps repos on their own business', async () => {
  const db = await openDb();
  const platform = createRepos(db);
  const t1 = await platform.tenants.create({ slug: 'one', name: 'One' });
  const t2 = await platform.tenants.create({ slug: 'two', name: 'Two' });
  await bindTenant(platform, t1).products.create({ name: 'A', price: '1', active: 'on' });
  assert.equal((await bindTenant(platform, t2).products.list()).length, 0);
  assert.equal((await bindTenant(platform, t1).products.list()).length, 1);
});

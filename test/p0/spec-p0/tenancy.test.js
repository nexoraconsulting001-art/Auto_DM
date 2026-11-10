// PRD 5.1 and the isolation scenario of section 11: one business can never see or touch another's rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER, TINY_PNG, addBusiness, addOrder, addProduct, addStaff, api, asAppRole, assertAttemptLogged, captureLogs, findAppRole, hit, need, requestId, signIn, startWorld, uploadFile } from './support.js';
import { setup } from '../../helpers.js';

async function twoBusinesses(t) {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  return { app, a, b };
}

test('F-01: two businesses both save the slug kids-toy and each storefront shows only its own', async (t) => {
  const { app, a, b } = await twoBusinesses(t);
  const create = async (business, description) => {
    const token = await signIn(app, business);
    const res = need(await api(app, business, token, '/products', { method: 'POST', body: { name: 'Kids Toy', pricePaise: 49900, description, active: true } }), 201, 'Create product');
    return res.json();
  };
  const madeA = await create(a, 'Only in the Alpha catalogue');
  const madeB = await create(b, 'Only in the Beta catalogue');
  assert.equal(madeA.slug, 'kids-toy');
  assert.equal(madeB.slug, 'kids-toy');

  const pageA = need(await hit(app, '/p/kids-toy', { host: a.host }), 200, 'Alpha product page').text;
  const pageB = need(await hit(app, '/p/kids-toy', { host: b.host }), 200, 'Beta product page').text;
  assert.match(pageA, /Only in the Alpha catalogue/);
  assert.doesNotMatch(pageA, /Beta/);
  assert.match(pageB, /Only in the Beta catalogue/);
  assert.doesNotMatch(pageB, /Alpha/);
  assert.doesNotMatch(need(await hit(app, '/shop', { host: a.host }), 200, 'Alpha shop').text, /Beta/);
});

test('F-02: the owner of A asking for B\'s product id gets 404, with no B data in the answer or the logs', async (t) => {
  const { app, a, b } = await twoBusinesses(t);
  const logs = captureLogs(t);
  const secret = await addProduct(b, 'BETA-PRIVATE-NAME', { description: 'BETA-PRIVATE-TEXT' });
  const token = await signIn(app, a);

  const id = requestId();
  const read = await api(app, a, token, `/products/${secret.id}`, { headers: { 'x-request-id': id } });
  assert.equal(read.status, 404);
  assert.equal(read.json().code, 'not_found');
  assert.doesNotMatch(read.text, /BETA-PRIVATE/);
  assertAttemptLogged(logs, id, /not_found|not.?found|404/i);

  const change = await api(app, a, token, `/products/${secret.id}`, { method: 'PATCH', body: { name: 'Taken over' } });
  assert.equal(change.status, 404);
  assert.equal((await api(app, a, token, `/products/${secret.id}`, { method: 'DELETE' })).status, 404);

  assert.equal((await b.repos.products.get(secret.id)).name, 'BETA-PRIVATE-NAME', 'B\'s product is unchanged');
  assert.doesNotMatch(logs.text(), /BETA-PRIVATE/);
});

test('F-03: a repo query with no tenant context throws "tenant context missing" and returns no rows', async () => {
  const { platform, repos } = await setup();
  await repos.products.create({ name: 'Should stay fenced', price: '100', active: 'on' });
  const calls = {
    'products.list': (r) => r.products.list(),
    'orders.list': (r) => r.orders.list(),
    'settings.getAll': (r) => r.settings.getAll(),
    'activity.count': (r) => r.activity.count(),
    'users.findByPhone': (r) => r.users.findByPhone('9000000001'),
    'reels.get': (r) => r.reels.get('1'),
    'brandKit.get': (r) => r.brandKit.get(),
    'categories.get': (r) => r.categories.get(1),
  };
  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(() => call(platform), /tenant context missing/i, name);
  }
});

async function ordersInTwoBusinesses(t) {
  const { app, a, b } = await twoBusinesses(t);
  const productA = await addProduct(a, 'Lamp');
  const productB = await addProduct(b, 'Pot');
  await addOrder(a, productA);
  await addOrder(a, productA);
  await addOrder(b, productB);
  return { app, a, b };
}

test('F-04: the app role running SELECT * FROM orders with context A sees only A\'s orders', async (t) => {
  const { app, a } = await ordersInTwoBusinesses(t);
  const role = await findAppRole(app.db);
  assert.ok(role, 'No app role exists: a role that can read orders, is no superuser and cannot bypass RLS');
  const rows = await asAppRole(app.db, role, a.tenant.id, (q) => q.query('SELECT * FROM orders'));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.tenant_id === a.tenant.id), 'every order returned is A\'s');
});

test('F-04: the app role with no context sees no orders, and cannot switch row security off', async (t) => {
  const { app, a } = await ordersInTwoBusinesses(t);
  const role = await findAppRole(app.db);
  assert.ok(role, 'No app role exists');
  const seen = await asAppRole(app.db, role, null, (q) => q.query('SELECT * FROM orders')).catch(() => []);
  assert.deepEqual(seen, [], 'with no business set, nothing is visible');
  await assert.rejects(
    () => asAppRole(app.db, role, a.tenant.id, async (q) => {
      await q.exec('SET LOCAL row_security = off');
      return q.query('SELECT * FROM orders');
    }),
    /row.level security|row_security/i,
  );
});

test('F-04: row-level security is on for every table that holds business rows', async () => {
  const { db } = await setup();
  const tables = await db.query(
    `SELECT c.table_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.is_nullable = 'NO' AND t.table_type = 'BASE TABLE'`,
  );
  assert.ok(tables.length > 5, 'business tables were found');
  const secured = await db.query(`SELECT relname FROM pg_class WHERE relkind IN ('r', 'p') AND relrowsecurity`);
  const on = new Set(secured.map((r) => r.relname));
  assert.deepEqual(tables.map((r) => r.table_name).filter((name) => !on.has(name)).sort(), [], 'tables without RLS');
});

test('F-05: the first order on a new business is 1001, per business, in the API', async (t) => {
  const { app, a, b } = await twoBusinesses(t);
  const orderNumber = async (business) => {
    const product = await addProduct(business, `Item ${Date.now()}${Math.random()}`);
    const order = await addOrder(business, product);
    const token = await signIn(app, business);
    return need(await api(app, business, token, `/orders/${order.id}`), 200, 'Read order').json().orderNumber;
  };
  assert.match(await orderNumber(a), /(^|\D)1001$/);
  assert.match(await orderNumber(a), /(^|\D)1002$/);
  assert.match(await orderNumber(b), /(^|\D)1001$/, 'each business counts on its own');
});

test('F-05: a migrated business whose highest number is 4210 continues at 4211', async (t) => {
  const { app, a } = await twoBusinesses(t);
  const product = await addProduct(a, 'Lamp');
  await app.db.query(
    `INSERT INTO orders (tenant_id, order_number, public_token, customer_name, phone, address, city, state, pincode, subtotal_paise, shipping_paise, total_paise)
     VALUES ($1, '4210', 'migrated-token', $2, $3, $4, $5, $6, $7, 100, 0, 100)`,
    [a.tenant.id, CUSTOMER.name, CUSTOMER.phone, CUSTOMER.address, CUSTOMER.city, CUSTOMER.state, CUSTOMER.pincode],
  );
  await app.db.query('UPDATE tenants SET next_order_number = 4211 WHERE id = $1', [a.tenant.id]);
  const order = await addOrder(a, product);
  assert.match(order.order_number, /(^|\D)4211$/);
});

test('F-05: orders placed at the same moment never share a number', async (t) => {
  const { a } = await twoBusinesses(t);
  const product = await addProduct(a, 'Lamp');
  const orders = await Promise.all(Array.from({ length: 12 }, () => addOrder(a, product)));
  assert.equal(new Set(orders.map((o) => o.order_number)).size, 12);
});

test('F-06: a media id of B requested on A\'s domain is 404, and B\'s own domain serves it', async (t) => {
  const { app, a, b } = await twoBusinesses(t);
  const token = await signIn(app, b);
  const uploaded = need(await uploadFile(app, b, token), 201, 'Upload an image').json();
  assert.match(uploaded.url, /^\/media\//);

  const own = need(await hit(app, uploaded.url, { host: b.host }), 200, 'B reads its own image');
  assert.deepEqual(own.raw, TINY_PNG);
  assert.equal((await hit(app, uploaded.url, { host: a.host })).status, 404);
});

test('R-01: A\'s owner calling the API with B\'s order id gets not found, and the attempt is logged', async (t) => {
  const { app, a, b } = await twoBusinesses(t);
  const logs = captureLogs(t);
  const order = await addOrder(b, await addProduct(b, 'Pot'), { ...CUSTOMER, name: 'BETA-BUYER' });
  const token = await signIn(app, a);
  const id = requestId();
  const res = await api(app, a, token, `/orders/${order.id}`, { headers: { 'x-request-id': id } });
  assert.equal(res.status, 404);
  assert.equal(res.json().code, 'not_found');
  assert.doesNotMatch(res.text, /BETA-BUYER/);
  assertAttemptLogged(logs, id, /not_found|not.?found|404/i);
  assert.doesNotMatch(logs.text(), /BETA-BUYER/);
  assert.equal((await api(app, a, token, `/orders/${order.id}/status`, { method: 'POST', body: { status: 'cancelled' } })).status, 404);
  assert.equal((await b.repos.orders.get(order.id)).status, 'awaiting_payment', 'B\'s order is unchanged');
});

test('R-01: A\'s staff with the orders permission gets not found on B\'s order, and it is logged', async (t) => {
  const { app, a, b } = await twoBusinesses(t);
  const logs = captureLogs(t);
  const order = await addOrder(b, await addProduct(b, 'Pot'));
  const staff = await addStaff(app, a, { permissions: ['orders'] });
  const id = requestId();
  const res = await api(app, a, staff.token, `/orders/${order.id}`, { headers: { 'x-request-id': id } });
  assert.equal(res.status, 404);
  assertAttemptLogged(logs, id, /not_found|not.?found|404/i);
});

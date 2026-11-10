// PRD 2: what staff and platform admins may do, and that it is recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER, addBusiness, addOrder, addProduct, addStaff, api, assertAttemptLogged, captureLogs, consoleUser, need, nextPhone, onConsole, requestId, signIn, startWorld } from './support.js';
import { consolePaths } from './surfaces.js';

const REEL_ID = '17900000000000020';

test('U-02: staff with orders only reach orders and are refused Automations, and the refusal is logged', async (t) => {
  const app = await startWorld(t);
  const logs = captureLogs(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const product = await addProduct(shop, 'Lamp');
  await addOrder(shop, product);
  await shop.repos.reels.save(REEL_ID, { headline: 'A reel', keywords: 'LINK', productIds: [product.id], active: 'on' });
  const staff = await addStaff(app, shop, { permissions: ['orders'] });

  need(await api(app, shop, staff.token, '/orders'), 200, 'Orders, which this staff member may use');
  const refused = [
    ['GET', '/reels'],
    ['GET', `/reels/${REEL_ID}`],
    ['GET', '/activity'],
    ['GET', '/instagram/posts'],
    ['PUT', `/reels/${REEL_ID}`, { keywords: ['LINK'], productIds: [product.id] }],
    ['DELETE', `/reels/${REEL_ID}`],
  ];
  for (const [method, route, body] of refused) {
    const id = requestId();
    const res = await api(app, shop, staff.token, route, { method, body, headers: { 'x-request-id': id } });
    assert.equal(res.status, 403, `${method} ${route}`);
    assert.equal(res.json().code, 'forbidden');
    assertAttemptLogged(logs, id, /forbidden|refus|denied|403/i);
  }
  assert.ok(!logs.text().includes(staff.phone), 'the log holds no phone number');
  assert.equal((await shop.repos.reels.get(REEL_ID)).headline, 'A reel', 'the refused calls changed nothing');
});

test('U-02: staff with no permissions reach nothing', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const staff = await addStaff(app, shop, { permissions: [] });
  for (const route of ['/orders', '/products', '/reels', '/customers', '/stats/dashboard', '/settings']) {
    assert.equal((await api(app, shop, staff.token, route)).status, 403, route);
  }
});

async function staffInTwoBusinesses(t) {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  await addOrder(a, await addProduct(a, 'Lamp'), { ...CUSTOMER, name: 'Alpha Buyer' });
  await addOrder(b, await addProduct(b, 'Pot'), { ...CUSTOMER, name: 'Beta Buyer' });
  const phone = nextPhone();
  const inA = await addStaff(app, a, { permissions: ['orders'], phone });
  await addStaff(app, b, { permissions: ['orders'], phone });
  return { app, a, b, token: inA.token };
}

const customerNames = (res) => res.json().items.map((o) => o.customerName);

test('U-03: staff in two businesses switch between them and see only the chosen one\'s data', async (t) => {
  const { app, a, b, token } = await staffInTwoBusinesses(t);
  const orders = (tenantId) => api(app, a, token, '/orders', { headers: tenantId ? { 'x-tenant-id': String(tenantId) } : {} });

  assert.deepEqual(customerNames(need(await orders(), 200, 'Orders with no switch')), ['Alpha Buyer']);
  assert.deepEqual(customerNames(need(await orders(b.tenant.id), 200, 'Orders after switching to B')), ['Beta Buyer']);
  assert.deepEqual(customerNames(need(await orders(a.tenant.id), 200, 'Orders after switching back')), ['Alpha Buyer']);

  const me = need(await api(app, a, token, '/auth/me', { headers: { 'x-tenant-id': String(b.tenant.id) } }), 200, 'Profile in B').json();
  assert.equal(me.business.slug, 'beta-store');
});

test('U-03: orders asked for in one business are not found from the other', async (t) => {
  const { app, a, b, token } = await staffInTwoBusinesses(t);
  const betaOrder = (await b.repos.orders.list())[0];
  assert.equal((await api(app, a, token, `/orders/${betaOrder.id}`, { headers: { 'x-tenant-id': String(a.tenant.id) } })).status, 404);
  need(await api(app, a, token, `/orders/${betaOrder.id}`, { headers: { 'x-tenant-id': String(b.tenant.id) } }), 200, 'The same order from its own business');
});

test('U-04: a platform admin opening a business is logged with who, when and why', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const operator = await consoleUser(app);
  const started = new Date(Date.now() - 2000);

  const res = await onConsole(app, operator, consolePaths.impersonate(shop.tenant.id), { method: 'POST', body: { reason: 'ticket 123' } });
  need(res, [200, 201], 'Open a business\'s admin to help');
  const [row] = await app.db.query(`SELECT * FROM audit_log WHERE tenant_id = $1 AND action ILIKE '%impersonat%'`, [shop.tenant.id]);
  assert.ok(row, 'No audit row for opening the business');
  assert.match(row.actor, new RegExp(operator.email), 'who');
  assert.ok(new Date(row.created_at) >= started, 'when');
  assert.match(JSON.stringify(row.details), /ticket 123/, 'why');
});

test('U-04: opening a business with no reason is refused and leaves no session', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const operator = await consoleUser(app);
  for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
    assert.equal((await onConsole(app, operator, consolePaths.impersonate(shop.tenant.id), { method: 'POST', body })).status, 400);
  }
  assert.deepEqual(await app.db.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action ILIKE '%impersonat%'`, [shop.tenant.id]), []);
});

test('U-04: a business owner cannot open another business through the console', async (t) => {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  const token = await signIn(app, a);
  const res = await onConsole(app, { cookie: undefined, csrf: '' }, consolePaths.impersonate(b.tenant.id), { method: 'POST', body: { reason: 'nosy' }, token });
  assert.ok([401, 403, 404].includes(res.status), `answered ${res.status}`);
});

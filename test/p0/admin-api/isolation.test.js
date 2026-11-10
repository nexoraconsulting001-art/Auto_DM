// Who can reach what: other businesses' ids, staff permissions, and every route being answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeList } from '../../../src/contracts/api/index.js';
import { adminApi } from '../../../src/modules/admin-api/index.js';
import { adminListsRepo } from '../../../src/modules/admin-api/repo.js';
import { apiAuth } from '../../../src/modules/api-auth/index.js';
import { NoTenantError, withTenant } from '../../../src/tenancy.js';
import { REEL_ID, openTestDb } from '../../helpers.js';
import { capturingLogs, ok, placeOrder, refused, secondBusiness, withApp } from './support.js';

const reelBody = (productIds) => ({ keywords: ['LINK'], productIds, headline: 'Secret reel', slug: 'secret-reel' });

/** Gives signed-in staff the role and permissions the database cannot store yet. */
const actingAs = (role, permissions) => ({
  name: 'acting-as',
  routes(app) {
    app.use((req, _res, next) => {
      if (req.user?.role === 'staff') req.user = { ...req.user, role, permissions };
      next();
    });
  },
});

async function staffApp(role, permissions, run) {
  await withApp({ extra: [actingAs(role, permissions)] }, async (app) => {
    await app.repos.users.create({ name: 'Ravi S', phone: '9123456780', password: 'secret1', role: 'staff' });
    await run(app, app.as(await app.signIn({ phone: '9123456780', password: 'secret1' })));
  })();
}

test('every route in the contract is answered', () => {
  const answered = new Set([...Object.keys(adminApi.api({ repos: {}, config: {}, ig: {} })), ...Object.keys(apiAuth.api({ repos: {}, auth: {} }))]);
  assert.deepEqual([...answered].sort(), routeList.map((r) => r.id).sort());
});

test('R-01: another business\'s ids are not found on every route, and the attempt is logged with ids only', withApp(async (app) => {
  const leaf = await secondBusiness(app);
  const shopper = await leaf.repos.users.create({ name: 'Asha K', phone: '9876543210', password: 'secret1' });
  const product = await ok(await leaf.api('POST', '/products', { name: 'SECRET pot', pricePaise: 100 }), 201);
  const category = await ok(await leaf.api('POST', '/categories', { name: 'SECRET shelf' }), 201);
  const order = await placeOrder(leaf.repos, product);
  await ok(await leaf.api('PUT', `/reels/${REEL_ID}`, reelBody([product.id])));
  const mine = await ok(await app.api('POST', '/products', { name: 'Mine', pricePaise: 100 }), 201);

  const attempts = [
    ['GET', `/products/${product.id}`], ['PATCH', `/products/${product.id}`, { name: 'Hacked' }], ['DELETE', `/products/${product.id}`],
    ['GET', `/categories/${category.id}`], ['PATCH', `/categories/${category.id}`, { name: 'Hacked' }], ['DELETE', `/categories/${category.id}`],
    ['GET', `/orders/${order.id}`], ['POST', `/orders/${order.id}/status`, { status: 'cancelled' }],
    ['GET', `/reels/${REEL_ID}`], ['PUT', `/reels/${REEL_ID}`, reelBody([mine.id])], ['DELETE', `/reels/${REEL_ID}`],
    ['POST', `/customers/${shopper.id}/reset-password`],
  ];

  const { api } = app;
  const lines = await capturingLogs(async () => {
    for (const [method, path, body] of attempts) {
      const error = await refused(await api(method, path, body), 404, 'not_found');
      assert.doesNotMatch(JSON.stringify(error), /SECRET|Asha/, `${method} ${path}`);
    }
  });

  const logged = lines.filter((l) => l.msg === 'api.not_found');
  assert.equal(logged.length, attempts.length);
  for (const line of logged) assert.equal(line.tenant, 'default');
  assert.ok(logged.some((l) => l.route === 'orders.get' && l.target === String(order.id)));
  assert.ok(logged.some((l) => l.route === 'reels.save' && l.target === REEL_ID));
  assert.doesNotMatch(JSON.stringify(lines), /SECRET|Asha|9876543210/);

  assert.equal((await ok(await leaf.api('GET', `/products/${product.id}`))).name, 'SECRET pot');
  assert.equal((await ok(await leaf.api('GET', `/categories/${category.id}`))).name, 'SECRET shelf');
  assert.equal((await ok(await leaf.api('GET', `/orders/${order.id}`))).status, 'awaiting_payment');
  assert.equal((await ok(await leaf.api('GET', `/reels/${REEL_ID}`))).headline, 'Secret reel');
  assert.ok(await leaf.repos.users.verify(shopper.phone, 'secret1'));
}));

test('F-02: the owner of one business gets a 404 for another\'s product, and nothing of it in the logs', withApp(async (app) => {
  const leaf = await secondBusiness(app);
  const product = await ok(await leaf.api('POST', '/products', { name: 'SECRET pot', pricePaise: 100 }), 201);
  let body;
  const lines = await capturingLogs(async () => {
    body = await refused(await app.api('GET', `/products/${product.id}`), 404, 'not_found');
  });
  assert.doesNotMatch(JSON.stringify(body), /SECRET/);
  assert.doesNotMatch(JSON.stringify(lines), /SECRET/);
}));

test('lists hold only the caller\'s own rows, on every list route', withApp(async (app) => {
  const leaf = await secondBusiness(app);
  const product = await ok(await leaf.api('POST', '/products', { name: 'SECRET pot', pricePaise: 100 }), 201);
  await ok(await leaf.api('POST', '/categories', { name: 'SECRET shelf' }), 201);
  await placeOrder(leaf.repos, product);
  await ok(await leaf.api('PUT', `/reels/${REEL_ID}`, reelBody([product.id])));
  await leaf.repos.users.create({ name: 'SECRET shopper', phone: '9876543210', password: 'secret1' });
  await leaf.repos.activity.log({ commentId: 'secret-c', reelId: REEL_ID, username: 'SECRET', text: 'SECRET', result: 'sent' });

  for (const path of ['/products', '/categories', '/orders', '/reels', '/customers', '/activity']) {
    const body = await ok(await app.api('GET', path));
    assert.doesNotMatch(JSON.stringify(body), /SECRET/, path);
  }
  assert.equal((await ok(await app.api('GET', '/stats/dashboard'))).orders, 0);
}));

test('F-03: the module\'s lists refuse to run with no business selected', async () => {
  const db = await openTestDb();
  const lists = adminListsRepo(db);
  await assert.rejects(() => lists.orders({ limit: 5 }), NoTenantError);
  await assert.rejects(() => lists.customers({ limit: 5 }), NoTenantError);
  await assert.rejects(() => lists.activity({ limit: 5 }), NoTenantError);
  await assert.rejects(() => lists.reelHeldElsewhere('1'), NoTenantError);
  const [tenant] = await db.query(`INSERT INTO tenants (slug, name) VALUES ('t', 'T') RETURNING id, slug`);
  assert.deepEqual(await withTenant(tenant, () => lists.orders({ limit: 5 })), { items: [], nextCursor: null });
  await db.close();
});

test('U-02: staff with orders only are refused automations and it is logged; orders work', async () => {
  await staffApp('staff', ['orders'], async (_app, staff) => {
    assert.equal((await ok(await staff('GET', '/orders'))).nextCursor, null);
    const lines = await capturingLogs(async () => {
      await refused(await staff('GET', '/reels'), 403, 'forbidden');
      await refused(await staff('GET', `/reels/${REEL_ID}`), 403, 'forbidden');
      await refused(await staff('GET', '/activity'), 403, 'forbidden');
    });
    const logged = lines.filter((l) => l.msg === 'api.forbidden');
    assert.deepEqual(logged.map((l) => l.route), ['reels.list', 'reels.get', 'activity.list']);
    assert.ok(logged.every((l) => l.role === 'staff'));
    assert.doesNotMatch(JSON.stringify(lines), /9123456780/);
  });
});

test('F-46: each staff permission opens its own routes and no others', async () => {
  await staffApp('staff', ['catalog'], async (_app, staff) => {
    assert.equal((await ok(await staff('POST', '/products', { name: 'Pot', pricePaise: 100 }), 201)).name, 'Pot');
    await ok(await staff('GET', '/categories'));
    for (const path of ['/orders', '/customers', '/stats/dashboard', '/settings', '/brand-kit', '/reels']) await refused(await staff('GET', path), 403, 'forbidden');
  });
  await staffApp('staff', ['customers'], async (app, staff) => {
    await ok(await staff('GET', '/customers'));
    const user = await app.repos.users.create({ name: 'Asha K', phone: '9876543210', password: 'secret1' });
    await refused(await staff('POST', `/customers/${user.id}/reset-password`), 403, 'forbidden');
  });
});

test('F-48: a manager runs the shop but cannot touch where the money goes', async () => {
  await staffApp('manager', [], async (app, manager) => {
    await ok(await manager('GET', '/settings'));
    await ok(await manager('PATCH', '/settings', { storeName: 'Managed' }));
    await ok(await manager('GET', '/brand-kit'));
    await ok(await manager('GET', '/orders'));
    await ok(await manager('GET', '/settings/setup'));
    const user = await app.repos.users.create({ name: 'Asha K', phone: '9876543210', password: 'secret1' });
    await ok(await manager('POST', `/customers/${user.id}/reset-password`));
    await refused(await manager('PATCH', '/settings/payment', { upiId: 'x@upi' }), 403, 'forbidden');
  });
});

test('shoppers and strangers get nothing from the seller routes', withApp(async (app) => {
  const shopper = { name: 'Asha K', phone: '9876543210', password: 'secret1' };
  await app.repos.users.create(shopper);
  const customer = app.as(await app.signIn(shopper));
  const stranger = app.as('not-a-real-token');
  for (const path of ['/products', '/orders', '/customers', '/settings', '/activity', '/stats/dashboard']) {
    await refused(await customer('GET', path), 403, 'forbidden');
    await refused(await stranger('GET', path), 401, 'unauthorized');
    await refused(await fetch(`${app.base}/api/v1${path}`), 401, 'unauthorized');
  }
}));

test('no response carries a tenant id or a password hash', withApp(async ({ api, repos }) => {
  const product = await ok(await api('POST', '/products', { name: 'Pot', pricePaise: 100 }), 201);
  await placeOrder(repos, product);
  await repos.users.create({ name: 'Asha K', phone: '9876543210', password: 'secret1' });
  for (const path of ['/products', '/categories', '/orders', '/customers', '/activity', '/reels', '/settings', '/brand-kit', `/products/${product.id}`]) {
    assert.doesNotMatch(await (await api('GET', path)).text(), /tenant_id|tenantId|password_hash|public_token/, path);
  }
}));

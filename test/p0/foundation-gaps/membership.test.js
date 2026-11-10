// One person working at several businesses, and what proves it. A phone number typed into an account is not proof:
// the owner of any business can put anyone's number on a staff account there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBusiness, addOrder, addProduct, addStaff, api, assertAttemptLogged, captureLogs, hit, need, nextPhone, requestId, signIn, signInCookie, startWorld, CUSTOMER } from '../spec-p0/support.js';

async function world(t) {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  return { app, a, b };
}

const asTenant = (app, business, token, id, route = '/auth/me', options = {}) =>
  api(app, business, token, route, { ...options, headers: { 'x-tenant-id': String(id), ...options.headers } });

test('the owner of A cannot reach B by putting B\'s owner\'s phone on a staff account at A', async (t) => {
  const { app, a, b } = await world(t);
  const logs = captureLogs(t);
  const impostor = { phone: b.owner.phone, password: 'known-to-the-attacker' };
  const staff = await a.repos.users.create({ name: 'Fake Staff', ...impostor, role: 'staff' });
  await a.repos.users.setPermissions(staff.id, ['orders']);
  const token = await signIn(app, a, impostor);

  const id = requestId();
  const res = await asTenant(app, a, token, b.tenant.id, '/orders', { headers: { 'x-request-id': id } });
  assert.equal(res.status, 403);
  assert.equal(res.json().code, 'forbidden');
  assertAttemptLogged(logs, id, /forbidden/);
  assert.ok(!logs.text().includes(impostor.phone), 'the log holds no phone number');
});

test('the same phone with a different password at each business makes no membership', async (t) => {
  const { app, a, b } = await world(t);
  const phone = nextPhone();
  for (const [business, password] of [[a, 'first-password'], [b, 'second-password']]) {
    await business.repos.users.create({ name: 'Ravi Staff', phone, password, role: 'staff' });
  }
  const token = await signIn(app, a, { phone, password: 'first-password' });
  await signIn(app, b, { phone, password: 'second-password' });
  assert.equal((await asTenant(app, a, token, b.tenant.id)).status, 403);
});

test('a shopper account with the same phone and password is no membership', async (t) => {
  const { app, a, b } = await world(t);
  const person = { phone: nextPhone(), password: 'same-password' };
  await a.repos.users.create({ name: 'Ravi Staff', ...person, role: 'staff' });
  await b.repos.users.create({ name: 'Ravi Shopper', ...person });
  const token = await signIn(app, a, person);
  await signIn(app, b, person);
  assert.equal((await asTenant(app, a, token, b.tenant.id)).status, 403);
});

async function member(t) {
  const { app, a, b } = await world(t);
  const phone = nextPhone();
  const inA = await addStaff(app, a, { permissions: ['orders'], phone });
  const inB = await addStaff(app, b, { permissions: ['catalog'], phone });
  return { app, a, b, inA, inB, token: inA.token };
}

test('after switching, the permissions are those of the person\'s account at that business', async (t) => {
  const { app, a, b, token } = await member(t);
  need(await api(app, a, token, '/orders'), 200, 'orders at A');
  assert.equal((await api(app, a, token, '/products')).status, 403);
  assert.equal((await asTenant(app, a, token, b.tenant.id, '/orders')).status, 403, 'B gave this person the catalog, not orders');
  need(await asTenant(app, a, token, b.tenant.id, '/products'), 200, 'the catalog at B');
});

test('losing the role at the other business counts on the very next call', async (t) => {
  const { app, a, b, inB, token } = await member(t);
  need(await asTenant(app, a, token, b.tenant.id, '/products'), 200, 'before');
  await b.repos.users.setRole(inB.user.id, 'customer');
  assert.equal((await asTenant(app, a, token, b.tenant.id, '/products')).status, 403);
});

test('deleting the account at the other business ends the membership', async (t) => {
  const { app, a, b, inB, token } = await member(t);
  await app.db.query('DELETE FROM users WHERE tenant_id = $1 AND id = $2', [b.tenant.id, inB.user.id]);
  assert.equal((await asTenant(app, a, token, b.tenant.id)).status, 403);
  assert.deepEqual(await app.db.query('SELECT 1 FROM memberships'), [], 'neither direction is left behind');
});

test('a header for the business the session is already in changes nothing, and nonsense is refused without a server fault', async (t) => {
  const { app, a } = await world(t);
  const token = await signIn(app, a);
  need(await asTenant(app, a, token, a.tenant.id, '/products'), 200, 'own business');
  for (const value of ['0', '-1', '1.5', '1e3', '2147483648', '99999999999999999999', 'abc', '1; DROP TABLE users']) {
    assert.equal((await asTenant(app, a, token, value, '/products')).status, 403, value);
  }
});

test('with nobody signed in the header changes nothing', async (t) => {
  const { app, a, b } = await world(t);
  assert.equal((await hit(app, '/api/v1/products', { host: a.host, headers: { 'x-tenant-id': String(b.tenant.id) } })).status, 401);
});

test('a cookie session switches the same way', async (t) => {
  const { app, a, b } = await world(t);
  const person = { phone: nextPhone(), password: 'same-password' };
  await a.repos.users.create({ name: 'Ravi Staff', ...person, role: 'manager' });
  await b.repos.users.create({ name: 'Ravi Staff', ...person, role: 'manager' });
  await signIn(app, b, person);
  const cookie = await signInCookie(app, a, person);
  const me = need(await hit(app, '/api/v1/auth/me', { host: a.host, cookie, headers: { 'x-tenant-id': String(b.tenant.id) } }), 200, 'profile in B').json();
  assert.equal(me.business.slug, 'beta-store');
  assert.equal((await hit(app, '/api/v1/auth/me', { host: a.host, cookie, headers: { 'x-tenant-id': '999999' } })).status, 403);
});

test('signing out with the header on ends the session where it belongs', async (t) => {
  const { app, a, b, token } = await member(t);
  need(await asTenant(app, a, token, b.tenant.id, '/auth/logout', { method: 'POST' }), 204, 'sign out');
  assert.equal((await api(app, a, token, '/auth/me')).status, 401);
});

test('the business list shows each business once, this one first, and shoppers get none', async (t) => {
  const { app, a, b, token } = await member(t);
  const list = need(await api(app, a, token, '/auth/businesses'), 200, 'list').json().businesses;
  assert.deepEqual(list.map((x) => [x.slug, x.role, x.current]), [['alpha-store', 'staff', true], ['beta-store', 'staff', false]]);
  const switched = need(await asTenant(app, a, token, b.tenant.id, '/auth/businesses'), 200, 'list from B').json().businesses;
  assert.deepEqual(switched.map((x) => [x.slug, x.current]), [['beta-store', true], ['alpha-store', false]]);

  const shopper = { phone: nextPhone(), password: 'shopper-pass' };
  await a.repos.users.create({ name: 'Asha K', ...shopper });
  assert.deepEqual(need(await api(app, a, await signIn(app, a, shopper), '/auth/businesses'), 200, 'shopper').json(), { businesses: [] });
});

test('a switched caller reaches only that business\'s rows, by id too', async (t) => {
  const { app, a, b, token } = await member(t);
  const order = await addOrder(a, await addProduct(a, 'Lamp'), CUSTOMER);
  const staffB = (await b.repos.users.listTeam()).find((u) => u.role === 'staff');
  await b.repos.users.setPermissions(staffB.id, ['orders']);
  assert.equal((await asTenant(app, a, token, b.tenant.id, `/orders/${order.id}`)).status, 404);
});

test('permissions must be known ones, and only staff hold them', async (t) => {
  const { a } = await world(t);
  const person = await a.repos.users.create({ name: 'Ravi Staff', phone: nextPhone(), password: 'staff-pass-1', role: 'staff' });
  await assert.rejects(() => a.repos.users.setPermissions(person.id, ['orders', 'billing']), /Unknown permission/);
  assert.deepEqual((await a.repos.users.setPermissions(person.id, ['orders', 'orders', 'inbox'])).permissions, ['orders', 'inbox']);

  await a.repos.users.setRole(person.id, 'customer');
  assert.deepEqual((await a.repos.users.get(person.id)).permissions, [], 'leaving staff clears them');
  await assert.rejects(() => a.repos.users.setPermissions(person.id, ['orders']), /Only a staff member/);
});

test('a manager gets manager routes and is refused the owner\'s', async (t) => {
  const { app, a } = await world(t);
  const person = { phone: nextPhone(), password: 'manager-pass' };
  await a.repos.users.create({ name: 'Mira Manager', ...person, role: 'manager' });
  const token = await signIn(app, a, person);
  need(await api(app, a, token, '/settings'), 200, 'settings');
  need(await api(app, a, token, '/products'), 200, 'products');
  assert.equal((await api(app, a, token, '/settings/payment', { method: 'PATCH', body: { upiId: 'x@upi' } })).status, 403);
  assert.equal((await api(app, a, token, '/audit-log')).status, 403);
});

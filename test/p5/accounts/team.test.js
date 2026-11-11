// The team and what each role reaches (PRD 5.11, 10.2, 10.3): invitations taken up only with a verified identity,
// the last owner kept, removal ending every session, role and permission refusals, and one business never reaching
// another's data.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { subjectHash, tokenHash } from '../../../src/contracts/accounts.js';
import { bindTenant } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { OWNER, accountsApp, call, captureLogs, codeSignIn, freshIp, otherBusiness, random10, testDevice, typedAccount } from './support.js';

const SHOPPER = { name: 'Asha K', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' };

let app;
let owner;
before(async () => {
  app = await accountsApp();
  owner = await codeSignIn(app, { device: testDevice('Owner phone') });
});
after(() => app?.close());

const reset = async () => {
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  await app.db.platform.query('DELETE FROM rate_limit_hits');
};
const as = (session, extra = {}) => ({ ...session.auth, ...extra });

async function placeOrder(tenant) {
  const repos = bindTenant(app.platform, tenant);
  const product = await repos.products.create({ name: 'Brass diya', price: '250', stock: '', active: 'on' });
  return repos.orders.create({ items: [{ productId: product.id, qty: 1 }], customer: SHOPPER }, await repos.settings.getAll());
}

/** Invites `contact` as `role` from the owner's session, then signs the invitee in with a code to `phone`. */
async function invited({ contact, role = 'staff', permissions = [], phone = contact }) {
  const res = await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body: { contact, role, permissions } });
  assert.equal(res.status, 201, res.text);
  await reset();
  return { invite: res.json, session: await codeSignIn(app, { phone, device: testDevice('Staff phone') }) };
}

test('an invitation holds only hashes, and the account appears when the invited number is verified', async () => {
  const phone = random10();
  const res = await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body: { contact: phone, role: 'staff', permissions: ['orders'] } });
  assert.equal(res.status, 201);
  assert.equal(res.json.contact.includes(phone.slice(-4)) && res.json.contact.includes(phone), false);
  assert.deepEqual([res.json.role, res.json.permissions], ['staff', ['orders']]);
  const [row] = await withTenant(app.tenant, () => app.db.query('SELECT * FROM team_invites WHERE tenant_id = $1 AND id = $2', [app.tenant.id, res.json.id]));
  assert.equal(JSON.stringify(row).includes(phone), false, 'no number in the row');
  assert.equal(row.contact_hash, subjectHash('test-secret', 'phone', `+91${phone}`));
  const listed = await call(app, '/api/v1/team', { headers: as(owner) });
  assert.ok(listed.json.invites.some((i) => i.id === res.json.id));

  await reset();
  const session = await codeSignIn(app, { phone });
  const here = session.businesses.find((b) => b.id === app.tenant.id);
  assert.ok(here, 'the business is in their switcher');
  assert.equal(here.role, 'staff');
  const team = await call(app, '/api/v1/team', { headers: as(owner) });
  const joined = team.json.items.find((m) => m.role === 'staff' && m.verified && m.phone.endsWith(phone.slice(-4)));
  assert.ok(joined);
  assert.deepEqual(joined.permissions, ['orders']);
  assert.equal(joined.phone.includes(phone), false, 'masked');
  assert.equal(team.json.invites.some((i) => i.id === res.json.id), false, 'taken up');
  // Writing an invitation and taking it up are audited with ids only.
  const audit = await call(app, '/api/v1/audit-log', { headers: as(owner) });
  const rows = audit.json.items.filter((r) => r.action.startsWith('team.'));
  assert.ok(rows.some((r) => r.action === 'team.invite') && rows.some((r) => r.action === 'team.invite_accepted'));
  assert.equal(JSON.stringify(rows).includes(phone), false);
});

test('a membership is made only from a verified identity, never from a number an owner typed', async () => {
  // Business B's owner types someone's number onto a staff account; a Google-only person whose account in A also
  // carries that typed number is not linked to it.
  const typed = random10();
  const second = await otherBusiness(app, 'Typed Shop');
  await typedAccount(app, second, { phone: typed, role: 'staff', permissions: ['orders'] });
  await typedAccount(app, app.tenant, { phone: typed, role: 'staff', permissions: ['orders'] });
  const pairs = await app.db.platform.query('SELECT 1 FROM memberships m JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id WHERE u.phone = $1', [typed]);
  assert.deepEqual(pairs, [], 'nothing links two typed numbers');

  // An invitation to a number is not taken up by someone who merely has that number typed on an account.
  const victim = random10();
  await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body: { contact: victim, role: 'manager' } });
  const [taken] = await withTenant(app.tenant, () => app.db.query('SELECT count(*)::int AS n FROM team_invites WHERE tenant_id = $1 AND accepted_at IS NOT NULL', [app.tenant.id]));
  const before = taken.n;
  await typedAccount(app, second, { phone: victim, role: 'owner' });
  const [after] = await withTenant(app.tenant, () => app.db.query('SELECT count(*)::int AS n FROM team_invites WHERE tenant_id = $1 AND accepted_at IS NOT NULL', [app.tenant.id]));
  assert.equal(after.n, before);

  // Only when that number is proved does anything tie: then both typed accounts are that person's.
  await reset();
  const session = await codeSignIn(app, { phone: typed, tenantId: app.tenant.id });
  assert.deepEqual(session.businesses.map((b) => b.id).sort(), [app.tenant.id, second.id].sort());
});

test('a shopper\'s session never becomes a team member\'s when their number is invited', async () => {
  const phone = random10();
  const shopper = await app.repos.users.create({ name: 'Shopper', phone, password: 'shop-pass', role: 'customer' });
  const shopperSession = await withTenant(app.tenant, () => app.platform.sessions.create(shopper.id, 30, 'bearer'));
  assert.equal((await call(app, '/api/v1/auth/me', { headers: { authorization: `Bearer ${shopperSession}` }, host: null })).status, 200);
  await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body: { contact: phone, role: 'manager' } });
  await reset();
  const session = await codeSignIn(app, { phone, tenantId: app.tenant.id });
  assert.equal(session.user.role, 'manager');
  assert.equal((await call(app, '/api/v1/auth/me', { headers: { authorization: `Bearer ${shopperSession}` }, host: null })).status, 401, 'the old session ended when the account changed hands');
});

test('an invitation to an email is taken up by a verified Google email, and an invitation for someone who already proved it is taken up at once', async () => {
  const [person] = await app.db.platform.query(`INSERT INTO people (name) VALUES ('Meera') RETURNING id`);
  await app.db.platform.query(`INSERT INTO person_identities (person_id, kind, subject, email, verified_at) VALUES ($1, 'google', 'g-meera', 'meera@example.com', now())`, [person.id]);
  const res = await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body: { contact: 'Meera@Example.com', role: 'manager' } });
  assert.equal(res.status, 201);
  const [account] = await app.db.platform.query('SELECT role, phone FROM users WHERE tenant_id = $1 AND person_id = $2', [app.tenant.id, person.id]);
  assert.deepEqual(account, { role: 'manager', phone: `person:${person.id}` });
});

/** A staff member with the orders permission only, signed in on the app and on the web console. */
async function ordersOnlyStaff() {
  const { session: onApp } = await invited({ contact: random10(), role: 'staff', permissions: ['orders'] });
  await reset();
  const web = await codeSignIn(app, { phone: onApp.user.phone, transport: 'cookie', tenantId: app.tenant.id });
  return { onApp, web, clients: [as(onApp), { cookie: web.cookie, 'x-csrf-token': web.csrf }] };
}

test('F-46: staff with orders only are refused the automations API with 403, on web and app, logged with ids only', async () => {
  const { onApp, clients } = await ordersOnlyStaff();
  for (const headers of clients) {
    assert.equal((await call(app, '/api/v1/orders', { headers })).status, 200, 'their own permission');
    for (const [method, pathname, body] of [['GET', '/api/v1/automations'], ['POST', '/api/v1/automations', { name: 'x' }]]) {
      const res = await call(app, pathname, { method, headers, body });
      assert.deepEqual([res.status, res.json?.code], [403, 'forbidden'], `${method} ${pathname}`);
    }
  }
  const lines = await captureLogs(() => call(app, '/api/v1/automations', { headers: as(onApp) }));
  assert.ok(lines.some((l) => l.includes('api.forbidden')));
  assert.equal(lines.join(String.fromCharCode(10)).includes(onApp.user.phone), false, 'refusals are logged with ids only');
});

test('P-12: staff without a permission get 403 from every route that needs it: payments, customers, the team', async () => {
  const { clients } = await ordersOnlyStaff();
  for (const headers of clients) {
    for (const [method, pathname, body] of [['PATCH', '/api/v1/settings/payment', { upiId: 'x@upi' }], ['GET', '/api/v1/payment-account'], ['GET', '/api/v1/customers'], ['GET', '/api/v1/team']]) {
      const res = await call(app, pathname, { method, headers, body });
      assert.deepEqual([res.status, res.json?.code], [403, 'forbidden'], `${method} ${pathname}`);
    }
  }
});

test('F-48: a manager is refused billing, staff, roles, keys and refunds', async () => {
  const { session } = await invited({ contact: random10(), role: 'manager' });
  assert.equal(session.user.role, 'manager');
  assert.equal((await call(app, '/api/v1/orders', { headers: as(session) })).status, 200);
  for (const [method, pathname, body] of [
    ['GET', '/api/v1/team'],
    ['POST', '/api/v1/team/invites', { contact: random10(), role: 'staff' }],
    ['PATCH', `/api/v1/team/${app.ownerId}`, { role: 'staff' }],
    ['PATCH', '/api/v1/settings/payment', { upiId: 'x@upi' }],
    ['DELETE', '/api/v1/payment-account/own'],
    ['GET', '/api/v1/api-keys'],
    ['POST', '/api/v1/orders/1/refunds', { amountPaise: 100, reason: 'x' }],
  ]) {
    const res = await call(app, pathname, { method, headers: as(session), body });
    assert.deepEqual([res.status, res.json?.code], [403, 'forbidden'], `${method} ${pathname}`);
  }
});

test('F-49: the only owner cannot demote or remove themselves, and nobody can take the last owner away', async () => {
  const demote = await call(app, `/api/v1/team/${app.ownerId}`, { method: 'PATCH', headers: as(owner), body: { role: 'manager' } });
  assert.deepEqual([demote.status, demote.json.code], [409, 'conflict']);
  const remove = await call(app, `/api/v1/team/${app.ownerId}`, { method: 'DELETE', headers: as(owner) });
  assert.deepEqual([remove.status, remove.json.code], [409, 'conflict']);
  const [me] = await withTenant(app.tenant, () => app.db.query('SELECT role, removed_at FROM users WHERE tenant_id = $1 AND id = $2', [app.tenant.id, app.ownerId]));
  assert.deepEqual([me.role, me.removed_at], ['owner', null]);

  // With a second owner, demoting at the same moment leaves one of them owner.
  const { session: co } = await invited({ contact: random10(), role: 'owner' });
  const both = await Promise.all([
    call(app, `/api/v1/team/${app.ownerId}`, { method: 'PATCH', headers: as(owner), body: { role: 'manager' } }),
    call(app, `/api/v1/team/${co.user.id}`, { method: 'PATCH', headers: as(co), body: { role: 'manager' } }),
  ]);
  const owners = await withTenant(app.tenant, () => app.db.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL`, [app.tenant.id]));
  assert.equal(owners.length, 1, `answers: ${both.map((b) => b.status).join(', ')}`);
  // Put things back for the other tests: whichever is still owner makes the original owner owner again.
  if (owners[0].id !== app.ownerId) {
    assert.equal((await call(app, `/api/v1/team/${app.ownerId}`, { method: 'PATCH', headers: as(co), body: { role: 'owner' } })).status, 200);
  }
});

test('team.update changes role and permissions, permissions count only for staff, and an unknown id is 404', async () => {
  const { session } = await invited({ contact: random10(), role: 'staff', permissions: ['orders'] });
  const id = session.user.id;
  const up = await call(app, `/api/v1/team/${id}`, { method: 'PATCH', headers: as(owner), body: { permissions: ['orders', 'catalog'] } });
  assert.deepEqual(up.json.permissions.sort(), ['catalog', 'orders']);
  const manager = await call(app, `/api/v1/team/${id}`, { method: 'PATCH', headers: as(owner), body: { role: 'manager', permissions: ['orders'] } });
  assert.deepEqual([manager.json.role, manager.json.permissions], ['manager', []]);
  assert.equal((await call(app, '/api/v1/customers', { headers: as(session) })).status, 200, 'the new role counts on the next request');
  assert.equal((await call(app, '/api/v1/team/999999', { method: 'PATCH', headers: as(owner), body: { role: 'staff' } })).status, 404);
  // A customer is not on the team.
  const shopper = await app.repos.users.create({ name: 'Buyer', phone: random10(), password: 'buyer-pass', role: 'customer' });
  assert.equal((await call(app, `/api/v1/team/${shopper.id}`, { method: 'PATCH', headers: as(owner), body: { role: 'owner' } })).status, 404);
});

test('team changes need a fresh re-auth', async () => {
  const renewed = await call(app, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: owner.refreshToken }, ip: freshIp() });
  assert.equal(renewed.status, 201);
  const stale = { authorization: `Bearer ${renewed.json.accessToken}` };
  owner = { ...owner, refreshToken: renewed.json.refreshToken, accessToken: renewed.json.accessToken, auth: stale };
  assert.equal((await call(app, '/api/v1/team', { headers: stale })).status, 200, 'reading needs none');
  for (const [method, pathname, body] of [['POST', '/api/v1/team/invites', { contact: random10(), role: 'staff' }], ['PATCH', `/api/v1/team/${app.ownerId}`, { role: 'owner' }], ['DELETE', '/api/v1/team/999']]) {
    assert.equal((await call(app, pathname, { method, headers: stale, body })).json.code, 'reauth_required', pathname);
  }
  await app.db.platform.query(`UPDATE sessions SET fresh_until = now() + interval '5 minutes' WHERE id = $1`, [tokenHash(renewed.json.accessToken)]);
});

test('F-47: a removed staff member is signed out on web and app at once, and cannot get back in by refreshing or switching', async () => {
  const { session: appSide } = await invited({ contact: random10(), role: 'staff', permissions: ['orders'] });
  await reset();
  const web = await codeSignIn(app, { phone: appSide.user.phone, transport: 'cookie', tenantId: app.tenant.id });
  await reset();
  const onOwnAddress = await codeSignIn(app, { phone: appSide.user.phone, transport: 'cookie', host: null });
  for (const headers of [as(appSide), { cookie: web.cookie }]) assert.equal((await call(app, '/api/v1/orders', { headers })).status, 200);
  assert.equal((await call(app, '/api/v1/orders', { headers: { cookie: onOwnAddress.cookie }, host: null })).status, 200);

  const removed = await call(app, `/api/v1/team/${appSide.user.id}`, { method: 'DELETE', headers: as(owner) });
  assert.equal(removed.status, 204);
  const t0 = Date.now();
  assert.equal((await call(app, '/api/v1/orders', { headers: as(appSide) })).status, 401, 'app');
  assert.equal((await call(app, '/api/v1/orders', { headers: { cookie: web.cookie } })).status, 401, 'web on the sign-in host');
  assert.equal((await call(app, '/api/v1/orders', { headers: { cookie: onOwnAddress.cookie }, host: null })).status, 401, 'web on the business\'s own address');
  assert.ok(Date.now() - t0 < 60_000);
  assert.equal((await call(app, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: appSide.refreshToken }, ip: freshIp() })).status, 401);
  const team = await call(app, '/api/v1/team', { headers: as(owner) });
  assert.equal(team.json.items.some((m) => m.id === appSide.user.id), false);
  // Signing in again does not bring the account back.
  await reset();
  await assert.rejects(() => codeSignIn(app, { phone: appSide.user.phone, host: null }), /403/, 'not on the business own address');
  await reset();
  await assert.rejects(() => codeSignIn(app, { phone: appSide.user.phone, tenantId: app.tenant.id }), /403/, 'nor by asking for it');
});

/** A person with typed staff accounts at this business and at Plant Store, an order in each, and a third business that is not theirs. */
let twoShopsWorld = null;
function twoShops() {
  twoShopsWorld ??= (async () => {
    const phone = random10();
    const plant = await otherBusiness(app, 'Plant Store');
    await app.db.platform.query(`INSERT INTO users (tenant_id, name, phone, email, password_hash, role) VALUES ($1, 'Plant Owner', $2, '', '!', 'owner')`, [plant.id, random10()]);
    await typedAccount(app, plant, { phone, role: 'staff', permissions: ['orders'] });
    await typedAccount(app, app.tenant, { phone, role: 'staff', permissions: ['orders'] });
    await otherBusiness(app, 'Not Theirs');
    const mehtaOrder = await placeOrder(app.tenant);
    const plantOrder = await placeOrder(plant);
    await reset();
    const session = await codeSignIn(app, { phone, tenantId: app.tenant.id, device: testDevice('Two shops') });
    return { plant, mehtaOrder, plantOrder, session };
  })();
  return twoShopsWorld;
}

test('P-09: a staff user in two businesses opens the switcher and exactly those two are listed', async () => {
  const { plant, session } = await twoShops();
  const listed = await call(app, '/api/v1/auth/businesses', { headers: as(session) });
  assert.deepEqual(listed.json.businesses.map((b) => b.id).sort(), [app.tenant.id, plant.id].sort(), 'exactly those two');
  assert.equal(listed.json.businesses.find((b) => b.current).id, app.tenant.id);
  assert.ok(listed.json.businesses.every((b) => b.role === 'staff'));
});

test('P-10: switching business shows only the new business orders, with no stale rows', async () => {
  const { plant, mehtaOrder, plantOrder, session } = await twoShops();
  const here = await call(app, '/api/v1/orders', { headers: as(session) });
  const there = await call(app, '/api/v1/orders', { headers: as(session, { 'x-tenant-id': String(plant.id) }) });
  assert.equal(there.status, 200);
  const ids = (res) => res.json.items.map((o) => o.id);
  assert.ok(ids(here).includes(mehtaOrder.id) && !ids(here).includes(plantOrder.id));
  assert.ok(ids(there).includes(plantOrder.id) && !ids(there).includes(mehtaOrder.id), 'no stale rows from the other business');
  const me = await call(app, '/api/v1/auth/me', { headers: as(session, { 'x-tenant-id': String(plant.id) }) });
  assert.equal(me.json.business.id, plant.id);
});

test('P-06: an owner of business A asking for business B\'s order gets 404, logged with ids only; X-Tenant-Id for a business they are not in is 403', async () => {
  const stranger = await otherBusiness(app, 'Stranger Shop');
  const theirOrder = await placeOrder(stranger);
  let res;
  const lines = await captureLogs(async () => {
    res = await call(app, `/api/v1/orders/${theirOrder.id}`, { headers: as(owner) });
  });
  assert.deepEqual([res.status, res.json.code], [404, 'not_found']);
  assert.equal(JSON.stringify(res.json).includes(SHOPPER.name), false, 'no data leaks');
  const logged = lines.find((l) => l.includes('api.not_found'));
  assert.ok(logged);
  assert.match(logged, new RegExp(`"target":"${theirOrder.id}"`));
  assert.equal(lines.join('\n').includes(SHOPPER.phone) || lines.join('\n').includes(OWNER.phone), false);

  for (const wanted of [String(stranger.id), '999999', 'abc']) {
    const switched = await call(app, '/api/v1/orders', { headers: as(owner, { 'x-tenant-id': wanted }) });
    assert.deepEqual([switched.status, switched.json.code], [403, 'forbidden'], wanted);
  }
  // Asking to open a session in someone else's business is refused the same way.
  await reset();
  await assert.rejects(() => codeSignIn(app, { tenantId: stranger.id }), /403/);
});

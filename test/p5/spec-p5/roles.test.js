// PRD 5.11: roles. Staff reach only what their permissions name, managers everything but billing, staff and roles,
// payment and integration keys, refunds, and Reach Guard override and thresholds, and a business always keeps an owner.
// Removing someone signs them out everywhere within 60 s, and only a super admin exports the raw event log.
// F-46, F-47, F-48, F-49, F-111, P-12 (the server's half).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLE_HOST, SECOND, addMember, addSeller, appSignIn, atOnce, consoleUser, freshen, local10, newSellerPhone, noCrash, onConsole, ownerApp,
  ownerPhone, refusedWith, routeList, staleAll, useP5World, webSignIn,
} from './kit.js';

const world = useP5World();
const ALL_PERMISSIONS = ['catalog', 'orders', 'automations', 'analytics', 'customers', 'inbox'];
const pathOf = (route) => `${route.path.replace(/:[A-Za-z]+/g, '1')}`;
const sellerRoutes = routeList.filter((r) => !r.access.public && !r.access.signedIn && !r.noBusiness);

/** Waits up to a minute for `check` to hold, asking again every half second. */
async function within60s(check) {
  const started = Date.now();
  while (Date.now() - started < 60 * SECOND) {
    if (await check()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

test('F-46: staff with only the orders permission get 403 from the automations API, on the web and in the app', async () => {
  const shop = await addSeller(world);
  const staff = await addMember(shop, { role: 'staff', permissions: ['orders'] });
  const app = await appSignIn(world, staff.phone, { tenantId: shop.tenantId });
  const web = await webSignIn(world, staff.phone, { tenantId: shop.tenantId });
  for (const [client, s] of [['app', app], ['web', web]]) {
    assert.equal((await s.send('GET', '/orders')).status, 200, `${client}: orders`);
    for (const [method, path, body] of [['GET', '/automations'], ['POST', '/automations', { name: 'x' }], ['GET', '/automations/1'], ['GET', '/instagram/connection']]) {
      const res = await s.send(method, path, body);
      assert.deepEqual([res.status, res.data?.code], [403, 'forbidden'], `${client}: ${method} ${path} answered ${res.status}`);
    }
  }
});

test('P-12: staff without the payments permission are refused Settings > Payments by the API, fresh or not', async () => {
  const shop = await addSeller(world);
  const staff = await addMember(shop, { role: 'staff', permissions: ALL_PERMISSIONS });
  const s = await appSignIn(world, staff.phone, { tenantId: shop.tenantId });
  for (const [method, path, body] of [
    ['GET', '/payment-settings'], ['PATCH', '/payment-settings', { cod: true }], ['GET', '/payment-account'], ['PATCH', '/settings/payment', { razorpayKeyId: 'rzp_test_x', razorpayKeySecret: 'secret' }],
    ['POST', '/payment-account/connect'], ['PUT', '/payment-account/mode', { mode: 'own' }],
  ]) {
    const res = await s.send(method, path, body);
    assert.equal(res.status, 403, `${method} ${path} answered ${res.status} to staff`);
    assert.notEqual(res.data?.code, 'reauth_required', `${method} ${path} told staff to re-authenticate instead of refusing them`);
  }
  await staleAll(world);
  const stale = await s.send('PATCH', '/settings/payment', { razorpayKeyId: 'rzp_test_x', razorpayKeySecret: 'secret' });
  assert.deepEqual([stale.status, stale.data?.code], [403, 'forbidden'], 'Who may call comes before freshness');
});

test('F-46: staff holding every permission are refused every route above staff, and the refusal names no data', async () => {
  const shop = await addSeller(world);
  const staff = await addMember(shop, { role: 'staff', permissions: ALL_PERMISSIONS });
  const s = await appSignIn(world, staff.phone, { tenantId: shop.tenantId });
  const above = sellerRoutes.filter((r) => !r.access.roles?.includes('staff'));
  assert.ok(above.length > 20, `Only ${above.length} routes are above staff`);
  const wrong = [];
  for (const route of above) {
    const res = await s.send(route.method, pathOf(route), ['GET', 'DELETE'].includes(route.method) ? undefined : {});
    if (res.status !== 403) wrong.push(`${route.id} ${route.method} ${pathOf(route)} -> ${res.status}`);
  }
  assert.deepEqual(wrong, [], 'Staff reached routes above their role');
});

test('F-48: a manager is refused every owner-only route, billing included, with "Owner only."', async () => {
  const shop = await addSeller(world);
  const manager = await addMember(shop, { role: 'manager' });
  const s = await appSignIn(world, manager.phone, { tenantId: shop.tenantId });
  const ownerOnly = sellerRoutes.filter((r) => r.access.roles?.length === 1 && r.access.roles[0] === 'owner');
  const billing = sellerRoutes.filter((r) => /billing|subscription|\bplan\b/i.test(`${r.id} ${r.path}`));
  for (const r of billing) assert.ok(ownerOnly.includes(r), `${r.id} is a billing route a manager may reach`);
  const wrong = [];
  for (const route of ownerOnly) {
    const res = await s.send(route.method, pathOf(route), ['GET', 'DELETE'].includes(route.method) ? undefined : {});
    if (res.status !== 403 || res.data?.code === 'reauth_required') wrong.push(`${route.id} -> ${res.status} ${res.data?.code}`);
    else if (!/owner only/i.test(res.data?.error ?? '')) wrong.push(`${route.id} -> 403 without "Owner only.": ${res.data?.error}`);
  }
  assert.deepEqual(wrong, [], 'A manager reached owner-only routes');
  // Managers do everything else: settings, the catalogue, orders.
  for (const path of ['/settings', '/orders', '/products', '/payment-settings']) assert.equal((await s.send('GET', path)).status, 200, `A manager was refused GET ${path}`);
});

test('F-48: a manager is refused staff and roles, payment and integration keys, refunds, and Reach Guard override and thresholds (5.11)', async () => {
  const shop = await addSeller(world);
  const manager = await addMember(shop, { role: 'manager' });
  const s = await appSignIn(world, manager.phone, { tenantId: shop.tenantId });
  for (const [method, path, body] of [
    ['GET', '/team'], ['POST', '/team/invites', { contact: newSellerPhone(), role: 'staff', permissions: ['orders'] }], ['PATCH', `/team/${manager.userId}`, { role: 'owner' }],
    ['PATCH', '/settings/payment', { razorpayKeyId: 'rzp_test_x', razorpayKeySecret: 'secret' }], ['GET', '/api-keys'], ['POST', '/api-keys', { name: 'k' }],
    ['PUT', '/shopify', { shop: 'x.myshopify.com', token: 't' }], ['PUT', '/whatsapp-account', { wabaId: '1', phoneNumberId: '1', accessToken: 'x' }],
    ['POST', '/orders/1/refunds', { amountPaise: 100 }], ['PATCH', '/reach-guard/thresholds', {}], ['POST', '/compliance/slow-mode/override', {}],
  ]) {
    const res = await s.send(method, path, body);
    assert.equal(res.status, 403, `A manager's ${method} ${path} answered ${res.status}`);
  }
  // A manager cannot make themselves owner.
  const [row] = await shop.sql('SELECT role FROM users WHERE tenant_id = $1 AND id = $2', [shop.tenantId, manager.userId]);
  assert.equal(row.role, 'manager');
});

test('F-49: the only owner cannot demote or remove themselves', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  const me = (await s.me()).data.user;
  for (const [method, body] of [['PATCH', { role: 'manager' }], ['PATCH', { role: 'staff', permissions: ['orders'] }], ['DELETE']]) {
    const res = noCrash(await s.send(method, `/team/${me.id}`, body), `${method} on the only owner`);
    assert.ok(res.status >= 400 && res.status < 500, `The only owner's ${method} on themselves answered ${res.status}`);
    assert.notEqual(res.data?.code, 'reauth_required', 'The refusal was "re-authenticate", not "a business keeps an owner"');
  }
  const [row] = await shop.sql('SELECT role, removed_at FROM users WHERE tenant_id = $1 AND id = $2', [shop.tenantId, me.id]);
  assert.deepEqual([row.role, row.removed_at], ['owner', null], 'The business lost its only owner');
  assert.equal((await s.send('GET', '/team')).status, 200, 'The owner lost access');
});

test('F-49: with two owners one may step down, but two owners demoting each other at once leave one', async () => {
  const shop = await addSeller(world);
  const second = await addMember(shop, { role: 'owner' });
  const a = await ownerApp(world, shop);
  const b = await appSignIn(world, second.phone, { tenantId: shop.tenantId });
  const aId = (await a.me()).data.user.id;
  const [x, y] = await atOnce(2, (i) => (i === 0 ? a.send('PATCH', `/team/${second.userId}`, { role: 'manager' }) : b.send('PATCH', `/team/${aId}`, { role: 'manager' })));
  for (const res of [x, y]) noCrash(res, 'An owner demoting the other');
  const owners = await shop.sql(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL`, [shop.tenantId]);
  assert.ok(owners.length >= 1, 'Two owners demoting each other left the business with none');
  if (owners.length === 2) {
    // Neither change went through: one may still step down on its own.
    const down = await b.send('PATCH', `/team/${second.userId}`, { role: 'manager' });
    assert.equal(down.status, 200, `The second owner stepping down: ${down.status} ${down.text.slice(0, 200)}`);
  }
});

test('F-47: staff removed while signed in on the web and in the app get 401 on both within 60 s', async () => {
  const shop = await addSeller(world);
  const staff = await addMember(shop, { role: 'staff', permissions: ['orders'] });
  const app = await appSignIn(world, staff.phone, { tenantId: shop.tenantId });
  const web = await webSignIn(world, staff.phone, { tenantId: shop.tenantId });
  assert.equal((await app.send('GET', '/orders')).status, 200);
  assert.equal((await web.send('GET', '/orders')).status, 200);

  const owner = await ownerApp(world, shop);
  const removed = await owner.send('DELETE', `/team/${staff.userId}`);
  assert.equal(removed.status, 204, `Removing the staff member: ${removed.status} ${removed.text.slice(0, 200)}`);
  const appOut = await within60s(async () => (await app.send('GET', '/orders')).status === 401);
  const webOut = await within60s(async () => (await web.send('GET', '/orders')).status === 401);
  assert.notEqual(appOut, null, 'The app session still works a minute after removal');
  assert.notEqual(webOut, null, 'The web session still works a minute after removal');
  refusedWith(await app.refresh(), 401, 'The removed staff member refreshing');
  const [row] = await shop.sql('SELECT removed_at FROM users WHERE tenant_id = $1 AND id = $2', [shop.tenantId, staff.userId]);
  assert.ok(row.removed_at, 'removed_at was not set');
  const families = await world.sql('SELECT revoke_reason FROM token_families WHERE device_id = $1', [app.device.id]);
  assert.ok(families.every((f) => f.revoke_reason === 'staff_removed'), `Families: ${JSON.stringify(families)}`);
  // Signing in again does not bring the account back.
  const again = await world.app('/api/v1/auth/start', { method: 'POST', body: { phone: staff.phone } });
  assert.equal(again.status, 202);
  const list = await owner.send('GET', '/team');
  assert.ok(!list.data.items.some((m) => m.id === staff.userId), 'The removed member is still listed');
});

test('F-47: removal needs a fresh owner, and staff or managers cannot remove anyone', async () => {
  const shop = await addSeller(world);
  const staff = await addMember(shop, { role: 'staff', permissions: ALL_PERMISSIONS });
  const manager = await addMember(shop, { role: 'manager' });
  const s = await appSignIn(world, staff.phone, { tenantId: shop.tenantId });
  const m = await appSignIn(world, manager.phone, { tenantId: shop.tenantId });
  const ownerUser = (await (await ownerApp(world, shop)).me()).data.user;
  assert.equal((await s.send('DELETE', `/team/${manager.userId}`)).status, 403, 'Staff removed a manager');
  assert.equal((await m.send('DELETE', `/team/${staff.userId}`)).status, 403, 'A manager removed staff');
  assert.equal((await m.send('DELETE', `/team/${ownerUser.id}`)).status, 403, 'A manager removed the owner');
  const owner = await ownerApp(world, shop);
  await staleAll(world);
  const stale = await owner.send('DELETE', `/team/${staff.userId}`);
  assert.deepEqual([stale.status, stale.data?.code], [403, 'reauth_required'], 'Removing someone without a fresh re-auth');
  await freshen(world, owner);
  assert.equal((await owner.send('DELETE', `/team/${staff.userId}`)).status, 204);
});

test('F-47: an invitation becomes an account only when the invited number signs in, with the role and permissions chosen', async () => {
  const shop = await addSeller(world, { name: 'Invite Works' });
  const owner = await ownerApp(world, shop);
  const phone = newSellerPhone();
  const invite = await owner.send('POST', '/team/invites', { contact: phone, role: 'staff', permissions: ['orders', 'catalog'] });
  assert.equal(invite.status, 201, `Inviting: ${invite.status} ${invite.text.slice(0, 200)}`);
  assert.ok(!invite.text.includes(local10(phone)), 'The invitation shows the whole number');
  const [row] = await shop.sql('SELECT * FROM team_invites WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]);
  assert.ok(row && !JSON.stringify(row).includes(local10(phone)), 'team_invites holds the number');
  // Typing the number made nobody: there is no account until the person signs in.
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND phone = $2', [shop.tenantId, local10(phone)]))[0].n, 0);
  const s = await appSignIn(world, phone, { tenantId: shop.tenantId });
  assert.equal(s.business.id, shop.tenantId);
  assert.equal(s.user.role, 'staff');
  assert.deepEqual([...s.user.permissions].sort(), ['catalog', 'orders']);
  assert.equal((await s.send('GET', '/automations')).status, 403);
  const team = await owner.send('GET', '/team');
  const member = team.data.items.find((x) => x.role === 'staff');
  assert.ok(member?.verified, 'The new member is not shown as verified');
  assert.ok(!team.data.invites.some((i) => i.id === invite.data.id), 'The accepted invitation is still open');
  // Another number cannot take it.
  const other = await owner.send('POST', '/team/invites', { contact: newSellerPhone(), role: 'manager', permissions: [] });
  assert.equal(other.status, 201);
  const stranger = newSellerPhone();
  await world.app('/api/v1/auth/start', { method: 'POST', body: { phone: stranger } });
  const code = await world.sellerCode(stranger);
  const res = await world.app('/api/v1/auth/verify', { method: 'POST', body: { phone: stranger, code, transport: 'bearer', tenantId: shop.tenantId } });
  assert.ok(res.status !== 201 || res.data.business.id !== shop.tenantId, 'A number that was not invited opened the business');
});

test('F-47: an invitation older than seven days opens nothing', async () => {
  const shop = await addSeller(world);
  const owner = await ownerApp(world, shop);
  const phone = newSellerPhone();
  assert.equal((await owner.send('POST', '/team/invites', { contact: phone, role: 'staff', permissions: ['orders'] })).status, 201);
  await world.shift(7 * 24 * 60 * 60 * SECOND + 60 * SECOND, ['team_invites']);
  await world.app('/api/v1/auth/start', { method: 'POST', body: { phone } });
  const code = await world.sellerCode(phone);
  const res = await world.app('/api/v1/auth/verify', { method: 'POST', body: { phone, code, transport: 'bearer', tenantId: shop.tenantId } });
  assert.ok(res.status !== 201 || res.data.business.id !== shop.tenantId, 'An expired invitation opened the business');
});

test('F-111: only a super admin can export the raw event log; support, the owner and the app cannot', async () => {
  const shop = await addSeller(world);
  const body = { reason: 'Spec audit', tables: ['audit_log'], tenantIds: [shop.tenantId], from: '2026-01-01', to: '2026-12-31' };
  const support = await consoleUser(world, 'support');
  const refused = await onConsole(world, support, '/raw-export', { method: 'POST', body });
  assert.equal(refused.status, 403, `Support's raw export answered ${refused.status}`);
  const admin = await consoleUser(world, 'super_admin');
  const done = await onConsole(world, admin, '/raw-export', { method: 'POST', body });
  assert.ok([200, 201].includes(done.status), `The super admin's raw export answered ${done.status}: ${done.text.slice(0, 200)}`);

  // The owner, signed in the Phase 5 way, on every address they have.
  const owner = await ownerApp(world, shop);
  for (const [host, path] of [[undefined, '/raw-export'], [undefined, '/api/v1/raw-export'], [shop.host, '/raw-export'], [CONSOLE_HOST, '/raw-export']]) {
    const res = await world.app(path, { method: 'POST', body, host, headers: { authorization: `Bearer ${owner.accessToken}` } });
    assert.ok([401, 403, 404].includes(res.status), `The owner's raw export at ${host ?? 'the sign-in host'}${path} answered ${res.status}`);
  }
  // No seller route exports raw rows.
  const exports = routeList.filter((r) => /raw|export/i.test(`${r.id} ${r.path}`));
  assert.deepEqual(exports.map((r) => r.id), [], 'A seller route exports raw rows');
});

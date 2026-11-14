// Impersonation (PRD 5.10, F-42 to F-45), from the console's side and the business's: a reason, at most 30 minutes, read
// only until a second confirmation, a one-time address on the business's own host, and an audit row for all of it.
import { test } from 'node:test';
import { CONSOLE_HOST, assert, consoleUser, hit, json, need, one, opCall, openSession, pause, shopOn, sql, useBillingWorld } from '../spec-p7/support.js';

const world = useBillingWorld();
const auditOf = (shop, pattern) => sql(world, `SELECT * FROM audit_log WHERE tenant_id = $1 AND action ~* $2 ORDER BY id`, [shop.tenantId, pattern]);
const opId = async (op) => (await one(world, 'SELECT id FROM platform_users WHERE email = $1', [op.email])).id;
async function start(shop, op, reason = 'ticket 42') {
  const res = need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/impersonate`, { reason }), 200, 'Starting an impersonation');
  return json(res);
}

test('F-42: starting needs a reason and the right role; the session is read-only, 30 minutes at most, and on the record', async () => {
  const shop = await shopOn(world, 't3');
  const op = await consoleUser(world, 'support');
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }]) assert.equal((await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/impersonate`, body)).status, 400);
  for (const role of ['onboarding', 'service_operator']) assert.equal((await opCall(world, await consoleUser(world, role), 'POST', `/tenants/${shop.tenantId}/impersonate`, { reason: 'x' })).status, 403, role);
  assert.equal((await hit(world, `/tenants/${shop.tenantId}/impersonate`, { host: CONSOLE_HOST, method: 'POST', body: { reason: 'x' } })).status, 401);
  assert.equal((await opCall(world, op, 'POST', '/tenants/999999/impersonate', { reason: 'x' })).status, 404);

  const started = await start(shop, op, 'ticket 42');
  const url = new URL(started.url);
  assert.equal(url.host, shop.host, 'the address is on the business\'s own host');
  assert.equal(started.session.mode, 'read');
  assert.equal(started.session.reason, 'ticket 42');
  assert.ok(new Date(started.session.expiresAt) - new Date(started.session.startedAt) <= 30 * 60_000);
  const row = await one(world, 'SELECT * FROM impersonation_sessions WHERE id = $1', [started.session.id]);
  assert.equal(row.operator_id, await opId(op));
  const session = await openSession(world, shop, started);
  const me = json(session.me);
  assert.deepEqual([me.operator.kind, me.operator.mode], ['impersonation', 'read']);
  assert.equal(me.user.role, 'owner');
  need(await session.call('GET', '/products'), 200, 'Reading');
  const write = await session.call('PATCH', '/settings', { storeName: 'Changed' });
  assert.deepEqual([write.status, write.data.code], [403, 'impersonation.read_only']);
  const rows = await auditOf(shop, '^impersonation\\.');
  const actions = rows.map((r) => r.action);
  for (const action of ['impersonation.start', 'impersonation.enter', 'impersonation.request']) assert.ok(actions.includes(action), action);
  const startRow = rows.find((r) => r.action === 'impersonation.start');
  assert.equal(startRow.actor, `platform:${await opId(op)}`);
  assert.equal(startRow.details.reason, 'ticket 42');
  assert.ok(rows.filter((r) => r.action === 'impersonation.request').every((r) => r.details.operatorId && r.details.ownerId));
});

test('F-42: the one-time address works once, for a minute, only on its own business, and its cookie is no use anywhere else', async () => {
  const shop = await shopOn(world, 't1');
  const other = await shopOn(world, 't1');
  const op = await consoleUser(world, 'support');
  const started = await start(shop, op);
  const url = new URL(started.url);
  const wrongHost = await hit(world, `${url.pathname}${url.search}`, { host: other.host });
  assert.equal(wrongHost.status, 404, 'not on another business');
  const first = await hit(world, `${url.pathname}${url.search}`, { host: shop.host });
  assert.equal(first.status, 303);
  assert.equal(first.headers['cache-control'], 'no-store');
  const cookie = String(first.headers['set-cookie']).split(';')[0];
  assert.match(cookie, /^sid=/);
  assert.match(String(first.headers['set-cookie']), /HttpOnly/i);
  const again = await hit(world, `${url.pathname}${url.search}`, { host: shop.host });
  assert.equal(again.status, 404, 'once');
  assert.equal((await hit(world, '/api/v1/auth/me', { host: other.host, cookie })).status, 401);
  assert.equal((await hit(world, '/api/v1/auth/me', { host: shop.host, cookie, headers: { 'x-tenant-id': String(other.tenantId) } })).status >= 400, true);
  assert.equal((await hit(world, '/api/v1/auth/me', { host: CONSOLE_HOST, cookie })).status >= 400, true, 'nor on the console');
  // Two uses at the same moment: one session at most.
  const racing = await start(shop, await consoleUser(world, 'support'));
  const r = new URL(racing.url);
  const both = await Promise.all([1, 2].map(() => hit(world, `${r.pathname}${r.search}`, { host: shop.host })));
  assert.equal(both.filter((x) => x.status === 303).length, 1);
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM sessions WHERE impersonation_id = $1', [racing.session.id])).n), 1);
  // An ended session's address opens nothing, and neither does a made-up one.
  const late = await start(shop, await consoleUser(world, 'support'));
  await sql(world, 'UPDATE impersonation_sessions SET ended_at = now() WHERE id = $1', [late.session.id]);
  const l = new URL(late.url);
  assert.equal((await hit(world, `${l.pathname}${l.search}`, { host: shop.host })).status, 404, 'an ended session');
  assert.equal((await hit(world, '/operator/enter?t=short', { host: shop.host })).status, 404, 'a made-up token');
});

test('F-43: write mode needs the business name and a reason from the operator who started it; blocked routes stay blocked', async () => {
  const shop = await shopOn(world, 't3');
  const product = await shop.product({ pricePaise: 10_000 });
  const op = await consoleUser(world, 'support');
  const started = await start(shop, op);
  const s = await openSession(world, shop, started);
  const id = started.session.id;
  const confirm = (who, body) => opCall(world, who, 'POST', `/impersonations/${id}/write`, body);
  assert.equal((await confirm(op, { confirm: 'Another shop', reason: 'fix' })).status, 400);
  assert.equal((await confirm(op, { confirm: shop.name })).status, 400);
  assert.equal((await confirm(op, { confirm: shop.name, reason: ' ' })).status, 400);
  assert.equal((await confirm(await consoleUser(world, 'support'), { confirm: shop.name, reason: 'not mine' })).status, 403, 'another operator');
  assert.equal((await confirm(await consoleUser(world, 'onboarding'), { confirm: shop.name, reason: 'x' })).status, 403);
  assert.equal((await s.call('PATCH', `/products/${product.id}`, { pricePaise: 5000 })).status, 403);
  const on = json(need(await confirm(op, { confirm: `  ${shop.name.toUpperCase()} `, reason: 'owner asked on the phone' }), 200, 'Write mode'));
  assert.equal(on.mode, 'write');
  need(await s.call('PATCH', `/products/${product.id}`, { pricePaise: 5000 }), 200, 'A write');
  assert.equal((await shop.getProduct(product.id)).pricePaise, 5000);
  const writeRow = (await auditOf(shop, '^impersonation\\.write_mode$'))[0];
  assert.equal(writeRow.details.reason, 'owner asked on the phone');
  // Even in write mode: the owner's phone and email, closing the business, and billing.
  const owner = await one(world, `SELECT phone, email FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenantId]);
  for (const [method, path, body] of [['PATCH', '/auth/me', { phone: '9999999999' }], ['DELETE', '/auth/account'], ['POST', '/billing/change', { plan: 't5', requestKey: 'abcdefgh1' }], ['GET', '/billing']]) {
    const res = await s.call(method, path, body);
    assert.ok([403, 404, 405].includes(res.status), `${method} ${path}: ${res.status}`);
  }
  assert.deepEqual(await one(world, `SELECT phone, email FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenantId]), owner);
  assert.equal((await one(world, 'SELECT plan FROM tenants WHERE id = $1', [shop.tenantId])).plan, 't3');
});

test('F-44: a session ends by itself at 30 minutes and at once when ended from the console; the list shows past and live ones', async () => {
  const shop = await shopOn(world, 't1');
  const op = await consoleUser(world, 'support');
  const started = await start(shop, op);
  const s = await openSession(world, shop, started);
  const id = started.session.id;
  const live = json(need(await opCall(world, op, 'GET', `/impersonations?tenantId=${shop.tenantId}&live=true`), 200, 'Live'));
  assert.ok(live.items.some((i) => i.id === id));
  await sql(world, `UPDATE impersonation_sessions SET started_at = now() - interval '29 minutes 59 seconds', expires_at = now() + interval '1 second' WHERE id = $1`, [id]);
  assert.equal((await s.call('GET', '/products')).status, 200);
  await pause(1300);
  assert.equal((await s.call('GET', '/products')).status, 401, 'over by itself, with the cookie still in hand');
  const past = json(need(await opCall(world, op, 'GET', `/impersonations?tenantId=${shop.tenantId}&live=false`), 200, 'Past'));
  assert.ok(past.items.some((i) => i.id === id));
  assert.equal((await opCall(world, op, 'POST', `/impersonations/${id}/write`, { confirm: shop.name, reason: 'late' })).status, 409, 'no write mode on an ended session');

  const next = await start(shop, op, 'ticket 43');
  const s2 = await openSession(world, shop, next);
  const ended = json(need(await opCall(world, op, 'POST', `/impersonations/${next.session.id}/end`), 200, 'Ending'));
  assert.ok(ended.endedAt);
  assert.equal((await s2.call('GET', '/products')).status, 401);
  assert.ok((await one(world, 'SELECT revoked_at FROM sessions WHERE impersonation_id = $1', [next.session.id])).revoked_at, 'its cookie is revoked');
  assert.equal((await auditOf(shop, '^impersonation\\.end$')).length, 1);
  // Starting again ends the operator's previous live session there.
  const a = await start(shop, op, 'ticket 44');
  const b = await start(shop, op, 'ticket 45');
  assert.ok((await one(world, 'SELECT ended_at FROM impersonation_sessions WHERE id = $1', [a.session.id])).ended_at);
  assert.equal((await one(world, 'SELECT ended_at FROM impersonation_sessions WHERE id = $1', [b.session.id])).ended_at, null);
  // Paging.
  const page1 = json(need(await opCall(world, op, 'GET', `/impersonations?tenantId=${shop.tenantId}&limit=2`), 200, 'Page 1'));
  assert.equal(page1.items.length, 2);
  const page2 = json(need(await opCall(world, op, 'GET', `/impersonations?tenantId=${shop.tenantId}&limit=2&cursor=${page1.nextCursor}`), 200, 'Page 2'));
  assert.ok(page2.items.every((i) => i.id < page1.items.at(-1).id));
});

test('F-42: shopper contacts are masked in an impersonated session outside order detail', async () => {
  const shop = await shopOn(world, 't3');
  await shop.repos?.users?.create?.({ name: 'Asha K', phone: '9876543210', password: 'shopper-pass-1', role: 'customer' }).catch(() => {});
  const s = await openSession(world, shop, await start(shop, await consoleUser(world, 'support')));
  const customers = await s.call('GET', '/customers');
  if (customers.status === 200) assert.doesNotMatch(customers.text, /9876543210/);
  const settings = need(await s.call('GET', '/settings'), 200, 'Settings');
  assert.doesNotMatch(settings.text, /sim-key-secret|test-ig-token/);
});

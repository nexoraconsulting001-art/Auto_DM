// PRD 5.5 (sign-in), 5.8 (pauses and the kill switch), 5.9 (tenant health) and 5.10 (impersonation). F-36 to F-45.
// The Platform Console is on its own host; an impersonation is a seller session the router fences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareHealth, HEALTH_STATUSES } from '../../../src/contracts/health.js';
import { IMPERSONATION_BLOCKED, impersonationBlocked, routeList } from '../../../src/contracts/api/index.js';
import {
  CONSOLE_HOST, buyer, consoleUser, hit, impersonate, json, need, one, onConsole, opCall, ownGateway, pause, shopOn, sql, totp, unique, useBillingWorld, addStaff, clearFaults,
} from './support.js';

const world = useBillingWorld();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });
const isPaused = async (shop) => Boolean((await one(world, 'SELECT paused_by FROM compliance_settings WHERE tenant_id = $1', [shop.tenantId]))?.paused_by);
const audit = (shop, pattern) => sql(world, `SELECT * FROM audit_log WHERE tenant_id = $1 AND action ~* $2 ORDER BY id`, [shop.tenantId, pattern]);

// ---- 5.8 ----------------------------------------------------------------------------------------------------------------------

test('F-36: a business pause with no reason, a blank one or an over-long one is blocked and the business keeps running', async () => {
  const shop = await shopOn(world, 't3');
  const op = await consoleUser(world);
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: null }, { reason: 42 }]) {
    const res = await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/pause`, body);
    assert.equal(res.status, 400, `reason ${JSON.stringify(body.reason)}: ${res.text.slice(0, 120)}`);
  }
  assert.equal(await isPaused(shop, op), false);
  assert.equal((await audit(shop, 'pause')).length, 0, 'a refused pause leaves no pause on record');
  need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/pause`, { reason: 'Meta asked us to stop' }), 200, 'Pausing with a reason');
  assert.equal(await isPaused(shop, op), true);
  const row = (await audit(shop, 'pause'))[0];
  assert.ok(row, 'the pause is audited');
  assert.match(JSON.stringify(row), /Meta asked us to stop/);
});

test('F-36: the pause routes are the console\'s: a business address, an owner\'s token and an anonymous caller get nothing', async () => {
  const shop = await shopOn(world, 't1');
  const other = await shopOn(world, 't1');
  const attempt = { reason: 'because' };
  assert.equal((await hit(world, `/tenants/${other.tenantId}/pause`, { host: shop.host, method: 'POST', body: attempt })).status, 404);
  assert.equal((await hit(world, `/tenants/${other.tenantId}/pause`, { host: CONSOLE_HOST, method: 'POST', body: attempt })).status, 401);
  assert.equal((await hit(world, `/tenants/${other.tenantId}/pause`, { host: CONSOLE_HOST, method: 'POST', body: attempt, token: shop.token })).status, 401);
  assert.equal(await isPaused(other), false);
  const onboarding = await consoleUser(world, 'onboarding');
  assert.equal((await opCall(world, onboarding, 'POST', `/tenants/${other.tenantId}/pause`, attempt)).status, 403, 'the onboarding team does not pause');
});

test('F-37: an owner cannot resume a business support paused: the message is "Paused by support. Contact support." and it stays paused', async () => {
  const shop = await shopOn(world, 't3');
  const op = await consoleUser(world);
  need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/pause`, { reason: 'investigation' }), 200, 'Pausing');
  for (const path of ['/compliance/resume']) {
    const res = await shop.send('POST', path, {});
    assert.ok([401, 403, 409].includes(res.status), `${path} answered ${res.status}`);
    assert.match(res.text, /Paused by support\. Contact support\./);
  }
  assert.equal(await isPaused(shop, op), true);
  const status = json(need(await shop.send('GET', '/compliance/status'), 200, 'Compliance status'));
  // The status names who paused it by the contract's code (pausedBy 'ops' is support, src/contracts/api/compliance.js); the words are the screen's.
  assert.equal(status.pausedBy, 'ops', 'the owner is shown who paused it');
  assert.equal(status.canResume, false, 'and cannot resume it');
  const pauses = json(need(await opCall(world, op, 'GET', `/pauses?tenantId=${shop.tenantId}`), 200, 'The pause list'));
  const mine = pauses.items.find((p) => p.scope === 'business' && p.engaged);
  assert.ok(mine, 'the console lists it');
  assert.equal(mine.by, 'platform');
  assert.equal(mine.reason, 'investigation');
  need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/resume`, { reason: 'cleared' }), 200, 'Resuming from the console');
  assert.equal(await isPaused(shop, op), false);
});

test('F-37: an owner can pause and resume their own automations, and that is shown as theirs, not the platform\'s', async () => {
  const shop = await shopOn(world, 't1');
  need(await shop.send('POST', '/compliance/pause', { reason: 'holiday' }), 200, 'Owner pause');
  const op = await consoleUser(world);
  const pauses = json(need(await opCall(world, op, 'GET', `/pauses?tenantId=${shop.tenantId}&engaged=true`), 200, 'Pauses'));
  assert.ok(pauses.items.some((p) => p.by === 'owner'));
  need(await shop.send('POST', '/compliance/resume', {}), 200, 'Owner resume');
});

test('F-38: the global kill switch shows actor, reason and a pending release; the one who asks for the release cannot approve it', async () => {
  const first = await consoleUser(world);
  const second = await consoleUser(world);
  assert.equal((await opCall(world, first, 'POST', '/kill-switch', { scope: 'global' })).status, 400, 'no reason');
  assert.equal((await opCall(world, first, 'POST', '/kill-switch', { scope: 'global', reason: ' ' })).status, 400);
  assert.equal((await opCall(world, first, 'POST', '/kill-switch', { scope: 'tenant', reason: 'x' })).status, 400, 'only the global scope here');
  try {
    need(await opCall(world, first, 'POST', '/kill-switch', { scope: 'global', reason: 'Meta incident 42' }), 200, 'Engaging');
    const switches = json(need(await opCall(world, second, 'GET', '/switches'), 200, 'Switches'));
    const global = switches.items.find((s) => s.key === 'global' || /global/.test(s.key));
    assert.ok(global?.engaged, 'engaged');
    assert.equal(global.reason, 'Meta incident 42');
    assert.ok(global.engagedBy, 'the actor is named');
    assert.ok(global.engagedAt);
    assert.ok(!global.releaseRequestedBy, 'nothing pending yet');
    need(await opCall(world, first, 'POST', '/kill-switch/release', { reason: 'incident over' }), 200, 'Asking for the release');
    const pending = json(need(await opCall(world, second, 'GET', '/switches'), 200, 'Switches')).items.find((s) => /global/.test(s.key));
    assert.ok(pending.releaseRequestedBy, 'the pending release names who asked');
    assert.ok(pending.engaged, 'still engaged while the release waits');
    const self = await opCall(world, first, 'POST', '/kill-switch/release/approve', { reason: 'me again' });
    assert.ok([403, 409].includes(self.status), `approving your own request: ${self.status}`);
    assert.ok(json(need(await opCall(world, second, 'GET', '/switches'), 200, 'Switches')).items.find((s) => /global/.test(s.key)).engaged);
    need(await opCall(world, second, 'POST', '/kill-switch/release/approve', { reason: 'agreed' }), 200, 'Approving');
    assert.equal(json(need(await opCall(world, second, 'GET', '/switches'), 200, 'Switches')).items.find((s) => /global/.test(s.key)).engaged, false);
  } finally {
    await sql(world, `UPDATE platform_switches SET engaged = false WHERE key = 'global'`).catch(() => {});
  }
});

test('F-38: nothing is sent while the global switch is engaged, and a seller cannot engage or release it', async () => {
  const shop = await shopOn(world, 't1');
  const op = await consoleUser(world);
  assert.ok((await shop.send('POST', '/kill-switch', { scope: 'global', reason: 'x' })).status >= 400);
  assert.equal((await hit(world, '/kill-switch', { host: shop.host, method: 'POST', token: shop.token, body: { scope: 'global', reason: 'x' } })).status, 404);
  const auto = await shop.automate();
  try {
    need(await opCall(world, op, 'POST', '/kill-switch', { scope: 'global', reason: 'drill' }), 200, 'Engaging');
    await world.switchLag();
    const before = (await shop.dms()).length;
    await shop.comment(auto.mediaId, { from: world.fan() });
    await shop.settle();
    assert.equal((await shop.dms()).length, before, 'no DM while the switch is engaged');
  } finally {
    await sql(world, `UPDATE platform_switches SET engaged = false WHERE key = 'global'`).catch(() => {});
    await world.switchLag();
  }
});

// ---- 5.9 ----------------------------------------------------------------------------------------------------------------------

test('F-39: three businesses with different health are listed worst first, each check with when it last ran', async () => {
  const good = await shopOn(world, 't1');
  const poor = await shopOn(world, 't1');
  const bad = await shopOn(world, 't1');
  await sql(world, `UPDATE ig_accounts SET token_expires_at = now() + interval '10 days' WHERE tenant_id = $1`, [poor.tenantId]);
  await sql(world, `UPDATE ig_accounts SET status = 'reconnect_needed', token_expires_at = now() - interval '1 day' WHERE tenant_id = $1`, [bad.tenantId]);
  const op = await consoleUser(world);
  for (const shop of [good, poor, bad]) need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/health/run`), 200, 'Running the checks');
  const list = json(need(await opCall(world, op, 'GET', '/tenant-health?limit=100'), 200, 'The health list'));
  const ids = list.items.map((i) => i.tenantId);
  const at = (shop) => ids.indexOf(shop.tenantId);
  assert.ok(at(bad) !== -1 && at(poor) !== -1 && at(good) !== -1, 'all three are listed');
  assert.ok(at(bad) < at(good), 'the worst comes before the healthy one');
  assert.ok(at(bad) < at(poor));
  const sorted = [...list.items].sort((a, b) => compareHealth({ worst: a.worst, score: a.score, name: a.tenantName }, { worst: b.worst, score: b.score, name: b.tenantName }));
  assert.deepEqual(list.items.map((i) => i.tenantId), sorted.map((i) => i.tenantId), 'sorted by the contract\'s order');
  for (const item of list.items.filter((i) => [good, poor, bad].some((s) => s.tenantId === i.tenantId))) {
    assert.ok(HEALTH_STATUSES.includes(item.worst));
    assert.ok(item.checks.length >= 5);
    assert.ok(item.checks.every((c) => c.lastRanAt), 'every check says when it ran');
  }
  assert.equal((await opCall(world, await consoleUser(world, 'service_operator'), 'GET', '/tenant-health')).status, 403);
  assert.equal((await good.send('GET', '/tenant-health')).status >= 400, true);
});

test('F-39: a check runs at most every 10 minutes per business: asking again at once answers the stored row', async () => {
  const biz = await shopOn(world, 't1');
  const op = await consoleUser(world);
  const first = json(need(await opCall(world, op, 'POST', `/tenants/${biz.tenantId}/health/run`), 200, 'Run 1'));
  const calls = (await world.meta.get('/calls')).calls?.length ?? 0;
  const second = json(need(await opCall(world, op, 'POST', `/tenants/${biz.tenantId}/health/run`), 200, 'Run 2'));
  assert.deepEqual(second.checks.map((c) => c.lastRanAt), first.checks.map((c) => c.lastRanAt), 'the stored rows');
  assert.equal(((await world.meta.get('/calls')).calls?.length ?? 0), calls, 'no new call to Meta');
  await sql(world, `UPDATE tenant_health_checks SET last_ran_at = now() - interval '10 minutes 1 second' WHERE tenant_id = $1`, [biz.tenantId]).catch(() => {});
});

test('F-40: when the Graph API hangs the check says unreachable at 10 seconds, and the page still loads', async () => {
  const biz = await shopOn(world, 't1');
  const op = await consoleUser(world);
  await world.meta.post('/faults', { kind: 'timeout', match: { path: '*' }, times: 'forever' });
  try {
    const started = Date.now();
    const res = await opCall(world, op, 'POST', `/tenants/${biz.tenantId}/health/run`);
    const took = Date.now() - started;
    need(res, 200, 'Running the checks against a hanging Graph API');
    assert.ok(took >= 9_000 && took < 20_000, `stopped at about 10 s, took ${took} ms`);
    const graph = json(res).checks.find((c) => c.check === 'account.graph');
    assert.equal(graph.status, 'unreachable');
    const page = await opCall(world, op, 'GET', '/tenant-health');
    assert.equal(page.status, 200, 'the page loads');
    assert.ok(json(page).items.length >= 1);
  } finally {
    await clearFaults(world.meta);
  }
});

test('F-41: revoked own payment keys turn the payments check red and the owner gets a reconnect notice, once', async () => {
  const biz = await shopOn(world, 't3');
  await ownGateway(world, biz);
  const op = await consoleUser(world);
  need(await opCall(world, op, 'POST', `/tenants/${biz.tenantId}/health/run`), 200, 'Run on good keys');
  assert.equal(json(need(await opCall(world, op, 'GET', `/tenants/${biz.tenantId}/health`), 200, 'Health')).checks.find((c) => c.check === 'keys.payments').status, 'ok');
  await sql(world, `UPDATE tenant_health_checks SET last_ran_at = now() - interval '11 minutes' WHERE tenant_id = $1`, [biz.tenantId]).catch(() => {});
  await world.rzp.post('/faults', { kind: 'rate_limit', status: 401, times: 'forever', body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The API key provided is invalid.' } } });
  try {
    const res = need(await opCall(world, op, 'POST', `/tenants/${biz.tenantId}/health/run`), 200, 'Run on revoked keys');
    assert.equal(json(res).checks.find((c) => c.check === 'keys.payments').status, 'bad');
    await world.quiet(800);
    const notices = await sql(world, `SELECT kind FROM notification_events WHERE tenant_id = $1 AND kind ~ 'reconnect'`, [biz.tenantId]);
    assert.equal(notices.length, 1, 'one reconnect notice');
    assert.match(notices[0].kind, /payments/);
    await sql(world, `UPDATE tenant_health_checks SET last_ran_at = now() - interval '11 minutes' WHERE tenant_id = $1`, [biz.tenantId]).catch(() => {});
    await opCall(world, op, 'POST', `/tenants/${biz.tenantId}/health/run`);
    assert.equal((await sql(world, `SELECT 1 FROM notification_events WHERE tenant_id = $1 AND kind ~ 'reconnect'`, [biz.tenantId])).length, 1, 'not repeated while it stays red');
  } finally {
    await clearFaults(world.rzp);
  }
  const own = await shopOn(world, 't3');
  const managed = json(need(await opCall(world, op, 'POST', `/tenants/${own.tenantId}/health/run`), 200, 'A business on Bhava\'s accounts'));
  assert.ok(!managed.checks.some((c) => c.check === 'keys.payments' && c.status === 'bad'), 'no own-key check for a business on the default path');
});

// ---- 5.10 ---------------------------------------------------------------------------------------------------------------------

test('F-42: an impersonation with a reason is a read-only view of the owner\'s console, bannered, with an audit row naming both people', async () => {
  const shop = await shopOn(world, 't3');
  const op = await consoleUser(world, 'support');
  for (const body of [{}, { reason: '' }, { reason: '  ' }]) assert.equal((await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/impersonate`, body)).status, 400);
  const session = await impersonate(world, shop, op, 'ticket 123');
  const me = json(session.me);
  assert.equal(me.operator.kind, 'impersonation');
  assert.equal(me.operator.mode, 'read');
  assert.ok(me.operator.operatorName);
  assert.ok(new Date(me.operator.expiresAt).getTime() - Date.now() <= 30 * 60_000 + 5_000, 'at most 30 minutes');
  need(await session.call('GET', '/products'), 200, 'Reading as the owner');
  const rows = await audit(shop, 'impersonation');
  assert.ok(rows.length >= 2, 'the start and the request are audited');
  const text = JSON.stringify(rows);
  assert.match(text, /ticket 123/);
  assert.ok(rows.some((r) => /operatorId/.test(JSON.stringify(r.details)) && /ownerId/.test(JSON.stringify(r.details))), 'both ids on the request row');
  const staffOnly = await consoleUser(world, 'service_operator');
  assert.equal((await opCall(world, staffOnly, 'POST', `/tenants/${shop.tenantId}/impersonate`, { reason: 'x' })).status, 403);
  assert.equal((await opCall(world, await consoleUser(world, 'onboarding'), 'POST', `/tenants/${shop.tenantId}/impersonate`, { reason: 'x' })).status, 403);
  assert.equal((await hit(world, `/tenants/${shop.tenantId}/impersonate`, { host: shop.host, method: 'POST', body: { reason: 'x' } })).status, 404);
});

test('F-42: the one-time address works once and only for a minute, and a stolen session cookie is no use on another business', async () => {
  const shop = await shopOn(world, 't1');
  const other = await shopOn(world, 't1');
  const op = await consoleUser(world, 'support');
  const started = json(need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/impersonate`, { reason: 'ticket 5' }), [200, 201], 'Start'));
  const url = new URL(started.url, `https://${shop.host}`);
  const first = await hit(world, `${url.pathname}${url.search}`, { host: shop.host });
  assert.ok(first.status < 400);
  const second = await hit(world, `${url.pathname}${url.search}`, { host: shop.host });
  assert.ok(second.status >= 400 || !String(second.headers['set-cookie'] ?? '').includes('sid='), 'the address is good once');
  const cookie = String(first.headers['set-cookie']).split(';')[0];
  assert.equal((await hit(world, '/api/v1/auth/me', { host: other.host, cookie })).status, 401, 'not on another business');
  const wrongHost = await hit(world, `${url.pathname}${url.search}`, { host: other.host });
  assert.ok(wrongHost.status >= 400 || !String(wrongHost.headers['set-cookie'] ?? '').includes('sid='));
});

test('F-43: a save in read-only mode gets 403 on every write, however the request is made, and nothing changes', async () => {
  const shop = await shopOn(world, 't3');
  const product = await shop.product({ pricePaise: 10_000 });
  const op = await consoleUser(world, 'support');
  const s = await impersonate(world, shop, op, 'ticket 7');
  const before = await shop.getProduct(product.id);
  for (const [method, path, body] of [['PATCH', `/products/${product.id}`, { pricePaise: 1 }], ['DELETE', `/products/${product.id}`], ['POST', '/products', { name: 'Sneaky', pricePaise: 100, active: true }], ['PATCH', '/settings', { storeName: 'Hacked' }], ['POST', '/compliance/pause', { reason: 'x' }]]) {
    const res = await s.call(method, path, body);
    assert.equal(res.status, 403, `${method} ${path}: ${res.text.slice(0, 120)}`);
    assert.equal(res.data.code, 'impersonation.read_only');
  }
  const noCsrf = await hit(world, `/api/v1/products/${product.id}`, { host: shop.host, cookie: s.cookie, method: 'PATCH', body: { pricePaise: 1 } });
  assert.ok(noCsrf.status === 403 || noCsrf.status === 401);
  assert.deepEqual(await shop.getProduct(product.id), before);
  const refusals = await audit(shop, 'impersonation');
  assert.ok(refusals.length >= 5, 'refusals are audited too');
});

test('F-43: write mode needs a second confirmation with the business name and a reason; with it a change is audited, and the blocked routes stay blocked', async () => {
  const shop = await shopOn(world, 't3');
  const product = await shop.product({ pricePaise: 10_000 });
  const op = await consoleUser(world, 'support');
  const s = await impersonate(world, shop, op, 'ticket 8');
  const id = json(s.me).operator.id;
  assert.ok(id);
  const sessionRow = await one(world, `SELECT id FROM impersonation_sessions WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [shop.tenantId]);
  const confirm = (body) => opCall(world, op, 'POST', `/impersonations/${sessionRow.id}/write`, body);
  assert.equal((await confirm({ confirm: 'Some other shop', reason: 'fix price' })).status, 400, 'the wrong name');
  assert.equal((await confirm({ confirm: shop.name })).status, 400, 'no reason');
  assert.equal((await s.call('PATCH', `/products/${product.id}`, { pricePaise: 5000 })).status, 403, 'still read-only');
  need(await confirm({ confirm: shop.name, reason: 'owner asked on the phone' }), 200, 'The second confirmation');
  need(await s.call('PATCH', `/products/${product.id}`, { pricePaise: 5000 }), 200, 'A write after confirming');
  assert.equal((await shop.getProduct(product.id)).pricePaise, 5000);
  const mine = await opCall(world, await consoleUser(world, 'support'), 'POST', `/impersonations/${sessionRow.id}/write`, { confirm: shop.name, reason: 'someone else\'s session' });
  assert.ok(mine.status < 500, `another operator confirming this session: never a crash, got ${mine.status}`);
  assert.ok(IMPERSONATION_BLOCKED, 'the contract names the blocked routes');
  const blocked = routeList.filter((r) => impersonationBlocked(r) && r.id !== 'auth.logout');
  assert.ok(blocked.length >= 20, 'there are routes to try');
  for (const r of blocked) {
    const path = r.path.replace(/:[a-zA-Z]+/g, '1');
    const res = await s.call(r.method, path, r.method === 'GET' ? undefined : {});
    assert.equal(res.status, 403, `${r.id} in write mode: ${res.status} ${res.text.slice(0, 80)}`);
    assert.equal(res.data?.code, 'impersonation.blocked', r.id);
  }
});

test('F-44: a session at 30 minutes less a second works, and at 31 minutes it is over and the console says it ended', async () => {
  const shop = await shopOn(world, 't1');
  const op = await consoleUser(world, 'support');
  const s = await impersonate(world, shop, op, 'ticket 9');
  const row = await one(world, `SELECT id FROM impersonation_sessions WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [shop.tenantId]);
  await sql(world, `UPDATE impersonation_sessions SET expires_at = now() + interval '1 second' WHERE id = $1`, [row.id]);
  await sql(world, `UPDATE sessions SET expires_at = now() + interval '1 second' WHERE impersonation_id = $1`, [row.id]);
  assert.equal((await s.call('GET', '/products')).status, 200, 'one second before the end');
  await pause(1300);
  assert.equal((await s.call('GET', '/products')).status, 401, 'one second after');
  assert.equal(json(need(await opCall(world, op, 'GET', `/impersonations?tenantId=${shop.tenantId}&live=false`), 200, 'Past sessions')).items.some((i) => i.id === Number(row.id)), true);
  await assert.rejects(sql(world, `UPDATE impersonation_sessions SET expires_at = started_at + interval '31 minutes' WHERE id = $1`, [row.id]), /check|violates/i, 'the database refuses more than 30 minutes');
  const again = await impersonate(world, shop, op, 'ticket 10');
  const next = await one(world, `SELECT id, started_at, expires_at FROM impersonation_sessions WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [shop.tenantId]);
  assert.ok(new Date(next.expires_at) - new Date(next.started_at) <= 30 * 60_000);
  need(await opCall(world, op, 'POST', `/impersonations/${next.id}/end`), 200, 'Ending it');
  assert.equal((await again.call('GET', '/products')).status, 401, 'ending it ends it at once');
});

test('F-45: an operator cannot change the owner\'s phone or email, in read or write mode, and the owner row does not change', async () => {
  const shop = await shopOn(world, 't3');
  const owner = await one(world, `SELECT id, phone, email FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenantId]);
  const op = await consoleUser(world, 'support');
  const s = await impersonate(world, shop, op, 'ticket 11');
  const row = await one(world, `SELECT id FROM impersonation_sessions WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [shop.tenantId]);
  const attempts = [['PATCH', '/auth/me', { phone: '9999999999', email: 'evil@example.com' }], ['POST', '/auth/link-identity', { phone: '9999999999' }], ['PATCH', '/team/1', { phone: '9999999999' }], ['PUT', '/settings', { ownerPhone: '9999999999' }], ['PATCH', '/settings', { phone: '9999999999', email: 'evil@example.com' }], ['DELETE', '/auth/account'], ['POST', '/billing/change', { plan: 't5', requestKey: 'abcdefgh1' }]];
  for (const mode of ['read', 'write']) {
    if (mode === 'write') need(await opCall(world, op, 'POST', `/impersonations/${row.id}/write`, { confirm: shop.name, reason: 'ticket 11 follow-up' }), 200, 'Write mode');
    for (const [method, path, body] of attempts) {
      const res = await s.call(method, path, body);
      assert.ok([400, 403, 404, 405].includes(res.status), `${mode} ${method} ${path}: ${res.status}`);
      assert.notEqual(res.status, 200);
    }
  }
  // User decision 2026-11-26 (F-45): PATCH /settings with a phone or email is refused, pointing to the verified change flow.
  const settings = await s.call('PATCH', '/settings', { phone: '9999999999', email: 'evil@example.com' });
  assert.equal(settings.status, 400, settings.text);
  assert.deepEqual(Object.keys(settings.data?.fields ?? {}).sort(), ['email', 'phone']);
  assert.match(settings.data.error, /Ways to sign in/);
  const after = await one(world, `SELECT id, phone, email FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenantId]);
  assert.deepEqual(after, owner);
  assert.equal((await one(world, 'SELECT plan FROM tenants WHERE id = $1', [shop.tenantId])).plan, 't3');
  assert.equal((await one(world, 'SELECT status FROM tenants WHERE id = $1', [shop.tenantId])).status !== 'closed', true);
});

test('F-42: shopper contacts are masked everywhere in a support session except order detail, and secrets stay masked', async () => {
  const shop = await shopOn(world, 't3');
  const b = buyer(world, shop);
  const product = await shop.product({ pricePaise: 49_900, stock: 5 });
  const { placed } = await b.buy({ lines: [line(product)] });
  const phone = placed.body.address.phone;
  const op = await consoleUser(world, 'support');
  const s = await impersonate(world, shop, op, 'ticket 12');
  for (const path of ['/customers', '/orders', '/leads', '/inbox/threads']) {
    const res = await s.call('GET', path);
    if (res.status !== 200) continue;
    assert.ok(!res.text.includes(phone.replace(/^\+/, '')) && !res.text.includes(phone), `${path} shows no phone number`);
  }
  const orders = json(need(await s.call('GET', '/orders'), 200, 'Orders'));
  const detail = need(await s.call('GET', `/orders/${orders.items[0].id}`), 200, 'Order detail');
  assert.ok(detail.text.includes(placed.body.address.line1), 'order detail shows what support needs for a delivery');
  const settings = need(await s.call('GET', '/settings'), 200, 'Settings');
  assert.doesNotMatch(settings.text, /sim-whatsapp-token|test-ig-token|rzp_test_sim|sim-key-secret/);
});

test('F-91: a staff member of one business cannot start an impersonation; operators of one role cannot use another role\'s routes', async () => {
  const shop = await shopOn(world, 't1');
  const staff = await addStaff(world, shop, { permissions: ['orders'] });
  assert.equal((await hit(world, `/tenants/${shop.tenantId}/impersonate`, { host: CONSOLE_HOST, method: 'POST', token: staff.token, body: { reason: 'x' } })).status, 401);
  const svc = await consoleUser(world, 'service_operator');
  for (const [method, path] of [['GET', '/audit-log'], ['GET', '/team'], ['POST', '/kill-switch'], ['GET', '/billing-settings'], ['GET', '/flags']]) {
    const res = await onConsole(world, svc, path, { method, ...(method === 'POST' ? { body: { scope: 'global', reason: 'x' } } : {}) });
    assert.equal(res.status, 403, `${method} ${path} for a service operator`);
  }
  const support = await consoleUser(world, 'support');
  for (const [method, path, body] of [['GET', '/team'], ['POST', '/team', { email: 'a@b.example', role: 'super_admin' }], ['PUT', '/billing-settings', { sac: '998439', reason: 'x' }], ['PUT', '/signup', { mode: 'public', reason: 'x' }], ['POST', `/tenants/${shop.tenantId}/plan`, { plan: 't5', reason: 'free upgrade' }]]) {
    const res = await onConsole(world, support, path, { method, ...(body ? { body } : {}) });
    assert.equal(res.status, 403, `${method} ${path} for support`);
  }
  assert.equal((await one(world, 'SELECT plan FROM tenants WHERE id = $1', [shop.tenantId])).plan, 't1');
});

// ---- 5.5 ----------------------------------------------------------------------------------------------------------------------

test('F-42: console sign-in is an emailed code and then an authenticator code: seller credentials, a replayed code and a guessed one do not get in', async () => {
  const email = `op${unique()}@team.example`;
  await world.platform.platformUsers.create({ email, password: 'console-pass-1', role: 'support', name: 'Meera' });
  const shop = await shopOn(world, 't1');
  // A seller's phone and password are not a console sign-in.
  assert.ok((await hit(world, '/sign-in/verify', { host: CONSOLE_HOST, method: 'POST', body: { email: shop.owner.phone, code: '123456' } })).status >= 400);
  // Any address is answered the same way, so the form cannot be used to find who works here.
  assert.equal((await hit(world, '/sign-in/code', { host: CONSOLE_HOST, method: 'POST', body: { email: `nobody${unique()}@team.example` } })).status, 204);
  assert.equal((await hit(world, '/sign-in/code', { host: CONSOLE_HOST, method: 'POST', body: { email } })).status, 204);
  const mail = (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email));
  assert.equal(mail.length, 1, 'one code, by email');
  const emailed = /(?<!\d)\d{6}(?!\d)/.exec(`${mail[0].text}${mail[0].html}`)?.[1] ?? /(?<!\d)(\d{6})(?!\d)/.exec(`${mail[0].text}${mail[0].html}`)?.[1];
  assert.ok(emailed, 'the code is in the mail');
  const wrong = emailed === '000000' ? '111111' : '000000';
  for (let i = 0; i < 2; i++) assert.ok((await hit(world, '/sign-in/verify', { host: CONSOLE_HOST, method: 'POST', body: { email, code: wrong } })).status >= 400);
  const ticket = json(need(await hit(world, '/sign-in/verify', { host: CONSOLE_HOST, method: 'POST', body: { email, code: emailed } }), 200, 'The emailed code'));
  assert.ok(ticket.ticket);
  assert.ok(ticket.enrol?.secret, 'a first sign-in is shown the secret to enrol, once');
  assert.ok((await hit(world, '/sign-in/verify', { host: CONSOLE_HOST, method: 'POST', body: { email, code: emailed } })).status >= 400, 'the emailed code works once');
  const secret = ticket.enrol.secret;
  const now = Date.now();
  const right = totp(secret, now);
  const guess = right === '000000' ? '000001' : '000000';
  assert.ok((await hit(world, '/sign-in/totp', { host: CONSOLE_HOST, method: 'POST', body: { ticket: ticket.ticket, code: guess } })).status >= 400, 'a guessed code');
  const stale = totp(secret, now - 10 * 60_000);
  if (stale !== right) assert.ok((await hit(world, '/sign-in/totp', { host: CONSOLE_HOST, method: 'POST', body: { ticket: ticket.ticket, code: stale } })).status >= 400, 'a code from ten minutes ago');
  assert.ok((await hit(world, '/sign-in/totp', { host: CONSOLE_HOST, method: 'POST', body: { ticket: 'forged-ticket-value', code: right } })).status >= 400, 'a made-up ticket');
  const signedIn = need(await hit(world, '/sign-in/totp', { host: CONSOLE_HOST, method: 'POST', body: { ticket: ticket.ticket, code: right } }), 200, 'The right code');
  assert.ok(signedIn.headers['set-cookie']);
  assert.ok(json(signedIn).recoveryCodes?.length >= 5, 'recovery codes are shown once at enrolment');
  // The same code again, on a fresh sign-in, is refused: a code is accepted once.
  await hit(world, '/sign-in/code', { host: CONSOLE_HOST, method: 'POST', body: { email } });
  const mail2 = (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email)).at(-1);
  const code2 = /(?<!\d)(\d{6})(?!\d)/.exec(`${mail2.text}${mail2.html}`)?.[1];
  const ticket2 = json(need(await hit(world, '/sign-in/verify', { host: CONSOLE_HOST, method: 'POST', body: { email, code: code2 } }), 200, 'Second sign-in'));
  const replay = await hit(world, '/sign-in/totp', { host: CONSOLE_HOST, method: 'POST', body: { ticket: ticket2.ticket, code: right } });
  assert.ok(replay.status >= 400, 'a TOTP code is not accepted twice');
  // Never on a business's address.
  assert.equal((await hit(world, '/sign-in/code', { host: shop.host, method: 'POST', body: { email } })).status, 404);
});

test('F-42: a disabled operator is signed out at once, and five wrong emailed codes lock that code', async () => {
  const email = `op${unique()}@team.example`;
  await world.platform.platformUsers.create({ email, password: 'console-pass-1', role: 'support', name: 'Ravi' });
  const op = await consoleUser(world, 'support');
  assert.equal((await onConsole(world, op, '/me')).status, 200);
  await sql(world, 'UPDATE platform_users SET disabled_at = now() WHERE email = $1', [op.email]);
  assert.equal((await onConsole(world, op, '/me')).status, 401);
  assert.equal((await hit(world, '/sign-in/code', { host: CONSOLE_HOST, method: 'POST', body: { email } })).status, 204, 'Asking for an emailed code');
  const mail = (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email)).at(-1);
  assert.ok(mail, 'No sign-in code was emailed');
  const real = /(?<!\d)(\d{6})(?!\d)/.exec(`${mail.text}${mail.html}`)?.[1];
  assert.ok(real, 'The email carries no six-digit code');
  const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 6; i++) await hit(world, '/sign-in/verify', { host: CONSOLE_HOST, method: 'POST', body: { email, code: wrong } });
  assert.ok((await hit(world, '/sign-in/verify', { host: CONSOLE_HOST, method: 'POST', body: { email, code: real } })).status >= 400, 'after five misses even the right code is refused');
});

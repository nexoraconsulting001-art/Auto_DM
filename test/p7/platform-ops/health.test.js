// Tenant health (PRD 5.9, F-39 to F-41). Attack cases: opening the page over and over, several runs at the same moment, a
// business on Bhava's own accounts, the wrong role, and secrets in what a check reports.
import { test } from 'node:test';
import { HEALTH_CHECK_NAMES, HEALTH_STATUSES } from '../../../src/contracts/health.js';
import { CONSOLE_HOST, assert, consoleUser, hit, json, need, opCall, ownGateway, shopOn, sql, useBillingWorld } from '../spec-p7/support.js';

const world = useBillingWorld();
const metaCalls = async () => (await world.meta.get('/calls')).calls?.length ?? 0;

test('F-39: however often the page is opened or the checks asked for at once, each check runs once per 10 minutes', async () => {
  const shop = await shopOn(world, 't1');
  const op = await consoleUser(world, 'support');
  // Opening the list and the business never runs anything: it reads what is stored.
  const before = await metaCalls();
  for (let i = 0; i < 3; i++) {
    need(await opCall(world, op, 'GET', '/tenant-health?limit=100'), 200, 'The list');
    const view = json(need(await opCall(world, op, 'GET', `/tenants/${shop.tenantId}/health`), 200, 'One business'));
    assert.ok(view.checks.every((c) => c.lastRanAt === null), 'nothing has run yet');
  }
  assert.equal(await metaCalls(), before, 'reading the page calls nobody');
  // Five runs at the same moment: one does the work, every answer holds the same times.
  const answers = await Promise.all(Array.from({ length: 5 }, () => opCall(world, op, 'POST', `/tenants/${shop.tenantId}/health/run`)));
  const bodies = answers.map((r) => json(need(r, 200, 'Run')));
  assert.ok(await metaCalls() - before <= 1, 'Meta was asked once at most');
  const rows = await sql(world, 'SELECT check_name, last_ran_at FROM tenant_health_checks WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(new Set(rows.map((r) => r.check_name)).size, rows.length, 'one row per check');
  const times = new Map(rows.map((r) => [r.check_name, new Date(r.last_ran_at).getTime()]));
  for (const body of bodies) for (const c of body.checks) if (c.lastRanAt) assert.equal(new Date(c.lastRanAt).getTime(), times.get(c.check));
  // Once the 10 minutes are up a check runs again.
  await sql(world, `UPDATE tenant_health_checks SET last_ran_at = now() - interval '10 minutes 1 second' WHERE tenant_id = $1 AND check_name = 'domain.dns'`, [shop.tenantId]);
  const again = json(need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/health/run`), 200, 'Run after 10 minutes'));
  const dns = again.checks.find((c) => c.check === 'domain.dns');
  assert.ok(Date.now() - new Date(dns.lastRanAt).getTime() < 60_000, 'the due check ran');
  const token = again.checks.find((c) => c.check === 'account.token');
  assert.equal(new Date(token.lastRanAt).getTime(), times.get('account.token'), 'the others did not');
});

test('F-39, F-41: the checks are the contract\'s, statuses are its words, own-key checks only for own keys, and no secret in a detail', async () => {
  const managed = await shopOn(world, 't3');
  const own = await shopOn(world, 't3');
  await ownGateway(world, own);
  const op = await consoleUser(world);
  const m = json(need(await opCall(world, op, 'POST', `/tenants/${managed.tenantId}/health/run`), 200, 'Managed'));
  const o = json(need(await opCall(world, op, 'POST', `/tenants/${own.tenantId}/health/run`), 200, 'Own keys'));
  for (const body of [m, o]) {
    assert.ok(body.checks.every((c) => HEALTH_CHECK_NAMES.includes(c.check) && HEALTH_STATUSES.includes(c.status) && c.label && c.lastRanAt));
    assert.equal(body.worst, [...body.checks.map((c) => c.status)].sort((a, b) => HEALTH_STATUSES.indexOf(a) - HEALTH_STATUSES.indexOf(b))[0]);
  }
  assert.ok(!m.checks.some((c) => c.check.startsWith('keys.')), 'no own-key check on Bhava\'s accounts');
  assert.equal(o.checks.find((c) => c.check === 'keys.payments')?.status, 'ok');
  const all = await sql(world, 'SELECT detail FROM tenant_health_checks WHERE tenant_id = ANY($1::int[])', [[managed.tenantId, own.tenantId]]);
  for (const { detail } of all) assert.doesNotMatch(JSON.stringify(detail), /secret|token_value|rzp_|access_token|EAA/i);
  // An Instagram token that expired shows at once as bad, without waiting for Account Health.
  await sql(world, `UPDATE ig_accounts SET token_expires_at = now() - interval '1 day' WHERE tenant_id = $1`, [managed.tenantId]);
  await sql(world, `UPDATE tenant_health_checks SET last_ran_at = now() - interval '11 minutes' WHERE tenant_id = $1`, [managed.tenantId]);
  const after = json(need(await opCall(world, op, 'POST', `/tenants/${managed.tenantId}/health/run`), 200, 'After expiry'));
  assert.equal(after.checks.find((c) => c.check === 'account.token').status, 'bad');
  assert.equal(after.worst, 'bad');
  const list = json(need(await opCall(world, op, 'GET', '/tenant-health?limit=100'), 200, 'List')).items;
  const firstOk = list.findIndex((i) => i.worst === 'ok');
  assert.ok(firstOk === -1 || list.findIndex((i) => i.tenantId === managed.tenantId) < firstOk, 'the bad one before every healthy one');
});

test('F-39: who may look: support and super admin run; onboarding may only look at one business; others and sellers get nothing', async () => {
  const shop = await shopOn(world, 't1');
  const onboarding = await consoleUser(world, 'onboarding');
  need(await opCall(world, onboarding, 'GET', `/tenants/${shop.tenantId}/health`), 200, 'Onboarding looks at one business');
  assert.equal((await opCall(world, onboarding, 'POST', `/tenants/${shop.tenantId}/health/run`)).status, 403);
  assert.equal((await opCall(world, onboarding, 'GET', '/tenant-health')).status, 403);
  const service = await consoleUser(world, 'service_operator');
  for (const [method, path] of [['GET', '/tenant-health'], ['GET', `/tenants/${shop.tenantId}/health`], ['POST', `/tenants/${shop.tenantId}/health/run`]]) assert.equal((await opCall(world, service, method, path)).status, 403, `${method} ${path}`);
  assert.equal((await hit(world, '/tenant-health', { host: CONSOLE_HOST })).status, 401);
  assert.equal((await hit(world, '/tenant-health', { host: CONSOLE_HOST, token: shop.token })).status, 401, 'an owner token on the console');
  assert.ok((await shop.send('GET', '/tenant-health')).status >= 400, 'not on a business');
  const support = await consoleUser(world, 'support');
  assert.equal((await opCall(world, support, 'GET', '/tenants/999997/health')).status, 404);
  assert.equal((await opCall(world, support, 'POST', '/tenants/999997/health/run')).status, 404);
  assert.equal((await opCall(world, support, 'GET', '/tenants/abc/health')).status, 404);
});

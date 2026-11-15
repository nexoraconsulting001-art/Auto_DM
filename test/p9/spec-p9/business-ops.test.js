// G-14 (PRD 11: observability): one business's errors, Meta calls and usage, and queue depth in the Platform Console, never
// under another business and never in /metrics. Attack cases: one business's numbers requested as another; by a seller and
// by a business's own address; with ids that are not ids; windows that exclude old events; events written outside any
// business; a flood of one business moving another's numbers; the answer searched for names and text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_OPS_EVENTS, BusinessOps } from '../../../src/contracts/metrics.js';
import { platformRoutes } from '../../../src/contracts/api/platform.js';
import { reportError } from '../../../src/platform/log.js';
import { withTenant } from '../../../src/tenancy.js';
import { CONSOLE_HOST, addBusiness, consoleUser, hit, need, onConsole, pause, signIn, startWorld, waitFor } from '../../p0/spec-p0/support.js';
import { assertNoneOf } from './support.js';

const E = BUSINESS_OPS_EVENTS;
const track = (app, shop, name, props) => withTenant(shop.tenant, () => app.ctx.platform.analytics.track(name, props));
async function give(app, shop, { errors = 0, calls = 0, throttled = 0, usage = null, queue = null } = {}) {
  for (let i = 0; i < errors; i++) await track(app, shop, E.error.name, { service: 'web', kind: 'sample' });
  for (let i = 0; i < calls; i++) await track(app, shop, E.metaCall.name, { call_class: 'send', result: 'ok' });
  for (let i = 0; i < throttled; i++) await track(app, shop, E.metaCall.name, { call_class: 'send', result: 'throttled' });
  if (usage !== null) await track(app, shop, E.metaUsage.name, { call_class: 'send', percent: usage });
  if (queue) await track(app, shop, E.queueDepth.name, { queue: 'dm', depth: queue.depth, oldest_seconds: queue.oldest });
}
const ops = (app, who, shop, query = '') => onConsole(app, who, `/tenants/${shop.tenant.id}/ops${query}`);

async function twoShops(t) {
  const app = await startWorld(t);
  const admin = await consoleUser(app);
  const a = await addBusiness(app, { slug: 'ops-alpha', name: 'Alpha Candles' });
  const b = await addBusiness(app, { slug: 'ops-beta', name: 'Beta Spices' });
  await give(app, a, { errors: 3, calls: 5, throttled: 2, usage: 80, queue: { depth: 12, oldest: 340 } });
  await give(app, b, { errors: 1, calls: 9, throttled: 0, usage: 15, queue: { depth: 2, oldest: 4 } });
  return { app, admin, a, b };
}

test('G-14: each business\'s errors, Meta calls, throttling, usage and queue depth show under that business and match what it did', async (t) => {
  const { app, admin, a, b } = await twoShops(t);
  const ra = await ops(app, admin, a);
  const rb = await ops(app, admin, b);
  assert.equal(ra.status, 200, ra.text.slice(0, 200));
  const A = BusinessOps.parse(ra.json());
  const B = BusinessOps.parse(rb.json());
  assert.equal(A.tenantId, a.tenant.id);
  assert.equal(B.tenantId, b.tenant.id);
  assert.deepEqual([A.errors, A.metaCalls, A.metaThrottled, A.metaUsagePercent, A.queueDepth, A.queueOldestSeconds], [3, 7, 2, 80, 12, 340]);
  assert.deepEqual([B.errors, B.metaCalls, B.metaThrottled, B.metaUsagePercent, B.queueDepth, B.queueOldestSeconds], [1, 9, 0, 15, 2, 4]);
});

test('G-14: one business\'s numbers never show under another, and a flood by one moves nobody else\'s', async (t) => {
  const { app, admin, a, b } = await twoShops(t);
  const before = (await ops(app, admin, b)).json();
  await give(app, a, { errors: 40, calls: 40, throttled: 10, usage: 99, queue: { depth: 900, oldest: 7000 } });
  const after = (await ops(app, admin, b)).json();
  assert.deepEqual(after, { ...before, since: after.since, until: after.until }, 'B is unchanged by what A did');
  const c = await addBusiness(app, { slug: 'ops-gamma', name: 'Gamma Teas' });
  const empty = (await ops(app, admin, c)).json();
  assert.deepEqual([empty.errors, empty.metaCalls, empty.metaThrottled, empty.metaUsagePercent, empty.queueDepth, empty.queueOldestSeconds], [0, 0, 0, 0, 0, 0], 'a business that did nothing shows nothing');
});

test('G-14: events written outside any business, or as the wrong one, reach nobody\'s numbers', async (t) => {
  const { app, admin, a, b } = await twoShops(t);
  const before = (await ops(app, admin, b)).json();
  await assert.rejects(app.ctx.platform.analytics.track(E.error.name, { service: 'web', kind: 'x' }), 'no business, no event');
  await withTenant(a.tenant, () => app.ctx.platform.analytics.track(E.error.name, { service: 'web', kind: 'for-a' }));
  assert.deepEqual((await ops(app, admin, b)).json().errors, before.errors);
});

test('G-14: an error reported while a business is being served is counted for that business and only that one', async (t) => {
  const { app, admin, a, b } = await twoShops(t);
  const before = [(await ops(app, admin, a)).json().errors, (await ops(app, admin, b)).json().errors];
  withTenant(a.tenant, () => reportError(new Error('a failure while serving'), { msg: 'spec.sample_error' }));
  const counted = await waitFor(async () => (await ops(app, admin, a)).json().errors === before[0] + 1, 8000);
  assert.equal(counted, true, 'the business\'s error count went up by one');
  assert.equal((await ops(app, admin, b)).json().errors, before[1]);
  reportError(new Error('a failure with no business'), { msg: 'spec.platform_error' });
  await pause(300);
  assert.equal((await ops(app, admin, a)).json().errors, before[0] + 1, 'a failure outside any business is nobody\'s');
});

test('G-14: the window: events older than it do not count, and the longest window is bounded', async (t) => {
  const { app, admin, a } = await twoShops(t);
  const q = (text, params) => (app.db.platform ?? app.db).query(text, params);
  await q(`UPDATE events SET at = now() - interval '50 hours' WHERE tenant_id = $1 AND name = $2`, [a.tenant.id, E.error.name]);
  assert.equal((await ops(app, admin, a, '?hours=24')).json().errors, 0, 'inside 24 hours: none');
  assert.equal((await ops(app, admin, a, '?hours=72')).json().errors, 3, 'inside 72 hours: all three');
  assert.equal((await ops(app, admin, a)).json().errors, 0, 'the default is a day');
  for (const bad of ['?hours=0', '?hours=-5', '?hours=721', '?hours=abc', '?hours=1.5', '?hours=1e9']) assert.equal((await ops(app, admin, a, bad)).status, 400, bad);
});

test('G-14: a business that does not exist, an id that is not an id, and an injected one answer not-found or bad request and never an error', async (t) => {
  const { app, admin } = await twoShops(t);
  for (const id of ['999999', '0', '-1', 'abc', '1%20OR%201%3D1', '1;DROP%20TABLE%20events', '99999999999999999999', '1.5']) {
    const res = await onConsole(app, admin, `/tenants/${id}/ops`);
    assert.ok([400, 404].includes(res.status), `${id} answered ${res.status}`);
  }
});

test('G-14: only platform users with a role may read it: nobody signed in, an onboarding user, a seller and a business\'s own address are all refused', async (t) => {
  const { app, admin, a, b } = await twoShops(t);
  assert.deepEqual([...platformRoutes['platform.businessOps'].platformRoles], ['super_admin', 'support']);
  assert.equal((await hit(app, `/tenants/${a.tenant.id}/ops`, { host: CONSOLE_HOST })).status, 401);
  assert.equal((await ops(app, await consoleUser(app, 'onboarding'), a)).status, 403);
  assert.equal((await ops(app, await consoleUser(app, 'support'), a)).status, 200);
  assert.equal((await ops(app, admin, a)).status, 200);
  // A seller, signed in on its own address, asks for its own and another business's numbers.
  const token = (await need(await hit(app, '/api/v1/auth/login', { host: a.host, method: 'POST', body: { phone: a.owner.phone, password: a.owner.password } }), 201, 'sign-in')).json().token;
  for (const target of [a, b]) {
    for (const host of [a.host, CONSOLE_HOST]) {
      const res = await hit(app, `/tenants/${target.tenant.id}/ops`, { host, token });
      assert.notEqual(res.status, 200, `${target.slug} on ${host} with a seller token`);
      const api = await hit(app, `/api/v1/tenants/${target.tenant.id}/ops`, { host: a.host, token });
      assert.notEqual(api.status, 200);
    }
  }
});

test('G-14: the answer holds numbers and dates only: no name, no message text, no id of anything else', async (t) => {
  const { app, admin, a } = await twoShops(t);
  const res = await ops(app, admin, a);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), Object.keys(BusinessOps.shape).sort(), 'exactly the contract\'s fields');
  assertNoneOf('the answer', res.text, ['Alpha Candles', 'ops-alpha', 'sample', 'for-a', a.owner.phone, 'dm']);
  for (const [key, value] of Object.entries(body)) assert.ok(typeof value === 'number' || key === 'since' || key === 'until', `${key} is a number or a date`);
});

test('G-14: the per-business numbers are in the console only: /metrics never shows them, and a business\'s own staff never reach them', async (t) => {
  const app = await startWorld(t, { overrides: { metricsToken: 'metrics-token-ops-spec-0123456789' } });
  const a = await addBusiness(app, { slug: 'ops-solo', name: 'Solo Shop' });
  await give(app, a, { errors: 4, calls: 4, usage: 71, queue: { depth: 31, oldest: 123 } });
  const metrics = await (await fetch(`${app.base}/metrics`, { headers: { authorization: 'Bearer metrics-token-ops-spec-0123456789' } })).text();
  assertNoneOf('/metrics', metrics, ['ops-solo', 'Solo Shop', 'ops.error', 'ops_error', 'tenant']);
  assert.equal(/^[a-z_]*ops[a-z_]*[{ ]/m.test(metrics), false, 'no metric of per-business numbers');
  const owner = await signIn(app, a);
  for (const p of [`/api/v1/tenants/${a.tenant.id}/ops`, '/api/v1/ops', '/api/v1/platform/ops']) {
    const res = await hit(app, p, { host: a.host, token: owner });
    assert.notEqual(res.status, 200, p);
  }
});

test('G-14: what an error in a business leaves in the events is classes and numbers: no person, no message text, no address', async (t) => {
  const { app, admin, a } = await twoShops(t);
  const before = (await ops(app, admin, a)).json().errors;
  withTenant(a.tenant, () => reportError(Object.assign(new Error('Asha said: call me on 9876543210'), { code: 'E_SAMPLE' }), { msg: 'spec.person_error', username: 'asha_k', path: '/r/sale?phone=9876543210', text: 'call me on 9876543210' }));
  assert.equal(await waitFor(async () => (await ops(app, admin, a)).json().errors > before, 8000), true, 'the error was counted for the business');
  const q = (text, params) => (app.db.platform ?? app.db).query(text, params);
  const rows = await q('SELECT props::text AS p FROM events WHERE tenant_id = $1', [a.tenant.id]);
  assertNoneOf('the stored events', rows.map((r) => r.p).join(' '), ['asha_k', '9876543210', 'call me', 'Asha said']);
  assertNoneOf('the console answer', (await ops(app, admin, a)).text, ['asha_k', '9876543210']);
});

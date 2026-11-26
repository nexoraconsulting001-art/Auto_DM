// Per-business operating numbers and the platform's instruments (G-04, G-05, G-14): fenced like any other business data,
// never a label at /metrics, never shown under another business, never readable by a business user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_OPS_EVENTS, BusinessOps, FORBIDDEN_LABELS, metricProblem, metricSeriesNames } from '../../../src/contracts/metrics.js';
import { businessOps } from '../../../src/modules/business-ops/index.js';
import { createOpsMetrics, readConnections } from '../../../src/modules/ops-metrics/index.js';
import { reportError, withRequestId } from '../../../src/platform/log.js';
import { withTenant } from '../../../src/tenancy.js';
import { CONSOLE_HOST, addBusiness, captureLogs, consoleUser, hit, need, onConsole, startWorld, waitFor } from '../../p0/spec-p0/support.js';

const TOKEN = 'sim-metrics-token-p9'; // secret-scan:allow made-up fixture
const scrape = async (app) => need(await hit(app, '/metrics', { token: TOKEN }), 200, '/metrics').text;
const opsOf = async (app, op, business, query = '') => need(await onConsole(app, op, `/tenants/${business.tenant.id}/ops${query}`), 200, 'ops').json();
const call = (extra = {}) => ({ method: 'POST', pathname: 'v21.0/17841/messages', channel: 'instagram', accountId: 'acct-1', status: 200, ms: 40, ...extra });

async function world(t) {
// These read and write the Postgres events and jobs tables themselves, and a shared ClickHouse or Redis would hold other tests' rows under the same small tenant ids: they run on the pg drivers, as the p1/p2/p3 suites do.
  const app = await startWorld(t, { overrides: { metricsToken: TOKEN, queueDriver: 'pg', analyticsDriver: 'pg' } });
  const a = await addBusiness(app, { slug: 'alpha', name: 'Alpha Saree House' });
  const b = await addBusiness(app, { slug: 'beta', name: 'Beta Bakes' });
  return { app, a, b, op: await consoleUser(app, 'support') };
}

test('G-14: the module is registered as business-ops, owns the one route, and has its jobs and hooks', () => {
  assert.equal(businessOps.name, 'business-ops');
  assert.deepEqual(businessOps.owns, { migrations: [], tables: [], api: [], store: [], platform: ['platform.businessOps'], jobs: [] });
  for (const hook of ['setup', 'onMetaCall', 'jobs', 'platformRoutes']) assert.equal(typeof businessOps[hook], 'function', hook);
});

test('G-14: Meta calls, errors and queue depth are written as the business and read back for that business only', async (t) => {
  const { app, a, b, op } = await world(t);
  const before = await opsOf(app, op, a);
  assert.deepEqual([before.errors, before.metaCalls, before.metaThrottled, before.metaUsagePercent, before.queueDepth], [0, 0, 0, 0, 0]);
  BusinessOps.parse(before);

  await withTenant(a.tenant, async () => {
    businessOps.onMetaCall(call({ usage: { percent: 40 } }), app.ctx);
    businessOps.onMetaCall(call({ usage: { percent: 83.4 } }), app.ctx);
    businessOps.onMetaCall(call({ status: 429, kind: 'throttled', code: 4 }), app.ctx);
    businessOps.onMetaCall(call({ status: 400, kind: 'token_invalid', code: 190 }), app.ctx);
    reportError(new Error('boom for asha@example.com'), { msg: 'orders.create_failed' });
    reportError(new Error('boom'), { msg: 'orders.create_failed' });
  });
  await withTenant(b.tenant, async () => businessOps.onMetaCall(call(), app.ctx));
  // A call with no business current (a platform-wide one) is counted at /metrics and written for nobody.
  businessOps.onMetaCall(call({ pathname: 'oauth/access_token' }), app.ctx);

  await waitFor(async () => (await opsOf(app, op, a)).metaCalls === 4 && (await opsOf(app, op, a)).errors === 2 && (await opsOf(app, op, b)).metaCalls === 1);
  const first = await opsOf(app, op, a);
  assert.deepEqual([first.errors, first.metaCalls, first.metaThrottled, first.metaUsagePercent], [2, 4, 1, 83], 'the usage is the highest, rounded');
  const second = await opsOf(app, op, b);
  assert.deepEqual([second.errors, second.metaCalls, second.metaThrottled, second.metaUsagePercent], [0, 1, 0, 0], 'nothing of the first business under the second');
  assert.equal(first.tenantId, a.tenant.id);
  assert.equal(second.tenantId, b.tenant.id);

  // The rows themselves: only the allowed properties, only classes and numbers.
  const rows = await app.db.platform.query("SELECT name, props, tenant_id FROM events WHERE name LIKE 'ops.%'");
  const allowed = Object.fromEntries(Object.values(BUSINESS_OPS_EVENTS).map((e) => [e.name, e.props]));
  assert.equal(rows.length, 9, 'four calls, two usage readings and two errors for the first business, one call for the second');
  for (const row of rows) {
    assert.ok(Object.keys(row.props).every((k) => allowed[row.name].includes(k)), `${row.name} carries ${Object.keys(row.props)}`);
    assert.ok(Object.values(row.props).every((v) => typeof v === 'number' || /^[a-z_]{1,30}$/.test(v)), JSON.stringify(row.props));
  }
  assert.doesNotMatch(JSON.stringify(rows), /asha|example\.com|boom/);
  // Another business's connection cannot see them, even naming the other business.
  const seen = await withTenant(b.tenant, () => app.db.query("SELECT count(*)::int AS n FROM events WHERE tenant_id = $1 AND name LIKE 'ops.%'", [a.tenant.id]));
  assert.equal(seen[0].n, 0);
});

test('G-14: the window is the hours asked for, and 0 or more than 30 days is refused', async (t) => {
  const { app, a, op } = await world(t);
  await app.db.platform.query("INSERT INTO events (tenant_id, name, props, at) VALUES ($1, 'ops.error', $2, now() - interval '48 hours'), ($1, 'ops.error', $2, now() - interval '1 hour')", [a.tenant.id, JSON.stringify({ service: 'web', kind: 'x' })]);
  assert.equal((await opsOf(app, op, a)).errors, 1);
  assert.equal((await opsOf(app, op, a, '?hours=72')).errors, 2);
  const result = await opsOf(app, op, a, '?hours=1');
  assert.equal(+new Date(result.until) - +new Date(result.since), 3_600_000);
  for (const hours of [0, 721, 'x']) assert.equal((await onConsole(app, op, `/tenants/${a.tenant.id}/ops?hours=${hours}`)).status, 400, String(hours));
  assert.equal((await onConsole(app, op, '/tenants/999999/ops')).status, 404);
  assert.equal((await onConsole(app, op, '/tenants/abc/ops')).status, 404);
});

test('G-14: who may read: support and super admin signed in, no other platform role, nobody signed out, and a business user never', async (t) => {
  const { app, a, b } = await world(t);
  assert.equal((await hit(app, `/tenants/${a.tenant.id}/ops`, { host: CONSOLE_HOST })).status, 401, 'nobody signed in');
  for (const [role, status] of [['super_admin', 200], ['support', 200], ['onboarding', 403], ['service_operator', 403]]) {
    assert.equal((await onConsole(app, await consoleUser(app, role), `/tenants/${a.tenant.id}/ops`)).status, status, role);
  }
  // A business's own address, with its owner signed in, has no such route.
  const owner = need(await hit(app, '/api/v1/auth/login', { host: a.host, method: 'POST', body: { phone: a.owner.phone, password: a.owner.password } }), 201, 'sign in').json().token;
  for (const path of [`/tenants/${a.tenant.id}/ops`, `/tenants/${b.tenant.id}/ops`, `/api/v1/tenants/${a.tenant.id}/ops`, '/api/v1/ops', '/api/v1/analytics/ops.error']) {
    const res = await hit(app, path, { host: a.host, token: owner });
    assert.ok(res.status >= 400, `${path} gave ${res.status}`);
    assert.doesNotMatch(res.text, /metaCalls|queueDepth/);
  }
  assert.notEqual((await hit(app, `/tenants/${a.tenant.id}/ops`, { host: a.host })).status, 200);
});

test('G-14: the queue depth of each business is sampled for the businesses that have jobs, and a cleared queue shows as cleared', async (t) => {
  const { app, a, b, op } = await world(t);
  const ops = createOpsMetrics(app.ctx);
  const { queue } = app.ctx.platform;
  await queue.enqueue('dm.send', {}, { tenantId: a.tenant.id });
  await queue.enqueue('dm.send', {}, { tenantId: a.tenant.id });
  await queue.enqueue('platform.sweep', {}, { tenantId: null });
  await app.db.platform.query("UPDATE jobs SET run_at = now() - interval '90 seconds' WHERE tenant_id = $1", [a.tenant.id]);
  assert.equal(await ops.sampleQueues(), 1, 'one business has jobs waiting; the platform job belongs to none');
  const busy = await opsOf(app, op, a);
  assert.equal(busy.queueDepth, 2);
  assert.ok(busy.queueOldestSeconds >= 89 && busy.queueOldestSeconds < 600, String(busy.queueOldestSeconds));
  assert.equal((await opsOf(app, op, b)).queueDepth, 0, 'nothing for the other business');
  await app.db.platform.query("UPDATE jobs SET status = 'done' WHERE tenant_id = $1", [a.tenant.id]);
  assert.equal(await ops.sampleQueues(), 0);
  const cleared = await opsOf(app, op, a);
  assert.deepEqual([cleared.queueDepth, cleared.queueOldestSeconds], [0, 0]);
  assert.equal(await ops.sampleQueues(), 0);
  const samples = await app.db.platform.query("SELECT count(*)::int AS n FROM events WHERE name = 'ops.queue_depth'");
  assert.equal(samples[0].n, 2, 'a business with nothing waiting is not written to again');
});

test('R3-OP2-2: the pg queue waitingByTenant() is the ready jobs per business, which the sample reads from the queue in use', async (t) => {
  const { app, a, b } = await world(t);
  const { queue } = app.ctx.platform;
  assert.equal(queue.driver, 'pg');
  await queue.enqueue('dm.send', {}, { tenantId: a.tenant.id });
  await queue.enqueue('notify', {}, { tenantId: a.tenant.id });
  await queue.enqueue('dm.send', {}, { tenantId: b.tenant.id });
  await queue.enqueue('dm.send', {}, { tenantId: b.tenant.id, delayMs: 60_000 });
  await queue.enqueue('platform.sweep', {}, { tenantId: null });
  await app.db.platform.query("UPDATE jobs SET run_at = now() - interval '120 seconds' WHERE tenant_id = $1", [a.tenant.id]);
  const rows = await queue.waitingByTenant();
  const ids = [a.tenant.id, b.tenant.id].map(Number);
  assert.deepEqual(rows.map((r) => [r.tenantId, r.depth]), [[ids[0], 2], [ids[1], 1]].sort((x, y) => x[0] - y[0]), 'across queues, delayed and platform jobs left out');
  assert.ok(rows.find((r) => r.tenantId === ids[0]).oldestSeconds >= 119);
  // The sample asks the queue, not the jobs table: a queue that reports nothing waiting writes nothing, whatever the table holds.
  const tracked = [];
  const ops = createOpsMetrics({ ...app.ctx, platform: { ...app.ctx.platform, queue: { ...queue, waitingByTenant: async () => [] }, analytics: { track: async (...args) => tracked.push(args) } } });
  assert.equal(await ops.sampleQueues(), 0);
  assert.deepEqual(tracked, []);
});

test('G-04: the platform instruments at /metrics: calls by class, usage, errors by kind, jobs, queue age and businesses by plan, with nothing about one business', async (t) => {
  const { app, a } = await world(t);
  withTenant(a.tenant, () => {
    businessOps.onMetaCall(call({ usage: { percent: 91 } }), app.ctx);
    businessOps.onMetaCall(call({ status: 429, kind: 'throttled', usage: { percent: 97 } }), app.ctx);
    reportError(new Error('token=abc123 failed'), { msg: 'billing.charge_failed' });
  });
  await app.ctx.platform.queue.enqueue('dm.send', {}, { tenantId: a.tenant.id });
  await app.db.platform.query("UPDATE jobs SET run_at = now() - interval '120 seconds' WHERE queue = 'dm.send'");
  await app.ctx.platform.queue.drain('dm.send', async () => {});
  await app.ctx.platform.queue.enqueue('dm.send', {}, { tenantId: a.tenant.id, maxAttempts: 1 });
  await app.ctx.platform.queue.drain('dm.send', async () => {
    throw new Error('send failed');
  });
  const text = await scrape(app);
  assert.match(text, /meta_calls_total\{call_class="send",result="ok"\} 1/);
  assert.match(text, /meta_calls_total\{call_class="send",result="throttled"\} 1/);
  assert.match(text, /meta_usage_ratio\{call_class="send"\} 0.97/);
  assert.match(text, /errors_reported_total\{service="web",kind="billing"\} 1/);
  assert.match(text, /job_runs_total\{queue="dm.send",result="ok"\} 1/);
  assert.match(text, /job_runs_total\{queue="dm.send",result="failed"\} 1/);
  assert.match(text, /job_failures_total\{queue="dm.send"\} 1/);
  assert.match(text, /process_draining\{service="web"\} 0/);
  assert.match(text, /businesses\{plan="t3",state="active"\} 2/);
  assert.match(text, /http_requests_in_flight\{service="web"\}/);

  // Every series is in the catalogue with labels it allows; no label is a forbidden name; no business shows anywhere.
  const names = metricSeriesNames();
  for (const line of text.split('\n').filter((l) => l && !l.startsWith('#'))) {
    const [, name, raw = ''] = /^([a-z_]+)(\{.*\})? /.exec(line);
    assert.ok(names.has(name), `${name} is not in the catalogue`);
    const labels = Object.fromEntries([...raw.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    delete labels.le;
    const base = name.replace(/_(bucket|sum|count)$/, '');
    assert.equal(metricProblem(base in labels ? name : base, labels), null, line);
    assert.ok(Object.keys(labels).every((k) => !FORBIDDEN_LABELS.includes(k)), line);
  }
  assert.doesNotMatch(text, /alpha|beta|Saree|Bakes|abc123|asha/i);
  assert.deepEqual(app.ctx.platform.metrics.rejected(), [], 'nothing in this world wrote outside the catalogue');
});

test('G-04: connections are read as pool and state from the database, and a database that cannot answer leaves the gauge out', async () => {
  const asked = [];
  const db = {
    platform: {
      query: async (sql) => {
        asked.push(sql);
        if (/current_user/.test(sql)) return [{ me: 'owner_login' }];
        return [{ usename: 'owner_login', state: 'idle', n: 2 }, { usename: 'owner_login', state: 'active', n: 1 }, { usename: 'bhava_app', state: 'idle', n: 5 }, { usename: 'bhava_app', state: 'idle in transaction', n: 1 }, { usename: 'bhava_app', state: 'active', n: 3 }];
      },
    },
  };
  const rows = await readConnections(db);
  const text = rows.map((r) => `${r.labels.pool}/${r.labels.state}=${r.value}`).sort().join(' ');
  assert.equal(text, 'app/idle=5 app/used=4 owner/idle=2 owner/used=1');
  assert.ok(rows.every((r) => metricProblem('db_pool_connections', r.labels) === null));
  assert.ok(asked.every((sql) => !/query|usename.*=.*'/.test(sql.replace('usename, state', ''))), 'no statement text is read');
});

test('G-04: logs and error reports carry the request id and business id, and never message text, usernames, phones, tokens or keys', async (t) => {
  const { app, a } = await world(t);
  const logs = captureLogs(t);
  const sent = [];
  const { createErrorSink } = await import('../../../src/platform/error-sink.js');
  const sink = createErrorSink({ errorSink: 'http', errorSinkUrl: 'http://sink.test/events', errorSinkToken: 'tok' }, { fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  const { onError } = await import('../../../src/platform/log.js');
  onError(sink.report);
  await withRequestId('req-observe-0001', () => withTenant(a.tenant, async () => {
    const { log } = await import('../../../src/platform/log.js');
    log.info('dm.sent', { username: 'asha_k', text: 'Hi, call me on 9876543210', phone: '9876543210', accessToken: 'EAAGsecretsecretsecret', headers: { authorization: 'Bearer abc.def.ghi', host: 'x' }, count: 2 });
    reportError(new Error('reply to +91 98765 43210 failed with Bearer abc.def.ghi and token=EAAGsecretsecretsecret'), { msg: 'dm.reply_failed', username: 'asha_k', detail: { text: 'price please', note: 'call 9876543210' } });
  }));
  await sink.flush();
  const text = logs.text();
  assert.match(text, /"requestId":"req-observe-0001"/);
  assert.match(text, new RegExp(`"tenantId":${a.tenant.id}`));
  assert.match(text, /"count":2/);
  assert.doesNotMatch(text, /asha_k|price please|9876543210|98765 43210|EAAGsecret|abc\.def\.ghi/);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].requestId, sent[0].tenantId, sent[0].event], ['req-observe-0001', a.tenant.id, 'dm.reply_failed']);
  assert.doesNotMatch(JSON.stringify(sent), /asha_k|price please|9876543210|98765|abc\.def\.ghi|tok/);
});

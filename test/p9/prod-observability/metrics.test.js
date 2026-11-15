// Metrics (PRD 11 availability and observability; G-04 to G-07): the catalogue is enforced where metrics are written,
// no label can grow without bound, and /metrics answers only with its token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { FORBIDDEN_LABELS, METRICS, metricProblem } from '../../../src/contracts/metrics.js';
import { createMetrics, errorKind, instrumentQueue, metaCallClass, metaCallResult, webhookProviderOf, webhookResultOf } from '../../../src/platform/metrics.js';

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, () => resolve({ server, port: server.address().port }));
});
const get = (port, path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
    let text = '';
    res.on('data', (c) => (text += c));
    res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
  });
  req.on('error', reject);
  req.end();
});

test('G-06: a metric the catalogue does not have, a forbidden label, a value outside its set or the wrong type is refused, and strict mode throws', async () => {
  const strict = createMetrics({ strict: true });
  assert.throws(() => strict.inc('made_up_total'), /not in the catalogue/);
  for (const label of ['tenant_id', 'business', 'username', 'phone', 'path', 'url', 'text', 'request_id', 'ip']) {
    assert.ok(FORBIDDEN_LABELS.includes(label));
    assert.throws(() => strict.inc('http_requests_total', { method: 'GET', group: 'home', status: '200', [label]: 'x' }), new RegExp(`label ${label}`), label);
  }
  assert.throws(() => strict.inc('http_requests_total', { method: 'GET', group: '/orders/12345', status: '200' }), /outside its set/, 'a path with an id');
  assert.throws(() => strict.inc('http_requests_total', { method: 'GET', group: 'home', status: 'OK' }), /outside its set/);
  assert.throws(() => strict.inc('http_request_seconds', { group: 'home' }), /histogram, not a counter/);
  assert.throws(() => strict.observe('http_requests_total', 1, { method: 'GET', group: 'home', status: '200' }), /counter, not a histogram/);
  assert.throws(() => strict.gauge('http_requests_total', () => []), /counter, not a gauge/);

  const lax = createMetrics();
  lax.inc('made_up_total', { result: 'sent' });
  lax.inc('made_up_total', { phone: '9876543210' });
  lax.inc('made_up_total', { note: 'x'.repeat(41) });
  lax.inc('http_requests_total', { method: 'GET', group: 'home', status: '200', phone: '9876543210' });
  lax.inc('http_requests_total', { method: 'GET', group: 'home', status: '200' });
  assert.deepEqual(lax.rejected().map((r) => r.why).sort(), ['http_requests_total has the label phone', 'made_up_total has the label note', 'made_up_total has the label phone'],
    'outside strict mode a name the catalogue lacks is written (code is checked by the contract test), but never with a forbidden label or a long value');
  assert.match(await lax.render(), /made_up_total\{result="sent"\} 1/);
});

test('G-06: a metric has at most maxSeries label combinations, so nothing grows without bound', async () => {
  const metrics = createMetrics({ maxSeries: 5 });
  for (let i = 0; i < 40; i++) metrics.inc('job_runs_total', { queue: `q${i}`, result: 'ok' });
  const text = await metrics.render();
  assert.equal(text.split('\n').filter((l) => l.startsWith('job_runs_total{')).length, 5);
  assert.ok(metrics.rejected().some((r) => /series limit/.test(r.why) && r.count === 35));
  metrics.inc('job_runs_total', { queue: 'q0', result: 'ok' });
  assert.match(await metrics.render(), /job_runs_total\{queue="q0",result="ok"\} 2/, 'a series that exists still counts');
});

test('every label of every metric is bounded: a fixed list, or a pattern with a ceiling, and none is a forbidden name', () => {
  for (const [name, def] of Object.entries(METRICS)) {
    for (const label of def.labels) {
      assert.ok(!FORBIDDEN_LABELS.includes(label), `${name} has ${label}`);
      assert.equal(metricProblem(name, { [label]: 'x'.repeat(200) }) !== null, true, `${name}.${label} takes a 200 character value`);
    }
  }
});

test('G-04: render writes HELP and TYPE once per metric, a histogram with its buckets, and drops a gauge row that breaks the catalogue or is not a number', async () => {
  const metrics = createMetrics({ service: 'worker' });
  metrics.inc('http_requests_total', { method: 'GET', group: 'store', status: '200' }, 3);
  metrics.observe('http_request_seconds', 0.2, { group: 'store' });
  metrics.gauge('queue_jobs', () => [
    { labels: { queue: 'dm', status: 'queued' }, value: 4 },
    { labels: { queue: 'dm', status: 'bogus' }, value: 1 },
    { labels: { queue: 'dm', status: 'failed' }, value: Number.NaN },
  ]);
  metrics.gauge('queue_oldest_job_seconds', () => {
    throw new Error('the database is down');
  });
  const text = await metrics.render();
  assert.equal(text.match(/# TYPE http_requests_total counter/g).length, 1);
  assert.match(text, /# HELP http_requests_total Requests answered/);
  assert.match(text, /http_requests_total\{method="GET",group="store",status="200"\} 3/);
  assert.match(text, /http_request_seconds_bucket\{group="store",le="0.25"\} 1/);
  assert.match(text, /http_request_seconds_bucket\{group="store",le="\+Inf"\} 1/);
  assert.match(text, /queue_jobs\{queue="dm",status="queued"\} 4/);
  assert.doesNotMatch(text, /bogus|NaN|queue_oldest_job_seconds/);
  assert.match(text, /http_requests_in_flight\{service="worker"\} 0/);
});

test('G-05: backup_age_seconds follows backup_last_success_seconds', async () => {
  let clock = 1_700_000_000_000;
  const metrics = createMetrics({ now: () => clock });
  metrics.gauge('backup_last_success_seconds', () => [{ labels: {}, value: 1_700_000_000 - 600 }]);
  assert.match(await metrics.render(), /backup_age_seconds 600\n/);
  clock += 3_600_000;
  assert.match(await metrics.render(), /backup_age_seconds 4200\n/);
});

test('G-04: the middleware counts requests by class and status, webhooks by provider and outcome, and requests in flight, with no path or id in a label', async (t) => {
  const metrics = createMetrics({ strict: true });
  const app = express();
  app.use(metrics.middleware());
  let release;
  const hold = new Promise((resolve) => (release = resolve));
  app.post('/webhook', (req, res) => res.sendStatus(req.get('x-case') === 'bad' ? 403 : req.get('x-case') === 'fault' ? 500 : 200));
  app.post('/webhooks/razorpay/:key', (_req, res) => res.sendStatus(200));
  app.post('/webhooks/billing/razorpay', (_req, res) => res.sendStatus(400));
  app.post('/webhooks/courier', (_req, res) => res.sendStatus(503));
  app.get('/orders/:id', (_req, res) => res.sendStatus(404));
  app.get('/slow', async (_req, res) => {
    await hold;
    res.send('ok');
  });
  const { server, port } = await listen(app);
  t.after(() => server.close());

  await get(port, '/webhook', { method: 'POST' });
  await get(port, '/webhook', { method: 'POST', headers: { 'x-case': 'bad' } });
  await get(port, '/webhook', { method: 'POST', headers: { 'x-case': 'fault' } });
  await get(port, '/webhooks/razorpay/key_abc123def', { method: 'POST' });
  await get(port, '/webhooks/billing/razorpay', { method: 'POST' });
  await get(port, '/webhooks/courier', { method: 'POST' });
  await get(port, '/orders/9876543210');
  await get(port, '/webhook');
  const pending = get(port, '/slow');
  await new Promise((r) => setTimeout(r, 100));
  const during = await metrics.render();
  assert.match(during, /http_requests_in_flight\{service="web"\} 1/);
  release();
  await pending;
  const text = await metrics.render();
  assert.match(text, /http_requests_in_flight\{service="web"\} 0/);
  for (const [labels, n] of [
    ['provider="meta",result="accepted"', 1], ['provider="meta",result="bad_signature"', 1], ['provider="meta",result="refused"', 1],
    ['provider="razorpay",result="accepted"', 1], ['provider="razorpay_billing",result="bad_signature"', 1], ['provider="shiprocket",result="refused"', 1],
  ]) assert.match(text, new RegExp(`webhook_received_total\\{${labels}\\} ${n}`), labels);
  assert.doesNotMatch(text, /9876543210|key_abc123def/, 'no id from a path reaches a label');
  assert.match(text, /http_requests_total\{method="GET",group="orders",status="404"\} 1/);
  assert.equal(webhookProviderOf('GET', '/webhook'), null, 'the verification handshake is not a delivery');
  assert.equal(webhookProviderOf('POST', '/webhooks/unknown'), null);
  assert.deepEqual([200, 202, 400, 401, 403, 404, 500, 503].map(webhookResultOf), ['accepted', 'accepted', 'bad_signature', 'bad_signature', 'bad_signature', 'refused', 'refused', 'refused']);
});

test('G-04: /metrics answers only with its token, and not at all when none is set', async (t) => {
  const metrics = createMetrics();
  metrics.inc('process_draining'.replace('process_draining', 'secret_refresh_failures_total'));
  const secured = express();
  secured.get('/metrics', metrics.handler('sim-metrics-token-1'));
  const open = express();
  open.get('/metrics', metrics.handler(''));
  const a = await listen(secured);
  const b = await listen(open);
  t.after(() => {
    a.server.close();
    b.server.close();
  });
  assert.equal((await get(a.port, '/metrics')).status, 404);
  assert.equal((await get(a.port, '/metrics', { headers: { authorization: 'Bearer wrong' } })).status, 404);
  assert.equal((await get(a.port, '/metrics', { headers: { authorization: 'Bearer sim-metrics-token-1x' } })).status, 404, 'a longer token');
  assert.equal((await get(a.port, '/metrics', { headers: { authorization: 'sim-metrics-token-1' } })).status, 404, 'no Bearer');
  const ok = await get(a.port, '/metrics', { headers: { authorization: 'Bearer sim-metrics-token-1' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /text\/plain/);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.match(ok.text, /secret_refresh_failures_total 1/);
  assert.equal((await get(b.port, '/metrics', { headers: { authorization: 'Bearer ' } })).status, 404, 'an empty token is not a token');
});

test('G-04: Meta calls are classed by what they did and how they ended, and a log entry name becomes a bounded kind', () => {
  assert.deepEqual([
    { method: 'POST', pathname: 'v21.0/17841/messages' }, { method: 'GET', pathname: 'v21.0/1784/insights' }, { method: 'GET', pathname: 'oauth/access_token' },
    { method: 'GET', pathname: 'v21.0/refresh_access_token' }, { method: 'POST', pathname: '1784/subscribed_apps' }, { method: 'POST', pathname: '1784/media_publish' },
    { method: 'GET', pathname: '1784' }, { method: 'DELETE', pathname: '1784' },
  ].map(metaCallClass), ['send', 'insights', 'token', 'token', 'subscribe', 'media', 'read', 'other']);
  assert.deepEqual([
    { status: 200 }, { status: 429, kind: 'throttled' }, { status: 400, kind: 'buc_throttled' }, { status: 400, kind: 'token_invalid' }, { status: 0, kind: 'timeout' },
    { status: 0, kind: 'network' }, { status: 400, kind: 'validation' }, { status: 500, kind: 'server_error' },
  ].map(metaCallResult), ['ok', 'throttled', 'throttled', 'token_error', 'timeout', 'timeout', 'error', 'error']);
  for (const call of [{ method: 'GET', pathname: 'x' }]) assert.equal(metricProblem('meta_calls_total', { call_class: metaCallClass(call), result: metaCallResult({ status: 200 }) }), null);
  assert.equal(errorKind('tenant_health.sweep_failed'), 'tenant_health');
  assert.equal(errorKind('Hello World! +91 98765 43210'), 'hello_world_91_98765_43210'.slice(0, 30));
  assert.equal(errorKind(undefined), 'error');
  assert.equal(errorKind('9bad'), 'error');
  assert.equal(metricProblem('errors_reported_total', { service: 'web', kind: errorKind('x'.repeat(100)) }), null);
});

test('G-04: the queue is counted by wrapping drain: runs by result and failures, once however often it is wrapped', async () => {
  const metrics = createMetrics({ strict: true });
  const queue = { drain: async (name, handler) => { for (const job of [{ id: 1 }, { id: 2 }]) await handler(job).catch(() => {}); return 2; } };
  assert.equal(instrumentQueue(metrics, queue), true);
  assert.equal(instrumentQueue(metrics, queue), false);
  assert.equal(instrumentQueue(metrics, {}), false);
  let n = 0;
  await queue.drain('dm.send', async () => {
    if (++n === 2) throw new Error('send failed for someone@example.com');
  });
  const text = await metrics.render();
  assert.match(text, /job_runs_total\{queue="dm.send",result="ok"\} 1/);
  assert.match(text, /job_runs_total\{queue="dm.send",result="failed"\} 1/);
  assert.match(text, /job_failures_total\{queue="dm.send"\} 1/);
  assert.doesNotMatch(text, /example\.com/);
});

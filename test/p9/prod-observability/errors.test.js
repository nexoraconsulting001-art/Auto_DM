// Error reports (G-05): from reportError through the sink's http driver to a tracker, carrying the request id and the business id
// and nothing a person wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_EVENT_FIELDS, ErrorEvent } from '../../../src/contracts/metrics.js';
import { createErrorSink } from '../../../src/platform/error-sink.js';
import { onError, reportError, setLogSink, withRequestId } from '../../../src/platform/log.js';
import { withTenant } from '../../../src/tenancy.js';
import { createErrorTracker } from '../../../tools/sim/errors/index.mjs';

const quiet = (t) => {
  setLogSink(() => {});
  t.after(() => setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)));
};

test('G-05: an error reported inside a request reaches the tracker with its request id and business id, and no message, name, phone or token', async (t) => {
  quiet(t);
  const tracker = createErrorTracker({ token: 'sim-errors-token' });
  await tracker.start();
  t.after(() => tracker.close());
  const sink = createErrorSink({ errorSink: 'http', errorSinkUrl: `${tracker.url}/events`, errorSinkToken: 'sim-errors-token', release: 'rel-1' }, { service: 'web' });
  onError(sink.report);

  const err = Object.assign(new RangeError('Asha (+91 98765 43210) wrote "send the red saree" with token=EAAGsecret1234567890'), { code: 'E_SAMPLE' }); // secret-scan:allow made-up fixture
  await withRequestId('req-obs-000001', () => withTenant({ id: 41, slug: 'alpha' }, async () => {
    reportError(err, { msg: 'dm.reply_failed', username: 'asha_k', text: 'send the red saree', route: 'inbox.reply', path: '/api/v1/inbox/9876543210' });
  }));
  await sink.flush();
  const { events } = await tracker.get('/events');
  assert.equal(events.length, 1);
  const { id, ...event } = events[0];
  assert.ok(id);
  assert.deepEqual(Object.keys(event), [...ERROR_EVENT_FIELDS]);
  ErrorEvent.parse(event);
  assert.deepEqual([event.requestId, event.tenantId, event.event, event.errorClass, event.code, event.route, event.service, event.release], ['req-obs-000001', 41, 'dm.reply_failed', 'RangeError', 'E_SAMPLE', 'inbox.reply', 'web', 'rel-1']);
  assert.doesNotMatch(JSON.stringify(event), /Asha|asha_k|red saree|98765|9876543210|EAAG|alpha|\/api\/v1/);
  assert.deepEqual(sink.stats(), { sent: 1, failed: 0, dropped: 0 });
});

test('G-05: an error with no business current is reported with no business, and a tracker that refuses, fails or is gone is counted and never thrown', async (t) => {
  quiet(t);
  const tracker = createErrorTracker({ token: 'sim-errors-token' });
  await tracker.start();
  t.after(() => tracker.close());
  const url = `${tracker.url}/events`;
  const good = createErrorSink({ errorSink: 'http', errorSinkUrl: url, errorSinkToken: 'sim-errors-token' }, { service: 'worker' });
  const wrongToken = createErrorSink({ errorSink: 'http', errorSinkUrl: url, errorSinkToken: 'not-it' });
  const gone = createErrorSink({ errorSink: 'http', errorSinkUrl: 'http://127.0.0.1:9/events', errorSinkTimeoutMs: 300 });
  const sinks = [good, wrongToken, gone];
  const hooks = sinks.map((s) => (err, context) => s.report(err, context));
  hooks.forEach(onError);
  reportError(new Error('x'), { msg: 'queue.poll_failed' });
  await Promise.all(sinks.map((s) => s.flush()));
  assert.equal(good.stats().sent, 1);
  assert.equal(wrongToken.stats().failed, 1);
  assert.equal(gone.stats().failed, 1);
  const { events } = await tracker.get('/events');
  assert.deepEqual([events.length, events[0].tenantId, events[0].requestId, events[0].service], [1, null, null, 'worker']);

  await tracker.post('/faults', { kind: 'server_error', times: 1 });
  reportError(new Error('y'), { msg: 'queue.poll_failed' });
  await good.flush();
  assert.equal(good.stats().failed, 1, 'a 500 from the tracker is a failure, counted');
});

test('G-05: the tracker refuses a document with a field outside the contract, so a report that leaks a message fails a test', async (t) => {
  const tracker = createErrorTracker({ token: 'sim-errors-token' });
  await tracker.start();
  t.after(() => tracker.close());
  const post = (body, token = 'sim-errors-token') => fetch(`${tracker.url}/events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await post({ time: 'now' }, 'wrong')).status, 401);
  assert.equal((await post({ time: 'now', message: 'Asha called 9876543210' })).status, 422);
  assert.equal((await post([1])).status, 422);
  assert.equal((await post({ time: 'now' })).status, 202);
});

test('G-05: a flood is bounded: at most twenty reports in flight, the rest dropped and counted, and the process is never slowed', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const sink = createErrorSink({ errorSink: 'http', errorSinkUrl: 'http://tracker.test/events' }, { fetch: async () => { await gate; return { ok: true }; } });
  const started = Date.now();
  for (let i = 0; i < 100; i++) sink.report(new Error('x'), { msg: 'orders.create_failed' });
  assert.ok(Date.now() - started < 500, 'reporting does not wait for the tracker');
  assert.equal(sink.stats().dropped, 80);
  release();
  await sink.flush();
  assert.equal(sink.stats().sent, 20);
});

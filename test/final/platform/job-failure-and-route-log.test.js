// platform-6: a throwing job is reported (log + error tracker). platform-8: error logs never carry buyer tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { onError } from '../../../src/platform/log.js';
import { createQueue } from '../../../src/platform/queue.js';
import { sendApiError } from '../../../src/modules/api-v1/respond.js';

function capture() {
  const seen = [];
  onError((err, ctx) => seen.push({ err, ctx }));
  return seen;
}

/** A pg queue whose table hands out one job once, on the given attempt of two. */
function pgQueueWithOneJob(attempts) {
  let claimed = false;
  const rows = [{ id: 1, tenant_id: null, payload: {}, attempts, max_attempts: 2 }];
  const db = { query: async (sql) => (/SET status = 'running'/.test(sql) && !claimed ? ((claimed = true), rows) : []) };
  return createQueue({ queueDriver: 'pg' }, { db });
}

test('platform-6: the pg drain reports a job that throws on its last attempt, with queue, attempt and final', async () => {
  const seen = capture();
  await pgQueueWithOneJob(2).drain('system.backup', async () => { throw new Error('disk full'); });
  const hits = seen.filter((s) => s.ctx.msg === 'job.failed' && s.ctx.queue === 'system.backup');
  assert.equal(hits.length, 1, 'reported once');
  assert.equal(hits[0].ctx.attempt, 2);
  assert.equal(hits[0].ctx.final, true);
  assert.equal(hits[0].err.message, 'disk full');
});

test('platform-6: a pg job that will be retried is reported as not final', async () => {
  const seen = capture();
  await pgQueueWithOneJob(1).drain('q-retry', async () => { throw new Error('x'); });
  const hit = seen.find((s) => s.ctx.msg === 'job.failed' && s.ctx.queue === 'q-retry');
  assert.ok(hit, 'reportError was called');
  assert.deepEqual([hit.ctx.attempt, hit.ctx.final], [1, false]);
});

test('platform-8: an error under a buyer route is logged with the route pattern, never the token', async () => {
  const { routeOf } = await import('../../../src/platform/log.js');
  const app = express();
  const store = express.Router();
  const api = express.Router();
  store.get('/order/:token', () => { throw new Error('x'); });
  api.get('/orders/:id', async () => { throw new Error('y'); });
  app.use(store);
  app.use('/api/v1', api);
  app.use((_req, _res, next) => next(new Error('no route')));
  const got = [];
  app.use((err, req, res, _next) => { got.push(routeOf(req)); res.status(500).end(); });
  const server = app.listen(0);
  try {
    for (const url of ['/order/SECRETTOKEN123', '/api/v1/orders/SECRETTOKEN456', '/track/SECRETTOKEN789']) await fetch(`http://127.0.0.1:${server.address().port}${url}`);
  } finally { server.close(); }
  assert.deepEqual(got, ['/order/:token', '/orders/:id', '/track/*']);
  assert.ok(!routeOf({ path: '/9f8a7b6c5d4e3f/x' }).includes('9f8a'));
});

test('platform-8: the api error path logs no token', () => {
  const seen = capture();
  const res = { headersSent: false, status() { return this; }, json() { return this; }, set() { return this; } };
  sendApiError(new Error('boom'), { method: 'GET', path: '/cart/restore/SECRETTOKEN123' }, res);
  const ctx = seen.findLast((s) => s.ctx.msg === 'http.error').ctx;
  assert.ok(!JSON.stringify(ctx).includes('SECRETTOKEN123'));
});

test('platform-8: nothing in src logs or reports a request\'s concrete path or URL', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  const offenders = [];
  for (const file of walk('src')) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\b(reportError|log\.(info|warn|error|debug))\(/.test(line) && /\breq\.(path|url|originalUrl)\b/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

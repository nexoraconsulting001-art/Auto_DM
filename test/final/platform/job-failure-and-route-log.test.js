// platform-6: a throwing job is reported (log + error tracker). platform-8: error logs never carry buyer tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { onError, routeOf } from '../../../src/platform/log.js';
import { createQueue, reportJobFailure } from '../../../src/platform/queue.js';
import { sendApiError } from '../../../src/modules/api-v1/respond.js';

function capture() {
  const seen = [];
  onError((err, ctx) => seen.push({ err, ctx }));
  return seen;
}

test('platform-6: the pg drain reports a job that throws, with queue, attempt and final', async () => {
  const seen = capture();
  const rows = [{ id: 1, tenant_id: null, payload: {}, attempts: 2, max_attempts: 2 }];
  let claimed = false;
  const db = {
    async query(sql) {
      if (/SET status = 'running'/.test(sql) && !claimed) { claimed = true; return rows; }
      return [];
    },
  };
  const q = createQueue({ queueDriver: 'pg' }, { db });
  await q.drain('backup', async () => { throw new Error('disk full'); });
  const hit = seen.find((s) => s.ctx.msg === 'job.failed');
  assert.ok(hit, 'reportError was called');
  assert.equal(hit.ctx.queue, 'backup');
  assert.equal(hit.ctx.attempt, 2);
  assert.equal(hit.ctx.final, true);
});

test('platform-6: reportJobFailure marks a retryable failure as not final', () => {
  const seen = capture();
  reportJobFailure(new Error('x'), { queue: 'q-retry', attempt: 1, maxAttempts: 5 });
  assert.equal(seen.findLast((s) => s.ctx.queue === 'q-retry').ctx.final, false);
});

test('platform-8: routeOf gives the route pattern, never the token', async () => {
  const app = express();
  let got;
  app.get('/order/:token', (req, res) => { got = routeOf(req); res.end(); });
  const server = app.listen(0);
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/order/SECRETTOKEN123`);
  } finally { server.close(); }
  assert.equal(got, '/order/:token');
  assert.equal(routeOf({ path: '/track/SECRETTOKEN123' }), '/track/*');
  assert.ok(!routeOf({ path: '/9f8a7b6c5d4e3f/x' }).includes('9f8a'));
});

test('platform-8: the api error path logs no token', () => {
  const seen = capture();
  const res = { headersSent: false, status() { return this; }, json() { return this; }, set() { return this; } };
  sendApiError(new Error('boom'), { method: 'GET', path: '/cart/restore/SECRETTOKEN123' }, res);
  const ctx = seen.findLast((s) => s.ctx.msg === 'http.error').ctx;
  assert.ok(!JSON.stringify(ctx.path).includes('SECRETTOKEN123'));
});

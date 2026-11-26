// platform-5: on the Redis queue (production) the job counters, queue depth and queue age must read the real queues.
// Redis is not available here, so BullMQ and the Redis client are stand-ins with the same calls the driver makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { metricProblem } from '../../../src/contracts/metrics.js';
import { createOpsMetrics } from '../../../src/modules/ops-metrics/index.js';
import { onError } from '../../../src/platform/log.js';
import { createMetrics, instrumentQueue } from '../../../src/platform/metrics.js';
import { createQueue } from '../../../src/platform/queue.js';

const REDIS = { queueDriver: 'redis', redisUrl: 'redis://127.0.0.1:1' };

/** BullMQ as the driver uses it: Queue counts and lists, Worker hands its processor over so the test can run a job. */
function fakeBullmq(state) {
  class UnrecoverableError extends Error {
    constructor(message) { super(message); this.name = 'UnrecoverableError'; }
  }
  class Queue {
    constructor(name) { this.name = name; state.queues[name] ??= { waiting: [], delayed: 0, active: 0, failed: [] }; }
    get s() { return state.queues[this.name]; }
    get client() { return Promise.resolve({ set: async () => 'OK' }); }
    async add(_name, data, opts) { const job = { id: String(this.s.waiting.length + 1), data, opts, timestamp: Date.now() }; this.s.waiting.unshift(job); return job; }
    async getJobCounts() { return { waiting: this.s.waiting.length, delayed: this.s.delayed, active: this.s.active, failed: this.s.failed.length }; }
    async getFailed() { return this.s.failed; }
    async getWaiting(start, end) { return [...this.s.waiting].reverse().slice(start, end + 1); } // oldest first, as BullMQ's asc list
    async close() {}
  }
  class Worker {
    constructor(name, processor) { state.processors[name] = processor; }
    on() {}
    async close() {}
  }
  return { Queue, Worker, UnrecoverableError };
}

function fakeRedis(members = []) {
  const set = new Set(members);
  return { sadd: async (_key, name) => set.add(name), smembers: async () => [...set], members: set };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('platform-5: every run on the Redis queue is counted in job_runs_total and job_failures_total', async () => {
  const state = { queues: {}, processors: {} };
  const queue = createQueue(REDIS, { bullmq: fakeBullmq(state), redis: fakeRedis() });
  const metrics = createMetrics({ strict: true });
  assert.equal(instrumentQueue(metrics, queue), true, 'the Redis queue can be counted');
  assert.equal(instrumentQueue(metrics, queue), false, 'once only');
  let n = 0;
  queue.work('dm.send', async () => { if (++n === 2) throw new Error('send failed for someone@example.com'); });
  await settle();
  const run = state.processors['dm.send'];
  assert.ok(run, 'the worker was started');
  const bjob = (attemptsMade) => ({ id: '1', data: { payload: {}, tenantId: null, retryInFlight: false }, opts: { attempts: 2 }, attemptsMade, attemptsStarted: attemptsMade + 1 });
  await run(bjob(0));
  await assert.rejects(run(bjob(1)));
  const text = await metrics.render();
  assert.match(text, /job_runs_total\{queue="dm.send",result="ok"\} 1/);
  assert.match(text, /job_runs_total\{queue="dm.send",result="failed"\} 1/);
  assert.match(text, /job_failures_total\{queue="dm.send"\} 1/);
  assert.doesNotMatch(text, /example\.com/);
  await queue.close();
});

test('platform-6: a job that throws on the Redis queue is reported once, final on its last attempt', async () => {
  const seen = [];
  onError((_err, ctx) => { if (ctx.msg === 'job.failed') seen.push(ctx); });
  const state = { queues: {}, processors: {} };
  const queue = createQueue(REDIS, { bullmq: fakeBullmq(state), redis: fakeRedis() });
  queue.work('system.backup', async () => { throw new Error('disk full'); });
  await settle();
  const run = state.processors['system.backup'];
  const bjob = (attemptsMade) => ({ id: '1', data: { payload: {}, tenantId: null, retryInFlight: true }, opts: { attempts: 2 }, attemptsMade, attemptsStarted: attemptsMade + 1 });
  await assert.rejects(run(bjob(0)));
  await assert.rejects(run(bjob(1)));
  const mine = seen.filter((c) => c.queue === 'system.backup');
  assert.deepEqual(mine.map((c) => [c.attempt, c.final]), [[1, false], [2, true]]);
  await queue.close();
});

test('platform-5: Redis stats() covers every registered queue, with delayed jobs apart from queued', async () => {
  const state = { queues: { 'dm.send': { waiting: [{ id: '1', timestamp: Date.now() }], delayed: 3, active: 1, failed: [{ failedReason: 'unknown: worker stopped while running' }, { failedReason: 'boom' }] } }, processors: {} };
  // This process (the web) never enqueued to dm.send: only the worker did, and it is in the shared registry.
  const queue = createQueue(REDIS, { bullmq: fakeBullmq(state), redis: fakeRedis(['dm.send']) });
  assert.deepEqual(await queue.stats(), { 'dm.send': { queued: 1, delayed: 3, running: 1, failed: 1, unknown: 1 } });
  for (const status of Object.keys((await queue.stats())['dm.send'])) assert.equal(metricProblem('queue_jobs', { queue: 'dm.send', status }), null, status);
  await queue.close();
});

test('platform-5: enqueue and work put the queue in the shared registry', async () => {
  const redis = fakeRedis();
  const state = { queues: {}, processors: {} };
  const queue = createQueue(REDIS, { bullmq: fakeBullmq(state), redis });
  await queue.enqueue('notify', { x: 1 });
  queue.work('orders.events', async () => {});
  await settle();
  assert.deepEqual([...redis.members].sort(), ['notify', 'orders.events']);
  await queue.close();
});

test('platform-5: Redis oldestWaiting() is the age of the oldest ready job of each registered queue', async () => {
  const now = Date.now();
  const state = {
    queues: {
      'dm.send': { waiting: [{ id: '2', timestamp: now - 5_000, opts: {} }, { id: '1', timestamp: now - 700_000, opts: { delay: 100_000 } }], delayed: 0, active: 0, failed: [] },
      retried: { waiting: [{ id: '3', timestamp: now - 900_000, opts: {}, processedOn: now - 20_000 }], delayed: 0, active: 0, failed: [] },
      empty: { waiting: [], delayed: 4, active: 0, failed: [] },
    },
    processors: {},
  };
  const queue = createQueue(REDIS, { bullmq: fakeBullmq(state), redis: fakeRedis(['dm.send', 'retried', 'empty']) });
  const ages = await queue.oldestWaiting();
  assert.deepEqual(Object.keys(ages).sort(), ['dm.send', 'retried'], 'a queue with only delayed jobs has nothing waiting');
  assert.ok(Math.abs(ages['dm.send'] - 600) < 5, `ready since its delay ended: ${ages['dm.send']}`);
  assert.ok(Math.abs(ages.retried - 20) < 5, `a retry waits from its last attempt: ${ages.retried}`);
  await queue.close();
});

test('platform-5: queue_oldest_job_seconds comes from the queue, not the Postgres jobs table', async () => {
  const metrics = createMetrics({ strict: true });
  const queue = { driver: 'redis', onRun() {}, oldestWaiting: async () => ({ 'dm.send': 42 }) };
  const ctx = { service: 'worker', platform: { metrics, queue, analytics: { track() {} } }, db: { platform: { query: async () => [] } } };
  createOpsMetrics(ctx).wire();
  assert.match(await metrics.render(), /queue_oldest_job_seconds\{queue="dm.send"\} 42/);
});

test('platform-5: the worker autoscaler reads a queue_jobs state the queue reports', () => {
  const hpa = fs.readFileSync(new URL('../../../deploy/prod/k8s/base/hpa.yaml', import.meta.url), 'utf8');
  const block = hpa.slice(hpa.indexOf('name: queue_jobs'));
  const status = /status:\s*(\w+)/.exec(block)?.[1];
  assert.ok(['queued', 'delayed', 'running', 'failed', 'unknown'].includes(status), `HPA selects status=${status}`);
  assert.equal(status, 'queued', 'the worker scales on jobs ready to run');
});

test('R3-OP2-2: Redis waitingByTenant() reads every registered queue a page at a time, per business, oldest ready first', async () => {
  const now = Date.now();
  const job = (id, tenantId, ageMs, opts = {}) => ({ id, data: { payload: {}, tenantId, retryInFlight: false }, timestamp: now - ageMs, opts });
  // The fake lists `waiting` newest first, as BullMQ keeps its wait list; getWaiting answers oldest first.
  const state = {
    queues: {
      'dm.send': { waiting: [job('5', 7, 1_000), job('4', null, 2_000), job('3', 9, 3_000), job('2', 7, 4_000), job('1', 7, 300_000)], delayed: 2, active: 0, failed: [] },
      notify: { waiting: [job('6', 9, 50_000, { delay: 10_000 })], delayed: 0, active: 0, failed: [] },
      empty: { waiting: [], delayed: 1, active: 0, failed: [] },
    },
    processors: {},
  };
  const bullmq = fakeBullmq(state);
  const asked = [];
  const getWaiting = bullmq.Queue.prototype.getWaiting;
  bullmq.Queue.prototype.getWaiting = function (start, end) {
    asked.push([this.name, start, end]);
    return getWaiting.call(this, start, end);
  };
  const queue = createQueue(REDIS, { bullmq, redis: fakeRedis(['dm.send', 'notify', 'empty']) });
  const rows = await queue.waitingByTenant({ page: 2 });
  assert.deepEqual(rows.map((r) => [r.tenantId, r.depth]), [[7, 3], [9, 2]], 'the platform job (no business) is in none; delayed jobs are not waiting');
  assert.ok(Math.abs(rows[0].oldestSeconds - 300) < 5, String(rows[0].oldestSeconds));
  assert.ok(Math.abs(rows[1].oldestSeconds - 40) < 5, `ready since its delay ended: ${rows[1].oldestSeconds}`);
  assert.deepEqual(asked.filter(([name]) => name === 'dm.send').map(([, s, e]) => [s, e]), [[0, 1], [2, 3], [4, 5]], 'a page at a time, stopping at the short page');
  assert.deepEqual(asked.filter(([name]) => name === 'empty'), [['empty', 0, 1]]);
  asked.length = 0;
  const capped = await queue.waitingByTenant({ page: 2, limit: 3 });
  assert.deepEqual(asked.filter(([name]) => name === 'dm.send').map(([, s, e]) => [s, e]), [[0, 1], [2, 2]], 'never past the limit');
  assert.deepEqual(capped.map((r) => [r.tenantId, r.depth]), [[7, 2], [9, 2]]);
  await queue.close();
});

test('R3-OP2-2: on the Redis queue each business\'s queue depth is sampled from the queue, never the Postgres jobs table', async () => {
  const now = Date.now();
  const state = {
    queues: { 'dm.send': { waiting: [{ id: '2', data: { tenantId: 4 }, timestamp: now - 1_000, opts: {} }, { id: '1', data: { tenantId: 4 }, timestamp: now - 90_000, opts: {} }], delayed: 0, active: 0, failed: [] } },
    processors: {},
  };
  const queue = createQueue(REDIS, { bullmq: fakeBullmq(state), redis: fakeRedis(['dm.send']) });
  const tracked = [];
  const { currentTenant } = await import('../../../src/tenancy.js');
  const analytics = { track: async (name, props) => tracked.push({ name, tenant: currentTenant()?.id, props }) };
  const db = { platform: { query: async (sql) => { throw new Error(`the jobs table was read: ${sql.slice(0, 40)}`); } } };
  const ops = createOpsMetrics({ service: 'worker', platform: { metrics: createMetrics({ strict: true }), queue, analytics }, db });
  assert.equal(await ops.sampleQueues(), 1);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].name, 'ops.queue_depth');
  assert.equal(tracked[0].tenant, 4, 'written as the business');
  assert.equal(tracked[0].props.depth, 2);
  assert.ok(Math.abs(tracked[0].props.oldest_seconds - 90) <= 2, String(tracked[0].props.oldest_seconds));
  state.queues['dm.send'].waiting = [];
  assert.equal(await ops.sampleQueues(), 0);
  assert.deepEqual([tracked.length, tracked[1].tenant, tracked[1].props.depth], [2, 4, 0], 'a cleared queue shows as cleared');
  await queue.close();
});

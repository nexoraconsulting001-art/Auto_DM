// Health under attack (G-02, G-03): readiness turns false when the database, queue, storage or cache is down or the
// migrations are behind, and true again by itself; liveness stays true; no answer names a business, an address or a
// secret. On SIGTERM no new request starts, the ones in flight finish within the deadline, and the worker finishes or
// releases its jobs so that nothing runs twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { HEALTH_DEPENDENCIES, HEALTH_STATES, createHealth, drainHttp, drainOnSignals, knownMigrations } from '../../../src/platform/health.js';
import { createQueue } from '../../../src/platform/queue.js';
import { createStorage } from '../../../src/platform/storage.js';
import { createRepos } from '../../../src/repos/index.js';
import { openTestDb } from '../../helpers.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms = 3000) {
  const until = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > until) assert.fail('timed out waiting');
    await pause(10);
  }
}
/** The health module's own timers do not hold a process open; a test with a promise that never ends needs one that does. */
const keepAlive = (t) => {
  const timer = setInterval(() => {}, 1000);
  t.after(() => clearInterval(timer));
};
const LEAKS = ['tenant-acme-shop', 'Acme Fashion', '10.9.8.7', 'hunter2', 'bucket-prod-files', 'AKIAFAKEKEY', 'redis-pass-123'];
const noLeak = (answer) => {
  const text = JSON.stringify(answer);
  for (const word of LEAKS) assert.ok(!text.includes(word), `no "${word}" in the answer`);
  for (const state of Object.values(answer.checks ?? {})) assert.ok(HEALTH_STATES.includes(state), state);
};

test('each dependency down turns readiness false, its return turns it true by itself, and liveness never moves', async (t) => {
  keepAlive(t);
  const applied = knownMigrations().map((version) => ({ version }));
  const down = { database: false, queue: false, storage: false, cache: false, redis: false };
  const fail = (what) => { throw new Error(`${what} at 10.9.8.7 for tenant-acme-shop (Acme Fashion) password=hunter2 bucket-prod-files AKIAFAKEKEY redis-pass-123`); };
  const db = { query: async (text) => (down.database ? fail('db') : /schema_migrations/.test(text) ? applied : [{ ok: 1 }]) };
  const memory = createStorage({ storageDriver: 'memory' });
  const platform = {
    queue: { driver: 'redis', stats: async () => (down.queue ? fail('queue') : {}) },
    storage: { driver: 'memory', put: async (...args) => (down.storage ? fail('storage') : memory.put(...args)), get: async (key) => (down.storage ? fail('storage') : memory.get(key)) },
    cache: { get: async () => (down.cache ? fail('cache') : null) },
  };
  // The queue on Redis is pinged on its own connection: a queue with no queues made yet still proves Redis is there.
  const redis = { ping: async () => (down.redis ? fail('redis') : 'PONG'), disconnect: () => {} };
  const health = createHealth({ db, platform, redis, config: { healthCheckMs: 100, redisUrl: 'redis://:redis-pass-123@10.9.8.7:6379' } });

  const healthy = await health.ready();
  assert.deepEqual(healthy, { ok: true, draining: false, checks: { database: 'up', migrations: 'up', queue: 'up', storage: 'up', cache: 'up' } });
  for (const [what, checkName] of [['database', 'database'], ['queue', 'queue'], ['redis', 'queue'], ['storage', 'storage'], ['cache', 'cache']]) {
    down[what] = true;
    const answer = await health.ready();
    assert.equal(answer.ok, false, what);
    assert.equal(answer.checks[checkName], 'down', what);
    noLeak(answer);
    assert.deepEqual(health.live(), { ok: true }, `liveness stays true while ${what} is down`);
    down[what] = false;
    assert.equal((await health.ready()).ok, true, `${what} back: ready again with nothing done`);
  }
  // A dependency that hangs is down at the check deadline, and the answer does not wait for it.
  platform.cache.get = () => new Promise(() => {});
  const at = Date.now();
  assert.equal((await health.ready()).checks.cache, 'down');
  assert.ok(Date.now() - at < 1000);
  platform.cache.get = async () => null;
  // Migrations behind: the build ships one the database has not run. Then it is run, and readiness comes back.
  const last = applied.pop();
  assert.deepEqual([(await health.ready()).ok, (await health.ready()).checks.migrations], [false, 'behind']);
  applied.push(last);
  assert.equal((await health.ready()).ok, true);
  // Startup is false until the process says it has started, then true once a readiness has passed.
  assert.deepEqual(await health.startup(), { ok: false });
  health.markStarted();
  assert.deepEqual(await health.startup(), { ok: true });
});

test('on a real database every dependency answers in one word, and no business is named', async (t) => {
  const db = await openTestDb();
  t.after(() => db.close());
  const repos = createRepos(db, {});
  await repos.tenants.ensure({ slug: 'tenant-acme-shop', name: 'Acme Fashion' });
  const queue = createQueue({ queueDriver: 'pg' }, { db });
  const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'bhava-p9-health-'));
  const health = createHealth({ db, platform: { queue, storage: createStorage({ storageDriver: 'local', storageDir: dir }), cache: { get: async () => null } } });
  const answer = await health.ready();
  assert.deepEqual(answer, { ok: true, draining: false, checks: Object.fromEntries(HEALTH_DEPENDENCIES.map((d) => [d, 'up'])) });
  noLeak(answer);
});

/** One request on its own connection, or on the agent's. */
function request(port, path, agent) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('SIGTERM on the web server: no new request starts, the one in flight finishes, and the drain ends within the deadline', async (t) => {
  const health = createHealth({ config: { shutdownSeconds: 3 } });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let started = 0;
  const app = express();
  app.use(health.middleware());
  app.get('/healthz', (_req, res) => res.send('ok'));
  app.get('/slow', async (_req, res) => {
    started += 1;
    await gate;
    res.send('finished');
  });
  app.get('/fast', (_req, res) => {
    started += 1;
    res.send('fast');
  });
  const server = app.listen(0);
  t.after(() => server.closeAllConnections?.());
  const { port } = server.address();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  t.after(() => agent.destroy());

  // A keep-alive connection that sits idle, and a request in flight.
  assert.equal((await request(port, '/fast', agent)).status, 200);
  const inFlight = request(port, '/slow', agent);
  await waitFor(() => health.inFlight === 1);

  health.onDrain('http', () => drainHttp(server, health));
  const exits = [];
  const logs = [];
  const stop = drainOnSignals(health, { exit: (code) => exits.push(code), proc: { once: () => {} }, log: { info: (...a) => logs.push(a), warn: (...a) => logs.push(a) }, name: 'server' });
  const stopping = stop('SIGTERM');
  await pause(20);
  assert.equal(health.draining, true);
  assert.equal((await health.ready()).ok, false, 'the load balancer stops sending at once');

  // A new connection is refused: the server no longer listens.
  await assert.rejects(request(port, '/fast'), /ECONNREFUSED|ECONNRESET|socket hang up/);
  // A request that reaches the app on a connection opened before is refused before it starts.
  const answers = [];
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body) { answers.push([this.statusCode, this.headers.connection, body]); } };
  let ran = false;
  health.middleware()({ path: '/fast' }, res, () => (ran = true));
  assert.deepEqual([ran, answers[0][0], answers[0][1]], [false, 503, 'close']);
  // Probes still answer while draining: liveness must not get the process killed early.
  let probed = false;
  health.middleware()({ path: '/healthz' }, res, () => (probed = true));
  assert.equal(probed, true);

  release();
  const finished = await inFlight;
  assert.deepEqual([finished.status, finished.body, finished.headers.connection], [200, 'finished', 'close']);
  await stopping;
  assert.deepEqual(exits, [0]);
  assert.equal(started, 2, 'nothing started after the drain began');
  assert.equal(health.inFlight, 0);
  assert.ok(!JSON.stringify(logs).includes('finished'));
});

test('SIGTERM on the worker: the job in progress finishes once; at the deadline held jobs are released by the queue’s rule and none runs twice', async (t) => {
  keepAlive(t);
  const db = await openTestDb();
  t.after(() => db.close());
  const sql = (text, params) => (db.platform ?? db).query(text, params);
  const statusOf = async (id) => (await sql('SELECT status, run_at > now() AS later FROM jobs WHERE id = $1', [id]))[0];

  // Finishes: the drain waits for the job, which runs exactly once and is done.
  const queue = createQueue({ queueDriver: 'pg', queuePollMs: 10 }, { db });
  const health = createHealth({ db, platform: { queue } });
  let runs = 0;
  const id = await queue.enqueue('p9.finish', {});
  queue.work('p9.finish', async () => {
    runs += 1;
    await pause(150);
  });
  await waitFor(async () => (await statusOf(id)).status === 'running');
  health.onDrain('queue', () => queue.close());
  const result = await health.drain({ deadlineMs: 3000 });
  assert.deepEqual([result.ok, result.timedOut], [true, false]);
  assert.equal((await statusOf(id)).status, 'done');
  assert.equal(runs, 1);
  assert.equal(await createQueue({ queueDriver: 'pg' }, { db }).drain('p9.finish', async () => { runs += 1; }), 0, 'not run again');

  // Stuck past the deadline: a job that must not repeat is marked unknown; one safe to repeat goes back, later.
  const stuckQueue = createQueue({ queueDriver: 'pg', queuePollMs: 10 }, { db });
  const stuckHealth = createHealth({ db, platform: { queue: stuckQueue } });
  const once = await stuckQueue.enqueue('p9.once', {});
  const again = await stuckQueue.enqueue('p9.again', {}, { retryInFlight: true });
  const never = new Promise(() => {});
  let started = 0;
  stuckQueue.work('p9.once', () => ((started += 1), never));
  stuckQueue.work('p9.again', () => ((started += 1), never));
  await waitFor(async () => (await statusOf(once)).status === 'running' && (await statusOf(again)).status === 'running');
  stuckHealth.onDrain('queue', () => stuckQueue.close());
  const late = await stuckHealth.drain({ deadlineMs: 150 });
  assert.deepEqual([late.ok, late.timedOut], [false, true]);
  assert.equal(stuckHealth.released, 2);
  assert.deepEqual(await statusOf(once), { status: 'unknown', later: false });
  assert.deepEqual(await statusOf(again), { status: 'queued', later: true }, 'safe to repeat, but not beside the copy still ending');
  const other = createQueue({ queueDriver: 'pg' }, { db });
  let otherRuns = 0;
  assert.equal(await other.drain('p9.once', async () => { otherRuns += 1; }), 0);
  assert.equal(await other.drain('p9.again', async () => { otherRuns += 1; }), 0, 'held back for a few seconds');
  assert.deepEqual([started, otherRuns], [2, 0]);
  // Another worker's claimed jobs are not this worker's to release.
  const theirs = await other.enqueue('p9.theirs', {});
  await sql(`UPDATE jobs SET status = 'running', locked_by = 'another-host:1', lease_until = now() + interval '1 hour' WHERE id = $1`, [theirs]);
  const mine = createHealth({ db, platform: { queue: createQueue({ queueDriver: 'pg' }, { db }) } });
  mine.onDrain('stuck', () => never);
  await mine.drain({ deadlineMs: 50 });
  assert.equal((await statusOf(theirs)).status, 'running');
});

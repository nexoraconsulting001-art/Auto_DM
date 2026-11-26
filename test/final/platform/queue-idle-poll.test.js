// The pg queue's work loops: idle loops share one probe instead of each writing to the jobs table every poll (budgets C-09,
// C-47: per-queue claim polling and a stale sweep on every poll used most of the database, so webhook events waited behind it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../../../src/platform/queue.js';
import { openTestDb } from '../../helpers.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The database with every query counted by its first words. */
function counting(db) {
  const seen = [];
  const count = (sql) => seen.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 40));
  const wrap = (runner) => ({ ...runner, query: (sql, params) => { count(sql); return runner.query(sql, params); } });
  return { db: { ...wrap(db), platform: wrap(db.platform) }, seen, reset: () => seen.splice(0) };
}

test('idle loops of many queues cost one read a poll, not a claim write and a sweep per queue', async () => {
  const base = await openTestDb();
  const { db, seen, reset } = counting(base);
  const queue = createQueue({ queueDriver: 'pg', queuePollMs: 10, queueLeaseMs: 60_000 }, { db });
  try {
    const names = Array.from({ length: 30 }, (_, i) => `idle-${i}`);
    for (const name of names) queue.work(name, async () => {});
    await pause(150); // every loop has looked once and is now waiting
    reset();
    await pause(300);
    const claims = seen.filter((q) => q.startsWith("UPDATE jobs SET status = 'running'")).length;
    const sweeps = seen.filter((q) => q.startsWith('UPDATE jobs SET status = CASE')).length;
    const probes = seen.filter((q) => q.startsWith('SELECT DISTINCT queue FROM jobs')).length;
    assert.equal(claims, 0, 'No loop claims while nothing is ready');
    assert.equal(sweeps, 0, 'The stale sweep runs once per tenth of a lease, not every poll');
    assert.ok(probes >= 3 && probes <= 40, `One probe a poll for all 30 queues, got ${probes}`);
  } finally {
    await queue.close();
    await base.close();
  }
});

test('a waiting loop runs a job another process enqueued at its next probe, and one this process enqueued at once', async () => {
  const db = await openTestDb();
  const worker = createQueue({ queueDriver: 'pg', queuePollMs: 20 }, { db });
  const web = createQueue({ queueDriver: 'pg', queuePollMs: 20 }, { db });
  try {
    const ran = [];
    worker.work('mail', async (job) => { ran.push(job.payload.n); });
    await pause(100);
    await web.enqueue('mail', { n: 1 });
    for (let i = 0; i < 100 && ran.length < 1; i++) await pause(10);
    assert.deepEqual(ran, [1], 'Found by the probe of the process that works the queue');
    const started = Date.now();
    await worker.enqueue('mail', { n: 2 });
    for (let i = 0; i < 100 && ran.length < 2; i++) await pause(2);
    assert.deepEqual(ran, [1, 2]);
    assert.ok(Date.now() - started < 1000);
    await worker.enqueue('mail', { n: 3 }, { delayMs: 300 });
    await pause(100);
    assert.deepEqual(ran, [1, 2], 'A delayed job waits for its time');
    for (let i = 0; i < 100 && ran.length < 3; i++) await pause(10);
    assert.deepEqual(ran, [1, 2, 3]);
  } finally {
    await worker.close();
    await web.close();
    await db.close();
  }
});

test('a job left running by a dead worker is still swept by a busy or idle loop within its lease', async () => {
  const db = await openTestDb();
  const queue = createQueue({ queueDriver: 'pg', queuePollMs: 5, queueLeaseMs: 200 }, { db });
  try {
    await db.platform.query(`INSERT INTO jobs (queue, payload, status, attempts, lease_until, retry_in_flight) VALUES ('dm', '{}', 'running', 1, now() - interval '1 second', false), ('refresh', '{}', 'running', 1, now() - interval '1 second', true)`);
    const ran = [];
    queue.work('dm', async () => { ran.push('dm'); });
    queue.work('refresh', async () => { ran.push('refresh'); });
    // Wait for the outcome, not for the handler: 'done' is written after the handler returns (queue.js finish()), so
    // reading the rows as soon as it ran raced that write on a slower database.
    const settled = async () => (await db.platform.query(`SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running')`))[0].n === 0;
    for (let i = 0; i < 100 && !(ran.length >= 1 && (await settled())); i++) await pause(10);
    const rows = await db.platform.query('SELECT queue, status FROM jobs ORDER BY queue');
    assert.deepEqual(rows.map((r) => [r.queue, r.status]), [['dm', 'unknown'], ['refresh', 'done']]);
    assert.deepEqual(ran, ['refresh'], 'The DM that may have gone is never run again; the safe job reruns');
  } finally {
    await queue.close();
    await db.close();
  }
});

test('close() ends loops that are waiting for work', async () => {
  const db = await openTestDb();
  const queue = createQueue({ queueDriver: 'pg', queuePollMs: 50 }, { db });
  queue.work('a', async () => {});
  queue.work('b', async () => {});
  await pause(100);
  const closing = queue.close();
  const done = await Promise.race([closing.then(() => 'closed'), pause(2000).then(() => 'hung')]);
  assert.equal(done, 'closed');
  await db.close();
});

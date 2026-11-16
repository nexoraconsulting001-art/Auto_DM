// platform-1: the worker's own HTTP listener answers /metrics (with its token), so the 'worker' scrape job
// (deploy/prod/monitoring/probe/scrape.yaml) reads the job, backup, Meta-call and error metrics recorded in the worker.
// platform-2: backup_last_success_seconds is the time the last backup finished, not the time of the scrape, and it is kept
// with the backups, so a restarted worker and the backup CronJob report it too.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMetrics } from '../../../src/platform/metrics.js';
import { createStorage } from '../../../src/platform/storage.js';
import * as backup from '../../../src/backup.js';
import * as worker from '../../../src/worker.js';

const TOKEN = 'worker-metrics-token-0123456789';

test('platform-1: the worker probe server answers /metrics with its token, labelled service="worker", and keeps its health paths', async (t) => {
  assert.equal(typeof worker.createWorkerProbes, 'function', 'the worker has a probe server that answers /metrics');
  const metrics = createMetrics({ service: 'worker' });
  metrics.inc('job_runs_total', { queue: 'dm', result: 'ok' });
  const health = { serve: (req, res) => (req.url === '/healthz' ? (res.end('ok'), true) : false) };
  const server = worker.createWorkerProbes({ platform: { metrics, health }, config: { metricsToken: TOKEN } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const scraped = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(scraped.status, 200);
  assert.match(scraped.headers.get('content-type'), /text\/plain/);
  assert.equal(scraped.headers.get('cache-control'), 'no-store');
  const text = await scraped.text();
  assert.match(text, /job_runs_total\{queue="dm",result="ok"\} 1/);
  assert.match(text, /http_requests_in_flight\{service="worker"\} 0/);

  assert.equal((await fetch(`${base}/metrics`)).status, 404, 'no token, no metrics');
  assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong-token-0123456789-abcdef' } })).status, 404);
  assert.equal((await fetch(`${base}/healthz`)).status, 200, 'health still answers');
  assert.equal((await fetch(`${base}/other`)).status, 404);
});

test('platform-1: without METRICS_TOKEN the worker has no /metrics, as on the web server', async (t) => {
  const metrics = createMetrics({ service: 'worker' });
  const server = worker.createWorkerProbes({ platform: { metrics, health: { serve: () => false } }, config: { metricsToken: '' } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/metrics`, { headers: { authorization: 'Bearer ' } })).status, 404);
});

test('platform-1: the worker platform labels its own series service="worker"', async (t) => {
  const { createPlatform } = await import('../../../src/platform/index.js');
  const { openTestDb } = await import('../../helpers.js');
  const db = await openTestDb();
  t.after(() => db.close());
  const platform = createPlatform({ storageDriver: 'memory', queueDriver: 'pg', analyticsDriver: 'pg', cacheDriver: 'memory' }, { db, service: 'worker' });
  t.after(() => platform.queue.close());
  assert.match(await platform.metrics.render(), /http_requests_in_flight\{service="worker"\} 0/);
});

test('platform-2: backup age grows after the last success instead of reading about 0 at every scrape', async () => {
  assert.equal(typeof backup.recordBackupSuccess, 'function', 'a finished backup is recorded with the backups');
  assert.equal(typeof worker.watchBackups, 'function', 'the worker reports the recorded backup time');
  const storage = createStorage({ storageDriver: 'memory' });
  let nowMs = Date.parse('2026-11-10T02:00:00Z');
  const metrics = createMetrics({ strict: true, service: 'worker', now: () => nowMs });
  const watch = worker.watchBackups(metrics, storage, { now: () => nowMs });

  assert.doesNotMatch(await metrics.render(), /backup_age_seconds/, 'no backup yet: no age, so BackupMissing (absent) can fire, not a fresh 0');

  await watch.succeeded({ key: 'backups/daily-10.dump', at: new Date(nowMs) });
  nowMs += 30 * 3600_000; // a day and a quarter of failed backups later
  const text = await metrics.render();
  const age = Number(/backup_age_seconds (\d+)/.exec(text)?.[1]);
  assert.equal(age, 30 * 3600, 'the age is measured from the success, so BackupTooOld fires');
  assert.match(text, new RegExp(`backup_last_success_seconds ${Date.parse('2026-11-10T02:00:00Z') / 1000}`));
});

test('platform-2: a restarted worker reads the last success the backup run (worker or CronJob) recorded', async () => {
  const storage = createStorage({ storageDriver: 'memory' });
  const at = new Date('2026-11-12T01:30:00Z');
  await backup.recordBackupSuccess(storage, { key: 'backups/daily-12.dump', at });
  let nowMs = Date.parse('2026-11-14T01:30:00Z');
  const metrics = createMetrics({ strict: true, service: 'worker', now: () => nowMs });
  worker.watchBackups(metrics, storage, { now: () => nowMs });
  const text = await metrics.render();
  assert.match(text, /backup_age_seconds 172800/);
  assert.match(text, new RegExp(`backup_last_success_seconds ${at.getTime() / 1000}`));
});

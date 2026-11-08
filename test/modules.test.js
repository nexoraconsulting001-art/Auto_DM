// The switchable modules. By default these run the QA drivers. The CI "production profile" runs the
// same file with QUEUE_DRIVER=redis, STORAGE_DRIVER=s3, ANALYTICS_DRIVER=clickhouse, CACHE_DRIVER=redis
// (plus REDIS_URL, S3_*, CLICKHOUSE_URL), which proves the production drivers behave the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { bindTenant, createRepos } from '../src/repos/index.js';
import { withTenant } from '../src/tenancy.js';
import { createStorage } from '../src/platform/storage.js';
import { createQueue, backoffMs } from '../src/platform/queue.js';
import { createAnalytics } from '../src/platform/analytics.js';
import { createCache } from '../src/platform/cache.js';
import { createSecrets } from '../src/platform/secrets.js';
import { createMetrics } from '../src/platform/metrics.js';
import { log, setLogSink, withRequestId, reportError, onError } from '../src/platform/log.js';
import { login, startApp } from './helpers.js';

const env = process.env;
const drivers = {
  storageDriver: env.STORAGE_DRIVER || 'memory',
  queueDriver: env.QUEUE_DRIVER || 'pg',
  analyticsDriver: env.ANALYTICS_DRIVER || 'pg',
  cacheDriver: env.CACHE_DRIVER || 'memory',
  redisUrl: env.REDIS_URL,
  clickhouseUrl: env.CLICKHOUSE_URL,
  clickhouseDb: `bhava_test_${process.pid}`,
  s3Bucket: env.S3_BUCKET,
  s3Region: env.S3_REGION,
  s3Endpoint: env.S3_ENDPOINT,
  s3AccessKeyId: env.S3_ACCESS_KEY_ID,
  s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
  s3ForcePathStyle: env.S3_FORCE_PATH_STYLE === '1',
};
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

async function businesses() {
  const db = await openDb();
  const platform = createRepos(db);
  const a = await platform.tenants.create({ slug: 'a', name: 'A' });
  const b = await platform.tenants.create({ slug: 'b', name: 'B' });
  return { db, platform, a, b };
}

// ---- Storage ----

test(`storage (${drivers.storageDriver}): put, get, remove`, async () => {
  const storage = createStorage(drivers);
  const key = `t/1/media/${crypto.randomUUID()}`;
  await storage.put(key, Buffer.from('hello'), 'text/plain');
  assert.equal((await storage.get(key)).toString(), 'hello');
  await storage.remove(key);
  assert.equal(await storage.get(key), null);
  await assert.rejects(() => storage.put('../etc/passwd', Buffer.from('x')), /Invalid storage key/);
});

test('storage (local): files land in STORAGE_DIR and never outside it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-files-'));
  const storage = createStorage({ storageDriver: 'local', storageDir: dir });
  await storage.put('t/7/media/abc', Buffer.from('img'));
  assert.equal(fs.readFileSync(path.join(dir, 't', '7', 'media', 'abc'), 'utf8'), 'img');
  await assert.rejects(() => storage.get('t/../../x'), /Invalid storage key/);
  assert.equal(await storage.get('t/7/media/missing'), null);
});

test('uploaded images go to storage, not the database, and stay with their business', async () => {
  const { db, a, b, platform } = await businesses();
  const storage = createStorage({ storageDriver: 'memory' });
  const repos = createRepos(db, { storage });
  const ra = bindTenant(repos, a);
  const id = await ra.media.save(Buffer.from('png-bytes'), 'image/png');
  const [row] = await db.query('SELECT * FROM media WHERE id = $1', [id]);
  assert.equal(row.storage_key, `t/${a.id}/media/${id}`);
  assert.equal('data' in row, false);
  assert.equal((await ra.media.get(id)).data.toString(), 'png-bytes');
  assert.equal(await bindTenant(repos, b).media.get(id), null);
  assert.ok(platform);
});

test('an image uploaded in the admin is served back from storage', async () => {
  const app = await startApp();
  try {
    const { cookie, csrf } = await login(app.base, { csrfPage: '/admin/products/new' });
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'a.png');
    const res = await fetch(`${app.base}/admin/media`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: fd });
    assert.equal(res.status, 201);
    const { url } = await res.json();
    const img = await fetch(`${app.base}${url}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual([...Buffer.from(await img.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    app.close();
  }
});

// ---- Queue ----

test(`queue (${drivers.queueDriver}): jobs run once, as their own business`, async () => {
  const { db, a, platform } = await businesses();
  const queue = createQueue({ ...drivers, queuePollMs: 20 }, { db });
  const name = `t-${crypto.randomUUID()}`;
  const seen = [];
  try {
    queue.work(name, async (job) => {
      seen.push({ payload: job.payload, store: await platform.settings.getAll().then(() => 'scoped') });
    });
    await queue.enqueue(name, { n: 1 }, { tenantId: a.id });
    assert.equal(await queue.enqueue(name, { n: 2 }, { tenantId: a.id, dedupeKey: 'event:1' }) !== null, true);
    assert.equal(await queue.enqueue(name, { n: 3 }, { tenantId: a.id, dedupeKey: 'event:1' }), null, 'same key is dropped');
    assert.ok(await until(() => seen.length === 2));
    assert.deepEqual(seen.map((s) => s.payload.n).sort(), [1, 2]);
    assert.ok(seen.every((s) => s.store === 'scoped'));
  } finally {
    await queue.close();
  }
});

test(`queue (${drivers.queueDriver}): a failing job is retried, then marked failed`, async () => {
  const db = await openDb();
  const queue = createQueue({ ...drivers, queuePollMs: 20 }, { db });
  const name = `t-${crypto.randomUUID()}`;
  let tries = 0;
  try {
    if (queue.driver === 'pg') {
      await queue.enqueue(name, {}, { maxAttempts: 2 });
      await queue.drain(name, async () => { tries++; throw new Error('boom'); });
      await db.query(`UPDATE jobs SET run_at = now() WHERE queue = $1`, [name]); // skip the backoff wait
      await queue.drain(name, async () => { tries++; throw new Error('boom'); });
      const [job] = await db.query('SELECT status, attempts, last_error FROM jobs WHERE queue = $1', [name]);
      assert.deepEqual([job.status, job.attempts, job.last_error], ['failed', 2, 'boom']);
    } else {
      queue.work(name, async () => { tries++; throw new Error('boom'); });
      await queue.enqueue(name, {}, { maxAttempts: 2 });
      assert.ok(await until(async () => (await queue.stats())[name]?.failed === 1, 20_000));
    }
    assert.equal(tries, 2);
    assert.equal(backoffMs(1), 1000);
    assert.equal(backoffMs(30), 60 * 60_000);
  } finally {
    await queue.close();
  }
});

test('queue (pg): a job running when its worker died becomes unknown unless safe to repeat (R-02)', async () => {
  const db = await openDb();
  const queue = createQueue({ queueDriver: 'pg' }, { db });
  await queue.enqueue('dm', { to: 'x' });
  await queue.enqueue('refresh', {}, { retryInFlight: true });
  // Simulate two workers that claimed these jobs and then crashed.
  await db.query(`UPDATE jobs SET status = 'running', attempts = 1, lease_until = now() - interval '1 second'`);
  await queue.recoverStale();
  const rows = await db.query('SELECT queue, status FROM jobs ORDER BY queue');
  assert.deepEqual(rows.map((r) => [r.queue, r.status]), [['dm', 'unknown'], ['refresh', 'queued']]);
  let sent = 0;
  assert.equal(await queue.drain('dm', async () => sent++), 0);
  assert.equal(sent, 0, 'the unknown DM is never sent again');
  assert.deepEqual(await queue.stats(), { dm: { queued: 0, running: 0, failed: 0, unknown: 1 }, refresh: { queued: 1, running: 0, failed: 0, unknown: 0 } });
});

test('queue (pg): 500 queued jobs survive a restart and none runs twice (R-02)', async () => {
  const db = await openDb();
  const first = createQueue({ queueDriver: 'pg' }, { db });
  for (let i = 0; i < 500; i++) await first.enqueue('dm', { i });
  const runs = new Map();
  const handler = async (job) => runs.set(job.payload.i, (runs.get(job.payload.i) || 0) + 1);
  await first.drain('dm', handler, { limit: 200 });
  await first.close(); // "restart"
  const second = createQueue({ queueDriver: 'pg' }, { db });
  while (await second.drain('dm', handler, { limit: 100 }));
  assert.equal(runs.size, 500);
  assert.ok([...runs.values()].every((n) => n === 1));
});

test(`queue (${drivers.queueDriver}): every() enqueues one job per interval across servers`, async () => {
  const db = await openDb();
  const one = createQueue(drivers, { db });
  const two = createQueue(drivers, { db });
  const name = `cron-${crypto.randomUUID()}`;
  try {
    const ids = await Promise.all([one.every(name, 3_600_000), two.every(name, 3_600_000), one.every(name, 3_600_000)]);
    assert.equal(ids.filter(Boolean).length, 1);
  } finally {
    await one.close();
    await two.close();
  }
});

// ---- Analytics ----

test(`analytics (${drivers.analyticsDriver}): events are counted per business`, async () => {
  const { db, a, b } = await businesses();
  const analytics = createAnalytics(drivers, { db });
  await withTenant(a, async () => {
    await analytics.track('dm.sent', { reel: '1' });
    await analytics.track('dm.sent', { reel: '2' });
    await analytics.track('page.visit', {});
  });
  await withTenant(b, () => analytics.track('dm.sent', {}));
  assert.equal(await withTenant(a, () => analytics.count('dm.sent')), 2);
  assert.equal(await withTenant(b, () => analytics.count('dm.sent')), 1);
  const days = await withTenant(a, () => analytics.countByDay('dm.sent'));
  assert.equal(days.length, 1);
  assert.equal(Number(days[0].n), 2);
  await assert.rejects(() => withTenant(a, () => analytics.track('Bad Name!', {})), /Invalid event name/);
  await assert.rejects(() => analytics.track('dm.sent', {}), /No business/);
});

// ---- Cache ----

test(`cache (${drivers.cacheDriver}): set, get, expire, delete`, async () => {
  const cache = createCache(drivers);
  const key = `t:${crypto.randomUUID()}`;
  try {
    await cache.set(key, { a: 1 }, 60);
    assert.deepEqual(await cache.get(key), { a: 1 });
    await cache.del(key);
    assert.equal(await cache.get(key), null);
    await cache.set(key, 'x', 1);
    assert.ok(await until(async () => (await cache.get(key)) === null, 3000));
  } finally {
    await cache.close();
  }
});

// ---- Secrets ----

test('secrets: tokens are encrypted, tampering is caught, old keys still decrypt', () => {
  const k1 = crypto.randomBytes(32).toString('base64');
  const k2 = crypto.randomBytes(32).toString('base64');
  const s1 = createSecrets({ dataKey: k1 });
  const stored = s1.encrypt('IGQVJ-secret-token');
  assert.doesNotMatch(stored, /secret-token/);
  assert.equal(s1.decrypt(stored), 'IGQVJ-secret-token');
  assert.notEqual(s1.encrypt('same'), s1.encrypt('same'), 'a fresh IV every time');

  const parts = stored.split('.');
  parts[4] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => s1.decrypt(parts.join('.')));

  const rotated = createSecrets({ dataKey: k2, dataKeyOld: k1 });
  assert.equal(rotated.decrypt(stored), 'IGQVJ-secret-token');
  assert.equal(rotated.needsRotation(stored), true);
  assert.equal(rotated.needsRotation(rotated.encrypt('x')), false);
  assert.throws(() => createSecrets({ dataKey: k2 }).decrypt(stored), /no longer configured/);
  assert.throws(() => createSecrets({}).encrypt('x'), /DATA_KEY is not set/);
  assert.throws(() => createSecrets({ dataKey: 'short' }), /32 bytes/);
});

// ---- Logs, metrics, health ----

test('logs are JSON lines with the business and request id, and errors reach reporters', async () => {
  const lines = [];
  setLogSink((line) => lines.push(JSON.parse(line)));
  const reported = [];
  onError((err, ctx) => reported.push([err.message, ctx.tenant, ctx.requestId]));
  try {
    await withRequestId('req-12345678', () => withTenant({ id: 3, slug: 'leaf' }, async () => {
      log.info('order.created', { order: 'LC-1001' });
      reportError(new Error('boom'), { msg: 'job.failed' });
    }));
  } finally {
    setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`));
  }
  assert.equal(lines[0].msg, 'order.created');
  assert.equal(lines[0].tenant, 'leaf');
  assert.equal(lines[0].requestId, 'req-12345678');
  assert.equal(lines[1].level, 'error');
  assert.equal(lines[1].err.message, 'boom');
  assert.deepEqual(reported, [['boom', 'leaf', 'req-12345678']]);
});

test('metrics render in Prometheus format', async () => {
  const m = createMetrics();
  m.inc('dms_total', { result: 'sent' });
  m.inc('dms_total', { result: 'sent' });
  m.observe('job_seconds', 0.2);
  m.gauge('queue_jobs', () => [{ labels: { queue: 'dm', status: 'queued' }, value: 4 }]);
  const text = await m.render();
  assert.match(text, /dms_total\{result="sent"\} 2/);
  assert.match(text, /job_seconds_bucket\{le="0.25"\} 1/);
  assert.match(text, /queue_jobs\{queue="dm",status="queued"\} 4/);
});

test('health, readiness, request ids and protected /metrics', async () => {
  const app = await startApp({ overrides: { metricsToken: 'm-token-123' } });
  try {
    assert.equal(await (await fetch(`${app.base}/healthz`)).text(), 'ok');
    const ready = await (await fetch(`${app.base}/readyz`)).json();
    assert.equal(ready.ok, true);
    assert.equal(ready.modules.queue, 'pg');
    const home = await fetch(`${app.base}/`, { headers: { 'x-request-id': 'abcdef123456' } });
    assert.equal(home.headers.get('x-request-id'), 'abcdef123456');
    assert.equal((await fetch(`${app.base}/metrics`)).status, 404);
    const metrics = await fetch(`${app.base}/metrics`, { headers: { authorization: 'Bearer m-token-123' } });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /http_requests_total\{method="GET",group="home",status="200"\}/);
  } finally {
    app.close();
  }
});

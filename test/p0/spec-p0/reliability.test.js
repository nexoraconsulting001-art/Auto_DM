// PRD 11: restarts, restores, running on several servers, and moving between clouds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupStorage, runBackup, runRestore } from '../../../src/backup.js';
import { MIGRATIONS_DIR, openDb } from '../../../src/db/index.js';
import { createPlatform, describePlatform } from '../../../src/platform/index.js';
import { createQueue } from '../../../src/platform/queue.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { bindTenant, createRepos } from '../../../src/repos/index.js';
import { config as baseConfig } from '../../../src/config.js';
import { createApp } from '../../../src/server.js';
import { IG_ACCOUNT, OWNER, TEST_DATA_KEY, fakeIg, openTestDb, setup } from '../../helpers.js';
import { NEUTRAL, TINY_PNG, hit, need, pause, sendComment, uploadFile, waitFor } from './support.js';

const repoRoot = path.resolve(MIGRATIONS_DIR, '..', '..', '..');
const QUEUE = 'spec.dm';

const pgQueueSettings = { queueDriver: 'pg', queuePollMs: 5, queueLeaseMs: 150 };

test('R-02: a crash with 500 DMs queued sends nothing twice, and everything not in flight still sends once', async (t) => {
  const { db, tenant } = await setup();
  const before = createQueue(pgQueueSettings, { db });
  for (let n = 0; n < 500; n++) await before.enqueue(QUEUE, { n }, { tenantId: tenant.id, dedupeKey: `dm-${n}` });

  const sends = [];
  const hung = new Set();
  let crashed = false;
  before.work(QUEUE, async (job) => {
    sends.push(job.payload.n);
    if (crashed || sends.length > 100) {
      crashed = true;
      hung.add(job.payload.n);
      await new Promise(() => {}); // the process dies mid-send: this never finishes
    }
  }, { concurrency: 5 });
  await waitFor(() => crashed, 30_000);
  assert.ok(crashed, 'the first server reached the crash point');
  before.close(); // not awaited: its loop is stuck in the send, as a dead process would be

  await pause(250); // the dead worker's lease runs out
  const after = createQueue(pgQueueSettings, { db });
  t.after(() => after.close());
  after.work(QUEUE, async (job) => void sends.push(job.payload.n), { concurrency: 5 });

  const settled = async () => {
    const s = (await after.stats())[QUEUE] ?? { queued: 0, running: 0 };
    return s.queued === 0 && s.running === 0;
  };
  assert.ok(await waitFor(settled, 60_000), 'every job finished or was marked unknown');

  const { unknown, failed } = (await after.stats())[QUEUE];
  assert.equal(failed, 0);
  assert.equal(new Set(sends).size, sends.length, 'no job was sent twice');
  assert.ok(unknown >= 1 && unknown <= 5, `jobs in flight at the crash are unknown: ${unknown}`);
  const statusOf = new Map((await db.query('SELECT payload, status FROM jobs WHERE queue = $1', [QUEUE])).map((r) => [r.payload.n, r.status]));
  for (const n of hung) assert.equal(statusOf.get(n), 'unknown', `job ${n}, mid-send at the crash`);
  const done = [...statusOf].filter(([, status]) => status === 'done').map(([n]) => n);
  assert.equal(done.length + unknown, 500, 'every job is accounted for');
  const started = new Set(sends);
  for (const n of done) assert.ok(started.has(n), `job ${n} is marked done and was never sent`);
});

const hasPgTools = () => {
  try {
    execSync('pg_dump --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const canRoundTrip = Boolean(process.env.TEST_DATABASE_URL) && hasPgTools();

async function freshPostgres(prefix) {
  const admin = await openDb({ url: process.env.TEST_DATABASE_URL, migrate: false, poolSize: 1 });
  const name = `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
  await admin.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.href;
}

test('R-03: a restore from the nightly backup brings the platform back with no data mixed between businesses', { skip: !canRoundTrip && 'needs real Postgres with pg_dump and pg_restore' }, async (t) => {
  const url = await freshPostgres('spec_restore');
  const db = await openDb({ url, poolSize: 3 });
  const platform = createRepos(db);
  const a = await platform.tenants.create({ slug: 'alpha-store', name: 'Alpha Store' });
  const b = await platform.tenants.create({ slug: 'beta-store', name: 'Beta Store' });
  const repoA = bindTenant(platform, a);
  const repoB = bindTenant(platform, b);
  await repoA.products.create({ name: 'Alpha lamp', price: '100', active: 'on' });
  await repoB.products.create({ name: 'Beta pot', price: '200', active: 'on' });

  const storage = backupStorage({ backupStorageDriver: 'local', backupStorageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'spec-backups-')) });
  await runBackup({ databaseUrl: url, storage });
  await repoA.products.create({ name: 'Made after the backup', price: '1', active: 'on' });
  await db.close();

  await runRestore({ databaseUrl: url, storage });
  const restored = await openDb({ url, poolSize: 3 });
  t.after(() => restored.close());
  const repos = createRepos(restored);
  assert.deepEqual((await bindTenant(repos, a).products.list()).map((p) => p.name), ['Alpha lamp']);
  assert.deepEqual((await bindTenant(repos, b).products.list()).map((p) => p.name), ['Beta pot']);
});

test('R-05: choosing the production drivers is configuration only', () => {
  const production = {
    storageDriver: 's3', s3Bucket: 'b', s3Region: 'r', s3Endpoint: 'http://127.0.0.1:9', s3AccessKeyId: 'k', s3SecretAccessKey: 's',
    queueDriver: 'redis', cacheDriver: 'redis', redisUrl: 'redis://127.0.0.1:9',
    analyticsDriver: 'clickhouse', clickhouseUrl: 'http://127.0.0.1:9',
    dataKey: TEST_DATA_KEY,
  };
  const drivers = describePlatform(createPlatform(production, { db: {} }));
  assert.equal(drivers.storage, 's3');
  assert.equal(drivers.queue, 'redis');
  assert.equal(drivers.cache, 'redis');
  assert.equal(drivers.analytics, 'clickhouse');
});

test('R-05: every test runs in CI on the production drivers with no code change', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const setting of [/QUEUE_DRIVER:\s*redis/, /CACHE_DRIVER:\s*redis/, /ANALYTICS_DRIVER:\s*clickhouse/, /STORAGE_DRIVER:\s*s3/, /REDIS_URL:/, /CLICKHOUSE_URL:/, /S3_BUCKET:/]) {
    assert.match(ci, setting);
  }
  assert.match(ci, /npm (run )?test(:ci)?/, 'the production job runs the test suite');
});

test('R-05: no route or feature talks to a provider directly', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  const offenders = ['routes', 'modules', 'repos', 'views'].flatMap((d) => walk(path.join(repoRoot, 'src', d)))
    .filter((f) => /from\s+['"](?:ioredis|bullmq|@aws-sdk\/[^'"]*|@clickhouse\/[^'"]*)['"]/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(repoRoot, f));
  assert.deepEqual(offenders, []);
});

/** One web server, as server.js builds it, on a database and file store shared with any others. */
function serverOn(db, storageDir, ig = fakeIg(), extra = {}) {
  const config = {
    ...baseConfig, storageDriver: 'local', storageDir, queueDriver: 'pg', queuePollMs: 5, analyticsDriver: 'pg', cacheDriver: 'memory', defaultTenant: 'default',
    platformDomain: NEUTRAL, adminPhone: OWNER.phone, adminPassword: OWNER.password, sessionSecret: 'test-secret', verifyToken: 'vt', appSecret: 'secret',
    publicBaseUrl: '', dataKey: TEST_DATA_KEY, dryRun: false, oneDmPerUser: false, ...extra,
  };
  const platform = createPlatform(config, { db });
  const server = createApp({ db, ig, config, platform }).listen(0);
  return { port: server.address().port, platform, ig, close: () => server.close() };
}

async function shared(t) {
  const { db, repos, platform, tenant } = await setup();
  await repos.users.ensureOwner(OWNER);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-storage-'));
  const one = serverOn(db, storageDir);
  const two = serverOn(db, storageDir);
  t.after(() => {
    one.close();
    two.close();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });
  return { db, repos, platform, tenant, one, two, shop: { host: `default.${NEUTRAL}` } };
}

test('R-06: a seller stays logged in when requests move between two web servers, and logout ends it on both', async (t) => {
  const { one, two, shop } = await shared(t);
  const login = need(await hit(one, '/api/v1/auth/login', { host: shop.host, method: 'POST', body: { phone: OWNER.phone, password: OWNER.password } }), 201, 'Sign in on server one').json();
  need(await hit(two, '/api/v1/auth/me', { host: shop.host, token: login.token }), 200, 'The session on server two');
  need(await hit(one, '/api/v1/auth/me', { host: shop.host, token: login.token }), 200, 'And back on server one');

  const form = await hit(one, '/login', { host: shop.host, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(OWNER).toString() });
  assert.equal(form.status, 303);
  const cookie = form.headers['set-cookie'][0].split(';')[0];
  assert.equal((await hit(two, '/account', { host: shop.host, cookie })).status, 200, 'the cookie session too');

  need(await hit(two, '/api/v1/auth/logout', { host: shop.host, method: 'POST', token: login.token }), 204, 'Sign out on server two');
  assert.equal((await hit(one, '/api/v1/auth/me', { host: shop.host, token: login.token })).status, 401, 'signed out on server one as well');
});

test('R-06: an image uploaded through one server shows on the other', async (t) => {
  const { one, two, shop } = await shared(t);
  const { token } = need(await hit(one, '/api/v1/auth/login', { host: shop.host, method: 'POST', body: { phone: OWNER.phone, password: OWNER.password } }), 201, 'Sign in').json();
  const uploaded = need(await uploadFile(one, shop, token), 201, 'Upload on server one').json();
  const seen = need(await hit(two, uploaded.url, { host: shop.host }), 200, 'The image on server two');
  assert.deepEqual(seen.raw, TINY_PNG);
});

test('R-06: a scheduled job runs once however many servers schedule it', async (t) => {
  const db = await openTestDb();
  const first = createQueue(pgQueueSettings, { db });
  const second = createQueue(pgQueueSettings, { db });
  t.after(() => Promise.all([first.close(), second.close()]));
  let runs = 0;
  const handler = async () => void runs++;
  await Promise.all([first.every('spec.tick', 3_600_000), second.every('spec.tick', 3_600_000), first.every('spec.tick', 3_600_000)]);
  first.work('spec.tick', handler);
  second.work('spec.tick', handler);
  await waitFor(() => runs > 0);
  await pause(200);
  assert.equal(runs, 1);
});

test('R-06: two workers claiming the same queue never run one job twice', async (t) => {
  const db = await openTestDb();
  const first = createQueue(pgQueueSettings, { db });
  const second = createQueue(pgQueueSettings, { db });
  t.after(() => Promise.all([first.close(), second.close()]));
  for (let n = 0; n < 60; n++) await first.enqueue('spec.claim', { n });
  const ran = [];
  const handler = async (job) => void ran.push(job.payload.n);
  first.work('spec.claim', handler, { concurrency: 3 });
  second.work('spec.claim', handler, { concurrency: 3 });
  await waitFor(() => ran.length >= 60, 30_000);
  await pause(100);
  assert.equal(ran.length, 60);
  assert.equal(new Set(ran).size, 60);
});

/**
 * A database that can be copied whole: a named database on the test Postgres, or a PGlite folder on disk.
 * Without pg_dump, the copy stands in for the backup. What this checks is that nothing outside the database
 * and DATABASE_URL has to change when the platform moves.
 */
async function movableDatabase(t) {
  if (process.env.TEST_DATABASE_URL) {
    const url = await freshPostgres('spec_source');
    return {
      open: () => openDb({ url, poolSize: 3 }),
      async move() {
        const target = `spec_moved_${crypto.randomUUID().replace(/-/g, '')}`;
        const admin = await openDb({ url: process.env.TEST_DATABASE_URL, migrate: false, poolSize: 1 });
        await admin.exec(`CREATE DATABASE ${target} TEMPLATE ${new URL(url).pathname.slice(1)}`);
        await admin.close();
        const moved = new URL(url);
        moved.pathname = `/${target}`;
        return () => openDb({ url: moved.href, poolSize: 3 });
      },
    };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-move-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, 'source');
  return {
    open: () => openDb({ dataDir: source }),
    async move() {
      const target = path.join(root, 'moved');
      fs.cpSync(source, target, { recursive: true });
      return () => openDb({ dataDir: target });
    },
  };
}

test('R-07: after moving the database, all data is back and only the connection setting changed', async (t) => {
  const store = await movableDatabase(t);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-storage-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const shopHost = `moving-shop.${NEUTRAL}`;

  const db = await store.open();
  const secrets = createSecrets({ dataKey: TEST_DATA_KEY });
  const platform = createRepos(db, { secrets });
  const tenant = await platform.tenants.create({ slug: 'moving-shop', name: 'Moving Shop' });
  const repos = bindTenant(platform, tenant);
  await repos.users.ensureOwner(OWNER);
  await repos.settings.update({ store_name: 'Moving Shop' });
  const lamp = await repos.products.create({ name: 'Brass lamp', price: '499', active: 'on' });
  const reel = await repos.reels.save('17900000000000040', { headline: 'Reel to move', keywords: 'LINK', productIds: [lamp.id], active: 'on' });
  await platform.tenants.linkIgAccount(tenant.id, IG_ACCOUNT.igUserId, IG_ACCOUNT.username);
  await repos.igAccounts.setToken(IG_ACCOUNT.igUserId, IG_ACCOUNT.token);

  const original = serverOn(db, storageDir);
  const { token } = need(await hit(original, '/api/v1/auth/login', { host: shopHost, method: 'POST', body: { phone: OWNER.phone, password: OWNER.password } }), 201, 'Sign in before the move').json();
  original.close();
  await db.close();

  const openMoved = await store.move();
  const movedDb = await openMoved();
  t.after(() => movedDb.close().catch(() => {})); // PGlite can abort while shutting down, after the test is decided
  const ig = fakeIg();
  const moved = serverOn(movedDb, storageDir, ig);
  t.after(() => moved.close());

  assert.equal(titleFrom(need(await hit(moved, `/p/${lamp.slug}`, { host: shopHost }), 200, 'The product page after the move').text).includes('Brass lamp'), true);
  need(await hit(moved, `/r/${reel.slug}`, { host: shopHost }), 200, 'The reel page after the move');
  need(await hit(moved, '/api/v1/auth/me', { host: shopHost, token }), 200, 'A session from before the move');

  need(await sendComment(moved, IG_ACCOUNT.igUserId, '17900000000000040'), 200, 'A comment after the move');
  await waitFor(() => ig.calls.length > 0);
  assert.equal(ig.accounts[0]?.token, IG_ACCOUNT.token, 'the stored Instagram token still decrypts');
});

const titleFrom = (html) => /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';

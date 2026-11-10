import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupStorage, pgEnv, runBackup, runRestore } from '../src/backup.js';
import { MIGRATIONS_DIR, openDb, runMigrations } from '../src/db/index.js';
import { createPlatform } from '../src/platform/index.js';
import { createQueue } from '../src/platform/queue.js';
import { bindTenant, createRepos } from '../src/repos/index.js';
import { HOUSEKEEPING, BACKUP, housekeeping, registerJobs } from '../src/worker.js';
import { tenantCommand } from '../scripts/tenant.js';
import { openTestDb, setup } from './helpers.js';

const hasPgTools = () => {
  try {
    execSync('pg_dump --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

test('housekeeping removes only what is past its retention', async () => {
  const { db, repos, tenant } = await setup();
  const queue = createQueue({ queueDriver: 'pg' }, { db });
  const user = await repos.users.create({ name: 'Asha', phone: '9876543210', password: 'secret1' });
  const live = await repos.sessions.create(user.id, 30);
  await db.query(
    `INSERT INTO sessions (id, tenant_id, user_id, expires_at) VALUES ('expired', $1, $2, now() - interval '1 hour')`,
    [tenant.id, user.id],
  );
  await db.query(
    `INSERT INTO compliance_events (tenant_id, kind, decision, created_at) VALUES ($1, 'dm', 'allow', now() - interval '400 days'), ($1, 'dm', 'allow', now())`,
    [tenant.id],
  );
  await db.query(`INSERT INTO jobs (queue, status, finished_at) VALUES ('x', 'done', now() - interval '30 days'), ('x', 'done', now()), ('x', 'failed', now() - interval '30 days')`);

  await housekeeping({ db, queue });

  assert.equal(await repos.sessions.userIdFor(live), user.id);
  assert.equal((await db.query(`SELECT 1 FROM sessions WHERE id = 'expired'`)).length, 0);
  assert.equal((await db.query('SELECT 1 FROM compliance_events')).length, 1);
  assert.deepEqual((await db.query('SELECT status FROM jobs ORDER BY status')).map((r) => r.status), ['done', 'failed']);
});

test('the worker schedules housekeeping once per hour however many workers run', async () => {
  const db = await openTestDb();
  const platform = createPlatform({ storageDriver: 'memory', queueDriver: 'pg', analyticsDriver: 'pg', cacheDriver: 'memory' }, { db });
  const config = { backupStorageDriver: '' };
  const schedule = registerJobs({ db, platform: { ...platform, queue: { ...platform.queue, work() {}, every: platform.queue.every.bind(platform.queue), enqueue: platform.queue.enqueue } }, config });
  await Promise.all([schedule(), schedule(), schedule()]);
  const rows = await db.query('SELECT queue FROM jobs');
  assert.deepEqual(rows.map((r) => r.queue), [HOUSEKEEPING]);
});

test('backups are scheduled only when backup storage is set', async () => {
  const db = await openTestDb();
  const platform = createPlatform({ storageDriver: 'memory', queueDriver: 'pg', analyticsDriver: 'pg', cacheDriver: 'memory' }, { db });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-backups-'));
  const config = { backupStorageDriver: 'local', backupStorageDir: dir, databaseUrl: '' };
  const schedule = registerJobs({ db, platform: { ...platform, queue: { ...platform.queue, work() {}, every: platform.queue.every.bind(platform.queue), enqueue: platform.queue.enqueue } }, config });
  await schedule();
  assert.deepEqual((await db.query('SELECT queue FROM jobs ORDER BY queue')).map((r) => r.queue), [BACKUP, HOUSEKEEPING]);
});

test('pg tools get the connection from the environment, with the password decoded', () => {
  const env = pgEnv('postgres://bhava:p%40ss@postgres:5432/bhava');
  assert.deepEqual([env.PGHOST, env.PGPORT, env.PGUSER, env.PGPASSWORD, env.PGDATABASE], ['postgres', '5432', 'bhava', 'p@ss', 'bhava']);
});

test('migrations are safe when several processes start at once', { skip: !process.env.TEST_DATABASE_URL && 'needs real Postgres' }, async () => {
  const db = await openTestDb();
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const results = await Promise.all([runMigrations(db), runMigrations(db), runMigrations(db)]);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  assert.equal(results.flat().length, files.length, 'each migration applied exactly once');
});

test('R-03: a backup restores with no data mixed between businesses', { skip: !(process.env.TEST_DATABASE_URL && hasPgTools()) && 'needs real Postgres and pg_dump' }, async () => {
  const admin = await openDb({ url: process.env.TEST_DATABASE_URL, migrate: false, poolSize: 1 });
  const name = `r_${Date.now()}`;
  await admin.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = await openDb({ url: url.href, poolSize: 3 });
  const platform = createRepos(db);
  const [a, b] = [await platform.tenants.create({ slug: 'a', name: 'A' }), await platform.tenants.create({ slug: 'b', name: 'B' })];
  await bindTenant(platform, a).products.create({ name: 'Lamp', price: '100', active: 'on' });
  await bindTenant(platform, b).products.create({ name: 'Pot', price: '200', active: 'on' });

  const storage = backupStorage({ backupStorageDriver: 'local', backupStorageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-backups-')) });
  const saved = await runBackup({ databaseUrl: url.href, storage });
  assert.match(saved.key, /^backups\/daily-\d\d\.dump$/);

  await bindTenant(platform, a).products.create({ name: 'Added after backup', price: '1', active: 'on' });
  await db.query(`DELETE FROM products WHERE name = 'Pot'`);
  await db.close(); // pg_restore needs the tables free

  await runRestore({ databaseUrl: url.href, storage });
  const after = await openDb({ url: url.href, poolSize: 3 });
  const repos = createRepos(after);
  assert.deepEqual((await bindTenant(repos, a).products.list()).map((p) => p.name), ['Lamp']);
  assert.deepEqual((await bindTenant(repos, b).products.list()).map((p) => p.name), ['Pot']);
  await after.close();
});

test('businesses can be managed from the server', async () => {
  const { platform: repos } = await setup();
  assert.match(await tenantCommand(repos, ['create', 'bhava-mehta', 'Mehta Mart']), /Created Mehta Mart/);
  await assert.rejects(() => tenantCommand(repos, ['owner', 'bhava-mehta', '9000000002']), /OWNER_PASSWORD/);
  assert.match(await tenantCommand(repos, ['owner', 'bhava-mehta', '9000000002'], { ownerPassword: 'owner-pass' }), /is now the owner/);
  assert.match(await tenantCommand(repos, ['domain', 'bhava-mehta', 'shop.example.com']), /shop\.example\.com now serves/);
  assert.match(await tenantCommand(repos, ['link-ig', 'bhava-mehta', '178414']), /now belongs/);
  assert.match(await tenantCommand(repos, ['list']), /bhava-mehta {2}Mehta Mart/);
  await assert.rejects(() => tenantCommand(repos, ['owner', 'nobody', '9000000002']), /No business/);
  await assert.rejects(() => tenantCommand(repos, ['nonsense']), /Usage/);
});

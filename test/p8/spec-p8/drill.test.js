// Q-08 and Q-09: the backup and restore drill (tools/drill) and, without it, the real backup and restore code on real Postgres:
// a truncated, corrupted, wrong-version or empty backup is refused and the target is left exactly as it was; a good backup
// restored into a database that is not empty leaves nothing of what was there and no mixture of businesses; and after a
// restore the app login reads one business at a time. Needs pg_dump and pg_restore on the PATH, like R-03: without them the
// tests that need them skip, and say so.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBackup, runRestore } from '../../../src/backup.js';
import { ensureAppLogin, openDb } from '../../../src/db/index.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { bindTenant, createRepos } from '../../../src/repos/index.js';
import { TEST_DATA_KEY } from '../../helpers.js';
import { BAD_BACKUPS, DRILL_PARTS, DRILL_STEPS, checksumSql, run as runDrill } from '../../../tools/drill/index.mjs';
import { loadBudgets, startPostgres } from '../../../tools/load/index.mjs';
import { FULL, repoRoot } from './support.js';

const tools = (() => {
  try {
    execSync('pg_dump --version', { stdio: 'ignore' });
    execSync('pg_restore --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = tools ? false : 'needs pg_dump and pg_restore on the PATH (the drill and the backup use them)';

const cleanup = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
});

const memoryStorage = () => {
  const files = new Map();
  return {
    files,
    put: async (key, data) => { files.set(key, Buffer.from(data)); },
    get: async (key) => files.get(key) ?? null,
    list: async () => [...files.keys()],
    delete: async (key) => { files.delete(key); },
  };
};

const withDatabase = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.href;
};

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-pg-'));
  const pg = await startPostgres({ dir, budgets: loadBudgets() });
  cleanup.push(async () => {
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { default: pgClient } = await import('pg');
  const client = new pgClient.Client({ connectionString: pg.ownerUrl });
  await client.connect();
  cleanup.push(() => client.end());
  return { pg, client, urlFor: (name) => withDatabase(pg.ownerUrl, name), createDatabase: (name) => client.query(`CREATE DATABASE ${name}`) };
}

/** Counts and a checksum for every table of the public schema, read as the owner. */
async function fingerprint(url) {
  const { default: pgClient } = await import('pg');
  const c = new pgClient.Client({ connectionString: url });
  await c.connect();
  try {
    const tables = (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name);
    const out = {};
    for (const table of tables) {
      const { rows } = await c.query(`SELECT count(*)::int AS rows, COALESCE(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS sum FROM "${table}" t`);
      out[table] = `${rows[0].rows}:${rows[0].sum}`;
    }
    return out;
  } finally {
    await c.end();
  }
}

async function populated(url, { slugs, products = 6 }) {
  const db = await openDb({ url, migrate: true, poolSize: 2 });
  try {
    const platform = createRepos(db, { secrets: createSecrets({ dataKey: TEST_DATA_KEY }) });
    for (const slug of slugs) {
      const tenant = await platform.tenants.create({ slug, name: `Business ${slug}`, plan: 't3' });
      const repos = bindTenant(platform, tenant);
      for (let i = 0; i < products; i++) await repos.products.create({ name: `${slug} product ${i}`, price: '100', active: 'on' });
    }
  } finally {
    await db.close();
  }
}

const damage = {
  truncated: (data) => data.subarray(0, Math.floor((data.length * 2) / 3)),
  corrupted: (data) => {
    const copy = Buffer.from(data);
    const at = Math.floor(copy.length / 2);
    copy.fill(0xaa, at, Math.min(copy.length, at + 256));
    return copy;
  },
  wrong_version: (data) => {
    const copy = Buffer.from(data);
    assert.equal(copy.subarray(0, 5).toString('latin1'), 'PGDMP', 'a custom-format dump');
    copy[5] = 99; // the format's major version, which no server of ours reads
    return copy;
  },
  empty: () => Buffer.alloc(0),
  not_a_backup: () => Buffer.from('this is not a database backup\n'.repeat(50)),
};

test('Q-09: the three damaged backups of the contract are the three this drill knows, and the drill names them', () => {
  assert.deepEqual(Object.keys(BAD_BACKUPS), ['truncated', 'corrupted', 'wrong_version']);
  assert.ok(DRILL_STEPS.includes('refuse') && DRILL_PARTS.refuse.includes('backup'));
  assert.throws(() => checksumSql('products; DROP TABLE tenants', ['id']), /not a table or column/);
  assert.throws(() => checksumSql('products', ['id; --']), /not a table or column/);
  assert.throws(() => checksumSql('products', []), /columns/);
  assert.match(checksumSql('products', ['id'], { tenantColumn: 'tenant_id' }), /WHERE t\.tenant_id = \$1/);
});

test('Q-09: the drill refuses to run with NODE_ENV=production', () => {
  const guard = pathToFileURL(path.join(repoRoot, 'tools/net-guard.mjs')).href;
  const r = spawnSync(process.execPath, ['--import', guard, path.join(repoRoot, 'tools/drill/index.mjs')], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_ENV: 'production' } });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /production/i);
  const bad = spawnSync(process.execPath, ['--import', guard, path.join(repoRoot, 'tools/drill/index.mjs'), '--only', 'everything'], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
  assert.equal(bad.status, 2);
});

test('Q-09: a truncated, corrupted, wrong-version, empty or foreign backup is refused and the target is left exactly as it was', { skip, timeout: 900_000 }, async () => {
  const server = await makeServer();
  await server.createDatabase('source');
  await server.createDatabase('target');
  await populated(server.urlFor('source'), { slugs: ['alpha', 'beta'] });
  await populated(server.urlFor('target'), { slugs: ['gamma'], products: 3 });
  const storage = memoryStorage();
  const { key } = await runBackup({ databaseUrl: server.urlFor('source'), storage });
  const good = storage.files.get(key);
  assert.ok(good.length > 1000);

  const before = await fingerprint(server.urlFor('target'));
  assert.ok(Object.keys(before).length > 20, 'the target has the whole schema');
  for (const [what, make] of Object.entries(damage)) {
    const broken = memoryStorage();
    await broken.put('backups/daily-01.dump', make(good));
    await broken.put('backups/LATEST', Buffer.from('backups/daily-01.dump'));
    await assert.rejects(runRestore({ databaseUrl: server.urlFor('target'), storage: broken, key: 'backups/daily-01.dump' }), (err) => {
      assert.ok(err.message.length > 0);
      assert.doesNotMatch(err.message, /postgres:\/\/[^\s]*:[^\s@]+@/, `${what}: the error holds no password`);
      return true;
    }, `${what} is refused`);
    assert.deepEqual(await fingerprint(server.urlFor('target')), before, `${what}: the target is byte for byte what it was`);
  }
  await assert.rejects(runRestore({ databaseUrl: server.urlFor('target'), storage, key: 'backups/daily-99.dump' }), /not found/i, 'a name that is not there');
  assert.deepEqual(await fingerprint(server.urlFor('target')), before);
});

test('Q-08: a good backup restored into a database that is not empty leaves nothing of what was there, and no mixture of businesses', { skip, timeout: 900_000 }, async () => {
  const server = await makeServer();
  await server.createDatabase('source');
  await server.createDatabase('target');
  await populated(server.urlFor('source'), { slugs: ['alpha', 'beta'] });
  await populated(server.urlFor('target'), { slugs: ['gamma', 'delta'], products: 3 });
  const { default: pgClient } = await import('pg');
  const stray = new pgClient.Client({ connectionString: server.urlFor('target') });
  await stray.connect();
  await stray.query('CREATE TABLE left_over (id int, note text)');
  await stray.query(`INSERT INTO left_over VALUES (1, 'not part of any backup')`);
  await stray.end();

  const storage = memoryStorage();
  await runBackup({ databaseUrl: server.urlFor('source'), storage });
  const source = await fingerprint(server.urlFor('source'));
  const untouched = await fingerprint(server.urlFor('target'));
  const outcome = await runRestore({ databaseUrl: server.urlFor('target'), storage }).then(() => 'restored', () => 'refused');
  const target = await fingerprint(server.urlFor('target'));
  if (outcome === 'restored') {
    for (const [table, value] of Object.entries(source)) assert.equal(target[table], value, `${table}: rows and checksum match the backup`);
    assert.equal(target.left_over, undefined, 'what was in the target and not in the backup is gone');
    const t = new pgClient.Client({ connectionString: server.urlFor('target') });
    await t.connect();
    const slugs = (await t.query('SELECT slug FROM tenants ORDER BY 1')).rows.map((r) => r.slug).filter((s) => !['default'].includes(s));
    await t.end();
    assert.deepEqual(slugs.filter((s) => s !== 'alpha' && s !== 'beta'), [], `no business of the old target survives (found ${slugs})`);
  } else {
    assert.ok(target.left_over, 'refused: the stray table is still there, so nothing changed');
    assert.deepEqual(target, untouched, 'refused: the target is exactly what it was');
  }
});

test('Q-08: after a restore the app login reads one business at a time and nothing with none set, and cannot change a table', { skip, timeout: 900_000 }, async () => {
  const server = await makeServer();
  await server.createDatabase('source');
  await server.createDatabase('target');
  await populated(server.urlFor('source'), { slugs: ['alpha', 'beta'] });
  const storage = memoryStorage();
  await runBackup({ databaseUrl: server.urlFor('source'), storage });
  await runRestore({ databaseUrl: server.urlFor('target'), storage });

  const targetOwner = server.urlFor('target');
  const appUrl = new URL(targetOwner);
  appUrl.username = 'bhava_app_drill';
  appUrl.password = 'drill-app-password-1';
  const { default: pgClient } = await import('pg');
  const owner = new pgClient.Client({ connectionString: targetOwner });
  await owner.connect();
  await ensureAppLogin({ exec: (sql) => owner.query(sql), query: async (sql, params) => (await owner.query(sql, params)).rows }, appUrl.href);
  const ids = Object.fromEntries((await owner.query(`SELECT slug, id FROM tenants WHERE slug IN ('alpha', 'beta')`)).rows.map((r) => [r.slug, r.id]));
  await owner.end();
  assert.ok(ids.alpha && ids.beta, 'both businesses came back');

  const app = new pgClient.Client({ connectionString: appUrl.href });
  await app.connect();
  try {
    const none = await app.query('SELECT count(*)::int AS n FROM products').then((r) => r.rows[0].n, () => 0);
    assert.equal(none, 0, 'with no business set the login sees no business rows');
    for (const [mine, theirs] of [['alpha', 'beta'], ['beta', 'alpha']]) {
      await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [String(ids[mine])]);
      const seen = (await app.query('SELECT DISTINCT tenant_id FROM products')).rows.map((r) => r.tenant_id);
      assert.deepEqual(seen, [ids[mine]], `${mine} sees only its own products`);
      const other = (await app.query('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [ids[theirs]])).rows[0].n;
      assert.equal(other, 0, `${mine} asking for ${theirs} by number gets nothing`);
      await assert.rejects(app.query('INSERT INTO products (tenant_id, name, slug, price_paise) VALUES ($1, $2, $3, 100)', [ids[theirs], 'smuggled', 'smuggled']), /row-level security|violates/i, 'and cannot write into the other');
      await assert.rejects(app.query('DROP TABLE products'), /must be owner|permission denied/i, 'the app login cannot change a table');
    }
  } finally {
    await app.end();
  }
});

// ---- the tool -------------------------------------------------------------------------------------------------------------------

const reportOf = (name) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'test-results', name, 'report.json'), 'utf8'));
let serial = 0;
const name = (part) => `p8-spec-drill-${part}-${process.pid}-${++serial}`;

test('Q-08: the timed drill restores into an empty Postgres: counts and checksums match, the fence and both logins work, the app starts', { skip, timeout: 1_800_000 }, async () => {
  const out = name('restore');
  const report = await runDrill({ only: ['restore'], out, budgets: loadBudgets() });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
  const q8 = report.checks.filter((c) => c.id === 'Q-08');
  const names = q8.map((c) => c.name).join('|');
  for (const step of ['compare', 'fence', 'logins', 'start']) assert.match(names, new RegExp(step, 'i'), `a Q-08 check for ${step}`);
  assert.ok(report.checks.some((c) => /restore/i.test(c.name) && /second|time|within/i.test(`${c.name} ${c.limit}`)), 'the restore is timed against its budget');
  const onDisk = reportOf(out);
  assert.equal(onDisk.ok, true);
  assert.ok(fs.existsSync(path.join(repoRoot, 'test-results', out, 'report.md')));
  assert.doesNotMatch(JSON.stringify(onDisk), /postgres(ql)?:\/\/[^\s"]*:[^\s"@]+@/i, 'no database password in the written report');
  assert.match(JSON.stringify(report.summary), /backup|bytes|KB|MB/i);
});

test('Q-09: the drill\'s refuse part tries all three damaged backups and the report names each one', { skip, timeout: 1_800_000 }, async () => {
  const out = name('refuse');
  const report = await runDrill({ only: ['refuse'], out, budgets: loadBudgets() });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
  const q9 = report.checks.filter((c) => c.id === 'Q-09');
  assert.ok(q9.length >= 1);
  const text = JSON.stringify(report);
  for (const kind of Object.keys(BAD_BACKUPS)) assert.match(text, new RegExp(kind.replace('_', '[ _]'), 'i'), `${kind} is in the report`);
});

test('Q-08: a restore slower than its budget fails the drill, and says so', { skip, timeout: 1_800_000 }, async () => {
  const b = structuredClone(loadBudgets());
  b.drill = { restoreWithinSeconds: 0.001 };
  const out = name('slow');
  const report = await runDrill({ only: ['restore'], out, budgets: b });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => !c.ok && /restore/i.test(c.name)), 'the restore check is the one that failed');
});

test('Q-08: the whole drill, every step in order, with the refusals', { skip: skip || (FULL ? false : 'full version: P8_FULL=1'), timeout: 3_000_000 }, async () => {
  const report = await runDrill({ only: [], out: name('all'), budgets: loadBudgets() });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
  assert.ok(report.checks.length >= DRILL_STEPS.length - 3);
});

// The drill's building blocks that need no database: damaging a backup, reading its header, the checksum statement and the
// comparison of two snapshots. The steps that do need Postgres are in drill-steps.test.js.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BAD_BACKUPS, checksumSql } from '../../../tools/drill/index.mjs';
import { READABLE, checkBackup, damage, headerProblem, readHeader, toolEnv } from '../../../tools/drill/backup-check.mjs';
import { coverage, diffSnapshots } from '../../../tools/drill/compare.mjs';

/** Something that looks like a custom-format archive to its first bytes: PGDMP, 1.15.0, then a body. */
const archive = (size = 6000) => Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, 15, 0, 4, 8]), crypto.randomBytes(size)]);

test('the header: a good one reads, anything else says what is wrong', () => {
  assert.equal(readHeader(archive()).version, '1.15.0');
  assert.equal(headerProblem(archive()), null);
  assert.match(headerProblem(Buffer.from('not a backup at all, just text')), /does not start as a PostgreSQL custom-format backup/);
  assert.match(headerProblem(Buffer.alloc(3)), /does not start as/);
  const old = archive();
  old[6] = READABLE.minMinor - 1;
  assert.match(headerProblem(old), /format version 1\.11\.0/);
  const next = archive();
  next[6] = READABLE.maxMinor + 1;
  assert.match(headerProblem(next), /format version/);
  const major = archive();
  major[5] = 2;
  assert.match(headerProblem(major), /format version 2\./);
});

test('Q-09: the three damaged copies are made as BAD_BACKUPS says, and the good one is not touched', () => {
  const good = archive();
  const before = Buffer.from(good);
  const cut = damage(good, 'truncated');
  assert.equal(cut.length, Math.floor((good.length * 2) / 3));
  assert.ok(cut.equals(good.subarray(0, cut.length)), 'the front of the file is as it was');
  const bent = damage(good, 'corrupted');
  assert.equal(bent.length, good.length);
  const changed = [...bent].reduce((n, byte, i) => n + (byte === good[i] ? 0 : 1), 0);
  assert.ok(changed >= 8 && changed <= 512, `a run of bytes changed: ${changed}`);
  assert.ok(bent.subarray(0, 100).equals(good.subarray(0, 100)), 'the header and the start are as they were');
  assert.equal(headerProblem(bent), null, 'the damage is in the data, so the first look cannot see it');
  const wrong = damage(good, 'wrong_version');
  assert.equal(wrong.length, good.length);
  assert.match(headerProblem(wrong), /format version 1\.99\.0/);
  assert.ok(good.equals(before), 'damage works on a copy');
  assert.deepEqual(Object.keys(BAD_BACKUPS), ['truncated', 'corrupted', 'wrong_version']);
  assert.deepEqual(damage(good, 'corrupted'), damage(good, 'corrupted'), 'the same input always gives the same damage');
  assert.throws(() => damage(good, 'melted'), /Unknown kind/);
});

test('checkBackup: a file that is not there, or is not a backup, or has a wrong header is refused before pg_restore is asked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-check-'));
  try {
    assert.deepEqual(await checkBackup(path.join(dir, 'missing.dump')), { ok: false, reason: 'The backup file cannot be read.' });
    const text = path.join(dir, 'text.dump');
    fs.writeFileSync(text, 'hello, this is not a backup, only some text of some length');
    assert.match((await checkBackup(text)).reason, /does not start as/);
    const wrong = path.join(dir, 'wrong.dump');
    fs.writeFileSync(wrong, damage(archive(), 'wrong_version'));
    const refused = await checkBackup(wrong, { env: { ...process.env, PATH: dir, Path: dir } });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /format version 1\.99\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBackup: with no pg_restore to read it, a good-looking file is refused, never passed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-check-'));
  try {
    const file = path.join(dir, 'good.dump');
    fs.writeFileSync(file, archive());
    const result = await checkBackup(file, { env: { PATH: dir, Path: dir, SystemRoot: process.env.SystemRoot } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /pg_restore cannot read the backup/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PG_BIN_DIR goes first on the path for the pg tools, and leaves the rest of the environment alone', () => {
  const sep = process.platform === 'win32' ? ';' : ':';
  const key = process.platform === 'win32' ? 'Path' : 'PATH';
  const env = toolEnv({ [key]: `a${sep}b`, PG_BIN_DIR: 'pgbin', OTHER: '1' });
  assert.equal(env[key], `pgbin${sep}a${sep}b`);
  assert.equal(env.OTHER, '1');
  assert.deepEqual(toolEnv({ [key]: 'a' }), { [key]: 'a' });
});

test('the checksum statement is one statement that names no value, orders by the key, and takes the business as a parameter', () => {
  assert.equal(checksumSql('orders', ['id']), `SELECT count(*)::int AS rows, COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') AS checksum FROM orders t`);
  assert.equal(checksumSql('order_items', ['tenant_id', 'id'], { tenantColumn: 'tenant_id' }).includes('WHERE t.tenant_id = $1'), true);
  for (const bad of ['orders t; DROP TABLE x', 'Orders', 'o"rders', '', '1orders']) assert.throws(() => checksumSql(bad, ['id']), /not a table or column name/, bad);
  assert.throws(() => checksumSql('orders', ['id; select 1']), /not a table or column name/);
  assert.throws(() => checksumSql('orders', ['id'], { tenantColumn: 'x y' }), /not a table or column name/);
});

const table = (whole, tenants = {}) => ({ keys: ['id'], tenantColumn: Object.keys(tenants).length ? 'tenant_id' : '', whole, tenants });
const snap = (overrides = {}) => ({
  tenantIds: [1, 2],
  tables: {
    tenants: table({ rows: 2, checksum: 'aa' }),
    orders: table({ rows: 5, checksum: 'bb' }, { 1: { rows: 3, checksum: 'b1' }, 2: { rows: 2, checksum: 'b2' } }),
    products: table({ rows: 4, checksum: 'cc' }, { 1: { rows: 2, checksum: 'c1' }, 2: { rows: 2, checksum: 'c2' } }),
  },
  sequences: { orders_id_seq: '5', products_id_seq: '4' },
  grants: ['orders:bhava_app:SELECT', 'orders:bhava_app:INSERT'],
  security: { tables: ['orders:rls:forced'], policies: ['orders:p:ALL:{public}:(tenant_id = 1):'] },
  ...overrides,
});
const clone = () => JSON.parse(JSON.stringify(snap()));

test('Q-08: two snapshots that are the same differ in nothing; each kind of difference is named by table and business, without a row', () => {
  assert.deepEqual(diffSnapshots(snap(), clone()), []);
  const fewer = clone();
  fewer.tables.orders.whole.rows = 4;
  fewer.tables.orders.tenants[2].rows = 1;
  const a = diffSnapshots(snap(), fewer);
  assert.deepEqual(a, ['table orders: 5 rows in the source, 4 after restore', 'table orders, business 2: 2 rows in the source, 1 after restore']);
  const bent = clone();
  bent.tables.products.tenants[1].checksum = 'zz';
  assert.deepEqual(diffSnapshots(snap(), bent), ['table products, business 1: same 2 rows but a different checksum']);
  const whole = clone();
  whole.tables.tenants.whole.checksum = 'q';
  assert.deepEqual(diffSnapshots(snap(), whole), ['table tenants: same 2 rows but a different checksum']);
  const missing = clone();
  delete missing.tables.orders;
  assert.deepEqual(diffSnapshots(snap(), missing), ['table orders: missing after restore']);
  const extra = clone();
  extra.tables.leftover = table({ rows: 1, checksum: 'x' });
  assert.deepEqual(diffSnapshots(snap(), extra), ['table leftover: not in the source']);
  const fewerBusinesses = clone();
  fewerBusinesses.tenantIds = [1];
  delete fewerBusinesses.tables.orders.tenants[2];
  assert.ok(diffSnapshots(snap(), fewerBusinesses).some((line) => /the businesses differ: 2 in the source, 1 after restore/.test(line)));
  assert.ok(diffSnapshots(snap(), fewerBusinesses).some((line) => /business 2: missing after restore/.test(line)));
  const sequence = clone();
  sequence.sequences.orders_id_seq = '3';
  assert.deepEqual(diffSnapshots(snap(), sequence), ['sequence orders_id_seq: 5 in the source, 3 after restore']);
});

test('Q-08: grants and security settings are compared as sets, and each part of the comparison can be asked for alone', () => {
  const grants = clone();
  grants.grants = ['orders:bhava_app:SELECT', 'orders:bhava_app:DELETE'];
  assert.deepEqual(diffSnapshots(snap(), grants, { only: ['grants'] }), ['grant: missing after restore: orders:bhava_app:INSERT', 'grant: not in the source: orders:bhava_app:DELETE']);
  assert.deepEqual(diffSnapshots(snap(), grants, { only: ['rows', 'sequences'] }), [], 'the rows are the same');
  const security = clone();
  security.security.tables = ['orders:open:owner-exempt'];
  security.security.policies = [];
  const lines = diffSnapshots(snap(), security, { only: ['security'] });
  assert.equal(lines.length, 3);
  assert.match(lines.join('\n'), /row-level security: missing after restore: orders:rls:forced/);
  assert.match(lines.join('\n'), /policy: missing after restore: orders:p:ALL/);
  const many = clone();
  for (let i = 0; i < 40; i++) many.tables[`t${i}`] = table({ rows: 1, checksum: 'x' });
  assert.equal(diffSnapshots(snap(), many).length, 25, 'a long list is cut, not printed whole');
});

test('coverage says how much was compared', () => {
  assert.deepEqual(coverage(snap()), { tables: 3, businesses: 2, rows: 11, tenantTables: 2 });
});

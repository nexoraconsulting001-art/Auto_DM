// R-07 / G-12: the data move from the VM. The databases here are PGlite (real Postgres in process); pg_restore is
// stood in for by a clone of the source's data folder, which is what a finished single-transaction restore leaves.
// The real pg_dump and pg_restore run in npm run check:r07 (CI), not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '../../../src/db/index.js';
import { pgRollups } from '../../../src/platform/analytics-rollups.js';
import { withTenant } from '../../../src/tenancy.js';
import { MoveError, STEPS, copyRollups, fingerprint, parseArgs, readFingerprint, restoreDump, targetState, toolProblem, verifyTarget } from '../../../scripts/move-to-cloud.js';
import { ROOT } from './support.js';

/** The two shapes the code uses: a client (query -> { rows }) and a db (query -> rows, exec, tx). */
const asDb = (pg) => ({
  query: async (sql, params) => (await pg.query(sql, params)).rows,
  exec: (sql) => pg.exec(sql),
  tx: (fn) => pg.transaction((t) => fn({ query: async (sql, params) => (await t.query(sql, params)).rows, exec: (sql) => t.exec(sql) })),
});
/** A client whose database can be swapped, as a restore replaces what the target holds. */
const swappable = (pg) => {
  const box = { pg };
  return { box, query: (sql, params) => box.pg.query(sql, params) };
};

const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03'];
async function seed(pg) {
  await runMigrations(asDb(pg));
  await pg.query("UPDATE schema_migrations SET applied_at = '2026-10-01T00:00:00Z'");
  const ids = [];
  for (const slug of ['qxalpha', 'qxbeta']) {
    ids.push((await pg.query("INSERT INTO tenants (slug, name, created_at) VALUES ($1, $1, '2026-09-01T00:00:00Z') RETURNING id", [slug])).rows[0].id);
  }
  const rollups = pgRollups(asDb(pg));
  for (const [i, id] of ids.entries()) {
    await withTenant({ id }, () => rollups.write('traffic_daily', DAYS.map((day, d) => ({ day, hour: d, weekday: 3, source: 'zq-src-7', sessions: 10 * (i + 1) + d, bounces: d, page_views: 30 + d }))));
  }
  return ids;
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-move-'));
let source;
let ids;
let dumpFile;
let dumpBlob;

test.before(async () => {
  source = new PGlite();
  ids = await seed(source);
  dumpBlob = await source.dumpDataDir();
  dumpFile = path.join(scratch(), 'vm.dump');
  fs.writeFileSync(dumpFile, Buffer.from(await dumpBlob.arrayBuffer()));
});
test.after(async () => {
  await source?.close();
});

/** Stands in for pg_restore: the target becomes the backup's data, all at once, or (failing) stays as it was. */
const cloneRestore = (target, { fail = false } = {}) => async () => {
  if (fail) throw new Error("pg_restore: error: COPY failed for table \"orders\": line 3: 'Priya 98xxxxxx01'");
  const pg = new PGlite({ loadDataDir: new Blob([fs.readFileSync(dumpFile)]) });
  await pg.waitReady;
  // A data folder copied while running comes back like a crash: each sequence a little ahead. pg_restore sets them exactly.
  for (const { name, last_value: v } of (await source.query("SELECT sequencename AS name, last_value FROM pg_sequences WHERE schemaname = 'public' AND last_value IS NOT NULL")).rows) {
    await pg.query("SELECT setval($1::regclass, $2::bigint)", [`public.${name}`, v]);
  }
  target.box.pg = pg;
};
const okCheck = async () => ({ ok: true });

test('R-07 the steps and their arguments; a bad argument is refused before anything runs', () => {
  assert.deepEqual(STEPS, ['fingerprint', 'restore', 'verify', 'rollups', 'schema']);
  assert.deepEqual(parseArgs(['restore', '--dump', 'x.dump']), { step: 'restore', dump: 'x.dump' });
  assert.deepEqual(parseArgs(['verify', '--fingerprint=f.json', '--files', 's.jsonl']), { step: 'verify', fingerprint: 'f.json', files: 's.jsonl' });
  for (const bad of [[], ['move'], ['restore'], ['restore', '--dump'], ['restore', '--target', 'x'], ['fingerprint', '--out', '--dump']]) {
    assert.throws(() => parseArgs(bad), (e) => e instanceof MoveError && e.exitCode === 2, bad.join(' '));
  }
  const cli = spawnSync(process.execPath, ['scripts/move-to-cloud.js', 'restore'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: '', DATABASE_OWNER_URL: '' } });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /restore needs --dump/);
});

test('R-07 the fingerprint reads the VM in one read-only snapshot and changes nothing there', async () => {
  const seen = [];
  const spy = { query: (sql, params) => { seen.push(sql.trim()); return source.query(sql, params); } };
  const before = await fingerprint(source);
  const fp = await fingerprint(spy, { now: new Date('2026-11-15T00:00:00Z') });
  assert.equal(seen[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(seen.at(-1), 'ROLLBACK');
  assert.deepEqual(seen.filter((s) => !/^(BEGIN TRANSACTION|ROLLBACK$|SET |SELECT )/.test(s)), [], 'only reads and session settings');
  assert.deepEqual(fp.snapshot, before.snapshot, 'reading twice sees the same database');
  assert.deepEqual(fp.coverage.businesses, 2);
  assert.equal(fp.snapshot.tables.traffic_daily.tenants[ids[1]].rows, 3);
  const text = JSON.stringify(fp);
  assert.doesNotMatch(text, /zq-src-7|qxalpha|qxbeta/, 'no row of data is in the fingerprint');
  const file = path.join(scratch(), 'fp.json');
  fs.writeFileSync(file, text);
  assert.deepEqual(readFingerprint(file).snapshot, fp.snapshot);
  fs.writeFileSync(file, '{"format":"other"}');
  assert.throws(() => readFingerprint(file), /not a fingerprint/);
});

test('R-07 restore refuses a target that is not empty, and writes nothing to it', async () => {
  const busy = new PGlite();
  try {
    await runMigrations(asDb(busy));
    await assert.rejects(restoreDump({ dumpFile, owner: busy, ownerUrl: 'postgres://owner@db.test/bhava', tools: { check: okCheck, restore: () => assert.fail('restored into a busy target') } }),
      (e) => e.code === 'target_not_empty' && e.exitCode === 2);
    const { rows } = await busy.query("SELECT to_regnamespace('bhava_move') AS ns");
    assert.equal(rows[0].ns, null, 'not even the restore record was written');
  } finally {
    await busy.close();
  }
});

test('R-07 restore: a bad backup is refused first; a failure leaves the target empty and can be re-run; a finished one is not redone', async () => {
  const target = swappable(new PGlite());
  const ownerUrl = 'postgres://owner@db.test/bhava';
  await assert.rejects(restoreDump({ dumpFile, owner: target, ownerUrl, tools: { check: async () => ({ ok: false, reason: 'the archive is cut short' }), restore: () => assert.fail('restored a bad backup') } }),
    (e) => e.code === 'bad_backup' && /cut short/.test(e.message));
  assert.equal((await targetState(target)).relations, 0);

  // Interrupted: the tool fails; the message keeps no quoted value from the tool's output.
  await assert.rejects(restoreDump({ dumpFile, owner: target, ownerUrl, tools: { check: okCheck, restore: cloneRestore(target, { fail: true }) } }), (e) => {
    assert.equal(e.code, 'restore_failed');
    assert.doesNotMatch(e.message, /Priya|98xx/);
    return true;
  });
  const failed = await targetState(target);
  assert.equal(failed.relations, 0, 'nothing of the backup is left behind');
  assert.equal(failed.record.status, 'failed');

  // Re-run: it goes through.
  const first = await restoreDump({ dumpFile, owner: target, ownerUrl, tools: { check: okCheck, restore: cloneRestore(target) } });
  assert.equal(first.status, 'restored');
  assert.ok((await targetState(target)).relations > 50);
  // Again: nothing is redone.
  const again = await restoreDump({ dumpFile, owner: target, ownerUrl, tools: { check: okCheck, restore: () => assert.fail('restored twice') } });
  assert.equal(again.status, 'already_restored');
  // A different backup into the same target is refused.
  const other = path.join(scratch(), 'other.dump');
  fs.writeFileSync(other, 'not the same backup');
  await assert.rejects(restoreDump({ dumpFile: other, owner: target, ownerUrl, tools: { check: okCheck, restore: () => assert.fail('restored over another backup') } }), (e) => e.code === 'target_has_other_backup');

  // Verify: the restored target matches the fingerprint of the source.
  const fp = await fingerprint(source);
  const same = await verifyTarget({ fp, owner: target });
  assert.deepEqual(same.differences, []);
  assert.equal(same.ok, true);

  // One business's row changed: named by table and business, never by its values.
  await target.query("UPDATE traffic_daily SET sessions = sessions + 1 WHERE tenant_id = $1 AND day = '2026-10-02'", [ids[1]]);
  const changed = await verifyTarget({ fp, owner: target });
  assert.equal(changed.ok, false);
  assert.ok(changed.differences.some((d) => d === `table traffic_daily, business ${ids[1]}: same 3 rows but a different checksum`), changed.differences.join('\n'));
  assert.ok(!changed.differences.some((d) => d.includes(`business ${ids[0]}:`)), 'the other business is not blamed');
  assert.doesNotMatch(changed.differences.join('\n'), /zq-src-7|qxalpha|qxbeta/);
  // A row missing: a count difference.
  await target.query("DELETE FROM traffic_daily WHERE tenant_id = $1 AND day = '2026-10-01'", [ids[0]]);
  const missing = await verifyTarget({ fp, owner: target });
  assert.ok(missing.differences.includes(`table traffic_daily, business ${ids[0]}: 3 rows in the source, 2 in the target`), missing.differences.join('\n'));
  // A newer migration run before verify is called out.
  await target.query("INSERT INTO schema_migrations (version, applied_at) VALUES ('999', '2026-11-01T00:00:00Z')");
  const migrated = await verifyTarget({ fp, owner: target });
  assert.ok(migrated.differences.some((d) => /run verify before the schema step/.test(d)));
  await target.box.pg.close();
});

test('R-07 the analytics summaries move business by business, a re-run changes nothing, and a lost row is caught', async () => {
  const analytics = new PGlite();
  try {
    await runMigrations(asDb(analytics));
    for (const slug of ['qxalpha', 'qxbeta']) await analytics.query("INSERT INTO tenants (slug, name, created_at) VALUES ($1, $1, '2026-09-01T00:00:00Z')", [slug]);
    const target = pgRollups(asDb(analytics));
    const first = await copyRollups({ owner: asDb(source), rollups: target });
    assert.deepEqual(first.problems, []);
    assert.equal(first.businesses, 2);
    assert.equal(first.rows, 6);
    const again = await copyRollups({ owner: asDb(source), rollups: target });
    assert.deepEqual(again.problems, []);
    const { rows } = await analytics.query('SELECT tenant_id, sum(sessions)::int AS s, count(*)::int AS n FROM traffic_daily GROUP BY 1 ORDER BY 1');
    assert.deepEqual(rows.map((r) => [r.n, r.s]), [[3, 33], [3, 63]], 'each business has its own rows, once');
    // A store that loses one day's rows is reported, by store, business and measure.
    const lossy = { ...target, rebuild: (name, range, dayRows) => target.rebuild(name, range, range.since === '2026-10-03' ? [] : dayRows) };
    const lost = await copyRollups({ owner: asDb(source), rollups: lossy });
    assert.ok(lost.problems.some((p) => /^rollup traffic_daily, business \d+: sessions totals \d+ in Postgres, \d+ in the analytics database$/.test(p)), lost.problems.join('\n'));
  } finally {
    await analytics.close();
  }
});

test('R-07 a tool error keeps its first line and drops the values it quotes', () => {
  assert.equal(toolProblem("pg_restore: error: could not execute query: ERROR:  duplicate key value 'Priya'\nCommand was: COPY public.orders"), "pg_restore: error: could not execute query: ERROR:  duplicate key value '…'");
  assert.doesNotMatch(toolProblem('pg_restore: error: COPY failed for table "orders": line 3: Priya,9800000001'), /Priya|9800/);
});

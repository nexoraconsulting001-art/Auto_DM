// The drill with the real backup and restore code and the real pg_dump and pg_restore (Q-08, Q-09, R-03). It needs the PostgreSQL 16
// client programs on the PATH or in PG_BIN_DIR, which not every machine has: where they are missing the test is skipped, and says
// why. CI installs them (postgresql-client-16). The steps themselves are covered without them in drill-steps.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../../../tools/drill/index.mjs';
import { checkBackup, damage, pgTools } from '../../../tools/drill/backup-check.mjs';
import { loadBudgets } from '../../../tools/load/stack.mjs';

const tools = await pgTools();
const skip = tools.missing ? `needs pg_dump and pg_restore 16 (${tools.missing} was not found; set PG_BIN_DIR)` : false;

test('Q-08 and Q-09: the real drill, with the real tools, passes every step', { skip, timeout: 1_200_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-drill-real-'));
  try {
    const report = await run({ budgets: loadBudgets(), only: [], out: 'drill', root, say: () => {} });
    assert.deepEqual(report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.measured}`), []);
    assert.equal(report.ok, true);
    assert.equal(report.ofRecord, true);
    assert.ok(report.data.backup.bytes > 10_000);
    assert.ok(report.data.restore.seconds < loadBudgets().drill.restoreWithinSeconds);
    for (const kind of ['truncated', 'corrupted', 'wrong_version']) {
      assert.equal(report.data.refuse[kind].precheckRefused, true, `${kind}: refused by the read-through check`);
      assert.equal(report.data.refuse[kind].restoreRefused, true, `${kind}: refused by pg_restore`);
      assert.equal(report.data.refuse[kind].targetChanged, 0, `${kind}: target untouched`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkBackup with the real pg_restore: a real archive reads through; the three damaged copies do not', { skip, timeout: 300_000 }, async () => {
  const { startPostgres, loadBudgets: budgets } = await import('../../../tools/load/stack.mjs');
  const { spawnSync } = await import('node:child_process');
  const { toolEnv } = await import('../../../tools/drill/backup-check.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-check-real-'));
  const server = await startPostgres({ dir: path.join(dir, 'pg'), budgets: budgets() });
  try {
    const url = new URL(server.ownerUrl);
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: server.ownerUrl });
    await client.connect();
    await client.query("CREATE TABLE sample AS SELECT g AS id, md5(g::text) AS text FROM generate_series(1, 30000) g");
    await client.end();
    const file = path.join(dir, 'good.dump');
    const dump = spawnSync('pg_dump', ['--format=custom', '--no-owner', `--file=${file}`], { env: { ...toolEnv(), PGHOST: url.hostname, PGPORT: url.port, PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1) } });
    assert.equal(dump.status, 0, String(dump.stderr).split('\n')[0]);
    assert.deepEqual(await checkBackup(file), { ok: true });
    const good = fs.readFileSync(file);
    for (const kind of ['truncated', 'corrupted', 'wrong_version']) {
      const bad = path.join(dir, `${kind}.dump`);
      fs.writeFileSync(bad, damage(good, kind));
      const result = await checkBackup(bad);
      assert.equal(result.ok, false, `${kind} must be refused`);
    }
  } finally {
    await server.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

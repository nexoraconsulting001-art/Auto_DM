// The drill's steps on a real Postgres with the real app, with a stand-in for the two programs that need the PostgreSQL client
// tools (pg_dump and pg_restore are not on every machine). The stand-in "backup" is a framed file and its "restore" copies the
// database with CREATE DATABASE ... TEMPLATE, so the seed, compare, fence, logins, start and refuse steps all run for real.
// The real round trip, with the real tools, is in drill-real.test.js and is skipped where the tools are missing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { DRILL_STEPS, run } from '../../../tools/drill/index.mjs';
import { headerProblem } from '../../../tools/drill/backup-check.mjs';
import { loadBudgets } from '../../../tools/load/stack.mjs';

const budgets = loadBudgets();
const swapDatabase = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.href;
};

/** The stand-ins. `tamper` changes the restored copy; `lenient` makes the restore accept anything. */
function standIns({ tamper = false, lenient = false } = {}) {
  const state = { sourceUrl: null };
  const frame = (body) => {
    const head = Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, 15, 0]), body]);
    return Buffer.concat([head, crypto.createHash('sha256').update(head).digest()]);
  };
  const problemWith = (buffer) => {
    const header = headerProblem(buffer);
    if (header) return header;
    const head = buffer.subarray(0, buffer.length - 32);
    return crypto.createHash('sha256').update(head).digest().equals(buffer.subarray(buffer.length - 32)) ? null : 'The backup is cut short or damaged.';
  };
  return {
    pgTools: async () => ({ pg_dump: 'stand-in', pg_restore: 'stand-in' }),
    checkBackup: async (file) => {
      const problem = problemWith(fs.readFileSync(file));
      return problem ? { ok: false, reason: problem } : { ok: true };
    },
    startTarget: async ({ source }) => ({ ownerUrl: swapDatabase(source.ownerUrl, 'restored'), appUrl: swapDatabase(source.appUrl, 'restored'), stop: async () => {} }),
    runBackup: async ({ databaseUrl, storage }) => {
      state.sourceUrl = databaseUrl;
      const data = frame(crypto.randomBytes(4000));
      await storage.put('backups/daily-01.dump', data, 'application/octet-stream');
      return { key: 'backups/daily-01.dump', bytes: data.length };
    },
    runRestore: async ({ storage, key }) => {
      const data = await storage.get(key);
      if (lenient && key !== 'backups/daily-01.dump') return { key, bytes: data.length };
      const problem = problemWith(data);
      if (problem) throw new Error(problem);
      const admin = new pg.Client({ connectionString: swapDatabase(state.sourceUrl, 'postgres') });
      admin.on('error', () => {});
      await admin.connect();
      try {
        await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'bhava' AND pid <> pg_backend_pid()`);
        await admin.query('CREATE DATABASE restored TEMPLATE bhava');
      } finally {
        await admin.end();
      }
      if (tamper) {
        const copy = new pg.Client({ connectionString: swapDatabase(state.sourceUrl, 'restored') });
        copy.on('error', () => {});
        await copy.connect();
        try {
          await copy.query(`UPDATE products SET name = name || ' (changed)' WHERE id = (SELECT min(id) FROM products)`);
        } finally {
          await copy.end();
        }
      }
      return { key, bytes: data.length };
    },
  };
}

const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-drill-test-'));
const checkOf = (report, text) => report.checks.find((c) => c.name.includes(text));

test('Q-08 and Q-09: the whole drill passes on a good restore, with every step timed, every table compared and the three bad backups refused', { timeout: 900_000 }, async () => {
  const root = dirOf();
  const quiet = [];
  const report = await run({ budgets, only: [], out: 'drill', root, say: (m) => quiet.push(m), deps: { ...standIns(), businesses: 2, seedSeconds: 5 } });
  try {
    assert.equal(report.ok, true, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.measured}`).join('\n'));
    assert.deepEqual(report.checks.map((c) => c.id), ['', 'R-03', 'R-03', 'Q-08', 'Q-08', 'Q-08', 'Q-08', 'Q-09']);
    assert.deepEqual(Object.keys(report.data.timingsSeconds), [...DRILL_STEPS]);
    const compare = report.data.compare;
    assert.ok(compare.tables > 100, `every table is compared: ${compare.tables}`);
    assert.ok(compare.businesses >= 2 && compare.rows > 50 && compare.tenantTables > 50, JSON.stringify(compare));
    assert.deepEqual(compare.differences, []);
    assert.ok(report.data.fence.checked > 300, `each business is read through the app login on each table: ${report.data.fence.checked}`);
    assert.deepEqual(report.data.logins.problems, []);
    assert.deepEqual(report.data.start.problems, []);
    for (const kind of ['truncated', 'corrupted', 'wrong_version']) {
      const result = report.data.refuse[kind];
      assert.equal(result.precheckRefused, true, `${kind}: read-through check`);
      assert.equal(result.restoreRefused, true, `${kind}: restore`);
      assert.equal(result.targetChanged, 0, `${kind}: target`);
    }
    const files = ['json', 'md'].map((ext) => fs.readFileSync(path.join(root, 'test-results', 'drill', `report.${ext}`), 'utf8'));
    assert.match(files[1], /^# Restore drill\n\nResult: \*\*PASS\*\*/);
    // No secret and no database address anywhere in what was written or said.
    for (const text of [...files, quiet.join('\n')]) {
      assert.doesNotMatch(text, /postgres(ql)?:\/\//i);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Q-08 and Q-09: a restored copy that differs by one value fails compare by table and business, and a restore that accepts a bad backup fails refuse', { timeout: 900_000 }, async () => {
  const root = dirOf();
  const report = await run({ budgets, only: [], out: 'drill-bad', root, say: () => {}, deps: { ...standIns({ tamper: true, lenient: true }), businesses: 2, seedSeconds: 4 } });
  try {
    assert.equal(report.ok, false);
    const compare = checkOf(report, 'row counts and checksums match');
    assert.equal(compare.ok, false);
    assert.match(compare.measured, /table products, business \d+: same \d+ rows but a different checksum/);
    assert.equal(checkOf(report, 'a truncated, corrupted and wrong-version backup').ok, false);
    assert.match(checkOf(report, 'a truncated, corrupted and wrong-version backup').measured, /the real restore accepted it/);
    assert.equal(checkOf(report, 'the fence').ok, true, 'a difference elsewhere does not hide what still works');
    assert.ok(report.data.compare.differences.length >= 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the drill stops at once, and says why, when the PostgreSQL client programs are not there', { timeout: 60_000 }, async () => {
  const root = dirOf();
  const said = [];
  try {
    const report = await run({ budgets, only: [], out: 'drill-none', root, say: (m) => said.push(m), deps: { pgTools: async () => ({ missing: 'pg_dump' }) } });
    assert.equal(report.ok, false);
    assert.equal(report.checks.length, 1);
    assert.match(report.checks[0].measured, /pg_dump not found/);
    assert.match(said.join(' '), /PG_BIN_DIR/);
    assert.ok(fs.existsSync(path.join(root, 'test-results', 'drill-none', 'report.json')), 'a report is written even then');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

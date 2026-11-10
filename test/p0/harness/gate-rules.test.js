import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkLedger, checkMigrations, checkRequirements, checkSkips, digestOf, e2eFolders, lockPhase, nodeTestGlobs,
  parsePhase, phaseFileHashes, phaseOf, readJson, repoRoot,
} from '../../../tools/gate-lib.mjs';

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-gate-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const passing = (root, n, byPhase = { [n]: { node: 3, e2e: 0 } }) => ({ phase: n, ok: true, byPhase, lockDigest: digestOf(phaseFileHashes(root, n)) });

test('a repeated migration number fails, and so does a file the runner would ignore', () => {
  const clean = checkMigrations(tree({ 'src/db/migrations/001_a.sql': '', 'src/db/migrations/002_b.sql': '' }));
  assert.deepEqual(clean, { count: 2, problems: [] });
  const bad = checkMigrations(tree({ 'src/db/migrations/003_a.sql': '', 'src/db/migrations/003_b.sql': '', 'src/db/migrations/4_c.sql': '' }));
  assert.equal(bad.problems.length, 2);
  assert.match(bad.problems.join('\n'), /Duplicate migration number 003: 003_a\.sql, 003_b\.sql/);
  assert.match(bad.problems.join('\n'), /4_c\.sql/);
});

test('this repository has no duplicate migrations', () => {
  assert.deepEqual(checkMigrations(repoRoot).problems, []);
});

test('a requirement needs a test name that starts with exactly its id', () => {
  const root = tree({ 'requirements/p0.json': JSON.stringify([{ id: 'F-11', title: 'a' }, { id: 'F-1', title: 'b' }, { id: 'U-02', title: 'c' }, { id: 'R-01', title: 'd' }]) });
  const { missing, total } = checkRequirements(root, 0, ['F-110 not it', 'F-11: covered', 'see U-02 in the middle', 'R-01']);
  assert.equal(total, 4);
  assert.deepEqual(missing, ['F-1', 'U-02']);
});

test('every phase up to N must have a valid requirement list', () => {
  const root = tree({ 'requirements/p0.json': '[]', 'requirements/p1.json': '[{"id":"lower-1","title":"x"}]', 'requirements/p2.json': 'not json' });
  const { problems } = checkRequirements(root, 3, []);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /p1\.json has an invalid entry/);
  assert.match(problems[1], /p2\.json is not valid JSON/);
  assert.match(problems[2], /p3\.json does not exist/);
  assert.match(checkRequirements(tree({ 'requirements/p0.json': '[{"id":"F-1","title":"a"},{"id":"F-1","title":"a"}]' }), 0, ['F-1 x']).problems[0], /twice/);
});

test('requirements/p0.json is well formed and holds short titles only', () => {
  const list = readJson(path.join(repoRoot, 'requirements', 'p0.json'));
  const { problems: shape } = checkRequirements(repoRoot, 0, list.map((r) => `${r.id} stand-in`));
  assert.deepEqual(shape, []);
  assert.equal(list.length, 52);
  assert.ok(list.every((r) => r.title.length <= 75), 'titles stay short');
});

test('a skip passes only when listed by name with a reason', () => {
  const allow = { tests: [{ name: 'ok', file: 'test/a.test.js', reason: 'no pg_dump' }, { name: 'bare', reason: ' ' }] };
  const { verdicts, problems } = checkSkips([
    { name: 'ok', file: 'test/a.test.js', kind: 'skip' },
    { name: 'ok', file: 'test/b.test.js', kind: 'skip' },
    { name: 'bare', file: 'test/a.test.js', kind: 'skip' },
    { name: 'ok', file: 'test/a.test.js', kind: 'todo' },
  ], allow);
  assert.deepEqual(verdicts.map((v) => v.allowed), [true, false, false, false]);
  assert.equal(problems.length, 4, 'three tests plus the entry with no reason');
  assert.match(problems[1], /Skipped test without an allowed reason: "bare"/);
  assert.match(problems[2], /Unfinished .* test without an allowed reason: "ok"/);
  assert.match(problems[3], /no name or no reason/);
});

test('phases are told apart by folder, and empty folders are left out', () => {
  assert.equal(phaseOf('test/accounts.test.js'), 0);
  assert.equal(phaseOf('test/p1/x/a.test.js'), 1);
  assert.equal(phaseOf('test/attack/p10/a.test.js'), 10);
  assert.equal(phaseOf('e2e/attack/p2/a.spec.js'), 2);
  const root = tree({ 'test/a.test.js': '', 'test/helpers.js': '', 'test/p0/x/b.test.js': '', 'test/p1/fixture.json': '{}', 'test/attack/p1/c/d.test.js': '', 'test/p10/e.test.js': '', 'e2e/p0/a.spec.js': '', 'e2e/attack/p1/b.txt': '' });
  assert.deepEqual(nodeTestGlobs(root, [0, 1]), ['test/*.test.js', 'test/p0/**/*.test.js', 'test/attack/p1/**/*.test.js']);
  assert.deepEqual(nodeTestGlobs(root, [1], { baseline: false }), ['test/attack/p1/**/*.test.js']);
  assert.deepEqual(e2eFolders(root, [0, 1]), ['e2e/p0']);
  for (const bad of ['', 'x', '-1', '1.5', undefined]) assert.throws(() => parsePhase(bad));
  assert.equal(parsePhase('4'), 4);
});

test('a locked file changing, disappearing or a falling count fails the gate', () => {
  const root = tree({ 'test/a.test.js': 'one', 'test/p0/b.test.js': 'two', 'test/p0/fixture.txt': 'three', 'requirements/p0.json': '[]' });
  const ledger = lockPhase({ root, ledger: { version: 1, phases: {} }, n: 0, summary: passing(root, 0), now: 'T' });
  assert.deepEqual(Object.keys(ledger.phases[0].files), ['requirements/p0.json', 'test/a.test.js', 'test/p0/b.test.js', 'test/p0/fixture.txt']);
  assert.deepEqual(checkLedger(root, ledger, 0, { 0: { node: 3, e2e: 0 } }).problems, []);
  assert.deepEqual(checkLedger(root, ledger, 2, { 0: { node: 5, e2e: 1 } }).problems, [], 'more tests is fine');

  fs.writeFileSync(path.join(root, 'test/p0/fixture.txt'), 'edited');
  fs.rmSync(path.join(root, 'test/a.test.js'));
  const { changed, lower } = checkLedger(root, ledger, 1, { 0: { node: 2, e2e: 0 } });
  assert.deepEqual(changed, ['test/a.test.js (locked in phase 0) is missing', 'test/p0/fixture.txt (locked in phase 0) has changed']);
  assert.deepEqual(lower, ['Phase 0 has 2 node test(s), the ledger has 3']);
});

test('line endings alone do not count as a change', () => {
  const root = tree({ 'test/p0/b.test.js': 'a\nb\n' });
  const before = phaseFileHashes(root, 0);
  fs.writeFileSync(path.join(root, 'test/p0/b.test.js'), 'a\r\nb\r\n');
  assert.deepEqual(phaseFileHashes(root, 0), before);
});

test('the ledger only checks phases up to the one being gated', () => {
  const root = tree({ 'test/p1/a.test.js': 'x', 'requirements/p1.json': '[]' });
  const ledger = lockPhase({ root, ledger: { version: 1, phases: {} }, n: 1, summary: passing(root, 1) });
  fs.writeFileSync(path.join(root, 'test/p1/a.test.js'), 'y');
  assert.deepEqual(checkLedger(root, ledger, 0, {}).problems, []);
  assert.equal(checkLedger(root, ledger, 1, { 1: { node: 3, e2e: 0 } }).changed.length, 1);
});

test('locking needs a passing gate for this phase and these exact files', () => {
  const root = tree({ 'test/p0/b.test.js': 'two' });
  const empty = { version: 1, phases: {} };
  assert.throws(() => lockPhase({ root, ledger: empty, n: 0 }), /run the gate first/);
  assert.throws(() => lockPhase({ root, ledger: empty, n: 0, summary: { ...passing(root, 0), ok: false } }), /did not pass/);
  assert.throws(() => lockPhase({ root, ledger: empty, n: 1, summary: passing(root, 0) }), /for phase 0, not 1/);
  const summary = passing(root, 0);
  fs.writeFileSync(path.join(root, 'test/p0/b.test.js'), 'changed after the gate');
  assert.throws(() => lockPhase({ root, ledger: empty, n: 0, summary }), /changed after the gate passed/);
  fs.writeFileSync(path.join(root, 'test/p0/b.test.js'), 'two');
  assert.equal(lockPhase({ root, ledger: empty, n: 0, summary, commit: 'abc' }).phases[0].commit, 'abc');
});

test('overwriting a locked file takes a written reason, which stays in the ledger', () => {
  const root = tree({ 'test/p0/b.test.js': 'two' });
  const ledger = lockPhase({ root, ledger: { version: 1, phases: {} }, n: 0, summary: passing(root, 0) });

  // New files may join a locked phase without a reason.
  fs.writeFileSync(path.join(root, 'test/p0/c.test.js'), 'new');
  const grown = lockPhase({ root, ledger, n: 0, summary: passing(root, 0) });
  assert.equal(Object.keys(grown.phases[0].files).length, 2);
  assert.equal(grown.phases[0].relocks, undefined);

  fs.writeFileSync(path.join(root, 'test/p0/b.test.js'), 'fixed');
  assert.throws(() => lockPhase({ root, ledger: grown, n: 0, summary: passing(root, 0) }), /already locked.*test\/p0\/b\.test\.js/);
  const relocked = lockPhase({ root, ledger: grown, n: 0, summary: passing(root, 0), reason: 'test asserted the wrong status', now: 'T2' });
  assert.deepEqual(relocked.phases[0].relocks, [{ at: 'T2', reason: 'test asserted the wrong status', files: ['test/p0/b.test.js'] }]);
});

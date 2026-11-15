// R-07 / G-12: local storage to object storage, with checksums and resume. The target here is a local folder (the
// same code path as object storage apart from listing); the S3 run is npm run check:r07 in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CopyError, businessOf, copyFiles, parseArgs, readState, targetStore, verifyCopy } from '../../../scripts/copy-files.js';
import { ROOT } from './support.js';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-copy-'));
const KEYS = ['t/1/media/a1', 't/1/media/a2', 't/1/exports/report.csv', 't/2/media/b1', 't/2/media/b2', 'backups/latest'];

function makeSource() {
  const dir = scratch();
  for (const key of KEYS) {
    fs.mkdirSync(path.join(dir, path.dirname(key)), { recursive: true });
    fs.writeFileSync(path.join(dir, key), crypto.randomBytes(200 + key.length));
  }
  // A write that never finished: local storage's temporary name.
  fs.writeFileSync(path.join(dir, 't/1/media/a3.4242.tmp'), 'half');
  return dir;
}
const fingerprintOf = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => { const f = path.join(e.parentPath ?? e.path, e.name); const s = fs.statSync(f); return `${path.relative(dir, f)}:${s.size}:${s.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`; }).sort();

test('R-07 a copy: every file read back and checked, per business counts, the source untouched', async () => {
  const source = makeSource();
  const before = fingerprintOf(source);
  const store = targetStore({}, { dir: scratch() });
  const statePath = path.join(scratch(), 'state.jsonl');
  const report = await copyFiles({ sourceDir: source, store, statePath });
  assert.equal(report.copied, KEYS.length);
  assert.equal(report.skipped, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(report.perBusiness).map(([b, v]) => [b, v.files])), { 1: 3, 2: 2, platform: 1 });
  assert.deepEqual((await store.list()).sort(), [...KEYS].sort(), 'the unfinished temporary file is not copied');
  assert.deepEqual(fingerprintOf(source), before, 'nothing in the source changed');
  const state = readState(statePath);
  assert.equal(state.done.size, KEYS.length);
  assert.ok(state.finished);
  assert.doesNotMatch(fs.readFileSync(statePath, 'utf8'), /half/, 'the state file holds keys and checksums, never content');
  const checked = await verifyCopy({ manifest: statePath, store, sourceDir: source });
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.files, KEYS.length);
  assert.equal(businessOf('t/12/media/x'), '12');
  assert.equal(businessOf('backups/latest'), 'platform');
});

test('R-07 a target that is not empty is refused; so are a state file inside the source and one for another target', async () => {
  const source = makeSource();
  const targetDir = scratch();
  fs.mkdirSync(path.join(targetDir, 't/9'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 't/9/other'), 'someone else');
  const store = targetStore({}, { dir: targetDir });
  const statePath = path.join(scratch(), 'state.jsonl');
  await assert.rejects(copyFiles({ sourceDir: source, store, statePath }), (e) => e instanceof CopyError && e.code === 'target_not_empty' && e.exitCode === 2);
  assert.equal(fs.existsSync(statePath), false, 'nothing written');
  await assert.rejects(copyFiles({ sourceDir: source, store: targetStore({}, { dir: scratch() }), statePath: path.join(source, 'state.jsonl') }), (e) => e.code === 'state_in_source');
  const good = path.join(scratch(), 'state.jsonl');
  await copyFiles({ sourceDir: source, store: targetStore({}, { dir: scratch() }), statePath: good });
  await assert.rejects(copyFiles({ sourceDir: source, store: targetStore({}, { dir: scratch() }), statePath: good }), (e) => e.code === 'state_mismatch');
  assert.throws(() => targetStore({ storageDriver: 'local' }), (e) => e.code === 'not_configured', 'the real target must be object storage');
});

test('R-07 interrupted halfway, the copy resumes: what was copied and checked is skipped, the rest is copied', async () => {
  const source = makeSource();
  const store = targetStore({}, { dir: scratch() });
  const statePath = path.join(scratch(), 'state.jsonl');
  let puts = 0;
  const flaky = { ...store, put: async (...args) => { if (++puts === 4) throw new Error('connection reset'); return store.put(...args); } };
  await assert.rejects(copyFiles({ sourceDir: source, store: flaky, statePath }), /connection reset/);
  assert.equal(readState(statePath).done.size, 3);
  assert.equal(readState(statePath).finished, null);
  const partial = await verifyCopy({ manifest: statePath, store });
  assert.ok(partial.problems.some((p) => /has not finished/.test(p)), 'a copy that has not finished never passes');
  const dry = await copyFiles({ sourceDir: source, store, statePath, dryRun: true });
  assert.deepEqual([dry.pending, dry.skipped], [3, 3]);
  const resumed = await copyFiles({ sourceDir: source, store, statePath });
  assert.deepEqual([resumed.copied, resumed.skipped, resumed.files], [3, 3, KEYS.length]);
  assert.deepEqual((await verifyCopy({ manifest: statePath, store, sourceDir: source })).problems, []);
  // A crash mid-line leaves half a line at the end: it is ignored.
  fs.appendFileSync(statePath, '{"key":"t/1/med');
  assert.equal(readState(statePath).done.size, KEYS.length);
});

test('R-07 a checksum difference stops the copy loudly, and verify names the business of a file corrupted later', async () => {
  const source = makeSource();
  const store = targetStore({}, { dir: scratch() });
  const corrupting = { ...store, get: async (key) => { const b = await store.get(key); if (key === 't/2/media/b1') b[0] ^= 0xff; return b; } };
  await assert.rejects(copyFiles({ sourceDir: source, store: corrupting, statePath: path.join(scratch(), 's.jsonl') }), (e) => e.code === 'checksum_mismatch' && /t\/2\/media\/b1/.test(e.message));

  const target = scratch();
  const good = targetStore({}, { dir: target });
  const statePath = path.join(scratch(), 'state.jsonl');
  await copyFiles({ sourceDir: source, store: good, statePath });
  const file = path.join(target, 't/2/media/b2');
  const bytes = fs.readFileSync(file);
  bytes[10] ^= 0x01;
  fs.writeFileSync(file, bytes);
  fs.rmSync(path.join(target, 't/1/media/a1'));
  fs.writeFileSync(path.join(source, 't/1/media/a2'), 'changed after the copy');
  const report = await verifyCopy({ manifest: statePath, store: good, sourceDir: source });
  assert.equal(report.ok, false);
  assert.ok(report.problems.includes('files, business 2: t/2/media/b2 differs in the target (checksum)'), report.problems.join('\n'));
  assert.ok(report.problems.includes('files, business 1: t/1/media/a1 is missing from the target'));
  assert.ok(report.problems.includes('files, business 1: t/1/media/a2 changed in the source after it was copied'));
});

test('R-07 the command line: exit 0 when done, 2 for a refused target, 1 when verify finds a difference; no content printed', () => {
  assert.deepEqual(parseArgs(['--from', 'a', '--state', 'b', '--dry-run']), { from: 'a', state: 'b', toDir: '', dryRun: true, verify: false });
  for (const bad of [[], ['--from', 'a'], ['--from', 'a', '--state', 'b', '--dry-run', '--verify'], ['--from', 'a', '--state', 'b', '--to', 'x']]) assert.throws(() => parseArgs(bad), CopyError);
  const source = makeSource();
  const target = scratch();
  const statePath = path.join(scratch(), 'state.jsonl');
  const cli = (...args) => spawnSync(process.execPath, ['scripts/copy-files.js', '--from', source, '--state', statePath, '--to-dir', target, ...args], { cwd: ROOT, encoding: 'utf8' });
  const copied = cli();
  assert.equal(copied.status, 0, copied.stderr);
  assert.match(copied.stderr, /6 copied/);
  assert.equal(cli('--verify').status, 0);
  const again = cli();
  assert.equal(again.status, 0);
  assert.match(again.stderr, /0 copied, 6 already there/);
  fs.writeFileSync(path.join(target, 't/1/media/a1'), 'tampered');
  const verify = cli('--verify');
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /DIFFERENT {2}files, business 1: t\/1\/media\/a1 differs/);
  const refused = spawnSync(process.execPath, ['scripts/copy-files.js', '--from', source, '--state', path.join(scratch(), 'new.jsonl'), '--to-dir', target], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /not empty/);
  assert.doesNotMatch(copied.stderr + verify.stderr + refused.stderr, /tampered|half/);
});

/**
 * Running the test suite for R-05 and comparing two runs of it.
 *
 *   await runSuite({ cwd, env, patterns, resultFile, concurrency, timeoutMs })   -> { code, timedOut, rows }
 *   failures(rows)                    the tests that failed, each { key, file, name, error }
 *   compareRuns(production, simple)   -> { onlyHere, onBoth, counts }  what fails only on the production drivers, and what fails on both
 *   gitState(cwd) / sourceChanges(before, after)   proof that the run changed no source file
 *
 * A test is named by its file, line and title: the same on both runs, since both run the same files.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPORTER = pathToFileURL(path.join(HERE, 'suite-reporter.mjs')).href;

export const keyOf = (row) => `${row.file}:${row.line}:${row.column} ${row.name}`;

export function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a line cut short by a crash
    }
  }
  return rows;
}

/**
 * The tests that failed. A suite that failed with no failing test inside it (a hook that threw, a file that crashed before its
 * tests ran) counts as one failure of its own.
 */
export function failures(rows) {
  const real = rows.filter((r) => !r.ok && !r.skipped);
  const byFile = new Map();
  for (const r of real) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const picked = [];
  for (const list of byFile.values()) {
    const leaf = list.filter((r) => !r.suite);
    if (leaf.length) picked.push(...leaf);
    else picked.push(...list.filter((r) => r.nesting === Math.min(...list.map((x) => x.nesting))));
  }
  const seen = new Set();
  const out = [];
  for (const r of picked) {
    const key = keyOf(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, file: r.file, name: r.name, error: r.error ?? '' });
  }
  return out;
}

export function counts(rows) {
  const leaf = rows.filter((r) => !r.suite);
  return { passed: leaf.filter((r) => r.ok && !r.skipped).length, skipped: leaf.filter((r) => r.skipped).length, failed: failures(rows).length, files: new Set(rows.map((r) => r.file).filter(Boolean)).size };
}

/** `simple` holds the rerun, on the simple drivers, of the files that failed on the production ones. */
export function compareRuns(production, simple) {
  const onProduction = failures(production);
  const simpleFailed = new Set(failures(simple).map((f) => f.key));
  const simplePassed = new Set(simple.filter((r) => r.ok && !r.skipped && !r.suite).map(keyOf));
  const onlyHere = [];
  const onBoth = [];
  for (const f of onProduction) {
    if (simpleFailed.has(f.key)) onBoth.push(f);
    else if (simplePassed.has(f.key)) onlyHere.push(f);
    else onBoth.push({ ...f, note: 'it did not run on the simple drivers' });
  }
  return { onlyHere, onBoth };
}

/** Runs `node --test` over the patterns. `env` is the whole environment of the run. */
export function runSuite({ cwd, env, patterns, resultFile, concurrency = 4, timeoutMs = 2_400_000, guard = true }) {
  const args = [];
  if (guard) args.push('--import', './tools/net-guard.mjs');
  args.push('--test', '--test-force-exit', `--test-concurrency=${concurrency}`, `--test-reporter=${REPORTER}`, `--test-reporter-destination=${resultFile}`, ...patterns);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', () => resolve({ code: -1, timedOut, rows: [], stderr }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, rows: readRows(resultFile), stderr });
    });
  });
}

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: this is not a git checkout`);
  return r.stdout;
};

/** The commit, every tracked file that differs from it (with a hash of its content), and the new files under src/. */
export function gitState(cwd) {
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  const changed = {};
  const names = git(cwd, ['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '--', 'src']).split('\n').filter(Boolean);
  for (const name of [...names, ...untracked]) {
    const file = path.join(cwd, name);
    changed[name] = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'deleted';
  }
  return { head, changed };
}

/** The names of the files that are different between two states, and whether the commit moved. */
export function sourceChanges(before, after) {
  const out = [];
  if (before.head !== after.head) out.push('the commit moved');
  for (const name of new Set([...Object.keys(before.changed), ...Object.keys(after.changed)])) {
    if (before.changed[name] !== after.changed[name]) out.push(`${name} ${before.changed[name] === undefined ? 'was added or changed' : after.changed[name] === undefined ? 'was restored' : 'changed'}`);
  }
  return out;
}

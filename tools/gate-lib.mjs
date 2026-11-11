/**
 * The rules behind `npm run gate` and `npm run ledger`, kept free of side effects so they can be tested.
 *
 * Where tests live, per phase K:
 *   test/pK/**, test/attack/pK/**    node:test files named *.test.js (test/*.test.js count as phase 0)
 *   e2e/pK/**, e2e/attack/pK/**      Playwright files named *.spec.js or *.test.js
 *   requirements/pK.json             [{ id, title }]; each id needs a test whose name starts with that id
 *
 * The apps (phase 5 on) keep their tests beside their code, and those count too:
 *   apps/**, packages/**             jest files named *.test.js or *.test.jsx (`npm run test:apps`)
 *   apps/<app>/.maestro/**           Maestro flows (*.yaml), by the `name:` in their header. The gate does not boot an
 *                                    emulator: flows run in .github/workflows/apps.yml, and here their names are counted
 *   apps/owner and the shared packages belong to phase 5; apps/shopper, packages/store-client and packages/pay to phase 6
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEDGER_PATH = 'tools/gate-ledger.json';
export const ALLOW_SKIP_PATH = 'tools/gate-allow-skip.json';
const MIGRATIONS = 'src/db/migrations';
const IS_NODE_TEST = /\.test\.js$/;
const IS_E2E_TEST = /\.(spec|test)\.m?js$/;
const IS_APP_TEST = /\.test\.jsx?$/;
const IS_FLOW = /\.ya?ml$/;
const APP_ROOTS = ['apps', 'packages'];
const APP_SKIP = new Set(['node_modules', 'android', 'ios', 'dist', 'build', '.expo']);
export const APP_JEST_CONFIG = 'jest.apps.config.cjs';

export const range = (n) => Array.from({ length: n + 1 }, (_, k) => k);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

export function parsePhase(arg) {
  if (!/^\d{1,2}$/.test(String(arg ?? ''))) throw new Error(`A phase number is required, got "${arg ?? ''}"`);
  return Number(arg);
}

/** The folder holding docs/, logs/ and tmp/ (C:\bhava here, from any worktree); .gate inside the repo elsewhere. */
export function findHome(root = repoRoot) {
  if (process.env.BHAVA_HOME) return process.env.BHAVA_HOME;
  for (let dir = path.dirname(root), up = path.dirname(dir); ; dir = up, up = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'docs', 'FULL-BUILD-PLAN.md'))) return dir;
    if (up === dir) return path.join(root, '.gate');
  }
}

/** A base folder for scratch files. Postgres' tools do not cope with spaces in a path. */
export function scratchBase(home = findHome()) {
  const preferred = path.join(home, 'tmp');
  if (!/\s/.test(preferred)) return preferred;
  if (!/\s/.test(os.tmpdir())) return os.tmpdir();
  throw new Error(`No folder without spaces for temporary files: tried ${preferred} and ${os.tmpdir()}`);
}

/** Every file under root/rel, as sorted repo-relative paths with forward slashes. */
export function walk(root, rel) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) return walk(root, child);
    return entry.isFile() ? [child] : [];
  }).sort();
}

export const testDirs = (k) => [`test/p${k}`, `test/attack/p${k}`];
export const e2eDirs = (k) => [`e2e/p${k}`, `e2e/attack/p${k}`];

const baselineTests = (root) =>
  fs.existsSync(path.join(root, 'test'))
    ? fs.readdirSync(path.join(root, 'test')).filter((f) => IS_NODE_TEST.test(f)).map((f) => `test/${f}`).sort()
    : [];

/** Globs for `node --test` covering exactly the given phases. Folders with no tests are left out. */
export function nodeTestGlobs(root, phases, { baseline = true } = {}) {
  const globs = baseline && baselineTests(root).length ? ['test/*.test.js'] : [];
  for (const k of phases) {
    for (const dir of testDirs(k)) if (walk(root, dir).some((f) => IS_NODE_TEST.test(f))) globs.push(`${dir}/**/*.test.js`);
  }
  return globs;
}

/** Playwright folders with tests, for the given phases. */
export function e2eFolders(root, phases) {
  return phases.flatMap(e2eDirs).filter((dir) => walk(root, dir).some((f) => IS_E2E_TEST.test(f)));
}

/** The phase an app or package folder belongs to. */
export const appPhaseOf = (rel) => (/^(apps\/shopper|packages\/(store-client|pay))\//.test(rel) ? 6 : 5);

/** The phase a test file belongs to. */
export function phaseOf(rel) {
  if (/^(apps|packages)\//.test(rel)) return appPhaseOf(rel);
  const m = /^(?:test|e2e)\/(?:attack\/)?p(\d+)\//.exec(rel);
  return m ? Number(m[1]) : 0;
}

/** Every file under apps/ and packages/, leaving out installed packages and build output. */
function walkApps(root) {
  const visit = (rel) => {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (APP_SKIP.has(entry.name)) return [];
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) return visit(child);
      return entry.isFile() ? [child] : [];
    });
  };
  return APP_ROOTS.flatMap(visit).sort();
}

/** The apps' jest test files, optionally only those of the given phases. */
export function appTestFiles(root, phases) {
  return walkApps(root).filter((f) => IS_APP_TEST.test(f) && (!phases || phases.includes(appPhaseOf(f))));
}

/**
 * The apps' Maestro flows: [{ file, name }]. A flow's name is the `name:` in its header (the part above `---`), and
 * a flow without one is named after its file, so it can never stand for a requirement by accident.
 */
export function maestroFlows(root, phases) {
  return walkApps(root)
    .filter((f) => /\/\.maestro\//.test(f) && IS_FLOW.test(f) && (!phases || phases.includes(appPhaseOf(f))))
    .map((file) => {
      const header = fs.readFileSync(path.join(root, file), 'utf8').split(/^---\s*$/m)[0];
      const named = /^name:\s*(.+?)\s*$/m.exec(header)?.[1].replace(/^(['"])(.*)\1$/, '$2');
      return { file, name: named || path.basename(file).replace(IS_FLOW, '') };
    });
}

/**
 * Rows from jest's --json report, in the shape the gate keeps: { source: 'app', name, file, outcome, message }.
 * `name` is the test's own title, so "P-11 sign-in offers..." counts for P-11 whatever it is grouped under.
 * A file that could not run at all is one failing row named after the file.
 */
export function readJestResults(report, root = repoRoot) {
  const rows = [];
  const rel = (file) => path.relative(root, file).split(path.sep).join('/');
  const outcomes = { passed: 'pass', failed: 'fail', pending: 'skip', skipped: 'skip', disabled: 'skip', todo: 'todo' };
  for (const suite of report?.testResults ?? []) {
    const file = rel(suite.name ?? suite.testFilePath ?? '');
    const tests = suite.assertionResults ?? suite.testResults ?? [];
    if (tests.length === 0 && suite.status === 'failed') {
      rows.push({ source: 'app', name: `${file} could not run`, file, type: 'test', outcome: 'fail', message: String(suite.message ?? suite.failureMessage ?? '').slice(0, 600) });
    }
    for (const t of tests) {
      rows.push({ source: 'app', name: t.title, file, type: 'test', outcome: outcomes[t.status] ?? 'fail', message: (t.failureMessages ?? []).join('\n').slice(0, 600) || undefined });
    }
  }
  return rows;
}

/** Line endings are ignored so a checkout on another system still matches. */
export function hashFile(file) {
  return sha256(Buffer.from(fs.readFileSync(file).toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
}

/** Every file a lock on phase K freezes, with its hash. Includes fixtures and the requirement list. */
export function phaseFileHashes(root, k) {
  const files = [
    ...(k === 0 ? baselineTests(root) : []),
    ...testDirs(k).flatMap((d) => walk(root, d)),
    ...e2eDirs(k).flatMap((d) => walk(root, d)),
    ...appTestFiles(root, [k]),
    ...maestroFlows(root, [k]).map((flow) => flow.file),
    ...(fs.existsSync(path.join(root, `requirements/p${k}.json`)) ? [`requirements/p${k}.json`] : []),
  ];
  return Object.fromEntries(files.sort().map((f) => [f, hashFile(path.join(root, f))]));
}

export const digestOf = (hashes) => sha256(JSON.stringify(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1))));

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const readLedger = (root = repoRoot) => readJson(path.join(root, LEDGER_PATH), { version: 1, phases: {} });

/** Migration files must have unique numbers: the runner tracks only the number, so a twin would be dropped silently. */
export function checkMigrations(root) {
  const dir = path.join(root, MIGRATIONS);
  const problems = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const byNumber = new Map();
  for (const file of files) {
    if (!/^\d{3}_[\w-]+\.sql$/.test(file)) {
      problems.push(`Migration "${file}" is not named NNN_name.sql, so it would never run`);
      continue;
    }
    byNumber.set(file.slice(0, 3), [...(byNumber.get(file.slice(0, 3)) ?? []), file]);
  }
  for (const [number, same] of byNumber) {
    if (same.length > 1) problems.push(`Duplicate migration number ${number}: ${same.join(', ')}`);
  }
  return { count: byNumber.size, problems };
}

/** Each requirement in phases 0..n needs a test whose name is the id followed by a non-alphanumeric or nothing. */
export function checkRequirements(root, n, testNames) {
  const problems = [];
  const missing = [];
  const names = [...new Set(testNames)];
  const covered = (id) => names.some((name) => name.startsWith(id) && !/[0-9A-Za-z]/.test(name[id.length] ?? ''));
  let total = 0;
  for (const k of range(n)) {
    const file = `requirements/p${k}.json`;
    let list;
    try {
      list = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch (err) {
      problems.push(err.code === 'ENOENT' ? `${file} does not exist` : `${file} is not valid JSON: ${err.message}`);
      continue;
    }
    if (!Array.isArray(list)) {
      problems.push(`${file} must be an array of { id, title }`);
      continue;
    }
    const seen = new Set();
    for (const item of list) {
      if (!/^[A-Z]{1,3}-\d+$/.test(item?.id ?? '') || typeof item?.title !== 'string' || !item.title || item.title.length > 90) {
        problems.push(`${file} has an invalid entry: ${JSON.stringify(item)}`);
        continue;
      }
      if (seen.has(item.id)) problems.push(`${file} lists ${item.id} twice`);
      seen.add(item.id);
      total++;
      if (!covered(item.id)) missing.push(item.id);
    }
  }
  if (missing.length) problems.push(`${missing.length} requirement(s) have no test whose name starts with the id: ${missing.join(', ')}`);
  return { total, missing, problems };
}

/** A skipped or todo test fails the gate unless the allow list names it and says why. */
export function checkSkips(skipped, allow = { tests: [] }) {
  const entries = (allow.tests ?? []).filter((e) => e?.name && typeof e.reason === 'string' && e.reason.trim());
  const verdicts = skipped.map((test) => {
    const entry = test.kind === 'skip' ? entries.find((e) => e.name === test.name && (!e.file || e.file === test.file)) : undefined;
    return { ...test, allowed: Boolean(entry), reason: entry?.reason };
  });
  const invalid = (allow.tests ?? []).length - entries.length;
  const problems = verdicts
    .filter((t) => !t.allowed)
    .map((t) => `${t.kind === 'skip' ? 'Skipped' : 'Unfinished (todo or expected failure)'} test without an allowed reason: "${t.name}" in ${t.file}`);
  if (invalid) problems.push(`${ALLOW_SKIP_PATH} has ${invalid} entr${invalid === 1 ? 'y' : 'ies'} with no name or no reason`);
  return { verdicts, problems };
}

/** What a phase's tests are counted as: node:test, Playwright, the apps' jest tests, and Maestro flows. */
export const TEST_KINDS = Object.freeze(['node', 'e2e', 'app', 'flow']);

/** Compares locked phases up to n with the working tree and this run's test counts. */
export function checkLedger(root, ledger, n, byPhase) {
  const changed = [];
  const lower = [];
  for (const [phase, locked] of Object.entries(ledger.phases ?? {})) {
    const k = Number(phase);
    if (k > n) continue;
    for (const [file, hash] of Object.entries(locked.files ?? {})) {
      const full = path.join(root, file);
      if (!fs.existsSync(full)) changed.push(`${file} (locked in phase ${k}) is missing`);
      else if (hashFile(full) !== hash) changed.push(`${file} (locked in phase ${k}) has changed`);
    }
    for (const kind of TEST_KINDS) {
      const now = byPhase[k]?.[kind] ?? 0;
      const was = locked.counts?.[kind] ?? 0;
      if (now < was) lower.push(`Phase ${k} has ${now} ${kind} test(s), the ledger has ${was}`);
    }
  }
  return { changed, lower, problems: [...changed, ...lower] };
}

/**
 * Locks phase n into the ledger from a passing gate summary. `reason` is required to overwrite a file that
 * is already locked; the override is recorded in the ledger. Returns the new ledger, or throws.
 */
export function lockPhase({ root, ledger, n, summary, reason = '', commit = '', now = new Date().toISOString() }) {
  if (!summary) throw new Error(`No gate summary for phase ${n}: run the gate first`);
  if (summary.phase !== n) throw new Error(`The gate summary is for phase ${summary.phase}, not ${n}`);
  if (summary.ok !== true) throw new Error(`The last gate for phase ${n} did not pass, so it cannot be locked`);
  const files = phaseFileHashes(root, n);
  if (summary.lockDigest !== digestOf(files)) throw new Error(`Test files for phase ${n} changed after the gate passed: rerun the gate`);

  const previous = ledger.phases?.[n];
  const altered = previous ? Object.keys(previous.files).filter((f) => files[f] !== previous.files[f]) : [];
  if (altered.length && !reason.trim()) throw new Error(`Phase ${n} is already locked and these files differ: ${altered.join(', ')}. Pass --reason to override`);
  const relocks = [...(previous?.relocks ?? []), ...(altered.length ? [{ at: now, reason: reason.trim(), files: altered }] : [])];
  const counted = (kind) => summary.byPhase?.[n]?.[kind] ?? 0;
  const counts = { node: counted('node'), e2e: counted('e2e'), ...(counted('app') ? { app: counted('app') } : {}), ...(counted('flow') ? { flow: counted('flow') } : {}) };
  return {
    version: 1,
    phases: {
      ...ledger.phases,
      [n]: { lockedAt: now, commit, counts, files, ...(relocks.length ? { relocks } : {}) },
    },
  };
}

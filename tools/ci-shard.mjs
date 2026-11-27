/**
 * Splits the test files CI runs into shards, so the heavy jobs in .github/workflows/ci.yml run in parallel with nothing
 * left out. A shard is a set of whole files; every file is in exactly one shard of its suite.
 *
 *   node tools/ci-shard.mjs list <suite>            every file of the suite, one per line
 *   node tools/ci-shard.mjs files <suite> <k>/<n>   the files of shard k of n
 *   node tools/ci-shard.mjs run <suite> <k>/<n>     runs shard k of n (npm run test:shard -- <suite> <k>/<n>)
 *   node tools/ci-shard.mjs plan                    the coverage guard: checks every split, prints the counts and, in
 *                                                   GitHub Actions, writes the matrices the sharded jobs run
 *
 * Suites
 *   node  node:test files, from the glob at the end of `npm run test:ci`. A shard runs exactly that command's node
 *         flags (net-guard, --test-force-exit, --test-concurrency, the spec and ci-annotate reporters) on its files,
 *         plus tools/ci-timing.mjs, which only prints each file's time so the split can be balanced.
 *   e2e   Playwright files, as playwright.config.mjs finds them (testDir e2e, *.spec.js or *.test.js), run the way the
 *         gate runs them, with net-guard in NODE_OPTIONS.
 *   app   jest files of the apps and packages (`npm run test:apps`). Not sharded: apps.yml runs them in one job of a
 *         few minutes. Counted here so the total is known.
 *
 * Balance: greedy, longest first, onto the lightest shard. A file's weight is its time in tools/ci-timings.json when
 * known, else its size scaled to the known times. Ties go by name, so the split depends only on the checkout.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Shards per suite. The matrices in ci.yml come from here (`plan`), so a shard can never be missing from a job. */
export const SHARDS = { node: 12, e2e: 6 };
const TIMINGS = 'tools/ci-timings.json';
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(rel) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(child);
    return entry.isFile() ? [child] : [];
  });
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The command `npm run test:ci` runs, as arguments. Its last argument is the glob of test files. */
export function testCiCommand() {
  const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['test:ci'];
  const args = [...script.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  if (args[0] !== 'node') throw new Error(`test:ci does not start with node: ${script}`);
  const glob = args.at(-1);
  if (!/^[\w./-]+\/\*\*\/\*[\w.-]+$/.test(glob)) throw new Error(`test:ci's last argument is not a "dir/**/*suffix" glob: ${glob}`);
  return { flags: args.slice(1, -1), glob };
}

/** The node:test files of test:ci's glob ("test/**\/*.test.js": every *.test.js anywhere under test/). */
function nodeFiles() {
  const { glob } = testCiCommand();
  const [, dir, suffix] = /^(.*)\/\*\*\/\*(.*)$/.exec(glob);
  return walk(dir).filter((f) => f.endsWith(suffix)).sort(byName);
}

/** Playwright's files: testDir and testMatch from playwright.config.mjs. */
function e2eFiles() {
  const config = fs.readFileSync(path.join(root, 'playwright.config.mjs'), 'utf8');
  const dir = /testDir:\s*'([^']+)'/.exec(config)?.[1];
  const match = /testMatch:\s*\/(.+)\/,/.exec(config)?.[1];
  if (!dir || !match) throw new Error('playwright.config.mjs has no testDir or testMatch this tool can read');
  const re = new RegExp(match);
  return walk(dir).filter((f) => re.test(f)).sort(byName);
}

async function appFiles() {
  const { appTestFiles } = await import(pathToFileURL(path.join(root, 'tools', 'gate-lib.mjs')).href);
  return appTestFiles(root);
}

const SUITES = { node: nodeFiles, e2e: e2eFiles };

function readTimings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, TIMINGS), 'utf8'));
  } catch {
    return {};
  }
}

/** Every file's weight: its known time, else its size times the known time per byte. */
function weights(files) {
  const timings = readTimings();
  const size = (f) => fs.statSync(path.join(root, f)).size;
  const known = files.filter((f) => Number(timings[f]) > 0);
  const perByte = known.length ? known.reduce((n, f) => n + Number(timings[f]), 0) / known.reduce((n, f) => n + size(f), 0) : 1;
  return new Map(files.map((f) => [f, Number(timings[f]) > 0 ? Number(timings[f]) : size(f) * perByte]));
}

/** The files split into n shards: [[...files of shard 1], ...]. */
export function split(files, n) {
  const weight = weights(files);
  const shards = Array.from({ length: n }, () => ({ files: [], load: 0 }));
  const order = [...files].sort((a, b) => weight.get(b) - weight.get(a) || byName(a, b));
  for (const file of order) {
    let best = shards[0];
    for (const shard of shards) if (shard.load < best.load) best = shard;
    best.files.push(file);
    best.load += weight.get(file);
  }
  return shards.map((s) => ({ files: s.files.sort(byName), load: s.load }));
}

function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text ?? ''));
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`A shard is k/n with 1 <= k <= n, got "${text}"`);
  return { k: Number(m[1]), n: Number(m[2]) };
}

/** The files of shard `text` ("k/n") of a suite: what `files <suite> <k>/<n>` prints. R-05 runs the same split on production drivers. */
export function shardFiles(suite, text) {
  const { k, n } = parseShard(text);
  return split(suiteFiles(suite), n)[k - 1].files;
}

function suiteFiles(suite) {
  if (!SUITES[suite]) throw new Error(`Unknown suite "${suite}"; one of ${Object.keys(SUITES).join(', ')}`);
  return SUITES[suite]();
}

/** A Playwright filter that matches this file and no other (Playwright reads its arguments as regular expressions). */
const e2eFilter = (file) => `${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

/** The coverage guard. Returns the problems found; prints the counts. */
async function plan() {
  const problems = [];
  const counts = {};
  for (const [suite, n] of Object.entries(SHARDS)) {
    const files = suiteFiles(suite);
    counts[suite] = files.length;
    if (!files.length) problems.push(`${suite}: no test files found`);
    if (new Set(files).size !== files.length) problems.push(`${suite}: a file is listed twice`);
    // Node's own glob, when this Node has it, must find the same files test:ci would run.
    if (suite === 'node' && typeof fs.globSync === 'function') {
      const own = fs.globSync(testCiCommand().glob, { cwd: root }).map((f) => f.split(path.sep).join('/')).sort(byName);
      const missing = own.filter((f) => !files.includes(f));
      const extra = files.filter((f) => !own.includes(f));
      if (missing.length || extra.length) problems.push(`node: this tool and Node's glob disagree: missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`);
    }
    const shards = split(files, n);
    const seen = new Map();
    for (const [i, shard] of shards.entries()) for (const f of shard.files) seen.set(f, [...(seen.get(f) ?? []), i + 1]);
    for (const f of files) {
      const at = seen.get(f) ?? [];
      if (at.length !== 1) problems.push(`${suite}: ${f} is in ${at.length ? `shards ${at.join(', ')}` : 'no shard'}`);
    }
    for (const f of seen.keys()) if (!files.includes(f)) problems.push(`${suite}: ${f} is in a shard but is not a test file`);
    const empty = shards.filter((s) => !s.files.length).length;
    if (empty) problems.push(`${suite}: ${empty} shard(s) have no files; lower SHARDS.${suite}`);
    if (suite === 'e2e') {
      for (const f of files) {
        const re = new RegExp(e2eFilter(f), 'i');
        const hits = files.filter((g) => re.test(g));
        if (hits.length !== 1 || hits[0] !== f) problems.push(`e2e: the filter for ${f} matches ${hits.join(', ') || 'nothing'}`);
      }
    }
    const total = shards.reduce((n2, s) => n2 + s.files.length, 0);
    console.log(`${suite}: ${files.length} files in ${n} shards (${total} assigned); files per shard ${shards.map((s) => s.files.length).join(' ')}`);
    for (const [i, s] of shards.entries()) console.log(`  shard ${i + 1}/${n}: ${s.files.length} files, weight ${Math.round(s.load)}`);
  }
  counts.app = (await appFiles()).length;
  console.log(`app (jest, run whole by apps.yml and brand-apps.yml, not sharded): ${counts.app} files`);
  console.log(`Total test files: ${counts.node + counts.e2e + counts.app} (node ${counts.node}, e2e ${counts.e2e}, app ${counts.app})`);
  if (!counts.app) problems.push('app: no jest files found');

  const matrix = (suite, n) => Array.from({ length: n }, (_, i) => ({ suite, shard: i + 1, of: n }));
  const outputs = {
    node: matrix('node', SHARDS.node),
    postgres: [...matrix('node', SHARDS.node), ...matrix('e2e', SHARDS.e2e)],
  };
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${JSON.stringify(v)}\n`).join(''));
  }
  return problems;
}

/** Minutes with no output at all before a node:test run counts as stalled. Normal runs never go quiet for 2. */
const STALL_MINUTES = Number(process.env.CI_SHARD_STALL_MINUTES || 10);

/** The processes on this machine, for the log of a stalled run. */
function processList() {
  const ps = spawnSync('ps', ['-eo', 'pid,ppid,etime,args', '--forest'], { encoding: 'utf8' });
  return ps.status === 0 ? ps.stdout : '(ps is not available)';
}

/** A file as the reporters name it: relative to the repository, with forward slashes. */
const repoPath = (file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/');

/**
 * One node --test run over these files, passed through to stdout. Resolves with its exit code, the files it showed
 * any sign of (a test started, or the file's time) and those it finished, and whether it stalled: no output for
 * STALL_MINUTES, after which the run (and every process it started) is stopped.
 */
function nodeRun(files) {
  const args = [...testCiCommand().flags, '--test-reporter=./tools/ci-timing.mjs', '--test-reporter-destination=stdout', ...files];
  return new Promise((resolve, reject) => {
    // Its own process group, so a stalled run can be stopped with everything it started.
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const seen = new Set();
    const finished = new Set();
    let last = Date.now();
    let stalled = false;
    let partial = '';
    child.stdout.on('data', (chunk) => {
      last = Date.now();
      process.stdout.write(chunk);
      const text = partial + chunk.toString('utf8');
      const lines = text.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const m = /^ci-(start|timing \d+) (\S+)$/.exec(line.trim());
        if (m) seen.add(m[2]);
        if (m && m[1] !== 'start') finished.add(m[2]);
      }
    });
    child.stderr.on('data', (chunk) => {
      last = Date.now();
      process.stderr.write(chunk);
    });
    const watchdog = setInterval(() => {
      if (Date.now() - last < STALL_MINUTES * 60_000) return;
      stalled = true;
      clearInterval(watchdog);
      console.log(`\nci-shard: no output for ${STALL_MINUTES} minutes. The processes:\n${processList()}`);
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, 15_000);
    child.once('error', (err) => {
      clearInterval(watchdog);
      reject(err);
    });
    child.once('close', (code) => {
      clearInterval(watchdog);
      resolve({ code: code ?? 1, seen, finished, stalled });
    });
  });
}

/**
 * The node:test shard. If the runner stalls (it has, once, with every test file finished and nothing left running),
 * the file it was in is reported as failed and the files it never reached run in a new runner, so no file is left
 * out and the shard fails with a reason instead of hitting the job's time limit.
 */
export async function runNode(files) {
  let remaining = files;
  let exitCode = 0;
  const stalledIn = [];
  while (remaining.length) {
    const { code, seen, finished, stalled } = await nodeRun(remaining);
    if (code !== 0) exitCode = 1;
    if (!stalled) break;
    // Files run one at a time, in the order given: everything before the last file showing a sign of life is done.
    // That file is the one the run stalled in, unless it finished, and then it is the next one.
    let at = -1;
    remaining.forEach((f, i) => {
      if (seen.has(repoPath(f))) at = i;
    });
    if (at >= 0 && finished.has(repoPath(remaining[at]))) at++;
    at = Math.max(at, 0);
    const culprit = remaining[at];
    if (culprit) stalledIn.push(culprit);
    console.log(`::error title=Shard stalled::The test run went quiet for ${STALL_MINUTES} minutes in ${culprit ? repoPath(culprit) : 'no file'} and was stopped; that file counts as failed, and the files after it run again now.`);
    remaining = remaining.slice(at + 1);
    if (remaining.length) console.log(`ci-shard: running the ${remaining.length} file(s) after it:\n${remaining.map((f) => `  ${f}`).join('\n')}`);
  }
  for (const f of stalledIn) console.log(`::error file=${repoPath(f)},title=Shard stalled::The test run stalled in this file.`);
  return stalledIn.length ? 1 : exitCode;
}

async function run(suite, k, n) {
  const files = split(suiteFiles(suite), n)[k - 1].files;
  console.log(`ci-shard: ${suite} shard ${k}/${n}: ${files.length} files`);
  for (const f of files) console.log(`  ${f}`);
  if (!files.length) throw new Error('This shard has no files');
  if (suite === 'node') return runNode(files);
  // As tools/gate.mjs runs Playwright: the config's settings, net-guard for the app servers the tests start.
  const guard = pathToFileURL(path.join(root, 'tools', 'net-guard.mjs')).href;
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${guard}`.trim() };
  // CI sets PLAYWRIGHT_JSON_OUTPUT_NAME so the full errors (axe violations, expect diffs) are kept as a JSON report for tools/gh-results.mjs.
  const reporter = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? '--reporter=list,json' : '--reporter=list';
  const args = [path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--config=playwright.config.mjs', reporter, ...files.map(e2eFilter)];
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function main(argv) {
  const [command, suite, shard] = argv;
  if (command === 'list') {
    for (const f of suite === 'app' ? await appFiles() : suiteFiles(suite)) console.log(f);
    return 0;
  }
  if (command === 'files' || command === 'run') {
    const { k, n } = parseShard(shard);
    if (command === 'run') return await run(suite, k, n);
    for (const f of split(suiteFiles(suite), n)[k - 1].files) console.log(f);
    return 0;
  }
  if (command === 'plan') {
    const problems = await plan();
    for (const p of problems) console.log(`::error title=Test coverage guard::${p}`);
    if (problems.length) console.log(`The coverage guard failed: ${problems.length} problem(s).`);
    else console.log('The coverage guard passed: every test file is in exactly one shard.');
    return problems.length ? 1 : 0;
  }
  console.error('Usage: node tools/ci-shard.mjs list <suite> | files <suite> <k>/<n> | run <suite> <k>/<n> | plan');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`ci-shard: ${err.message}`);
    process.exitCode = 2;
  }
}

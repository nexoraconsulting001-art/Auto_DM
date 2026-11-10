/**
 * `npm run gate -- N`: all tests for phases 0 to N on a fresh embedded Postgres, with migrations run from empty.
 * Writes logs/gate-pN.json (counts, failing names, every rule broken) and logs/gate-pN.log (full output).
 * Exit code 0 only when everything passed. Add --verbose to stream test output here too.
 *
 * It fails on any failing test, and also on: a skipped or todo test not listed with a reason in
 * tools/gate-allow-skip.json; a locked file changed or a count lower than tools/gate-ledger.json; a duplicate
 * migration number; a requirement in requirements/pK.json (K up to N) with no test whose name starts with its id.
 *
 * Environment: GATE_CONCURRENCY (default 2), GATE_TEST_TIMEOUT_MS per test (default 120000).
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALLOW_SKIP_PATH, checkLedger, checkMigrations, checkRequirements, checkSkips, digestOf, e2eFolders, findHome,
  nodeTestGlobs, parsePhase, phaseFileHashes, phaseOf, range, readJson, readLedger, repoRoot, scratchBase,
} from './gate-lib.mjs';

const NET_GUARD = pathToFileURL(path.join(repoRoot, 'tools', 'net-guard.mjs')).href;
const REPORTER = pathToFileURL(path.join(repoRoot, 'tools', 'gate-reporter.mjs')).href;
const CONCURRENCY = process.env.GATE_CONCURRENCY || '2';
const TEST_TIMEOUT = process.env.GATE_TEST_TIMEOUT_MS || '120000';
// Settings a developer's shell may carry that would point tests at something other than the gate's own database.
const HOST_SETTINGS = /^(DATABASE_URL|REDIS_URL|CLICKHOUSE_URL|QUEUE_DRIVER|CACHE_DRIVER|ANALYTICS_DRIVER|STORAGE_DRIVER|S3_[A-Z_]+)$/;

const verbose = process.argv.includes('--verbose');
let n;
try {
  n = parsePhase(process.argv.slice(2).find((a) => !a.startsWith('--')));
} catch (err) {
  console.error(`${err.message}\nUsage: npm run gate -- N`);
  process.exit(2);
}

const home = findHome();
const logs = path.join(home, 'logs');
fs.mkdirSync(logs, { recursive: true });
fs.mkdirSync(scratchBase(home), { recursive: true });
const scratch = path.join(scratchBase(home), `gate-p${n}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
fs.mkdirSync(scratch);
const logFile = path.join(logs, `gate-p${n}.log`);
const logFd = fs.openSync(logFile, 'w');

const started = Date.now();
const problems = [];
const results = []; // { source, name, file, line, outcome: pass|fail|skip|todo }
const startedPids = new Set();

const say = (line) => {
  fs.writeSync(logFd, `${line}\n`);
  console.log(line);
};

function savePids() {
  fs.writeFileSync(path.join(scratch, 'pids.json'), JSON.stringify([...startedPids]));
}

const watchdog = spawn(process.execPath, [path.join(repoRoot, 'tools', 'gate-watchdog.mjs'), String(process.pid), scratch], { detached: true, stdio: 'ignore', windowsHide: true });
watchdog.unref();

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', verbose ? 'pipe' : logFd, verbose ? 'pipe' : logFd], windowsHide: true });
    startedPids.add(child.pid);
    savePids();
    if (verbose) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          process.stdout.write(chunk);
          fs.writeSync(logFd, chunk);
        });
      }
    }
    child.once('error', (err) => resolve({ code: -1, error: err.message }));
    child.once('close', (code) => {
      startedPids.delete(child.pid);
      savePids();
      resolve({ code });
    });
  });
}

async function startPostgres() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await freePort();
  const password = crypto.randomBytes(16).toString('hex');
  const output = [];
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(scratch, 'pg'),
    port,
    user: 'postgres',
    password,
    persistent: true, // the gate deletes the whole scratch folder itself, after the server has stopped
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=300', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
    onLog: (line) => output.push(String(line)),
    onError: (line) => output.push(String(line)),
  });
  try {
    await pg.initialise();
    await pg.start();
  } catch (err) {
    throw new Error(`${err?.message ?? 'postgres exited during start'}\n${output.slice(-15).join('')}`);
  }
  startedPids.add(pg.process.pid);
  savePids();
  return { pg, url: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`, pid: pg.process.pid };
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stopPostgres(server) {
  await server.pg.stop();
  for (let i = 0; i < 40 && isAlive(server.pid); i++) await new Promise((r) => setTimeout(r, 250));
  if (isAlive(server.pid)) process.kill(server.pid);
  startedPids.delete(server.pid);
  savePids();
  return !isAlive(server.pid);
}

/** Migrates a brand-new database, then again to prove a second run changes nothing. */
async function migrateFromEmpty(url, expected) {
  const { openDb, runMigrations } = await import(pathToFileURL(path.join(repoRoot, 'src', 'db', 'index.js')).href);
  const admin = await openDb({ url, migrate: false, poolSize: 1 });
  const [{ version }] = await admin.query('SELECT version()');
  await admin.exec('CREATE DATABASE gate_migrate_check');
  await admin.close();
  const target = new URL(url);
  target.pathname = '/gate_migrate_check';
  const db = await openDb({ url: target.href, migrate: false, poolSize: 1 });
  try {
    const applied = await runMigrations(db);
    const again = await runMigrations(db);
    if (applied.length !== expected) problems.push(`Migrating from empty applied ${applied.length} of ${expected} migrations`);
    if (again.length) problems.push(`A second migration run applied ${again.join(', ')}`);
    return { applied: applied.length, version: String(version).split(' on ')[0] };
  } finally {
    await db.close();
  }
}

function relativeFile(file) {
  if (!file) return '';
  return (path.isAbsolute(file) ? path.relative(repoRoot, file) : file).split(path.sep).join('/');
}

function readNodeResults(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      problems.push('The test reporter wrote a damaged line; the run was cut short');
      continue;
    }
    const outcome = r.todo ? 'todo' : r.failed ? 'fail' : r.skip ? 'skip' : 'pass';
    results.push({ source: 'node', name: r.name, file: relativeFile(r.file), line: r.line, type: r.type, failureType: r.failureType, message: r.message, outcome });
  }
}

function readPlaywrightResults(file) {
  const report = readJson(file);
  if (!report) {
    problems.push('Playwright wrote no report');
    return;
  }
  for (const err of report.errors ?? []) problems.push(`Playwright error: ${String(err.message ?? err).slice(0, 300)}`);
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const rel = relativeFile(path.join(report.config?.rootDir ?? path.join(repoRoot, 'e2e'), spec.file));
        const failure = t.results?.at(-1)?.error?.message;
        let outcome = 'fail';
        if (t.status === 'skipped') outcome = 'skip';
        else if (t.status === 'expected') outcome = t.expectedStatus === 'failed' ? 'todo' : 'pass';
        results.push({ source: 'e2e', name: spec.title, file: rel, line: spec.line, type: 'test', message: failure?.slice(0, 600), outcome });
      }
    }
    (suite.suites ?? []).forEach(visit);
  };
  (report.suites ?? []).forEach(visit);
}

function tally(source) {
  const rows = results.filter((r) => r.source === source && r.type !== 'suite');
  const of = (...kinds) => rows.filter((r) => kinds.includes(r.outcome)).length;
  return { total: rows.length, passed: of('pass'), failed: of('fail'), skipped: of('skip', 'todo') };
}

async function main() {
  const summary = {
    phase: n,
    ok: false,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim() !== '',
    startedAt: new Date(started).toISOString(),
    postgres: { started: false, stopped: false },
    migrations: {},
  };
  const migrationCheck = checkMigrations(repoRoot);
  problems.push(...migrationCheck.problems);

  let server;
  try {
    say(`gate p${n}: starting a fresh embedded Postgres in ${scratch}`);
    server = await startPostgres();
    summary.postgres.started = true;
    const env = { ...process.env, TEST_DATABASE_URL: server.url, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${NET_GUARD}`.trim() };
    for (const key of Object.keys(env)) if (HOST_SETTINGS.test(key)) delete env[key];

    summary.migrations = await migrateFromEmpty(server.url, migrationCheck.count);
    summary.postgres.version = summary.migrations.version;
    delete summary.migrations.version;
    say(`gate p${n}: ${summary.postgres.version}; ${summary.migrations.applied} migrations applied from empty`);

    say(`gate p${n}: building the seller console`);
    const consoleBuild = await run(process.execPath, [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', path.join(repoRoot, 'console')], env);
    if (consoleBuild.code !== 0) problems.push(`The seller console did not build (exit ${consoleBuild.code})`);

    const phases = range(n);
    const globs = nodeTestGlobs(repoRoot, phases);
    const ndjson = path.join(scratch, 'node-results.ndjson');
    say(`gate p${n}: node --test over ${globs.join(' ')}`);
    const nodeRun = await run(process.execPath, [
      '--test', `--test-concurrency=${CONCURRENCY}`, `--test-timeout=${TEST_TIMEOUT}`, '--test-force-exit',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${REPORTER}`, `--test-reporter-destination=${ndjson}`,
      ...globs,
    ], env);
    readNodeResults(ndjson);
    summary.node = { exitCode: nodeRun.code, ...tally('node') };
    if (nodeRun.code !== 0 && summary.node.failed === 0) problems.push(`node --test exited with ${nodeRun.code} without naming a failing test${nodeRun.error ? `: ${nodeRun.error}` : ''}`);

    const folders = e2eFolders(repoRoot, phases);
    if (folders.length) {
      const report = path.join(scratch, 'playwright-results.json');
      say(`gate p${n}: Playwright over ${folders.join(' ')}`);
      const e2eRun = await run(process.execPath, [
        path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--config=playwright.config.mjs', '--reporter=list,json', ...folders.map((f) => `${f}/`),
      ], { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: report });
      readPlaywrightResults(report);
      summary.playwright = { ran: true, exitCode: e2eRun.code, ...tally('e2e') };
      if (e2eRun.code !== 0 && summary.playwright.failed === 0) problems.push(`Playwright exited with ${e2eRun.code} without naming a failing test`);
    } else {
      summary.playwright = { ran: false, exitCode: 0, total: 0, passed: 0, failed: 0, skipped: 0 };
    }
  } catch (err) {
    problems.push(`The gate could not finish: ${err.message}`);
    summary.node ??= { exitCode: null, total: 0, passed: 0, failed: 0, skipped: 0 };
    summary.playwright ??= { ran: false, exitCode: null, total: 0, passed: 0, failed: 0, skipped: 0 };
  } finally {
    if (server) {
      try {
        summary.postgres.stopped = await stopPostgres(server);
      } catch (err) {
        problems.push(`Postgres did not stop: ${err.message}`);
      }
      if (!summary.postgres.stopped) problems.push('The embedded Postgres was still running after the gate tried to stop it');
    }
  }

  // Everything below is judged on what actually ran.
  const tests = results.filter((r) => r.type !== 'suite');
  const byPhase = Object.fromEntries(range(n).map((k) => [k, { node: 0, e2e: 0 }]));
  for (const t of tests) {
    const k = phaseOf(t.file);
    if (byPhase[k]) byPhase[k][t.source]++;
  }
  const skips = checkSkips(
    tests.filter((t) => t.outcome === 'skip' || t.outcome === 'todo').map(({ name, file, outcome }) => ({ name, file, kind: outcome })),
    readJson(path.join(repoRoot, ALLOW_SKIP_PATH), { tests: [] }),
  );
  const ledger = checkLedger(repoRoot, readLedger(), n, byPhase);
  const requirements = checkRequirements(repoRoot, n, tests.map((t) => t.name));
  problems.push(...skips.problems, ...ledger.problems, ...requirements.problems);
  if (tests.length === 0) problems.push('No tests ran');

  const failing = results
    .filter((r) => r.outcome === 'fail' && r.failureType !== 'subtestsFailed')
    .map(({ source, name, file, line, message }) => ({ source, name, file, line, message }));
  if (failing.length) problems.push(`${failing.length} test(s) failed`);

  Object.assign(summary, {
    ok: problems.length === 0 && failing.length === 0,
    durationMs: Date.now() - started,
    counts: {
      total: summary.node.total + summary.playwright.total,
      passed: summary.node.passed + summary.playwright.passed,
      failed: summary.node.failed + summary.playwright.failed,
      skipped: summary.node.skipped + summary.playwright.skipped,
    },
    byPhase,
    failing,
    skipped: skips.verdicts,
    requirements: { total: requirements.total, missing: requirements.missing },
    lockDigest: digestOf(phaseFileHashes(repoRoot, n)),
    problems,
  });

  const out = path.join(logs, `gate-p${n}.json`);
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  say(`gate p${n}: ${summary.ok ? 'PASS' : 'FAIL'} in ${Math.round(summary.durationMs / 1000)} s; node ${summary.node.passed}/${summary.node.total} passed, e2e ${summary.playwright.passed}/${summary.playwright.total} passed, ${summary.counts.skipped} skipped`);
  for (const f of failing.slice(0, 30)) say(`  failed: [${f.file}] ${f.name}`);
  for (const p of problems) say(`  ${p}`);
  say(`Summary: ${out}\nFull output: ${logFile}`);
  return summary.ok ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error(`The gate crashed: ${err.stack}`);
} finally {
  fs.closeSync(logFd);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
// embedded-postgres' exit hook has nothing left to stop by now and would only print a warning about process.exit.
process.removeAllListeners('exit');
process.exit(exitCode);

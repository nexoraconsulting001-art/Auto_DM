/**
 * R-05 (G-10): the whole test suite on the production drivers, with no code change.
 *
 *   drivers_are_production   Postgres with two logins, Redis, the analytics database and an S3-compatible store answer, and the
 *                            app's settings name the production driver for each (QUEUE_DRIVER, CACHE_DRIVER, ANALYTICS_DRIVER, STORAGE_DRIVER)
 *   no_source_change         git shows the same commit and the same changed files after the run as before it (a checksum of each)
 *   suite_passes             every test passes; a test that fails here is run again on the simple drivers (built-in database,
 *                            memory, local files), and the report names each that passes there and fails here
 *
 * The suite runs against a bucket, an analytics database and (empty) Redis made for this run, and on the Postgres server at
 * TEST_DATABASE_URL, where the tests make their own databases; the ones this run made are dropped at the end.
 * With READINESS_ALLOW_SIMPLE_DRIVERS=1 a service that is not named may be left out; the report then says `reduced: true`.
 * READINESS_TEST_FILES (comma separated) names other test files than the whole suite; it is for trying the check itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { STEPS } from '../prod-checks/steps.mjs';
import { createCleanup } from '../prod-checks/cleanup.mjs';
import { assertLocalServices, makeScrub } from '../prod-checks/guard.mjs';
import { createReport, describeProblems } from '../prod-checks/report.mjs';
import { claimRedis, pingServices, provisionBucket, provisionClickhouse, s3Settings, withClient } from '../prod-checks/services.mjs';
import { allLoopback } from '../prod-checks/stack.mjs';
import { compareRuns, counts, failures, gitState, runSuite, sourceChanges } from '../prod-checks/suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASICS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'COMSPEC', 'ComSpec', 'PG_BIN_DIR'];
const basics = () => Object.fromEntries(BASICS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const TEST_DB = /^t_[0-9a-f]{32}$/;

/** The environment the suite runs in on the production drivers. Every driver is named, so none can fall back to a simple one. */
export function productionSettings(env, { bucket, clickhouseDb, reduced }) {
  const settings = { TEST_DATABASE_URL: env.TEST_DATABASE_URL, TEST_DB_LOGINS: '2' };
  if (env.REDIS_URL) Object.assign(settings, { QUEUE_DRIVER: 'redis', CACHE_DRIVER: 'redis', REDIS_URL: env.REDIS_URL });
  if (env.CLICKHOUSE_URL) Object.assign(settings, { ANALYTICS_DRIVER: 'clickhouse', CLICKHOUSE_URL: env.CLICKHOUSE_URL, CLICKHOUSE_DB: clickhouseDb });
  if (env.S3_ENDPOINT && bucket) Object.assign(settings, s3Settings(env, bucket));
  if (!reduced) for (const name of ['QUEUE_DRIVER', 'CACHE_DRIVER', 'ANALYTICS_DRIVER', 'STORAGE_DRIVER']) if (!settings[name]) throw new Error(`${name} has no production service to point at`);
  return settings;
}

export async function run({ env = process.env, keep = false, log = () => {} } = {}) {
  assertLocalServices(env);
  const reduced = env.READINESS_ALLOW_SIMPLE_DRIVERS === '1';
  const scrub = makeScrub(env);
  const report = createReport('r05', { steps: STEPS.r05, scrub, reduced });
  const cleanup = createCleanup({ keep, log });
  const say = (line) => log(scrub(line));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-r05-'));
  cleanup.add('work folder', () => fs.rmSync(dir, { recursive: true, force: true }));
  let settings = null;
  const patterns = env.READINESS_TEST_FILES ? env.READINESS_TEST_FILES.split(',').map((s) => s.trim()).filter(Boolean) : ['test/**/*.test.js'];

  try {
    // The databases the tests make on the server, so the ones this run made can be dropped at the end.
    const existing = await withClient(env.TEST_DATABASE_URL, async (c) => new Set((await c.query('SELECT datname FROM pg_database')).rows.map((r) => r.datname)));
    cleanup.add('the tests\' databases', async () => {
      await withClient(env.TEST_DATABASE_URL, async (c) => {
        const names = (await c.query('SELECT datname FROM pg_database')).rows.map((r) => r.datname).filter((n) => TEST_DB.test(n) && !existing.has(n));
        for (const name of names) await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      });
    }, { data: true });

    let redis = null;
    let clickhouse = null;
    let bucket = null;
    if (env.REDIS_URL) redis = await claimRedis({ url: env.REDIS_URL, cleanup });
    if (env.CLICKHOUSE_URL) clickhouse = await provisionClickhouse({ url: env.CLICKHOUSE_URL, cleanup, label: 'r05' });
    if (env.S3_ENDPOINT && env.S3_BUCKET) bucket = await provisionBucket({ env, cleanup, label: 'r05' });
    settings = productionSettings(env, { bucket: bucket?.bucket, clickhouseDb: clickhouse?.database, reduced });
    const guard = allLoopback([env.TEST_DATABASE_URL, env.REDIS_URL, env.CLICKHOUSE_URL, env.S3_ENDPOINT]);

    // ---- drivers_are_production
    await report.step('drivers_are_production', async () => {
      const answered = await pingServices({ env, bucket, redis, clickhouse });
      // The app's own settings, read the way the app reads them, name the production driver for each service.
      const read = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./src/config.js').then(({config:c})=>console.log(JSON.stringify({queue:c.queueDriver,cache:c.cacheDriver,analytics:c.analyticsDriver,storage:c.storageDriver})))"], { cwd: ROOT, env: { ...basics(), ...settings }, encoding: 'utf8', windowsHide: true });
      if (read.status !== 0) throw new Error('the app could not read its settings with the production drivers set');
      const seen = JSON.parse(read.stdout.trim().split('\n').at(-1));
      const want = { queue: settings.QUEUE_DRIVER, cache: settings.CACHE_DRIVER, analytics: settings.ANALYTICS_DRIVER, storage: settings.STORAGE_DRIVER };
      const wrong = Object.entries(want).filter(([k, v]) => v && seen[k] !== v).map(([k, v]) => `${k} driver is ${seen[k]}, not ${v}`);
      if (!reduced) {
        const dropped = ['queue', 'cache', 'analytics', 'storage'].filter((k) => !want[k]);
        for (const k of dropped) wrong.push(`${k} driver is not set to a production driver`);
      }
      if (wrong.length) return { problems: wrong };
      const named = Object.entries(seen).filter(([k]) => want[k]).map(([k, v]) => `${k}=${v}`).join(' ');
      return `${answered.join(', ')} answer; two logins (TEST_DB_LOGINS=2); ${named}${reduced ? ' (reduced run)' : ''}`;
    }, { blocking: true });

    // ---- the suite, between two looks at git
    const before = gitState(ROOT);
    const passthrough = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('READINESS_PASS_')));
    let production = null;
    await report.step('suite_passes', async () => {
      const concurrency = Number(env.READINESS_TEST_CONCURRENCY) || 4;
      const timeoutMs = Number(env.READINESS_SUITE_TIMEOUT_MS) || 2_400_000;
      const result = await runSuite({ cwd: ROOT, env: { ...basics(), ...settings, ...passthrough }, patterns, resultFile: path.join(dir, 'production.jsonl'), concurrency, timeoutMs, guard });
      production = result;
      if (result.timedOut) return { problems: [`the suite did not finish in ${Math.round(timeoutMs / 60000)} minutes`] };
      if (!result.rows.length) return { problems: [`no test results were written (node exited ${result.code}): ${scrub(result.stderr.split('\n').filter(Boolean).slice(-2).join(' | '))}`] };
      const total = counts(result.rows);
      const failed = failures(result.rows);
      if (!failed.length && result.code === 0) return `${total.passed} tests passed in ${total.files} files on the production drivers (${total.skipped} skipped, 0 failed)`;
      // Run the files that failed again on the simple drivers: what passes there and fails here is what the drivers broke.
      const files = [...new Set(failed.map((f) => f.file).filter(Boolean))];
      const simple = files.length ? await runSuite({ cwd: ROOT, env: { ...basics(), ...passthrough }, patterns: files, resultFile: path.join(dir, 'simple.jsonl'), concurrency: 2, timeoutMs: 1_200_000 }) : { rows: [] };
      const { onlyHere, onBoth } = compareRuns(result.rows, simple.rows);
      const problems = [];
      if (!failed.length) problems.push(`every test passed but node exited ${result.code}`);
      if (onlyHere.length) problems.push(`${onlyHere.length} tests pass on the simple drivers and fail on the production ones: ${describeProblems(onlyHere.map((f) => `${f.file} "${f.name}"${f.error ? ` (${f.error.slice(0, 120)})` : ''}`), { limit: 8 })}`);
      if (onBoth.length) problems.push(`${onBoth.length} tests fail on the simple drivers too: ${describeProblems(onBoth.map((f) => `${f.file} "${f.name}"`), { limit: 8 })}`);
      return { problems };
    });

    // ---- no_source_change (after the suite, so it sees what the suite did)
    await report.step('no_source_change', async () => {
      if (!production) return { problems: ['the suite did not run'] };
      const after = gitState(ROOT);
      const changes = sourceChanges(before, after);
      if (changes.length) return { problems: changes };
      return `commit ${after.head.slice(0, 10)} and ${Object.keys(after.changed).length} locally changed files have the same checksums after the run as before it`;
    });
  } catch (err) {
    for (const name of STEPS.r05) if (!report.has(name)) report.fail(name, `not run: ${String(err.message).split('\n')[0]}`);
  } finally {
    const failed = await cleanup.run();
    cleanup.dispose();
    if (failed.length) say(`could not remove: ${failed.join(', ')}`);
  }
  return report.finish();
}

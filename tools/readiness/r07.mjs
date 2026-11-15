/**
 * R-07 (G-12): a backup and the files of a single-server setup move to a new database and a new object store, and nothing differs
 * but configuration.
 *
 *   source_seeded                    a single-server setup (local files, queue in Postgres) is seeded with businesses, each with an image
 *   backup_taken                     a backup is taken, read back whole, and the source's fingerprint is written
 *   restored_to_new_database         scripts/move-to-cloud.js restores it into a new, empty database
 *   files_copied_to_object_storage   scripts/copy-files.js copies the files; scripts/move-to-cloud.js verify reads each one back
 *   counts_match_per_business        every table's row count, for every business, is the same; the app on the new setup shows the same products
 *   checksums_match_per_business     every table's checksum, for every business, is the same; each image has the same bytes through the app
 *   only_config_changed              the app on the new setup differs from the old only in the settings that name where things are
 *
 * The target is made for this run (a database, a bucket and, when REDIS_URL names an empty one, a Redis) and removed at the end.
 * Differences are named by table, business id and the two counts; no row is ever printed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupStorage, runBackup } from '../../src/backup.js';
import { openDb } from '../../src/db/index.js';
import { checkBackup, pgTools } from '../drill/backup-check.mjs';
import { diffSnapshots, snapshot } from '../drill/compare.mjs';
import { STEPS } from '../prod-checks/steps.mjs';
import { createCleanup } from '../prod-checks/cleanup.mjs';
import { assertLocalServices, makeScrub } from '../prod-checks/guard.mjs';
import { createReport } from '../prod-checks/report.mjs';
import { claimRedis, provisionBucket, provisionPostgres, s3Settings, withClient } from '../prod-checks/services.mjs';
import {
  allLoopback, appEnv, authed, createClient, freePort, lastOutput, multipartFile, pngBytes, rawRequest, runSecrets, seedBusinesses, sha256, signIn, startRole,
  startSimulators, waitWeb, waitWorkerUp,
} from '../prod-checks/stack.mjs';
import { gitState, sourceChanges } from '../prod-checks/suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASICS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'COMSPEC', 'ComSpec', 'PG_BIN_DIR'];
const basics = () => Object.fromEntries(BASICS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

/** The settings that say where the data lives, how big the machine is and which port it listens on: the only ones allowed to change in a move. */
export const MOVE_MAY_CHANGE = Object.freeze([
  /^DATABASE_URL$/, /^DATABASE_OWNER_URL$/, /^PORT$/, /^WORKER_HEALTH_PORT$/, /^META_CALLBACK_BASE_URL$/,
  /^STORAGE_DRIVER$/, /^STORAGE_DIR$/, /^S3_[A-Z_]+$/, /^QUEUE_DRIVER$/, /^CACHE_DRIVER$/, /^REDIS_URL$/, /^ANALYTICS_DRIVER$/, /^CLICKHOUSE_[A-Z_]+$/,
  /^BACKUP_[A-Z_]+$/, /^NODE_OPTIONS$/,
]);

/** The names of settings that differ between two environments, and those among them that a move may not change. Names only, never values. */
export function configDifference(a, b, allowed = MOVE_MAY_CHANGE) {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const changed = names.filter((n) => a[n] !== b[n]);
  const unexpected = changed.filter((n) => !allowed.some((re) => re.test(n)));
  return { changed, unexpected };
}

/** Sorts the lines of a comparison into the step they belong to. */
export function classifyDifference(line) {
  if (/different checksum/i.test(line)) return 'checksums';
  if (/\bfiles?\b|object storage|copied/i.test(line)) return 'files';
  return 'counts';
}

/** The two comparisons of one database snapshot against another, as plain sentences, split into counts and checksums. */
export function compareSnapshots(source, target) {
  const lines = diffSnapshots(source, target, { only: ['rows'], limit: 200 }).map((l) => l.replace('in the source', 'in the old database').replace('after restore', 'in the new database'));
  return { counts: lines.filter((l) => classifyDifference(l) === 'counts'), checksums: lines.filter((l) => classifyDifference(l) === 'checksums') };
}

function runScript(args, env, cwd = ROOT, timeoutMs = 600_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-4000); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => resolve({ code: -1, stderr: 'could not start', stdout }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}
const linesOf = (text, re) => String(text).split('\n').map((l) => l.trim()).filter((l) => re.test(l)).map((l) => l.replace(/^DIFFERENT\s+/, ''));
const lastLine = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';

export async function run({ env = process.env, keep = false, log = () => {} } = {}) {
  assertLocalServices(env);
  const reduced = env.READINESS_ALLOW_SIMPLE_DRIVERS === '1';
  const scrub0 = makeScrub(env);
  let scrubNow = scrub0;
  const report = createReport('r07', { steps: STEPS.r07, scrub: (t) => scrubNow(t), reduced });
  const cleanup = createCleanup({ keep, log });
  const secrets = runSecrets();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-r07-'));
  cleanup.add('work folder', () => fs.rmSync(dir, { recursive: true, force: true }));
  const businesses = Math.max(2, Number(env.READINESS_R07_BUSINESSES) || 3);
  const gitBefore = (() => { try { return gitState(ROOT); } catch { return null; } })();
  const fail = (name, err) => report.fail(name, `not run: ${String(err.message).split('\n')[0]}`);

  try {
    const hasS3 = Boolean(env.S3_ENDPOINT && env.S3_BUCKET);
    if (!hasS3 && !reduced) throw Object.assign(new Error('R-07 needs S3_ENDPOINT and S3_BUCKET (set READINESS_ALLOW_SIMPLE_DRIVERS=1 for a reduced run).'), { code: 'missing_services' });
    const source = await provisionPostgres({ adminUrl: env.TEST_DATABASE_URL, cleanup, label: 'r07src' });
    const target = await provisionPostgres({ adminUrl: env.TEST_DATABASE_URL, cleanup, label: 'r07dst' });
    const bucket = hasS3 ? await provisionBucket({ env, cleanup, label: 'r07' }) : null;
    const redis = env.REDIS_URL ? await claimRedis({ url: env.REDIS_URL, cleanup }) : null;
    const scrub = makeScrub(env, [source.appPassword, target.appPassword, secrets.appSecret, secrets.session, secrets.dataKey, secrets.verifyToken]);
    scrubNow = scrub;
    const sayAll = (line) => log(scrub(line));
    const guard = allLoopback([env.TEST_DATABASE_URL, env.REDIS_URL, env.S3_ENDPOINT]);
    const sourceFiles = path.join(dir, 'source-files');
    const targetFiles = path.join(dir, 'target-files');
    const backupDir = path.join(dir, 'backups');
    for (const d of [sourceFiles, targetFiles, backupDir]) fs.mkdirSync(d, { recursive: true });
    const workerPort = await freePort();
    const webPort = await freePort();
    const sims = await startSimulators({ cleanup, secrets, webhookUrl: `http://127.0.0.1:${webPort}/webhook` });

    // ---- the old setup: the single server's own settings (local files, queue in Postgres, cache in memory)
    const sourceSettings = { BACKUP_STORAGE_DRIVER: 'local', BACKUP_STORAGE_DIR: backupDir };
    const sourceEnv = appEnv({ ownerUrl: source.ownerUrl, appUrl: source.appUrl, port: webPort, workerPort, metaUrl: sims.meta.url, razorpay: sims.razorpay, secrets, storageDir: sourceFiles, settings: sourceSettings, guard });
    const expected = new Map();
    let sourceDb = null;
    let dumpFile = '';
    const fpFile = path.join(dir, 'fingerprint.json');
    const stateFile = path.join(dir, 'copy-state.jsonl');
    let sourceSnap = null;

    await report.step('source_seeded', async () => {
      const tools = await pgTools(process.env);
      if (tools.missing) throw new Error(`${tools.missing} is not on this machine: install the PostgreSQL 16 client tools, or put them on PATH or PG_BIN_DIR`);
      sourceDb = await openDb({ url: source.appUrl, ownerUrl: source.ownerUrl, poolSize: 3 });
      cleanup.add('source database handle', () => sourceDb.close());
      const web = startRole('web', { env: sourceEnv, cleanup, label: 'old web' });
      const worker = startRole('worker', { env: sourceEnv, cleanup, label: 'old worker' });
      try {
        await Promise.all([waitWeb(webPort, web), waitWorkerUp(workerPort, worker)]);
      } catch (err) {
        throw new Error(`the old setup did not start: ${err.message}: ${lastOutput(web.child.exitCode !== null ? web : worker)}`);
      }
      const client = createClient({ port: webPort, connections: 4 });
      const world = { db: sourceDb, meta: sims.meta, razorpay: sims.razorpay, client, secrets, webPort, shops: [], say: () => {} };
      await seedBusinesses(world, businesses);
      let files = 0;
      for (const shop of world.shops) {
        const token = await signIn(client, shop);
        const bytes = await pngBytes();
        const form = multipartFile({ bytes });
        const up = await rawRequest({ port: webPort, method: 'POST', path: '/api/v1/media', host: shop.host, headers: { ...authed(token), 'content-type': form.contentType }, body: form.body });
        if (up.status !== 201) throw new Error(`an image upload for business ${shop.tenantId} answered ${up.status || up.error}`);
        const { id } = JSON.parse(up.body.toString('utf8'));
        const served = await rawRequest({ port: webPort, path: `/media/${id}`, host: shop.host });
        if (served.status !== 200) throw new Error(`the uploaded image of business ${shop.tenantId} cannot be read back (${served.status})`);
        const list = JSON.parse((await client.request({ path: '/api/v1/products', host: shop.host, headers: authed(token) })).text);
        expected.set(shop.tenantId, { shop, products: list.items.length, media: [{ id, sha: sha256(served.body) }] });
        files++;
      }
      client.close();
      // Writes have stopped: the old web server and worker are stopped before the backup, as the runbook says.
      await web.stop();
      await worker.stop();
      const [{ n }] = await sourceDb.platform.query('SELECT count(*)::int AS n FROM tenants');
      const stored = fs.readdirSync(sourceFiles, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
      if (stored < files) throw new Error(`${files} images were uploaded but the old setup holds ${stored} files`);
      return `${businesses} businesses (${n} rows in tenants) seeded on the old setup, each with products and an uploaded image; ${stored} files on disk; web and worker stopped`;
    }, { blocking: true });

    await report.step('backup_taken', async () => {
      const storage = backupStorage({ backupStorageDriver: 'local', backupStorageDir: backupDir });
      const { key, bytes } = await runBackup({ databaseUrl: source.ownerUrl, storage });
      const data = await storage.get(key);
      if (!data?.length) throw new Error('the backup was reported taken but cannot be read back');
      dumpFile = path.join(dir, 'db.dump');
      fs.writeFileSync(dumpFile, data);
      const checked = await checkBackup(dumpFile, { env: process.env });
      if (!checked.ok) return { problems: [`the backup does not read back whole: ${checked.reason}`] };
      const scriptEnv = { ...basics(), DATABASE_URL: source.appUrl, DATABASE_OWNER_URL: source.ownerUrl, DATA_KEY: secrets.dataKey, SESSION_SECRET: secrets.session, APP_SECRET: secrets.appSecret };
      const fp = await runScript(['scripts/move-to-cloud.js', 'fingerprint', '--out', fpFile], scriptEnv);
      if (fp.code !== 0) return { problems: [`the fingerprint of the old database failed: ${scrub(lastLine(fp.stderr))}`] };
      await withClient(source.ownerUrl, async (c) => { sourceSnap = await snapshot(c); });
      return `a ${Math.round(bytes / 1024)} KB backup was taken, read back whole, and the old database's fingerprint written (${Object.keys(sourceSnap.tables).length} tables)`;
    }, { blocking: true });

    const targetSettings = {
      ...(bucket ? s3Settings(env, bucket.bucket) : { STORAGE_DRIVER: 'local', STORAGE_DIR: targetFiles }),
      QUEUE_DRIVER: redis ? 'redis' : 'pg',
      CACHE_DRIVER: redis ? 'redis' : 'memory',
      ANALYTICS_DRIVER: 'pg',
      ...(redis ? { REDIS_URL: env.REDIS_URL } : {}),
    };
    const tPort = await freePort();
    const tWorkerPort = await freePort();
    const targetEnv = appEnv({ ownerUrl: target.ownerUrl, appUrl: target.appUrl, port: tPort, workerPort: tWorkerPort, metaUrl: sims.meta.url, razorpay: sims.razorpay, secrets, storageDir: targetFiles, settings: targetSettings, guard });
    const scriptEnvTarget = { ...basics(), DATABASE_URL: target.appUrl, DATABASE_OWNER_URL: target.ownerUrl, DATA_KEY: secrets.dataKey, SESSION_SECRET: secrets.session, APP_SECRET: secrets.appSecret, ...targetSettings };
    const verifyLines = { counts: [], checksums: [], files: [] };
    let targetSnap = null;

    await report.step('restored_to_new_database', async () => {
      const res = await runScript(['scripts/move-to-cloud.js', 'restore', '--dump', dumpFile], scriptEnvTarget);
      if (res.code !== 0) return { problems: [`the restore into the new database failed (exit ${res.code}): ${scrub(lastLine(res.stderr))}`] };
      await withClient(target.ownerUrl, async (c) => { targetSnap = await snapshot(c); });
      return `restored into a new, empty database: ${scrub(lastLine(res.stderr))}`;
    }, { blocking: true });

    await report.step('files_copied_to_object_storage', async () => {
      const copy = await runScript(['scripts/copy-files.js', '--from', sourceFiles, '--state', stateFile], scriptEnvTarget);
      if (copy.code !== 0) return { problems: [`copying the files failed (exit ${copy.code}): ${scrub(lastLine(copy.stderr))}`] };
      const verify = await runScript(['scripts/move-to-cloud.js', 'verify', '--fingerprint', fpFile, '--files', stateFile], scriptEnvTarget);
      for (const line of linesOf(verify.stderr, /^DIFFERENT/)) verifyLines[classifyDifference(line)].push(scrub(line));
      const keys = bucket ? await bucket.keys() : fs.readdirSync(targetFiles, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
      const wanted = fs.readdirSync(sourceFiles, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
      const problems = [...verifyLines.files];
      if (keys.length !== wanted) problems.push(`the new store holds ${keys.length} files and the old setup ${wanted}`);
      if (verify.code !== 0 && !problems.length && !verifyLines.counts.length && !verifyLines.checksums.length) problems.push(`the data-move check failed (exit ${verify.code}): ${scrub(lastLine(verify.stderr))}`);
      return problems.length ? { problems } : `${wanted} files copied to ${bucket ? 'the new bucket' : 'the new folder'} and each read back with the same checksum`;
    });

    // The app on the new setup: the same code and the same secrets, started on the new database and the new store.
    let app = null;
    const startTarget = async () => {
      if (app) return app;
      const targetDb = await openDb({ url: target.appUrl, ownerUrl: target.ownerUrl, poolSize: 3 });
      cleanup.add('new database handle', () => targetDb.close());
      const web = startRole('web', { env: targetEnv, cleanup, label: 'new web' });
      const worker = startRole('worker', { env: targetEnv, cleanup, label: 'new worker' });
      await Promise.all([waitWeb(tPort, web), waitWorkerUp(tWorkerPort, worker)]).catch((err) => {
        throw new Error(`the app did not start on the new setup: ${err.message}: ${lastOutput(web.child.exitCode !== null ? web : worker)}`);
      });
      app = { web, worker, client: createClient({ port: tPort, connections: 4 }) };
      cleanup.add('new client', async () => app.client.close());
      return app;
    };

    await report.step('counts_match_per_business', async () => {
      if (!targetSnap) throw new Error('there is no restored database to compare');
      const problems = [...compareSnapshots(sourceSnap, targetSnap).counts, ...verifyLines.counts];
      const { client } = await startTarget();
      for (const [tenantId, want] of expected) {
        const token = await signIn(client, want.shop).catch((err) => { problems.push(`business ${tenantId} cannot sign in on the new setup (${err.message})`); return null; });
        if (!token) continue;
        const res = await client.request({ path: '/api/v1/products', host: want.shop.host, headers: authed(token) });
        const got = res.status === 200 ? JSON.parse(res.text).items.length : null;
        if (got !== want.products) problems.push(`business ${tenantId}: ${want.products} products on the old setup, ${got ?? `status ${res.status || res.error}`} on the new one`);
      }
      return problems.length ? { problems } : `every table has the same row count for each of ${sourceSnap.tenantIds.length} businesses, and the app on the new setup shows the same products`;
    });

    await report.step('checksums_match_per_business', async () => {
      if (!targetSnap) throw new Error('there is no restored database to compare');
      const problems = [...compareSnapshots(sourceSnap, targetSnap).checksums, ...verifyLines.checksums];
      const { client } = await startTarget();
      for (const [tenantId, want] of expected) {
        for (const media of want.media) {
          const res = await rawRequest({ port: tPort, path: `/media/${media.id}`, host: want.shop.host });
          if (res.status !== 200) problems.push(`business ${tenantId}: an image answers ${res.status || res.error} on the new setup`);
          else if (sha256(res.body) !== media.sha) problems.push(`business ${tenantId}: an image has different bytes on the new setup`);
        }
      }
      void client;
      return problems.length ? { problems } : `every table has the same checksum for each business, and each uploaded image has the same bytes through the app on the new setup`;
    });

    await report.step('only_config_changed', async () => {
      const { changed, unexpected } = configDifference(sourceEnv, targetEnv);
      const problems = unexpected.map((n) => `${n} is different on the new setup, and a move may not change it`);
      const settingsOnly = ['DATA_KEY', 'SESSION_SECRET', 'APP_SECRET'].filter((n) => sourceEnv[n] !== targetEnv[n]);
      for (const n of settingsOnly) if (!problems.some((p) => p.startsWith(n))) problems.push(`${n} is different on the new setup`);
      if (gitBefore) problems.push(...sourceChanges(gitBefore, gitState(ROOT)));
      else problems.push('the code could not be compared: this is not a git checkout');
      // The app answered on the new setup with the same code: the steps above started it.
      if (app) {
        const ready = await fetch(`http://127.0.0.1:${tPort}/readyz`, { signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch(() => 0);
        if (ready !== 200) problems.push(`/readyz on the new setup answered ${ready || 'nothing'}`);
      } else problems.push('the app did not run on the new setup');
      return problems.length ? { problems } : `the old and new setups differ in ${changed.length} settings, all of them where things are (${changed.filter((n) => !/PORT|BASE_URL/.test(n)).join(', ')}); the code and every secret are the same`;
    });
    sayAll('R-07 finished');
  } catch (err) {
    for (const name of STEPS.r07) if (!report.has(name)) fail(name, err);
  } finally {
    const failed = await cleanup.run();
    cleanup.dispose();
    if (failed.length) log(`could not remove: ${failed.join(', ')}`);
  }
  return report.finish();
}

/**
 * The restore drill: the steps of DRILL_STEPS in order, each timed, each one check of the report. index.mjs holds the
 * command line and the names. Everything is on this machine: two embedded Postgres servers set as the QA server's.
 *
 * `deps` lets a test stand in for the two things that need the PostgreSQL client programs (backup and restore); the real
 * ones are src/backup.js. Nothing printed here carries a secret: every message goes through scrub().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DRILL_STEPS, BAD_BACKUPS } from './index.mjs';
import { damage, checkBackup, pgTools, toolEnv } from './backup-check.mjs';
import { checkFence, checkLogins, coverage, diffSnapshots, snapshot } from './compare.mjs';
import { DrillError } from './sql.mjs';
import { drive, percentile, sleep } from '../load/http.mjs';
import { scrub } from '../load/runner.mjs';
import { ROOT, startNode, startPostgres, writeReport } from '../load/stack.mjs';
import { classPlans, createRecorder, createRng } from '../load/traffic.mjs';
import { waitDrained } from '../load/verify.mjs';
import { childEnv, freePort, startWorld, waitReady, waitWorker } from '../load/world.mjs';

export const DRILL_BUSINESSES = 3;
const SEED_SECONDS = 12;
const SEED_RPS = 15;

const round1 = (v) => Math.round(v * 10) / 10;
const seconds = (ms) => round1(ms / 1000);

export async function runDrill({ budgets, only, out = 'drill', root, say = (m) => console.log(`drill: ${m}`), deps = {} }) {
  const startedAt = new Date().toISOString();
  const wanted = new Set(only.flatMap((part) => (part === 'restore' ? ['seed', 'backup', 'restore', 'compare', 'fence', 'logins', 'start'] : ['seed', 'backup', 'refuse'])));
  const steps = DRILL_STEPS.filter((s) => wanted.has(s));
  const checks = [];
  const timings = {};
  const notes = [];
  const data = {};
  const summary = [];
  const ctx = {};
  let secrets = [];
  const closers = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-drill-'));

  const backupMod = deps.backup ?? (await import('../../src/backup.js'));
  const runBackup = deps.runBackup ?? backupMod.runBackup;
  const runRestore = deps.runRestore ?? backupMod.runRestore;
  const dbMod = await import('../../src/db/index.js');
  const { default: pg } = await import('pg');
  const connect = async (url) => {
    const client = new pg.Client({ connectionString: url });
    client.on('error', () => {}); // a server that goes away under it is the test's business, not a crash
    await client.connect();
    closers.push(() => client.end());
    return client;
  };

  // The PostgreSQL client programs the real backup and restore need. Without them the drill cannot say anything true.
  const tools = deps.pgTools ? await deps.pgTools() : await pgTools();
  if (tools.missing) {
    const message = `${tools.missing} was not found. The drill runs the real backup and restore, which need the PostgreSQL 16 client programs (pg_dump and pg_restore) on the PATH, or in the folder PG_BIN_DIR names.`;
    const report = {
      title: 'Restore drill', ok: false, ofRecord: false, startedAt, finishedAt: new Date().toISOString(), summary: [['Tools', `${tools.missing} not found`]],
      checks: [{ id: 'Q-08', name: 'the PostgreSQL client programs are available', ok: false, measured: `${tools.missing} not found`, limit: 'pg_dump and pg_restore 16' }], notes: [message],
    };
    writeReport(out, report, root ? { root } : undefined);
    say(message);
    fs.rmSync(dir, { recursive: true, force: true });
    return report;
  }
  // src/backup.js starts pg_dump and pg_restore with this process's environment: put PG_BIN_DIR on this process's own path, for this run.
  for (const [key, value] of Object.entries(toolEnv())) if (key.toLowerCase() === 'path' && value !== undefined) process.env[key] = value;
  data.tools = tools;

  const record = (id, name, ok, measured, limit) => checks.push({ id, name, ok: Boolean(ok), measured, limit });
  const failedBefore = () => checks.some((c) => !c.ok);

  async function step(name, id, label, limit, fn) {
    if (!steps.includes(name)) return;
    const begin = performance.now();
    try {
      if (failedBefore() && !['seed', 'backup'].includes(name) && ctx.broken) throw new DrillError('An earlier step failed, so this one cannot be shown to work.');
      const result = await fn();
      timings[name] = performance.now() - begin;
      record(id, label, result.ok, result.measured, limit);
      if (!result.ok && ['seed', 'backup', 'restore'].includes(name)) ctx.broken = true;
    } catch (err) {
      timings[name] = performance.now() - begin;
      record(id, label, false, scrub(err?.message ?? err, secrets).split('\n')[0].slice(0, 300), limit);
      if (['seed', 'backup', 'restore'].includes(name)) ctx.broken = true;
    }
  }

  try {
    // ---- seed -----------------------------------------------------------------------------------------------------
    await step('seed', '', 'a source database with businesses and activity', 'at least 2 businesses with rows', async () => {
      const businesses = deps.businesses ?? DRILL_BUSINESSES;
      const seedSeconds = deps.seedSeconds ?? SEED_SECONDS;
      say(`seed: ${businesses} businesses and ${seedSeconds} s of traffic on a Postgres with the QA settings`);
      const world = await startWorld({ budgets, dir: path.join(dir, 'source'), businesses, say });
      ctx.source = world;
      closers.push(() => world.close());
      secrets = [world.secrets.appSecret, world.secrets.verifyToken, world.secrets.session, world.secrets.dataKey, ...world.shops.map((s) => s.token), ...world.shops.map((s) => s.owner.password), world.pg.ownerUrl, world.pg.appUrl];
      const rec = createRecorder();
      await drive({ client: world.client, plan: classPlans({ world, rec, rps: SEED_RPS, mix: budgets.mix, rng: createRng(7), tag: 'd1' }), seconds: seedSeconds, onResult: rec.onResult });
      const drained = await waitDrained(world, { ms: 60_000 });
      // Nothing may be writing while the backup is taken: stop the app's two processes, as a restore runbook does.
      await world.web.stop();
      await world.worker.stop();
      ctx.sourceOwner = await connect(world.pg.ownerUrl);
      ctx.sourceSnap = await snapshot(ctx.sourceOwner);
      // The app's own connections are not needed again, and a server that is about to be copied must have none open.
      await world.db.close().catch(() => {});
      const cover = coverage(ctx.sourceSnap);
      data.source = cover;
      summary.push(['Source', `${cover.businesses} businesses, ${cover.tables} tables (${cover.tenantTables} with a business column), ${cover.rows} rows`]);
      return { ok: drained && cover.businesses >= 2 && cover.rows > 0, measured: `${cover.businesses} businesses, ${cover.rows} rows${drained ? '' : ', queues did not drain'}` };
    });

    // ---- backup ---------------------------------------------------------------------------------------------------
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const storage = backupMod.backupStorage({ backupStorageDriver: 'local', backupStorageDir: backupDir });
    await step('backup', 'R-03', 'backup taken with the real backup code', 'a non-empty backup', async () => {
      const t0 = performance.now();
      const made = await runBackup({ databaseUrl: ctx.source.pg.ownerUrl, storage, now: new Date() });
      ctx.backup = made;
      data.backup = { key: made.key, bytes: made.bytes, seconds: seconds(performance.now() - t0) };
      summary.push(['Backup', `${made.bytes} bytes in ${seconds(performance.now() - t0)} s`]);
      return { ok: made.bytes > 0, measured: `${made.bytes} bytes in ${seconds(performance.now() - t0)} s` };
    });

    // ---- restore --------------------------------------------------------------------------------------------------
    await step('restore', 'R-03', 'restore into an empty Postgres with the real restore code', `within ${budgets.drill.restoreWithinSeconds} s`, async () => {
      const target = deps.startTarget ? await deps.startTarget({ source: ctx.source.pg, dir: path.join(dir, 'target') }) : await startPostgres({ dir: path.join(dir, 'target'), budgets, appLogin: false });
      ctx.target = target;
      closers.push(() => target.stop());
      secrets.push(target.ownerUrl, target.appUrl);
      const t0 = performance.now();
      await runRestore({ databaseUrl: target.ownerUrl, storage, key: ctx.backup.key });
      const took = performance.now() - t0;
      ctx.targetOwner = await connect(target.ownerUrl);
      ctx.restoredSnap = await snapshot(ctx.targetOwner);
      data.restore = { seconds: seconds(took) };
      summary.push(['Restore', `${seconds(took)} s (limit ${budgets.drill.restoreWithinSeconds} s)`]);
      return { ok: took <= budgets.drill.restoreWithinSeconds * 1000, measured: `${seconds(took)} s` };
    });

    // ---- compare --------------------------------------------------------------------------------------------------
    await step('compare', 'Q-08', 'compare every business: row counts and checksums match, table by table', 'no difference', async () => {
      const diffs = diffSnapshots(ctx.sourceSnap, ctx.restoredSnap, { only: ['rows', 'sequences'] });
      const cover = coverage(ctx.restoredSnap);
      data.compare = { ...cover, differences: diffs };
      return { ok: diffs.length === 0 && cover.businesses >= 2, measured: diffs.length ? `${diffs.length} differences: ${diffs.slice(0, 3).join('; ')}` : `${cover.tables} tables, ${cover.businesses} businesses, ${cover.rows} rows, all the same` };
    });

    // ---- fence ----------------------------------------------------------------------------------------------------
    await step('fence', 'Q-08', 'the fence: each business sees only its own rows, none with no business set', 'no row of another business visible', async () => {
      // The app makes its login on a new server when it first starts (src/db ensureAppLogin); the drill does the same, then asks as that login.
      await dbMod.ensureAppLogin({ exec: (sql) => ctx.targetOwner.query(sql), query: async (sql, params) => (await ctx.targetOwner.query(sql, params)).rows }, ctx.target.appUrl);
      ctx.targetApp = await connect(ctx.target.appUrl);
      const settings = diffSnapshots(ctx.sourceSnap, ctx.restoredSnap, { only: ['security'] });
      const fence = await checkFence(ctx.targetApp, ctx.restoredSnap);
      data.fence = { checked: fence.checked, problems: [...settings, ...fence.problems] };
      const problems = [...settings, ...fence.problems];
      return { ok: problems.length === 0 && fence.checked > 0, measured: problems.length ? `${problems.length} problems: ${problems.slice(0, 3).join('; ')}` : `${fence.checked} table and business reads, security settings the same as the source` };
    });

    // ---- logins ---------------------------------------------------------------------------------------------------
    await step('logins', 'Q-08', 'the grants, and both logins work', 'owner and restricted app login, same grants', async () => {
      const grants = diffSnapshots(ctx.sourceSnap, ctx.restoredSnap, { only: ['grants'] });
      const logins = await checkLogins({ owner: ctx.targetOwner, app: ctx.targetApp, assertRestrictedLogin: dbMod.assertRestrictedLogin });
      const problems = [...grants, ...logins.problems];
      data.logins = { problems, businessesSeenByOwner: logins.businesses };
      return { ok: problems.length === 0 && logins.businesses === ctx.restoredSnap.tenantIds.length, measured: problems.length ? `${problems.length} problems: ${problems.slice(0, 3).join('; ')}` : `owner reads ${logins.businesses} businesses, app login is restricted and cannot change a table, grants the same` };
    });

    // ---- start ----------------------------------------------------------------------------------------------------
    await step('start', 'Q-08', 'the app starts on the restored database and serves each business', '/readyz answers, sign-in and pages work, no business sees another', async () => {
      const world = ctx.source;
      const webPort = await freePort();
      const workerPort = await freePort();
      const env = childEnv({ ownerUrl: ctx.target.ownerUrl, appUrl: ctx.target.appUrl, webPort, workerPort, metaUrl: world.meta.url, razorpay: world.razorpay, secrets: world.secrets, storageDir: path.join(dir, 'files-restored') });
      fs.mkdirSync(env.STORAGE_DIR, { recursive: true });
      const { createClient } = await import('../load/http.mjs');
      const client = createClient({ port: webPort, connections: 8 });
      const t0 = performance.now();
      const web = startNode('web', { budgets, env });
      const worker = startNode('worker', { budgets, env });
      try {
        await Promise.all([waitReady(client, undefined, 90_000, web), waitWorker(workerPort, 90_000, worker)]);
        const upMs = performance.now() - t0;
        const [one, two] = world.shops;
        const login = await client.request({ method: 'POST', path: '/api/v1/auth/login', host: one.host, body: one.owner });
        const token = login.status === 201 ? JSON.parse(login.text).token : null;
        const orders = token ? await client.request({ path: '/api/v1/orders', host: one.host, headers: { authorization: `Bearer ${token}` } }) : { status: 0 };
        const page = await client.request({ path: '/shop', host: one.host });
        const crossed = token ? await client.request({ path: '/api/v1/orders', host: two.host, headers: { authorization: `Bearer ${token}` } }) : { status: 0 };
        const problems = [];
        if (login.status !== 201) problems.push(`the first business's owner could not sign in (${login.status})`);
        if (orders.status !== 200) problems.push(`its orders answered ${orders.status}`);
        if (page.status !== 200) problems.push(`its shop page answered ${page.status}`);
        if (crossed.status === 200) problems.push('the first business\'s sign-in worked on the second business');
        data.start = { upSeconds: seconds(upMs), problems };
        summary.push(['App start on the restored copy', `${seconds(upMs)} s to answer /readyz and /healthz`]);
        return { ok: problems.length === 0, measured: problems.length ? problems.join('; ') : `up in ${seconds(upMs)} s; sign-in, orders and shop page answer; the first business's sign-in is refused on the second (${crossed.status})` };
      } finally {
        client.close();
        await web.stop().catch(() => {});
        await worker.stop().catch(() => {});
      }
    });

    // ---- refuse ---------------------------------------------------------------------------------------------------
    await step('refuse', 'Q-09', 'a truncated, corrupted and wrong-version backup are each refused and the target is untouched', 'refused before restoring, target identical', async () => {
      const targetUrl = ctx.target?.ownerUrl ?? ctx.source.pg.ownerUrl;
      const owner = ctx.targetOwner ?? ctx.sourceOwner;
      const good = await storage.get(ctx.backup.key);
      const results = {};
      const problems = [];
      for (const kind of Object.keys(BAD_BACKUPS)) {
        const bad = damage(good, kind);
        const key = `backups/bad-${kind}.dump`;
        await storage.put(key, bad, 'application/octet-stream');
        const file = path.join(dir, `bad-${kind}.dump`);
        fs.writeFileSync(file, bad);
        const before = await snapshot(owner, { perTenant: false });
        const pre = await (deps.checkBackup ?? checkBackup)(file, { env: process.env });
        let refusedBy = '';
        try {
          await runRestore({ databaseUrl: targetUrl, storage, key });
        } catch (err) {
          refusedBy = scrub(err?.message ?? err, secrets).split('\n')[0].slice(0, 160);
        }
        const after = await snapshot(owner, { perTenant: false });
        const changed = diffSnapshots(before, after, { only: ['rows', 'sequences', 'grants', 'security'] });
        results[kind] = { precheckRefused: !pre.ok, precheck: pre.ok ? '' : pre.reason, restoreRefused: Boolean(refusedBy), restoreError: refusedBy, targetChanged: changed.length };
        if (pre.ok) problems.push(`${kind}: the check before restoring accepted it`);
        if (!refusedBy) problems.push(`${kind}: the real restore accepted it`);
        if (changed.length) problems.push(`${kind}: the target changed (${changed[0]})`);
      }
      data.refuse = results;
      return { ok: problems.length === 0, measured: problems.length ? problems.join('; ') : 'all three refused by the check before restoring and by the restore, target identical after each (counts and checksums)' };
    });
  } catch (err) {
    record('Q-08', 'the drill ran to the end', false, scrub(err?.message ?? err, secrets).split('\n')[0].slice(0, 300), 'no error');
  } finally {
    for (const close of closers.reverse()) await Promise.resolve().then(close).catch(() => {});
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  summary.unshift(['Parts', only.join(', ')]);
  summary.push(['Step times (s)', Object.entries(timings).map(([k, v]) => `${k} ${seconds(v)}`).join(', ')]);
  notes.push('The backup and the restore are src/backup.js (runBackup, runRestore), run on the same two-login Postgres as the QA server; nothing here replaces them.');
  notes.push('A backup holds the database only. The data key, the session secret and the uploaded files are not in it and are not drilled here: see docs/runbooks/backup-restore.md.');
  notes.push('The source is a database this drill seeded: businesses made through the console API, then traffic through the simulators. The restored copy is on a second server.');
  const report = {
    title: 'Restore drill',
    ok: checks.length > 0 && checks.every((c) => c.ok) && steps.every((s) => s in timings),
    ofRecord: only.length === 2,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary,
    checks,
    notes,
    data: { ...data, timingsSeconds: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, seconds(v)])) },
  };
  const files = writeReport(out, JSON.parse(scrub(JSON.stringify(report), secrets)), root ? { root } : undefined);
  say(`report: ${files.md}`);
  for (const c of checks) say(`${c.ok ? 'pass' : 'FAIL'}  ${c.id} ${c.name}: ${c.measured}`);
  say(report.ok ? 'PASS' : 'FAIL');
  return report;
}

export { percentile, ROOT };

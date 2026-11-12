import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_PLATFORMS, APP_VERSION, isBelowMinimum } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { BUILD_STEPS, canMove } from '../../contracts/apps.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';
import { appConfigFor } from '../app-config/index.js';
import { toolOptions } from './pipeline.js';

/**
 * Per-brand builds (PRD 10.8). See index.js for the interface; this file holds the rules.
 *
 *   One shared app version: every build takes the app version and runtime of the newest app_runtimes row (a native-change
 *   batch writes a new one; with none, the shopper app's own version). Each brand has its own build number per platform, taken
 *   with UPDATE ... RETURNING in the transaction that inserts the build, under a lock on the brand's app_configs row.
 *   One build per request key and platform (the unique key is the second lock), and one running build per platform.
 *   A seller's request is refused before anything is written when the plan lacks the platform (403) or the details would not
 *   build (409, naming every field). A native-change batch writes a build for every entitled brand with an app (built before,
 *   or complete details) and reports each; a brand whose details broke stops at its own validate step and never stops the
 *   others. A build the service no longer knows (404 while following it) is failed, so it never holds the platform for ever.
 *   A build runs on the queue (app-builds.run) through tools/build-brand: load, validate, assets, brand file, then the driver.
 *   The eas driver only starts the build; app-builds.poll follows it, keeps the artifact in private storage, and hands a built
 *   production build to app-submissions (appSubmissionsFor(ctx).submit) for the brand's own store accounts.
 *   Nothing here logs a name, a token or a message: builds are named by id, business and platform.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const RUN_QUEUE = 'app-builds.run';
export const POLL_QUEUE = 'app-builds.poll';
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,80}$/;
const RUNNING = ['queued', 'building'];
const KIT_STEPS = ['load', 'validate', 'assets', 'brand_file'];
const NEXT_BUILD = Object.freeze({ android: 'android_next_build', ios: 'ios_next_build' });
/** markStatus's `set`: route-style and column names, each to its column. The only column names a caller can reach. */
const SET_COLUMNS = Object.freeze({
  failedStep: 'failed_step', failedField: 'failed_field', failedMessage: 'failed_message', submitError: 'submit_error',
  providerBuildId: 'provider_build_id', providerSubmissionId: 'provider_submission_id', artifactKey: 'artifact_key',
  fingerprint: 'fingerprint', configHash: 'config_hash', startedAt: 'started_at', finishedAt: 'finished_at', submittedAt: 'submitted_at',
});
const COLUMN_OF = new Map([...Object.entries(SET_COLUMNS), ...Object.values(SET_COLUMNS).map((c) => [c, c])]);
const LIMITS = { failed_field: 80, failed_message: 500, submit_error: 500, provider_build_id: 80, provider_submission_id: 80, artifact_key: 300, fingerprint: 80, config_hash: 80 };

const NO_APP = 'Your plan doesn’t include your own shopper app.';
const NO_PLATFORM = { android: 'Your plan doesn’t include an Android app.', ios: 'Your plan doesn’t include an iPhone app.' };
const BUSY = 'A build of this app is already running. Wait for it to finish.';
const BUSY_IN_BATCH = 'Another build of this app was still running. Build it again once that one finishes.';
const STUCK = 'The build did not start. Ask for it again.';
const MAX_ARTIFACT = 300 * 1024 * 1024;

/** Text that may go into a column: no control characters, at most `max` characters. */
export const clip = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
const iso = (value) => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The AppBuild route shape of a row. */
export function buildOut(r) {
  return {
    id: Number(r.id),
    platform: r.platform,
    appVersion: r.app_version,
    buildNumber: Number(r.build_number),
    runtimeVersion: r.runtime_version,
    status: r.status,
    reason: r.reason,
    failedStep: r.failed_step ?? '',
    failedField: r.failed_field ?? '',
    failedMessage: r.failed_message ?? '',
    submitError: r.submit_error ?? '',
    createdAt: iso(r.created_at),
    finishedAt: iso(r.finished_at),
    submittedAt: iso(r.submitted_at),
  };
}

/** The runtime every brand starts on before our team has made one: the shopper app's own version and native dependencies. */
export function shopperRuntime(root = ROOT) {
  let version = '1.0.0';
  let deps = 'shopper';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'apps/shopper/package.json'), 'utf8'));
    if (APP_VERSION.test(String(pkg.version))) version = String(pkg.version);
    deps = JSON.stringify(Object.entries(pkg.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  } catch {
    // The server image has no app source: the first runtime is a placeholder until a native-change batch names the real one.
  }
  return { runtimeVersion: version, appVersion: version, fingerprint: `fp${sha256(`${version}:${deps}`).slice(0, 30)}` };
}

/** The refusal of a request whose details would not build: every problem, each naming its field (P-33). */
function kitRefusal(problems) {
  const fields = {};
  for (const p of problems) fields[p.field] ??= p.message;
  const first = problems[0];
  const more = problems.length > 1 ? ` (${problems.length - 1} more to fix)` : '';
  return new ApiError('conflict', `Your app can’t be built yet: ${first.message}${more}`, { fields });
}

/**
 * The builds service of one context. `seams` is for tests and the command line: { exec, drivers, anyHost, log } go to the build
 * tool, `submit(buildId, { actor })` replaces app-submissions' submit, and `autoSubmit: false` leaves built builds unsent.
 */
export function createAppBuilds(ctx, seams = {}) {
  const { db } = ctx;
  const config = ctx.config ?? {};
  const platformDb = () => db.platform ?? db;
  const pollMs = () => Math.max(20, Number(config.appBuildPollMs) || 15_000);
  const appConfig = () => appConfigFor(ctx);
  const queue = () => ctx.platform?.queue ?? null;
  const storage = () => ctx.platform?.storage ?? null;

  // ---- one build's status: the only code that writes app_builds.status ----

  async function markStatus(t, id, to, { set = {}, ifAllowed = false } = {}) {
    const tid = tenantId();
    const [row] = await t.query('SELECT * FROM app_builds WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, Number(id)]);
    if (!row) {
      if (ifAllowed) return null;
      throw new Error('There is no such build.');
    }
    if (!canMove('app_build', row.status, to)) {
      if (ifAllowed) return null;
      throw new Error(`A build cannot go from ${row.status} to ${to}.`);
    }
    const values = new Map();
    for (const [key, value] of Object.entries(set)) {
      const column = COLUMN_OF.get(key);
      if (!column) throw new Error(`markStatus cannot set ${key}`);
      values.set(column, LIMITS[column] ? clip(value, LIMITS[column]) : value);
    }
    if (to === 'building' && !values.has('started_at')) values.set('started_at', new Date());
    if ((to === 'built' || to === 'failed') && !values.has('finished_at')) values.set('finished_at', new Date());
    if (to === 'submitted' && !values.has('submitted_at')) values.set('submitted_at', new Date());
    if (to === 'failed') {
      if (!BUILD_STEPS.includes(values.get('failed_step'))) values.set('failed_step', 'build');
      if (!values.get('failed_message')) values.set('failed_message', 'The build stopped.');
    }
    const columns = [...values.keys()];
    const [updated] = await t.query(
      `UPDATE app_builds SET status = $3${columns.map((c, i) => `, ${c} = $${i + 4}`).join('')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tid, Number(id), to, ...columns.map((c) => values.get(c))],
    );
    if (to === 'failed') await tellOwner(t, updated);
    return updated;
  }

  /** A failed build reaches the owner through ctx.notify, in the same transaction, on a savepoint so it never undoes the failure. */
  async function tellOwner(t, build) {
    if (typeof ctx.notify?.emit !== 'function') return;
    if (build.reason !== 'brand' && !KIT_STEPS.includes(build.failed_step)) return;
    try {
      await t.query('SAVEPOINT app_build_notify');
      await ctx.notify.emit({ event: 'app.build_failed', tenantId: Number(build.tenant_id), key: `build:${Number(build.id)}`, data: { buildId: Number(build.id) } }, t);
      await t.query('RELEASE SAVEPOINT app_build_notify');
    } catch (err) {
      await t.query('ROLLBACK TO SAVEPOINT app_build_notify').catch(() => {});
      log.warn('app_builds.notify_failed', { buildId: Number(build.id), error: err?.name ?? 'Error' });
    }
  }

  const fail = (id, { step = 'build', field = '', message = '' }) => db.tx((t) => markStatus(t, id, 'failed', {
    set: { failedStep: BUILD_STEPS.includes(step) ? step : 'build', failedField: field ?? '', failedMessage: message || 'The build stopped.' },
    ifAllowed: true,
  }));

  // ---- reading ----

  async function rowOf(id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return null;
    const [row] = await db.query('SELECT * FROM app_builds WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(id)]);
    return row ?? null;
  }

  async function get(id) {
    const row = await rowOf(id);
    return row ? buildOut(row) : null;
  }

  async function list({ platform, cursor, limit = 25 } = {}) {
    await appConfig().requireApp();
    const after = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] > 0)[0] : null;
    const rows = await db.query(
      `SELECT * FROM app_builds WHERE tenant_id = $1 AND ($2::text IS NULL OR platform = $2) AND ($3::bigint IS NULL OR id < $3)
       ORDER BY id DESC LIMIT $4`,
      [tenantId(), APP_PLATFORMS.includes(platform) ? platform : null, after, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (row) => [Number(row.id)]);
    return { items: page.items.map(buildOut), nextCursor: page.nextCursor };
  }

  // ---- asking for builds ----

  async function currentRuntime() {
    const p = platformDb();
    const [newest] = await p.query('SELECT * FROM app_runtimes ORDER BY created_at DESC, runtime_version DESC LIMIT 1');
    if (newest) return newest;
    const first = shopperRuntime();
    await p.query('INSERT INTO app_runtimes (runtime_version, fingerprint, app_version) VALUES ($1, $2, $3) ON CONFLICT (runtime_version) DO NOTHING', [first.runtimeVersion, first.fingerprint, first.appVersion]);
    const [made] = await p.query('SELECT * FROM app_runtimes WHERE runtime_version = $1', [first.runtimeVersion]);
    return made;
  }

  /** The 'brand' batch of one request, written through db.platform: the table is the platform's alone. One per request key. */
  async function brandBatch(tid, requestKey, actor) {
    const runtime = await currentRuntime();
    const key = `brand-${sha256(`${tid}:${requestKey}`).slice(0, 40)}`;
    const p = platformDb();
    const [made] = await p.query(
      `INSERT INTO app_build_batches (reason, tenant_id, app_version, runtime_version, requested_by, request_key) VALUES ('brand', $1, $2, $3, $4, $5)
       ON CONFLICT (request_key) DO NOTHING RETURNING *`,
      [tid, runtime.app_version, runtime.runtime_version, clip(actor, 80), key],
    );
    if (made) return made;
    const [found] = await p.query('SELECT * FROM app_build_batches WHERE request_key = $1 AND tenant_id = $2', [key, tid]);
    if (!found) throw new ApiError('conflict', 'That request could not be matched. Ask again.');
    return found;
  }

  /**
   * One build row of `platform` in `batch`, or the row this request key already made. `busyFails`: a build already running is
   * written as a failed build that says so (a batch reports every brand) instead of refusing the request.
   */
  async function insertBuild({ tid, batch, platform, requestKey, actor, busyFails = false }) {
    const driver = config.appBuildDriver === 'eas' ? 'eas' : 'local';
    const profile = driver === 'eas' ? 'production' : 'preview';
    const column = NEXT_BUILD[platform];
    const byKey = async (runner) => (await runner.query('SELECT * FROM app_builds WHERE tenant_id = $1 AND platform = $2 AND request_key = $3', [tid, platform, requestKey]))[0];
    try {
      return await db.tx(async (t) => {
        const [locked] = await t.query('SELECT tenant_id FROM app_configs WHERE tenant_id = $1 FOR UPDATE', [tid]);
        if (!locked) throw new ApiError('conflict', 'Fill in your app’s details first.');
        const dup = await byKey(t);
        if (dup) return dup;
        const [running] = await t.query(`SELECT id FROM app_builds WHERE tenant_id = $1 AND platform = $2 AND status IN ('queued', 'building') LIMIT 1`, [tid, platform]);
        if (running && !busyFails) throw new ApiError('conflict', BUSY);
        const [{ n }] = await t.query(`UPDATE app_configs SET ${column} = ${column} + 1, updated_at = now() WHERE tenant_id = $1 RETURNING ${column} - 1 AS n`, [tid]);
        const failed = Boolean(running);
        const [build] = await t.query(
          `INSERT INTO app_builds (tenant_id, batch_id, reason, platform, app_version, build_number, runtime_version, driver, profile, status,
                                   failed_step, failed_message, request_key, requested_by, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
          [tid, Number(batch.id), batch.reason, platform, batch.app_version, Number(n), batch.runtime_version, driver, profile, failed ? 'failed' : 'queued',
            failed ? 'load' : '', failed ? BUSY_IN_BATCH : '', requestKey, clip(actor, 80), failed ? new Date() : null],
        );
        return build;
      });
    } catch (err) {
      if (err?.code !== '23505') throw err;
      const dup = await byKey(db);
      if (dup) return dup;
      throw new ApiError('conflict', BUSY);
    }
  }

  async function enqueueRuns(builds) {
    const q = queue();
    if (!q) return;
    for (const b of builds.filter((x) => x.status === 'queued')) {
      await q.enqueue(RUN_QUEUE, { buildId: Number(b.id) }, { tenantId: Number(b.tenant_id), dedupeKey: `t${Number(b.tenant_id)}:build:${Number(b.id)}`, maxAttempts: 3 });
    }
  }

  async function schedulePoll(delayMs = pollMs()) {
    const q = queue();
    if (!q) return;
    await q.enqueue(POLL_QUEUE, {}, { delayMs, dedupeKey: `poll:${Math.floor((Date.now() + delayMs) / pollMs())}`, maxAttempts: 1 });
  }

  /** The rows of one request: the builds this key already made, plus new ones for the platforms it has not. */
  async function requestRows({ platforms, requestKey, actor = 'system', check = true }) {
    const tid = tenantId();
    const wanted = [...new Set(Array.isArray(platforms) ? platforms : [])];
    if (!wanted.length || wanted.some((p) => !APP_PLATFORMS.includes(p))) throw new ApiError('validation_failed', 'Choose android, ios or both.', { fields: { platforms: 'Choose android, ios or both.' } });
    if (!REQUEST_KEY.test(String(requestKey ?? ''))) throw new ApiError('validation_failed', 'Use 8 to 80 letters, digits, - or _', { fields: { requestKey: 'Use 8 to 80 letters, digits, - or _' } });
    // The plan is checked here, on the server, whatever a screen shows (Android from tier 4, iOS from tier 5).
    const entitled = await appConfig().entitledPlatforms();
    if (!entitled.length) throw new ApiError('forbidden', NO_APP);
    const refused = wanted.find((p) => !entitled.includes(p));
    if (refused) throw new ApiError('forbidden', NO_PLATFORM[refused]);
    const existing = await db.query('SELECT * FROM app_builds WHERE tenant_id = $1 AND request_key = $2 ORDER BY platform', [tid, requestKey]);
    const mine = existing.filter((b) => wanted.includes(b.platform));
    const missing = wanted.filter((p) => !mine.some((b) => b.platform === p));
    if (!missing.length) return mine;
    if (check) {
      const validation = await appConfig().validate({ platforms: missing });
      if (!validation.ok) throw kitRefusal(validation.problems);
    }
    const batch = await brandBatch(tid, requestKey, actor);
    const made = [];
    for (const platform of missing) made.push(await insertBuild({ tid, batch, platform, requestKey, actor }));
    await enqueueRuns(made);
    return [...mine, ...made].sort((a, b) => a.platform.localeCompare(b.platform));
  }

  async function request(input = {}) {
    return (await requestRows(input)).map(buildOut);
  }

  // ---- a native change: every brand ----

  async function batchCounts(ids) {
    if (!ids.length) return new Map();
    const rows = await platformDb().query(
      `SELECT batch_id, count(*)::int AS total, count(*) FILTER (WHERE status = 'built')::int AS built, count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'submitted')::int AS submitted
       FROM app_builds WHERE batch_id = ANY($1::bigint[]) GROUP BY batch_id`,
      [ids.map(Number)],
    );
    return new Map(rows.map((r) => [Number(r.batch_id), { total: Number(r.total), built: Number(r.built), failed: Number(r.failed), submitted: Number(r.submitted) }]));
  }

  function batchOut(b, counts) {
    return {
      id: Number(b.id), reason: b.reason, tenantId: b.tenant_id === null || b.tenant_id === undefined ? null : Number(b.tenant_id), appVersion: b.app_version,
      runtimeVersion: b.runtime_version, note: b.note ?? '', status: b.status, createdAt: iso(b.created_at), finishedAt: iso(b.finished_at),
      counts: counts ?? { total: 0, built: 0, failed: 0, submitted: 0 },
    };
  }

  async function batchSummary(b) {
    return batchOut(b, (await batchCounts([b.id])).get(Number(b.id)));
  }

  /**
   * Every brand of a business that is not closed gets a build of each platform its plan allows, each brand on its own: a brand
   * whose app was built before is always rebuilt (and reported failed at validate when its details broke since), and one that
   * never built is rebuilt only when its details are complete; one still being set up has no app to rebuild yet, and builds on
   * the new runtime anyway once its owner asks.
   */
  async function fanOut(batch, platforms, actor) {
    const p = platformDb();
    const brands = await p.query(`SELECT c.tenant_id FROM app_configs c JOIN tenants t ON t.id = c.tenant_id WHERE t.status NOT IN ('closed', 'killed') ORDER BY c.tenant_id`);
    const requestKey = `batch-${String(batch.id).padStart(6, '0')}`;
    const made = [];
    for (const { tenant_id: id } of brands) {
      const tid = Number(id);
      try {
        await withTenant(tid, async () => {
          const entitled = await appConfig().entitledPlatforms();
          for (const platform of platforms.filter((x) => entitled.includes(x))) {
            const [shipped] = await db.query(`SELECT 1 AS one FROM app_builds WHERE tenant_id = $1 AND platform = $2 AND status IN ('built', 'submitted') LIMIT 1`, [tid, platform]);
            if (!shipped && (await appConfig().check([platform])).length) {
              log.info('app_builds.batch_skipped', { batchId: Number(batch.id), tenantId: tid, platform, why: 'not_set_up' });
              continue;
            }
            made.push(await insertBuild({ tid, batch, platform, requestKey, actor, busyFails: true }));
          }
        });
      } catch (err) {
        reportError(err, { msg: 'app_builds.batch_brand_failed', batchId: Number(batch.id), tenantId: tid });
      }
    }
    if (!made.length) await p.query(`UPDATE app_build_batches SET status = 'finished', finished_at = now() WHERE id = $1 AND status = 'open'`, [Number(batch.id)]);
    // Only now are the builds started: until every brand has its row, none can finish and close the batch early.
    await enqueueRuns(made);
    if (made.length) await schedulePoll();
    return made;
  }

  async function createBatch({ note = '', appVersion, runtimeVersion, fingerprint, platforms = ['android', 'ios'], requestKey, actor = 'system' } = {}) {
    const p = platformDb();
    const wanted = [...new Set(platforms)].filter((x) => APP_PLATFORMS.includes(x));
    if (!wanted.length) throw new ApiError('validation_failed', 'Choose android, ios or both.');
    if (!APP_VERSION.test(String(appVersion))) throw new ApiError('validation_failed', 'Use a version like 1.2.0');
    if (!REQUEST_KEY.test(String(requestKey ?? ''))) throw new ApiError('validation_failed', 'Use 8 to 80 letters, digits, - or _');
    const [existing] = await p.query('SELECT * FROM app_build_batches WHERE request_key = $1', [requestKey]);
    if (existing) {
      if (existing.reason !== 'native_change') throw new ApiError('conflict', 'That request key was used for something else.');
      return batchSummary(existing);
    }
    const [newest] = await p.query('SELECT * FROM app_runtimes ORDER BY created_at DESC, runtime_version DESC LIMIT 1');
    if (newest && isBelowMinimum(appVersion, newest.app_version)) throw new ApiError('conflict', `The app version can’t go back: every brand is on ${newest.app_version}.`);
    const [same] = await p.query('SELECT * FROM app_runtimes WHERE runtime_version = $1', [runtimeVersion]);
    if (same && (same.fingerprint !== fingerprint || same.app_version !== appVersion)) {
      throw new ApiError('conflict', 'That runtime version already belongs to other native code. Use a new runtime version.');
    }
    if (!same) await p.query('INSERT INTO app_runtimes (runtime_version, fingerprint, app_version) VALUES ($1, $2, $3) ON CONFLICT (runtime_version) DO NOTHING', [runtimeVersion, fingerprint, appVersion]);
    const [batch] = await p.query(
      `INSERT INTO app_build_batches (reason, tenant_id, app_version, runtime_version, note, requested_by, request_key) VALUES ('native_change', NULL, $1, $2, $3, $4, $5)
       ON CONFLICT (request_key) DO NOTHING RETURNING *`,
      [appVersion, runtimeVersion, clip(note, 500), clip(actor, 80), requestKey],
    );
    if (!batch) {
      const [twin] = await p.query('SELECT * FROM app_build_batches WHERE request_key = $1', [requestKey]);
      return batchSummary(twin);
    }
    log.info('app_builds.batch_created', { batchId: Number(batch.id), platforms: wanted.join(',') });
    await fanOut(batch, wanted, actor);
    const [now] = await p.query('SELECT * FROM app_build_batches WHERE id = $1', [Number(batch.id)]);
    return batchSummary(now);
  }

  async function batches({ cursor, limit = 25 } = {}) {
    const after = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] > 0)[0] : null;
    const rows = await platformDb().query('SELECT * FROM app_build_batches WHERE ($1::bigint IS NULL OR id < $1) ORDER BY id DESC LIMIT $2', [after, limit + 1]);
    const page = pageOfFetched(rows, limit, (row) => [Number(row.id)]);
    const counts = await batchCounts(page.items.map((b) => b.id));
    return { items: page.items.map((b) => batchOut(b, counts.get(Number(b.id)))), nextCursor: page.nextCursor };
  }

  /** One batch with every build in it and the brand it is for: the report per brand (P-35). */
  async function batch(id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return null;
    const p = platformDb();
    const [b] = await p.query('SELECT * FROM app_build_batches WHERE id = $1', [Number(id)]);
    if (!b) return null;
    const rows = await p.query(
      'SELECT x.*, t.name AS tenant_name FROM app_builds x JOIN tenants t ON t.id = x.tenant_id WHERE x.batch_id = $1 ORDER BY x.tenant_id, x.platform, x.id',
      [Number(id)],
    );
    return { ...(await batchSummary(b)), builds: rows.map((r) => ({ ...buildOut(r), tenantId: Number(r.tenant_id), tenantName: String(r.tenant_name ?? '') })) };
  }

  // ---- running a build ----

  /** The queue's handler for one build, as its business. A repeated job, or a build that has moved on, does nothing. */
  async function run(id) {
    const build = await rowOf(id);
    if (!build || build.status !== 'queued') return { skipped: true };
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-build-'));
    const store = [];
    try {
      const { buildBrand } = await import('../../../tools/build-brand/index.mjs');
      const report = await buildBrand(`t${Number(build.tenant_id)}`, toolOptions(ctx, build, { outDir, store, seams }));
      return await settle(build, report, store);
    } catch (err) {
      reportError(err, { msg: 'app_builds.run_failed', buildId: Number(build.id) });
      await fail(build.id, { step: 'build', message: 'The build stopped on our side. Ask for it again.' });
      return { status: 'failed' };
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }

  async function settle(build, report, store) {
    const id = Number(build.id);
    const result = report.builds?.find((b) => b.platform === build.platform) ?? null;
    const configHash = report.brandFile && fs.existsSync(report.brandFile) ? sha256(fs.readFileSync(report.brandFile)) : '';
    if (!result || (!report.ok && report.step && report.step !== 'build' && report.step !== 'submit')) {
      log.info('app_builds.stopped', { buildId: id, step: report.step ?? 'build', code: report.code ?? 'failed' });
      await fail(id, { step: report.step, field: report.field ?? '', message: report.message });
      return { status: 'failed', step: report.step };
    }
    if (result.status === 'failed') {
      log.info('app_builds.stopped', { buildId: id, step: 'build', code: 'build_failed' });
      await fail(id, { step: 'build', message: result.detail });
      return { status: 'failed', step: 'build' };
    }
    if (result.status === 'building') {
      await db.tx((t) => markStatus(t, id, 'building', { set: { providerBuildId: result.providerBuildId ?? '', configHash }, ifAllowed: true }));
      await keepStoreImages(build, store);
      await schedulePoll();
      log.info('app_builds.started', { buildId: id, tenantId: Number(build.tenant_id), platform: build.platform });
      return { status: 'building' };
    }
    if (result.status === 'built') {
      const artifactKey = await keepFile(build, result.artifact).catch(() => '');
      await db.tx(async (t) => {
        await markStatus(t, id, 'building', { set: { configHash }, ifAllowed: true });
        await markStatus(t, id, 'built', { set: { artifactKey }, ifAllowed: true });
      });
      await keepStoreImages(build, store);
      await submitBuilt(id);
      return { status: 'built' };
    }
    await fail(id, { step: 'build', message: 'The build gave no result.' });
    return { status: 'failed' };
  }

  /** A local build's file, kept in private storage (never /media). An iOS simulator build is a folder and is not kept. */
  async function keepFile(build, file) {
    const store = storage();
    if (!store || !file || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > MAX_ARTIFACT) return '';
    const key = `t/${Number(build.tenant_id)}/app-builds/${Number(build.id)}/${build.platform}.${build.platform === 'ios' ? 'app' : 'apk'}`;
    await store.put(key, fs.readFileSync(file), 'application/octet-stream');
    return key;
  }

  /** A build service artifact, kept in private storage. Best effort: a build is built whether or not this works. */
  async function keepArtifact(build) {
    const store = storage();
    if (!store || typeof ctx.eas?.fetchArtifact !== 'function') return '';
    const { stream } = await ctx.eas.fetchArtifact(build.provider_build_id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const key = `t/${Number(build.tenant_id)}/app-builds/${Number(build.id)}/${build.platform}.${build.platform === 'ios' ? 'ipa' : 'aab'}`;
    await store.put(key, Buffer.concat(chunks), 'application/octet-stream');
    return key;
  }

  /** The store images made for this build, handed to the store listing (store-listings' putAsset), when that module takes them. */
  async function keepStoreImages(build, images) {
    const mine = images.filter((image) => image.platform === build.platform);
    if (!mine.length) return;
    let listings;
    try {
      const mod = await import('../store-listings/index.js');
      if (typeof mod.storeListingsFor !== 'function') return;
      listings = mod.storeListingsFor(ctx);
    } catch {
      return;
    }
    if (typeof listings?.putAsset !== 'function') return;
    const { measureImage } = await import('./images.js');
    for (const image of mine) {
      try {
        const m = await measureImage(image.buffer);
        await listings.putAsset(build.platform, image.kind, image.buffer, { width: m.width, height: m.height, mime: m.mime, bytes: m.bytes, hasAlpha: m.hasAlpha, source: 'generated', buildId: Number(build.id), device: '', position: 0 });
      } catch (err) {
        log.warn('app_builds.listing_image_failed', { buildId: Number(build.id), kind: image.kind, error: err?.name ?? 'Error' });
      }
    }
  }

  // ---- following the build service, and sending to the stores ----

  /** One building eas build: built, failed, or still going. A build service that times out or answers junk moves nothing. */
  async function check(id) {
    const build = await rowOf(id);
    if (!build || build.status !== 'building' || build.driver !== 'eas' || !build.provider_build_id) return build ? buildOut(build) : null;
    let remote;
    try {
      remote = await ctx.eas.getBuild(build.provider_build_id);
    } catch (err) {
      // The service no longer knows a build it started: nothing will ever move it, so it is failed and can be asked for again.
      if (err?.name === 'ProviderError' && err.kind === 'rejected' && err.status === 404) {
        await fail(build.id, { step: 'build', message: 'The build service no longer has this build. Ask for it again.' });
        return get(build.id);
      }
      log.warn('app_builds.poll_failed', { buildId: Number(build.id), kind: err?.kind ?? 'error' });
      return buildOut(build);
    }
    if (remote.status === 'built') {
      let artifactKey = '';
      try {
        artifactKey = await keepArtifact(build);
      } catch (err) {
        log.warn('app_builds.artifact_failed', { buildId: Number(build.id), kind: err?.kind ?? 'error' });
      }
      await db.tx((t) => markStatus(t, build.id, 'built', { set: { fingerprint: remote.fingerprint ?? '', artifactKey }, ifAllowed: true }));
      await submitBuilt(build.id);
    } else if (remote.status === 'failed') {
      await fail(build.id, { step: 'build', message: clip(remote.error?.message) || 'The build failed on the build service.' });
    }
    return get(build.id);
  }

  async function submitter() {
    if (typeof seams.submit === 'function') return seams.submit;
    try {
      const mod = await import('../app-submissions/index.js');
      if (typeof mod.appSubmissionsFor === 'function') return (buildId, options) => mod.appSubmissionsFor(ctx).submit(buildId, options);
    } catch {
      // Not there yet: the build stays built and says why.
    }
    return null;
  }

  const setSubmitError = (id, message) => db.query('UPDATE app_builds SET submit_error = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(id), clip(message, 500) || 'Sending to the store failed.']);

  /**
   * A built store build goes to the brand's own store account through app-submissions (its pre-submit gate, then ctx.eas.submit
   * with the brand's own credentials). A failed submit leaves the build built, with the reason in submit_error.
   */
  async function submitBuilt(id) {
    if (seams.autoSubmit === false) return null;
    const build = await rowOf(id);
    if (!build || build.status !== 'built' || build.profile !== 'production' || build.driver !== 'eas') return null;
    const send = await submitter();
    if (!send) {
      await setSubmitError(id, 'Sending to the store is not available yet.');
      return null;
    }
    try {
      await send(Number(id), { actor: 'system' });
      return await db.tx((t) => markStatus(t, id, 'submitted', { set: { submitError: '' }, ifAllowed: true }));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err?.name === 'ProviderError' ? 'The store did not answer. Ask for the build again.' : 'Sending to the store failed.';
      log.warn('app_builds.submit_failed', { buildId: Number(id), error: err?.name ?? 'Error' });
      await setSubmitError(id, message);
      return null;
    }
  }

  /**
   * The schedule's job (no business): follows every building eas build, fails builds that never started, sends built builds a
   * crash left unsent, closes finished batches, and comes back while anything is still running.
   */
  async function poll() {
    const p = platformDb();
    const building = await p.query(`SELECT id, tenant_id FROM app_builds WHERE status = 'building' AND driver = 'eas' AND provider_build_id <> '' ORDER BY id LIMIT 200`);
    for (const b of building) {
      await withTenant(Number(b.tenant_id), () => check(b.id)).catch((err) => reportError(err, { msg: 'app_builds.check_failed', buildId: Number(b.id) }));
    }
    const stuck = await p.query(`SELECT id, tenant_id FROM app_builds WHERE status = 'queued' AND created_at < now() - interval '30 minutes' ORDER BY id LIMIT 100`);
    for (const b of stuck) await withTenant(Number(b.tenant_id), () => fail(b.id, { step: 'load', message: STUCK })).catch((err) => reportError(err, { msg: 'app_builds.stuck_failed', buildId: Number(b.id) }));
    const unsent = await p.query(
      `SELECT id, tenant_id FROM app_builds WHERE status = 'built' AND driver = 'eas' AND profile = 'production' AND submit_error = ''
         AND finished_at < now() - interval '2 minutes' ORDER BY id LIMIT 50`,
    );
    for (const b of unsent) await withTenant(Number(b.tenant_id), () => submitBuilt(b.id)).catch((err) => reportError(err, { msg: 'app_builds.resubmit_failed', buildId: Number(b.id) }));
    await p.query(
      `UPDATE app_build_batches b SET status = 'finished', finished_at = now()
       WHERE b.status = 'open' AND EXISTS (SELECT 1 FROM app_builds x WHERE x.batch_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM app_builds x WHERE x.batch_id = b.id AND x.status IN ('queued', 'building'))`,
    );
    const [{ n }] = await p.query(`SELECT count(*)::int AS n FROM app_builds WHERE status IN ('queued', 'building')`);
    if (Number(n) > 0) await schedulePoll();
  }

  async function work(payload = {}) {
    if (payload.buildId !== undefined) return run(Number(payload.buildId));
    return null;
  }

  /** Waits for this business's builds to settle, following them itself (the command line has no worker). */
  async function follow(ids, { timeoutMs = 3_600_000, everyMs = pollMs() } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const now = [];
      for (const id of ids) now.push(await check(id));
      if (now.every((b) => b && !RUNNING.includes(b.status)) || Date.now() > end) return now.filter(Boolean);
      await sleep(everyMs);
    }
  }

  return { request, requestRows, list, get, markStatus, createBatch, batch, batches, run, check, poll, work, submitBuilt, follow, currentRuntime };
}

import crypto from 'node:crypto';
import { APP_ENTITLEMENTS, PLAYBOOKS, findAppMove, playbookFor, presubmitChecksFor, presubmitPassed } from '../../contracts/apps.js';
import { ApiError } from '../../contracts/api/errors.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { failureSummary } from '../../../tools/presubmit/checks.mjs';
import * as appBuildsModule from '../app-builds/index.js';
import * as appConfigModule from '../app-config/index.js';
import { writeAudit } from '../audit/index.js';
import { storeAccessFor } from '../store-access/index.js';
import { presubmitBuild } from './presubmit.js';

/**
 * Store review (PRD 10.14). See index.js for the interface. change() is the only code here that writes app_submissions.state;
 * the 603 triggers are the second lock. The poll only ever moves a submission forward on what the store says, and a store answer
 * that arrives late or twice changes nothing:
 *   - a rejection is applied only while the app is in review and only when the store's key for it is new (a rejection read again,
 *     or still shown after our team resubmitted, is the old one);
 *   - in review is taken from the store only from draft; approved only from in review; live only from in review or approved;
 *   - an answer about another app version than the one we sent is ignored;
 *   - the owner is told once per rejection and once per live version (notify keys).
 */
const STATE_WORDS = Object.freeze({ draft: 'a draft', in_review: 'in review', rejected: 'rejected', approved: 'approved', live: 'live' });
const SETTABLE = new Set(['build_id', 'app_version', 'build_number', 'live_version', 'live_build_number', 'store_url', 'provider_ref', 'provider_state', 'provider_checked_at']);
const GUIDELINE = /^[0-9A-Za-z_.:() -]{1,40}$/;
const services = new WeakMap();

/** A store's guideline as we store it: its own text when it fits app_rejections, else 'unknown'. */
export function cleanGuideline(raw) {
  const text = String(raw ?? '').trim().replace(/[^0-9A-Za-z_.:() -]/g, '').slice(0, 40).trim();
  return GUIDELINE.test(text) ? text : 'unknown';
}

const playbookRef = (row) => {
  const book = PLAYBOOKS[row.playbook_code] ?? playbookFor(row.guideline);
  return { code: book.code, title: book.title, doc: book.doc };
};

export function appSubmissionsFor(ctx) {
  let found = services.get(ctx);
  if (!found) services.set(ctx, (found = createAppSubmissions(ctx)));
  return found;
}

function createAppSubmissions(ctx) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;

  async function requireApp(platform = null) {
    const can = (p) => ctx.repos.entitlements.can(APP_ENTITLEMENTS[p]);
    const ok = platform ? await can(platform) : (await can('android')) || (await can('ios'));
    if (!ok) throw new ApiError('forbidden', 'Your plan doesn’t include your own shopper app.', { reason: 'plan' });
  }

  // ---- reading ----

  async function newestRun(runner, tid, buildId, platform) {
    if (!buildId) return null;
    const [run] = await runner.query('SELECT * FROM presubmit_runs WHERE tenant_id = $1 AND build_id = $2 AND platform = $3 ORDER BY id DESC LIMIT 1', [tid, buildId, platform]);
    return run ?? null;
  }

  /** The AppSubmission answer for a row, read with `runner` (the fenced db for a seller, db.platform for our team). */
  async function viewOf(runner, row) {
    const tid = row.tenant_id;
    const rejections = await runner.query('SELECT guideline, message, playbook_code, rejected_at FROM app_rejections WHERE tenant_id = $1 AND submission_id = $2 ORDER BY id DESC LIMIT 5', [tid, row.id]);
    const [task] = await runner.query(`SELECT guideline_key FROM app_review_tasks WHERE tenant_id = $1 AND platform = $2 AND status = 'open' ORDER BY id LIMIT 1`, [tid, row.platform]);
    const run = await newestRun(runner, tid, row.build_id, row.platform);
    return {
      platform: row.platform,
      state: row.state,
      appVersion: row.app_version,
      buildNumber: row.build_number ?? null,
      liveVersion: row.live_version,
      storeUrl: row.store_url,
      submittedAt: row.submitted_at,
      decidedAt: row.decided_at,
      rejections: rejections.map((r) => ({ guideline: r.guideline, message: r.message, rejectedAt: r.rejected_at, playbook: playbookRef(r) })),
      reviewTask: task ? { guideline: task.guideline_key } : null,
      presubmit: run ? { passed: run.passed && presubmitPassed(row.platform, run.checks), ranAt: run.ran_at, checks: (Array.isArray(run.checks) ? run.checks : []).map((c) => ({ code: String(c?.code ?? ''), guideline: String(c?.guideline ?? ''), passed: c?.passed === true, detail: String(c?.detail ?? '') })) } : null,
    };
  }

  const placeholder = (platform) => ({
    platform, state: 'draft', appVersion: '', buildNumber: null, liveVersion: '', storeUrl: '', submittedAt: null, decidedAt: null, rejections: [], reviewTask: null, presubmit: null,
  });

  const rowOf = async (platform, runner = db, lock = false) => (await runner.query(`SELECT * FROM app_submissions WHERE tenant_id = $1 AND platform = $2${lock ? ' FOR UPDATE' : ''}`, [tenantId(), platform]))[0] ?? null;

  async function get(platform) {
    const row = await rowOf(platform);
    return row ? viewOf(db, row) : placeholder(platform);
  }

  /** Each platform the plan has, as the store has it. */
  async function list() {
    await requireApp();
    const out = [];
    for (const platform of ['android', 'ios']) if (await ctx.repos.entitlements.can(APP_ENTITLEMENTS[platform])) out.push(await get(platform));
    return out;
  }

  // ---- moving ----

  /** Why the move's guard does not hold for this row, or null. */
  async function guardProblem(t, row, guard) {
    if (!guard) return null;
    if (!row.build_id) return 'This app has no build to send for review yet.';
    const run = await newestRun(t, row.tenant_id, row.build_id, row.platform);
    if (!run) return 'This build has not been through the pre-submit check, so it cannot go to review.';
    const checks = Array.isArray(run.checks) ? run.checks : [];
    if (!run.passed || !presubmitPassed(row.platform, checks)) {
      const missing = presubmitChecksFor(row.platform).filter((c) => !checks.some((x) => x?.code === c.code)).map((c) => ({ code: c.code, guideline: c.guideline, passed: false, detail: 'not in the run.' }));
      const failed = [...checks.filter((c) => c && c.passed !== true).map((c) => ({ code: String(c.code), guideline: String(c.guideline ?? ''), passed: false, detail: String(c.detail || 'failed.') })), ...missing];
      return `The build failed the pre-submit check, so it cannot go to review. ${failureSummary(failed)}`.slice(0, 1000);
    }
    if (guard === 'presubmit_no_task') {
      const [task] = await t.query(`SELECT guideline_key FROM app_review_tasks WHERE tenant_id = $1 AND platform = $2 AND status = 'open' LIMIT 1`, [row.tenant_id, row.platform]);
      if (task) return `A review task is open for this app (guideline ${task.guideline_key}): our team resolves it before the app goes back to review.`;
    }
    return null;
  }

  /**
   * Moves this business's submission on `platform` to `to`, inside transaction `t`, along APP_TRANSITIONS and its guard.
   * { actor, reason, set: { column: value }, ifAllowed }. With ifAllowed a move that is not allowed (a late or repeated store
   * answer) returns { moved: false } instead of throwing. Returns { row, moved }.
   */
  async function change(t, platform, to, { actor = 'system', reason = '', set = {}, ifAllowed = false } = {}) {
    const row = await rowOf(platform, t, true);
    if (!row) throw new ApiError('not_found', 'This app has no submission yet.');
    const refuse = (message) => {
      if (ifAllowed) return { row, moved: false };
      throw new ApiError('conflict', message);
    };
    if (row.state === to) return refuse(`This app is already ${STATE_WORDS[to] ?? to}.`);
    const move = findAppMove('app_submission', row.state, to);
    if (!move) return refuse(`An app that is ${STATE_WORDS[row.state]} can’t be moved to ${STATE_WORDS[to] ?? to}.`);
    const problem = await guardProblem(t, row, move.guard);
    if (problem) return refuse(problem);
    const columns = ['state = $3', 'changed_by = $4', 'change_reason = $5'];
    const params = [tenantId(), row.id, to, String(actor).slice(0, 80), String(reason ?? '').slice(0, 500)];
    for (const [column, value] of Object.entries(set)) {
      if (!SETTABLE.has(column)) throw new Error(`change() cannot set ${column}`);
      params.push(value);
      columns.push(`${column} = $${params.length}`);
    }
    if (to === 'in_review') columns.push('submitted_at = now()');
    if (to === 'rejected' || to === 'approved') columns.push('decided_at = now()');
    if (to === 'live') columns.push('live_at = now()');
    const [moved] = await t.query(`UPDATE app_submissions SET ${columns.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`, params);
    log.info('app_submissions.moved', { tenantId: tenantId(), platform, from: row.state, to });
    return { row: moved, moved: true };
  }

  /**
   * Stores one rejection with its guideline and playbook, once per store key: { rejection, taskOpened, duplicate }. A second one
   * on the same guideline opens a review task (the database does it, app_rejections_review_task).
   */
  async function recordRejection(t, platform, { guideline, message = '', providerKey, appVersion, buildNumber } = {}) {
    const row = await rowOf(platform, t);
    if (!row) throw new ApiError('not_found', 'This app has no submission yet.');
    const clean = cleanGuideline(guideline);
    const book = playbookFor(clean);
    const key = String(providerKey ?? '').slice(0, 120) || `manual:${crypto.randomUUID()}`;
    const openBefore = await t.query(`SELECT id FROM app_review_tasks WHERE tenant_id = $1 AND platform = $2 AND status = 'open'`, [tenantId(), platform]);
    const [inserted] = await t.query(
      `INSERT INTO app_rejections (tenant_id, submission_id, platform, guideline, message, playbook_code, app_version, build_number, provider_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_id, submission_id, provider_key) DO NOTHING RETURNING *`,
      [tenantId(), row.id, platform, clean, String(message ?? '').slice(0, 4000), book.code, String(appVersion ?? row.app_version ?? ''), Number.isInteger(buildNumber) ? buildNumber : row.build_number, key],
    );
    if (!inserted) {
      const [existing] = await t.query('SELECT * FROM app_rejections WHERE tenant_id = $1 AND submission_id = $2 AND provider_key = $3', [tenantId(), row.id, key]);
      return { rejection: existing, taskOpened: false, duplicate: true };
    }
    const openAfter = await t.query(`SELECT id FROM app_review_tasks WHERE tenant_id = $1 AND platform = $2 AND status = 'open'`, [tenantId(), platform]);
    return { rejection: inserted, taskOpened: openAfter.length > openBefore.length, duplicate: false };
  }

  /** Stores a pre-submit run of a build. passed is worked out here from the checks, never taken from the caller. */
  async function recordPresubmit(buildId, { platform, checks, toolVersion = '' }) {
    const list = (Array.isArray(checks) ? checks : []).map((c) => ({ code: String(c?.code ?? ''), guideline: String(c?.guideline ?? ''), passed: c?.passed === true, detail: String(c?.detail ?? '').slice(0, 500) }));
    const passed = presubmitPassed(platform, list);
    const [run] = await db.query(
      `INSERT INTO presubmit_runs (tenant_id, build_id, platform, passed, checks, tool_version)
       SELECT $1, b.id, $3, $4, $5, $6 FROM app_builds b WHERE b.tenant_id = $1 AND b.id = $2 AND b.platform = $3 RETURNING id`,
      [tenantId(), buildId, platform, passed, JSON.stringify(list), String(toolVersion).slice(0, 60)],
    );
    if (!run) throw new ApiError('not_found', 'There is no such build.');
    return { passed, id: Number(run.id) };
  }

  const notifyOwner = (t, event, key) => ctx.notify?.emit({ event, tenantId: tenantId(), key, data: {} }, t);

  async function setSubmitError(buildId, message) {
    await db.query(`UPDATE app_builds SET submit_error = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId(), buildId, String(message).slice(0, 500)]);
  }

  /** The build's move built -> submitted, through app-builds' markStatus once that track is on this branch. */
  async function markBuildSubmitted(t, build, submissionId) {
    const builds = appBuildsModule.appBuildsFor?.(ctx);
    if (typeof builds?.markStatus === 'function') {
      return builds.markStatus(t, build.id, 'submitted', { set: { provider_submission_id: submissionId, submit_error: '' }, ifAllowed: true });
    }
    return t.query(
      `UPDATE app_builds SET status = 'submitted', provider_submission_id = $3, submit_error = '', submitted_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'built'`,
      [tenantId(), build.id, String(submissionId).slice(0, 80)],
    );
  }

  /**
   * Sends a built build to its store: the pre-submit gate first (always recorded), then ctx.eas.submit with this business's own
   * credentials. A failed gate, no credentials or a refused upload leaves the build 'built' with submit_error saying why.
   * The submission enters review when the build service says the upload finished (poll()).
   */
  async function submit(buildId, { actor = 'system' } = {}) {
    const [build] = await db.query('SELECT * FROM app_builds WHERE tenant_id = $1 AND id = $2', [tenantId(), buildId]);
    if (!build) throw new ApiError('not_found', 'There is no such build.');
    const platform = build.platform;
    if (build.status === 'submitted') return get(platform);
    if (build.status !== 'built') throw new ApiError('conflict', 'Only a finished build can be sent to the store.');
    const report = await presubmitBuild(ctx, build);
    const run = await recordPresubmit(build.id, { platform, checks: report.checks, toolVersion: report.toolVersion });
    await db.tx(async (t) => {
      await t.query('INSERT INTO app_submissions (tenant_id, platform) VALUES ($1, $2) ON CONFLICT (tenant_id, platform) DO NOTHING', [tenantId(), platform]);
      const row = await rowOf(platform, t, true);
      if (row.state === 'in_review') throw new ApiError('conflict', 'This app is in review. Wait for the store’s answer before sending a new build.');
      await t.query(
        `UPDATE app_submissions SET build_id = $3, app_version = $4, build_number = $5, provider_ref = '', provider_state = '', changed_by = $6, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), row.id, build.id, build.app_version, build.build_number, String(actor).slice(0, 80)],
      );
    });
    if (!run.passed) {
      await setSubmitError(build.id, `Pre-submit failed: ${failureSummary(report.checks)}`);
      log.info('app_submissions.presubmit_failed', { tenantId: tenantId(), platform, buildId: Number(build.id) });
      return get(platform);
    }
    const credentials = await storeAccessFor(ctx).credentials(platform);
    if (!credentials) {
      await setSubmitError(build.id, platform === 'ios' ? 'Add your App Store Connect key in Store access, then send the build again.' : 'Our Google Play access is not set up yet. Contact support.');
      return get(platform);
    }
    if (!build.provider_build_id) {
      await setSubmitError(build.id, 'This build was not made on the build service, so it cannot be sent to the store from here.');
      return get(platform);
    }
    const { packageName: _package, ...send } = credentials;
    let submissionId;
    try {
      ({ submissionId } = await ctx.eas.submit({ buildId: build.provider_build_id, platform, track: 'production', credentials: send, idempotencyKey: `submit-${tenantId()}-${build.id}` }));
    } catch (err) {
      await setSubmitError(build.id, 'The build service did not take the upload. Try sending the build again.');
      log.warn('app_submissions.submit_failed', { tenantId: tenantId(), platform, buildId: Number(build.id), kind: err?.kind ?? 'error' });
      return get(platform);
    }
    await db.tx(async (t) => {
      await markBuildSubmitted(t, build, submissionId);
      await t.query(`UPDATE app_submissions SET provider_ref = $3, provider_state = 'uploading', updated_at = now() WHERE tenant_id = $1 AND platform = $2`, [tenantId(), platform, String(submissionId).slice(0, 120)]);
    });
    log.info('app_submissions.submitted', { tenantId: tenantId(), platform, buildId: Number(build.id) });
    return get(platform);
  }

  // ---- the stores ----

  /** What the store says now about this business's app on `platform`, applied. Never throws for the store's sake. */
  async function pollOne(platform) {
    const row = await rowOf(platform);
    if (!row) return;
    if (row.state === 'draft' && row.provider_ref && row.provider_state === 'uploading') {
      let upload;
      try {
        upload = await ctx.eas.getSubmission(row.provider_ref);
      } catch {
        return;
      }
      if (upload.status === 'finished') {
        await db.tx(async (t) => {
          const { moved } = await change(t, platform, 'in_review', { actor: 'provider:eas', reason: 'The upload reached the store', set: { provider_state: 'uploaded' }, ifAllowed: true });
          if (!moved) await t.query(`UPDATE app_submissions SET provider_state = 'uploaded' WHERE tenant_id = $1 AND id = $2`, [tenantId(), row.id]);
        });
      } else if (upload.status === 'errored') {
        await db.query(`UPDATE app_submissions SET provider_state = 'upload_failed' WHERE tenant_id = $1 AND id = $2`, [tenantId(), row.id]);
        if (row.build_id) await setSubmitError(row.build_id, `The store did not take the upload: ${String(upload.error ?? 'no reason given').slice(0, 300)}`);
      }
      return;
    }
    if (!['draft', 'in_review', 'approved'].includes(row.state)) return;
    const reader = await storeAccessFor(ctx).reviewReader(platform).catch(() => null);
    if (!reader) return;
    let event;
    try {
      event = await reader();
    } catch {
      return; // the store timed out or answered junk: nothing new
    }
    await applyStoreEvent(platform, event);
  }

  /** One store answer, applied to this business's submission on `platform` if it moves it forward. */
  async function applyStoreEvent(platform, event) {
    if (!event || typeof event !== 'object') return;
    const source = event.source === 'play' ? 'provider:play' : 'provider:appstore';
    let liveUrl = null;
    await db.tx(async (t) => {
      const row = await rowOf(platform, t, true);
      if (!row) return;
      await t.query('UPDATE app_submissions SET provider_state = $3, provider_checked_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), row.id, String(event.state ?? '').slice(0, 60)]);
      if (row.app_version && event.version && String(event.version) !== row.app_version) return; // about another version
      const go = (to, extra = {}) => change(t, platform, to, { actor: source, reason: `The store says ${STATE_WORDS[to]}`, ifAllowed: true, ...extra });
      if (event.state === 'in_review' && row.state === 'draft') await go('in_review');
      else if (event.state === 'rejected' && row.state === 'in_review' && event.rejection) {
        const { rejection, duplicate } = await recordRejection(t, platform, { guideline: event.rejection.guideline, message: event.rejection.message, providerKey: event.rejection.key, appVersion: event.version, buildNumber: event.buildNumber });
        if (duplicate) return; // read before, or still shown after our team resubmitted
        const { moved } = await go('rejected', { reason: `Rejected under ${rejection.guideline}` });
        if (moved) await notifyOwner(t, 'app.rejected', `app.rejected:${rejection.id}`);
      } else if (event.state === 'approved' && row.state === 'in_review') await go('approved');
      else if (event.state === 'live' && (row.state === 'in_review' || row.state === 'approved')) {
        if (row.state === 'in_review' && !(await go('approved')).moved) return;
        const storeUrl = /^https:\/\/\S+$/.test(String(event.storeUrl ?? '')) ? String(event.storeUrl).slice(0, 500) : row.store_url;
        const version = String(event.version || row.app_version);
        const { moved } = await go('live', { set: { live_version: version, live_build_number: Number.isInteger(event.buildNumber) ? event.buildNumber : row.build_number, store_url: storeUrl } });
        if (moved) {
          await notifyOwner(t, 'app.live', `app.live:${row.id}:${version}`);
          liveUrl = storeUrl;
        }
      }
    });
    // Outside the transaction: the app settings write uses its own connection and must not wait on this one.
    if (liveUrl) await setStoreUrl(platform, liveUrl);
  }

  async function setStoreUrl(platform, url) {
    const config = appConfigModule.appConfigFor?.(ctx);
    if (!url || typeof config?.setStoreUrl !== 'function') return;
    await config.setStoreUrl(platform, url).catch((err) => reportError(err, { msg: 'app_submissions.store_url_failed' }));
  }

  /** Every business's apps waiting on a store, read once each. Platform-wide; each business inside its own withTenant. */
  async function poll({ limit = 200 } = {}) {
    const rows = await platformDb.query(
      `SELECT tenant_id, platform FROM app_submissions
       WHERE state IN ('in_review', 'approved') OR (state = 'draft' AND (provider_state = 'uploading' OR provider_ref <> ''))
       ORDER BY provider_checked_at NULLS FIRST, id LIMIT $1`,
      [limit],
    );
    for (const { tenant_id: tid, platform } of rows) {
      await withTenant(tid, () => pollOne(platform)).catch((err) => reportError(err, { msg: 'app_submissions.poll_failed', tenantId: tid }));
    }
    return { read: rows.length };
  }

  // ---- our team's console ----

  const tenantNameOf = async (tid) => (await platformDb.query('SELECT name FROM tenants WHERE id = $1', [tid]))[0]?.name ?? '';
  const platformView = async (row) => ({ ...(await viewOf(platformDb, row)), id: Number(row.id), tenantId: row.tenant_id, tenantName: row.tenant_name ?? (await tenantNameOf(row.tenant_id)) });

  async function consoleList({ state, platform, cursor, limit = 25 } = {}) {
    const rows = await platformDb.query(
      `SELECT s.*, t.name AS tenant_name FROM app_submissions s JOIN tenants t ON t.id = s.tenant_id
       WHERE ($1::text IS NULL OR s.state = $1) AND ($2::text IS NULL OR s.platform = $2) AND ($3::bigint IS NULL OR s.id < $3::bigint)
       ORDER BY s.id DESC LIMIT $4`,
      [state ?? null, platform ?? null, /^[1-9][0-9]{0,17}$/.test(String(cursor ?? '')) ? cursor : null, limit + 1],
    );
    const items = [];
    for (const row of rows.slice(0, limit)) items.push(await platformView(row));
    return { items, nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null };
  }

  /** Our team moves a submission (a store answer read by hand, a resubmit). Rejected needs the guideline; live the store link. */
  async function consoleMove(id, { to, reason, storeUrl, rejection }, actor) {
    const [found] = await platformDb.query('SELECT tenant_id, platform FROM app_submissions WHERE id = $1', [id]);
    if (!found) throw new ApiError('not_found', 'There is no such submission.');
    return withTenant(found.tenant_id, async () => {
      const platform = found.platform;
      await db.tx(async (t) => {
        const row = await rowOf(platform, t, true);
        if (row.state !== to && !findAppMove('app_submission', row.state, to)) throw new ApiError('conflict', `An app that is ${STATE_WORDS[row.state]} can’t be moved to ${STATE_WORDS[to] ?? to}.`);
        let rejected = null;
        if (to === 'rejected') rejected = (await recordRejection(t, platform, { guideline: rejection.guideline, message: rejection.message, providerKey: `manual:${crypto.randomUUID()}` })).rejection;
        const set = to === 'live' ? { live_version: row.app_version, live_build_number: row.build_number, store_url: storeUrl } : {};
        await change(t, platform, to, { actor, reason, set });
        if (to === 'rejected') await notifyOwner(t, 'app.rejected', `app.rejected:${rejected.id}`);
        if (to === 'live') await notifyOwner(t, 'app.live', `app.live:${row.id}:${row.app_version}`);
        await writeAudit(t, { actor, action: 'app_submission.moved', target: `app_submission:${row.id}`, details: { platform, from: row.state, to } });
      });
      if (to === 'live') await setStoreUrl(platform, storeUrl);
      return platformView(await rowOf(platform));
    });
  }

  async function consoleRejections({ tenantId: tid, guideline, cursor, limit = 25 } = {}) {
    const rows = await platformDb.query(
      `SELECT r.*, t.name AS tenant_name FROM app_rejections r JOIN tenants t ON t.id = r.tenant_id
       WHERE ($1::int IS NULL OR r.tenant_id = $1) AND ($2::text IS NULL OR r.guideline = $2 OR r.guideline_key = $2) AND ($3::bigint IS NULL OR r.id < $3::bigint)
       ORDER BY r.id DESC LIMIT $4`,
      [tid ?? null, guideline ?? null, /^[1-9][0-9]{0,17}$/.test(String(cursor ?? '')) ? cursor : null, limit + 1],
    );
    const items = rows.slice(0, limit).map((r) => {
      const book = PLAYBOOKS[r.playbook_code] ?? playbookFor(r.guideline);
      return { id: Number(r.id), tenantId: r.tenant_id, tenantName: r.tenant_name, platform: r.platform, guideline: r.guideline, message: r.message, playbook: { ...book }, rejectedAt: r.rejected_at };
    });
    return { items, nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
  }

  const taskView = (r) => ({
    id: Number(r.id), tenantId: r.tenant_id, tenantName: r.tenant_name ?? '', platform: r.platform, guideline: r.guideline_key, status: r.status,
    openedAt: r.opened_at, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by, resolution: r.resolution,
  });

  async function consoleTasks({ status, cursor, limit = 25 } = {}) {
    const rows = await platformDb.query(
      `SELECT k.*, t.name AS tenant_name FROM app_review_tasks k JOIN tenants t ON t.id = k.tenant_id
       WHERE ($1::text IS NULL OR k.status = $1) AND ($2::bigint IS NULL OR k.id < $2::bigint) ORDER BY k.id DESC LIMIT $3`,
      [status ?? null, /^[1-9][0-9]{0,17}$/.test(String(cursor ?? '')) ? cursor : null, limit + 1],
    );
    const items = rows.slice(0, limit).map(taskView);
    return { items, nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
  }

  /** Only our team closes a review task: through db.platform, as the business's own login cannot update the table. */
  async function resolveTask(id, resolution, actor) {
    const [row] = await platformDb.query(
      `UPDATE app_review_tasks SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution = $3 WHERE id = $1 AND status = 'open' RETURNING *`,
      [id, String(actor).slice(0, 80), String(resolution).slice(0, 1000)],
    );
    if (!row) {
      const [exists] = await platformDb.query('SELECT status FROM app_review_tasks WHERE id = $1', [id]);
      if (!exists) throw new ApiError('not_found', 'There is no such review task.');
      throw new ApiError('conflict', 'This review task is already resolved.');
    }
    await platformDb.query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)', [row.tenant_id, actor, 'app_review_task.resolved', `app_review_task:${row.id}`, JSON.stringify({ platform: row.platform, guideline: row.guideline_key })]);
    return taskView({ ...row, tenant_name: await tenantNameOf(row.tenant_id) });
  }

  return {
    list, get, change, recordRejection, recordPresubmit, submit, poll, applyStoreEvent, requireApp,
    console: { list: consoleList, move: consoleMove, rejections: consoleRejections, tasks: consoleTasks, resolveTask },
  };
}

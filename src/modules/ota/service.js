import crypto from 'node:crypto';
import { APP_ENTITLEMENTS, APP_LIMITS, nextRollout } from '../../contracts/apps.js';
import { ApiError } from '../../contracts/api/errors.js';
import { OtaPublish } from '../../contracts/api/platform.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';

/**
 * Over-the-air updates (PRD 10.10). See index.js for the interface. Everything here is the platform's (607 has no tenant_id), so
 * it runs on db.platform; a business is reached only as its channel 't<tenantId>'.
 *
 * Publishing: a bundle built against a native fingerprint that is not its runtime's (app_runtimes) changed native code (a native
 * module, a permission, an SDK): it is recorded as blocked, ops are told a store build is needed, and nothing is published. Else
 * the release starts at 10% and a job puts the one bundle on every brand's channel; a release that does not reach every channel
 * never goes live, and one stalled for PUBLISH_STALL_MS is failed and taken back off the channels it reached. A newer release on
 * a runtime supersedes the live one (or fails one still publishing); none starts while a roll back runs.
 *
 * 607 has no row per channel, so each channel's update id is kept as a platform audit row ('ota.channel_published', target
 * 'ota_release:<id>', details { tenantId, channel, updateId }): advance and roll back read them, and so does the health count.
 *
 * Health: an app reports launch or crash for the update it runs. A report counts once per hour per release, event and device
 * (APP_LIMITS.healthPerDevice, the device id hashed), so a device sending a flood counts once and can neither cause nor hide a
 * roll back. Nothing about the device or the shopper is stored: ota_health holds counts per release and hour.
 *
 * The verdict (watch()): over config.otaWindowMinutes, with at least config.otaMinLaunches launches, the release is rolled back
 * when its crash rate is at least the threshold, max(config.otaCrashMultiplier x baseline, config.otaCrashFloor), with 95%
 * confidence: the lower Wilson bound of crashes / launches is compared, so a single crash among the minimum launches is not a
 * verdict. The baseline is the earlier release's rate on the same runtime, else config.otaBaselineCrashRate.
 */
export const PUBLISH_STALL_MS = 15 * 60_000;
const CHANNEL_ROW = 'ota.channel_published';
const Z = 1.96;
const services = new WeakMap();

/** The lower bound of the 95% Wilson interval of k events in n tries: what the rate is at least, given the evidence. */
export function wilsonLower(k, n) {
  if (!(n > 0)) return 0;
  const p = Math.min(1, k / n);
  const z2 = Z * Z;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/** The threshold a release's crash rate is held to. */
export const thresholdOf = (config, baseline) => Math.max(Number(config.otaCrashMultiplier ?? 2) * Number(baseline ?? config.otaBaselineCrashRate ?? 0.005), Number(config.otaCrashFloor ?? 0.01));

const toRelease = (r) => ({
  id: Number(r.id), runtimeVersion: r.runtime_version, bundleFingerprint: r.bundle_fingerprint, bundleId: r.bundle_id, message: r.message, rollout: Number(r.rollout),
  status: r.status, blockReason: r.block_reason, rollbackReason: r.rollback_reason, channelsTotal: Number(r.channels_total), channelsDone: Number(r.channels_done),
  publishedBy: r.published_by, createdAt: r.created_at, advancedAt: r.advanced_at, rolledBackAt: r.rolled_back_at,
});

export function otaFor(ctx) {
  let found = services.get(ctx);
  if (!found) services.set(ctx, (found = createOta(ctx)));
  return found;
}

function createOta(ctx) {
  const db = ctx.db.platform ?? ctx.db;
  const { config } = ctx;
  const channelCache = new Map(); // release id -> { at, rows }

  const releaseRow = async (id, runner = db) => (await runner.query('SELECT * FROM ota_releases WHERE id = $1', [id]))[0] ?? null;

  async function opsAlert({ kind, message, target, dedupeKey, severity = 'critical' }) {
    await db.query(
      `INSERT INTO alerts (tenant_id, audience, kind, severity, message, target, dedupe_key)
       SELECT NULL, 'ops', $1, $2, $3, $4, $5::text
       WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE tenant_id IS NULL AND audience = 'ops' AND dedupe_key = $5::text) ON CONFLICT DO NOTHING`,
      [kind, severity, message, target, dedupeKey],
    );
  }
  const audit = (actor, action, target, details) => db.query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (NULL, $1, $2, $3, $4)', [String(actor).slice(0, 80), action, target, JSON.stringify(details)]);

  /** Every brand that has an app: its app details and the plan for at least one platform. */
  async function brandChannels() {
    const rows = await db.query('SELECT tenant_id FROM app_configs ORDER BY tenant_id');
    const out = [];
    for (const { tenant_id: tid } of rows) {
      const has = await withTenant(tid, async () => (await ctx.repos.entitlements.can(APP_ENTITLEMENTS.android)) || (await ctx.repos.entitlements.can(APP_ENTITLEMENTS.ios))).catch(() => false);
      if (has) out.push({ tenantId: tid, channel: `t${tid}` });
    }
    return out;
  }

  /** The channel updates of a release: [{ tenantId, channel, updateId }]. */
  async function channelsOf(id, { fresh = false } = {}) {
    const cached = channelCache.get(String(id));
    if (!fresh && cached && Date.now() - cached.at < 30_000) return cached.rows;
    const rows = (await db.query(`SELECT details FROM audit_log WHERE tenant_id IS NULL AND action = $1 AND target = $2 ORDER BY id`, [CHANNEL_ROW, `ota_release:${id}`]))
      .map((r) => r.details).filter((d) => d && typeof d.channel === 'string' && typeof d.updateId === 'string');
    channelCache.set(String(id), { at: Date.now(), rows });
    if (channelCache.size > 500) channelCache.delete(channelCache.keys().next().value);
    return rows;
  }

  // ---- health ----

  async function windowTotals(id) {
    const minutes = Math.max(1, Number(config.otaWindowMinutes ?? 60));
    const [row] = await db.query(
      `SELECT COALESCE(sum(launches), 0)::int AS launches, COALESCE(sum(crashes), 0)::int AS crashes FROM ota_health
       WHERE release_id = $1 AND hour >= date_trunc('hour', now() - make_interval(mins => $2::int))`,
      [id, minutes],
    );
    return { launches: Number(row.launches), crashes: Number(row.crashes) };
  }
  const rateOf = ({ launches, crashes }) => (launches > 0 ? Math.min(1, crashes / Math.max(launches, crashes)) : null);

  async function health(id) {
    const release = await releaseRow(id);
    if (!release) return null;
    const hours = await db.query('SELECT hour, launches, crashes FROM ota_health WHERE release_id = $1 ORDER BY hour DESC LIMIT 72', [id]);
    const totals = await windowTotals(id);
    const baseline = release.baseline_crash_rate === null ? null : Number(release.baseline_crash_rate);
    return {
      hours: hours.map((h) => ({ hour: h.hour, launches: Number(h.launches), crashes: Number(h.crashes) })),
      ...totals,
      crashRate: rateOf(totals),
      baseline,
      threshold: thresholdOf(config, baseline),
    };
  }

  /** One report from an app: counted for the release it runs, once per hour per event and device. Unknown updates are ignored. */
  async function report({ updateId, runtimeVersion, event, deviceId }) {
    if (!updateId || !['launch', 'crash'].includes(event) || !deviceId) return { counted: false };
    const candidates = await db.query(`SELECT id, bundle_id FROM ota_releases WHERE runtime_version = $1 AND status IN ('live', 'rolling_back') ORDER BY id DESC LIMIT 3`, [String(runtimeVersion)]);
    let release = null;
    for (const c of candidates) {
      if (c.bundle_id === updateId || (await channelsOf(c.id)).some((row) => row.updateId === updateId)) {
        release = c;
        break;
      }
    }
    if (!release) return { counted: false };
    const device = crypto.createHash('sha256').update(String(deviceId)).digest('base64url').slice(0, 24);
    const { scope, limit, windowMs } = APP_LIMITS.healthPerDevice;
    const hit = await ctx.platform.rateLimit.hit(scope, `${release.id}:${event}:${device}`, { limit, windowMs });
    if (!hit.allowed) return { counted: false };
    await db.query(
      `INSERT INTO ota_health (release_id, hour, launches, crashes) VALUES ($1, date_trunc('hour', now()), $2, $3)
       ON CONFLICT (release_id, hour) DO UPDATE SET launches = ota_health.launches + EXCLUDED.launches, crashes = ota_health.crashes + EXCLUDED.crashes`,
      [release.id, event === 'launch' ? 1 : 0, event === 'crash' ? 1 : 0],
    );
    return { counted: true };
  }

  // ---- publishing ----

  async function baselineFor(runtimeVersion) {
    const [previous] = await db.query(`SELECT id FROM ota_releases WHERE runtime_version = $1 AND status IN ('live', 'superseded') ORDER BY id DESC LIMIT 1`, [runtimeVersion]);
    if (previous) {
      const totals = await db.query('SELECT COALESCE(sum(launches), 0)::int AS launches, COALESCE(sum(crashes), 0)::int AS crashes FROM ota_health WHERE release_id = $1', [previous.id]);
      const t = { launches: Number(totals[0].launches), crashes: Number(totals[0].crashes) };
      if (t.launches >= Number(config.otaMinLaunches ?? 50)) return Math.round(rateOf(t) * 100_000) / 100_000;
    }
    return Math.min(1, Math.max(0, Number(config.otaBaselineCrashRate ?? 0.005)));
  }

  const sameBundle = (row, body) => row.runtime_version === body.runtimeVersion && row.bundle_fingerprint === body.bundleFingerprint && row.bundle_id === body.bundleId && row.bundle_hash === body.bundleHash && row.message === body.message;
  const NATIVE = 'This update changes native code. Start a store build instead.';

  /**
   * Records the release and starts publishing it: { release, created }. A blocked release is recorded and then refused (409).
   * A request key already used answers what it made the first time, whatever bundle is sent with it again: a changed bundle under
   * a used key is never published (and the answer shows the first one's bundle id).
   */
  async function publish(input, actor) {
    const parsed = OtaPublish.strict().safeParse(input ?? {});
    if (!parsed.success) throw new ApiError('validation_failed', parsed.error.issues[0]?.message ?? 'Check the details and try again.');
    const body = parsed.data;
    const [existing] = await db.query('SELECT * FROM ota_releases WHERE request_key = $1', [body.requestKey]);
    if (existing) {
      if (!sameBundle(existing, body)) log.warn('ota.request_key_reused', { releaseId: Number(existing.id) });
      if (existing.status === 'blocked') throw new ApiError('conflict', NATIVE);
      return { release: toRelease(existing), created: false };
    }
    const [runtime] = await db.query('SELECT * FROM app_runtimes WHERE runtime_version = $1', [body.runtimeVersion]);
    if (!runtime) throw new ApiError('not_found', `No store build has runtime ${body.runtimeVersion}. Start a store build first.`);
    const [twin] = await db.query('SELECT id FROM ota_releases WHERE runtime_version = $1 AND bundle_hash = $2', [body.runtimeVersion, body.bundleHash]);
    if (twin) throw new ApiError('conflict', 'This bundle was already sent on this runtime.');
    const by = String(actor).slice(0, 80);
    if (runtime.fingerprint !== body.bundleFingerprint) {
      const [blocked] = await db.query(
        `INSERT INTO ota_releases (runtime_version, bundle_fingerprint, bundle_id, bundle_hash, message, status, block_reason, published_by, request_key)
         VALUES ($1, $2, $3, $4, $5, 'blocked', 'native_change', $6, $7) ON CONFLICT DO NOTHING RETURNING *`,
        [body.runtimeVersion, body.bundleFingerprint, body.bundleId, body.bundleHash, body.message, by, body.requestKey],
      );
      if (blocked) {
        await opsAlert({ kind: 'ota.native_change', severity: 'warning', target: `ota_release:${blocked.id}`, dedupeKey: `ota-native:${blocked.id}`, message: `An update for runtime ${body.runtimeVersion} changes native code, so it was not published. Start a store build instead.` });
        log.warn('ota.blocked', { releaseId: Number(blocked.id), runtimeVersion: body.runtimeVersion, reason: 'native_change' });
      }
      throw new ApiError('conflict', NATIVE);
    }
    const baseline = await baselineFor(body.runtimeVersion);
    const channels = await brandChannels();
    const { release, failed } = await db.tx(async (t) => {
      const [active] = await t.query(`SELECT * FROM ota_releases WHERE runtime_version = $1 AND status IN ('publishing', 'live', 'rolling_back') FOR UPDATE`, [body.runtimeVersion]);
      if (active?.status === 'rolling_back') throw new ApiError('conflict', `A roll back is running on runtime ${body.runtimeVersion}. Publish once it has finished.`);
      if (active) await t.query(`UPDATE ota_releases SET status = $2 WHERE id = $1`, [active.id, active.status === 'live' ? 'superseded' : 'failed']);
      const [made] = await t.query(
        `INSERT INTO ota_releases (runtime_version, bundle_fingerprint, bundle_id, bundle_hash, message, rollout, status, baseline_crash_rate, channels_total, published_by, request_key)
         VALUES ($1, $2, $3, $4, $5, 10, 'publishing', $6, $7, $8, $9) RETURNING *`,
        [body.runtimeVersion, body.bundleFingerprint, body.bundleId, body.bundleHash, body.message, baseline, channels.length, by, body.requestKey],
      );
      return { release: made, failed: active?.status === 'publishing' ? active : null };
    });
    if (failed) await takeOffChannels(failed.id);
    await audit(by, 'ota.published', `ota_release:${release.id}`, { runtimeVersion: body.runtimeVersion, channels: channels.length });
    await ctx.platform.queue.enqueue('ota.publish', { releaseId: Number(release.id) }, { dedupeKey: `ota-publish-${release.id}`, retryInFlight: true, maxAttempts: 8 });
    log.info('ota.publishing', { releaseId: Number(release.id), runtimeVersion: body.runtimeVersion, channels: channels.length });
    return { release: toRelease(release), created: true };
  }

  /** The job: the bundle onto every brand's channel that does not have it yet, then live. Throws to be tried again. */
  async function publishChannels(id) {
    let release = await releaseRow(id);
    if (!release || release.status !== 'publishing') return;
    const channels = await brandChannels();
    const done = new Set((await channelsOf(id, { fresh: true })).map((c) => c.channel));
    await db.query('UPDATE ota_releases SET channels_total = $2, channels_done = $3 WHERE id = $1 AND status = $4', [id, Math.max(channels.length, done.size), done.size, 'publishing']);
    for (const { tenantId: tid, channel } of channels) {
      if (done.has(channel)) continue;
      const { updateId } = await ctx.eas.publishUpdate({ channel, runtimeVersion: release.runtime_version, bundleId: release.bundle_id, message: release.message, idempotencyKey: `ota-update-${id}-${channel}` });
      await audit('system', CHANNEL_ROW, `ota_release:${id}`, { tenantId: tid, channel, updateId: String(updateId) });
      done.add(channel);
      channelCache.delete(String(id));
      release = await releaseRow(id);
      if (release.status !== 'publishing') {
        // Failed or replaced while this ran: take back what this job just put out.
        await ctx.eas.rollBack({ channel, updateId: String(updateId), idempotencyKey: `ota-rollback-${id}-${channel}` }).catch(() => {});
        return;
      }
      await db.query('UPDATE ota_releases SET channels_done = $2 WHERE id = $1 AND status = $3', [id, done.size, 'publishing']);
    }
    const [live] = await db.query(`UPDATE ota_releases SET status = 'live', channels_total = $2, channels_done = $2 WHERE id = $1 AND status = 'publishing' RETURNING id`, [id, done.size]);
    if (live) log.info('ota.live', { releaseId: Number(id), channels: done.size });
  }

  /** Rolls a release's channel updates back on the update service. True when every one is back. */
  async function takeOffChannels(id) {
    let all = true;
    for (const { channel, updateId } of await channelsOf(id, { fresh: true })) {
      try {
        await ctx.eas.rollBack({ channel, updateId, idempotencyKey: `ota-rollback-${id}-${channel}` });
      } catch (err) {
        all = false;
        log.warn('ota.channel_roll_back_failed', { releaseId: Number(id), channel, kind: err?.kind ?? err?.name ?? 'error' });
      }
    }
    return all;
  }

  // ---- moving a release ----

  /**
   * One stage on from the stage the request found. The move holds the release's row while it tells the update service, so a
   * roll back that starts meanwhile waits for the row and the update service is never told a new rollout once a roll back has
   * begun. A second advance at the same moment is refused, not queued after the first: it finds the row taken (NOWAIT), or,
   * once it gets the row, a stage other than the one it started from, so a double click never skips a stage. Inside the
   * transaction only `t` is queried (PGlite runs one transaction at a time and a query beside it would wait for it forever).
   * Within one process a second advance is refused before it reads anything, which also covers PGlite, where a read waits
   * for the open transaction and would otherwise find the new stage.
   */
  const advancing = new Set(); // release ids this process is advancing right now
  async function advance(id, actor) {
    const key = String(id);
    if (advancing.has(key)) throw new ApiError('conflict', 'This update is being changed right now. Look again in a moment.');
    advancing.add(key);
    try {
      return await advanceOnce(id, actor);
    } finally {
      advancing.delete(key);
    }
  }
  async function advanceOnce(id, actor) {
    const seen = await releaseRow(id);
    if (!seen) throw new ApiError('not_found', 'There is no such update.');
    if (seen.status === 'rolling_back') throw new ApiError('conflict', 'A roll back of this update is running. It cannot be advanced.');
    if (seen.status !== 'live') throw new ApiError('conflict', 'Only a live update can be advanced.');
    const from = Number(seen.rollout);
    const next = nextRollout(from);
    if (!next) throw new ApiError('conflict', 'This update already reaches everyone.');
    const channels = await channelsOf(id, { fresh: true });
    const moved = await db.tx(async (t) => {
      let release;
      try {
        [release] = await t.query('SELECT * FROM ota_releases WHERE id = $1 FOR UPDATE NOWAIT', [id]);
      } catch (err) {
        if (err?.code === '55P03') throw new ApiError('conflict', 'This update is being changed right now. Look again in a moment.');
        throw err;
      }
      if (release?.status === 'rolling_back') throw new ApiError('conflict', 'A roll back of this update is running. It cannot be advanced.');
      if (release?.status !== 'live' || Number(release.rollout) !== from) throw new ApiError('conflict', 'This update changed while it was being advanced. Look again.');
      const set = [];
      try {
        for (const c of channels) {
          await ctx.eas.setRollout({ channel: c.channel, updateId: c.updateId, percent: next });
          set.push(c);
        }
      } catch {
        // Put back the channels that took it, so every brand stays on the stage the release records.
        for (const c of set) await ctx.eas.setRollout({ channel: c.channel, updateId: c.updateId, percent: from }).catch(() => {});
        throw new ApiError('conflict', `The update service did not take the change. The update stays at ${from}%; try again.`);
      }
      const [row] = await t.query(`UPDATE ota_releases SET rollout = $2, advanced_at = now() WHERE id = $1 AND status = 'live' AND rollout = $3 RETURNING *`, [id, next, from]);
      if (!row) throw new ApiError('conflict', 'This update changed while it was being advanced. Look again.');
      return row;
    });
    await audit(actor, 'ota.advanced', `ota_release:${id}`, { from, to: next });
    log.info('ota.advanced', { releaseId: Number(id), rollout: next });
    return toRelease(moved);
  }

  /** Rolls a live release back ('manual' or 'crash_rate'). Repeating it on one rolled back, or rolling back, changes nothing. */
  async function rollBack(id, { reason = '', actor = 'system', cause = 'manual' } = {}) {
    let release = await releaseRow(id);
    if (!release) throw new ApiError('not_found', 'There is no such update.');
    if (release.status === 'rolled_back') return toRelease(release);
    if (release.status === 'live') {
      const [started] = await db.query(`UPDATE ota_releases SET status = 'rolling_back', rollback_reason = $2 WHERE id = $1 AND status = 'live' RETURNING *`, [id, cause === 'crash_rate' ? 'crash_rate' : 'manual']);
      if (!started) return rollBack(id, { reason, actor, cause });
      release = started;
      await audit(actor, 'ota.roll_back', `ota_release:${id}`, { cause, reason: String(reason).slice(0, 500) });
    } else if (release.status !== 'rolling_back') {
      throw new ApiError('conflict', 'Only a live update can be rolled back.');
    }
    if (await takeOffChannels(id)) {
      const [finished] = await db.query(`UPDATE ota_releases SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1 AND status = 'rolling_back' RETURNING *`, [id]);
      if (finished) release = finished;
      log.info('ota.rolled_back', { releaseId: Number(id), cause });
    }
    return toRelease(release ?? (await releaseRow(id)));
  }

  /** Every minute: crash verdicts on live releases, unfinished roll backs, stalled publishing. */
  async function watch() {
    const minLaunches = Number(config.otaMinLaunches ?? 50);
    for (const release of await db.query(`SELECT * FROM ota_releases WHERE status = 'live' ORDER BY id`)) {
      try {
        const totals = await windowTotals(release.id);
        if (totals.launches < minLaunches) continue;
        const baseline = release.baseline_crash_rate === null ? null : Number(release.baseline_crash_rate);
        const threshold = thresholdOf(config, baseline);
        const rate = rateOf(totals);
        if (wilsonLower(totals.crashes, Math.max(totals.launches, totals.crashes)) < threshold) continue;
        await rollBack(release.id, { actor: 'system', cause: 'crash_rate', reason: 'Crash rate over the threshold' });
        await opsAlert({
          kind: 'ota.rolled_back', target: `ota_release:${release.id}`, dedupeKey: `ota-rollback:${release.id}`,
          message: `Update ${release.id} on runtime ${release.runtime_version} was rolled back at ${release.rollout}%: ${totals.crashes} crashes in ${totals.launches} launches (${(rate * 100).toFixed(1)}%) against a threshold of ${(threshold * 100).toFixed(1)}%.`,
        });
      } catch (err) {
        reportError(err, { msg: 'ota.watch_failed', releaseId: Number(release.id) });
      }
    }
    for (const release of await db.query(`SELECT id FROM ota_releases WHERE status = 'rolling_back' ORDER BY id`)) {
      await rollBack(release.id, { actor: 'system' }).catch((err) => reportError(err, { msg: 'ota.roll_back_retry_failed' }));
    }
    for (const release of await db.query(`SELECT id, runtime_version, created_at FROM ota_releases WHERE status = 'publishing' ORDER BY id`)) {
      if (Date.now() - new Date(release.created_at).getTime() < PUBLISH_STALL_MS) {
        await ctx.platform.queue.enqueue('ota.publish', { releaseId: Number(release.id) }, { dedupeKey: `ota-publish-${release.id}-${Math.floor(Date.now() / 300_000)}`, retryInFlight: true, maxAttempts: 8 });
        continue;
      }
      const [failed] = await db.query(`UPDATE ota_releases SET status = 'failed' WHERE id = $1 AND status = 'publishing' RETURNING id`, [release.id]);
      if (!failed) continue;
      await takeOffChannels(release.id);
      await opsAlert({ kind: 'ota.publish_failed', target: `ota_release:${release.id}`, dedupeKey: `ota-publish-failed:${release.id}`, message: `Update ${release.id} on runtime ${release.runtime_version} did not reach every app and was stopped. Publish it again.` });
    }
  }

  async function list({ cursor, limit = 25 } = {}) {
    const rows = await db.query('SELECT * FROM ota_releases WHERE ($1::bigint IS NULL OR id < $1::bigint) ORDER BY id DESC LIMIT $2', [/^[1-9][0-9]{0,17}$/.test(String(cursor ?? '')) ? cursor : null, limit + 1]);
    const items = rows.slice(0, limit).map(toRelease);
    return { items, nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
  }

  return { publish, publishChannels, advance, rollBack, list, health, report, watch, channelsOf };
}

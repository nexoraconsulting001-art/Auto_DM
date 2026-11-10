import { INSTAGRAM_SCOPES } from '../../adapters/meta/index.js';
import { ApiError } from '../../contracts/api/index.js';
import { ANALYTICS_LIMITS } from '../../contracts/analytics.js';
import { log, reportError } from '../../platform/log.js';
import { currentTenant, tenantId, withTenant } from '../../tenancy.js';
import { SCOPES_TO_ANSWER } from '../facebook/connect.js';
import { DISCONNECTED_BY_OWNER } from '../ig-accounts/index.js';
import { SCOPE_INSIGHTS } from '../ig-connect/rules.js';
import {
  addDays, baselineBefore, clearsTrip, dayOf, isLearning, lastSettledDay, mediaTrip, median, reachDaysTrip, reachGuardState,
  scoreHealth, statusMessage, tripMessage, withMediaBaselines, worseState,
} from './rules.js';

const L = ANALYTICS_LIMITS;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often an account is looked at. Each look reads only the cache, and new figures arrive at most every few hours. */
export const EVALUATE_EVERY_MS = 15 * MINUTE;
/** PRD 5.9: a check runs at most every 10 min per business. */
export const HEALTH_EVERY_MS = 10 * MINUTE;
const SWEEP_BATCH = 200;
const WEBHOOK_SILENCE_MS = 72 * HOUR;
const CALL_STATS_KEEP_MS = 7 * DAY;
const INT32_MAX = 2_147_483_647;

/** Not an API failure. "Not enough viewers" (7.3), and insights calls Meta answered with "gone" or "expired", which the adapter also treats as an answer. */
function isNotAFailure(call) {
  if (call.kind === 'not_enough_viewers') return true;
  return /\/insights$/.test(call.pathname ?? '') && (call.kind === 'insights_expired' || call.kind === 'not_found');
}

const failed = (call) => Boolean(call.kind) || call.status === 0 || call.status >= 400;

const DEFAULT_THRESHOLDS = Object.freeze({
  reachDropPercent: L.reachDropPercent.default,
  mediaDropPercent: L.mediaDropPercent.default,
  clearPercent: L.clearPercent.default,
});

const toTripView = (trip, overriddenAt = trip.overrideAt) => ({
  id: trip.id, trigger: trip.trigger, startedAt: trip.startedAt, clearedAt: trip.clearedAt, baseline: trip.baseline, dropPercent: trip.dropPercent, overriddenAt: overriddenAt ?? null,
});

const NO_ACCOUNT_MESSAGE = 'Reach Guard starts once an account is connected and its insights are being collected.';

/** Reach Guard and Account Health for one app. Runs inside withTenant(), except sweep(), which finds the accounts and enters each business itself. */
export function createReachGuard({ db, repos, compliance }) {
  const rg = () => repos.reachGuard;
  const now = () => compliance.now();

  /** The connection behind an account, or null when it isn't connected: never linked up, or ended by the seller. */
  async function connectionOf(account) {
    const detail = account.channel === 'facebook' ? await repos.fbPages.detail(account.accountId) : await repos.igAccounts.detail(account.accountId);
    if (!detail || detail.statusReason === DISCONNECTED_BY_OWNER) return null;
    if (detail.status === 'active' && !detail.hasToken) return null;
    return detail;
  }

  /** Meta refused insights, or insights isn't among the permissions granted. No permissions on record (an account connected before they were stored) proves nothing. */
  function insightsDenied(account, connection) {
    if (account.permission === 'denied') return true;
    if (account.channel !== 'instagram' || !connection?.scopes?.length) return false;
    return !connection.scopes.includes(SCOPE_INSIGHTS);
  }

  function missingScopes(account, connection) {
    if (!connection?.scopes?.length) return [];
    const needed = account.channel === 'facebook' ? SCOPES_TO_ANSWER : INSTAGRAM_SCOPES;
    return needed.filter((scope) => !connection.scopes.includes(scope));
  }

  /** Looks at one account once. Safe to repeat and safe to run twice at the same moment: a trip, its alert and its reason code can each only happen once. */
  async function evaluate(account) {
    const at = now();
    const settledThrough = lastSettledDay(at);
    const { channel, accountId } = account;
    const saved = await rg().ensureState(account.id, at);
    const { thresholds } = saved;
    const series = await rg().settledReach(account.id, settledThrough);
    const media = withMediaBaselines(await rg().media24h(account.id));
    const connection = await connectionOf(account);
    const slow = await compliance.slowMode.status(channel, accountId);
    const denied = insightsDenied(account, connection);
    const usual = baselineBefore(series, addDays(settledThrough, 1));
    const learning = isLearning({ settledDays: usual.sample, mediaCounted: media.length });

    let trip = await rg().openTrip(account.id);
    if (trip && !denied && clearsTrip(series, trip, thresholds)) {
      if (await rg().endTrip(trip.id, { at, channel })) {
        await compliance.slowMode.leave(channel, accountId, 'reach_drop');
        log.info('reach_guard.cleared', { tenantId: tenantId(), accountRef: account.id, tripId: trip.id });
      }
      trip = null;
    } else if (!trip && !denied && !learning) {
      const found = reachDaysTrip(series, thresholds) ?? mediaTrip(media, thresholds, await rg().lastClearedAt(account.id));
      if (found) {
        const details = { ...found, baseline: found.baseline ?? usual.value };
        const started = await rg().startTrip(account.id, details, { at, channel, target: `${channel}:${accountId}`, message: tripMessage(found.dropPercent) });
        if (started) log.info('reach_guard.tripped', { tenantId: tenantId(), accountRef: account.id, tripId: started.id, trigger: found.trigger, dropPercent: found.dropPercent });
        trip = started ?? (await rg().openTrip(account.id));
      }
    }

    // Asked again every time: a cause with no set end has to keep asking, and enter() keeps the owner's override.
    if (trip) await compliance.slowMode.enter(channel, accountId, 'reach_drop');
    if (trip && !trip.overrideAt && slow.overridden && slow.trigger === 'reach_drop') {
      const rate = await compliance.gate.rateState(channel, accountId);
      await rg().noteOverride(trip.id, rate?.overrideAt ?? at);
    }
    if (denied) await compliance.slowMode.enter(channel, accountId, 'insights_denied');
    else if (slow.triggers.includes('insights_denied')) await compliance.slowMode.leave(channel, accountId, 'insights_denied');

    const state = reachGuardState({ denied, tripOpen: Boolean(trip), watch: slow.triggers.includes('buc_80002'), learning });
    const previous = await rg().saveState(account.id, { state, at, settledDays: usual.sample, mediaCounted: media.length, baselineReach: trip?.baseline ?? (learning ? null : usual.value) });
    if (state === 'permission_needed' && previous !== 'permission_needed') {
      await rg().notePermissionNeeded(account.id, { at, channel, target: `${channel}:${accountId}`, message: statusMessage({ state, channel }) });
    }

    await saveBaselines(account, settledThrough, series, usual, media);
    return state;
  }

  function saveBaselines(account, day, series, usual, media) {
    const observed = series.find((p) => p.day === day)?.reach ?? null;
    const rows = [{ scope: 'account', baseline: usual.value, sample: usual.sample, observed }];
    for (const kind of new Set(media.map((m) => m.kind))) {
      const ofKind = media.filter((m) => m.kind === kind).slice(-L.baselineMedia);
      rows.push({ scope: kind, baseline: median(ofKind.map((m) => m.reach)), sample: ofKind.length, observed: ofKind.at(-1).reach });
    }
    return rg().saveBaselines(account.id, day, rows);
  }

  const isDue = (savedState, at) => !savedState?.evaluatedAt || +at - +new Date(savedState.evaluatedAt) >= EVALUATE_EVERY_MS;

  async function viewOf(account) {
    const at = now();
    let saved = account.id ? await rg().state(account.id) : null;
    // A screen never shows a stale answer because a worker is behind. This reads only the cache and never calls Meta.
    if (account.id && isDue(saved, at)) {
      try {
        await evaluate(account);
      } catch (err) {
        reportError(err, { msg: 'reach_guard.evaluate_failed', tenantId: tenantId(), accountRef: account.id });
      }
      saved = await rg().state(account.id);
    }
    const slow = await compliance.slowMode.status(account.channel, account.accountId);
    const trip = account.id ? await rg().openTrip(account.id) : null;
    const denied = insightsDenied(account, await connectionOf(account));
    const counts = { settledDays: saved?.settledDays ?? 0, mediaCounted: saved?.mediaCounted ?? 0 };
    const state = reachGuardState({ denied, tripOpen: Boolean(trip), watch: slow.triggers.includes('buc_80002'), learning: isLearning(counts) });
    let overriddenAt = trip?.overrideAt ?? null;
    if (trip && !overriddenAt && slow.overridden && slow.trigger === 'reach_drop') overriddenAt = (await compliance.gate.rateState(account.channel, account.accountId))?.overrideAt ?? null;
    return {
      state,
      since: saved?.state === state ? saved.stateSince : slow.startedAt ?? null,
      message: statusMessage({ state, channel: account.channel, dropPercent: trip?.dropPercent, ...counts, overridden: Boolean(overriddenAt), restoring: slow.restoring }),
      ...counts,
      baselineReach: saved?.baselineReach ?? null,
      thresholds: saved?.thresholds ?? { ...DEFAULT_THRESHOLDS },
      trip: trip ? toTripView(trip, overriddenAt) : null,
      slowMode: { active: slow.active, trigger: slow.trigger, until: slow.until, canOverride: slow.canOverride, restoring: slow.restoring },
      lastEvaluatedAt: saved?.evaluatedAt ?? null,
    };
  }

  /** The business's answer. With more than one account, the one that needs attention most. */
  async function status() {
    const accounts = await rg().accounts();
    if (!accounts.length) {
      return {
        state: 'learning', since: null, message: NO_ACCOUNT_MESSAGE, settledDays: 0, mediaCounted: 0, baselineReach: null, thresholds: { ...DEFAULT_THRESHOLDS }, trip: null,
        slowMode: { active: false, trigger: null, until: null, canOverride: false, restoring: false }, lastEvaluatedAt: null,
      };
    }
    const views = [];
    for (const account of accounts) views.push(await viewOf(account));
    return views.sort((a, b) => worseState(a.state, b.state))[0];
  }

  async function setThresholds(change, user) {
    const values = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));
    if (Object.keys(values).length) {
      for (const account of await rg().accounts()) if (account.id) await rg().ensureState(account.id, now());
      if (!(await rg().setThresholds(values, `user:${user.id}`))) throw new ApiError('conflict', NO_ACCOUNT_MESSAGE);
    }
    return status();
  }

  // ---- Account Health --------------------------------------------------------------------------------------------------

  async function computeHealth(account) {
    const at = now();
    const connection = await connectionOf(account);
    if (!connection) {
      if (account.id) await rg().dropHealth(account.id);
      return null;
    }
    const { channel, accountId } = account;
    const since = new Date(+at - DAY);
    const stats = await rg().callStats(channel, accountId, since);
    const slow = await compliance.slowMode.status(channel, accountId);
    const rate = await compliance.gate.rateState(channel, accountId);
    const trip = account.id ? await rg().openTrip(account.id) : null;
    const usageIsRecent = rate?.usageAt && +new Date(rate.usageAt) > +since;
    const quietSince = new Date(+at - WEBHOOK_SILENCE_MS);
    const connectedAt = connection.connectedAt ?? connection.subscribedAt;
    const webhooksSilent = (!connectedAt || +new Date(connectedAt) <= +quietSince)
      && Boolean(account.id)
      && !(await rg().webhookSince(channel, accountId, quietSince))
      && (await rg().commentsSince(account.id, quietSince));

    const result = scoreHealth({
      channel,
      active: connection.status === 'active',
      hasToken: connection.hasToken,
      tokenExpiresAt: connection.tokenExpiresAt,
      refreshFailures: connection.refreshFailures ?? 0,
      calls: stats.calls,
      errors: stats.errors,
      excluded: stats.excluded,
      maxUsagePercent: Math.max(stats.maxUsagePercent, usageIsRecent ? rate.usagePercent ?? 0 : 0),
      buc80002: stats.bucThrottles > 0 || slow.triggers.includes('buc_80002'),
      missingScopes: missingScopes(account, connection),
      insightsDenied: insightsDenied(account, connection),
      webhooksSilent,
      tripDropPercent: trip ? trip.dropPercent ?? 0 : null,
      policyErrors: await rg().policyErrors(channel, since),
    }, at);

    if (account.id) await rg().saveHealth(account.id, result, { at, day: dayOf(at) });
    return { ...result, computedAt: at };
  }

  async function currentHealth(account) {
    if (account.id) {
      const saved = await rg().health(account.id);
      if (saved && +now() - +new Date(saved.computedAt) < HEALTH_EVERY_MS) return saved;
    }
    return computeHealth(account);
  }

  /** The business's score: its worst account's. A screen reads the cache, and works the score out from cached tables when it is older than 10 minutes. It never calls Meta. */
  async function health() {
    const results = [];
    for (const account of await rg().accounts()) {
      const result = await currentHealth(account);
      if (result) results.push(result);
    }
    const worst = results.sort((a, b) => a.score - b.score)[0];
    if (!worst) return { score: null, band: null, deductions: [], computedAt: null };
    return { score: worst.score, band: worst.band, deductions: worst.deductions, computedAt: worst.computedAt };
  }

  async function healthHistory({ range, from, to }) {
    const today = dayOf(now());
    const oldest = addDays(today, -(L.healthHistoryDays - 1));
    const end = range === 'custom' && to < today ? to : today;
    const wanted = range === 'custom' ? from : addDays(end, -(Number(range) - 1));
    const start = wanted < oldest ? oldest : wanted;
    const saved = await rg().healthHistory(start, end);
    const days = [];
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const row = saved.get(day);
      days.push({ day, value: row?.score ?? null, state: row ? 'ok' : 'no_data', mayChange: false, band: row?.band ?? null, deductions: row?.deductions ?? [] });
    }
    return { days };
  }

  /** Called for every call to Meta. Never throws into the call: meta-calls.js catches what this rejects with. */
  async function recordCall(call) {
    if (!currentTenant() || !call.channel || !call.accountId) return;
    const hour = new Date(Math.floor(+now() / HOUR) * HOUR);
    const excluded = failed(call) && isNotAFailure(call);
    await rg().recordCall({
      channel: call.channel,
      accountId: call.accountId,
      hour,
      errors: failed(call) && !excluded ? 1 : 0,
      excluded: excluded ? 1 : 0,
      bucThrottles: call.kind === 'buc_throttled' ? 1 : 0,
      usagePercent: Math.min(INT32_MAX, Math.max(0, Math.round(call.usage?.percent ?? 0))),
    });
  }

  /** Every account due a look, across businesses: only finding them needs the unfenced connection, and each one runs inside its own business. */
  async function sweep() {
    const at = now();
    const due = await db.platform.query(
      `SELECT a.tenant_id, a.id FROM analytics_accounts a
         JOIN tenants t ON t.id = a.tenant_id AND t.status NOT IN ('closed', 'killed')
         LEFT JOIN reach_guard_state s ON s.tenant_id = a.tenant_id AND s.account_ref = a.id
       WHERE s.evaluated_at IS NULL OR s.evaluated_at <= $1::timestamptz
       ORDER BY s.evaluated_at ASC NULLS FIRST, a.id LIMIT $2`,
      [new Date(+at - EVALUATE_EVERY_MS), SWEEP_BATCH],
    );
    const oldest = addDays(dayOf(at), -(L.healthHistoryDays - 1));
    for (const row of due) {
      try {
        await withTenant(row.tenant_id, async () => {
          const account = await rg().account(row.id);
          if (!account) return;
          await evaluate(account);
          await computeHealth(account);
          await rg().purgeOld(account.id, oldest);
        });
      } catch (err) {
        reportError(err, { msg: 'reach_guard.sweep_failed', tenantId: row.tenant_id, accountRef: row.id });
      }
    }
    await db.platform.query('DELETE FROM meta_call_stats WHERE hour < $1::timestamptz', [new Date(+at - CALL_STATS_KEEP_MS)]);
    return due.length;
  }

  async function trips(query) {
    const page = await rg().trips(query);
    return { items: page.items.map((trip) => toTripView(trip)), nextCursor: page.nextCursor };
  }

  return { evaluate, status, setThresholds, trips, health, healthHistory, computeHealth, recordCall, sweep };
}

import { ANALYTICS_LIMITS, HEALTH_DEDUCTIONS } from '../../contracts/analytics.js';

/**
 * Reach Guard (PRD 7.6) and Account Health (7.7) as pure functions of what the cache holds, so every edge can be tested exactly. service.js reads the
 * facts, applies these and does what they say. Copy lives here too: nothing a seller reads may say "shadowbanned" or call an account "safe".
 *
 * Days are ISO dates in UTC, as Meta's end_time gives them, and compare as strings. A series is [{ day, reach }], oldest first, with no empty days:
 * a day Meta returned nothing for is "no data", never 0, so it can neither count as low nor as recovered, and it breaks a run.
 */
const DAY = 86_400_000;
const L = ANALYTICS_LIMITS;

export const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The newest day that counts as settled: at least 2 days old. Anything later may still change and is ignored (N-24). */
export const lastSettledDay = (at) => addDays(dayOf(at), -L.settleDays);

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** "Down by" as a whole percentage, from 0 to 100. */
export const dropPercentOf = (observed, baseline) => Math.min(100, Math.max(0, Math.round((1 - observed / baseline) * 100)));

/** The median of the 28 days before `day`, so days being judged can never pull down their own yardstick. */
export function baselineBefore(series, day) {
  const from = addDays(day, -L.baselineDays);
  const values = series.filter((p) => p.day >= from && p.day < day).map((p) => p.reach);
  return { value: median(values), sample: values.length };
}

/** The newest `length` points, if they are consecutive calendar days. A gap breaks the run. */
export function latestRun(series, length) {
  const run = series.slice(-length);
  if (run.length < length) return null;
  return run.every((p, i) => i === 0 || p.day === addDays(run[i - 1].day, 1)) ? run : null;
}

export const isLearning = ({ settledDays, mediaCounted }) => settledDays < L.learningMinSettledDays || mediaCounted < L.learningMinMedia;

/** The trip by daily reach: the 3 newest settled days all below the threshold, against the 28 days before them. Exactly on the threshold is not below it. */
export function reachDaysTrip(series, { reachDropPercent }) {
  const run = latestRun(series, L.tripConsecutiveDays);
  if (!run) return null;
  const { value: baseline } = baselineBefore(series, run[0].day);
  if (!baseline || !run.every((p) => p.reach * 100 < baseline * reachDropPercent)) return null;
  return {
    trigger: 'reach_days',
    baseline,
    dropPercent: dropPercentOf(median(run.map((p) => p.reach)), baseline),
    observed: run.map(({ day, reach }) => ({ day, reach })),
  };
}

/**
 * Gives each media the median 24h reach of the last 10 media of its type before it, or null with fewer than 5 of them to compare with.
 * media is [{ mediaId, kind, postedAt, reach }], oldest first.
 */
export function withMediaBaselines(media) {
  const history = new Map();
  return media.map((item) => {
    const seen = history.get(item.kind) ?? [];
    const baseline = seen.length >= L.learningMinMedia ? median(seen.slice(-L.baselineMedia)) : null;
    seen.push(item.reach);
    history.set(item.kind, seen);
    return { ...item, baseline };
  });
}

/**
 * The trip by media: the 3 newest comparable media all below the threshold at 24h, each against its own type. A media with no yardstick neither counts
 * nor breaks the run. `after` keeps media from a trip that has already cleared out of the next one, or they would trip it again at once.
 */
export function mediaTrip(media, { mediaDropPercent }, after = null) {
  const run = media.filter((m) => m.baseline && (!after || +new Date(m.postedAt) > +new Date(after))).slice(-L.tripConsecutiveMedia);
  if (run.length < L.tripConsecutiveMedia || !run.every((m) => m.reach * 100 < m.baseline * mediaDropPercent)) return null;
  const ratios = run.map((m) => m.reach / m.baseline).sort((a, b) => a - b);
  return {
    trigger: 'media_24h',
    dropPercent: dropPercentOf(ratios[Math.floor(ratios.length / 2)], 1),
    observed: run.map(({ mediaId, kind, reach, baseline, postedAt }) => ({ mediaId, kind, reach, baseline, postedAt: new Date(postedAt).toISOString() })),
  };
}

/** The first day that can count towards clearing a trip: after the days that caused it, or from the day a media trip started. */
function firstClearingDay(trip) {
  const lastLow = trip.trigger === 'reach_days' ? trip.observed?.at(-1)?.day : null;
  return lastLow ? addDays(lastLow, 1) : dayOf(trip.startedAt);
}

/** Clears on 3 settled days in a row at the clear level of the baseline the trip started from. A rolling baseline would sink with the drop and clear it too soon. */
export function clearsTrip(series, trip, { clearPercent }) {
  if (trip.baseline === null || trip.baseline === undefined) return false;
  const from = firstClearingDay(trip);
  const run = latestRun(series.filter((p) => p.day >= from), L.clearConsecutiveDays);
  return Boolean(run) && run.every((p) => p.reach * 100 >= trip.baseline * clearPercent);
}

/** One state per account, in this order. 80002 is Watch (4.3). An open trip outranks it, because the trip is what the owner must act on. */
export function reachGuardState({ denied, tripOpen, watch, learning }) {
  if (denied) return 'permission_needed';
  if (tripOpen) return 'tripped';
  if (watch) return 'watch';
  return learning ? 'learning' : 'normal';
}

/** Worst first, for a business with more than one account. */
const STATE_ORDER = Object.freeze({ permission_needed: 0, tripped: 1, watch: 2, normal: 3, learning: 4 });
export const worseState = (a, b) => STATE_ORDER[a] - STATE_ORDER[b];

export const channelName = (channel) => (channel === 'facebook' ? 'Facebook' : 'Instagram');

const NORMAL_CAUSES = 'Possible normal causes: posting less than usual, a change in what or when you post, a holiday or a seasonal dip, or figures that Meta is still updating.';

export const tripMessage = (dropPercent) => `Reach is down ${dropPercent}% vs your usual. ${NORMAL_CAUSES}`;

/** What Reach Guard says about an account. */
export function statusMessage({ state, channel, dropPercent, settledDays = 0, mediaCounted = 0, overridden = false, restoring = false }) {
  const name = channelName(channel);
  switch (state) {
    case 'permission_needed':
      return `Permission needed. Bhava can’t read your ${name} insights, so automations run in slow mode. Reconnect ${name} and allow insights to fix this.`;
    case 'tripped':
      return `${tripMessage(dropPercent ?? 0)} ${overridden ? 'You turned slow mode off, so automations are running at full speed.' : 'Automations run in slow mode until reach recovers.'}`;
    case 'watch':
      return `${name} has limited how often Bhava can read your data, so insights are paused and automated DMs run at half speed. This lifts by itself.`;
    case 'learning':
      return `Reach Guard is learning what’s usual for this account. It needs ${L.learningMinSettledDays} settled days and ${L.learningMinMedia} posts, and has ${settledDays} days and ${mediaCounted} posts so far.`;
    default:
      return restoring ? 'Reach has recovered. Automations are returning to full speed over the next 48 hours.' : 'Reach is in your usual range.';
  }
}

// ---- Account Health (7.7) -----------------------------------------------------------------------------------------------

export const bandOf = (score) => (score >= L.healthGoodFrom ? 'good' : score >= L.healthWatchFrom ? 'watch' : 'at_risk');

const pointsOf = (code) => (HEALTH_DEDUCTIONS[code] === 'score_zero' ? -100 : HEALTH_DEDUCTIONS[code]);

/**
 * Score, band and deductions from the checks' facts:
 *   { channel, active, hasToken, tokenExpiresAt, refreshFailures, calls, errors, excluded, maxUsagePercent, buc80002, missingScopes, insightsDenied,
 *     webhooksSilent, tripDropPercent, policyErrors }
 * Each check gives one deduction, its worst tier. Every deduction names its fix. Worst first, which is how 5.9 lists them too. Nothing here says an account is fine.
 */
export function scoreHealth(facts, at) {
  const name = channelName(facts.channel);
  const deductions = [];
  const deduct = (code, message, fix) => deductions.push({ code, points: pointsOf(code), message, fix });

  const left = facts.tokenExpiresAt ? +new Date(facts.tokenExpiresAt) - +at : Infinity;
  const days = Math.ceil(left / DAY);
  const lost = !facts.active || !facts.hasToken || left <= 0;
  if (lost) deduct('token_rejected', `${name} no longer accepts this connection, so automations are on hold.`, `Reconnect ${name}`);
  else if (facts.refreshFailures > 0) deduct('token_refresh_failed', `Refresh failed: Bhava could not renew your ${name} connection.`, `Reconnect ${name}`);
  else if (left <= 3 * DAY) deduct('token_3d', `Red: your ${name} connection ends in ${days} ${days === 1 ? 'day' : 'days'}.`, `Reconnect ${name} now so automations keep running.`);
  else if (left <= 14 * DAY) deduct('token_14d', `Refresh pending: your ${name} connection ends in ${days} days.`, `Nothing to do yet. Bhava renews it automatically. If this is still here in a few days, reconnect ${name}.`);

  const counted = Math.max(0, (facts.calls ?? 0) - (facts.excluded ?? 0));
  const rate = counted > 0 ? (facts.errors ?? 0) / counted : 0;
  const errorText = `API errors ${Math.round(rate * 100)}% in the last 24 hours.`;
  const errorFix = `Most clear by themselves. If this stays, check your ${name} connection or contact support.`;
  if (rate > 0.2) deduct('api_errors_20', errorText, errorFix);
  else if (rate > 0.05) deduct('api_errors_5', errorText, errorFix);

  if ((facts.maxUsagePercent ?? 0) >= 75) deduct('usage_75', `${name} API usage has reached ${Math.round(facts.maxUsagePercent)}% of its limit.`, 'Bhava slows its own calls to stay under the limit. Nothing to do unless this stays.');
  if (facts.buc80002) deduct('buc_80002', `${name} limited API calls in the last 24 hours (error 80002).`, 'Automated DMs run at half speed until the limit lifts. It lifts by itself.');

  const scopes = facts.missingScopes ?? [];
  if (scopes.length || facts.insightsDenied) {
    const what = facts.insightsDenied ? 'read your insights' : 'use a permission it needs';
    deduct('scope_missing', `Permission needed: Bhava can’t ${what}.`, `Reconnect ${name} and allow every permission.`);
  }

  if (facts.webhooksSilent) deduct('no_webhooks_72h', `No events from ${name} for 72 hours, while your posts got comments.`, `Reconnect ${name} so comments reach Bhava again.`);
  if (facts.tripDropPercent !== null && facts.tripDropPercent !== undefined) deduct('reach_guard_tripped', `Reach is down ${facts.tripDropPercent}% vs your usual.`, 'Automations run in slow mode until reach recovers. See Reach Guard for possible normal causes.');
  if ((facts.policyErrors ?? 0) > 0) deduct('messaging_policy', `${name} refused messages under its messaging policy in the last 24 hours.`, 'Check your automations and when they send. Contact support if this continues.');

  deductions.sort((a, b) => a.points - b.points);
  const score = lost ? 0 : Math.max(0, 100 + deductions.reduce((sum, d) => sum + d.points, 0));
  return { score, band: bandOf(score), deductions };
}

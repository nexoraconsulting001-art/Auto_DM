/**
 * What the Observability screen shows for one business, as plain data (platform.businessOps, src/contracts/metrics.js BusinessOps):
 * numbers only, each with a tone that says whether to look. The thresholds are the ones the platform's own alerts use for the whole
 * platform (Meta use 80% and 95%, a job waiting 10 and 30 minutes), so a business that is the cause shows before the alert does.
 */
export const WINDOWS = Object.freeze([
  { hours: 24, label: 'Last 24 hours' },
  { hours: 168, label: 'Last 7 days' },
  { hours: 720, label: 'Last 30 days' },
]);
export const USAGE_WARN_PERCENT = 80;
export const USAGE_BAD_PERCENT = 95;
export const QUEUE_WARN_SECONDS = 600;
export const QUEUE_BAD_SECONDS = 1800;
export const TONE_ORDER = Object.freeze(['good', 'neutral', 'warn', 'bad']);

/** A window the screen offers, else the default of 24 hours. */
export const hoursOf = (value) => (WINDOWS.some((w) => w.hours === Number(value)) ? Number(value) : 24);

/** 90 seconds is "1 min 30 s"; 5400 is "1 h 30 min"; nothing is "none". */
export function formatAge(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s <= 0) return 'none';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} h${m ? ` ${m} min` : ''}`;
}

const bySize = (value, warn, bad) => (value >= bad ? 'bad' : value >= warn ? 'warn' : 'good');

/** One row per number: { key, label, value, tone, hint }. */
export function opsFigures(ops) {
  const calls = ops.metaCalls;
  const throttledShare = calls ? ops.metaThrottled / calls : 0;
  return [
    { key: 'errors', label: 'Errors reported', value: String(ops.errors), tone: ops.errors === 0 ? 'good' : ops.errors >= 50 ? 'bad' : 'warn', hint: 'Errors the platform logged while working for this business.' },
    { key: 'metaCalls', label: 'Calls to Meta', value: String(calls), tone: 'neutral', hint: 'Every call made for this business to Instagram or Facebook.' },
    { key: 'metaThrottled', label: 'Throttled by Meta', value: String(ops.metaThrottled), tone: ops.metaThrottled === 0 ? 'good' : throttledShare >= 0.1 ? 'bad' : 'warn', hint: 'Calls Meta refused because of a rate limit.' },
    { key: 'metaUsage', label: 'Highest Meta limit use', value: `${Math.round(ops.metaUsagePercent)}%`, tone: bySize(ops.metaUsagePercent, USAGE_WARN_PERCENT, USAGE_BAD_PERCENT), hint: 'The most of a Meta rate limit this business used in the window.' },
    { key: 'queueDepth', label: 'Jobs waiting now', value: String(ops.queueDepth), tone: ops.queueDepth === 0 ? 'good' : 'neutral', hint: 'At the last sample, taken every five minutes.' },
    { key: 'queueOldest', label: 'Oldest job waiting', value: formatAge(ops.queueOldestSeconds), tone: bySize(ops.queueOldestSeconds, QUEUE_WARN_SECONDS, QUEUE_BAD_SECONDS), hint: 'How long the oldest waiting job has been waiting.' },
  ];
}

/** The worst tone among the figures, for the banner. */
export function worstTone(figures) {
  return figures.reduce((worst, f) => (TONE_ORDER.indexOf(f.tone) > TONE_ORDER.indexOf(worst) ? f.tone : worst), 'good');
}

/** The webhook check of a business's health (the platform's Health screen), as the words for "last webhook". */
export function lastWebhook(health) {
  const check = health?.checks?.find((c) => c.check === 'account.webhooks');
  if (!check) return { text: 'Not checked yet', tone: 'neutral', at: null };
  const text = { ok: 'Arriving', warn: 'None for 72 hours', bad: 'Not arriving', unreachable: 'Could not be checked' }[check.status] ?? 'Not checked yet';
  return { text, tone: { ok: 'good', warn: 'warn', bad: 'bad' }[check.status] ?? 'neutral', at: check.lastRanAt ?? null };
}

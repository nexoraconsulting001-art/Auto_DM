import { ANALYTICS_LIMITS as L } from '../../contracts/analytics.js';

/**
 * The polling schedule (PRD 7.3, 7.8) as plain arithmetic, so every edge can be tested without a clock or a database. Times are milliseconds and days are
 * 'YYYY-MM-DD' in UTC, because that is how src/adapters/meta/insights.js asks Meta for a day.
 */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 7.8 names no interval for reading the lists: a new post has to be found soon enough for its 3-hour polls to mean something, and a story within one story poll. */
export const MEDIA_LIST_EVERY_MS = L.mediaYoungEveryMs;
export const STORY_LIST_EVERY_MS = L.storyEveryMs;
/** An account whose login can't use /stories asks again now and then, since whether it exists is still to confirm (7.3). */
export const STORY_EDGE_RECHECK_MS = DAY;
/** Meta keeps 90 days, and they are worth having from the day a business connects; 30 at a time keeps one job well inside its lease. */
export const BACKFILL_DAYS_PER_RUN = 30;
export const BACKFILL_EVERY_MS = HOUR;

export const CALL_CLASS = Object.freeze({
  account_daily: 'insights',
  demographics: 'insights',
  media: 'insights',
  media_list: 'media_list',
  story: 'story_insights',
  story_list: 'story_insights',
});

export const ACCOUNT_JOBS = Object.freeze(['account_daily', 'demographics', 'media_list', 'story_list']);

const GOLDEN_RATIO = 0.6180339887498949;

/**
 * Where in the hour a business's jobs start. Multiples of the golden ratio spread consecutive ids almost evenly, so a run of new businesses can't bunch up in
 * one minute the way a plain hash can (N-37).
 */
export const pollOffsetSeconds = (tenantId) => Math.floor(((Number(tenantId) * GOLDEN_RATIO) % 1) * 3600);

/** Each of a business's account jobs a few minutes apart, so one business never starts them all in the same minute. */
export const accountJitterSeconds = (offset, job) => (offset + ACCOUNT_JOBS.indexOf(job) * 419) % 3600;

function stringHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export const mediaJitterSeconds = (offset, mediaId) => (offset + (stringHash(String(mediaId)) % 3600)) % 3600;

/** The first moment at or after `now` that is `jitterSeconds` into an hour. */
export function firstDueAt(now, jitterSeconds) {
  const due = Math.floor(now / HOUR) * HOUR + jitterSeconds * 1000;
  return due >= now ? due : due + HOUR;
}

/** The next run after `due`, on the same phase as `due`, and never in the past: a worker that was down doesn't owe a run for each interval it missed. */
export function nextDueAfter(due, everyMs, now) {
  return due + Math.max(1, Math.floor((now - due) / everyMs) + 1) * everyMs;
}

/** How often media of this age is read, or null when Meta no longer keeps it (7.8, 4.3 row 20). */
export function mediaEveryMs(ageMs) {
  if (ageMs < L.mediaYoungUnderMs) return L.mediaYoungEveryMs;
  if (ageMs < L.mediaMidUnderMs) return L.mediaMidEveryMs;
  if (ageMs < L.mediaHistoryDays * DAY) return L.mediaOldEveryMs;
  return null;
}

/** 'early' takes a normal snapshot, 'final' the last one, and 'closed' means the window has passed and nothing should be asked of Meta (7.3). */
export function storyPhase(ageMs) {
  if (ageMs >= L.storyFinalToMs) return 'closed';
  return ageMs >= L.storyFinalFromMs ? 'final' : 'early';
}

/** Every 2 hours from when the story was posted, then the final snapshot at 22 hours (N-10). */
export function nextStoryDue(postedAt, now) {
  const step = (Math.floor((now - postedAt) / L.storyEveryMs) + 1) * L.storyEveryMs;
  return postedAt + Math.min(step, L.storyFinalFromMs);
}

/** The wait after a failed poll: 5 minutes doubling to 6 hours, with jitter so a Meta outage doesn't end with every business at once. */
export function retryDelayMs(attempts, random = Math.random) {
  return Math.round(Math.min(6 * HOUR, 5 * MINUTE * 2 ** Math.max(0, attempts)) * (0.8 + 0.4 * random()));
}

// ---- days --------------------------------------------------------------------------------------------------------------

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day, n) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY);

export function eachDay(from, to) {
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * Which days an account poll fetches: the last 3 complete days, which Meta may still revise (7.8), then whatever else of Meta's 90 days isn't stored yet,
 * newest first. The oldest day is 89 back so a whole day's window stays inside the 90 Meta allows.
 */
export function accountDaysToFetch(today, storedDays, perRun = BACKFILL_DAYS_PER_RUN) {
  const recent = Array.from({ length: L.accountRefetchDays }, (_, i) => addDays(today, -(i + 1)));
  const stored = new Set(storedDays);
  const missing = [];
  for (let back = L.accountRefetchDays + 1; back < L.accountRetentionDays; back++) {
    const day = addDays(today, -back);
    if (!stored.has(day)) missing.push(day);
  }
  return { days: [...recent, ...missing.slice(0, perRun)], more: missing.length > perRun };
}

// ---- time zones ---------------------------------------------------------------------------------------------------------

const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** { day, weekday, hour } of a moment in a time zone. A zone Intl doesn't know reads as the default, since a screen must not fail over it. */
export function zonedTime(ms, timeZone) {
  let format;
  try {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || DEFAULT_TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit' });
  } catch {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit' });
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: WEEKDAYS.indexOf(parts.weekday), hour: Number(parts.hour) };
}

/**
 * online_followers by hour, as the cells insight_online_followers holds. Meta gives one day's hours with no zone stated, so they are read as UTC (to confirm,
 * along with whether Meta still returns this at all, 7.5). A poll each day fills all seven weekdays within a week.
 */
export function onlineFollowerCells(hours, now, timeZone) {
  const dayStart = Math.floor(now / DAY) * DAY;
  return Object.entries(hours).flatMap(([hour, value]) => {
    const h = Number(hour);
    if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isFinite(value)) return [];
    const zoned = zonedTime(dayStart + h * HOUR, timeZone);
    return [{ weekday: zoned.weekday, hour: zoned.hour, value: Math.max(0, Math.round(value)) }];
  });
}

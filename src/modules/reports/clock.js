import { addDays, localParts } from '../traffic/time.js';

/**
 * Report times are the business's wall clock (7.9, 7.13): Monday 09:00, the 1st at 09:00, or a schedule's own hour. Everything here is pure, so the
 * rules can be tested at any moment and in any zone. Weekday 0 is Sunday, as in the contract.
 */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const REPORT_HOUR = 9;
/** A report missed at its moment (the worker was down) still goes within this long, and not after: a late Monday report is better than none, a Wednesday one is noise. */
export const CATCH_UP_MS = DAY_MS;

export { addDays, localParts };

/** The app's clock for reports. Tests and the spec world set config.reportsNow. */
export const clockOf = (config) => config?.reportsNow ?? Date.now;

/** A zone that Intl knows, or India's: every business has one, and a bad value must never stop a report. */
export function safeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone || 'Asia/Kolkata' });
    return zone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

function wallClock(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** The instant that reads `day` at `hour`:`minute` on the business's clock. A zone that jumps over that hour gives the first instant after the gap. */
export function zonedMoment(day, hour, minute, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 3; i++) guess = wanted - (wallClock(guess, timeZone) - guess);
  return guess;
}

export const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
export const dayOfMonth = (day) => Number(day.slice(8, 10));
export const firstOfMonth = (day) => `${day.slice(0, 7)}-01`;
export const previousMonthStart = (day) => firstOfMonth(addDays(firstOfMonth(day), -1));

/**
 * The weekly report due at `at`: Monday 09:00 on the business's clock, for the Monday to Sunday before it. Null outside the
 * window that starts at that moment, so 08:59 is too early and Tuesday 09:00 is too late.
 */
export function weeklyDue(at, timeZone) {
  const zone = safeZone(timeZone);
  const today = localParts(new Date(at), zone).day;
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  const moment = zonedMoment(monday, REPORT_HOUR, 0, zone);
  if (at < moment || at >= moment + CATCH_UP_MS) return null;
  return { periodStart: addDays(monday, -7), periodEnd: addDays(monday, -1), moment };
}

/** The monthly report due at `at`: the 1st at 09:00 on the business's clock, for the calendar month before. */
export function monthlyDue(at, timeZone) {
  const zone = safeZone(timeZone);
  const today = localParts(new Date(at), zone).day;
  const first = firstOfMonth(today);
  const moment = zonedMoment(first, REPORT_HOUR, 0, zone);
  if (at < moment || at >= moment + CATCH_UP_MS) return null;
  return { periodStart: previousMonthStart(first), periodEnd: addDays(first, -1), moment };
}

/** A schedule's own day rule, with the defaults the console shows: Monday for weekly, the 1st for monthly. */
export function scheduleRule({ frequency, weekday, dayOfMonth: dom }) {
  if (frequency === 'weekly') return { frequency, weekday: weekday ?? 1, dayOfMonth: null };
  if (frequency === 'monthly') return { frequency, weekday: null, dayOfMonth: dom ?? 1 };
  return { frequency: 'daily', weekday: null, dayOfMonth: null };
}

/** The first moment strictly after `after` at which the schedule runs, on the business's clock. */
export function nextRunAt(schedule, after, timeZone) {
  const zone = safeZone(timeZone);
  const rule = scheduleRule(schedule);
  const hour = Number(schedule.hourOfDay ?? REPORT_HOUR);
  const start = localParts(new Date(after), zone).day;
  for (let i = 0; i <= 62; i++) {
    const day = addDays(start, i);
    if (rule.frequency === 'weekly' && weekdayOf(day) !== rule.weekday) continue;
    if (rule.frequency === 'monthly' && dayOfMonth(day) !== rule.dayOfMonth) continue;
    const moment = zonedMoment(day, hour, 0, zone);
    if (moment > after) return moment;
  }
  throw new Error('No next run within two months');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "3 to 9 November 2026", "28 October to 3 November 2026". */
export function periodLabel(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fy === ty && fm === tm) return fd === td ? `${td} ${MONTHS[tm - 1]} ${ty}` : `${fd} to ${td} ${MONTHS[tm - 1]} ${ty}`;
  if (fy === ty) return `${fd} ${MONTHS[fm - 1]} to ${td} ${MONTHS[tm - 1]} ${ty}`;
  return `${fd} ${MONTHS[fm - 1]} ${fy} to ${td} ${MONTHS[tm - 1]} ${ty}`;
}

export const monthLabel = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

/** A local date and time for a file: "2026-11-07 01:30". */
export function localStamp(at, timeZone) {
  if (at === null || at === undefined) return '';
  const ms = +new Date(at);
  if (!Number.isFinite(ms)) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: safeZone(timeZone), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

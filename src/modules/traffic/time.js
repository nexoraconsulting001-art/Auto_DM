import { ANALYTICS_LIMITS as L } from '../../contracts/analytics.js';
import { tenantId } from '../../tenancy.js';

/** Days are 'YYYY-MM-DD' in the business's time zone (7.10). Weekday 0 is Sunday, as in the rollup tables. */
const DAY_MS = 86_400_000;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export const clockOf = (config) => config?.trafficNow ?? config?.complianceNow ?? Date.now;

/** The business's zone. Falls back to India: every business has one, and a bad value must not stop a page view being counted. */
export async function timeZoneOf(db) {
  const [row] = await db.query('SELECT timezone FROM tenants WHERE id = $1', [tenantId()]);
  const zone = row?.timezone || 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return 'Asia/Kolkata';
  }
}

function zoned(at, timeZone) {
  const fields = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(at);
  return Object.fromEntries(fields.map((p) => [p.type, p.value]));
}

export function localParts(at, timeZone) {
  const p = zoned(at, timeZone);
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: WEEKDAYS[p.weekday] };
}

/** The moment a local day begins, allowing for a zone whose offset changes that day. */
export function dayStart(day, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const offsetAt = (instant) => {
    const p = zoned(new Date(instant), timeZone);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instant;
  };
  let guess = utc - offsetAt(utc);
  guess = utc - offsetAt(guess);
  return new Date(guess);
}

export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

function shiftYear(day) {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** The days a ranged query covers: the presets end today, in the business's zone. */
export function rangeOf(query, today) {
  if (query.range === 'custom') return { since: query.from, until: query.to };
  return { since: addDays(today, 1 - Number(query.range ?? 28)), until: today };
}

export function previousOf({ since, until }) {
  const length = daysBetween(since, until) + 1;
  return { since: addDays(since, -length), until: addDays(until, -length) };
}

export const lastYearOf = ({ since, until }) => ({ since: shiftYear(since), until: shiftYear(until) });

export function compareRange(query, range) {
  if (query.compare === 'previous') return previousOf(range);
  if (query.compare === 'last_year') return lastYearOf(range);
  if (query.compare === 'custom') return { since: query.compareFrom, until: query.compareTo };
  return null;
}

/** A session ends after 30 minutes without a hit, or at midnight in the business's zone (7.10). */
export const sameSession = (lastSeen, at, lastDay, day) => +at - +lastSeen < L.sessionIdleMs && lastDay === day;

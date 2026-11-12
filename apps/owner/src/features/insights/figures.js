/**
 * Pure: how the analytics screens (insights, Reach Guard, traffic, reports) turn the API's figures into words and
 * chart points. No React Native here, so the server's tests load it too.
 *
 * The rules this file holds (PRD 7.1, 7.15, 10.4):
 *  - a figure the API could not give comes back as null with a state that says why, and is shown as that state's
 *    words ("Not available", "Not collected", "<5"), never as 0;
 *  - "Permission needed" (the account's insights permission is gone) replaces a chart, it is never drawn as a flat line;
 *  - every chart and table names where its numbers come from (the API's `source`);
 *  - money is integer paise from the server, formatted and never added up here; revenue is for the people the
 *    access rules allow (canSeeRevenue) and nobody else.
 */
import { canSeeRevenue } from '@bhava/app-core/access';
import { formatMoney } from '../products/money.js';

/** The API's source codes and the string keys that say them (7.15). */
export const SOURCE_KEYS = Object.freeze({
  bhava: 'insights.source.bhava',
  platform: 'insights.source.platform',
  destination: 'insights.source.destination',
});
/** The key for a source code, or null for one the app does not know (shown as nothing rather than as a guess). */
export const sourceKey = (code) => (typeof code === 'string' && Object.hasOwn(SOURCE_KEYS, code) ? SOURCE_KEYS[code] : null);

/** A figure's state (FigureState in the contract) and the words for it when there is no number. */
export const STATE_KEYS = Object.freeze({
  no_data: 'insights.figure.noData',
  not_collected: 'insights.figure.notCollected',
  below_threshold: 'insights.figure.belowFive',
  not_available: 'insights.figure.notAvailable',
  permission: 'insights.figure.permissionNeeded',
  low_volume: 'insights.figure.lowVolume',
  hidden: 'insights.figure.ownerOnly',
});

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Indian digit grouping (12,34,567) without Intl, so Android and iOS read the same. */
function group(digits) {
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
}

/** A whole count: 1234567 as "12,34,567". Not a number gives '' (a caller says why there is no figure instead). */
export function formatCount(value) {
  if (!isNumber(value)) return '';
  const rounded = Math.round(value);
  return `${rounded < 0 ? '-' : ''}${group(String(Math.abs(rounded)))}`;
}

const trimmed = (n) => {
  const one = Math.round(n * 10) / 10;
  return Number.isInteger(one) ? String(one) : one.toFixed(1);
};

/** 12,400 as 12.4K and 1,25,00,000 as 1.3 Cr, for a tile on a small screen. */
export function formatCompact(value) {
  if (!isNumber(value)) return '';
  const size = Math.abs(value);
  if (size >= 10_000_000) return `${trimmed(value / 10_000_000)} Cr`;
  if (size >= 100_000) return `${trimmed(value / 100_000)} L`;
  if (size >= 10_000) return `${trimmed(value / 1000)}K`;
  return formatCount(value);
}

/** A rate the API sends as a fraction (0.453) as "45.3%". */
export function formatRate(rate, places = 1) {
  if (!isNumber(rate)) return '';
  const rounded = Number((rate * 100).toFixed(places));
  return `${rounded}%`;
}

/** A percent the API already sends as a percent (changePercent, dropPercent). */
export function formatPercent(percent, places = 0) {
  if (!isNumber(percent)) return '';
  return `${Number(percent.toFixed(places))}%`;
}

/** Milliseconds as "1 min 20 s". */
export function formatDuration(ms) {
  if (!isNumber(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A calendar day "2026-11-04" as "4 Nov". The day is the server's, so no time zone moves it. */
export function formatDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  return match ? `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}` : '';
}

/** 0 to 23 as "12 am", "1 pm". */
export function formatHour(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return '';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${hour < 12 ? 'am' : 'pm'}`;
}

/**
 * What one figure shows, as a string: the number when the API gave one, else the words for why it didn't.
 * `state` is the contract's FigureState ('ok', 'no_data', 'not_collected', 'below_threshold', 'not_available');
 * a null value with no state, or with 'ok', is "Not available": the app never turns a missing number into 0.
 */
export function figureText(t, value, state = 'ok', format = formatCount) {
  if (state === 'below_threshold') return t(STATE_KEYS.below_threshold);
  if (state && state !== 'ok' && Object.hasOwn(STATE_KEYS, state)) return t(STATE_KEYS[state]);
  if (!isNumber(value)) return t(STATE_KEYS.not_available);
  return format(value);
}

/**
 * What a chart of days shows: { kind: 'chart', values, labels, gaps } with the days that have a number (a day with
 * none is left out, never drawn as 0), or why there is no chart: 'permission' (Permission needed), 'not_available'
 * (the plan or the API has none), 'not_collected' (before the account was connected) or 'no_data'.
 * `days` is [{ day, value, state }]. Fewer than two numbers is not a line.
 */
export function chartOf(days, { permission = 'ok' } = {}) {
  if (permission === 'needed') return { kind: 'permission' };
  const list = Array.isArray(days) ? days : [];
  const points = list.filter((d) => (d.state ?? 'ok') === 'ok' && isNumber(d.value));
  if (points.length >= 2) {
    return { kind: 'chart', values: points.map((d) => d.value), labels: points.map((d) => formatDay(d.day)), gaps: list.length - points.length };
  }
  if (list.length && list.every((d) => d.state === 'not_available')) return { kind: 'not_available' };
  if (list.length && list.every((d) => d.state === 'not_collected')) return { kind: 'not_collected' };
  return { kind: list.length ? 'no_data' : 'not_available' };
}

/** The words for a chart that cannot be drawn. */
export const CHART_KEYS = Object.freeze({
  permission: 'insights.figure.permissionNeeded',
  not_available: 'insights.figure.notAvailable',
  not_collected: 'insights.figure.notCollected',
  no_data: 'insights.figure.noData',
});

/**
 * A change against the period before (the contract's Delta): { key, values } for "Up 12% on the previous period",
 * or null when there is nothing to compare with. A metric the plan or the person's role leaves out is not compared.
 */
export function deltaWords(delta) {
  if (!delta || !isNumber(delta.changePercent)) return null;
  const percent = formatPercent(Math.abs(delta.changePercent));
  if (delta.changePercent > 0) return { key: 'insights.delta.up', values: { percent } };
  if (delta.changePercent < 0) return { key: 'insights.delta.down', values: { percent } };
  return { key: 'insights.delta.same', values: {} };
}

/** True when this person may see money on the analytics screens: owner, manager, or staff holding `orders` (7.10). */
export const showsRevenue = (user) => Boolean(user) && canSeeRevenue(user);

/**
 * A money figure for this person: the formatted paise, or the words for why not. Someone who may not see revenue
 * gets "Owner only." even if a number somehow arrived; a null amount is "Not available", never ₹0.
 */
export function moneyText(t, user, paise, state = 'ok') {
  if (!showsRevenue(user)) return t(STATE_KEYS.hidden);
  return figureText(t, paise, state, formatMoney);
}

/**
 * The busiest hours of a week heatmap: { weekday, hour, value } of the largest cell, or null when every cell is 0
 * or there are none. Weekday 0 is Sunday, as the API sends it.
 */
export function busiest(cells, field = 'sessions') {
  let best = null;
  for (const cell of Array.isArray(cells) ? cells : []) {
    const value = cell?.[field] ?? cell?.value;
    if (isNumber(value) && value > 0 && (!best || value > best.value)) best = { weekday: cell.weekday, hour: cell.hour, value };
  }
  return best;
}

/** The share of each item in a list of { key, value }, largest first, as whole percents that never exceed 100 in all. */
export function shares(items, field = 'value') {
  const list = (Array.isArray(items) ? items : []).filter((i) => isNumber(i?.[field]) && i[field] > 0);
  const total = list.reduce((sum, i) => sum + i[field], 0);
  if (!total) return [];
  return [...list].sort((a, b) => b[field] - a[field]).map((i) => ({ ...i, percent: Math.floor((i[field] * 100) / total) }));
}

/** The query a date range sends: '7', '28' or '90' days, as RangeFields in the contract. */
export const RANGES = Object.freeze(['7', '28', '90']);
export const rangeQuery = (range) => ({ range: RANGES.includes(String(range)) ? String(range) : '28' });

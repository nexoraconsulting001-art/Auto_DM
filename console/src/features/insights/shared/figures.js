import { ANALYTICS_LIMITS as L, CUSTOM_FUNNEL_STEPS, EXPLORE_RATE_METRICS, FIGURE_TEXT, STEPS_NEEDING_TIER_3 } from './catalog.js';
import {
  LINK_MODE_WORDS, LINK_TYPE_WORDS, ORIGIN_WORDS, STAGE_WORDS, WEEKDAY_NAMES, WEEK_ORDER, formatCount, formatDuration, formatHour, formatMoney, formatRate, sourceLabel, wordFor,
} from './words.js';

/** Pure: what the analytics screens decide before they draw anything, so each rule can be tested without a browser. */

// ---- date ranges ---------------------------------------------------------------------------------------------------------

export const RANGE_CHOICES = Object.freeze([
  { value: '7', label: '7 days' },
  { value: '28', label: '28 days' },
  { value: '90', label: '90 days' },
  { value: 'custom', label: 'Custom' },
]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (text) => ISO_DAY.test(String(text ?? '')) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));

/**
 * The range in the address, as the API's RangeQuery. Anything mistyped falls back to 28 days rather than an error page, and a custom
 * range is only sent once it has a start and an end in order, within the 25 months anything is kept.
 */
export function rangeFrom(params, fallback = '28') {
  const get = (name) => (typeof params?.get === 'function' ? params.get(name) : params?.[name]) ?? '';
  const range = get('range');
  if (range === 'custom') {
    const from = get('from');
    const to = get('to');
    if (isDay(from) && isDay(to) && from <= to && (Date.parse(to) - Date.parse(from)) / 86_400_000 <= L.rollupDays) return { range, from, to };
    return { range: fallback };
  }
  return RANGE_CHOICES.some((choice) => choice.value === range && range !== 'custom') ? { range } : { range: fallback };
}

/** Checks a custom range the seller typed, with the words the field shows. */
export function checkCustomRange(from, to) {
  if (!isDay(from)) return { from: 'Choose a start date' };
  if (!isDay(to)) return { to: 'Choose an end date' };
  if (from > to) return { from: 'The start date must be before the end date' };
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > L.rollupDays) return { to: 'Choose a shorter range' };
  return null;
}

/** A preset as two dates, ending yesterday as the API's presets do, for the requests that take dates only (downloads). */
export function rangeDates(query, today = new Date()) {
  if (query.range === 'custom') return { from: query.from, to: query.to };
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (Number(query.range) - 1));
  return { from: iso(start), to: iso(end) };
}

export function rangeWords(query) {
  if (query.range === 'custom') return 'the chosen dates';
  return `the last ${query.range} days`;
}

// ---- account insights ----------------------------------------------------------------------------------------------------

/** The metric to show first, and the order of the rest: views leads, as Instagram's own app does since impressions went. */
const ACCOUNT_ORDER = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'reposts', 'profile_links_taps', 'follows_and_unfollows'];
export function orderMetrics(metrics) {
  const rank = (name) => {
    const at = ACCOUNT_ORDER.indexOf(name);
    return at === -1 ? ACCOUNT_ORDER.length : at;
  };
  return [...(metrics ?? [])].sort((a, b) => rank(a.metric) - rank(b.metric));
}

/** Most recent first, as a seller scrolls a day list. */
export const newestFirst = (days) => [...(days ?? [])].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

/** The latest follower count in the range, and how it moved from the first day that has one. */
export function followerSummary(days) {
  const known = [...(days ?? [])].filter((d) => d.state === 'ok' && typeof d.value === 'number').sort((a, b) => (a.day < b.day ? -1 : 1));
  if (!known.length) return { latest: null, change: null, day: null };
  const latest = known.at(-1);
  return { latest: latest.value, change: known.length > 1 ? latest.value - known[0].value : null, day: latest.day };
}

export const KIND_FILTERS = Object.freeze([
  { value: 'all', label: 'All' },
  { value: 'reel', label: 'Reels' },
  { value: 'feed', label: 'Posts' },
  { value: 'carousel', label: 'Carousels' },
]);

// ---- one post's growth (7.2) ------------------------------------------------------------------------------------------------

export const GROWTH_AGES = Object.freeze([
  { minutes: 60, label: 'After 1 hour' },
  { minutes: 24 * 60, label: 'After 24 hours' },
  { minutes: 7 * 24 * 60, label: 'After 7 days' },
]);

/**
 * The snapshot that stands for each age: the last one taken at or before it, as long as it is at least half that age, so a figure from
 * the first minutes is never shown as "after 7 days". null when there is none.
 */
export function growthAt(growth, ages = GROWTH_AGES) {
  const sorted = [...(growth ?? [])].sort((a, b) => a.ageMinutes - b.ageMinutes);
  return ages.map((age) => {
    let found = null;
    for (const snap of sorted) if (snap.ageMinutes <= age.minutes * 1.25 && snap.ageMinutes >= age.minutes / 2) found = snap;
    return { ...age, snapshot: found };
  });
}

// ---- the Bhava funnel (7.4, 7.15) -----------------------------------------------------------------------------------------

/**
 * One funnel step as the seller reads it. A step Bhava can't measure says why and shows no number; sales in more than one
 * source are listed by source and never added up; a rate over fewer than 20 shows "low volume".
 */
export function funnelStepView(step, { previousStage } = {}) {
  const title = wordFor(STAGE_WORDS, step.stage);
  const money = step.stage === 'sales';
  const origins = (step.origins ?? []).map((o) => ({
    key: `${o.origin}:${o.source}`,
    label: wordFor(ORIGIN_WORDS, o.origin),
    value: money && o.amountPaise ? `${formatCount(o.count)} · ${formatMoney(o.amountPaise)}` : formatCount(o.count),
    source: sourceLabel(o.source),
  }));
  if (step.state === 'not_available') {
    return { title, value: null, note: step.reason || FIGURE_TEXT.notAvailableForLink, source: '', origins: [], unavailable: true, rate: '' };
  }
  const split = step.count === null && origins.length > 0;
  let value = null;
  if (!split) value = typeof step.count === 'number' ? formatCount(step.count) : FIGURE_TEXT.noData;
  const amount = money && typeof step.amountPaise === 'number' ? formatMoney(step.amountPaise) : '';
  let rate = '';
  if (previousStage) rate = step.lowVolume ? FIGURE_TEXT.lowVolume : typeof step.rate === 'number' ? `${formatRate(step.rate, 0)} of ${wordFor(STAGE_RATE_WORDS, previousStage)}` : '';
  return {
    title,
    value,
    amount,
    note: split ? 'From more than one source, so they are listed apart and never added up.' : '',
    source: step.source ? sourceLabel(step.source) : '',
    // One origin is the step itself; the parts are worth listing only when there are several, or when they can't be added up.
    origins: split || origins.length > 1 ? origins : [],
    unavailable: false,
    rate,
  };
}

const STAGE_RATE_WORDS = Object.freeze({ comments: 'comments', dms: 'DMs', seen: 'seen', taps_or_visits: 'taps or visits', sales: 'sales' });

export function funnelSteps(funnel) {
  return (funnel?.steps ?? []).map((step, i, all) => ({ stage: step.stage, ...funnelStepView(step, { previousStage: i > 0 ? all[i - 1].stage : null }) }));
}

/** "Amazon, one tap": what the funnel's gaps are explained by (7.15). */
export function linkWords(funnel) {
  const type = funnel?.linkType ? wordFor(LINK_TYPE_WORDS, funnel.linkType) : '';
  const mode = funnel?.linkMode ? wordFor(LINK_MODE_WORDS, funnel.linkMode) : '';
  if (!type && !mode) return 'No link set up for this post';
  return [type, mode && mode.toLowerCase()].filter(Boolean).join(', ');
}

// ---- Reach Guard (7.6) -----------------------------------------------------------------------------------------------------

export const GUARD_STATE_WORDS = Object.freeze({
  learning: { title: 'Learning your usual reach', tone: 'neutral', badge: 'Learning' },
  normal: { title: 'Reach looks usual', tone: 'good', badge: 'Normal' },
  watch: { title: 'Watching closely', tone: 'warn', badge: 'Watch' },
  tripped: { title: 'Reach has dropped', tone: 'bad', badge: 'Tripped' },
  permission_needed: { title: 'Permission needed', tone: 'warn', badge: 'Permission needed' },
});

/** The words a typed override must match. The server holds the full list; the console asks for the plainest one. */
export const OVERRIDE_WORD = 'override';
export const overrideTyped = (text) => String(text ?? '').trim().toLowerCase() === OVERRIDE_WORD;

/**
 * What the Reach Guard screen offers. The override is the owner's alone, and only while slow mode was started by a drop in reach (PRD 7.6,
 * N-27, N-28). The server checks the same again, so this only decides what is shown.
 */
export function guardView(status, { role } = {}) {
  const state = wordFor(GUARD_STATE_WORDS, status?.state, null) || GUARD_STATE_WORDS.learning;
  const slow = status?.slowMode ?? { active: false, trigger: null, canOverride: false };
  const fromReach = slow.active && slow.trigger === 'reach_drop';
  const isOwner = role === 'owner';
  let overrideNote = '';
  if (slow.active && !fromReach) overrideNote = 'Slow mode can only be overridden when a drop in reach started it.';
  else if (fromReach && !isOwner) overrideNote = 'Only the owner can override slow mode.';
  else if (fromReach && !slow.canOverride) overrideNote = 'Slow mode can’t be overridden right now.';
  return {
    ...state,
    state: status?.state ?? 'learning',
    offerOverride: Boolean(fromReach && slow.canOverride && isOwner),
    overrideNote,
    canEditThresholds: isOwner,
    learning: status?.state === 'learning'
      ? { days: status.settledDays ?? 0, daysNeeded: L.learningMinSettledDays, media: status.mediaCounted ?? 0, mediaNeeded: L.learningMinMedia }
      : null,
  };
}

export const TRIP_WORDS = Object.freeze({ reach_days: 'Daily reach stayed low', media_24h: 'Posts in a row reached fewer people' });

/** Thresholds the owner typed, checked against the limits the API holds (7.6). Returns { body } or { errors }. */
export function thresholdsBody(values, current) {
  const fields = { reachDropPercent: L.reachDropPercent, mediaDropPercent: L.mediaDropPercent, clearPercent: L.clearPercent };
  const body = {};
  const errors = {};
  for (const [name, limits] of Object.entries(fields)) {
    const text = String(values?.[name] ?? '').trim();
    if (text === '') {
      errors[name] = 'Enter a number';
      continue;
    }
    const n = Number(text);
    if (!Number.isInteger(n)) errors[name] = 'Use a whole number';
    else if (n < limits.min) errors[name] = `Use ${limits.min} or more`;
    else if (n > limits.max) errors[name] = `Use ${limits.max} or less`;
    else if (!current || current[name] !== n) body[name] = n;
  }
  return Object.keys(errors).length ? { errors } : { body };
}

// ---- Account Health (7.7) --------------------------------------------------------------------------------------------------

export const BAND_WORDS = Object.freeze({ good: { label: 'Good', tone: 'good' }, watch: { label: 'Watch', tone: 'warn' }, at_risk: { label: 'At risk', tone: 'bad' } });
const RECONNECT_CODES = new Set(['token_rejected', 'token_refresh_failed', 'token_3d', 'token_14d', 'scope_missing', 'no_webhooks_72h']);

/** The score, its band, and its deductions worst first (7.7, as the Platform Console sorts them). */
export function healthView(health) {
  const band = health?.band ? wordFor(BAND_WORDS, health.band, null) : null;
  const deductions = [...(health?.deductions ?? [])].sort((a, b) => a.points - b.points || a.code.localeCompare(b.code));
  return {
    score: typeof health?.score === 'number' ? health.score : null,
    band: band || null,
    deductions,
    reconnect: deductions.some((d) => RECONNECT_CODES.has(d.code)) || health?.score === 0,
  };
}

export const pointsText = (points) => (typeof points === 'number' ? (points < 0 ? `${points}` : points === 0 ? '0' : `+${points}`) : '');

// ---- heatmaps (7.5, 7.10) --------------------------------------------------------------------------------------------------

export const HEAT_BLOCK_HOURS = 2;
const BLOCKS = 24 / HEAT_BLOCK_HOURS;

/**
 * Weekday by two-hour block, Monday first, with a level 0 to 4 for the colour. combine 'sum' for counts (sessions), 'mean' for averages
 * (average reach), so two hours of averages are never added together. Returns the rows and the busiest block.
 */
export function heatmap(cells, { value = 'value', combine = 'sum' } = {}) {
  const totals = new Map();
  for (const cell of cells ?? []) {
    if (!Number.isInteger(cell.weekday) || !Number.isInteger(cell.hour) || cell.weekday < 0 || cell.weekday > 6 || cell.hour < 0 || cell.hour > 23) continue;
    const n = Number(cell[value]);
    if (!Number.isFinite(n)) continue;
    const key = `${cell.weekday}:${Math.floor(cell.hour / HEAT_BLOCK_HOURS)}`;
    const t = totals.get(key) ?? { sum: 0, count: 0 };
    t.sum += n;
    t.count += 1;
    totals.set(key, t);
  }
  const valueOf = (key) => {
    const t = totals.get(key);
    if (!t) return 0;
    return combine === 'mean' ? t.sum / t.count : t.sum;
  };
  let peak = null;
  let max = 0;
  for (const weekday of WEEK_ORDER) {
    for (let block = 0; block < BLOCKS; block++) {
      const v = valueOf(`${weekday}:${block}`);
      if (v > max) {
        max = v;
        peak = { weekday, block, value: v };
      }
    }
  }
  const level = (v) => (v <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  const rows = WEEK_ORDER.map((weekday) => ({
    weekday,
    label: WEEKDAY_NAMES[weekday].slice(0, 3),
    cells: Array.from({ length: BLOCKS }, (_, block) => {
      const v = valueOf(`${weekday}:${block}`);
      return { block, value: v, level: level(v), label: `${WEEKDAY_NAMES[weekday]} ${blockWords(block)}` };
    }),
  }));
  return { rows, peak: peak ? { ...peak, label: `${WEEKDAY_NAMES[peak.weekday]} ${blockWords(peak.block)}` } : null, empty: max <= 0 };
}

export function blockWords(block) {
  const start = block * HEAT_BLOCK_HOURS;
  const end = (start + HEAT_BLOCK_HOURS) % 24;
  return `${formatHour(start).replace(' ', '')} to ${formatHour(end).replace(' ', '')}`;
}

/** The single best hour from the API's cells, in the business's own time zone, for the "Suggested" line (7.5). */
export function bestHour(cells) {
  let best = null;
  for (const cell of cells ?? []) if (!best || cell.value > best.value) best = cell;
  return best ? `${WEEKDAY_NAMES[best.weekday]} at ${formatHour(best.hour)}` : '';
}

// ---- charts ----------------------------------------------------------------------------------------------------------------

/**
 * A line through values that may have gaps. Each run of numbers is its own segment, so a day with no data is a break in the line and
 * never a drop to 0. Returns SVG path data and the points, in a box of width by height.
 */
export function linePath(values, { width = 320, height = 96, pad = 6, max: forcedMax } = {}) {
  const numbers = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const max = forcedMax ?? Math.max(1, ...numbers);
  const min = 0;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const x = (i) => Number((pad + i * step).toFixed(1));
  const y = (v) => Number((height - pad - ((v - min) / (max - min || 1)) * (height - pad * 2)).toFixed(1));
  const points = values.map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? { x: x(i), y: y(v), i } : null));
  let d = '';
  let open = false;
  for (const p of points) {
    if (!p) {
      open = false;
      continue;
    }
    d += `${open ? 'L' : 'M'}${p.x} ${p.y} `;
    open = true;
  }
  return { d: d.trim(), points: points.filter(Boolean), max };
}

/** A sentence a screen reader reads in place of the chart. */
export function chartSummary(label, days) {
  const known = (days ?? []).filter((d) => typeof d.value === 'number');
  if (!known.length) return `${label}: no figures for these days yet.`;
  const top = known.reduce((a, b) => (b.value > a.value ? b : a));
  return `${label} per day, ${known.length} of ${days.length} days with figures. Highest ${formatCount(top.value)} on ${top.day}.`;
}

// ---- traffic (7.10) --------------------------------------------------------------------------------------------------------

/** The summary tiles, in the order of the mockup. `money` and `time` say how the figure is written. */
export const TRAFFIC_TILES = Object.freeze([
  { key: 'visitors', label: 'Unique visitors' },
  { key: 'newVisitors', label: 'New visitors' },
  { key: 'returningVisitors', label: 'Returning visitors' },
  { key: 'pageViews', label: 'Page views' },
  { key: 'productTaps', label: 'Product taps' },
  { key: 'outboundTaps', label: 'Outbound link taps' },
  { key: 'whatsappTaps', label: 'WhatsApp taps' },
  { key: 'addToCart', label: 'Add to cart', revenue: false },
  { key: 'checkoutStarted', label: 'Checkout started' },
  { key: 'orders', label: 'Orders', revenue: true },
  { key: 'revenuePaise', label: 'Revenue', revenue: true, money: true },
  { key: 'bounceRate', label: 'Bounce rate', rate: true },
  { key: 'medianEngagedMs', label: 'Median engaged time', time: true },
]);

/** One tile: hidden for a role without revenue access, "not in your plan" when the plan leaves it out, otherwise the figure and its change. */
export function trafficTile(tile, summary, { canSeeRevenue = true } = {}) {
  if (tile.revenue && !canSeeRevenue) return null;
  const delta = summary?.[tile.key];
  if ((summary?.notIncluded ?? []).includes(tile.key)) return { ...tile, value: 'Not in your plan', change: '', included: false };
  const format = tile.money ? formatMoney : tile.rate ? (v) => formatRate(v, 0) : tile.time ? formatDuration : formatCount;
  const value = typeof delta?.value === 'number' ? format(delta.value) : FIGURE_TEXT.noData;
  let change = '';
  if (typeof delta?.changePercent === 'number') change = `${delta.changePercent > 0 ? '+' : ''}${Math.round(delta.changePercent)}%`;
  return { ...tile, value, change, included: true, direction: typeof delta?.changePercent === 'number' ? Math.sign(delta.changePercent) : 0 };
}

/** Shares of a list of counts, for bar widths and "34%" labels. */
export function shares(items, key) {
  const total = (items ?? []).reduce((sum, item) => sum + (Number(item[key]) || 0), 0);
  return (items ?? []).map((item) => ({ ...item, share: total > 0 ? (Number(item[key]) || 0) / total : 0 }));
}

// ---- Explore (7.11) --------------------------------------------------------------------------------------------------------

export const COMPARE_CHOICES = Object.freeze([
  { value: 'none', label: 'No comparison' },
  { value: 'previous', label: 'Previous period' },
  { value: 'last_year', label: 'Same time last year' },
  { value: 'custom', label: 'Dates I choose' },
]);

/** The comparison as the API takes it. Dates I choose need both dates in order; until then there is no comparison rather than an error. */
function compareOf(form) {
  if (form.compare === 'custom') return checkCustomRange(form.compareFrom, form.compareTo) ? { compare: 'none' } : { compare: 'custom', compareFrom: form.compareFrom, compareTo: form.compareTo };
  return { compare: COMPARE_CHOICES.some((c) => c.value === form.compare) ? form.compare : 'none' };
}

/**
 * The Explore form as an ExploreRequest body. Only catalogue names pass, at most two different breakdowns, and only filters with a value:
 * nothing a seller types can become a visitor id or a column of its own (7.11).
 */
export function exploreBody(form, { metricNames, dimensionNames }) {
  const metrics = [...new Set(form.metrics ?? [])].filter((m) => metricNames.includes(m)).slice(0, 12);
  const dimensions = [...new Set((form.dimensions ?? []).filter(Boolean))].filter((d) => dimensionNames.includes(d)).slice(0, L.exploreMaxBreakdowns);
  const filters = (form.filters ?? [])
    .filter((f) => dimensionNames.includes(f.dimension) && ['include', 'exclude'].includes(f.op))
    .map((f) => ({ dimension: f.dimension, op: f.op, values: [...new Set(String(f.value ?? '').split(',').map((v) => v.trim()).filter(Boolean))].slice(0, 50) }))
    .filter((f) => f.values.length);
  const thresholds = (form.thresholds ?? [])
    .filter((t) => metricNames.includes(t.metric) && ['gte', 'lte'].includes(t.op) && String(t.value ?? '').trim() !== '' && Number.isFinite(Number(t.value)) && Number(t.value) >= 0)
    .map((t) => ({ metric: t.metric, op: t.op, value: Number(t.value) }))
    .slice(0, 3);
  const range = rangeFrom(form);
  const body = { metrics, dimensions, filters, thresholds, ...range, ...compareOf(form), chart: ['table', 'line', 'bar'].includes(form.chart) ? form.chart : 'table', sortDirection: form.sortDirection === 'asc' ? 'asc' : 'desc' };
  if (form.sortBy && (metrics.includes(form.sortBy) || dimensions.includes(form.sortBy))) body.sortBy = form.sortBy;
  return body;
}

/** A saved view's definition back into the form, keeping only what the catalogue still has. */
export function exploreForm(definition = {}) {
  return {
    metrics: Array.isArray(definition.metrics) ? definition.metrics.filter((m) => typeof m === 'string') : ['sessions'],
    dimensions: Array.isArray(definition.dimensions) ? definition.dimensions.filter((d) => typeof d === 'string') : [],
    filters: Array.isArray(definition.filters) ? definition.filters.map((f) => ({ dimension: f.dimension, op: f.op, value: (f.values ?? []).join(', ') })) : [],
    thresholds: Array.isArray(definition.thresholds) ? definition.thresholds.map((t) => ({ metric: t.metric, op: t.op, value: String(t.value) })) : [],
    range: definition.range ?? '28',
    from: definition.from ?? '',
    to: definition.to ?? '',
    compare: definition.compare ?? 'none',
    compareFrom: definition.compareFrom ?? '',
    compareTo: definition.compareTo ?? '',
    chart: definition.chart ?? 'table',
    sortBy: definition.sortBy ?? '',
    sortDirection: definition.sortDirection ?? 'desc',
  };
}

/** One Explore cell as text. Revenue metrics are paise, rates are fractions, and a rate with a small denominator says "low volume". */
export function exploreCell(metric, cell) {
  if (!cell) return { value: FIGURE_TEXT.noData, change: '' };
  if (cell.lowVolume) return { value: FIGURE_TEXT.lowVolume, change: '' };
  const format = metric === 'revenue_paise' || metric === 'revenue_per_session' ? formatMoney
    : EXPLORE_RATE_METRICS.includes(metric) ? (v) => formatRate(v, 1)
      : metric === 'median_engaged_ms' || metric === 'ig_avg_watch_ms' ? formatDuration
        : metric === 'ig_skip_rate_bp' ? (v) => formatRate(v / 10_000, 1)
          : formatCount;
  const value = typeof cell.value === 'number' ? format(cell.value) : FIGURE_TEXT.noData;
  let change = '';
  if (typeof cell.changePercent === 'number') change = `${cell.changePercent > 0 ? '+' : ''}${Number(cell.changePercent.toFixed(1))}%`;
  else if (typeof cell.change === 'number' && cell.change !== 0) change = `${cell.change > 0 ? '+' : ''}${format(Math.abs(cell.change)).replace(/^/, cell.change < 0 ? '-' : '')}`;
  return { value, change };
}

// ---- custom funnels (7.12) -------------------------------------------------------------------------------------------------

export const FUNNEL_STEP_WORDS = Object.freeze({
  landing_view: 'Landing page view', category_view: 'Category view', product_view: 'Product view', product_tap: 'Product tap', outbound_click: 'Outbound click',
  whatsapp_tap: 'WhatsApp tap', add_to_cart: 'Add to cart', checkout_started: 'Checkout started', payment_success: 'Payment success', page_view: 'A page you choose',
});
export const stepNeedsTier3 = (kind) => STEPS_NEEDING_TIER_3.includes(kind);

/** The funnel form as a CustomFunnelInput, or the words for what is wrong, before anything is sent. */
export function funnelBody(form) {
  const errors = {};
  const name = String(form.name ?? '').trim();
  if (!name) errors.name = 'Name this funnel';
  else if (name.length > 80) errors.name = 'Use 80 characters or fewer';
  const steps = (form.steps ?? []).map((s) => ({ kind: s.kind, ...(s.kind === 'page_view' ? { page: String(s.page ?? '').trim() } : {}) }));
  if (steps.length < L.funnelMinSteps) errors.steps = `Add at least ${L.funnelMinSteps} steps`;
  else if (steps.length > L.funnelMaxSteps) errors.steps = `Use at most ${L.funnelMaxSteps} steps`;
  else if (steps.some((s) => !CUSTOM_FUNNEL_STEPS.includes(s.kind))) errors.steps = 'Choose each step from the list';
  else if (steps.some((s) => s.kind === 'page_view' && !s.page)) errors.steps = 'Choose the page for each page view step';
  const minutes = Number(form.windowMinutes);
  if (!Number.isInteger(minutes) || minutes < L.funnelMinWindowMinutes || minutes > L.funnelMaxWindowMinutes) errors.windowMinutes = `Use ${L.funnelMinWindowMinutes} minutes to ${L.funnelMaxWindowMinutes / 1440} days`;
  if (Object.keys(errors).length) return { errors };
  return { body: { name, steps, countBy: form.countBy === 'visitor' ? 'visitor' : 'session', windowMinutes: minutes } };
}

export const WINDOW_CHOICES = Object.freeze([
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 1440, label: '1 day' },
  { value: 4320, label: '3 days' },
  { value: 10080, label: '7 days' },
]);
export const windowWords = (minutes) => WINDOW_CHOICES.find((w) => w.value === minutes)?.label ?? `${minutes} minutes`;

// ---- pixels and tags (7.14) ------------------------------------------------------------------------------------------------

/**
 * The tag form as a TagSettingsUpdate: only what changed, and a token or secret only when one was typed, since the API never sends a saved
 * one back. Returns { body } or { errors }.
 */
export function tagsBody(form, current) {
  const errors = {};
  const body = {};
  const meta = {};
  const ga4 = {};
  const pixelId = String(form.pixelId ?? '').trim();
  const capiToken = String(form.capiToken ?? '').trim();
  const measurementId = String(form.measurementId ?? '').trim().toUpperCase();
  const apiSecret = String(form.apiSecret ?? '').trim();
  if (pixelId && !/^\d{5,20}$/.test(pixelId)) errors.pixelId = 'Enter the Pixel ID: 5 to 20 digits';
  if (capiToken && (capiToken.length < 10 || capiToken.length > 400)) errors.capiToken = 'Paste the whole Conversions API token';
  if (measurementId && !/^G-[A-Z0-9]{4,20}$/.test(measurementId)) errors.measurementId = 'Enter the measurement ID, starting G-';
  if (apiSecret && (apiSecret.length < 10 || apiSecret.length > 200)) errors.apiSecret = 'Paste the whole API secret';
  if (form.metaEnabled && !pixelId && !current?.meta?.pixelId) errors.pixelId = 'Enter the Pixel ID to turn this on';
  if (form.ga4Enabled && !measurementId && !current?.ga4?.measurementId) errors.measurementId = 'Enter the measurement ID to turn this on';
  if (Object.keys(errors).length) return { errors };
  if (Boolean(form.metaEnabled) !== Boolean(current?.meta?.enabled)) meta.enabled = Boolean(form.metaEnabled);
  if (pixelId && pixelId !== current?.meta?.pixelId) meta.pixelId = pixelId;
  if (capiToken) meta.capiToken = capiToken;
  if (Boolean(form.ga4Enabled) !== Boolean(current?.ga4?.enabled)) ga4.enabled = Boolean(form.ga4Enabled);
  if (measurementId && measurementId !== current?.ga4?.measurementId) ga4.measurementId = measurementId;
  if (apiSecret) ga4.apiSecret = apiSecret;
  if (Object.keys(meta).length) body.meta = meta;
  if (Object.keys(ga4).length) body.ga4 = ga4;
  return { body };
}

// ---- downloads and reports (7.9, 7.13) ------------------------------------------------------------------------------------

/** The summary files a seller can make here. Each is a summary: none lists single visits or shoppers, by design (7.13, N-81). */
export const SUMMARY_FILES = Object.freeze([
  { source: 'account_daily', label: 'Account figures by day', detail: 'Views, reach and followers for each day. From Instagram/Facebook.' },
  { source: 'media', label: 'Posts and reels', detail: 'Each post’s views, reach and interactions. From Instagram/Facebook.' },
  { source: 'story_finals', label: 'Stories', detail: 'The final figures of each story. From Instagram/Facebook.' },
  { source: 'content_funnel', label: 'Funnel per post', detail: 'Comments, DMs, seen, taps or visits and sales for each post. Measured by Bhava, with each figure’s source.' },
  { source: 'health_history', label: 'Account Health history', detail: 'The score for each day, and what lowered it.' },
]);

export const FORMAT_WORDS = Object.freeze({ csv: 'CSV', xlsx: 'Excel' });

/** A DownloadCreate body for one of the fixed summary files, over a range, or for Explore, a funnel or a cohort. */
export function downloadBody({ source, format = 'csv', range, query, funnelId, cohort }) {
  const body = { source, format: format === 'xlsx' ? 'xlsx' : 'csv' };
  if (source === 'explore') body.query = query;
  else if (source === 'funnel') body.funnelId = funnelId;
  else if (source === 'cohort') body.cohort = cohort;
  else if (range?.from && range?.to) {
    body.from = range.from;
    body.to = range.to;
  }
  return body;
}

export const DOWNLOAD_STATUS_WORDS = Object.freeze({
  queued: { label: 'Waiting', tone: 'neutral' },
  running: { label: 'Making the file', tone: 'neel' },
  ready: { label: 'Ready', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  expired: { label: 'Expired', tone: 'neutral' },
});
export const REPORT_STATUS_WORDS = Object.freeze({
  building: { label: 'Being made', tone: 'neel' },
  sent: { label: 'Sent', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  skipped: { label: 'Not sent', tone: 'neutral' },
});
export const REPORT_KIND_WORDS = Object.freeze({ weekly: 'Weekly summary', monthly: 'Monthly performance report', scheduled: 'Scheduled report' });
export const FREQUENCY_WORDS = Object.freeze({ daily: 'Every day', weekly: 'Every week', monthly: 'Every month' });

/** A schedule as words: "Every Monday at 9 am". */
export function scheduleWords(schedule) {
  const at = formatHour(schedule.hourOfDay);
  if (schedule.frequency === 'daily') return `Every day at ${at}`;
  if (schedule.frequency === 'weekly') return `Every ${WEEKDAY_NAMES[schedule.weekday ?? 1] ?? 'Monday'} at ${at}`;
  return `On day ${schedule.dayOfMonth ?? 1} of each month at ${at}`;
}

/**
 * Only a download that is ready and has a file can be opened, and only on this site: the file route needs the seller signed in here, so a
 * link anywhere else would be wrong. Anything else says what it is waiting for.
 */
export const canOpen = (download) => download?.status === 'ready' && isOwnFile(download.fileUrl);
export const isOwnFile = (url) => typeof url === 'string' && /^\/(?![/\\])/.test(url);

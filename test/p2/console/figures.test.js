// What the Phase 2 console screens decide before they draw: words for every code, figures that aren't numbers, and every request
// they build, checked against the API's own schemas so the console can't send what the server refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYTICS_LIMITS as L, CUSTOM_FUNNEL_STEPS, DEVICE_TYPES, DOWNLOAD_SOURCES, DOWNLOAD_STATUSES, EXPLORE_DIMENSION_NAMES, EXPLORE_METRIC_NAMES, FIGURE_TEXT,
  FUNNEL_ORIGINS, FUNNEL_STAGES, HEALTH_BANDS, IN_APP_BROWSERS, LINK_MODES, LINK_TYPES_MEASURED, REACH_GUARD_STATES, REACH_TRIP_TRIGGERS, REPORT_FREQUENCIES,
  REPORT_KINDS, SOURCE_LABELS, TRAFFIC_SOURCES, VISITOR_TYPES,
} from '../../../src/contracts/analytics.js';
import { RangeQuery } from '../../../src/contracts/api/insights.js';
import { ReachGuardThresholdsUpdate } from '../../../src/contracts/api/reach-guard.js';
import { CustomFunnelInput, DownloadCreate, ExploreQuery, ExploreRequest, SavedViewInput } from '../../../src/contracts/api/reports.js';
import { TagSettingsUpdate } from '../../../src/contracts/api/traffic.js';
import { SLOW_MODE_CONFIRMATIONS } from '../../../src/modules/compliance/api.js';
import * as catalog from '../../../console/src/features/insights/shared/catalog.js';
import {
  BAND_WORDS, COMPARE_CHOICES, DOWNLOAD_STATUS_WORDS, FREQUENCY_WORDS, FUNNEL_STEP_WORDS, GUARD_STATE_WORDS, OVERRIDE_WORD, REPORT_KIND_WORDS, SUMMARY_FILES, TRAFFIC_TILES,
  TRIP_WORDS, canOpen, checkCustomRange, downloadBody, exploreBody, exploreCell, exploreForm, followerSummary, funnelBody, funnelStepView, funnelSteps, growthAt, guardView,
  healthView, heatmap, isOwnFile, linePath, linkWords, overrideTyped, rangeDates, rangeFrom, scheduleWords, shares, tagsBody, thresholdsBody, trafficTile,
} from '../../../console/src/features/insights/shared/figures.js';
import {
  CHANNEL_WORDS, DEVICE_WORDS, IN_APP_WORDS, KIND_WORDS, LINK_MODE_WORDS, LINK_TYPE_WORDS, ORIGIN_WORDS, STAGE_WORDS, STATE_WORDS, TRAFFIC_SOURCE_WORDS, VISITOR_WORDS,
  agoWords, breakdownValue, changeWords, figureText, formatCompact, formatCount, formatDay, formatDuration, formatHour, formatMoney, formatRate, gapNote, humanize,
  mediaMetricRows, mediaMetricText, sourceLabel, wordFor,
} from '../../../console/src/features/insights/shared/words.js';

const names = { metricNames: [...EXPLORE_METRIC_NAMES], dimensionNames: [...EXPLORE_DIMENSION_NAMES] };
const keys = (table) => Object.keys(table).sort();

test('the console\'s copy of the catalogue is the server\'s, value for value', async () => {
  const server = await import('../../../src/contracts/analytics.js');
  const derived = { EXPLORE_RATE_METRICS: Object.entries(server.EXPLORE_METRICS).filter(([, def]) => def.rate).map(([name]) => name) };
  for (const [name, value] of Object.entries(catalog)) {
    const expected = Object.hasOwn(derived, name) ? derived[name] : server[name];
    assert.notEqual(expected, undefined, `${name} is not in src/contracts/analytics.js`);
    if (name === 'ANALYTICS_LIMITS') {
      // Every limit the console holds is the server's; the one about keeping single events is left out, as no console text may name it.
      for (const [key, limit] of Object.entries(value)) assert.deepEqual(limit, expected[key], `ANALYTICS_LIMITS.${key}`);
      assert.deepEqual(Object.keys(expected).filter((key) => !Object.hasOwn(value, key)), ['rawEventDays']);
    } else {
      assert.deepEqual(value, expected, name);
    }
  }
  assert.ok(Object.keys(catalog).length >= 25);
});

test('PRD 7.15: the three source labels are the server\'s, and anything else has no label', () => {
  assert.equal(sourceLabel('bhava'), 'Measured by Bhava');
  assert.equal(sourceLabel('platform'), 'From Instagram/Facebook');
  assert.equal(sourceLabel('destination'), 'From the destination');
  assert.deepEqual(Object.values(SOURCE_LABELS).sort(), ['From Instagram/Facebook', 'From the destination', 'Measured by Bhava']);
  assert.equal(sourceLabel('estimate'), '');
  assert.equal(sourceLabel('constructor'), '', 'a name every object inherits is not a label');
});

test('every code the API can send has words, and nothing else does', () => {
  const pairs = [
    [TRAFFIC_SOURCE_WORDS, TRAFFIC_SOURCES], [DEVICE_WORDS, DEVICE_TYPES], [IN_APP_WORDS, IN_APP_BROWSERS], [VISITOR_WORDS, VISITOR_TYPES],
    [STAGE_WORDS, FUNNEL_STAGES], [ORIGIN_WORDS, FUNNEL_ORIGINS], [LINK_TYPE_WORDS, LINK_TYPES_MEASURED], [LINK_MODE_WORDS, LINK_MODES],
    [GUARD_STATE_WORDS, REACH_GUARD_STATES], [TRIP_WORDS, REACH_TRIP_TRIGGERS], [BAND_WORDS, HEALTH_BANDS], [FUNNEL_STEP_WORDS, CUSTOM_FUNNEL_STEPS],
    [DOWNLOAD_STATUS_WORDS, DOWNLOAD_STATUSES], [REPORT_KIND_WORDS, REPORT_KINDS], [FREQUENCY_WORDS, REPORT_FREQUENCIES], [KIND_WORDS, catalog.CONTENT_KINDS],
    [CHANNEL_WORDS, ['instagram', 'facebook']],
  ];
  for (const [table, codes] of pairs) assert.deepEqual(keys(table), [...codes].sort());
});

test('a code the console doesn\'t know shows as itself, and inherited names are never looked up', () => {
  assert.equal(wordFor(TRAFFIC_SOURCE_WORDS, 'carrier_pigeon'), 'carrier_pigeon');
  assert.equal(wordFor(TRAFFIC_SOURCE_WORDS, '__proto__'), '__proto__');
  assert.equal(wordFor(TRAFFIC_SOURCE_WORDS, 'toString'), 'toString');
  assert.equal(wordFor(TRAFFIC_SOURCE_WORDS, undefined, ''), '');
  assert.equal(breakdownValue('source', ''), 'Not known');
  assert.equal(breakdownValue('weekday', '0'), 'Sunday');
  assert.equal(breakdownValue('hour', '20'), '8 pm');
  assert.equal(breakdownValue('date', '2026-11-04'), '4 Nov 2026');
  assert.equal(humanize('CAROUSEL_CONTAINER'), 'Carousel container');
});

// ---- figures that are not numbers ----

test('N-03: an empty day is "No data", never 0, and a day before connecting is "Not collected"', () => {
  assert.equal(figureText(null, 'no_data'), 'No data');
  assert.equal(figureText(0, 'ok'), '0');
  assert.equal(figureText(null, 'not_collected'), FIGURE_TEXT.notCollected);
  assert.equal(figureText(undefined, 'ok'), 'No data', 'a missing number is not shown as one');
  assert.equal(figureText(1234567, 'ok'), '12,34,567', 'Indian grouping');
  assert.equal(gapNote(1), 'Total leaves out 1 day with no data');
  assert.equal(gapNote(3), 'Total leaves out 3 days with no data');
  assert.equal(gapNote(0), '');
  assert.deepEqual(keys(STATE_WORDS), ['below_threshold', 'no_data', 'not_available', 'not_collected']);
});

test('N-11: a story under 5 viewers reads "<5"', () => {
  assert.equal(figureText(null, 'below_threshold'), '<5');
  assert.equal(FIGURE_TEXT.belowFive, '<5');
});

test('money is integer paise, rates arrive as fractions, and watch time in milliseconds', () => {
  assert.equal(formatMoney(129900), '₹1,299');
  assert.equal(formatMoney(49950), '₹499.50');
  assert.equal(formatMoney(null), '');
  assert.equal(formatRate(0.45), '45%');
  assert.equal(formatRate(0.3333), '33.3%');
  assert.equal(formatRate(1 / 3, 0), '33%');
  assert.equal(formatDuration(8300), '8 s');
  assert.equal(formatDuration(83_000), '1 min 23 s');
  assert.equal(formatCompact(12_400), '12.4K');
  assert.equal(formatCompact(2_50_000), '2.5 L');
  assert.equal(formatCount(Number.NaN), '');
  assert.equal(formatHour(0), '12 am');
  assert.equal(formatHour(12), '12 pm');
  assert.equal(formatHour(24), '');
  assert.equal(formatDay('2026-02-30x'), '');
  assert.equal(changeWords(12.4), 'Up 12% vs the previous period');
  assert.equal(changeWords(-3), 'Down 3% vs the previous period');
  assert.equal(changeWords(null), '');
  assert.equal(agoWords('2026-11-10T10:00:00Z', Date.parse('2026-11-10T10:05:30Z')), '5 min ago');
  assert.equal(agoWords('nonsense'), '');
});

test('a post\'s figures: watch time is a duration, skip rate a percent, views say they replace impressions', () => {
  assert.equal(mediaMetricText('ig_reels_avg_watch_time', 8300), '8 s');
  assert.equal(mediaMetricText('reels_skip_rate', 31.5), '31.5%');
  assert.equal(mediaMetricText('reach', null), 'No data');
  const rows = mediaMetricRows({ reach: 10, views: 20, brand_new_metric: 3 });
  assert.deepEqual(rows.map((r) => r.name), ['views', 'reach', 'brand_new_metric']);
  assert.equal(rows[0].label, 'Views (replaces impressions)');
  assert.equal(rows[2].label, 'Brand new metric');
});

test('PRD 7.2: growth at 1 hour, 24 hours and 7 days uses the right snapshot, and never an early one for a later age', () => {
  const growth = [
    { ageMinutes: 55, metrics: { views: 10 } },
    { ageMinutes: 180, metrics: { views: 50 } },
    { ageMinutes: 1440, metrics: { views: 300 } },
  ];
  const [hour, day, week] = growthAt(growth);
  assert.equal(hour.snapshot.metrics.views, 10);
  assert.equal(day.snapshot.metrics.views, 300);
  assert.equal(week.snapshot, null, 'a day-old snapshot is not "after 7 days"');
});

test('followers: the latest count and how it moved, from days that have one', () => {
  const days = [{ day: '2026-11-01', value: 100, state: 'ok' }, { day: '2026-11-02', value: null, state: 'no_data' }, { day: '2026-11-03', value: 130, state: 'ok' }];
  assert.deepEqual(followerSummary(days), { latest: 130, change: 30, day: '2026-11-03' });
  assert.deepEqual(followerSummary([]), { latest: null, change: null, day: null });
});

// ---- date ranges ----

test('a range in the address becomes a RangeQuery the API accepts, and anything mistyped is 28 days', () => {
  const params = (q) => new URLSearchParams(q);
  for (const query of [rangeFrom(params('range=7')), rangeFrom(params('range=90')), rangeFrom(params('')), rangeFrom(params('range=custom&from=2026-10-01&to=2026-10-31'))]) {
    assert.equal(RangeQuery.safeParse(query).success, true, JSON.stringify(query));
  }
  assert.deepEqual(rangeFrom(params('range=365')), { range: '28' });
  assert.deepEqual(rangeFrom(params('range=custom&from=2026-10-31&to=2026-10-01')), { range: '28' }, 'reversed');
  assert.deepEqual(rangeFrom(params('range=custom&from=2020-01-01&to=2026-10-01')), { range: '28' }, 'longer than anything is kept');
  assert.deepEqual(rangeFrom(params('range=custom&from=2026-13-01&to=2026-10-01')), { range: '28' });
  assert.deepEqual(rangeFrom(params('range=7'), '28'), { range: '7' });
  assert.deepEqual(rangeFrom({ range: 'custom', from: '2026-10-01', to: '2026-10-05' }), { range: 'custom', from: '2026-10-01', to: '2026-10-05' }, 'a plain object works too');
});

test('a custom range says what is wrong with it in the field\'s own words', () => {
  assert.deepEqual(checkCustomRange('', '2026-10-01'), { from: 'Choose a start date' });
  assert.deepEqual(checkCustomRange('2026-10-01', ''), { to: 'Choose an end date' });
  assert.deepEqual(checkCustomRange('2026-10-05', '2026-10-01'), { from: 'The start date must be before the end date' });
  assert.equal(checkCustomRange('2026-10-01', '2026-10-05'), null);
});

test('a preset as dates ends yesterday', () => {
  assert.deepEqual(rangeDates({ range: '7' }, new Date(2026, 10, 11, 15)), { from: '2026-11-04', to: '2026-11-10' });
  assert.deepEqual(rangeDates({ range: 'custom', from: '2026-01-01', to: '2026-01-31' }), { from: '2026-01-01', to: '2026-01-31' });
});

// ---- the Bhava funnel ----

const step = (stage, extra = {}) => ({ stage, count: 0, amountPaise: null, source: 'bhava', state: 'ok', reason: null, rate: null, lowVolume: false, origins: [], ...extra });

test('N-14, N-79: a step that can\'t be measured shows why and no number, never an estimate', () => {
  const view = funnelStepView(step('taps_or_visits', { count: null, source: null, state: 'not_available', reason: FIGURE_TEXT.notAvailableForLink }), { previousStage: 'seen' });
  assert.equal(view.unavailable, true);
  assert.equal(view.value, null);
  assert.equal(view.note, 'not available for this link type');
  assert.equal(view.source, '');
  assert.equal(view.rate, '');
});

test('N-14: each counted step carries its source label and its rate from the step before', () => {
  const steps = funnelSteps({ steps: [step('comments', { count: 40 }), step('dms', { count: 38, rate: 0.95 }), step('seen', { count: 30, rate: 0.7895 })] });
  assert.deepEqual(steps.map((s) => s.value), ['40', '38', '30']);
  assert.deepEqual(steps.map((s) => s.source), ['Measured by Bhava', 'Measured by Bhava', 'Measured by Bhava']);
  assert.equal(steps[0].rate, '', 'the first step has no step before it');
  assert.equal(steps[1].rate, '95% of comments');
  assert.equal(steps[2].rate, '79% of DMs');
});

test('PRD 7.4: a rate over fewer than 20 shows "low volume"', () => {
  const view = funnelStepView(step('dms', { count: 5, lowVolume: true }), { previousStage: 'comments' });
  assert.equal(view.rate, 'low volume');
});

test('PRD 7.15: sales from different sources are listed apart and never added up', () => {
  const view = funnelStepView(step('sales', {
    count: null,
    source: null,
    origins: [{ origin: 'bhava_store', count: 2, amountPaise: 99800, source: 'bhava' }, { origin: 'amazon', count: 1, amountPaise: 4500, source: 'destination' }],
  }), { previousStage: 'taps_or_visits' });
  assert.equal(view.value, null, 'no total across sources');
  assert.match(view.note, /never added up/);
  assert.deepEqual(view.origins.map((o) => [o.label, o.value, o.source]), [['Store orders', '2 · ₹998', 'Measured by Bhava'], ['Amazon earnings', '1 · ₹45', 'From the destination']]);
});

test('N-14: the link type and mode explain the gaps: "Amazon, one tap"', () => {
  assert.equal(linkWords({ linkType: 'amazon', linkMode: 'one_tap' }), 'Amazon, one tap');
  assert.equal(linkWords({ linkType: 'bhava_page', linkMode: 'two_tap' }), 'Your store page, two taps');
  assert.equal(linkWords({ linkType: null, linkMode: null }), 'No link set up for this post');
});

// ---- Reach Guard ----

const guard = (changes = {}) => ({
  state: 'tripped', since: null, message: 'Reach is down 45% vs your usual.', settledDays: 28, mediaCounted: 10, baselineReach: 10000,
  thresholds: { reachDropPercent: 60, mediaDropPercent: 50, clearPercent: 80 }, trip: null,
  slowMode: { active: true, trigger: 'reach_drop', until: null, canOverride: true, restoring: false }, lastEvaluatedAt: null, ...changes,
});

test('PRD 7.6: only the owner is offered the override, and only while a drop in reach started slow mode', () => {
  assert.equal(guardView(guard(), { role: 'owner' }).offerOverride, true);
  const manager = guardView(guard(), { role: 'manager' });
  assert.equal(manager.offerOverride, false, 'N-27');
  assert.equal(manager.overrideNote, 'Only the owner can override slow mode.');
  const throttled = guardView(guard({ state: 'watch', slowMode: { active: true, trigger: 'buc_80002', until: null, canOverride: false, restoring: false } }), { role: 'owner' });
  assert.equal(throttled.offerOverride, false, 'N-28');
  assert.match(throttled.overrideNote, /only be overridden when a drop in reach started it/);
  const denied = guardView(guard({ state: 'permission_needed', slowMode: { active: true, trigger: 'insights_denied', until: null, canOverride: false, restoring: false } }), { role: 'owner' });
  assert.equal(denied.offerOverride, false);
  assert.equal(guardView(guard({ slowMode: { active: false, trigger: null, until: null, canOverride: false, restoring: false } }), { role: 'owner' }).overrideNote, '');
  assert.equal(guardView(guard(), { role: 'owner' }).canEditThresholds, true);
  assert.equal(guardView(guard(), { role: 'manager' }).canEditThresholds, false);
});

test('N-25: Learning shows how far along it is, and every state has a title and a tone', () => {
  const view = guardView(guard({ state: 'learning', settledDays: 6, mediaCounted: 2 }), { role: 'owner' });
  assert.deepEqual(view.learning, { days: 6, daysNeeded: L.learningMinSettledDays, media: 2, mediaNeeded: L.learningMinMedia });
  assert.equal(guardView(guard({ state: 'normal' })).learning, null);
  for (const state of REACH_GUARD_STATES) assert.ok(guardView(guard({ state })).title, state);
  assert.equal(guardView(guard({ state: 'brand_new' })).title, GUARD_STATE_WORDS.learning.title, 'an unknown state never claims all is well');
});

test('PRD 7.6: the copy never says "shadowban" or "safe"', () => {
  const words = JSON.stringify([GUARD_STATE_WORDS, TRIP_WORDS, guardView(guard(), { role: 'manager' }), guardView(guard({ state: 'watch', slowMode: { active: true, trigger: 'buc_80002', canOverride: false } }))]);
  assert.doesNotMatch(words, /shadow.?ban|\bsafe\b/i);
});

test('the typed override word is one the server accepts, typed loosely', () => {
  assert.ok(SLOW_MODE_CONFIRMATIONS.includes(OVERRIDE_WORD));
  assert.equal(overrideTyped('  Override '), true);
  assert.equal(overrideTyped('overrid'), false);
  assert.equal(overrideTyped(''), false);
  assert.equal(overrideTyped(null), false);
});

test('thresholds the owner types are checked against the limits, and only changes are sent', () => {
  const current = { reachDropPercent: 60, mediaDropPercent: 50, clearPercent: 80 };
  const { body } = thresholdsBody({ reachDropPercent: '70', mediaDropPercent: '50', clearPercent: '80' }, current);
  assert.deepEqual(body, { reachDropPercent: 70 });
  assert.equal(ReachGuardThresholdsUpdate.safeParse(body).success, true);
  const { errors } = thresholdsBody({ reachDropPercent: String(L.reachDropPercent.max + 1), mediaDropPercent: '29', clearPercent: '80.5' }, current);
  assert.deepEqual(errors, { reachDropPercent: `Use ${L.reachDropPercent.max} or less`, mediaDropPercent: `Use ${L.mediaDropPercent.min} or more`, clearPercent: 'Use a whole number' });
  assert.deepEqual(thresholdsBody({ reachDropPercent: '', mediaDropPercent: '50', clearPercent: '80' }, current).errors, { reachDropPercent: 'Enter a number' });
});

// ---- Account Health ----

test('PRD 7.7: deductions are listed worst first, and a rejected token offers a reconnect', () => {
  const view = healthView({ score: 0, band: 'at_risk', deductions: [{ code: 'usage_75', points: -10, message: 'a', fix: 'b' }, { code: 'token_rejected', points: -100, message: 'c', fix: 'Reconnect Instagram' }], computedAt: null });
  assert.deepEqual(view.deductions.map((d) => d.code), ['token_rejected', 'usage_75']);
  assert.equal(view.reconnect, true);
  assert.equal(view.band.label, 'At risk');
  assert.equal(healthView({ score: 92, band: 'good', deductions: [], computedAt: null }).reconnect, false);
  assert.equal(healthView({ score: null, band: null, deductions: [], computedAt: null }).score, null);
  assert.deepEqual(Object.values(BAND_WORDS).map((b) => b.label), ['Good', 'Watch', 'At risk']);
});

// ---- heatmaps and charts ----

test('the heatmap runs Monday to Sunday in two-hour blocks, adds counts and averages averages', () => {
  const cells = [{ weekday: 0, hour: 20, sessions: 5 }, { weekday: 0, hour: 21, sessions: 7 }, { weekday: 1, hour: 9, sessions: 3 }, { weekday: 9, hour: 2, sessions: 99 }, { weekday: 1, hour: 'x', sessions: 99 }];
  const sum = heatmap(cells, { value: 'sessions', combine: 'sum' });
  assert.deepEqual(sum.rows.map((r) => r.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(sum.rows[0].cells.length, 12);
  assert.equal(sum.rows[6].cells[10].value, 12, 'Sunday 8 pm to 10 pm adds both hours');
  assert.equal(sum.rows[6].cells[10].level, 4);
  assert.equal(sum.peak.label, 'Sunday 8pm to 10pm');
  const mean = heatmap([{ weekday: 0, hour: 20, value: 100 }, { weekday: 0, hour: 21, value: 300 }], { combine: 'mean' });
  assert.equal(mean.rows[6].cells[10].value, 200, 'two hours of average reach are averaged, not added');
  assert.equal(heatmap([]).empty, true);
  assert.equal(heatmap([]).peak, null);
});

test('a day with no data is a gap in the line, not a drop to 0', () => {
  const { d, points } = linePath([10, null, 20, 30]);
  assert.equal((d.match(/M/g) ?? []).length, 2, 'two separate runs');
  assert.equal(points.length, 3);
  assert.equal(linePath([null, null]).d, '');
  assert.equal(linePath([0, 0]).points.length, 2, 'a real 0 is drawn');
});

// ---- traffic ----

const delta = (value, changePercent = null) => ({ value, previous: null, change: null, changePercent });
const summary = (changes = {}) => ({
  source: 'bhava', sessions: delta(81), visitors: delta(60), newVisitors: delta(50), returningVisitors: delta(10), pageViews: delta(200), productTaps: delta(34, 12.5),
  outboundTaps: delta(0), whatsappTaps: delta(0), addToCart: delta(null), checkoutStarted: delta(null), orders: delta(9), revenuePaise: delta(539100), bounceRate: delta(0.42),
  medianEngagedMs: delta(41_000), previews: 3, notIncluded: [], lastUpdatedAt: null, ...changes,
});

test('traffic tiles: a role without revenue access sees no orders or revenue, and a plan without a figure says so', () => {
  const tile = (key, user) => trafficTile(TRAFFIC_TILES.find((t) => t.key === key), summary({ notIncluded: ['addToCart'] }), user);
  assert.equal(tile('revenuePaise', { canSeeRevenue: false }), null);
  assert.equal(tile('orders', { canSeeRevenue: false }), null);
  assert.equal(tile('revenuePaise', { canSeeRevenue: true }).value, '₹5,391');
  assert.equal(tile('addToCart', { canSeeRevenue: true }).value, 'Not in your plan');
  assert.equal(tile('checkoutStarted', { canSeeRevenue: true }).value, 'No data');
  assert.equal(tile('bounceRate', { canSeeRevenue: true }).value, '42%');
  assert.equal(tile('medianEngagedMs', { canSeeRevenue: true }).value, '41 s');
  assert.equal(tile('productTaps', { canSeeRevenue: true }).change, '+13%');
  assert.deepEqual(shares([{ n: 1 }, { n: 3 }], 'n').map((s) => s.share), [0.25, 0.75]);
  assert.deepEqual(shares([{ n: 0 }], 'n').map((s) => s.share), [0]);
});

// ---- Explore ----

test('N-51: the Explore form becomes a request the API accepts, with only catalogue names', () => {
  const body = exploreBody({
    metrics: ['sessions', 'orders', 'sessions', 'visitor_id'],
    dimensions: ['source', 'device', 'city'],
    filters: [{ dimension: 'city', op: 'include', value: 'Pune, Mumbai ,, Pune' }, { dimension: 'source', op: 'exclude', value: 'direct' }, { dimension: 'ip', op: 'include', value: '1.2.3.4' }, { dimension: 'city', op: 'include', value: ' ' }],
    thresholds: [{ metric: 'sessions', op: 'gte', value: '50' }, { metric: 'sessions', op: 'gte', value: '' }, { metric: 'sessions', op: 'gte', value: '-1' }],
    range: '28',
    compare: 'previous',
    chart: 'pie',
    sortBy: 'visitor_id',
  }, names);
  assert.deepEqual(body.metrics, ['sessions', 'orders']);
  assert.deepEqual(body.dimensions, ['source', 'device'], 'at most two breakdowns');
  assert.deepEqual(body.filters, [{ dimension: 'city', op: 'include', values: ['Pune', 'Mumbai'] }, { dimension: 'source', op: 'exclude', values: ['direct'] }]);
  assert.deepEqual(body.thresholds, [{ metric: 'sessions', op: 'gte', value: 50 }]);
  assert.equal(body.chart, 'table');
  assert.equal(body.sortBy, undefined, 'only a column of the table can sort it');
  assert.equal(body.compare, 'previous');
  assert.equal(ExploreRequest.safeParse(body).success, true, JSON.stringify(ExploreRequest.safeParse(body).error?.issues));
  assert.equal(ExploreRequest.safeParse({ ...body, page: '100' }).success, true);
  assert.equal(SavedViewInput.safeParse({ name: 'Mine', definition: body }).success, true, 'it saves as a view as it is');
  assert.equal(ExploreQuery.safeParse(body).success, true);
});

test('every comparison the form offers is one the API takes; dates I choose only once both are there and in order', () => {
  for (const choice of COMPARE_CHOICES) {
    const body = exploreBody({ metrics: ['sessions'], compare: choice.value, compareFrom: '2025-10-01', compareTo: '2025-10-28' }, names);
    assert.equal(body.compare, choice.value);
    assert.equal(ExploreRequest.safeParse(body).success, true, choice.value);
  }
  assert.equal(exploreBody({ metrics: ['sessions'], compare: 'custom', compareFrom: '2025-10-28', compareTo: '2025-10-01' }, names).compare, 'none');
  assert.equal(exploreBody({ metrics: ['sessions'], compare: 'custom', compareFrom: '', compareTo: '' }, names).compare, 'none');
  const custom = exploreBody({ metrics: ['sessions'], compare: 'custom', compareFrom: '2025-10-01', compareTo: '2025-10-28' }, names);
  assert.deepEqual([custom.compareFrom, custom.compareTo], ['2025-10-01', '2025-10-28']);
  assert.deepEqual(exploreBody(exploreForm(custom), names), custom, 'a saved view compared with chosen dates opens as it was');
});

test('a saved view opens back into the form as it was saved', () => {
  const definition = exploreBody({ metrics: ['sessions'], dimensions: ['city'], filters: [{ dimension: 'source', op: 'exclude', value: 'direct, whatsapp' }], thresholds: [{ metric: 'sessions', op: 'gte', value: '5' }], range: 'custom', from: '2026-10-01', to: '2026-10-31', compare: 'last_year', chart: 'bar' }, names);
  const form = exploreForm(definition);
  assert.deepEqual(exploreBody(form, names), definition);
  assert.deepEqual(exploreForm({}).metrics, ['sessions'], 'a broken definition still opens');
  assert.equal(exploreBody(exploreForm({ compare: 'custom' }), names).compare, 'none', 'chosen dates that are missing mean no comparison, not an error');
});

test('Explore cells: rates as percents, money from paise, low volume as words', () => {
  assert.deepEqual(exploreCell('sessions', { value: 1200, previous: 1000, change: 200, changePercent: 20, lowVolume: false }), { value: '1,200', change: '+20%' });
  assert.equal(exploreCell('revenue_paise', { value: 129900, lowVolume: false }).value, '₹1,299');
  assert.equal(exploreCell('conversion_rate', { value: 0.0425, lowVolume: false }).value, '4.3%');
  assert.equal(exploreCell('conversion_rate', { value: null, lowVolume: true }).value, 'low volume');
  assert.equal(exploreCell('ig_reach', { value: null, lowVolume: false }).value, 'No data');
  assert.equal(exploreCell('median_engaged_ms', { value: 41_000, lowVolume: false }).value, '41 s');
  assert.equal(exploreCell('ig_skip_rate_bp', { value: 3150, lowVolume: false }).value, '31.5%');
  assert.equal(exploreCell('sessions', undefined).value, 'No data');
});

// ---- custom funnels ----

test('PRD 7.12: a funnel needs a name, 2 to 8 steps in the catalogue, a page for a page step, and a window of 30 minutes to 7 days', () => {
  const ok = funnelBody({ name: ' Cart ', steps: [{ kind: 'landing_view' }, { kind: 'page_view', page: ' /r/sale ' }, { kind: 'add_to_cart' }], countBy: 'visitor', windowMinutes: 1440 });
  assert.deepEqual(ok.body, { name: 'Cart', steps: [{ kind: 'landing_view' }, { kind: 'page_view', page: '/r/sale' }, { kind: 'add_to_cart' }], countBy: 'visitor', windowMinutes: 1440 });
  assert.equal(CustomFunnelInput.safeParse(ok.body).success, true);
  assert.equal(funnelBody({ name: '', steps: [{ kind: 'landing_view' }], windowMinutes: 10 }).errors.name, 'Name this funnel');
  assert.equal(funnelBody({ name: 'x', steps: [{ kind: 'landing_view' }], windowMinutes: 60 }).errors.steps, 'Add at least 2 steps');
  assert.equal(funnelBody({ name: 'x', steps: Array.from({ length: 9 }, () => ({ kind: 'page_view', page: '/' })), windowMinutes: 60 }).errors.steps, 'Use at most 8 steps');
  assert.equal(funnelBody({ name: 'x', steps: [{ kind: 'landing_view' }, { kind: 'page_view', page: '' }], windowMinutes: 60 }).errors.steps, 'Choose the page for each page view step');
  assert.equal(funnelBody({ name: 'x', steps: [{ kind: 'landing_view' }, { kind: 'raw_events' }], windowMinutes: 60 }).errors.steps, 'Choose each step from the list');
  assert.ok(funnelBody({ name: 'x', steps: [{ kind: 'landing_view' }, { kind: 'add_to_cart' }], windowMinutes: 10 }).errors.windowMinutes);
  assert.ok(funnelBody({ name: 'x', steps: [{ kind: 'landing_view' }, { kind: 'add_to_cart' }], windowMinutes: 7 * 1440 + 1 }).errors.windowMinutes);
});

// ---- pixels and tags ----

test('PRD 7.14: the tag form sends only what changed, and a token or secret only when one is typed', () => {
  const current = { available: true, consentReady: false, meta: { enabled: false, pixelId: '', capiTokenSet: false }, ga4: { enabled: false, measurementId: '', apiSecretSet: false } };
  const first = tagsBody({ metaEnabled: true, pixelId: '123456789', capiToken: 'token-1234567890', ga4Enabled: false, measurementId: '', apiSecret: '' }, current);
  assert.deepEqual(first.body, { meta: { enabled: true, pixelId: '123456789', capiToken: 'token-1234567890' } });
  assert.equal(TagSettingsUpdate.safeParse(first.body).success, true);
  const saved = { ...current, meta: { enabled: true, pixelId: '123456789', capiTokenSet: true } };
  assert.deepEqual(tagsBody({ metaEnabled: true, pixelId: '123456789', capiToken: '', ga4Enabled: false, measurementId: '', apiSecret: '' }, saved).body, {}, 'nothing changed, nothing sent');
  const ga4 = tagsBody({ metaEnabled: true, pixelId: '123456789', capiToken: '', ga4Enabled: true, measurementId: 'g-abcd1234', apiSecret: 'secret-1234567890' }, saved);
  assert.deepEqual(ga4.body, { ga4: { enabled: true, measurementId: 'G-ABCD1234', apiSecret: 'secret-1234567890' } });
  assert.equal(TagSettingsUpdate.safeParse(ga4.body).success, true);
  assert.equal(tagsBody({ metaEnabled: true, pixelId: '12ab', ga4Enabled: false }, current).errors.pixelId, 'Enter the Pixel ID: 5 to 20 digits');
  assert.equal(tagsBody({ metaEnabled: true, pixelId: '', ga4Enabled: false }, current).errors.pixelId, 'Enter the Pixel ID to turn this on');
  assert.equal(tagsBody({ ga4Enabled: true, measurementId: 'UA-1234', metaEnabled: false }, current).errors.measurementId, 'Enter the measurement ID, starting G-');
  assert.equal(tagsBody({ metaEnabled: false, capiToken: 'short', ga4Enabled: false }, current).errors.capiToken, 'Paste the whole Conversions API token');
});

// ---- downloads and reports ----

test('N-81: the summary files are summaries only, and each request is one the API accepts', () => {
  for (const file of SUMMARY_FILES) {
    assert.ok(DOWNLOAD_SOURCES.includes(file.source), file.source);
    assert.doesNotMatch(`${file.label} ${file.detail}`, /raw|event log/i);
    for (const format of ['csv', 'xlsx']) {
      const body = downloadBody({ source: file.source, format, range: { from: '2026-10-01', to: '2026-10-31' } });
      assert.equal(DownloadCreate.safeParse(body).success, true, JSON.stringify(body));
    }
  }
  const query = exploreBody({ metrics: ['sessions'], dimensions: ['source'], range: '28' }, names);
  assert.equal(DownloadCreate.safeParse(downloadBody({ source: 'explore', format: 'xlsx', query })).success, true);
  assert.equal(DownloadCreate.safeParse(downloadBody({ source: 'funnel', funnelId: 3 })).success, true);
  assert.equal(DownloadCreate.safeParse(downloadBody({ source: 'cohort', cohort: { range: '90', kind: 'visitors', groupBy: 'first_week' } })).success, true);
  assert.equal(downloadBody({ source: 'media', format: 'pdf' }).format, 'csv', 'only the two formats');
});

test('a file opens only from this site, signed in, and only once it is ready', () => {
  assert.equal(canOpen({ status: 'ready', fileUrl: '/report-files/12' }), true);
  assert.equal(canOpen({ status: 'running', fileUrl: '/report-files/12' }), false);
  assert.equal(canOpen({ status: 'expired', fileUrl: '/report-files/12' }), false);
  for (const url of ['//elsewhere.example/x', 'https://elsewhere.example/x', 'javascript:alert(1)', '/\\elsewhere', '', null]) assert.equal(isOwnFile(url), false, String(url));
});

test('a schedule reads as words', () => {
  assert.equal(scheduleWords({ frequency: 'weekly', weekday: 1, hourOfDay: 9 }), 'Every Monday at 9 am');
  assert.equal(scheduleWords({ frequency: 'daily', hourOfDay: 18 }), 'Every day at 6 pm');
  assert.equal(scheduleWords({ frequency: 'monthly', dayOfMonth: 1, hourOfDay: 9 }), 'On day 1 of each month at 9 am');
});

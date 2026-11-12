// The owner app's analytics and catalog screens (PRD 10.4, 7.1, 7.10, 7.15): what their figures say when the API has
// no number, who sees revenue, and rules read from the source files themselves (no import from src, no money worked
// out on the phone, every route of these areas mapped to a screen). Pure modules load here; the rest is read as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FIGURE_TEXT, SOURCE_LABELS, SOURCE_LABEL_CODES } from '../../../src/contracts/analytics.js';
import { FigureState } from '../../../src/contracts/api/insights.js';
import { canSeeRevenue } from '../../../src/contracts/api/access.js';
import { routeList } from '../../../src/contracts/api/index.js';
import { insightRoutes } from '../../../src/contracts/api/insights.js';
import { reachGuardRoutes } from '../../../src/contracts/api/reach-guard.js';
import { trafficRoutes } from '../../../src/contracts/api/traffic.js';
import { reportRoutes } from '../../../src/contracts/api/reports.js';
import { productRoutes } from '../../../src/contracts/api/products.js';
import { importRoutes } from '../../../src/contracts/api/imports.js';
import { categoryRoutes } from '../../../src/contracts/api/categories.js';
import { pageRoutes } from '../../../src/contracts/api/pages.js';
import { themeRoutes } from '../../../src/contracts/api/themes.js';
import { brandKitRoutes } from '../../../src/contracts/api/brand-kit.js';
import { creatorRoutes } from '../../../src/contracts/api/creator.js';
import { leadRoutes } from '../../../src/contracts/api/leads.js';
import { mediaRoutes } from '../../../src/contracts/api/media.js';
import { checkParity, gather } from '../../../tools/parity-check.mjs';
import { CHART_KEYS, STATE_KEYS, busiest, chartOf, deltaWords, figureText, formatCompact, formatCount, formatDay, formatDuration, formatHour, formatRate, moneyText, rangeQuery, shares, showsRevenue, sourceKey } from '../../../apps/owner/src/features/insights/figures.js';
import productStrings from '../../../apps/owner/src/features/products/strings.js';
import { isEmail, scheduleBody } from '../../../apps/owner/src/features/reports/rules.js';
import { ScheduledReportInput } from '../../../src/contracts/api/reports.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '../../..');
const FEATURES = ['insights', 'reach-guard', 'traffic', 'reports', 'products', 'imports', 'categories', 'pages', 'themes', 'brand-kit', 'creator', 'leads'];
const sources = () => FEATURES.flatMap((name) => {
  const dir = path.join(ROOT, 'apps/owner/src/features', name);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => ({ file: `${name}/${f}`, test: f.endsWith('.test.js'), text: fs.readFileSync(path.join(dir, f), 'utf8') }));
});

// The words the insights strings give these keys, so a test reads what a person reads.
const words = {
  'insights.figure.noData': 'No data', 'insights.figure.notCollected': 'Not collected', 'insights.figure.belowFive': '<5', 'insights.figure.notAvailable': 'Not available',
  'insights.figure.permissionNeeded': 'Permission needed', 'insights.figure.lowVolume': 'low volume', 'insights.figure.ownerOnly': 'Owner only.',
};
const t = (key, values = {}) => (words[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');

test('a figure the API has no number for says why, in the contract’s words, and is never 0', () => {
  assert.equal(figureText(t, null), 'Not available');
  assert.equal(figureText(t, null, 'ok'), 'Not available');
  assert.equal(figureText(t, 0), '0'); // a real zero stays a zero
  for (const state of FigureState.options.filter((s) => s !== 'ok')) assert.ok(STATE_KEYS[state], state);
  assert.equal(figureText(t, null, 'below_threshold'), FIGURE_TEXT.belowFive);
  assert.equal(figureText(t, null, 'not_collected'), FIGURE_TEXT.notCollected);
  assert.equal(figureText(t, null, 'no_data'), FIGURE_TEXT.noData);
  assert.equal(figureText(t, 12, 'not_available'), 'Not available', 'a state that says no wins over a stray number');
  assert.equal(t(STATE_KEYS.hidden), FIGURE_TEXT.ownerOnly);
});

test('a chart leaves out a day with no number, and says Permission needed or Not available instead of a flat line', () => {
  const day = (d, value, state = 'ok') => ({ day: `2026-11-0${d}`, value, state });
  const chart = chartOf([day(1, 4), day(2, null, 'no_data'), day(3, 0), day(4, 9)]);
  assert.deepEqual(chart, { kind: 'chart', values: [4, 0, 9], labels: ['1 Nov', '3 Nov', '4 Nov'], gaps: 1 });
  assert.equal(chartOf([day(1, 4), day(2, 5)], { permission: 'needed' }).kind, 'permission');
  assert.equal(chartOf([day(1, null, 'not_available'), day(2, null, 'not_available')]).kind, 'not_available');
  assert.equal(chartOf([day(1, null, 'not_collected')]).kind, 'not_collected');
  assert.equal(chartOf([day(1, 5)]).kind, 'no_data', 'one point is not a line');
  assert.equal(chartOf([]).kind, 'not_available');
  assert.equal(chartOf(undefined).kind, 'not_available');
  for (const kind of ['permission', 'not_available', 'not_collected', 'no_data']) assert.ok(CHART_KEYS[kind]);
  assert.equal(t(CHART_KEYS.permission), 'Permission needed');
});

test('every chart’s source label is one of the contract’s three, said in its words', () => {
  const en = {
    'insights.source.bhava': SOURCE_LABELS.bhava, 'insights.source.platform': SOURCE_LABELS.platform, 'insights.source.destination': SOURCE_LABELS.destination,
  };
  for (const code of SOURCE_LABEL_CODES) assert.equal(en[sourceKey(code)], SOURCE_LABELS[code], code);
  assert.equal(sourceKey('made-up'), null);
  const insights = fs.readFileSync(path.join(ROOT, 'apps/owner/src/features/insights/index.js'), 'utf8');
  for (const code of SOURCE_LABEL_CODES) assert.ok(insights.includes(`'insights.source.${code}': '${SOURCE_LABELS[code]}'`), `the app says "${SOURCE_LABELS[code]}"`);
});

test('revenue is for the people canSeeRevenue allows, and a null amount is Not available, never ₹0', () => {
  const people = [
    { role: 'owner', permissions: [] }, { role: 'manager', permissions: [] }, { role: 'staff', permissions: ['orders', 'analytics'] },
    { role: 'staff', permissions: ['analytics'] }, { role: 'staff', permissions: [] }, null,
  ];
  for (const user of people) {
    assert.equal(showsRevenue(user), Boolean(user) && canSeeRevenue(user), JSON.stringify(user));
    const shown = moneyText(t, user, 1234550);
    assert.equal(shown, showsRevenue(user) ? '₹12,345.50' : 'Owner only.', JSON.stringify(user));
  }
  assert.equal(moneyText(t, { role: 'owner' }, null), 'Not available');
  assert.equal(moneyText(t, { role: 'owner' }, 0), '₹0');
});

test('counts, rates and times read the same on Android and iOS', () => {
  assert.equal(formatCount(1234567), '12,34,567');
  assert.equal(formatCount(null), '');
  assert.equal(formatCompact(12400), '12.4K');
  assert.equal(formatCompact(1_25_00_000), '1.3 Cr');
  assert.equal(formatRate(0.453), '45.3%');
  assert.equal(formatDuration(80_000), '1 min 20 s');
  assert.equal(formatDay('2026-11-04'), '4 Nov');
  assert.equal(formatHour(0), '12 am');
  assert.equal(formatHour(20), '8 pm');
  assert.deepEqual(deltaWords({ changePercent: -12.4 }), { key: 'insights.delta.down', values: { percent: '12%' } });
  assert.equal(deltaWords({ changePercent: null }), null);
  assert.deepEqual(busiest([{ weekday: 1, hour: 9, sessions: 3 }, { weekday: 5, hour: 20, sessions: 8 }]), { weekday: 5, hour: 20, value: 8 });
  assert.equal(busiest([{ weekday: 1, hour: 9, sessions: 0 }]), null);
  assert.ok(shares([{ key: 'a', value: 1 }, { key: 'b', value: 1 }, { key: 'c', value: 1 }]).reduce((s, i) => s + i.percent, 0) <= 100);
  assert.deepEqual(rangeQuery('90'), { range: '90' });
  assert.deepEqual(rangeQuery('custom'), { range: '28' });
});

test('a scheduled report body is the server’s ScheduledReportInput, and an email is checked by position', () => {
  const weekly = scheduleBody({ viewId: 4, frequency: 'weekly', hourOfDay: 9, weekday: 1, dayOfMonth: '1', format: 'csv' });
  assert.deepEqual(weekly.body, { viewId: 4, frequency: 'weekly', hourOfDay: 9, format: 'csv', weekday: 1 });
  assert.equal(ScheduledReportInput.safeParse(weekly.body).success, true);
  assert.equal(scheduleBody({ viewId: null, frequency: 'daily', hourOfDay: 9, format: 'csv' }).error, 'reports.scheduled.pickView');
  assert.equal(scheduleBody({ viewId: 4, frequency: 'monthly', hourOfDay: 9, dayOfMonth: '31', format: 'csv' }).error, 'reports.scheduled.dayBad');
  assert.equal(isEmail('accounts@example.com'), true);
  for (const bad of ['a@b', 'no-at.example.com', 'a@@b.com', 'a b@c.com', 'a@b.com.', `${'a'.repeat(250)}@b.co`]) assert.equal(isEmail(bad), false, bad);
});

test('the screens import nothing from src but the access rules, log nothing, and keep tokens out of storage', () => {
  for (const { file, test: isTest, text } of sources()) {
    if (isTest) continue;
    assert.doesNotMatch(text, /from ['"](\.\.\/)+src\//, `${file} imports from src`);
    assert.doesNotMatch(text, /\bconsole\.(log|info|warn|error|debug)\(/, `${file} writes to the console`);
    assert.doesNotMatch(text, /AsyncStorage|localStorage/, `${file} uses storage outside SecureStore and the offline cache`);
  }
});

test('no screen works money out: paise are formatted, compared or sent, never added, taken away, multiplied or divided', () => {
  const arithmetic = /\b\w*[Pp]aise\b\s*[-+*/%]\s*[\w(]|[\w)]\s*[-+*/%]\s*\b\w*[Pp]aise\b/;
  for (const { file, test: isTest, text } of sources()) {
    if (isTest || file === 'products/money.js') continue; // the formatter itself turns paise into rupees and digits into paise
    const lines = text.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    for (const line of lines) assert.doesNotMatch(line, arithmetic, `${file}: ${line.trim()}`);
  }
});

test('every route of these areas that an owner can reach is on an app screen, and the parity check passes', async () => {
  const groups = [insightRoutes, reachGuardRoutes, trafficRoutes, reportRoutes, productRoutes, importRoutes, categoryRoutes, pageRoutes, themeRoutes, brandKitRoutes, creatorRoutes, leadRoutes, mediaRoutes];
  const ids = groups.flatMap((g) => Object.keys(g));
  const { readAppFeatures } = require('../../../tools/parity-read.cjs');
  const app = readAppFeatures(ROOT);
  const mine = app.features.filter((f) => FEATURES.includes(f.name));
  const covered = new Set(mine.flatMap((f) => f.routeIds));
  const known = new Set(routeList.map((r) => r.id));
  for (const id of ids) {
    const route = routeList.find((r) => r.id === id);
    if (!route || route.consoleOnly) continue;
    assert.ok(covered.has(id), `${id} has no screen`);
  }
  for (const id of covered) assert.ok(known.has(id) || id.startsWith('console:'), `${id} is not a route`);
  const input = await gather(ROOT);
  const result = checkParity(input);
  assert.deepEqual(input.readProblems, []);
  assert.deepEqual(result.problems, []);
  for (const id of covered) assert.ok(!input.pending.routes.includes(id) && !input.pending.pages.includes(id), `${id} is still pending`);
});

test('every line the shared kit says is in English and Hindi with the same blanks', () => {
  const en = productStrings.en;
  const hi = productStrings.hi;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(hi).sort());
  const blanks = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
  for (const key of Object.keys(en)) {
    assert.ok(key.startsWith('products.'), key);
    assert.equal(blanks(hi[key]), blanks(en[key]), key);
  }
  for (const { file, test: isTest, text } of sources()) {
    if (isTest) continue;
    for (const [, key] of text.matchAll(/\bt\('(products\.[\w.]+)'/g)) assert.ok(en[key] !== undefined, `${file} says ${key}, which has no line`);
  }
});

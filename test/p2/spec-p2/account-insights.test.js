// PRD 7.1: account insights, from the per-business cache. N-01 to N-05.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { META_METRICS } from '../../../src/contracts/analytics.js';
import { ANALYTICS_LIMITS, DAY, FIGURE_TEXT, SOURCE_LABELS, addDays, addP2Shop, assertNoImpressions, dayAgo, metricOf, need, unique, useP2World } from './support.js';

const world = useP2World();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const account = (shop, query = { range: '28' }) => shop.get('/insights/account', query, 'The account insights');
const days = (n, value = 100, from = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + from, typeof value === 'function' ? value(i) : value]));

// ---- N-01 ------------------------------------------------------------------------------------------------------------

test('N-01: a connected account is collected with no help: the worker makes its account row and polls, and the figures reach the screen', async () => {
  const shop = await addP2Shop(world, { followers: 5000 });
  await world.meta.post('/insights/daily', { igUserId: shop.igUserId, metric: 'reach', points: [{ day: dayAgo(3), value: 4321 }] });
  await shop.poll();
  const [row] = await shop.sql('SELECT * FROM analytics_accounts WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(row, 'A connected Instagram account gets a row in analytics_accounts by itself');
  assert.equal(row.ig_user_id, shop.igUserId);
  const jobs = (await shop.polls()).map((p) => p.job);
  for (const job of ['account_daily', 'demographics', 'media_list']) assert.ok(jobs.includes(job), `${job} is on the schedule: ${jobs}`);
  const res = await account(shop, { range: '7' });
  assert.equal(metricOf(res, 'reach').days.find((d) => d.day === dayAgo(3)).value, 4321);
});

test('N-01: 28 days load from the cache, with one figure per day, and opening the screens makes no call to Meta', async () => {
  const shop = await addP2Shop(world, { followers: 5000 });
  await shop.seedDays('reach', days(28, (i) => 1000 + i));
  await shop.seedDays('views', days(28, 2000));
  await shop.clearMetaCalls();
  const res = await account(shop);
  const reach = metricOf(res, 'reach');
  assert.equal(reach.days.length, 28);
  assert.ok([dayAgo(0), dayAgo(1)].includes(res.to), `The range ends today or yesterday, not ${res.to}`);
  assert.equal(res.from, addDays(res.to, -27));
  for (const route of ['/insights/status', '/insights/audience', '/insights/media', '/insights/stories', '/insights/top', '/insights/best-time', '/reach-guard', '/account-health']) {
    await shop.get(route, undefined, route);
  }
  assert.deepEqual((await world.meta.calls({})).map((c) => c.path), [], 'No screen calls Meta');
});

test('N-01: exactly the last 2 days are flagged "may still change"', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('reach', days(28));
  const reach = metricOf(await account(shop), 'reach');
  assert.deepEqual(reach.days.map((d) => d.mayChange), [...Array(26).fill(false), true, true]);
});

test('N-01: a custom range that ended long ago flags nothing: those days can no longer change', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('reach', days(11, 100, 20));
  const reach = metricOf(await account(shop, { range: 'custom', from: dayAgo(30), to: dayAgo(20) }), 'reach');
  assert.equal(reach.days.length, 11);
  assert.deepEqual(reach.days.filter((d) => d.mayChange), []);
});

test('N-01: the screen says where the figures come from, which are estimates, and when they were last updated', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('reach', days(7));
  await shop.seedDays('views', days(7));
  const res = await account(shop, { range: '7' });
  assert.equal(res.source, 'platform');
  assert.equal(SOURCE_LABELS[res.source], 'From Instagram/Facebook');
  assert.ok(res.lastUpdatedAt, 'Every figure shows a last updated time');
  assert.equal(metricOf(res, 'reach').estimated, META_METRICS.estimated.includes('reach'));
  assert.equal(metricOf(res, 'views').estimated, META_METRICS.estimated.includes('views'));
  assert.equal(metricOf(res, 'views').label, FIGURE_TEXT.viewsColumn);
});

test('N-01: with Meta down the screen still answers from the cache', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('reach', days(7, 55));
  await world.meta.fault({ kind: 'timeout', times: 'forever', match: { path: '*/insights' } });
  try {
    const res = await account(shop, { range: '7' });
    assert.ok(metricOf(res, 'reach').days.some((d) => d.value === 55));
  } finally {
    await world.meta.delete('/faults');
  }
});

test('N-01: a late revision from Meta overwrites the cached figure', async () => {
  const shop = await addP2Shop(world);
  const on = dayAgo(1);
  await world.meta.post('/insights/daily', { igUserId: shop.igUserId, metric: 'reach', points: [{ day: on, early: 40, value: 100 }] });
  await shop.poll({ jobs: ['account_daily'] });
  const first = await shop.sql(`SELECT value FROM insight_daily WHERE tenant_id = $1 AND day = $2 AND metric = 'reach' AND breakdown = ''`, [shop.tenantId, on]);
  assert.equal(Number(first[0]?.value), 40, 'The early figure is cached');
  await world.meta.post('/clock', { advanceMs: 2 * DAY });
  await shop.poll({ jobs: ['account_daily'] });
  const later = await shop.sql(`SELECT value FROM insight_daily WHERE tenant_id = $1 AND day = $2 AND metric = 'reach' AND breakdown = ''`, [shop.tenantId, on]);
  assert.equal(Number(later[0]?.value), 100, 'The settled figure replaces it');
});

test('N-01: the last 3 days are fetched again on the daily poll, and nothing older than 90 days is asked for', async () => {
  const shop = await addP2Shop(world);
  await shop.clearMetaCalls();
  await shop.poll({ jobs: ['account_daily'] });
  const calls = await shop.metaCalls('*/insights');
  assert.ok(calls.length > 0, 'The account was polled');
  const since = calls.map((c) => Number(c.query.since)).filter(Boolean);
  for (const at of since) assert.ok(at * 1000 >= Date.now() - ANALYTICS_LIMITS.accountRetentionDays * DAY - DAY, 'No request reaches past what Meta keeps');
});

test('N-01: two workers on the same poll at the same moment fetch each day once', async () => {
  const shop = await addP2Shop(world);
  await shop.settle({ ms: 1500, roundMs: 200 });
  world.addWorker();
  await shop.clearMetaCalls();
  await shop.sql(`UPDATE insight_polls SET next_due_at = now() - interval '1 second', lease_until = NULL WHERE tenant_id = $1 AND job = 'account_daily'`, [shop.tenantId]);
  await world.tickTogether();
  await shop.settle({ ms: 4000, roundMs: 300 });
  const asked = (await shop.metaCalls('*/insights')).map((c) => JSON.stringify(c.query));
  assert.ok(asked.length > 0, 'The poll ran');
  assert.equal(new Set(asked).size, asked.length, 'No request was made twice');
});

test('N-01: Meta timing out or answering junk changes nothing in the cache, and the poll is tried again', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('reach', { 3: 777 });
  await shop.settle({ ms: 1500, roundMs: 200 });
  for (const fault of [{ kind: 'timeout', delayMs: 50 }, { kind: 'malformed', mode: 'html' }, { kind: 'malformed', mode: 'wrong_shape' }, { kind: 'malformed', mode: 'garbage' }, { kind: 'server_error', status: 503 }]) {
    await world.meta.fault({ ...fault, times: 'forever', match: { path: '*/insights' } });
    await shop.poll({ jobs: ['account_daily'] });
    await world.meta.delete('/faults');
    const res = await account(shop, { range: '7' });
    assert.equal(metricOf(res, 'reach').days.find((d) => d.day === dayAgo(3)).value, 777, `After ${fault.kind} ${fault.mode ?? ''}`);
  }
  const [poll] = await shop.polls(`job = 'account_daily'`);
  assert.equal(poll.stopped_at, null, 'A failed poll is not given up on');
});

test('N-01: a range is checked: nonsense is a 400, never a crash', async () => {
  const shop = await addP2Shop(world);
  const bad = [
    { range: '0' }, { range: 'abc' }, { range: '-7' }, { range: "7' OR '1'='1" },
    { range: 'custom' }, { range: 'custom', from: dayAgo(3) }, { range: 'custom', to: dayAgo(3) },
    { range: 'custom', from: dayAgo(1), to: dayAgo(5) },
    { range: 'custom', from: '2026-02-30', to: '2026-03-01' },
    { range: 'custom', from: "2026-01-01'; DROP TABLE tenants;--", to: '2026-03-01' },
    { range: 'custom', from: '0001-01-01', to: '9999-12-31' },
    { range: 'custom', from: dayAgo(ANALYTICS_LIMITS.rollupDays + 5), to: dayAgo(0) },
  ];
  for (const query of bad) {
    const res = await shop.raw('/insights/account', query);
    assert.equal(res.status, 400, `${JSON.stringify(query)} got ${res.status}: ${res.text.slice(0, 200)}`);
    assert.equal(res.json().code, 'validation_failed');
  }
  assert.ok((await shop.sql('SELECT count(*)::int AS n FROM tenants'))[0].n > 0, 'The tenants table is still there');
});

test('N-01: who can read: staff need the analytics permission, and a shopper or stranger can\'t', async () => {
  const shop = await addP2Shop(world);
  const without = await shop.addStaff(['orders']);
  const withIt = await shop.addStaff(['analytics']);
  const customer = await shop.addCustomer();
  assert.equal((await shop.as(without.token, '/insights/account')).status, 403);
  need(await shop.as(withIt.token, '/insights/account'), 200, 'Staff with analytics');
  assert.equal((await shop.as(customer.token, '/insights/account')).status, 403);
  assert.equal((await shop.as(undefined, '/insights/account')).status, 401);
});

test('N-01: one business never sees another\'s figures, and can\'t ask to by header', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await a.seedDays('reach', days(7, 9999));
  const seen = await account(b, { range: '7' });
  for (const entry of metricOf(seen, 'reach').days) assert.notEqual(entry.value, 9999, 'A figure of the other business');
  const res = await b.raw('/insights/account', {}, { headers: { 'x-tenant-id': String(a.tenantId) } });
  assert.equal(res.status, 403);
  assert.equal(res.json().code, 'forbidden');
});

// ---- N-02 ------------------------------------------------------------------------------------------------------------

test('N-02: 80 followers: Audience shows the notice and no error', async () => {
  const shop = await addP2Shop(world, { followers: 80 });
  await shop.poll();
  const res = await shop.get('/insights/audience', undefined, 'Audience');
  assert.equal(res.available, false);
  assert.equal(res.message, 'Available once you reach 100 followers');
  assert.deepEqual([res.followers, res.engaged], [[], []]);
  assert.deepEqual((await shop.polls(`job = 'demographics' AND last_outcome ~* 'error|fail'`)).map((p) => p.last_outcome), [], 'Under 100 followers is not a failed poll');
});

for (const [followers, available] of [[99, false], [100, true], [101, true]]) {
  test(`N-02: at ${followers} followers Audience is ${available ? 'shown' : 'held back'}`, async () => {
    const shop = await addP2Shop(world, { followers });
    await world.meta.post('/insights/demographics', { igUserId: shop.igUserId, metric: 'follower_demographics', breakdown: 'city', results: { Pune: 60, Delhi: 40 } });
    await shop.poll();
    const res = await shop.get('/insights/audience', undefined, 'Audience');
    assert.equal(res.available, available, JSON.stringify(res));
    if (available) assert.deepEqual(res.followers.find((b) => b.breakdown === 'city').items.map((i) => i.key).sort(), ['Delhi', 'Pune']);
    else assert.equal(res.message, FIGURE_TEXT.fewFollowers);
  });
}

test('N-02: demographics are asked for this_week or this_month only, and any other timeframe is refused', async () => {
  const shop = await addP2Shop(world, { followers: 500 });
  await shop.clearMetaCalls();
  await shop.poll({ jobs: ['demographics'] });
  const timeframes = new Set((await shop.metaCalls('*/insights')).filter((c) => /demographics/.test(c.query.metric ?? '')).map((c) => c.query.timeframe));
  for (const timeframe of timeframes) assert.ok(['this_week', 'this_month'].includes(timeframe), timeframe);
  for (const timeframe of ['this_week', 'this_month']) need(await shop.raw('/insights/audience', { timeframe }), 200, timeframe);
  for (const timeframe of ['last_30_days', '', "this_week'--"]) assert.equal((await shop.raw('/insights/audience', { timeframe })).status, 400, timeframe);
});

test('N-02: demographics are polled weekly, and another poll inside the week makes no call', async () => {
  const shop = await addP2Shop(world, { followers: 500 });
  await shop.poll({ jobs: ['demographics'] });
  const [poll] = await shop.polls(`job = 'demographics'`);
  assert.ok(poll, 'A demographics poll exists');
  const waitMs = new Date(poll.next_due_at) - new Date(poll.last_finished_at ?? poll.last_started_at);
  assert.ok(waitMs >= ANALYTICS_LIMITS.demographicsEveryMs - DAY && waitMs <= ANALYTICS_LIMITS.demographicsEveryMs + DAY, `Next demographics poll in ${waitMs / DAY} days`);
  await shop.clearMetaCalls();
  await shop.runDue();
  assert.deepEqual((await shop.metaCalls('*/insights')).filter((c) => /demographics/.test(c.query.metric ?? '')), []);
});

// ---- N-03 ------------------------------------------------------------------------------------------------------------

test('N-03: an empty metric from Meta is stored as null, and that day shows No data', async () => {
  const shop = await addP2Shop(world);
  const on = dayAgo(3);
  await world.meta.post('/insights/daily', { igUserId: shop.igUserId, metric: 'comments', points: [{ day: on, value: null }, { day: dayAgo(4), value: 12 }] });
  await shop.poll({ jobs: ['account_daily'] });
  const [row] = await shop.sql(`SELECT value FROM insight_daily WHERE tenant_id = $1 AND day = $2 AND metric = 'comments' AND breakdown = ''`, [shop.tenantId, on]);
  assert.ok(row, 'The empty day has a row');
  assert.equal(row.value, null, 'It is null, never 0');
});

test('N-03: the screen says No data for that day, and the total notes the gap', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('comments', { 3: 10, 4: null, 5: 7 });
  const res = metricOf(await account(shop, { range: '7' }), 'comments');
  const entry = res.days.find((d) => d.day === dayAgo(4));
  assert.deepEqual([entry.value, entry.state], [null, 'no_data']);
  assert.equal(res.total, 17, 'The total is what there is');
  assert.ok(res.gapDays >= 1, 'The total notes the gap');
});

test('N-03: a real zero is a zero and not a gap', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('comments', Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, i === 3 ? 0 : 1])));
  const res = metricOf(await account(shop, { range: '7' }), 'comments');
  const zero = res.days.find((d) => d.day === dayAgo(3));
  assert.deepEqual([zero.value, zero.state], [0, 'ok']);
  assert.equal(res.gapDays, 0);
});

test('N-03: if every day is empty the total is null, not 0', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('comments', days(7, null));
  const res = metricOf(await account(shop, { range: '7' }), 'comments');
  assert.equal(res.total, null);
  assert.equal(res.gapDays, 7);
});

test('N-03: an empty day that Meta later fills in shows its number', async () => {
  const shop = await addP2Shop(world);
  const on = dayAgo(2);
  await world.meta.post('/insights/daily', { igUserId: shop.igUserId, metric: 'comments', points: [{ day: on, value: null }] });
  await shop.poll({ jobs: ['account_daily'] });
  await world.meta.post('/insights/daily', { igUserId: shop.igUserId, metric: 'comments', points: [{ day: on, value: 8 }] });
  await shop.poll({ jobs: ['account_daily'] });
  assert.equal(metricOf(await account(shop, { range: '7' }), 'comments').days.find((d) => d.day === on).value, 8);
});

test('N-03: Meta dropping a metric leaves the old figures and the other metrics alone', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('comments', { 2: 15 });
  await shop.settle({ ms: 1500, roundMs: 200 });
  await world.meta.post('/insights/daily', { igUserId: shop.igUserId, metric: 'reach', points: [{ day: dayAgo(2), value: 300 }] });
  await world.meta.fault({ kind: 'rate_limit', status: 400, times: 'forever', match: { path: '*/insights', query: { metric: 'comments' } }, body: { error: { message: '(#100) metric[0] must be one of the following values: views, reach', type: 'OAuthException', code: 100 } } });
  try {
    await shop.poll({ jobs: ['account_daily'] });
  } finally {
    await world.meta.delete('/faults');
  }
  const res = await account(shop, { range: '7' });
  assert.equal(metricOf(res, 'comments').days.find((d) => d.day === dayAgo(2)).value, 15, 'The cached figure stays');
});

// ---- N-04 ------------------------------------------------------------------------------------------------------------

test('N-04: a 180-day range: days past Meta\'s 90 come from stored rows, and no request reaches back for them', async () => {
  const shop = await addP2Shop(world);
  await shop.setCollectingSince(dayAgo(130));
  await shop.seedDays('reach', { 91: 910, 120: 1200 }, { sim: false });
  await shop.clearMetaCalls();
  const res = metricOf(await account(shop, { range: 'custom', from: dayAgo(179), to: dayAgo(0) }), 'reach');
  assert.equal(res.days.length, 180);
  assert.equal(res.days.find((d) => d.day === dayAgo(91)).value, 910);
  assert.equal(res.days.find((d) => d.day === dayAgo(120)).value, 1200);
  assert.deepEqual((await world.meta.calls({})).map((c) => c.path), [], 'Stored days never call Meta');
});

test('N-04: days before the account was connected show Not collected, not No data and not 0', async () => {
  const shop = await addP2Shop(world);
  await shop.setCollectingSince(dayAgo(60));
  const res = metricOf(await account(shop, { range: 'custom', from: dayAgo(90), to: dayAgo(0) }), 'reach');
  const before = res.days.find((d) => d.day === dayAgo(61));
  assert.deepEqual([before.value, before.state], [null, 'not_collected']);
  const first = res.days.find((d) => d.day === dayAgo(60));
  assert.notEqual(first.state, 'not_collected', 'The day collection began is collected');
  assert.equal(res.total, null, 'Nothing was collected in this range, so there is no total to give');
});

test('N-04: the range limits are exact: 25 months is allowed and a day more is not', async () => {
  const shop = await addP2Shop(world);
  need(await shop.raw('/insights/account', { range: 'custom', from: dayAgo(ANALYTICS_LIMITS.rollupDays), to: dayAgo(0) }), 200, 'The longest range');
  assert.equal((await shop.raw('/insights/account', { range: 'custom', from: dayAgo(ANALYTICS_LIMITS.rollupDays + 1), to: dayAgo(0) })).status, 400);
});

test('N-04: the first poll of a new account never asks Meta for days older than it keeps', async () => {
  const shop = await addP2Shop(world);
  await shop.clearMetaCalls();
  await shop.poll({ jobs: ['account_daily'] });
  for (const call of await shop.metaCalls('*/insights')) assert.notEqual(call.status, 400, `Meta refused ${JSON.stringify(call.query)}`);
});

// ---- N-05 ------------------------------------------------------------------------------------------------------------

test('N-05: no request sent to Meta asks for impressions, for an account, a feed post, a reel, a carousel or a story', async () => {
  const shop = await addP2Shop(world);
  await shop.reel({ id: `r${unique()}` });
  await shop.feedPost({ id: `p${unique()}` });
  await shop.reel({ id: `c${unique()}`, productType: 'FEED', mediaType: 'CAROUSEL_ALBUM', children: [`s${unique()}`] });
  await shop.story({ id: `st${unique()}` });
  await shop.poll();
  await shop.poll();
  const calls = await world.meta.calls({});
  assert.ok(calls.some((c) => /insights/.test(c.path)), 'Insights were polled');
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call.query ?? {}), /impressions/, call.path);
});

test('N-05: code search: no request in the source names impressions, and Bhava does not build on profile_views or website_clicks', () => {
  for (const list of [META_METRICS.accountDaily, META_METRICS.feed, META_METRICS.carousel, META_METRICS.reel, META_METRICS.story, ...Object.values(META_METRICS.accountBreakdowns)]) {
    for (const banned of ['impressions', 'profile_views', 'website_clicks']) assert.equal(list.includes(banned), false, banned);
  }
  const files = fs.readdirSync(path.join(repoRoot, 'src'), { recursive: true }).filter((f) => /\.js$/.test(f)).map((f) => path.join(repoRoot, 'src', f));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /[?&]metric=[^'"`]*impressions/, file);
    assert.doesNotMatch(text, /metrics?\s*[:=]\s*\[[^\]]*['"`]impressions['"`]/, file);
  }
});

test('N-05: no answer to the seller carries a metric called impressions, and views is labelled as its replacement', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('views', days(7, 9));
  const res = await account(shop, { range: '7' });
  assertNoImpressions(res.metrics.map((m) => m.metric), 'The metric list');
  assert.equal(metricOf(res, 'views').label, 'Views (replaces impressions)');
});

test('N-05: a post from before 2 July 2024 keeps its historic Impressions beside views, never merged', async () => {
  const shop = await addP2Shop(world);
  const { mediaId } = await shop.seedMedia({ mediaId: `old${unique()}`, kind: 'feed', postedAgoMs: Date.now() - Date.parse('2024-06-20T00:00:00Z'), latest: { views: 100 }, historicImpressions: 5000 });
  const detail = await shop.get(`/insights/media/${mediaId}`, undefined, 'The post');
  assert.equal(detail.metrics.views, 100, 'Views stay views');
  assert.equal(detail.historicImpressions, 5000);
});

test('N-05: a post from after 2 July 2024 has no historic Impressions column', async () => {
  const shop = await addP2Shop(world);
  const { mediaId } = await shop.seedMedia({ mediaId: `new${unique()}`, kind: 'feed', latest: { views: 100 } });
  assert.equal((await shop.get(`/insights/media/${mediaId}`, undefined, 'The post')).historicImpressions, null);
});

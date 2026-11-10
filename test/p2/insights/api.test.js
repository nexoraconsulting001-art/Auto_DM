// The insights screens through /api/v1: figures from the cache, never a call to Meta at page load, and nothing shown that isn't known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FIGURE_TEXT } from '../../../src/contracts/analytics.js';
import { ApiError } from '../../../src/contracts/api/index.js';
import { insightsApi } from '../../../src/modules/insights/api.js';
import { insights } from '../../../src/modules/insights/index.js';
import { createAnalytics } from '../../../src/platform/analytics.js';
import { withTenant } from '../../../src/tenancy.js';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { adminApp, ok, secondBusiness } from '../../p0/admin-api/support.js';
import { IG_ACCOUNT } from '../../helpers.js';
import { DAY, HOUR, MINUTE, NOW, dayBack } from './support.js';


/** Runs a test against one app, signed in as the owner, on a clock it controls. */
const withInsights = (run, { plan = 't1' } = {}) => async () => {
  const clock = { t: NOW };
  const sim = createMeta();
  await sim.start();
  const app = await adminApp({ overrides: { complianceNow: () => clock.t, complianceInline: false, graphBaseUrl: sim.url } });
  try {
    await app.db.platform.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, app.tenant.id]);
    const analytics = createAnalytics({ analyticsDriver: 'pg' }, { db: app.db });
    const rollups = (fn) => withTenant(app.tenant, () => fn(analytics.rollups));
    const insights = app.repos.insights;
    const ref = await insights.enrol({ igUserId: IG_ACCOUNT.igUserId, collectingSince: dayBack(200), offsetSec: 0, polls: [] });
    const get = async (path) => ok(await app.api('GET', `/insights${path}`));
    await run({ app, sim, clock, insights, ref, get, rollups });
  } finally {
    await app.close();
    await sim.close();
  }
};

const rowsFor = (metric, value) => [{ metric, breakdown: '', breakdownValue: '', value }];
const metricOf = (body, name) => body.metrics.find((m) => m.metric === name);

async function media(insights, ref, id, { kind = 'reel', postedAt, caption = '', latest = {}, snapshots = [] }) {
  const refs = await insights.upsertMedia(ref, [{ id, kind, caption, permalink: `https://instagram.example/${id}`, thumbnailUrl: '', postedAt: new Date(postedAt) }]);
  const mediaRef = refs.get(id);
  let slot = postedAt;
  for (const [ageMinutes, metrics] of snapshots) {
    slot += 1000;
    await insights.saveSnapshot(mediaRef, { slot, at: postedAt + ageMinutes * MINUTE, ageMinutes, metrics, breakdowns: {} });
  }
  if (!snapshots.length && Object.keys(latest).length) await insights.saveSnapshot(mediaRef, { slot: NOW, at: NOW, ageMinutes: 0, metrics: latest, breakdowns: {} });
  return mediaRef;
}

// ---- account --------------------------------------------------------------------------------------------------------------

test('N-01: 28 days load from the cache, the last 2 are flagged, and opening the screen makes no call to Meta', withInsights(async ({ sim, clock, insights, ref, get }) => {
  for (let back = 1; back <= 28; back++) await insights.replaceDay(ref, dayBack(back), rowsFor('reach', back * 10), clock.t);
  await insights.markRefreshed(ref, clock.t);
  const body = await get('/account?range=28');

  assert.equal(body.source, 'platform');
  assert.equal(body.from, dayBack(28));
  assert.equal(body.to, dayBack(1));
  const reach = metricOf(body, 'reach');
  assert.equal(reach.days.length, 28);
  assert.deepEqual(reach.days.filter((d) => d.mayChange).map((d) => d.day), [dayBack(2), dayBack(1)]);
  assert.equal(reach.estimated, true);
  assert.equal(body.lastUpdatedAt, new Date(clock.t).toISOString());
  assert.equal(metricOf(body, 'views').label, FIGURE_TEXT.viewsColumn);
  assert.equal((await sim.calls({})).length, 0);
}));

test('N-03: a day with no data says so, stays out of the total, and the total notes the gap', withInsights(async ({ clock, insights, ref, get }) => {
  for (let back = 1; back <= 7; back++) await insights.replaceDay(ref, dayBack(back), rowsFor('comments', back === 3 ? null : 4), clock.t);
  const comments = metricOf(await get('/account?range=7'), 'comments');
  const empty = comments.days.find((d) => d.day === dayBack(3));
  assert.deepEqual([empty.value, empty.state], [null, 'no_data']);
  assert.equal(comments.total, 24);
  assert.equal(comments.gapDays, 1);
}));

test('N-04: a 180 day range reads stored days, and days before connecting say "Not collected"', withInsights(async ({ app, clock, insights, ref, get }) => {
  await app.db.platform.query('UPDATE analytics_accounts SET collecting_since = $1 WHERE id = $2', [dayBack(120), ref]);
  await insights.replaceDay(ref, dayBack(100), rowsFor('reach', 77), clock.t);
  await insights.replaceDay(ref, dayBack(5), rowsFor('reach', 11), clock.t);
  const reach = metricOf(await get(`/account?range=custom&from=${dayBack(180)}&to=${dayBack(1)}`), 'reach');
  const at = (back) => reach.days.find((d) => d.day === dayBack(back));
  assert.equal(reach.days.length, 180);
  assert.deepEqual([at(100).value, at(100).state], [77, 'ok']);
  assert.deepEqual([at(150).value, at(150).state], [null, 'not_collected']);
  assert.deepEqual([at(50).value, at(50).state], [null, 'no_data']);
  assert.equal(reach.total, 88);
}));

test('a day Meta still had when the business connected shows, and an empty one before connecting is "Not collected", not "No data"', withInsights(async ({ app, clock, insights, ref, get }) => {
  await app.db.platform.query('UPDATE analytics_accounts SET collecting_since = $1 WHERE id = $2', [dayBack(10), ref]);
  await insights.replaceDay(ref, dayBack(20), rowsFor('reach', 5), clock.t);
  await insights.replaceDay(ref, dayBack(21), rowsFor('reach', null), clock.t);
  const reach = metricOf(await get('/account?range=28'), 'reach');
  assert.equal(reach.days.find((d) => d.day === dayBack(20)).state, 'ok');
  assert.equal(reach.days.find((d) => d.day === dayBack(21)).state, 'not_collected');
}));

test('the free plan sees 7 days, and what is older is unavailable rather than 0', withInsights(async ({ clock, insights, ref, get }) => {
  for (const back of [1, 6, 7, 8, 20]) await insights.replaceDay(ref, dayBack(back), rowsFor('reach', 10), clock.t);
  const reach = metricOf(await get('/account?range=28'), 'reach');
  const at = (back) => reach.days.find((d) => d.day === dayBack(back));
  assert.deepEqual([at(7).value, at(7).state], [10, 'ok']);
  assert.deepEqual([at(8).value, at(8).state], [null, 'not_available']);
  assert.deepEqual([at(20).value, at(20).state], [null, 'not_available']);
  assert.equal(reach.total, 30);
}, { plan: 'free' }));

test('metrics that come only broken down still have a daily figure and a breakdown', withInsights(async ({ clock, insights, ref, get }) => {
  await insights.replaceDay(ref, dayBack(4), [
    { metric: 'profile_links_taps', breakdown: 'contact_button_type', breakdownValue: 'CALL', value: 3 },
    { metric: 'profile_links_taps', breakdown: 'contact_button_type', breakdownValue: 'EMAIL', value: 2 },
    { metric: 'reach', breakdown: '', breakdownValue: '', value: 40 },
    { metric: 'reach', breakdown: 'media_product_type', breakdownValue: 'REEL', value: 30 },
  ], clock.t);
  const body = await get('/account?range=7');
  const taps = metricOf(body, 'profile_links_taps');
  assert.equal(taps.days.find((d) => d.day === dayBack(4)).value, 5);
  assert.deepEqual(taps.breakdowns, [{ breakdown: 'contact_button_type', items: [{ key: 'CALL', value: 3 }, { key: 'EMAIL', value: 2 }] }]);
  const reach = metricOf(body, 'reach');
  assert.equal(reach.days.find((d) => d.day === dayBack(4)).value, 40);
  assert.deepEqual(reach.breakdowns, [{ breakdown: 'media_product_type', items: [{ key: 'REEL', value: 30 }] }]);
}));

test('followers read as a daily series, and a day with no snapshot has no number', withInsights(async ({ clock, insights, ref, get }) => {
  await insights.saveFollowers(ref, dayBack(2), 5100, clock.t);
  const { followers } = await get('/account?range=7');
  assert.equal(followers.find((d) => d.day === dayBack(2)).value, 5100);
  assert.deepEqual([followers.find((d) => d.day === dayBack(3)).value, followers.find((d) => d.day === dayBack(3)).state], [null, 'no_data']);
}));

test('N-02: below 100 followers the audience says so, without an error', withInsights(async ({ clock, insights, ref, get }) => {
  await insights.saveFollowers(ref, dayBack(0), 80, clock.t);
  const body = await get('/audience');
  assert.deepEqual([body.available, body.message], [false, FIGURE_TEXT.fewFollowers]);
  assert.deepEqual([body.followers, body.engaged], [[], []]);
}));

test('the audience reads the stored breakdowns for its timeframe', withInsights(async ({ clock, insights, ref, get }) => {
  await insights.saveFollowers(ref, dayBack(0), 500, clock.t);
  await insights.replaceDemographics(ref, { metric: 'follower_demographics', timeframe: 'this_week', breakdown: 'city', items: [{ key: 'Pune', value: 9 }, { key: 'Agra', value: 20 }], at: clock.t });
  await insights.replaceDemographics(ref, { metric: 'engaged_audience_demographics', timeframe: 'this_month', breakdown: 'age', items: [{ key: '18-24', value: 4 }], at: clock.t });
  const week = await get('/audience?timeframe=this_week');
  assert.equal(week.available, true);
  assert.deepEqual(week.followers, [{ breakdown: 'city', items: [{ key: 'Agra', value: 20 }, { key: 'Pune', value: 9 }] }]);
  assert.deepEqual(week.engaged, []);
  assert.equal(week.source, 'platform');
  assert.equal((await get('/audience?timeframe=this_month')).engaged[0].items[0].key, '18-24');
}));

test('status says what the business has, and permission needed when it was denied', withInsights(async ({ app, clock, insights, ref, get }) => {
  await insights.setStoriesEdge(ref, 'unavailable');
  await insights.markRefreshed(ref, clock.t);
  let status = await get('/status');
  assert.deepEqual([status.connected, status.permission, status.collectingSince, status.storyDiscovery], [true, 'ok', dayBack(200), 'replies_and_mentions_only']);
  assert.equal(status.lastUpdatedAt, new Date(clock.t).toISOString());
  await insights.setPermission(ref, 'denied', clock.t);
  status = await get('/status');
  assert.equal(status.permission, 'needed');
  assert.equal((await get('/account?range=7')).permission, 'needed');
  await app.repos.igAccounts.loseToken(IG_ACCOUNT.igUserId, 'token.rejected', { actor: 'test' });
  assert.equal((await get('/status')).connected, false);
}));

// ---- posts ------------------------------------------------------------------------------------------------------------------

test('N-06: a reel shows its figures and which are estimated, and a metric Meta didn\'t give stays null', withInsights(async ({ insights, ref, get }) => {
  await media(insights, ref, 'r1', { postedAt: NOW - 3 * DAY, caption: 'Launch', latest: { views: 10, reach: 8, ig_reels_avg_watch_time: 1500, reels_skip_rate: 30, likes: null } });
  const { items } = await get('/media');
  assert.equal(items[0].id, 'r1');
  assert.equal(items[0].metrics.views, 10);
  assert.equal(items[0].metrics.likes, null);
  assert.deepEqual(items[0].estimated.sort(), ['ig_reels_avg_watch_time', 'reach', 'reels_skip_rate', 'views']);
  assert.equal(items[0].source, 'platform');
  assert.ok(items[0].lastUpdatedAt);
}));

test('the media list pages newest first, and filters by kind and by deleted', withInsights(async ({ clock, insights, ref, app, get }) => {
  await media(insights, ref, 'old', { kind: 'feed', postedAt: NOW - 10 * DAY });
  await media(insights, ref, 'mid', { kind: 'carousel', postedAt: NOW - 5 * DAY });
  const gone = await media(insights, ref, 'new', { kind: 'reel', postedAt: NOW - DAY });
  await insights.markMediaDeleted(gone, clock.t);

  const first = await get('/media?limit=2');
  assert.deepEqual(first.items.map((m) => m.id), ['new', 'mid']);
  assert.equal(first.items[0].deleted, true);
  const second = await get(`/media?limit=2&cursor=${first.nextCursor}`);
  assert.deepEqual(second.items.map((m) => m.id), ['old']);
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await get('/media?kind=carousel')).items.map((m) => m.id), ['mid']);
  assert.deepEqual((await get('/media?includeDeleted=false')).items.map((m) => m.id), ['mid', 'old']);
  const bad = await app.api('GET', '/insights/media?cursor=abc');
  assert.equal(bad.status, 400);
}));

test('a post\'s detail has its growth by age and its breakdowns', withInsights(async ({ insights, ref, get }) => {
  const mediaRef = await media(insights, ref, 'r1', { postedAt: NOW - 3 * DAY, snapshots: [[60, { views: 10 }], [1440, { views: 40 }]] });
  await insights.saveSnapshot(mediaRef, { slot: NOW, at: NOW, ageMinutes: 4320, metrics: { views: 90 }, breakdowns: { profile_activity: { BIO_LINK_CLICKED: 3 } } });
  const body = await get('/media/r1');
  assert.deepEqual(body.growth.map((g) => [g.ageMinutes, g.metrics.views]), [[60, 10], [1440, 40], [4320, 90]]);
  assert.deepEqual(body.breakdowns, { profile_activity: { BIO_LINK_CLICKED: 3 } });
  assert.equal(body.metrics.views, 90);
}));

test('an unknown post is a 404, and impressions is only ever a historic column', withInsights(async ({ app }) => {
  assert.equal((await app.api('GET', '/insights/media/nope')).status, 404);
  const moduleDir = new URL('../../../src/modules/insights/', import.meta.url);
  for (const file of fs.readdirSync(moduleDir)) {
    const source = fs.readFileSync(new URL(file, moduleDir), 'utf8');
    for (const match of source.matchAll(/[\w-]*impressions[\w-]*/gi)) assert.match(match[0], /^historic_?impressions$/i, `${file}: ${match[0]}`);
  }
}));

// ---- stories ----------------------------------------------------------------------------------------------------------------

test('stories show their state, below-threshold as such, and a Live as not tracked', withInsights(async ({ insights, ref, get, rollups }) => {
  const seen = (id, over = {}) => insights.upsertMedia(ref, [{ id, kind: 'story', caption: '', permalink: '', thumbnailUrl: '', postedAt: new Date(NOW - HOUR), storyExpiresAt: NOW + DAY, ...over }]);
  const finalRef = (await seen('s1')).get('s1');
  await insights.saveSnapshot(finalRef, { slot: NOW, at: NOW, ageMinutes: 1400, metrics: { views: 7, link_clicks: 2 }, breakdowns: { navigation: { TAP_FORWARD: 3 } }, isFinal: true });
  await insights.closeStory(finalRef, 'final');

  const fewRef = (await seen('s2')).get('s2');
  await insights.saveSnapshot(fewRef, { slot: NOW, at: NOW, ageMinutes: 120, metrics: {}, breakdowns: {}, belowThreshold: true });
  await seen('live', { storyTracking: 'not_tracked' });

  await rollups((r) => r.write('funnel_daily', [{ day: dayBack(0), media_id: 's1', origin: 'bhava_page', source_label: 'bhava', visits: 4 }]));

  const body = await get('/stories');
  const byId = Object.fromEntries(body.items.map((s) => [s.id, s]));
  assert.deepEqual([byId.s1.finalState, byId.s1.metrics.link_clicks, byId.s1.navigation.TAP_FORWARD, byId.s1.bhavaVisits, byId.s1.source], ['final', 2, 3, 4, 'platform']);
  assert.deepEqual([byId.s2.belowThreshold, byId.s2.finalState, byId.s2.bhavaVisits], [true, 'open', null]);
  assert.equal(byId.live.tracking, 'not_tracked');
  assert.equal(body.discovery, 'unknown');
}));

// ---- top content --------------------------------------------------------------------------------------------------------------

test('N-20: two-tap reels rank by taps, and ties are broken by views', withInsights(async ({ insights, ref, get, rollups }) => {
  const posted = NOW - 10 * DAY;
  const snap = (views) => [[9 * 24 * 60, { views }]];
  await media(insights, ref, 'a', { postedAt: posted, snapshots: snap(100) });
  await media(insights, ref, 'b', { postedAt: posted, snapshots: snap(900) });
  await media(insights, ref, 'c', { postedAt: posted, snapshots: snap(50) });
  await media(insights, ref, 'one-tap', { postedAt: posted, snapshots: snap(9999) });
  const row = (id, taps, mode = 'two_tap') => ({ day: dayBack(9), media_id: id, link_mode: mode, origin: 'two_tap', source_label: 'bhava', content_kind: 'reel', taps });
  await rollups((r) => r.write('funnel_daily', [row('a', 12), row('b', 12), row('c', 30), row('one-tap', 99, 'one_tap')]));

  const body = await get('/top?rank=taps_or_visits&kind=reel&linkMode=two_tap&days=30');
  assert.deepEqual(body.items.map((i) => [i.mediaId, i.value]), [['c', 30], ['b', 12], ['a', 12]]);
  assert.equal(body.source, 'bhava');
}));

test('N-21: a 2-day-old reel and a 60-day-old reel are ranked on their day-2 snapshot', withInsights(async ({ insights, ref, get }) => {
  await media(insights, ref, 'young', { postedAt: NOW - 2 * DAY, snapshots: [[47 * 60, { views: 200 }]] });
  await media(insights, ref, 'old', { postedAt: NOW - 60 * DAY, snapshots: [[2 * 24 * 60, { views: 150 }], [59 * 24 * 60, { views: 90000 }]] });
  const body = await get('/top?rank=views&days=90');
  assert.equal(body.comparedAtAgeDays, 2);
  assert.deepEqual(body.items.map((i) => [i.mediaId, i.value, i.ageDays]), [['young', 200, 2], ['old', 150, 60]]);
  assert.equal(body.source, 'platform');
}));

test('a post with no snapshot from that age has no figure, and ranks after the ones that do', withInsights(async ({ insights, ref, get }) => {
  await media(insights, ref, 'young', { postedAt: NOW - 2 * DAY, snapshots: [[100, { views: 5 }]] });
  await media(insights, ref, 'only-late', { postedAt: NOW - 60 * DAY, snapshots: [[50 * 24 * 60, { views: 8000 }]] });
  const body = await get('/top?rank=views&days=90');
  assert.deepEqual(body.items.map((i) => [i.mediaId, i.value]), [['young', 5], ['only-late', null]]);
}));

test('a story doesn\'t drag every post down to its first day, unless stories are what was asked for', withInsights(async ({ insights, ref, get }) => {
  await media(insights, ref, 'post', { kind: 'feed', postedAt: NOW - 5 * DAY, snapshots: [[100, { views: 5 }]] });
  await insights.upsertMedia(ref, [{ id: 'story', kind: 'story', caption: '', permalink: '', thumbnailUrl: '', postedAt: new Date(NOW - HOUR), storyExpiresAt: NOW + DAY }]);
  assert.equal((await get('/top?days=30')).comparedAtAgeDays, 5);
  assert.deepEqual((await get('/top?kind=story&days=30')).items.map((i) => i.mediaId), ['story']);
}));

test('sales rank by money from one source, never added across sources', withInsights(async ({ insights, ref, get, rollups }) => {
  const posted = NOW - 5 * DAY;
  await media(insights, ref, 'store', { postedAt: posted });
  await media(insights, ref, 'site', { postedAt: posted });
  await rollups((r) => r.write('funnel_daily', [
    { day: dayBack(4), media_id: 'store', origin: 'bhava_store', source_label: 'bhava', revenue_paise: 50000 },
    { day: dayBack(4), media_id: 'site', origin: 'shopify', source_label: 'destination', revenue_paise: 90000 },
  ]));
  const body = await get('/top?rank=sales&days=30');
  assert.equal(body.source, 'bhava');
  assert.deepEqual(body.items.map((i) => [i.mediaId, i.value]), [['store', 50000], ['site', null]]);
}));

test('the module registers its minute poll, and leaves the funnel routes for their own track', async () => {
  const worked = [];
  const every = [];
  const schedule = insights.jobs({ db: {}, repos: {}, meta: {}, compliance: {}, config: {}, platform: { queue: { work: (name) => worked.push(name), every: async (name, ms) => every.push([name, ms]) } } });
  await schedule();
  assert.deepEqual(worked, ['insights.poll']);
  assert.deepEqual(every, [['insights.poll', MINUTE]]);
  const api = insights.api({ repos: {}, platform: {}, compliance: {}, config: {} });
  assert.throws(() => api['insights.funnel'](), (err) => err instanceof ApiError && err.code === 'not_implemented');
  assert.equal(typeof api['insights.account'], 'function');
});

test('sales are shown only to someone who may see money', async () => {
  const api = insightsApi({ repos: {}, platform: {}, compliance: {}, config: {} });
  await assert.rejects(() => api['insights.top']({ query: { rank: 'sales' }, user: { role: 'staff', permissions: ['analytics'] } }), (err) => err instanceof ApiError && err.code === 'forbidden' && err.message === FIGURE_TEXT.ownerOnly);
});

test('the free plan ranks only its last 7 days', withInsights(async ({ insights, ref, get }) => {
  await media(insights, ref, 'recent', { kind: 'feed', postedAt: NOW - 3 * DAY, snapshots: [[100, { views: 1 }]] });
  await media(insights, ref, 'older', { kind: 'feed', postedAt: NOW - 20 * DAY, snapshots: [[100, { views: 1 }]] });
  assert.deepEqual((await get('/top?days=30')).items.map((i) => i.mediaId), ['recent']);
  assert.deepEqual((await get('/media')).items.map((i) => i.id), ['recent']);
}, { plan: 'free' }));

// ---- best time ----------------------------------------------------------------------------------------------------------------

test('N-22: 8 posts and no online followers give no heatmap', withInsights(async ({ insights, ref, get }) => {
  for (let i = 0; i < 8; i++) await media(insights, ref, `p${i}`, { kind: 'feed', postedAt: NOW - (i + 1) * DAY, latest: { reach: 10 } });
  const body = await get('/best-time');
  assert.deepEqual([body.available, body.message, body.basis, body.cells], [false, FIGURE_TEXT.notEnoughPosts, null, []]);
}));

test('20 posts in 90 days give average reach by weekday and hour, in the business\'s time zone', withInsights(async ({ clock, insights, ref, get }) => {
  await insights.saveFollowers(ref, dayBack(0), 50, clock.t);
  // 2026-11-02T04:00Z is 09:30 Monday in Kolkata; every post lands at 09:30 on some weekday.
  for (let i = 0; i < 20; i++) await media(insights, ref, `p${i}`, { kind: 'feed', postedAt: Date.parse('2026-11-02T04:00:00Z') - i * DAY, latest: { reach: i % 2 ? 100 : 200 } });
  const body = await get('/best-time');
  assert.equal(body.available, true);
  assert.equal(body.basis, 'average_reach');
  assert.equal(body.timeZone, 'Asia/Kolkata');
  assert.equal(body.label, FIGURE_TEXT.suggested);
  const monday = body.cells.find((c) => c.weekday === 1 && c.hour === 9);
  assert.ok(monday);
  assert.equal(body.cells.length, 7);
  for (const cell of body.cells) assert.equal(cell.hour, 9);
}));

test('with 100 followers and online followers from Meta, those are the basis', withInsights(async ({ clock, insights, ref, get }) => {
  await insights.saveFollowers(ref, dayBack(0), 500, clock.t);
  await insights.saveOnlineFollowers(ref, [{ weekday: 2, hour: 18, value: 40 }], clock.t);
  const body = await get('/best-time');
  assert.deepEqual([body.available, body.basis, body.cells], [true, 'online_followers', [{ weekday: 2, hour: 18, value: 40 }]]);
}));

// ---- refresh now ----------------------------------------------------------------------------------------------------------------

test('N-36: a second tap within 15 minutes says how old the figures are and moves nothing', withInsights(async ({ app, sim, clock, insights, ref }) => {
  await app.db.platform.query(`INSERT INTO insight_polls (tenant_id, account_ref, job, call_class, next_due_at) VALUES ($1, $2, 'account_daily', 'insights', $3)`, [app.tenant.id, ref, new Date(clock.t + DAY).toISOString()]);
  await app.db.platform.query(`INSERT INTO insight_polls (tenant_id, account_ref, job, call_class, next_due_at) VALUES ($1, $2, 'demographics', 'insights', $3)`, [app.tenant.id, ref, new Date(clock.t + DAY).toISOString()]);
  await insights.markRefreshed(ref, clock.t - HOUR);

  const first = await ok(await app.api('POST', '/insights/refresh'));
  assert.equal(first.refreshed, true);
  assert.equal(+new Date(first.nextRefreshAt), clock.t + 15 * MINUTE);
  const due = async (job) => +new Date((await app.db.platform.query('SELECT next_due_at FROM insight_polls WHERE job = $1 AND account_ref = $2', [job, ref]))[0].next_due_at);
  assert.equal(await due('account_daily'), clock.t);
  assert.equal(await due('demographics'), clock.t + DAY, 'a weekly job stays weekly');

  clock.t += 5 * MINUTE;
  const second = await ok(await app.api('POST', '/insights/refresh'));
  assert.deepEqual([second.refreshed, second.message], [false, 'Updated 5 min ago']);
  assert.equal(+new Date(second.nextRefreshAt), first.nextRefreshAt ? +new Date(first.nextRefreshAt) : 0);
  assert.equal(+new Date(second.lastUpdatedAt), NOW - HOUR, 'how old the cache really is');
  assert.equal((await sim.calls({})).length, 0);

  clock.t += 11 * MINUTE;
  assert.equal((await ok(await app.api('POST', '/insights/refresh'))).refreshed, true);
}));

test('refresh respects a 4.3 pause, and doesn\'t use up the tap', withInsights(async ({ app, clock }) => {
  await app.db.platform.query(`INSERT INTO account_rate_state (tenant_id, channel, account_id, other_paused_until) VALUES ($1, 'instagram', $2, $3)`, [app.tenant.id, IG_ACCOUNT.igUserId, new Date(clock.t + 30 * MINUTE).toISOString()]);
  const paused = await ok(await app.api('POST', '/insights/refresh'));
  assert.equal(paused.refreshed, false);
  assert.equal(+new Date(paused.nextRefreshAt), clock.t + 30 * MINUTE);

  await app.db.platform.query('UPDATE account_rate_state SET other_paused_until = NULL WHERE account_id = $1', [IG_ACCOUNT.igUserId]);
  assert.equal((await ok(await app.api('POST', '/insights/refresh'))).refreshed, true);
}));

test('two simultaneous taps can only start one refresh', withInsights(async ({ app }) => {
  const results = await Promise.all([ok(await app.api('POST', '/insights/refresh')), ok(await app.api('POST', '/insights/refresh'))]);
  assert.equal(results.filter((r) => r.refreshed).length, 1);
}));

// ---- one business, one view -------------------------------------------------------------------------------------------------------

test('another business sees none of this, can\'t reach it by id, and its refresh is its own', withInsights(async ({ app, clock, insights, ref }) => {
  await insights.replaceDay(ref, dayBack(3), rowsFor('reach', 9), clock.t);
  await media(insights, ref, 'mine', { postedAt: NOW - DAY, latest: { views: 3 } });
  const other = await secondBusiness(app);

  assert.deepEqual((await ok(await other.api('GET', '/insights/media'))).items, []);
  assert.equal((await other.api('GET', '/insights/media/mine')).status, 404);
  const reach = (await ok(await other.api('GET', '/insights/account?range=7'))).metrics.find((m) => m.metric === 'reach');
  assert.equal(reach.total, null);
  assert.ok(reach.days.every((d) => d.value === null && d.state === 'not_collected'));
  assert.deepEqual((await ok(await other.api('GET', '/insights/status'))).connected, false);
  assert.equal((await ok(await other.api('POST', '/insights/refresh'))).refreshed, false);
  assert.equal((await ok(await app.api('POST', '/insights/refresh'))).refreshed, true);
}));

test('a business that hasn\'t connected gets empty answers, never an error or a zero', withInsights(async ({ app }) => {
  const other = await secondBusiness(app, 'fresh');
  for (const path of ['/top', '/stories', '/media', '/best-time', '/audience']) {
    const res = await other.api('GET', `/insights${path}`);
    assert.equal(res.status, 200, path);
  }
  assert.equal((await ok(await other.api('GET', '/insights/best-time'))).available, false);
  assert.equal((await ok(await other.api('GET', '/insights/audience'))).available, false);
  assert.equal((await ok(await other.api('GET', '/insights/top'))).comparedAtAgeDays, null);
}));

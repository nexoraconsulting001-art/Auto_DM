// PRD 7.5: top content and best time to post. N-20 to N-22.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, FIGURE_TEXT, addP2Shop, liveReel, unique, useP2World } from './support.js';

const world = useP2World();
const top = (shop, query) => shop.get('/insights/top', query, 'Top content');
const bestTime = (shop) => shop.get('/insights/best-time', undefined, 'Best time');

async function tappedReel(shop, { taps, views, ageDays = 5, linkMode = 'two_tap' }) {
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode });
  await shop.seedMedia({ mediaId: auto.mediaId, kind: 'reel', postedAgoMs: ageDays * DAY, latest: { views }, snapshots: [{ ageMinutes: 2 * 1440, metrics: { views } }] });
  await shop.seedFunnel(auto.mediaId, { taps, linkMode, day: ageDays - 1 });
  return auto.mediaId;
}

test('N-20: two-tap reels rank by taps over 30 days, ties broken by views', async () => {
  const shop = await addP2Shop(world);
  const most = await tappedReel(shop, { taps: 9, views: 10 });
  const tieLow = await tappedReel(shop, { taps: 5, views: 100 });
  const tieHigh = await tappedReel(shop, { taps: 5, views: 900 });
  await shop.settle({ ms: 2500, roundMs: 250 });
  const res = await top(shop, { rank: 'taps_or_visits', kind: 'reel', linkMode: 'two_tap', days: '30' });
  assert.deepEqual(res.items.map((i) => i.mediaId), [most, tieHigh, tieLow]);
  assert.deepEqual(res.items.map((i) => i.value), [9, 5, 5]);
  assert.equal(res.source, 'bhava');
});

test('N-20: one-tap reels are left out when asked for two-tap only, and a one-tap reel is never ranked as 0 taps', async () => {
  const shop = await addP2Shop(world);
  const two = await tappedReel(shop, { taps: 2, views: 10 });
  const one = await tappedReel(shop, { taps: 0, views: 9999, linkMode: 'one_tap' });
  await shop.settle({ ms: 2500, roundMs: 250 });
  const items = (await top(shop, { rank: 'taps_or_visits', linkMode: 'two_tap', days: '30' })).items;
  assert.deepEqual(items.map((i) => i.mediaId), [two]);
  const everyone = (await top(shop, { rank: 'taps_or_visits', linkMode: 'all', days: '30' })).items;
  const row = everyone.find((i) => i.mediaId === one);
  if (row) assert.equal(row.value, null, 'Not measured is not zero');
});

test('N-20: the 30-day window is exact: a reel posted inside it counts, one posted before it doesn\'t', async () => {
  const shop = await addP2Shop(world);
  const inside = await tappedReel(shop, { taps: 3, views: 1, ageDays: 29 });
  const outside = await tappedReel(shop, { taps: 8, views: 1, ageDays: 31 });
  await shop.settle({ ms: 2500, roundMs: 250 });
  const ids = (await top(shop, { rank: 'taps_or_visits', days: '30' })).items.map((i) => i.mediaId);
  assert.ok(ids.includes(inside));
  assert.equal(ids.includes(outside), false);
});

test('N-20: every rank and kind is accepted and nonsense isn\'t', async () => {
  const shop = await addP2Shop(world);
  for (const rank of ['views', 'reach', 'interactions', 'dms', 'taps_or_visits', 'sales']) assert.equal((await shop.raw('/insights/top', { rank })).status, 200, rank);
  for (const query of [{ rank: 'evil' }, { rank: "views' OR 1=1--" }, { days: '0' }, { days: '731' }, { days: 'x' }, { kind: 'evil' }, { linkMode: 'x' }, { limit: '0' }]) {
    assert.equal((await shop.raw('/insights/top', query)).status, 400, JSON.stringify(query));
  }
});

test('N-20: another business\'s content is never ranked', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const id = await tappedReel(a, { taps: 9, views: 9 });
  await a.settle({ ms: 2500, roundMs: 250 });
  assert.equal((await top(b, { rank: 'taps_or_visits', days: '30' })).items.some((i) => i.mediaId === id), false);
});

test('N-20: staff without revenue access can\'t rank by sales', async () => {
  const shop = await addP2Shop(world);
  const staff = await shop.addStaff(['analytics']);
  const res = await shop.as(staff.token, '/insights/top?rank=sales');
  if (res.status === 200) for (const item of res.json().items) assert.equal(item.value, null);
  else assert.equal(res.status, 403);
});

test('N-21: a 2-day-old reel and a 60-day-old reel are ranked on their day-2 figures and noted as compared at the same age', async () => {
  const shop = await addP2Shop(world);
  const young = `y${unique()}`;
  const old = `o${unique()}`;
  await shop.seedMedia({ mediaId: young, kind: 'reel', postedAgoMs: 2 * DAY + 60_000, latest: { views: 200 }, snapshots: [{ ageMinutes: 2 * 1440, metrics: { views: 200 } }] });
  await shop.seedMedia({ mediaId: old, kind: 'reel', postedAgoMs: 60 * DAY, latest: { views: 100000 }, snapshots: [{ ageMinutes: 1 * 1440, metrics: { views: 40 } }, { ageMinutes: 2 * 1440, metrics: { views: 100 } }, { ageMinutes: 30 * 1440, metrics: { views: 90000 } }] });
  const res = await top(shop, { rank: 'views', kind: 'reel', days: '90' });
  assert.equal(res.comparedAtAgeDays, 2);
  assert.deepEqual(res.items.map((i) => [i.mediaId, i.value]), [[young, 200], [old, 100]]);
});

test('N-21: the shared age is the youngest reel\'s, in whole days', async () => {
  const shop = await addP2Shop(world);
  await shop.seedMedia({ mediaId: `y${unique()}`, kind: 'reel', postedAgoMs: 5 * DAY + 3_600_000, latest: { views: 5 }, snapshots: [{ ageMinutes: 5 * 1440, metrics: { views: 5 } }] });
  await shop.seedMedia({ mediaId: `o${unique()}`, kind: 'reel', postedAgoMs: 20 * DAY, latest: { views: 9 }, snapshots: [{ ageMinutes: 5 * 1440, metrics: { views: 3 } }] });
  assert.equal((await top(shop, { rank: 'views', kind: 'reel', days: '30' })).comparedAtAgeDays, 5);
});

test('N-21: a reel with no snapshot near that age shows no value, rather than its lifetime total', async () => {
  const shop = await addP2Shop(world);
  await shop.seedMedia({ mediaId: `y${unique()}`, kind: 'reel', postedAgoMs: 2 * DAY + 60_000, latest: { views: 200 }, snapshots: [{ ageMinutes: 2 * 1440, metrics: { views: 200 } }] });
  const gap = `g${unique()}`;
  await shop.seedMedia({ mediaId: gap, kind: 'reel', postedAgoMs: 60 * DAY, latest: { views: 100000 }, snapshots: [{ ageMinutes: 45 * 1440, metrics: { views: 90000 } }] });
  const row = (await top(shop, { rank: 'views', kind: 'reel', days: '90' })).items.find((i) => i.mediaId === gap);
  assert.notEqual(row?.value, 100000, 'A lifetime total is never compared with a day-2 figure');
});

test('N-21: Meta\'s figures and Bhava\'s rank under their own labels', async () => {
  const shop = await addP2Shop(world);
  assert.equal((await top(shop, { rank: 'views' })).source, 'platform');
  assert.equal((await top(shop, { rank: 'taps_or_visits' })).source, 'bhava');
});

async function posts(shop, n, { ageDays = 10, reach = 100, kind = 'feed' } = {}) {
  for (let i = 0; i < n; i++) await shop.seedMedia({ mediaId: `p${i}x${unique()}`, kind, postedAgoMs: ageDays * DAY + i * 3_600_000, latest: { reach }, snapshots: [{ ageMinutes: 1440, metrics: { reach } }] });
}

test('N-22: 8 posts and no online_followers: Not enough posts yet, and no heatmap', async () => {
  const shop = await addP2Shop(world, { followers: 5000 });
  await posts(shop, 8);
  await shop.settle({ ms: 2000, roundMs: 200 });
  const res = await bestTime(shop);
  assert.equal(res.available, false);
  assert.equal(res.message, FIGURE_TEXT.notEnoughPosts);
  assert.deepEqual(res.cells, []);
});

for (const [n, available] of [[19, false], [20, true]]) {
  test(`N-22: with ${n} posts in 90 days average reach ${available ? 'gives suggested times' : 'is not enough'}`, async () => {
    const shop = await addP2Shop(world, { followers: 50 });
    await posts(shop, n);
    await shop.settle({ ms: 2000, roundMs: 200 });
    const res = await bestTime(shop);
    assert.equal(res.available, available);
    if (available) {
      assert.equal(res.basis, 'average_reach');
      assert.ok(res.cells.length > 0);
      assert.equal(res.label, FIGURE_TEXT.suggested);
    } else assert.deepEqual(res.cells, []);
  });
}

test('N-22: posts older than 90 days don\'t count towards the 20', async () => {
  const shop = await addP2Shop(world, { followers: 50 });
  await posts(shop, 15);
  await posts(shop, 15, { ageDays: 91 });
  await shop.settle({ ms: 2000, roundMs: 200 });
  assert.equal((await bestTime(shop)).available, false);
});

test('N-22: online_followers, when Meta gives it and there are 100 followers, is used with fewer than 20 posts, and marked Suggested', async () => {
  const shop = await addP2Shop(world, { followers: 500, timeZone: 'Asia/Kolkata' });
  await world.meta.post('/insights', { id: shop.igUserId, metrics: { online_followers: { 0: 10, 13: 40 } } });
  await shop.poll();
  const res = await bestTime(shop);
  assert.equal(res.available, true);
  assert.equal(res.basis, 'online_followers');
  assert.equal(res.timeZone, 'Asia/Kolkata');
  assert.equal(res.label, 'Suggested');
});

test('N-22: under 100 followers online_followers isn\'t used, even if Meta returns it', async () => {
  const shop = await addP2Shop(world, { followers: 99 });
  await world.meta.post('/insights', { id: shop.igUserId, metrics: { online_followers: { 0: 10, 13: 40 } } });
  await shop.poll();
  const res = await bestTime(shop);
  assert.equal(res.available, false);
  assert.deepEqual(res.cells, []);
});

test('N-22: the seller\'s time zone is the one shown and used for weekday and hour', async () => {
  const shop = await addP2Shop(world, { followers: 50, timeZone: 'Asia/Kolkata' });
  for (let i = 0; i < 20; i++) {
    // 20:00 UTC on a day is 01:30 the next day in India.
    const at = new Date(Date.now() - (i + 2) * DAY).setUTCHours(20, 0, 0, 0);
    await shop.seedMedia({ mediaId: `p${i}x${unique()}`, kind: 'feed', postedAgoMs: Date.now() - at, latest: { reach: 100 }, snapshots: [{ ageMinutes: 1440, metrics: { reach: 100 } }] });
  }
  await shop.settle({ ms: 2000, roundMs: 200 });
  const res = await bestTime(shop);
  assert.equal(res.timeZone, 'Asia/Kolkata');
  assert.deepEqual([...new Set(res.cells.map((c) => c.hour))], [1], JSON.stringify(res.cells.slice(0, 3)));
});

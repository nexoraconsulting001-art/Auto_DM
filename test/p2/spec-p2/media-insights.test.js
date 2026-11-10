// PRD 7.2: post, reel and carousel insights. N-06 to N-09.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_LIMITS, DAY, HOUR, INSIDE_MS, OUTSIDE_MS, addP2Shop, need, unique, useP2World } from './support.js';

const world = useP2World();

const list = (shop, query) => shop.get('/insights/media', query, 'The media list');
const detail = (shop, id) => shop.get(`/insights/media/${id}`, undefined, `Media ${id}`);
const reelMetrics = { views: 900, reach: 700, likes: 40, comments: 5, shares: 3, saved: 2, total_interactions: 50, reposts: 1, follows: 2, profile_visits: 9, ig_reels_avg_watch_time: 4200, ig_reels_video_view_total_time: 88000, reels_skip_rate: 31, crossposted_views: 12, profile_activity: { BIO_LINK_CLICKED: 3 } };

async function polledReel(shop, { ageMs = 3 * DAY, metrics = reelMetrics } = {}) {
  const id = await shop.reel({ id: `r${unique()}`, at: Date.now() - ageMs });
  await world.meta.post('/insights', { id, metrics });
  await shop.poll();
  return id;
}

async function byId(shop, id) {
  return (await shop.sql('SELECT * FROM insight_media WHERE tenant_id = $1 AND media_id = $2', [shop.tenantId, id]))[0];
}
const insightCallsFor = async (shop, id) => (await shop.metaCalls('*/insights')).filter((c) => c.path.includes(`/${id}/insights`));

test('N-06: a reel posted 3 days ago shows views, reach, engagement, watch time and skip rate, with the estimated ones labelled', async () => {
  const shop = await addP2Shop(world);
  const id = await polledReel(shop);
  const res = await detail(shop, id);
  assert.equal(res.kind, 'reel');
  assert.equal(res.source, 'platform');
  assert.ok(res.lastUpdatedAt, 'It shows when it was last updated');
  assert.deepEqual([res.metrics.views, res.metrics.reach, res.metrics.total_interactions], [900, 700, 50]);
  const named = Object.keys(res.metrics).join(' ');
  assert.match(named, /watch/, 'Watch time is shown');
  assert.match(named, /skip/, 'Skip rate is shown');
  for (const name of ['views', 'reach']) assert.ok(res.estimated.includes(name), `${name} is labelled estimated: ${res.estimated}`);
  assert.ok(res.estimated.some((n) => /watch/.test(n)), `Watch time is labelled estimated: ${res.estimated}`);
  assert.ok(res.estimated.some((n) => /skip/.test(n)), `Skip rate is labelled estimated: ${res.estimated}`);
  assert.equal(res.estimated.includes('likes'), false, 'A counted metric is not an estimate');
});

test('N-06: metrics without a breakdown go in one request per media, and profile_activity in its own', async () => {
  const shop = await addP2Shop(world);
  await shop.clearMetaCalls();
  const id = await polledReel(shop);
  const asked = await insightCallsFor(shop, id);
  const pollsOfIt = asked.filter((c) => !c.query.breakdown);
  const distinct = new Set(pollsOfIt.map((c) => c.query.metric));
  assert.equal(distinct.size, 1, `One batch of metrics, got ${[...distinct]}`);
  assert.equal(asked.filter((c) => c.query.metric === 'profile_activity' && c.query.breakdown === 'action_type').length, pollsOfIt.length);
  assert.doesNotMatch([...distinct][0], /profile_activity/);
});

test('N-06: a feed post is not asked for reel-only metrics, and Meta refuses none of the requests', async () => {
  const shop = await addP2Shop(world);
  const id = await shop.feedPost({ id: `p${unique()}` });
  await world.meta.post('/insights', { id, metrics: { views: 10, reach: 8 } });
  await shop.clearMetaCalls();
  await shop.poll();
  const asked = await insightCallsFor(shop, id);
  assert.ok(asked.length > 0);
  for (const call of asked) {
    assert.equal(call.status, 200, `Meta refused ${call.query.metric}`);
    assert.doesNotMatch(call.query.metric, /ig_reels|skip_rate|crossposted/);
  }
});

test('N-06: every fetch is one snapshot, and the growth line has one point each', async () => {
  const shop = await addP2Shop(world);
  const id = await polledReel(shop);
  await world.meta.post('/insights', { id, metrics: { ...reelMetrics, views: 1500 } });
  await world.travel(HOUR, { sim: true });
  await shop.poll();
  const growth = (await detail(shop, id)).growth.sort((a, b) => a.ageMinutes - b.ageMinutes);
  assert.ok(growth.length >= 2, `Two fetches give two points: ${growth.length}`);
  assert.equal(growth[0].metrics.views, 900);
  assert.equal(growth.at(-1).metrics.views, 1500);
  assert.equal((await detail(shop, id)).metrics.views, 1500, 'The list shows the latest');
});

test('N-06: Meta changing its mind overwrites the shown figure but the old snapshot stays', async () => {
  const shop = await addP2Shop(world);
  const id = await polledReel(shop);
  await world.meta.post('/insights', { id, metrics: { ...reelMetrics, views: 850 } });
  await world.travel(HOUR, { sim: true });
  await shop.poll();
  const res = await detail(shop, id);
  assert.equal(res.metrics.views, 850);
  assert.ok(res.growth.some((p) => p.metrics.views === 900), 'The earlier snapshot is kept');
});

test('N-06: a metric Meta returns empty is null on the screen, never 0', async () => {
  const shop = await addP2Shop(world);
  const id = await polledReel(shop, { metrics: { ...reelMetrics, shares: null } });
  const res = await detail(shop, id);
  assert.equal(res.metrics.shares ?? null, null);
});

for (const [label, fault] of [
  ['timing out', { kind: 'timeout', delayMs: 50 }],
  ['a 500', { kind: 'server_error', status: 500 }],
  ['an HTML page', { kind: 'malformed', mode: 'html' }],
  ['the wrong shape', { kind: 'malformed', mode: 'wrong_shape' }],
  ['half a body', { kind: 'malformed', mode: 'truncated' }],
  ['a dropped connection', { kind: 'drop' }],
]) {
  test(`N-06: Meta ${label} keeps the figures, adds no snapshot, and the poll stays on the schedule`, async () => {
    const shop = await addP2Shop(world);
    const id = await polledReel(shop);
    const before = (await detail(shop, id)).growth.length;
    await world.meta.fault({ ...fault, times: 'forever', match: { path: `*/${id}/insights` } });
    try {
      await world.travel(HOUR, { sim: true });
      await shop.poll();
    } finally {
      await world.meta.delete('/faults');
    }
    const res = await detail(shop, id);
    assert.equal(res.metrics.views, 900);
    assert.equal(res.growth.length, before, 'A failed fetch adds no snapshot');
    const media = await byId(shop, id);
    const [poll] = await shop.polls(`job = 'media' AND media_ref = $2`, [media.id]);
    assert.equal(poll.stopped_at, null);
    await shop.poll();
    assert.ok((await detail(shop, id)).growth.length > before, 'The next poll works');
  });
}

test('N-06: Meta answering with metrics it never had before is not stored as a column Bhava trusts: an unknown metric is ignored', async () => {
  const shop = await addP2Shop(world);
  const id = await shop.reel({ id: `r${unique()}`, at: Date.now() - DAY });
  await world.meta.fault({ kind: 'partial', status: 200, times: 'forever', match: { path: `*/${id}/insights` }, body: { data: [{ name: 'impressions', period: 'lifetime', values: [{ value: 5 }] }, { name: 'views', period: 'lifetime', values: [{ value: 7 }] }] } });
  try {
    await shop.poll();
  } finally {
    await world.meta.delete('/faults');
  }
  const media = await byId(shop, id);
  if (media) assert.equal(Object.hasOwn(media.latest, 'impressions'), false);
});

test('N-06: a media id is checked: another business\'s post and nonsense are 404 or 400, never 500', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const { mediaId } = await a.seedMedia({ mediaId: `a${unique()}`, latest: { views: 1 } });
  assert.equal((await b.raw(`/insights/media/${mediaId}`)).status, 404);
  for (const id of ["1'%20OR%201=1", '%00', 'x'.repeat(81), '..%2f..%2fetc', '%3Cscript%3E']) {
    const res = await a.raw(`/insights/media/${id}`);
    assert.ok([400, 404].includes(res.status), `${id} got ${res.status}`);
  }
});

test('N-06: the list filters by kind, hostile filters are refused, and paging walks everything once', async () => {
  const shop = await addP2Shop(world);
  for (let i = 0; i < 3; i++) await shop.seedMedia({ mediaId: `f${i}${unique()}`, kind: 'feed', latest: { views: i } });
  await shop.seedMedia({ mediaId: `r${unique()}`, kind: 'reel', latest: { views: 9 } });
  assert.equal((await list(shop, { kind: 'reel' })).items.length, 1);
  assert.equal((await list(shop, { kind: 'feed' })).items.length, 3);
  for (const query of [{ kind: 'evil' }, { kind: "reel' OR 1=1--" }, { limit: '0' }, { limit: '101' }, { limit: 'abc' }, { cursor: "';DROP" }, { cursor: 'x'.repeat(600) }, { includeDeleted: 'maybe' }]) {
    assert.equal((await shop.raw('/insights/media', query)).status, 400, JSON.stringify(query));
  }
  const seen = [];
  let cursor;
  do {
    const page = await list(shop, { limit: '2', cursor });
    seen.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 4);
});

test('N-06: a cursor from another business reveals nothing of theirs', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  for (let i = 0; i < 3; i++) await a.seedMedia({ mediaId: `a${i}${unique()}`, latest: { views: 1 } });
  await b.seedMedia({ mediaId: `b${unique()}`, latest: { views: 2 } });
  const page = await list(a, { limit: '1' });
  const res = await b.raw('/insights/media', { limit: '5', cursor: page.nextCursor });
  if (res.status === 200) for (const item of res.json().items) assert.ok(item.id.startsWith('b'), 'Only its own');
});

// Cadence: 7.8.
for (const [label, ageMs, everyMs] of [
  ['under 48h old', 47 * HOUR, ANALYTICS_LIMITS.mediaYoungEveryMs],
  ['just past 48h old', 49 * HOUR, ANALYTICS_LIMITS.mediaMidEveryMs],
  ['30 days old less a little', 29.9 * DAY, ANALYTICS_LIMITS.mediaMidEveryMs],
  ['just past 30 days old', 30.1 * DAY, ANALYTICS_LIMITS.mediaOldEveryMs],
  ['a year old', 365 * DAY, ANALYTICS_LIMITS.mediaOldEveryMs],
]) {
  test(`N-06: media ${label} is polled every ${everyMs / HOUR}h`, async () => {
    const shop = await addP2Shop(world);
    const id = await shop.reel({ id: `r${unique()}`, at: Date.now() - ageMs });
    await shop.poll();
    const media = await byId(shop, id);
    assert.ok(media, 'The media is in the cache');
    const [poll] = await shop.polls(`job = 'media' AND media_ref = $2`, [media.id]);
    const waitMs = new Date(poll.next_due_at) - new Date(poll.last_finished_at ?? poll.last_started_at);
    // The jitter across the hour is allowed for.
    assert.ok(waitMs >= everyMs - HOUR && waitMs <= everyMs + HOUR, `Next poll in ${waitMs / HOUR}h, expected about ${everyMs / HOUR}h`);
  });
}

// ---- N-07 ------------------------------------------------------------------------------------------------------------

test('N-07: a carousel is one album row, asked about by album id with no request per slide', async () => {
  const shop = await addP2Shop(world);
  const album = `al${unique()}`;
  const slides = [`s1${unique()}`, `s2${unique()}`, `s3${unique()}`];
  await shop.reel({ id: album, productType: 'FEED', mediaType: 'CAROUSEL_ALBUM', children: slides });
  await world.meta.post('/insights', { id: album, metrics: { views: 80, reach: 60 } });
  await shop.clearMetaCalls();
  await shop.poll();
  const items = (await list(shop, { kind: 'carousel' })).items;
  assert.deepEqual(items.map((i) => i.id), [album]);
  assert.equal(items[0].metrics.views, 80);
  const rows = await shop.sql('SELECT media_id, kind FROM insight_media WHERE tenant_id = $1', [shop.tenantId]);
  assert.deepEqual(rows, [{ media_id: album, kind: 'carousel' }]);
  const calls = await world.meta.calls({});
  for (const slide of slides) assert.deepEqual(calls.filter((c) => c.path.includes(slide)).map((c) => c.path), [], `No request for ${slide}`);
});

test('N-07: asking about an album is a fetch of the feed metrics only', async () => {
  const shop = await addP2Shop(world);
  const album = `al${unique()}`;
  await shop.reel({ id: album, productType: 'FEED', mediaType: 'CAROUSEL_ALBUM', children: [`s1${unique()}`] });
  await shop.clearMetaCalls();
  await shop.poll();
  for (const call of await insightCallsFor(shop, album)) {
    assert.equal(call.status, 200);
    assert.doesNotMatch(call.query.metric, /ig_reels|skip_rate/);
  }
});

// ---- N-08 ------------------------------------------------------------------------------------------------------------

test('N-08: media deleted on Instagram keeps its row and figures, is marked deleted, and polling stops', async () => {
  const shop = await addP2Shop(world);
  const id = await polledReel(shop);
  await world.meta.post('/media/delete', { id });
  await shop.poll();
  const res = await detail(shop, id);
  assert.equal(res.deleted, true);
  assert.equal(res.metrics.views, 900, 'It keeps its figures');
  const media = await byId(shop, id);
  assert.ok(media.deleted_at, 'The deletion is stored');
  const [poll] = await shop.polls(`job = 'media' AND media_ref = $2`, [media.id]);
  assert.ok(poll.stopped_at, 'The poll is stopped');
  await shop.clearMetaCalls();
  await shop.poll();
  assert.deepEqual(await insightCallsFor(shop, id), [], 'No further polls');
});

test('N-08: the list keeps deleted media by default and leaves it out when asked', async () => {
  const shop = await addP2Shop(world);
  const { mediaId } = await shop.seedMedia({ mediaId: `d${unique()}`, deletedAt: new Date(), latest: { views: 1 } });
  await shop.seedMedia({ mediaId: `k${unique()}`, latest: { views: 2 } });
  assert.equal((await list(shop)).items.find((i) => i.id === mediaId).deleted, true);
  assert.equal((await list(shop, { includeDeleted: 'false' })).items.some((i) => i.id === mediaId), false);
});

test('N-08: a timeout is not a deletion: only Meta saying the media is gone stops the poll', async () => {
  const shop = await addP2Shop(world);
  const id = await polledReel(shop);
  await world.meta.fault({ kind: 'server_error', status: 500, times: 'forever', match: { path: `*/${id}/insights` } });
  try {
    await shop.poll();
  } finally {
    await world.meta.delete('/faults');
  }
  assert.equal((await detail(shop, id)).deleted, false);
});

test('N-08: the same media id at another business is left alone', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const shared = `shared${unique()}`;
  await a.reel({ id: shared });
  await b.seedMedia({ mediaId: shared, latest: { views: 3 } });
  await world.meta.post('/media/delete', { id: shared });
  await a.poll();
  assert.equal((await detail(b, shared)).deleted, false);
});

test('N-08: deleted media is not an API error for Account Health', async () => {
  const shop = await addP2Shop(world);
  const id = await polledReel(shop);
  await world.meta.post('/media/delete', { id });
  await shop.poll();
  await shop.settle({ ms: 1500, roundMs: 200 });
  const health = await shop.health();
  assert.deepEqual(health.deductions.filter((d) => /api_errors/.test(d.code)), []);
});

// ---- N-09 ------------------------------------------------------------------------------------------------------------

async function manyMedia(shop, n, ageMs = () => DAY) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(await shop.feedPost({ id: `m${i}x${unique()}`, at: Date.now() - ageMs(i) }));
  return ids;
}

async function allListed(shop) {
  const ids = [];
  let cursor;
  do {
    const page = await list(shop, { limit: '100', cursor });
    ids.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

test('N-09: 300 media paginate fully: every one is listed once and the count matches Instagram', async () => {
  const shop = await addP2Shop(world);
  const ids = await manyMedia(shop, 300);
  await shop.poll({ jobs: ['media_list'], rounds: 6 });
  const listed = await allListed(shop);
  assert.equal(listed.length, 300);
  assert.deepEqual([...new Set(listed)].sort(), [...ids].sort());
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM insight_media WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(n, 300);
});

test('N-09: media within 2 years is kept and older media is not fetched, at the edge of the window', async () => {
  const shop = await addP2Shop(world);
  const inside = await shop.feedPost({ id: `in${unique()}`, at: Date.now() - ANALYTICS_LIMITS.mediaHistoryDays * DAY + INSIDE_MS * 2 });
  const outside = await shop.feedPost({ id: `out${unique()}`, at: Date.now() - ANALYTICS_LIMITS.mediaHistoryDays * DAY - OUTSIDE_MS * 60 });
  await shop.poll();
  const rows = (await shop.sql('SELECT media_id FROM insight_media WHERE tenant_id = $1', [shop.tenantId])).map((r) => r.media_id);
  assert.ok(rows.includes(inside), 'Just inside 2 years is listed');
  assert.equal(rows.includes(outside), false, 'Just past 2 years is not');
  for (const call of await shop.metaCalls(`*/${outside}/insights`)) assert.fail(`Meta was asked about media past 2 years: ${call.path}`);
});

test('N-09: Meta failing partway through the list loses nothing and adds no duplicates when it is run again', async () => {
  const shop = await addP2Shop(world);
  const ids = await manyMedia(shop, 150);
  await world.meta.fault({ kind: 'server_error', status: 500, times: 1, after: 1, match: { path: '*/media' } });
  await shop.poll({ jobs: ['media_list'], rounds: 2 });
  await world.meta.delete('/faults');
  await shop.poll({ jobs: ['media_list'], rounds: 4 });
  const [{ n, m }] = await shop.sql('SELECT count(*)::int AS n, count(DISTINCT media_id)::int AS m FROM insight_media WHERE tenant_id = $1', [shop.tenantId]);
  assert.deepEqual([n, m], [ids.length, ids.length]);
});

test('N-09: a page of junk from Meta adds nothing and doesn\'t lose what is there', async () => {
  const shop = await addP2Shop(world);
  const id = await shop.feedPost({ id: `j${unique()}` });
  await shop.poll({ jobs: ['media_list'] });
  await world.meta.fault({ kind: 'partial', status: 200, times: 'forever', match: { path: '*/media' }, body: { data: 'not a list', paging: { cursors: { after: null } } } });
  try {
    await shop.poll({ jobs: ['media_list'] });
  } finally {
    await world.meta.delete('/faults');
  }
  const rows = (await shop.sql('SELECT media_id, deleted_at FROM insight_media WHERE tenant_id = $1', [shop.tenantId]));
  assert.deepEqual(rows.map((r) => [r.media_id, r.deleted_at]), [[id, null]]);
});

test('N-09: two workers listing the same account at the same moment leave one row per media', async () => {
  const shop = await addP2Shop(world);
  await manyMedia(shop, 30);
  await shop.settle({ ms: 1500, roundMs: 200 });
  world.addWorker();
  await shop.sql(`UPDATE insight_polls SET next_due_at = now() - interval '1 second', lease_until = NULL WHERE tenant_id = $1 AND job = 'media_list'`, [shop.tenantId]);
  await world.tickTogether();
  await shop.settle({ ms: 4000, roundMs: 300 });
  const [{ n, m }] = await shop.sql('SELECT count(*)::int AS n, count(DISTINCT media_id)::int AS m FROM insight_media WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(n, m);
});

test('N-09: the list is polled on a schedule that picks up a post made since, without another request from the seller', async () => {
  const shop = await addP2Shop(world);
  await shop.poll({ jobs: ['media_list'] });
  const fresh = await shop.feedPost({ id: `new${unique()}` });
  await shop.poll({ jobs: ['media_list'] });
  need(await shop.raw(`/insights/media/${fresh}`), 200, 'The new post');
});

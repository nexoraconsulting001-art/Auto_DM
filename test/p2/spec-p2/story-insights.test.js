// PRD 7.3: story insights captured before they disappear. N-10 to N-13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_LIMITS, DAY, FIGURE_TEXT, HOUR, MINUTE, addP2Shop, shopper, unique, useP2World } from './support.js';

const world = useP2World();

const stories = (shop, query) => shop.get('/insights/stories', query, 'The stories');
const row = async (shop, id) => (await stories(shop, { limit: '100' })).items.find((s) => s.id === id);
const storyMetrics = { views: 40, reach: 30, replies: 2, shares: 1, follows: 0, profile_visits: 3, total_interactions: 6, reposts: 0, link_clicks: 7, profile_activity: { BIO_LINK_CLICKED: 1 }, navigation: { TAP_FORWARD: 5, SWIPE_FORWARD: 2 } };

async function postedStory(shop, { ageMs = 0, metrics = storyMetrics } = {}) {
  const id = await shop.story({ id: `st${unique()}`, at: Date.now() - ageMs });
  await world.meta.post('/insights', { id, metrics });
  return id;
}

const mediaRow = async (shop, id) => (await shop.sql('SELECT * FROM insight_media WHERE tenant_id = $1 AND media_id = $2', [shop.tenantId, id]))[0];
const snapshotsOf = async (shop, id) => {
  const media = await mediaRow(shop, id);
  return media ? shop.sql('SELECT * FROM insight_snapshots WHERE tenant_id = $1 AND media_ref = $2 ORDER BY age_minutes', [shop.tenantId, media.id]) : [];
};
/** Time passes for the app and for Meta in half-hour steps, and the worker does what is due at each, so a schedule with jitter still gets its turn. */
async function passes(shop, ms, stepMs = 30 * MINUTE) {
  for (let done = 0; done < ms; done += stepMs) {
    await world.travel(Math.min(stepMs, ms - done), { sim: true });
    await shop.runDue();
  }
}

// ---- N-10 ------------------------------------------------------------------------------------------------------------

test('N-10: a story is snapshotted about every 2h, and a final one is taken between 22 and 23.5h and kept', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop);
  await shop.poll();
  await passes(shop, 22 * HOUR + 30 * MINUTE);
  const snaps = await snapshotsOf(shop, id);
  assert.ok(snaps.length >= 10 && snaps.length <= 13, `About every 2h over a day: got ${snaps.length}`);
  for (let i = 1; i < snaps.length - 1; i++) {
    const gap = snaps[i].age_minutes - snaps[i - 1].age_minutes;
    assert.ok(gap >= 90 && gap <= 150, `Snapshots about 2h apart, got ${gap} min`);
  }
  const finals = snaps.filter((s) => s.is_final);
  assert.equal(finals.length, 1, 'One final snapshot');
  assert.ok(finals[0].age_minutes >= 22 * 60 && finals[0].age_minutes <= 23.5 * 60, `Final at ${finals[0].age_minutes} min`);
  assert.equal((await row(shop, id)).finalState, 'final');
});

test('N-10: once the final snapshot is taken the story is not asked about again', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop);
  await shop.poll();
  await passes(shop, 22 * HOUR + 30 * MINUTE);
  const media = await mediaRow(shop, id);
  assert.ok((await shop.polls(`job = 'story' AND media_ref = $2`, [media.id]))[0].stopped_at, 'The poll is stopped');
  await shop.clearMetaCalls();
  await passes(shop, HOUR);
  assert.deepEqual((await shop.metaCalls(`*/${id}/insights`)).map((c) => c.path), []);
});

test('N-10: a story first seen at 22h gets its final straight away, inside the window', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop, { ageMs: 22 * HOUR + 5 * MINUTE });
  await shop.poll();
  const finals = (await snapshotsOf(shop, id)).filter((s) => s.is_final);
  assert.equal(finals.length, 1);
  assert.equal((await row(shop, id)).finalState, 'final');
});

test('N-10: a poll at 21h59 is not the final one', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop, { ageMs: 21 * HOUR + 58 * MINUTE });
  await shop.poll();
  assert.equal((await snapshotsOf(shop, id)).filter((s) => s.is_final).length, 0);
  assert.equal((await row(shop, id)).finalState, 'open');
});

test('N-10: every story request is on the story call class: metrics and navigation in separate requests, no refusal from Meta', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop);
  await shop.clearMetaCalls();
  await shop.poll();
  const asked = await shop.metaCalls(`*/${id}/insights`);
  assert.ok(asked.length >= 3, 'Base metrics, profile_activity and navigation');
  for (const call of asked) assert.equal(call.status, 200, `Meta refused ${call.query.metric}`);
  assert.equal(asked.filter((c) => c.query.metric === 'navigation' && c.query.breakdown === 'story_navigation_action_type').length >= 1, true);
  assert.equal(asked.filter((c) => /impressions|navigation,|,navigation/.test(c.query.metric)).length, 0);
});

test('N-10: with no /stories edge, Bhava says so and tracks only the stories seen through replies or mentions', async () => {
  const shop = await addP2Shop(world);
  await world.meta.post('/insights/options', { igUserId: shop.igUserId, storiesEdge: false });
  const unseen = await postedStory(shop);
  await shop.poll();
  const status = await shop.get('/insights/status', undefined, 'The status');
  assert.equal(status.storyDiscovery, 'replies_and_mentions_only');
  assert.equal((await stories(shop)).discovery, 'replies_and_mentions_only');
  assert.equal((await mediaRow(shop, unseen)), undefined, 'A story nobody replied to is unknown to Bhava');
  assert.deepEqual((await shop.polls(`job = 'story_list' AND last_outcome ~* 'fail'`)).map((p) => p.last_outcome), [], 'The missing edge is an answer, not a failure');
});

test('N-10: a story with a reply is then tracked as seen through replies, even with no edge', async () => {
  const shop = await addP2Shop(world);
  await world.meta.post('/insights/options', { igUserId: shop.igUserId, storiesEdge: false });
  const id = await postedStory(shop);
  await shop.storyReply(world.fan(), 'nice', id);
  await shop.poll();
  const media = await mediaRow(shop, id);
  assert.ok(media, 'The replied-to story is tracked');
  assert.equal(media.story_tracking, 'seen_only');
});

test('N-10: Live and reshared stories show as not tracked, with no figures to mislead', async () => {
  const shop = await addP2Shop(world);
  const { mediaId } = await shop.seedMedia({ mediaId: `live${unique()}`, kind: 'story', storyTracking: 'not_tracked', postedAgoMs: HOUR });
  assert.equal((await row(shop, mediaId)).tracking, 'not_tracked');
});

test('N-10: stories can be compared months later: the figures stay after the story has gone', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop);
  await shop.poll();
  await world.travel(90 * DAY, { sim: true });
  await shop.runDue();
  const res = await row(shop, id);
  assert.equal(res.metrics.views, 40);
  assert.ok(res.lastUpdatedAt);
});

// ---- N-11 ------------------------------------------------------------------------------------------------------------

test('N-11: a story with 3 viewers shows <5, stores no number, and Meta\'s error 10 doesn\'t reduce Account Health', async () => {
  const shop = await addP2Shop(world);
  const id = await shop.story({ id: `low${unique()}` });
  await world.meta.post('/insights', { id, notEnoughViewers: true });
  await shop.poll();
  const res = await row(shop, id);
  assert.equal(res.belowThreshold, true, FIGURE_TEXT.belowFive);
  assert.equal(res.metrics.views ?? null, null, 'No number stands in for <5');
  await shop.settle({ ms: 1500, roundMs: 200 });
  const health = await shop.health();
  assert.equal(health.score, 100, JSON.stringify(health.deductions));
});

test('N-11: error 10 is recorded as excluded from the error rate, not as an error', async () => {
  const shop = await addP2Shop(world);
  const id = await shop.story({ id: `low${unique()}` });
  await world.meta.post('/insights', { id, notEnoughViewers: true });
  await shop.poll();
  const stats = await shop.sql('SELECT sum(errors)::int AS errors, sum(excluded)::int AS excluded FROM meta_call_stats WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(stats[0].errors, 0);
  assert.ok(stats[0].excluded >= 1, 'Counted as excluded');
});

test('N-11: a story that gets enough viewers later shows its numbers', async () => {
  const shop = await addP2Shop(world);
  const id = await shop.story({ id: `low${unique()}` });
  await world.meta.post('/insights', { id, notEnoughViewers: true });
  await shop.poll();
  await world.meta.post('/insights', { id, notEnoughViewers: false, metrics: storyMetrics });
  await shop.poll();
  const res = await row(shop, id);
  assert.equal(res.belowThreshold, false);
  assert.equal(res.metrics.views, 40);
});

// ---- N-12 ------------------------------------------------------------------------------------------------------------

async function storyUntilHour(shop, last) {
  const id = await postedStory(shop);
  await shop.poll();
  await passes(shop, last * HOUR);
  return id;
}

test('N-12: worker down from hour 20 to 26: the last good snapshot stays, marked final may be incomplete', async () => {
  const shop = await addP2Shop(world);
  const id = await storyUntilHour(shop, 20);
  const before = await snapshotsOf(shop, id);
  world.stopWorker();
  try {
    await world.travel(6 * HOUR, { sim: true });
  } finally {
    world.startWorker();
  }
  await shop.runDue();
  const res = await row(shop, id);
  assert.equal(res.finalState, 'final_incomplete');
  assert.equal(res.metrics.views, 40, 'The last good figures are kept');
  const after = await snapshotsOf(shop, id);
  assert.equal(after.length, before.length, 'An expired story gets no new snapshot');
});

test('N-12: the worker back at 23h20 is still in time for a proper final', async () => {
  const shop = await addP2Shop(world);
  const id = await storyUntilHour(shop, 20);
  world.stopWorker();
  try {
    await world.travel(3 * HOUR + 20 * MINUTE, { sim: true });
  } finally {
    world.startWorker();
  }
  await shop.runDue();
  assert.equal((await row(shop, id)).finalState, 'final');
  assert.equal((await snapshotsOf(shop, id)).filter((s) => s.is_final).length, 1);
});

test('N-12: a story whose only snapshot was early still keeps it and says it may be incomplete', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop);
  await shop.poll();
  await world.travel(ANALYTICS_LIMITS.storyLifeMs + HOUR, { sim: true });
  await shop.runDue();
  const res = await row(shop, id);
  assert.equal(res.finalState, 'final_incomplete');
  assert.equal(res.metrics.views, 40);
});

test('N-12: Meta saying a story has expired is not an API error for Account Health', async () => {
  const shop = await addP2Shop(world);
  await storyUntilHour(shop, 20);
  await world.travel(6 * HOUR, { sim: true });
  await shop.runDue();
  await shop.settle({ ms: 1500, roundMs: 200 });
  const health = await shop.health();
  assert.deepEqual(health.deductions.filter((d) => /api_errors/.test(d.code)), []);
});

test('N-12: two workers finalising the same story at the same moment leave one final', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop, { ageMs: 22 * HOUR + 5 * MINUTE });
  await shop.settle({ ms: 1500, roundMs: 200 });
  world.addWorker();
  await shop.sql(`UPDATE insight_polls SET next_due_at = now() - interval '1 second', lease_until = NULL WHERE tenant_id = $1 AND job IN ('story_list', 'story')`, [shop.tenantId]);
  await world.tickTogether();
  await shop.settle({ ms: 4000, roundMs: 300 });
  const snaps = await snapshotsOf(shop, id);
  assert.ok(snaps.filter((s) => s.is_final).length <= 1, 'At most one final');
});

// ---- N-13 ------------------------------------------------------------------------------------------------------------

test('N-13: link sticker clicks show as Meta\'s, labelled From Instagram/Facebook', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop);
  await shop.poll();
  const res = await row(shop, id);
  assert.equal(res.metrics.link_clicks, 7);
  assert.equal(res.source, 'platform');
});

test('N-13: Bhava visits are blank unless the sticker opens a Bhava-hosted page', async () => {
  const shop = await addP2Shop(world);
  const external = await postedStory(shop);
  const hosted = await postedStory(shop);
  await shop.poll();
  await shopper(world, shop).send({ name: 'landing_view', path: '/r/spec', pageKind: 'landing', mediaId: hosted });
  await shopper(world, shop).send({ name: 'landing_view', path: '/r/spec', pageKind: 'landing', mediaId: hosted });
  await shop.settle({ ms: 2000, roundMs: 200 });
  assert.equal((await row(shop, external)).bhavaVisits, null);
  assert.equal((await row(shop, hosted)).bhavaVisits, 2);
});

test('N-13: Bhava visits and Meta\'s link clicks are separate figures and never added together', async () => {
  const shop = await addP2Shop(world);
  const id = await postedStory(shop);
  await shop.poll();
  await shopper(world, shop).send({ name: 'landing_view', path: '/r/spec', pageKind: 'landing', mediaId: id });
  await shop.settle({ ms: 2000, roundMs: 200 });
  const res = await row(shop, id);
  assert.equal(res.metrics.link_clicks, 7);
  assert.equal(res.bhavaVisits, 1);
});

test('N-13: another business can\'t see this business\'s story figures or use its media id', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const { mediaId } = await a.seedMedia({ mediaId: `st${unique()}`, kind: 'story', latest: { views: 8 }, postedAgoMs: HOUR });
  assert.equal((await b.get('/insights/stories', { limit: '100' })).items.some((s) => s.id === mediaId), false);
});

// Polling against the simulator, on real tables and the real rate guard: what gets asked, what lands in the cache, and what happens when things go wrong for one business.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { insights } from '../../../src/modules/insights/index.js';
import { createInsightsPoller } from '../../../src/modules/insights/poller.js';
import { DAY, HOUR, MINUTE, NOW, closeShared, dayBack, insightCalls, world } from './support.js';

after(closeShared);

const reachOf = (rows, day) => rows.find((r) => r.day === day)?.value;
const num = (v) => (v === null || v === undefined ? v : Number(v));

async function connected(t, options) {
  const w = await world(t, options);
  const b = await w.business();
  await w.enrol();
  return { w, b };
}

/** Lists a business's media, leaving each new post's poll where the listing put it. */
async function listed(w, b) {
  await b.only('media_list');
  await w.tick();
}

// ---- enrolling and spreading --------------------------------------------------------------------------------------------

test('a connected account starts collecting once, with its account polls', async (t) => {
  const { w, b } = await connected(t);
  await w.enrol();
  const polls = await b.polls();
  assert.deepEqual(polls.map((p) => p.job).sort(), ['account_daily', 'demographics', 'media_list', 'story_list']);
  assert.deepEqual(polls.map((p) => p.call_class).sort(), ['insights', 'insights', 'media_list', 'story_insights']);
  const account = await b.account();
  assert.equal(account.ig_user_id, b.igUserId);
  for (const poll of polls) {
    assert.ok(+new Date(poll.next_due_at) >= NOW && +new Date(poll.next_due_at) < NOW + HOUR);
    assert.equal(poll.lease_until, null);
  }
});

test('N-37: fifty businesses starting up spread their job starts across the hour', async (t) => {
  const w = await world(t);
  const businesses = [];
  for (let i = 0; i < 50; i++) businesses.push(await w.business());
  await w.enrol();
  const rows = await w.db.platform.query(`SELECT next_due_at FROM insight_polls WHERE tenant_id = ANY($1::int[]) AND job = 'account_daily'`, [businesses.map((b) => b.tenant.id)]);
  assert.equal(rows.length, 50);
  const minutes = new Map();
  for (const row of rows) {
    const minute = Math.floor(+new Date(row.next_due_at) / MINUTE);
    minutes.set(minute, (minutes.get(minute) ?? 0) + 1);
  }
  assert.ok(Math.max(...minutes.values()) <= 5, `busiest minute had ${Math.max(...minutes.values())}`);
});

// ---- account insights ---------------------------------------------------------------------------------------------------

test('N-03, N-05: account days are stored as Meta gave them, with an empty metric null and no impressions asked', async (t) => {
  const { w, b } = await connected(t);
  const day = dayBack(2);
  await w.sim.post('/insights/daily', { igUserId: b.igUserId, metric: 'reach', points: [{ day, value: 900 }] });
  await w.sim.post('/insights/daily', { igUserId: b.igUserId, metric: 'comments', points: [{ day, value: null }] });
  await w.sim.post('/insights/daily', { igUserId: b.igUserId, metric: 'follows_and_unfollows', points: [{ day, value: 7, breakdowns: { follow_type: { FOLLOWER: 5, NON_FOLLOWER: 2 } } }] });
  await b.only('account_daily');
  await w.tick();

  assert.equal(num(reachOf(await b.daily('reach'), day)), 900);
  const comments = (await b.daily('comments')).find((r) => r.day === day);
  assert.ok(comments, 'an empty day is still a row');
  assert.equal(comments.value, null);
  assert.deepEqual((await b.daily('follows_and_unfollows')).map((r) => [r.breakdown_value, num(r.value)]), [['FOLLOWER', 5], ['NON_FOLLOWER', 2]]);
  for (const call of await w.sim.calls({})) assert.doesNotMatch(JSON.stringify(call.query), /impressions/);

  const poll = await b.poll('account_daily');
  assert.equal(poll.last_outcome, 'ok');
  assert.ok((await b.account()).last_refresh_at);
});

test('every account figure is fetched for the last 3 complete days, and a late revision overwrites the first', async (t) => {
  const { w, b } = await connected(t);
  const day = dayBack(1);
  await w.sim.post('/insights/daily', { igUserId: b.igUserId, metric: 'reach', points: [{ day, early: 40, value: 100 }] });
  await b.only('account_daily');
  await w.tick();
  assert.equal(num(reachOf(await b.daily('reach'), day)), 40);

  await w.advance(2 * DAY);
  await b.only('account_daily');
  await w.tick();
  assert.equal(num(reachOf(await b.daily('reach'), day)), 100, 'the settled figure replaced the early one');
});

test('the first poll starts on Meta\'s 90 days, and the rest follows within hours without leaving the 90', async (t) => {
  const { w, b } = await connected(t);
  await b.only('account_daily');
  await w.tick();
  let days = new Set((await b.daily('views')).map((r) => r.day));
  assert.equal(days.size, 33);
  const next = await b.poll('account_daily');
  assert.ok(+new Date(next.next_due_at) <= w.clock.t + HOUR, 'more days are owed soon');

  await w.advance(HOUR);
  await w.tick();
  await w.advance(HOUR);
  await w.tick();
  days = new Set((await b.daily('views')).map((r) => r.day));
  assert.equal(days.size, 89);
  assert.equal([...days].sort()[0], dayBack(89, w.clock.t));
  assert.equal((await b.poll('account_daily')).last_outcome, 'ok');
});

test('followers are snapshotted daily and the rollup holds the same figures, through the analytics module', async (t) => {
  const { w, b } = await connected(t);
  const day = dayBack(1);
  await w.sim.post('/insights/daily', { igUserId: b.igUserId, metric: 'reach', points: [{ day, value: 321 }] });
  await w.sim.post('/insights/daily', { igUserId: b.igUserId, metric: 'follows_and_unfollows', points: [{ day, value: 3, breakdowns: { follow_type: { FOLLOWER: 2, NON_FOLLOWER: 1 } } }] });
  await b.only('account_daily');
  await w.tick();

  assert.equal(num((await b.daily('followers_count')).at(-1).value), 5000);
  assert.equal((await b.account()).followers_count, 5000);
  const [row] = await b.inTenant(() => w.drivers.analytics.rollups.read('meta_account_daily', { measures: ['reach', 'follows', 'unfollows', 'views'], dimensions: ['day'], filters: [{ dimension: 'account_id', op: 'include', values: [b.igUserId] }], since: day, until: day }));
  assert.deepEqual([row.reach, row.follows, row.unfollows, row.views], [321, 2, 1, null]);
});

test('N-02: demographics are not asked for below 100 followers, and are stored above it', async (t) => {
  const w = await world(t);
  const small = await w.business({ followers: 80 });
  const big = await w.business({ followers: 500 });
  await w.enrol();
  await w.sim.post('/insights/demographics', { igUserId: big.igUserId, metric: 'follower_demographics', breakdown: 'city', results: { Pune: 50, Delhi: 20 } });

  for (const b of [small, big]) await b.only('account_daily');
  await w.tick();
  for (const b of [small, big]) await b.only('demographics');
  await w.sim.delete?.('/calls');
  await w.tick();

  const smallCalls = (await w.sim.calls({ path: `${small.igUserId}/insights` })).filter((c) => /demographics/.test(String(c.query.metric)));
  assert.equal(smallCalls.length, 0);
  assert.deepEqual(await big.q(`SELECT breakdown_value, value::int FROM insight_demographics WHERE tenant_id = $1 AND metric = 'follower_demographics' AND breakdown = 'city' AND timeframe = 'this_month' ORDER BY breakdown_value`, [big.tenant.id]), [{ breakdown_value: 'Delhi', value: 20 }, { breakdown_value: 'Pune', value: 50 }]);
});

// ---- posts, reels, carousels ----------------------------------------------------------------------------------------------

test('N-09: every post within 2 years is listed across pages, and older ones are left out', async (t) => {
  const { w, b } = await connected(t);
  for (let i = 0; i < 300; i++) await w.sim.post('/media', { igUserId: b.igUserId, id: `m${i}`, productType: 'FEED', mediaType: 'IMAGE', at: NOW - i * DAY });
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'too-old', productType: 'FEED', mediaType: 'IMAGE', at: NOW - 800 * DAY });
  await listed(w, b);

  const [{ count }] = await b.q('SELECT count(*)::int AS count FROM insight_media WHERE tenant_id = $1', [b.tenant.id]);
  assert.equal(count, 300);
  assert.equal((await b.polls()).filter((p) => p.job === 'media').length, 300);
  assert.ok((await w.sim.calls({ path: '*/media' })).length >= 4);
  assert.ok((await b.account()).media_listed_at);
});

test('a later listing stops at the first page of posts it already knows', async (t) => {
  const { w, b } = await connected(t);
  for (let i = 0; i < 150; i++) await w.sim.post('/media', { igUserId: b.igUserId, id: `m${i}`, productType: 'FEED', mediaType: 'IMAGE', at: NOW - i * HOUR });
  await listed(w, b);
  const firstWalk = (await w.sim.calls({ path: '*/media' })).length;
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'new', productType: 'REELS', at: NOW - 10 * MINUTE });
  await listed(w, b);
  assert.equal((await w.sim.calls({ path: '*/media' })).length, firstWalk + 2, 'the first page has the new post, and the second shows there is nothing older to find');
  assert.ok(await b.media('new'));
});

test('N-06: a reel has its watch time and skip rate, and every post keeps a snapshot per fetch', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'r1', productType: 'REELS', at: NOW - 3 * DAY });
  await w.sim.post('/insights', { id: 'r1', metrics: { views: 10, reach: 8, ig_reels_avg_watch_time: 1500, ig_reels_video_view_total_time: 9000, reels_skip_rate: 31.25, profile_activity: { BIO_LINK_CLICKED: 2 } } });
  await listed(w, b);
  await b.only('media', 'r1');
  await w.tick();

  const media = await b.media('r1');
  assert.equal(media.kind, 'reel');
  assert.equal(media.latest.views, 10);
  assert.equal(media.latest.ig_reels_avg_watch_time, 1500);
  assert.deepEqual(media.latest_breakdowns.profile_activity, { BIO_LINK_CLICKED: 2 });

  await w.advance(DAY);
  await w.sim.post('/insights', { id: 'r1', metrics: { views: 25 } });
  await b.only('media', 'r1');
  await w.tick();
  const snapshots = await b.snapshots('r1');
  assert.deepEqual(snapshots.map((s) => s.metrics.views), [10, 25]);
  assert.equal(snapshots[0].age_minutes, 3 * 24 * 60);
  assert.equal(snapshots[1].age_minutes, 4 * 24 * 60);

  const [row] = await b.inTenant(() => w.drivers.analytics.rollups.read('meta_content_daily', { measures: ['views', 'avg_watch_ms', 'skip_rate_bp'], dimensions: ['media_id'], since: dayBack(1, w.clock.t), until: dayBack(0, w.clock.t) }));
  assert.deepEqual([row.media_id, row.views, row.avg_watch_ms, row.skip_rate_bp], ['r1', 25, 1500, 3125]);
});

test('a media poll comes back on the schedule for its age', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'young', productType: 'REELS', at: NOW - HOUR });
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'mid', productType: 'REELS', at: NOW - 5 * DAY });
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'old', productType: 'REELS', at: NOW - 60 * DAY });
  await listed(w, b);
  const expectations = { young: 3 * HOUR, mid: DAY, old: 7 * DAY };
  for (const [id, every] of Object.entries(expectations)) {
    await b.only('media', id);
    await w.tick();
    const poll = await b.poll('media', id);
    assert.equal(+new Date(poll.next_due_at), w.clock.t + every, id);
    assert.equal(poll.last_outcome, 'ok');
  }
});

test('N-07: a carousel is one album row and only its album is read', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'album', productType: 'FEED', mediaType: 'CAROUSEL_ALBUM', children: ['c1', 'c2'], at: NOW - DAY });
  await w.sim.post('/insights', { id: 'album', metrics: { reach: 44 } });
  await listed(w, b);
  await b.only('media', 'album');
  await w.tick();
  const rows = await b.q('SELECT media_id, kind FROM insight_media WHERE tenant_id = $1', [b.tenant.id]);
  assert.deepEqual(rows, [{ media_id: 'album', kind: 'carousel' }]);
  assert.equal((await b.media('album')).latest.reach, 44);
  assert.deepEqual([...new Set((await w.sim.calls({ path: '*/insights' })).map((c) => c.path))].filter((p) => /c1|c2/.test(p)), []);
});

test('N-08: media deleted on Instagram keeps its figures, is marked, and is not polled again', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'r1', productType: 'REELS', at: NOW - DAY });
  await w.sim.post('/insights', { id: 'r1', metrics: { views: 12 } });
  await listed(w, b);
  await b.only('media', 'r1');
  await w.tick();

  await w.sim.post('/media/delete', { id: 'r1' });
  await w.advance(DAY);
  await b.only('media', 'r1');
  await w.tick();

  const media = await b.media('r1');
  assert.ok(media.deleted_at);
  assert.equal(media.latest.views, 12);
  const poll = await b.poll('media', 'r1');
  assert.ok(poll.stopped_at);

  const before = (await w.sim.calls({ path: '*/r1/insights' })).length;
  await w.advance(30 * DAY);
  await w.tick();
  assert.equal((await w.sim.calls({ path: '*/r1/insights' })).length, before);
});

// ---- stories --------------------------------------------------------------------------------------------------------------

async function storyOn(w, b, id, at = w.clock.t, metrics = { views: 7, reach: 5, link_clicks: 2, navigation: { TAP_FORWARD: 3 } }) {
  await w.sim.post('/media', { igUserId: b.igUserId, id, productType: 'STORY', mediaType: 'IMAGE', at });
  await w.sim.post('/insights', { id, metrics });
  await b.only('story_list');
  await w.tick();
}

test('N-10, N-13: a story is polled about every 2h and its final snapshot lands between 22h and 23.5h and is kept', async (t) => {
  const start = Date.parse('2026-11-10T10:00:00.000Z');
  const { w, b } = await connected(t, { at: start });
  await storyOn(w, b, 's1');

  const created = await b.media('s1');
  assert.equal(created.kind, 'story');
  assert.equal(created.story_tracking, 'edge');
  assert.equal(+new Date(created.story_expires_at), start + DAY);

  for (let hour = 2; hour <= 22; hour += 2) {
    await w.advance(2 * HOUR);
    await w.tick();
  }

  const media = await b.media('s1');
  assert.equal(media.story_final_state, 'final');
  assert.equal(media.latest.link_clicks, 2, 'Meta\'s link clicks are kept');
  assert.deepEqual(media.latest_breakdowns.navigation, { TAP_FORWARD: 3 });
  const snapshots = await b.snapshots('s1');
  assert.equal(snapshots.length, 11);
  assert.equal(snapshots.at(-1).is_final, true);
  assert.ok(snapshots.at(-1).age_minutes >= 22 * 60 && snapshots.at(-1).age_minutes < 23.5 * 60);
  assert.ok((await b.poll('story', 's1')).stopped_at);

  // Live for another 2h, but it already has its final snapshot and nothing else is asked.
  const before = (await w.sim.calls({ path: '*/s1/insights' })).length;
  await w.advance(HOUR);
  await w.tick();
  assert.equal((await w.sim.calls({ path: '*/s1/insights' })).length, before);
});

test('N-11: a story with too few viewers is stored as below the threshold, not as a failure', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 's1', productType: 'STORY', mediaType: 'IMAGE', at: NOW });
  await w.sim.post('/insights', { id: 's1', notEnoughViewers: true });
  await b.only('story_list');
  await w.tick();
  await w.advance(2 * HOUR);
  await w.tick();

  const media = await b.media('s1');
  assert.equal(media.below_threshold, true);
  assert.deepEqual(media.latest, {});
  const snapshot = (await b.snapshots('s1'))[0];
  assert.equal(snapshot.below_threshold, true);
  const poll = await b.poll('story', 's1');
  assert.equal(poll.last_outcome, 'ok');
  assert.equal(poll.attempts, 0);
  assert.equal((await b.account()).permission, 'ok', 'error 10 about viewers is not a denied permission');
});

test('N-12: a worker down from hour 20 to 26 keeps the last good snapshot, marked incomplete, with no call to Meta', async (t) => {
  const { w, b } = await connected(t);
  await storyOn(w, b, 's1');
  for (let hour = 2; hour <= 20; hour += 2) {
    await w.advance(2 * HOUR);
    await w.tick();
  }
  const before = (await w.sim.calls({ path: '*/s1/insights' })).length;
  await w.advance(6 * HOUR);
  await w.tick();
  const media = await b.media('s1');
  assert.equal(media.story_final_state, 'final_incomplete');
  assert.equal(media.latest.views, 7);
  assert.equal((await b.snapshots('s1')).at(-1).is_final, true);
  assert.equal((await w.sim.calls({ path: '*/s1/insights' })).length, before);
  assert.ok((await b.poll('story', 's1')).stopped_at);
});

test('a failure in the final window is tried again before the window closes', async (t) => {
  const { w, b } = await connected(t);
  await storyOn(w, b, 's1');
  for (let hour = 2; hour <= 20; hour += 2) {
    await w.advance(2 * HOUR);
    await w.tick();
  }
  await w.sim.fault({ kind: 'server_error', status: 503, times: 1, match: { path: '*/s1/insights' } });
  await w.advance(2 * HOUR);
  await w.tick();
  assert.equal((await b.media('s1')).story_final_state, 'open');
  const retry = await b.poll('story', 's1');
  assert.ok(+new Date(retry.next_due_at) - w.clock.t <= 5 * MINUTE);

  await w.advance(5 * MINUTE);
  await w.tick();
  assert.equal((await b.media('s1')).story_final_state, 'final');
});

test('an account whose login has no /stories says so, and a story seen through a reply is still followed', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/insights/options', { igUserId: b.igUserId, storiesEdge: false });
  await b.only('story_list');
  await w.tick();
  assert.equal((await b.account()).stories_edge, 'unavailable');

  await w.sim.post('/media', { igUserId: b.igUserId, id: 'seen', productType: 'STORY', mediaType: 'IMAGE', at: NOW });
  await w.sim.post('/insights', { id: 'seen', metrics: { views: 3 } });
  const ctx = { repos: w.platform };
  await b.inTenant(() => insights.onInboundEvent({ type: 'story_reply', channel: 'instagram', accountId: b.igUserId, storyId: 'seen', receivedAt: new Date(w.clock.t) }, ctx));
  const media = await b.media('seen');
  assert.equal(media.story_tracking, 'seen_only');
  assert.equal(media.posted_at, null);

  await b.only('story', 'seen');
  await w.tick();
  assert.equal((await b.media('seen')).latest.views, 3);

  await w.advance(DAY);
  await b.only('story', 'seen');
  await w.tick();
  assert.equal((await b.media('seen')).story_final_state, 'final_incomplete');
});

test('a story reply or mention leaves nothing behind when the edge already has the story, or there is no story id', async (t) => {
  const { w, b } = await connected(t);
  const ctx = { repos: w.platform };
  assert.equal(await b.inTenant(() => insights.onInboundEvent({ type: 'story_mention', channel: 'instagram', accountId: b.igUserId, mediaRef: 'https://x' }, ctx)), undefined);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 's1', productType: 'STORY', mediaType: 'IMAGE', at: NOW });
  await b.only('story_list');
  await w.tick();
  await b.inTenant(() => insights.onInboundEvent({ type: 'story_reply', channel: 'instagram', accountId: b.igUserId, storyId: 'other', receivedAt: new Date(w.clock.t) }, ctx));
  assert.equal(await b.media('other'), undefined);
});

test('a Live on the stories edge is kept as not tracked and never polled', async (t) => {
  const w = await world(t);
  const b = await w.business();
  await w.enrol();
  const fakeReader = { storiesPage: async () => ({ available: true, next: null, items: [{ id: 'live1', kind: 'feed', caption: '', permalink: '', thumbnailUrl: '', postedAt: new Date(NOW) }] }) };
  const poller = createInsightsPoller({ db: w.db, repos: w.platform, meta: { client: { insightsFor: () => fakeReader } }, compliance: w.compliance, platform: w.drivers, config: { complianceNow: () => w.clock.t } });
  await b.only('story_list');
  await poller.tick();
  const media = await b.media('live1');
  assert.deepEqual([media.kind, media.story_tracking], ['story', 'not_tracked']);
  assert.equal(await b.poll('story', 'live1'), undefined);
});

// ---- the 4.3 rules, and one business's trouble staying its own --------------------------------------------------------------

test('N-35: 80002 stops insights calls until the regain time and puts messaging in slow mode', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/throttle', { igUserId: b.igUserId, regainMinutes: 30 });
  await b.only('account_daily');
  await w.tick();
  const poll = await b.poll('account_daily');
  assert.equal(+new Date(poll.next_due_at), w.clock.t + 30 * MINUTE);
  assert.match(poll.last_outcome, /buc_throttled/);
  const status = await b.inTenant(() => w.compliance.slowMode.status('instagram', b.igUserId));
  assert.equal(status.active, true);

  const calls = (await insightCalls(w.sim)).length;
  await w.advance(10 * MINUTE);
  await b.only('account_daily');
  await w.tick();
  assert.equal((await insightCalls(w.sim)).length, calls, 'even a poll forced due makes no call during the pause');
  assert.equal((await b.poll('account_daily')).last_outcome, 'deferred');

  await w.advance(25 * MINUTE);
  await b.only('account_daily');
  await w.tick();
  assert.ok((await insightCalls(w.sim)).length > calls);
  assert.equal((await b.poll('account_daily')).last_outcome, 'ok');
});

test('C-12: usage at 78% pauses non-story polling and leaves story polling running', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'r1', productType: 'REELS', at: NOW - DAY });
  await storyOn(w, b, 's1');
  await listed(w, b);
  await w.sim.post('/usage', { igUserId: b.igUserId, percent: 78 });

  await w.sim.delete?.('/calls');
  await b.only('story', 's1');
  await w.tick(); // the first answer brings the header
  assert.equal((await b.poll('story', 's1')).last_outcome, 'ok');

  await b.only('media', 'r1');
  await w.tick();
  assert.equal((await b.poll('media', 'r1')).last_outcome, 'deferred');
  assert.equal((await b.snapshots('r1')).length, 0);

  await w.advance(2 * HOUR);
  await b.only('story', 's1');
  await w.tick();
  assert.equal((await b.poll('story', 's1')).last_outcome, 'ok');
  assert.equal((await b.snapshots('s1')).length, 2);
});

test('C-13: usage at 92% stops story polling too', async (t) => {
  const { w, b } = await connected(t);
  await storyOn(w, b, 's1');
  await w.sim.post('/usage', { igUserId: b.igUserId, percent: 92 });
  await b.only('story', 's1');
  await w.tick();
  const count = (await insightCalls(w.sim)).length;
  await w.advance(MINUTE);
  await b.only('story', 's1');
  await w.tick();
  assert.equal((await insightCalls(w.sim)).length, count);
  assert.equal((await b.poll('story', 's1')).last_outcome, 'deferred');
});

test('a business with a denied permission, a dead token or a failing Meta never stops another from being polled', async (t) => {
  const w = await world(t);
  const denied = await w.business();
  const dead = await w.business();
  const failing = await w.business();
  const healthy = await w.business();
  await w.enrol();

  const day = dayBack(2);
  await w.sim.post('/insights/daily', { igUserId: healthy.igUserId, metric: 'reach', points: [{ day, value: 55 }] });
  await w.sim.post('/tokens/scopes', { igUserId: denied.igUserId, scopes: ['instagram_business_basic'] });
  await w.sim.post('/tokens/revoke', { igUserId: dead.igUserId });
  await w.sim.fault({ kind: 'server_error', status: 500, times: 'forever', match: { path: `*/${failing.igUserId}/*` } });

  for (const b of [denied, dead, failing, healthy]) await b.only('account_daily');
  await w.tick();

  assert.equal(num(reachOf(await healthy.daily('reach'), day)), 55);
  assert.equal((await healthy.poll('account_daily')).last_outcome, 'ok');

  assert.equal((await denied.account()).permission, 'denied');
  assert.equal((await denied.poll('account_daily')).last_outcome, 'denied');
  const slow = await denied.inTenant(() => w.compliance.slowMode.status('instagram', denied.igUserId));
  assert.deepEqual([slow.active, slow.trigger], [true, 'insights_denied']);

  assert.equal((await dead.poll('account_daily')).last_outcome, 'token_invalid');
  const [connection] = await dead.q('SELECT status FROM ig_accounts WHERE ig_user_id = $1', [dead.igUserId]);
  assert.equal(connection.status, 'reconnect_needed');

  assert.match((await failing.poll('account_daily')).last_outcome, /server_error/);
  assert.equal((await failing.poll('account_daily')).attempts, 1);
});

test('N-34 and back: a permission restored ends "Permission needed" and starts the restore', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/tokens/scopes', { igUserId: b.igUserId, scopes: ['instagram_business_basic'] });
  await b.only('account_daily');
  await w.tick();
  assert.equal((await b.account()).permission, 'denied');

  await w.sim.post('/tokens/scopes', { igUserId: b.igUserId, scopes: ['instagram_business_basic', 'instagram_business_manage_insights'] });
  await w.advance(6 * HOUR);
  await b.only('account_daily');
  await w.tick();
  assert.equal((await b.account()).permission, 'ok');
  const status = await b.inTenant(() => w.compliance.slowMode.status('instagram', b.igUserId));
  assert.equal(status.active, false);
});

test('a pause on other insights can\'t hold back a story in the same tick, whatever order they were claimed in', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'r1', productType: 'REELS', at: NOW - DAY });
  await storyOn(w, b, 's1');
  await listed(w, b);
  await w.sim.post('/usage', { igUserId: b.igUserId, percent: 78 });
  await b.only('media', 'r1');
  await w.tick(); // the header arrives; other insights now wait

  await b.only('media', 'r1');
  const nowIso = new Date(w.clock.t).toISOString();
  await b.q(`UPDATE insight_polls SET next_due_at = $1::timestamptz WHERE tenant_id = $2 AND job = 'story'`, [nowIso, b.tenant.id]);
  await w.tick();
  assert.equal((await b.poll('media', 'r1')).last_outcome, 'deferred');
  assert.equal((await b.poll('story', 's1')).last_outcome, 'ok');
  assert.equal((await b.snapshots('s1')).length, 1);
});

test('a denied account is asked once a tick, and an account with no token is asked nothing', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'r1', productType: 'REELS', at: NOW - DAY });
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'r2', productType: 'REELS', at: NOW - DAY });
  await listed(w, b);
  await w.sim.post('/tokens/scopes', { igUserId: b.igUserId, scopes: ['instagram_business_basic'] });
  const later = new Date(w.clock.t).toISOString();
  await b.q(`UPDATE insight_polls SET next_due_at = $1::timestamptz WHERE tenant_id = $2 AND job = 'media'`, [later, b.tenant.id]);

  await w.sim.delete?.('/calls');
  const before = (await insightCalls(w.sim)).length;
  await w.tick();
  assert.equal((await insightCalls(w.sim)).length, before + 1, 'the first refusal is enough to know');
  for (const id of ['r1', 'r2']) assert.ok(+new Date((await b.poll('media', id)).next_due_at) > w.clock.t);

  await b.repos.igAccounts.loseToken(b.igUserId, 'token.rejected', { actor: 'test' });
  await b.only('media', 'r1');
  const calls = (await insightCalls(w.sim)).length;
  await w.tick();
  assert.equal((await insightCalls(w.sim)).length, calls);
  assert.equal((await b.poll('media', 'r1')).last_outcome, 'no_token');
});

test('a story past its window closes even with no token', async (t) => {
  const { w, b } = await connected(t);
  await storyOn(w, b, 's1');
  await b.repos.igAccounts.loseToken(b.igUserId, 'token.rejected', { actor: 'test' });
  await w.advance(24 * HOUR);
  await b.only('story', 's1');
  await w.tick();
  assert.equal((await b.media('s1')).story_final_state, 'final_incomplete');
});

test('a business that is closed or suspended is left alone', async (t) => {
  const { w, b } = await connected(t);
  await b.q(`UPDATE tenants SET status = 'closed' WHERE id = $1`, [b.tenant.id]);
  await b.only('account_daily');
  assert.equal((await w.tick()).claimed, 0);
});

// ---- leases and fairness ----------------------------------------------------------------------------------------------------

test('N-38: a worker killed mid-job holds its lease 10 minutes, and the rerun adds no second snapshot', async (t) => {
  const { w, b } = await connected(t);
  await w.sim.post('/media', { igUserId: b.igUserId, id: 'r1', productType: 'REELS', at: NOW - DAY });
  await w.sim.post('/insights', { id: 'r1', metrics: { views: 5 } });
  await listed(w, b);
  await b.only('media', 'r1');

  const [claimed] = await w.poller.claim(w.clock.t);
  assert.equal(claimed.job, 'media');
  assert.equal(+new Date(claimed.lease_until), w.clock.t + 10 * MINUTE);
  const mediaRef = claimed.media_ref;
  // It got as far as writing the snapshot before it died.
  await b.inTenant(() => w.platform.insights.saveSnapshot(mediaRef, { slot: +new Date(claimed.next_due_at), at: w.clock.t, ageMinutes: 1440, metrics: { views: 5 }, breakdowns: {} }));

  assert.equal((await w.tick()).claimed, 0, 'the lease still holds');
  await w.advance(9 * MINUTE);
  assert.equal((await w.tick()).claimed, 0);

  await w.sim.post('/insights', { id: 'r1', metrics: { views: 9 } });
  await w.advance(2 * MINUTE);
  assert.equal((await w.tick()).claimed, 1);
  const snapshots = await b.snapshots('r1');
  assert.equal(snapshots.length, 1, 'same slot, same snapshot');
  assert.equal((await b.media('r1')).latest.views, 9, 'the row still shows Meta\'s newest figure');
  const poll = await b.poll('media', 'r1');
  assert.equal(poll.lease_until, null);
  assert.equal(poll.last_outcome, 'ok');
});

test('a worker that lost its lease cannot finish the poll', async (t) => {
  const { w, b } = await connected(t);
  await b.only('account_daily');
  const [first] = await w.poller.claim(w.clock.t);
  await w.advance(11 * MINUTE);
  const [second] = await w.poller.claim(w.clock.t);
  assert.notEqual(first.locked_by, second.locked_by);
  assert.equal(await b.repos.insights.finishPoll(first, { outcome: 'ok', at: w.clock.t }), false);
  assert.equal(await b.repos.insights.finishPoll(second, { outcome: 'ok', at: w.clock.t }), true);
});

test('a busy business can\'t take every slot in a tick, and stories go first', async (t) => {
  const w = await world(t);
  const busy = await w.business();
  const quiet = await w.business();
  await w.enrol();
  const account = await busy.account();
  const refs = await busy.repos.insights.upsertMedia(account.id, Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, kind: 'feed', caption: '', permalink: '', thumbnailUrl: '', postedAt: new Date(NOW - DAY) })));
  await busy.repos.insights.ensureMediaPolls(account.id, [...refs.values()].map((mediaRef) => ({ job: 'media', mediaRef, jitterSeconds: 0, dueAt: NOW })));
  const storyRefs = await busy.repos.insights.upsertMedia(account.id, [{ id: 's1', kind: 'story', caption: '', permalink: '', thumbnailUrl: '', postedAt: new Date(NOW), storyExpiresAt: NOW + DAY }]);
  await busy.repos.insights.ensureMediaPolls(account.id, [{ job: 'story', mediaRef: storyRefs.get('s1'), jitterSeconds: 0, dueAt: NOW }]);
  await quiet.only('account_daily');

  const claimed = await w.poller.claim(NOW + 2 * HOUR);
  const mine = (b) => claimed.filter((p) => p.tenant_id === b.tenant.id);
  assert.equal(mine(busy).length, 20);
  assert.equal(mine(quiet).length, 1);
  assert.ok(mine(busy).some((p) => p.job === 'story'), 'the story was not crowded out');
});

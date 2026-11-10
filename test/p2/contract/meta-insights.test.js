// Insights calls on the per-business Meta client, against the simulator: what is asked, what comes back, and the 4.3 rules on every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { InsightsDeferredError, MetaApiError, createMetaClient, isInsightsDenied } from '../../../src/adapters/meta/index.js';

const DAY = 86_400_000;
const ID = '1784';
const NOW = Date.parse('2026-11-10T12:00:00Z');
const day = (back) => new Date(NOW - back * DAY).toISOString().slice(0, 10);

const openGuard = () => {
  const seen = [];
  return { seen, check: async () => ({ allow: true, reason: '' }), observe: async (o) => seen.push(o) };
};

async function withSim(run, seed = {}) {
  const meta = createMeta();
  await meta.start();
  await meta.post('/clock', { now: NOW, freeze: true });
  try {
    const { token } = await meta.post('/accounts', { igUserId: ID, username: 'shop', followersCount: 5000, ...seed });
    const guard = openGuard();
    const client = createMetaClient({ graphBaseUrl: meta.url, metaTimeoutMs: 800 });
    await run({ meta, token, guard, reader: client.insightsFor({ igUserId: ID, token }, guard), client });
  } finally {
    await meta.close();
  }
}

const requests = async (meta, path = '*/insights') => (await meta.calls({ path })).map((c) => c.query);

test('no account, media or story request ever asks for impressions (for N-05)', async () => {
  await withSim(async ({ meta, reader }) => {
    await meta.post('/media', { igUserId: ID, id: 'r1', productType: 'REELS' });
    await meta.post('/media', { igUserId: ID, id: 's1', productType: 'STORY', mediaType: 'IMAGE' });
    await reader.accountDay(day(5));
    await reader.mediaInsights('r1', 'reel');
    await reader.storyInsights('s1');
    for (const call of await meta.calls({})) assert.doesNotMatch(JSON.stringify(call.query), /impressions/);
  });
});

test('every call needs the rate guard: there is no way round the 4.3 rules', () => {
  const client = createMetaClient({ graphBaseUrl: 'http://127.0.0.1:1' });
  assert.throws(() => client.insightsFor({ igUserId: ID, token: 't' }), /rate guard/);
});

test('an insights call has Meta\'s timeout, and the guard hears about it', async () => {
  await withSim(async ({ meta, reader, guard }) => {
    await meta.fault({ kind: 'timeout', times: 'forever', match: { path: '*/insights' } });
    await assert.rejects(() => reader.accountDay(day(5), { breakdowns: false }), (err) => err instanceof MetaApiError && err.kind === 'timeout');
    assert.equal(guard.seen.at(-1).kind, 'timeout');
  });
});

test('a paused call class makes no request and says when to try again', async () => {
  await withSim(async ({ meta, token, client }) => {
    const until = new Date(NOW + 30 * 60_000);
    const asked = [];
    const paused = client.insightsFor({ igUserId: ID, token }, { check: async (c) => { asked.push(c); return { allow: false, reason: 'rate.usage_header', retryAt: until }; }, observe: async () => {} });
    await assert.rejects(() => paused.accountDay(day(5)), (err) => err instanceof InsightsDeferredError && err.reason === 'rate.usage_header' && err.retryAt === until);
    await assert.rejects(() => paused.mediaPage(), InsightsDeferredError);
    await assert.rejects(() => paused.storiesPage(), InsightsDeferredError);
    await assert.rejects(() => paused.storyInsights('s1'), InsightsDeferredError);
    assert.deepEqual(asked, ['insights', 'media_list', 'story_insights', 'story_insights']);
    assert.equal((await meta.calls({})).length, 0);
  });
});

test('a day comes back as rows ready to store, with an empty metric null and never 0 (N-03)', async () => {
  await withSim(async ({ meta, reader }) => {
    const on = day(5);
    await meta.post('/insights/daily', { igUserId: ID, metric: 'reach', points: [{ day: on, value: 900 }] });
    await meta.post('/insights/daily', { igUserId: ID, metric: 'comments', points: [{ day: on, value: null }] });
    await meta.post('/insights/daily', { igUserId: ID, metric: 'profile_links_taps', points: [{ day: on, value: 3, breakdowns: { contact_button_type: { CALL: 2, EMAIL: 1 } } }] });
    const rows = await reader.accountDay(on);
    const total = (metric) => rows.find((r) => r.metric === metric && r.breakdown === '')?.value;
    assert.equal(total('reach'), 900);
    assert.equal(total('comments'), null);
    assert.equal(total('views'), null);
    assert.deepEqual(rows.filter((r) => r.metric === 'profile_links_taps').map((r) => [r.breakdown, r.breakdownValue, r.value]).sort(), [['contact_button_type', 'CALL', 2], ['contact_button_type', 'EMAIL', 1]]);
    for (const query of await requests(meta)) {
      if (query.metric === 'profile_links_taps') assert.equal(query.breakdown, 'contact_button_type');
    }
  });
});

test('late revisions: a settling day shows its early figure, then the final one on a later fetch', async () => {
  await withSim(async ({ meta, reader }) => {
    await meta.post('/insights/daily', { igUserId: ID, metric: 'reach', points: [{ day: day(1), early: 40, value: 100 }] });
    const reach = async () => (await reader.accountDay(day(1), { breakdowns: false })).find((r) => r.metric === 'reach').value;
    assert.equal(await reach(), 40);
    await meta.post('/clock', { advanceMs: 2 * DAY });
    assert.equal(await reach(), 100);
  });
});

test('a reel has its watch metrics, and profile_activity goes in its own request', async () => {
  await withSim(async ({ meta, reader }) => {
    await meta.post('/media', { igUserId: ID, id: 'r1', productType: 'REELS', at: NOW - 3 * DAY });
    await meta.post('/insights', { id: 'r1', metrics: { views: 10, reach: 8, ig_reels_avg_watch_time: 1200, reels_skip_rate: 30, profile_activity: { BIO_LINK_CLICKED: 2 } } });
    const result = await reader.mediaInsights('r1', 'reel');
    assert.equal(result.status, 'ok');
    assert.deepEqual([result.metrics.views, result.metrics.ig_reels_avg_watch_time, result.metrics.reels_skip_rate], [10, 1200, 30]);
    assert.deepEqual(result.breakdowns.profile_activity, { BIO_LINK_CLICKED: 2 });
    const queries = await requests(meta);
    assert.equal(queries.length, 2);
    assert.equal(queries.filter((q) => q.metric === 'profile_activity' && q.breakdown === 'action_type').length, 1);
    assert.doesNotMatch(queries.find((q) => !q.breakdown).metric, /profile_activity/);
  });
});

test('a carousel is read on its album id, and a slide is refused (for N-07)', async () => {
  await withSim(async ({ meta, reader, token }) => {
    await meta.post('/media', { igUserId: ID, id: 'a1', productType: 'FEED', mediaType: 'CAROUSEL_ALBUM', children: ['c1', 'c2'] });
    assert.equal((await reader.mediaInsights('a1', 'carousel')).status, 'ok');
    const page = await reader.mediaPage();
    assert.deepEqual(page.items.map((m) => [m.id, m.kind]), [['a1', 'carousel']]);
    await assert.rejects(() => reader.mediaInsights('c1', 'carousel'), MetaApiError);
    assert.ok(token);
  });
});

test('deleted media says gone (for N-08)', async () => {
  await withSim(async ({ meta, reader }) => {
    await meta.post('/media', { igUserId: ID, id: 'r1', productType: 'REELS' });
    await meta.post('/media/delete', { id: 'r1' });
    assert.equal((await reader.mediaInsights('r1', 'reel')).status, 'gone');
    assert.deepEqual((await reader.mediaPage()).items, []);
  });
});

test('a story with too few viewers is below_threshold, and an expired one says so (for N-11)', async () => {
  await withSim(async ({ meta, reader, guard }) => {
    await meta.post('/media', { igUserId: ID, id: 's1', productType: 'STORY', mediaType: 'IMAGE' });
    await meta.post('/insights', { id: 's1', notEnoughViewers: true });
    assert.equal((await reader.storyInsights('s1')).status, 'below_threshold');
    assert.equal(guard.seen.at(-1).kind, 'not_enough_viewers');
    await meta.post('/clock', { advanceMs: DAY });
    await meta.post('/insights', { id: 's1', notEnoughViewers: false });
    assert.equal((await reader.storyInsights('s1')).status, 'expired');
  });
});

test('a story has navigation in its own request, on the story call class', async () => {
  await withSim(async ({ meta, token, client }) => {
    await meta.post('/media', { igUserId: ID, id: 's1', productType: 'STORY', mediaType: 'IMAGE' });
    await meta.post('/insights', { id: 's1', metrics: { views: 7, link_clicks: 1, navigation: { TAP_FORWARD: 3 } } });
    const classes = [];
    const reader = client.insightsFor({ igUserId: ID, token }, { check: async (c) => { classes.push(c); return { allow: true, reason: '' }; }, observe: async () => {} });
    const result = await reader.storyInsights('s1');
    assert.deepEqual([result.metrics.views, result.metrics.link_clicks], [7, 1]);
    assert.deepEqual(result.breakdowns.navigation, { TAP_FORWARD: 3 });
    assert.ok(classes.length >= 3 && classes.every((c) => c === 'story_insights'));
  });
});

test('the /stories edge being unavailable is an answer, not a failure', async () => {
  await withSim(async ({ meta, reader }) => {
    await meta.post('/insights/options', { igUserId: ID, storiesEdge: false });
    assert.deepEqual(await reader.storiesPage(), { available: false, items: [], next: null });
  });
});

test('pagination walks every page of media (for N-09)', async () => {
  await withSim(async ({ meta, reader }) => {
    for (let i = 0; i < 150; i++) await meta.post('/media', { igUserId: ID, id: `m${i}`, productType: 'FEED', mediaType: 'IMAGE' });
    let after;
    const ids = new Set();
    do {
      const page = await reader.mediaPage({ after, limit: 100 });
      for (const item of page.items) ids.add(item.id);
      after = page.next;
    } while (after);
    assert.equal(ids.size, 150);
  });
});

test('a revoked insights scope reads as denied, for every request (for N-34)', async () => {
  await withSim(async ({ meta, reader }) => {
    await meta.post('/tokens/scopes', { igUserId: ID, scopes: ['instagram_business_basic'] });
    await assert.rejects(() => reader.accountDay(day(5)), (err) => isInsightsDenied(err));
  });
});

test('80002 reaches the guard with its regain time, and lifts on the controlled clock (for N-35)', async () => {
  await withSim(async ({ meta, reader, guard }) => {
    await meta.post('/throttle', { igUserId: ID, regainMinutes: 30 });
    await assert.rejects(() => reader.followers(), (err) => err.kind === 'buc_throttled' && err.usage.regainMinutes === 30);
    assert.deepEqual([guard.seen.at(-1).kind, guard.seen.at(-1).usage.regainMinutes], ['buc_throttled', 30]);
    await meta.post('/clock', { advanceMs: 31 * 60_000 });
    assert.equal(await reader.followers(), 5000);
  });
});

test('the client reports each call with its account, for Account Health', async () => {
  await withSim(async ({ meta, token }) => {
    const calls = [];
    const client = createMetaClient({ graphBaseUrl: meta.url }, { onCall: (c) => calls.push(c) });
    await client.forAccount({ igUserId: ID, token }).getAccount();
    assert.deepEqual([calls[0].channel, calls[0].accountId, calls[0].status], ['instagram', ID, 200]);
    assert.doesNotMatch(JSON.stringify(calls), new RegExp(token));
  });
});

test('demographics are empty below 100 followers, without an error', async () => {
  await withSim(async ({ meta, reader }) => {
    await meta.post('/insights/demographics', { igUserId: ID, metric: 'follower_demographics', breakdown: 'city', results: { Pune: 50 } });
    assert.deepEqual(await reader.demographics('follower_demographics', 'this_month', 'city'), []);
  }, { followersCount: 80 });
});

test('demographics take only this_week or this_month', async () => {
  await withSim(async ({ meta, reader }) => {
    await meta.post('/insights/demographics', { igUserId: ID, metric: 'follower_demographics', breakdown: 'city', results: { Pune: 50 } });
    assert.deepEqual(await reader.demographics('follower_demographics', 'this_month', 'city'), [{ key: 'Pune', value: 50 }]);
    await assert.rejects(() => reader.demographics('follower_demographics', 'last_30_days', 'city'), (err) => err.kind === 'validation');
  });
});

test('online_followers: available only when Meta still returns it', async () => {
  await withSim(async ({ meta, reader }) => {
    assert.equal((await reader.onlineFollowers()).available, false);
    await meta.post('/insights', { id: ID, metrics: { online_followers: { 0: 10, 13: 40 } } });
    assert.deepEqual(await reader.onlineFollowers(), { available: true, hours: { 0: 10, 13: 40 } });
  });
});

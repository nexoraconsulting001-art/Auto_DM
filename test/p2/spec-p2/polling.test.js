// PRD 7.8: polling inside the shared call budget, and 4.3's insights class. N-35 to N-38.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_LIMITS, DAY, HOUR, INSIDE_MS, MINUTE, OUTSIDE_MS, addP2Shop, comments, liveReel, unique, useP2World } from './support.js';

const world = useP2World();
const insightCalls = (shop) => shop.metaCalls('*/insights');
const refresh = (shop) => shop.post('/insights/refresh', {}, 200, 'Refresh now');
const rateState = async (shop) => (await shop.sql('SELECT * FROM account_rate_state WHERE tenant_id = $1 AND account_id = $2', [shop.tenantId, shop.igUserId]))[0];

async function throttled(shop, regainMinutes = 30) {
  await shop.poll();
  await world.meta.post('/throttle', { igUserId: shop.igUserId, regainMinutes });
  await shop.poll();
}

// ---- N-35 ------------------------------------------------------------------------------------------------------------

test('N-35: 80002 with a 30-minute regain time pauses insights until then, then polling resumes', async () => {
  const shop = await addP2Shop(world);
  await throttled(shop);
  await shop.clearMetaCalls();
  await world.travel(30 * MINUTE - INSIDE_MS * 2, { sim: true });
  await shop.poll();
  assert.deepEqual((await insightCalls(shop)).map((c) => c.path), [], 'No insights calls inside the 30 min');
  await world.travel(INSIDE_MS * 2 + OUTSIDE_MS, { sim: true });
  await shop.poll();
  assert.ok((await insightCalls(shop)).length > 0, 'Polling resumes after the regain time');
});

test('N-35: the regain time from Meta is what is stored: at 80002 the pause runs to it', async () => {
  const shop = await addP2Shop(world);
  await throttled(shop, 45);
  const until = new Date((await rateState(shop)).other_paused_until).getTime();
  assert.ok(Math.abs(until - (Date.now() + 45 * MINUTE)) < 2 * MINUTE, 'The pause ends at the regain time');
});

test('N-35: DM sends continue during 80002, at the slow-mode rate, and slow mode lasts 60 min past the regain time', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  await throttled(shop);
  await comments(world, shop, auto.mediaId, 1);
  await shop.settle({ ms: 6000 });
  assert.equal((await shop.dms()).length, 1, 'DMs continue');
  const rate = await rateState(shop);
  assert.equal(rate.slow_mode_trigger, 'buc_80002');
  const until = new Date(rate.slow_mode_until).getTime();
  assert.ok(Math.abs(until - (Date.now() + 90 * MINUTE)) < 3 * MINUTE, `Slow mode to regain + 60 min, got ${(until - Date.now()) / MINUTE} min`);
});

test('N-35: 80002 means Watch on Reach Guard and costs 25 on Account Health', async () => {
  const shop = await addP2Shop(world);
  await throttled(shop);
  assert.equal((await shop.guard()).state, 'watch');
  await shop.settle({ ms: 2000, roundMs: 200 });
  const health = await shop.health();
  assert.equal(health.deductions.find((d) => d.code === 'buc_80002')?.points, -25);
});

test('N-35: a usage header at 75% or more pauses other insights but story insights go on', async () => {
  const shop = await addP2Shop(world);
  await shop.reel({ id: `r${unique()}` });
  const story = await shop.story({ id: `st${unique()}` });
  await world.meta.post('/insights', { id: story, metrics: { views: 1 } });
  await shop.poll();
  await world.meta.post('/usage', { igUserId: shop.igUserId, percent: 78 });
  await shop.poll();
  await shop.clearMetaCalls();
  await shop.poll();
  const calls = await insightCalls(shop);
  assert.ok(calls.some((c) => c.path.includes(story)), 'Story insights continue');
  assert.deepEqual(calls.filter((c) => !c.path.includes(story)).map((c) => c.path), [], 'Other insights pause');
});

test('N-35: at 90% or more even story insights stop', async () => {
  const shop = await addP2Shop(world);
  const story = await shop.story({ id: `st${unique()}` });
  await world.meta.post('/insights', { id: story, metrics: { views: 1 } });
  await shop.poll();
  await world.meta.post('/usage', { igUserId: shop.igUserId, percent: 92 });
  await shop.poll();
  await shop.clearMetaCalls();
  await shop.poll();
  assert.deepEqual((await insightCalls(shop)).map((c) => c.path), []);
});

test('N-35: one account\'s 80002 leaves another business polling', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await throttled(a);
  await a.clearMetaCalls();
  await b.poll();
  assert.ok((await insightCalls(b)).length > 0);
  assert.deepEqual(await insightCalls(a), []);
});

test('N-35: reports and screens work through the pause, from the cache', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('reach', { 3: 500 });
  await throttled(shop);
  await shop.clearMetaCalls();
  assert.equal((await shop.raw('/insights/account', { range: '7' })).status, 200);
  assert.deepEqual(await world.meta.calls({}), []);
});

// ---- N-36 ------------------------------------------------------------------------------------------------------------

test('N-36: a second Refresh now within 5 min says "Updated 5 min ago" and makes no API call', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  const first = await refresh(shop);
  assert.equal(first.refreshed, true);
  await shop.settle({ ms: 3000, roundMs: 300 });
  await world.travel(5 * MINUTE);
  await shop.clearMetaCalls();
  const second = await refresh(shop);
  assert.equal(second.refreshed, false);
  assert.match(second.message, /Updated 5 min ago/);
  await shop.settle({ ms: 2000, roundMs: 200 });
  assert.deepEqual((await insightCalls(shop)).map((c) => c.path), [], 'No API call');
  assert.ok(second.lastUpdatedAt && second.nextRefreshAt, 'It says how old and when next');
});

test('N-36: the 15-minute limit is exact', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  assert.equal((await refresh(shop)).refreshed, true);
  await shop.settle({ ms: 2000, roundMs: 200 });
  await world.travel(ANALYTICS_LIMITS.refreshNowEveryMs - INSIDE_MS * 2);
  assert.equal((await refresh(shop)).refreshed, false, 'Just inside 15 min');
  await world.travel(INSIDE_MS * 2 + OUTSIDE_MS);
  assert.equal((await refresh(shop)).refreshed, true, 'Just past 15 min');
});

test('N-36: two taps at the same moment are one refresh', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  const results = await Promise.all([refresh(shop), refresh(shop), refresh(shop)]);
  assert.equal(results.filter((r) => r.refreshed).length, 1);
});

test('N-36: the limit is per business: another business can refresh in the same minute', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await a.poll();
  await b.poll();
  assert.equal((await refresh(a)).refreshed, true);
  assert.equal((await refresh(b)).refreshed, true);
});

test('N-36: refresh respects the 4.3 pauses: during 80002 it makes no call and says so', async () => {
  const shop = await addP2Shop(world);
  await throttled(shop);
  await shop.clearMetaCalls();
  const res = await refresh(shop);
  assert.equal(res.refreshed, false);
  assert.ok(res.message.length > 0);
  await shop.settle({ ms: 2000, roundMs: 200 });
  assert.deepEqual(await insightCalls(shop), []);
});

test('N-36: a refresh only moves polls forward: it never doubles a poll that is running', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  await shop.sql(`UPDATE insight_polls SET lease_until = now() + interval '5 minutes', locked_by = 'someone-else' WHERE tenant_id = $1 AND job = 'account_daily'`, [shop.tenantId]);
  await shop.clearMetaCalls();
  await refresh(shop);
  await shop.runDue();
  assert.deepEqual((await insightCalls(shop)).filter((c) => c.path.endsWith(`/${shop.igUserId}/insights`) || c.path.includes('/me/insights')).map((c) => c.path), [], 'A held lease is respected');
});

test('N-36: refresh is for sellers who can see analytics only', async () => {
  const shop = await addP2Shop(world);
  const staff = await shop.addStaff(['orders']);
  assert.equal((await shop.as(staff.token, '/insights/refresh', { method: 'POST', body: {} })).status, 403);
  assert.equal((await shop.as(undefined, '/insights/refresh', { method: 'POST', body: {} })).status, 401);
});

test('N-36: every screen shows a last updated time once there is one', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  const status = await shop.get('/insights/status');
  assert.ok(status.lastUpdatedAt, 'The status has a last updated time');
  assert.ok(new Date(status.lastUpdatedAt).getTime() <= Date.now() + MINUTE);
});

// ---- N-37 ------------------------------------------------------------------------------------------------------------

test('N-37: with 50 businesses no minute has more than 10% of the job starts', async () => {
  const shops = [];
  for (let i = 0; i < 50; i++) shops.push(await addP2Shop(world, { followers: 200 }));
  const ids = shops.map((s) => s.tenantId);
  await world.settle({ ms: 8000, roundMs: 500 });
  const polls = await shops[0].sql(`SELECT tenant_id, next_due_at FROM insight_polls WHERE tenant_id = ANY($1) AND job = 'account_daily'`, [ids]);
  assert.equal(polls.length, 50, 'One daily poll per business');
  const byMinute = new Map();
  for (const poll of polls) {
    const key = new Date(poll.next_due_at).toISOString().slice(0, 16);
    byMinute.set(key, (byMinute.get(key) ?? 0) + 1);
  }
  const busiest = Math.max(...byMinute.values());
  assert.ok(busiest <= 5, `The busiest minute has ${busiest} of 50 starts`);
  const distinctOffsets = new Set((await shops[0].sql(`SELECT poll_offset_sec FROM insight_settings WHERE tenant_id = ANY($1)`, [ids])).map((r) => r.poll_offset_sec));
  assert.ok(distinctOffsets.size > 1, 'Businesses are spread over the hour');
});

test('N-37: a business\'s place in the hour survives a poll: the next due time keeps its offset', async () => {
  const shop = await addP2Shop(world);
  await shop.settle({ ms: 2000, roundMs: 200 });
  const [first] = await shop.polls(`job = 'account_daily'`);
  const minuteOf = (d) => new Date(d).getUTCMinutes();
  await shop.poll({ jobs: ['account_daily'] });
  const [after] = await shop.polls(`job = 'account_daily'`);
  assert.ok(Math.abs(minuteOf(first.next_due_at) - minuteOf(after.next_due_at)) <= 5 || Math.abs(minuteOf(first.next_due_at) - minuteOf(after.next_due_at)) >= 55, 'Same part of the hour');
  assert.ok(new Date(after.next_due_at) - new Date(first.next_due_at) > HOUR * 20 || new Date(after.next_due_at) > Date.now() + HOUR * 20, 'A day later');
});

// ---- N-38 ------------------------------------------------------------------------------------------------------------

const claimAsDead = (shop, job, untilSql = `now() + interval '10 minutes'`) => shop.sql(`UPDATE insight_polls SET lease_until = ${untilSql}, locked_by = 'dead-worker', last_started_at = now(), next_due_at = now() - interval '1 minute' WHERE tenant_id = $1 AND job = $2 RETURNING *`, [shop.tenantId, job]);

test('N-38: a poll held by a live lease isn\'t started by another worker', async () => {
  const shop = await addP2Shop(world);
  await shop.settle({ ms: 2000, roundMs: 200 });
  await claimAsDead(shop, 'account_daily');
  await shop.clearMetaCalls();
  await shop.runDue();
  assert.deepEqual(await insightCalls(shop), []);
});

test('N-38: the 10-minute lease is exact: just inside no one touches it, just past someone does', async () => {
  const shop = await addP2Shop(world);
  await shop.settle({ ms: 2000, roundMs: 200 });
  await claimAsDead(shop, 'account_daily', `now() + interval '40 seconds'`);
  await shop.clearMetaCalls();
  await shop.runDue();
  assert.deepEqual(await insightCalls(shop), [], 'Still leased');
  await shop.sql(`UPDATE insight_polls SET lease_until = now() - interval '1 second' WHERE tenant_id = $1 AND job = 'account_daily'`, [shop.tenantId]);
  await shop.runDue();
  assert.ok((await insightCalls(shop)).length > 0, 'The lease ran out');
});

test('N-38: a poll claims a 10-minute lease while it runs', async () => {
  const shop = await addP2Shop(world);
  await shop.settle({ ms: 2000, roundMs: 200 });
  const seen = [];
  await world.meta.fault({ kind: 'timeout', delayMs: 300, times: 1, match: { path: '*/insights' } });
  await shop.sql(`UPDATE insight_polls SET next_due_at = now() - interval '1 second', lease_until = NULL WHERE tenant_id = $1 AND job = 'account_daily'`, [shop.tenantId]);
  const running = shop.settle({ ms: 2500, roundMs: 300 });
  for (let i = 0; i < 80 && !seen.length; i++) {
    const [row] = await shop.polls(`job = 'account_daily' AND lease_until > now()`);
    if (row) seen.push(row);
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await running;
  await world.meta.delete('/faults');
  assert.ok(seen.length, 'A lease was held while the poll ran');
  const leaseMs = new Date(seen[0].lease_until) - new Date(seen[0].last_started_at ?? Date.now());
  assert.ok(leaseMs >= ANALYTICS_LIMITS.pollLeaseMs - MINUTE && leaseMs <= ANALYTICS_LIMITS.pollLeaseMs + MINUTE, `Lease of ${leaseMs / MINUTE} min`);
});

test('N-38: worker killed after a snapshot: when the lease expires the rerun adds no duplicate', async () => {
  const shop = await addP2Shop(world);
  const id = await shop.reel({ id: `r${unique()}`, at: Date.now() - 3 * DAY });
  await world.meta.post('/insights', { id, metrics: { views: 10 } });
  await shop.poll();
  const [media] = await shop.sql('SELECT id FROM insight_media WHERE tenant_id = $1 AND media_id = $2', [shop.tenantId, id]);
  // The dead worker got as far as writing this poll's snapshot, for the slot this poll is about to run.
  const [poll] = await shop.polls(`job = 'media' AND media_ref = $2`, [media.id]);
  await shop.sql(`INSERT INTO insight_snapshots (tenant_id, media_ref, slot, age_minutes, metrics) VALUES ($1, $2, $3, 4320, '{"views":10}')`, [shop.tenantId, media.id, poll.next_due_at]);
  await shop.sql(`UPDATE insight_polls SET lease_until = now() - interval '1 second', locked_by = 'dead-worker', last_started_at = now() - interval '11 minutes' WHERE id = $1`, [poll.id]);
  const count = async () => (await shop.sql('SELECT count(*)::int AS n FROM insight_snapshots WHERE tenant_id = $1 AND media_ref = $2', [shop.tenantId, media.id]))[0].n;
  const before = await count();
  await world.travel(new Date(poll.next_due_at) - Date.now() + MINUTE, { sim: true });
  await shop.runDue();
  assert.equal(await count(), before, 'The slot already had its snapshot, so the rerun adds none');
});

test('N-38: two workers on the same poll at the same moment write one snapshot', async () => {
  const shop = await addP2Shop(world);
  const id = await shop.reel({ id: `r${unique()}`, at: Date.now() - 3 * DAY });
  await world.meta.post('/insights', { id, metrics: { views: 10 } });
  await shop.poll();
  const [media] = await shop.sql('SELECT id FROM insight_media WHERE tenant_id = $1 AND media_id = $2', [shop.tenantId, id]);
  world.addWorker();
  await shop.sql(`UPDATE insight_polls SET next_due_at = now() - interval '1 second', lease_until = NULL WHERE media_ref = $1`, [media.id]);
  await shop.clearMetaCalls();
  await world.tickTogether();
  await shop.settle({ ms: 4000, roundMs: 300 });
  const asked = (await shop.metaCalls(`*/${id}/insights`)).filter((c) => !c.query.breakdown);
  assert.ok(asked.length <= 1, `Meta asked ${asked.length} times`);
  const [{ n, slots }] = await shop.sql('SELECT count(*)::int AS n, count(DISTINCT slot)::int AS slots FROM insight_snapshots WHERE tenant_id = $1 AND media_ref = $2', [shop.tenantId, media.id]);
  assert.equal(n, slots);
});

test('N-38: a poll that crashes partway is not lost: it is due again after its lease', async () => {
  const shop = await addP2Shop(world);
  const id = await shop.reel({ id: `r${unique()}`, at: Date.now() - 3 * DAY });
  await world.meta.post('/insights', { id, metrics: { views: 10 } });
  await shop.poll();
  const [media] = await shop.sql('SELECT id FROM insight_media WHERE tenant_id = $1 AND media_id = $2', [shop.tenantId, id]);
  await shop.sql(`UPDATE insight_polls SET last_started_at = now() - interval '11 minutes', lease_until = now() - interval '1 minute', locked_by = 'dead-worker', next_due_at = now() - interval '11 minutes', last_finished_at = now() - interval '1 day' WHERE media_ref = $1`, [media.id]);
  await shop.clearMetaCalls();
  await shop.runDue();
  assert.ok((await shop.metaCalls(`*/${id}/insights`)).length >= 1, 'The rerun picked it up');
});

test('N-38: a rerun of a day\'s account poll changes nothing and duplicates nothing', async () => {
  const shop = await addP2Shop(world);
  await world.meta.post('/insights/daily', { igUserId: shop.igUserId, metric: 'reach', points: [{ day: new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10), value: 111 }] });
  await shop.poll({ jobs: ['account_daily'] });
  const before = await shop.sql('SELECT count(*)::int AS n FROM insight_daily WHERE tenant_id = $1', [shop.tenantId]);
  await shop.poll({ jobs: ['account_daily'] });
  const after = await shop.sql('SELECT count(*)::int AS n FROM insight_daily WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(after[0].n, before[0].n);
});

test('N-38: the poll\'s last outcome holds no token or personal data', async () => {
  const shop = await addP2Shop(world);
  await world.meta.fault({ kind: 'server_error', status: 500, times: 3, match: { path: '*/insights' } });
  await shop.poll();
  await world.meta.delete('/faults');
  for (const poll of await shop.polls()) assert.equal(`${poll.last_outcome}`.includes(shop.igToken), false);
});

test('N-38: a poll for one business never carries another\'s token', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await a.poll();
  await b.poll();
  const calls = await world.meta.calls({ path: '*/insights' });
  for (const call of calls) {
    const token = (call.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const expected = token === a.igToken ? a.igUserId : token === b.igToken ? b.igUserId : null;
    if (expected && call.path.match(/\/(\d+)\/insights/)) {
      const account = call.path.match(/\/(\d+)\/insights/)[1];
      if (account.length === expected.length && account !== expected && [a.igUserId, b.igUserId].includes(account)) assert.fail(`${token.slice(0, 8)} was used on the other account`);
    }
  }
});

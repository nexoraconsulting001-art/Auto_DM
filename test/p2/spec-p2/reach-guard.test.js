// PRD 7.6: Reach Guard. N-23 to N-28. "At least 2 days old" is read as it is written: the calendar day two days ago is settled, yesterday and today are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_LIMITS, DAY, HOUR, INSIDE_MS, OUTSIDE_MS, addP2Shop, need, unique, useP2World } from './support.js';

const world = useP2World();

const NORMAL = 10_000;
const range = (from, count, value) => Object.fromEntries(Array.from({ length: count }, (_, i) => [from + i, value]));

/** Enough history to leave Learning: 28 settled days of `value` at the far end, and 12 ordinary reels. */
async function history(shop, { oldest = 6, value = NORMAL, media = 12 } = {}) {
  await shop.seedDays('reach', range(oldest, 28, value));
  for (let i = 0; i < media; i++) await shop.seedMedia({ mediaId: `r${i}x${unique()}`, kind: 'reel', postedAgoMs: (40 + i) * DAY, latest: { reach: 5000 }, snapshots: [{ ageMinutes: 1440, metrics: { reach: 5000 } }] });
}

const low = (shop, map) => shop.seedDays('reach', map);
const trips = (shop) => shop.sql('SELECT * FROM reach_guard_trips WHERE tenant_id = $1 ORDER BY id', [shop.tenantId]);

async function tripped(shop) {
  await history(shop);
  await low(shop, { 5: 5500, 4: 5200, 3: 5800, 2: 5800, 1: NORMAL, 0: NORMAL });
  await shop.evaluate();
  assert.equal((await shop.guard()).state, 'tripped');
}

// ---- N-23 ------------------------------------------------------------------------------------------------------------

test('N-23: baseline 10,000 and three settled days at 5,500, 5,200 and 5,800: it trips, and slow mode starts', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await low(shop, { 5: 5500, 4: 5200, 3: 5800, 2: 5800, 1: NORMAL, 0: NORMAL });
  await shop.evaluate();
  const res = await shop.guard();
  assert.equal(res.state, 'tripped');
  assert.equal(res.baselineReach, NORMAL);
  assert.equal(res.trip.trigger, 'reach_days');
  assert.ok(res.trip.dropPercent >= 40 && res.trip.dropPercent <= 50, `Down about 45%, got ${res.trip.dropPercent}`);
  assert.deepEqual([res.slowMode.active, res.slowMode.trigger, res.slowMode.canOverride], [true, 'reach_drop', true]);
  assert.match(res.message, /Reach is down \d+% vs your usual/);
  const [rate] = await shop.sql('SELECT slow_mode_trigger, slow_mode_until FROM account_rate_state WHERE tenant_id = $1 AND account_id = $2', [shop.tenantId, shop.igUserId]);
  assert.equal(rate?.slow_mode_trigger, 'reach_drop', 'The gate reads this');
  assert.equal((await shop.get('/compliance/status')).slowMode.active, true);
});

test('N-23: one alert per channel, once per trip, however many times the job runs', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  const [first] = await trips(shop);
  assert.ok(first.alert_push_at && first.alert_banner_at && first.alert_email_at, 'Push, banner and email');
  const alertsBefore = (await shop.alerts()).filter((a) => /reach/i.test(a.kind)).length;
  assert.ok(alertsBefore >= 1, 'The owner was told');
  await shop.evaluate();
  await shop.evaluate();
  const all = await trips(shop);
  assert.equal(all.length, 1, 'One trip');
  for (const column of ['alert_push_at', 'alert_banner_at', 'alert_email_at']) assert.equal(+new Date(all[0][column]), +new Date(first[column]), column);
  assert.equal((await shop.alerts()).filter((a) => /reach/i.test(a.kind)).length, alertsBefore, 'No more alerts');
});

test('N-23: two workers evaluating at the same moment make one trip and one alert', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await low(shop, { 5: 5500, 4: 5200, 3: 5800, 2: 5800 });
  await shop.poll({ jobs: ['account_daily'] });
  world.addWorker();
  await world.tickTogether();
  await shop.settle({ ms: 4000, roundMs: 300 });
  assert.equal((await trips(shop)).length, 1);
  assert.equal((await shop.alerts()).filter((a) => /reach/i.test(a.kind)).length, 1);
});

test('N-23: the copy says normal causes and never "shadowbanned" or "safe"', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  const { message } = await shop.guard();
  assert.doesNotMatch(message, /shadow.?ban/i);
  assert.doesNotMatch(message, /\bsafe\b/i);
  for (const alert of await shop.alerts()) {
    assert.doesNotMatch(alert.message, /shadow.?ban/i);
    assert.doesNotMatch(alert.message, /\bsafe\b/i);
  }
});

test('N-23: two low days and a good one don\'t trip', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await low(shop, { 5: NORMAL, 4: 5200, 3: 5800, 2: NORMAL });
  await shop.evaluate();
  const res = await shop.guard();
  assert.notEqual(res.state, 'tripped');
  assert.equal(res.slowMode.active, false);
});

test('N-23: three low days must be in a row', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await low(shop, { 6: 5000, 5: 5000, 4: NORMAL, 3: 5000, 2: NORMAL });
  await shop.evaluate();
  assert.notEqual((await shop.guard()).state, 'tripped');
});

test('N-23: at exactly 60% of baseline it isn\'t below it', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await low(shop, { 5: 6000, 4: 6000, 3: 6000, 2: 6000 });
  await shop.evaluate();
  assert.notEqual((await shop.guard()).state, 'tripped');
});

test('N-23: one below 60% of baseline it is', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await low(shop, { 5: 5999, 4: 5999, 3: 5999, 2: 5999 });
  await shop.evaluate();
  assert.equal((await shop.guard()).state, 'tripped');
});

test('N-23: the baseline is a median: one huge day doesn\'t move it', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await shop.seedDays('reach', { 10: 5_000_000 });
  await shop.evaluate();
  assert.equal((await shop.guard()).baselineReach, NORMAL);
});

test('N-23: the baseline is over 28 settled days: older days are not in it', async () => {
  const shop = await addP2Shop(world);
  await history(shop, { oldest: 3 });
  await shop.seedDays('reach', range(31, 45, 100));
  await shop.evaluate();
  assert.equal((await shop.guard()).baselineReach, NORMAL);
});

test('N-23: three reels under 50% of the usual at 24h trip it, by that trigger', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  for (const [i, reach] of [2000, 2400, 2499].entries()) await shop.seedMedia({ mediaId: `low${i}x${unique()}`, kind: 'reel', postedAgoMs: (3 - i + 2) * DAY, latest: { reach }, snapshots: [{ ageMinutes: 1440, metrics: { reach } }] });
  await shop.evaluate();
  const res = await shop.guard();
  assert.equal(res.state, 'tripped');
  assert.equal(res.trip.trigger, 'media_24h');
});

test('N-23: a reel at exactly 50% of the usual isn\'t under it, and it takes three in a row', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  for (const [i, reach] of [2500, 2000, 2000].entries()) await shop.seedMedia({ mediaId: `low${i}x${unique()}`, kind: 'reel', postedAgoMs: (3 - i + 2) * DAY, latest: { reach }, snapshots: [{ ageMinutes: 1440, metrics: { reach } }] });
  await shop.evaluate();
  assert.notEqual((await shop.guard()).state, 'tripped');
});

test('N-23: a poor feed post is compared with feed posts, not reels', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  for (let i = 0; i < 12; i++) await shop.seedMedia({ mediaId: `f${i}x${unique()}`, kind: 'feed', postedAgoMs: (40 + i) * DAY, latest: { reach: 500 }, snapshots: [{ ageMinutes: 1440, metrics: { reach: 500 } }] });
  for (let i = 0; i < 3; i++) await shop.seedMedia({ mediaId: `f${i}y${unique()}`, kind: 'feed', postedAgoMs: (5 - i) * DAY, latest: { reach: 400 }, snapshots: [{ ageMinutes: 1440, metrics: { reach: 400 } }] });
  await shop.evaluate();
  assert.notEqual((await shop.guard()).state, 'tripped', '400 is low for a reel and normal for a feed post');
});

test('N-23: only the owner may change the thresholds, within limits, and a changed threshold is what counts', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await low(shop, { 5: 5500, 4: 5200, 3: 5800, 2: 5800 });
  const manager = await shop.addManager();
  const refused = await shop.as(manager.token, '/reach-guard/thresholds', { method: 'PATCH', body: { reachDropPercent: 50 } });
  assert.equal(refused.status, 403);
  assert.equal(refused.json().error, 'Owner only.');
  for (const body of [{ reachDropPercent: 39 }, { reachDropPercent: 81 }, { reachDropPercent: 50.5 }, { reachDropPercent: 'x' }, { mediaDropPercent: 29 }, { mediaDropPercent: 71 }, { clearPercent: 59 }, { clearPercent: 96 }]) {
    assert.equal((await shop.raw('/reach-guard/thresholds', undefined, { method: 'PATCH', body })).status, 400, JSON.stringify(body));
  }
  for (const body of [{ reachDropPercent: 40 }, { reachDropPercent: 80 }, { clearPercent: 60 }, { clearPercent: 95 }]) need(await shop.raw('/reach-guard/thresholds', undefined, { method: 'PATCH', body }), 200, JSON.stringify(body));
  const saved = await shop.patch('/reach-guard/thresholds', { reachDropPercent: 50 });
  assert.equal(saved.thresholds.reachDropPercent, 50);
  await shop.evaluate();
  assert.notEqual((await shop.guard()).state, 'tripped', '5,500 is not below 50% of 10,000');
});

test('N-23: a trip costs 20 points on Account Health', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await shop.settle({ ms: 2000, roundMs: 200 });
  assert.equal((await shop.health()).deductions.find((d) => d.code === 'reach_guard_tripped')?.points, -20);
});

test('N-23: another business\'s trip is no concern of this one, and its slow mode stays off', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await tripped(a);
  await history(b);
  await b.evaluate();
  assert.notEqual((await b.guard()).state, 'tripped');
  assert.equal((await b.get('/compliance/status')).slowMode.active, false);
  assert.deepEqual((await b.get('/reach-guard/trips')).items, []);
});

test('N-23: a day Meta has no reach for neither counts towards a trip nor as a good day', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await low(shop, { 5: 5000, 4: null, 3: 5000, 2: null });
  await shop.evaluate();
  assert.notEqual((await shop.guard()).state, 'tripped');
});

test('N-23: Meta timing out on the evaluation adds no trip and takes none away', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await world.meta.fault({ kind: 'timeout', delayMs: 50, times: 'forever', match: { path: '*/insights' } });
  try {
    await shop.evaluate();
  } finally {
    await world.meta.delete('/faults');
  }
  assert.notEqual((await shop.guard()).state, 'tripped');
  assert.equal((await trips(shop)).length, 0);
});

// ---- N-24 ------------------------------------------------------------------------------------------------------------

test('N-24: today\'s unsettled reach of 2,000 doesn\'t trip', async () => {
  const shop = await addP2Shop(world);
  await history(shop, { oldest: 1 });
  await low(shop, { 0: 2000 });
  await shop.evaluate();
  const res = await shop.guard();
  assert.equal(res.state, 'normal');
  assert.equal(res.slowMode.active, false);
});

test('N-24: today and yesterday both low don\'t trip either', async () => {
  const shop = await addP2Shop(world);
  await history(shop, { oldest: 2 });
  await low(shop, { 1: 2000, 0: 2000 });
  await shop.evaluate();
  assert.equal((await shop.guard()).state, 'normal');
});

test('N-24: a day exactly 2 days old is settled: low days 4, 3 and 2 days ago trip', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await low(shop, { 4: 5000, 3: 5000, 2: 5000, 1: NORMAL, 0: NORMAL });
  await shop.evaluate();
  assert.equal((await shop.guard()).state, 'tripped');
});

test('N-24: a day 1 day old isn\'t: low days 3, 2 and 1 days ago don\'t trip', async () => {
  const shop = await addP2Shop(world);
  await history(shop, { oldest: 4 });
  await low(shop, { 3: 5000, 2: 5000, 1: 5000, 0: NORMAL });
  await shop.evaluate();
  assert.notEqual((await shop.guard()).state, 'tripped');
});

test('N-24: Meta\'s early figure for a recent day can\'t trip it, and the settled one is what is used', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await world.meta.post('/insights/daily', { igUserId: shop.igUserId, metric: 'reach', points: [{ day: new Date(Date.now() - DAY).toISOString().slice(0, 10), early: 1, value: NORMAL }, { day: new Date().toISOString().slice(0, 10), early: 1, value: NORMAL }] });
  await shop.evaluate();
  assert.equal((await shop.guard()).state, 'normal');
});

test('N-24: unsettled days aren\'t in the baseline', async () => {
  const shop = await addP2Shop(world);
  await history(shop, { oldest: 2 });
  await low(shop, { 1: 1, 0: 1 });
  await shop.evaluate();
  const res = await shop.guard();
  assert.equal(res.baselineReach, NORMAL);
  assert.equal(res.settledDays, 28);
});

// ---- N-25 ------------------------------------------------------------------------------------------------------------

test('N-25: 6 days of data is Learning, and even a collapse can\'t trip', async () => {
  const shop = await addP2Shop(world);
  await shop.seedDays('reach', { 7: 10000, 6: 10000, 5: 10000, 4: 10, 3: 10, 2: 10 });
  for (let i = 0; i < 6; i++) await shop.seedMedia({ mediaId: `r${i}x${unique()}`, kind: 'reel', postedAgoMs: 8 * DAY, latest: { reach: 5000 }, snapshots: [{ ageMinutes: 1440, metrics: { reach: 5000 } }] });
  await shop.evaluate();
  const res = await shop.guard();
  assert.equal(res.state, 'learning');
  assert.equal(res.slowMode.active, false);
  assert.equal((await trips(shop)).length, 0);
  assert.equal((await shop.alerts()).filter((a) => /reach/i.test(a.kind)).length, 0);
});

for (const [settled, media, state] of [[13, 5, 'learning'], [14, 4, 'learning'], [14, 5, 'normal']]) {
  test(`N-25: ${settled} settled days and ${media} media is ${state === 'normal' ? 'past' : 'still'} Learning`, async () => {
    const shop = await addP2Shop(world);
    await shop.seedDays('reach', range(2, settled, NORMAL));
    for (let i = 0; i < media; i++) await shop.seedMedia({ mediaId: `r${i}x${unique()}`, kind: 'reel', postedAgoMs: 8 * DAY, latest: { reach: 5000 }, snapshots: [{ ageMinutes: 1440, metrics: { reach: 5000 } }] });
    await shop.evaluate();
    const res = await shop.guard();
    assert.equal(res.state, state);
    assert.equal(res.settledDays, settled);
    assert.equal(res.mediaCounted, media);
  });
}

test('N-25: a new account starts in Learning, says so, and shows no baseline yet', async () => {
  const shop = await addP2Shop(world);
  await shop.settle({ ms: 1500, roundMs: 200 });
  const res = await shop.guard();
  assert.equal(res.state, 'learning');
  assert.equal(res.baselineReach, null);
  assert.equal(res.trip, null);
  assert.ok(res.message.length > 0);
});

// ---- N-26 ------------------------------------------------------------------------------------------------------------

async function afterDays(shop, days, values) {
  await world.travel(days * DAY);
  await shop.seedDays('reach', values);
  await shop.evaluate();
}

test('N-26: three settled days back at 80% or more clear it, and restoring starts', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await afterDays(shop, 3, { 5: 9000, 4: 9000, 3: 9000, 2: 9000, 1: NORMAL, 0: NORMAL });
  const res = await shop.guard();
  assert.equal(res.state, 'normal');
  assert.equal(res.trip?.clearedAt ?? (await trips(shop))[0].cleared_at !== null, true, 'The trip is cleared');
  assert.ok((await trips(shop))[0].cleared_at, 'The trip row is closed');
  assert.equal(res.slowMode.active, false);
  assert.equal(res.slowMode.restoring, true);
});

test('N-26: restoring runs at 75%, then is over at 100% after 48h, exactly', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await afterDays(shop, 3, { 5: 9000, 4: 9000, 3: 9000, 2: 9000, 1: NORMAL, 0: NORMAL });
  await world.travel(48 * HOUR - INSIDE_MS * 2);
  assert.equal((await shop.guard()).slowMode.restoring, true, 'Just inside 48h');
  await world.travel(INSIDE_MS * 2 + OUTSIDE_MS);
  assert.equal((await shop.guard()).slowMode.restoring, false, 'Just past 48h');
});

test('N-26: two good days aren\'t enough', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await afterDays(shop, 2, { 3: 9000, 2: 9000, 1: NORMAL, 0: NORMAL });
  assert.equal((await shop.guard()).state, 'tripped');
});

test('N-26: at exactly 80% of baseline it clears', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await afterDays(shop, 3, { 5: 8000, 4: 8000, 3: 8000, 2: 8000, 1: NORMAL, 0: NORMAL });
  assert.equal((await shop.guard()).state, 'normal');
});

test('N-26: at one less than 80% it doesn\'t', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await afterDays(shop, 3, { 5: 7999, 4: 7999, 3: 7999, 2: 7999, 1: NORMAL, 0: NORMAL });
  assert.equal((await shop.guard()).state, 'tripped');
});

test('N-26: a good run interrupted doesn\'t clear', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await afterDays(shop, 3, { 5: 9000, 4: 3000, 3: 9000, 2: 9000, 1: NORMAL, 0: NORMAL });
  assert.equal((await shop.guard()).state, 'tripped');
});

test('N-26: unsettled good days don\'t clear it early', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await afterDays(shop, 1, { 1: NORMAL, 0: NORMAL });
  assert.equal((await shop.guard()).state, 'tripped');
});

test('N-26: a second trip after clearing is a new trip with its own alerts', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await afterDays(shop, 3, { 5: 9000, 4: 9000, 3: 9000, 2: 9000, 1: NORMAL, 0: NORMAL });
  await afterDays(shop, 3, { 5: 4000, 4: 4000, 3: 4000, 2: 4000, 1: NORMAL, 0: NORMAL });
  const all = await trips(shop);
  assert.equal(all.length, 2);
  assert.ok(all[1].alert_email_at, 'The second trip alerts too');
  assert.equal((await shop.get('/reach-guard/trips')).items.length, 2);
});

test('N-26: a clear ends only the reach-drop cause: an 80002 pause still holds slow mode', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await shop.sql(`UPDATE account_rate_state SET slow_mode_holds = slow_mode_holds || jsonb_build_object('buc_80002', (now() + interval '6 hours')::text) WHERE tenant_id = $1 AND account_id = $2`, [shop.tenantId, shop.igUserId]);
  await afterDays(shop, 3, { 5: 9000, 4: 9000, 3: 9000, 2: 9000, 1: NORMAL, 0: NORMAL });
  const res = await shop.guard();
  assert.equal(res.slowMode.active, true);
  assert.equal(res.slowMode.trigger, 'buc_80002');
  assert.equal(res.slowMode.canOverride, false);
});

// ---- N-27 and N-28 -----------------------------------------------------------------------------------------------------

const override = (shop, token, confirmation = 'override') => shop.as(token, '/compliance/slow-mode/override', { method: 'POST', body: { confirmation } });

test('N-27: a manager can\'t override slow mode: "Owner only"', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  const manager = await shop.addManager();
  const res = await override(shop, manager.token);
  assert.equal(res.status, 403);
  assert.match(res.json().error, /Owner only/);
  assert.equal((await shop.guard()).slowMode.active, true, 'Slow mode stays on');
});

test('N-27: nor can staff, a shopper, or nobody at all', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  const staff = await shop.addStaff(['analytics']);
  const customer = await shop.addCustomer();
  for (const token of [staff.token, customer.token]) assert.equal((await override(shop, token)).status, 403);
  assert.equal((await override(shop, undefined)).status, 401);
});

test('N-27: the owner overrides a reach drop by typing the confirmation, and it is in the audit log', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  assert.equal((await override(shop, shop.token, 'yes')).status, 400, 'The confirmation has to be typed');
  need(await override(shop, shop.token), 200, 'The override');
  const res = await shop.guard();
  assert.equal(res.slowMode.active, false);
  assert.ok(res.trip.overriddenAt, 'The trip records it');
  assert.ok((await shop.audit('slow')).length >= 1, 'The audit log has it');
});

test('N-27: another business\'s owner overrides nothing here', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await tripped(a);
  await override(a, b.token).catch(() => {});
  assert.equal((await a.guard()).slowMode.active, true);
});

test('N-27: Reach Guard looking again keeps the owner\'s override', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  need(await override(shop, shop.token), 200, 'The override');
  await shop.evaluate();
  await shop.evaluate();
  assert.equal((await shop.guard()).slowMode.active, false);
});

test('N-28: the owner can\'t override slow mode caused by 80002', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  await world.meta.post('/throttle', { igUserId: shop.igUserId, regainMinutes: 30 });
  await shop.poll();
  const before = await shop.guard();
  assert.equal(before.slowMode.active, true);
  assert.equal(before.slowMode.trigger, 'buc_80002');
  assert.equal(before.slowMode.canOverride, false);
  const res = await override(shop, shop.token);
  assert.ok([400, 403, 409].includes(res.status), `Refused, got ${res.status}`);
  assert.equal((await shop.guard()).slowMode.active, true);
});

test('N-28: the owner can\'t override slow mode from denied insights', async () => {
  const shop = await addP2Shop(world);
  await shop.poll();
  await world.meta.post('/tokens/scopes', { igUserId: shop.igUserId, scopes: ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'] });
  await shop.poll();
  const before = await shop.guard();
  assert.deepEqual([before.state, before.slowMode.active, before.slowMode.canOverride], ['permission_needed', true, false]);
  assert.ok((await override(shop, shop.token)).status >= 400);
});

test('N-28: with a reach drop and 80002 at once the override is still refused', async () => {
  const shop = await addP2Shop(world);
  await tripped(shop);
  await world.meta.post('/throttle', { igUserId: shop.igUserId, regainMinutes: 30 });
  await shop.poll();
  assert.equal((await shop.guard()).slowMode.canOverride, false);
  assert.ok((await override(shop, shop.token)).status >= 400);
});

test('N-28: a Watch state ends when the 80002 regain time has passed, and Reach Guard goes back', async () => {
  const shop = await addP2Shop(world);
  await history(shop);
  await shop.poll();
  await world.meta.post('/throttle', { igUserId: shop.igUserId, regainMinutes: 30 });
  await shop.poll();
  assert.equal((await shop.guard()).state, 'watch');
  await world.travel(ANALYTICS_LIMITS.refreshNowEveryMs * 12, { sim: true });
  await shop.evaluate();
  assert.equal((await shop.guard()).state, 'normal');
});

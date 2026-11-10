// Reach Guard against the real database and the real compliance module, on a clock the test controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetMultiplier } from '../../../src/modules/compliance/gate.js';
import { SWEEP, reachGuard } from '../../../src/modules/reach-guard/index.js';
import { COMPLIANCE_LIMITS } from '../../../src/contracts/compliance.js';
import { withTenant } from '../../../src/tenancy.js';
import { DAY, HOUR, IG, START, addAnalyticsAccount, at, connectAccount, establish, normalMedia, noonSettling, seedDays, seedMedia, settle, world } from './support.js';

async function tripped(w) {
  await establish(w);
  await settle(w, '2026-11-06', 5500);
  await settle(w, '2026-11-07', 5200);
  return settle(w, '2026-11-08', 5800);
}

test('N-23: three settled low days trip on the third, once, with one alert per channel and the reason code', async () => {
  const w = await world();
  await establish(w);

  assert.equal(await settle(w, '2026-11-06', 5500), 'normal');
  assert.equal((await w.tripRows()).length, 0);
  assert.equal(await settle(w, '2026-11-07', 5200), 'normal');
  assert.equal((await w.tripRows()).length, 0, 'two low days do not trip');
  assert.equal((await w.slow()).active, false);

  assert.equal(await settle(w, '2026-11-08', 5800), 'tripped');
  const [trip] = await w.tripRows();
  assert.equal(trip.trigger, 'reach_days');
  assert.equal(Number(trip.baseline), 10_000);
  assert.equal(trip.drop_percent, 45);
  assert.deepEqual(trip.observed.map((d) => d.reach), [5500, 5200, 5800]);

  const slow = await w.slow();
  assert.deepEqual([slow.active, slow.trigger, slow.canOverride, slow.multiplier], [true, 'reach_drop', true, COMPLIANCE_LIMITS.reducedBudgetMultiplier]);

  assert.ok(trip.alert_push_at && trip.alert_banner_at && trip.alert_email_at, 'every channel told');
  const [alert] = await w.alertRows();
  assert.equal(alert.kind, 'reach_guard.tripped');
  assert.match(alert.message, /^Reach is down 45% vs your usual\. Possible normal causes: /);
  assert.deepEqual((await w.reasonRows()).map((r) => [r.reason, r.details.trigger, r.details.slowMode]), [['rate.slow_mode', 'reach_drop', 'start']]);

  const stamps = [trip.alert_push_at, trip.alert_banner_at, trip.alert_email_at].map(Number);
  for (let i = 0; i < 4; i++) {
    w.clock.t += HOUR;
    assert.equal(await w.evaluate(), 'tripped');
  }
  const rows = await w.tripRows();
  assert.equal(rows.length, 1, 'one trip');
  assert.deepEqual([rows[0].alert_push_at, rows[0].alert_banner_at, rows[0].alert_email_at].map(Number), stamps, 'alerts are not repeated');
  assert.equal((await w.alertRows()).length, 1);
  assert.equal((await w.reasonRows()).length, 1);
});

test('two evaluations at the same moment make one trip and one alert', async () => {
  const w = await world();
  await establish(w);
  await seedDays(w.db, w.tenant, w.ref, '2026-11-08', [5500, 5200, 5800]);
  at(w, '2026-11-08');
  await Promise.all([w.evaluate(), w.evaluate(), w.evaluate()]);
  assert.equal((await w.tripRows()).length, 1);
  assert.equal((await w.alertRows()).length, 1);
  assert.equal((await w.reasonRows()).length, 1);
});

test('N-24: reach that has not settled cannot trip, however low', async () => {
  const w = await world();
  await establish(w);
  await seedDays(w.db, w.tenant, w.ref, '2026-11-06', [9000]);
  at(w, '2026-11-06');
  await seedDays(w.db, w.tenant, w.ref, '2026-11-08', [2000, 2000]); // yesterday and today, unsettled
  assert.equal(await w.evaluate(), 'normal');
  assert.equal((await w.tripRows()).length, 0);
});

test('an empty day is no data: it is not low, and it breaks a run', async () => {
  const w = await world();
  await establish(w);
  await seedDays(w.db, w.tenant, w.ref, '2026-11-09', [5000, 5000, null, 5000]);
  at(w, '2026-11-09');
  assert.equal(await w.evaluate(), 'normal');
  assert.equal((await w.tripRows()).length, 0);
});

test('N-25: 6 days of data is Learning and cannot trip', async () => {
  const w = await world();
  await seedDays(w.db, w.tenant, w.ref, '2026-11-08', [10_000, 10_000, 10_000, 1, 1, 1]);
  await seedMedia(w.db, w.tenant, w.ref, normalMedia(8));
  at(w, '2026-11-08');
  assert.equal(await w.evaluate(), 'learning');
  assert.equal((await w.tripRows()).length, 0);
  assert.equal((await w.slow()).active, false);
  const s = await w.status();
  assert.deepEqual([s.state, s.settledDays, s.mediaCounted], ['learning', 6, 8]);
  assert.match(s.message, /learning/i);
});

test('Learning also holds with enough days and too few media', async () => {
  const w = await world();
  await seedDays(w.db, w.tenant, w.ref, '2026-11-08', [...Array(20).fill(10_000), 1, 1, 1]);
  await seedMedia(w.db, w.tenant, w.ref, normalMedia(4));
  at(w, '2026-11-08');
  assert.equal(await w.evaluate(), 'learning');
  assert.equal((await w.tripRows()).length, 0);
});

test('N-26: three recovered days clear the trip, and slow mode restores at 75% then 100% over 48h', async () => {
  const w = await world();
  await tripped(w);
  assert.equal(await settle(w, '2026-11-09', 8500), 'tripped');
  assert.equal(await settle(w, '2026-11-10', 9000), 'tripped');
  assert.equal(await settle(w, '2026-11-11', 8000), 'normal');

  const [trip] = await w.tripRows();
  assert.ok(trip.cleared_at);
  assert.equal(+trip.cleared_at, w.clock.t);
  let slow = await w.slow();
  assert.deepEqual([slow.active, slow.restoring, slow.multiplier], [false, true, 0.75]);
  assert.deepEqual((await w.reasonRows()).map((r) => r.details.slowMode), ['start', 'restore']);

  const s = await w.status();
  assert.deepEqual([s.state, s.trip, s.slowMode.restoring], ['normal', null, true]);
  assert.match(s.message, /48 hours/);

  w.clock.t += 48 * HOUR;
  slow = await w.slow();
  assert.deepEqual([slow.restoring, slow.multiplier], [false, 1]);
});

test('a dip back under the clear level restarts the 3 days', async () => {
  const w = await world();
  await tripped(w);
  await settle(w, '2026-11-09', 8500);
  await settle(w, '2026-11-10', 8500);
  assert.equal(await settle(w, '2026-11-11', 7000), 'tripped');
  await settle(w, '2026-11-12', 8500);
  await settle(w, '2026-11-13', 8500);
  assert.equal(await settle(w, '2026-11-14', 8500), 'normal');
});

test('clearing does not end slow mode that another cause is still holding', async () => {
  const w = await world();
  await tripped(w);
  await w.inside(() => w.compliance.slowMode.enter('instagram', IG, 'buc_80002', { until: new Date(noonSettling('2026-11-11') + 10 * HOUR) }));
  await settle(w, '2026-11-09', 8500);
  await settle(w, '2026-11-10', 8500);
  assert.equal(await settle(w, '2026-11-11', 8500), 'watch');
  const slow = await w.slow();
  assert.deepEqual([slow.active, slow.trigger, slow.canOverride], [true, 'buc_80002', false]);
});

test('a new low spell after a clear is a new trip with its own alert', async () => {
  const w = await world();
  await tripped(w);
  await settle(w, '2026-11-09', 9000);
  await settle(w, '2026-11-10', 9000);
  await settle(w, '2026-11-11', 9000);
  await settle(w, '2026-11-12', 5000);
  await settle(w, '2026-11-13', 5000);
  assert.equal(await settle(w, '2026-11-14', 5000), 'tripped');
  assert.equal((await w.tripRows()).length, 2);
  assert.equal((await w.alertRows()).length, 2);
});

test('three media low at 24h trip by media; the trip clears on 3 later days and does not fire again on the same media', async () => {
  const w = await world();
  await seedDays(w.db, w.tenant, w.ref, '2026-11-08', Array(28).fill(10_000));
  await seedMedia(w.db, w.tenant, w.ref, normalMedia(10));
  await seedMedia(w.db, w.tenant, w.ref, [0, 1, 2].map((i) => ({ kind: 'reel', reach: 300 + i, postedAt: START - (10 - i) * DAY })));
  at(w, '2026-11-08');
  assert.equal(await w.evaluate(), 'tripped');
  const [trip] = await w.tripRows();
  assert.equal(trip.trigger, 'media_24h');
  assert.equal(Number(trip.baseline), 10_000, 'the trip keeps the daily baseline, which is what clears it');
  assert.equal(trip.observed.length, 3);
  assert.equal((await w.status()).trip.trigger, 'media_24h');

  await settle(w, '2026-11-09', 9000); // the trip started on the 10th, so this day can't count
  await settle(w, '2026-11-10', 9000);
  assert.equal(await settle(w, '2026-11-11', 9000), 'tripped');
  assert.equal(await settle(w, '2026-11-12', 9000), 'normal');
  w.clock.t += HOUR;
  assert.equal(await w.evaluate(), 'normal', 'the same three media can not trip it again');
  assert.equal((await w.tripRows()).length, 1);
});

test('only a figure from about 24h counts, a story uses its final snapshot, and "<5" is left out', async () => {
  const w = await world();
  await seedDays(w.db, w.tenant, w.ref, '2026-11-08', Array(28).fill(10_000));
  await seedMedia(w.db, w.tenant, w.ref, normalMedia(6));
  await seedMedia(w.db, w.tenant, w.ref, [
    { reach: 5, postedAt: START - 12 * DAY, ageMinutes: 60 }, // 1h old: not a 24h figure
    { reach: 5, postedAt: START - 11 * DAY, ageMinutes: 3 * 1440 }, // 3 days old: not a 24h figure
    { reach: null, postedAt: START - 10 * DAY, belowThreshold: true, metrics: { reach: 3 } },
    { kind: 'story', reach: 900, postedAt: START - 9 * DAY, ageMinutes: 1350 },
  ]);
  at(w, '2026-11-08');
  assert.equal(await w.evaluate(), 'normal');
  const s = await w.inside(() => w.platform.reachGuard.state(w.ref));
  assert.equal(s.mediaCounted, 7, 'six reels and the story');
  assert.equal((await w.tripRows()).length, 0);
});

test('what was worked out is kept per day and per type', async () => {
  const w = await world();
  await establish(w);
  await settle(w, '2026-11-06', 9000);
  const rows = await w.db.platform.query(`SELECT to_char(day, 'YYYY-MM-DD') AS d, scope, baseline, sample, observed FROM reach_guard_baselines WHERE tenant_id = $1 ORDER BY scope`, [w.tenant.id]);
  assert.deepEqual(rows.map((r) => [r.d, r.scope, Number(r.baseline), r.sample, Number(r.observed)]), [
    ['2026-11-06', 'account', 10_000, 28, 9000],
    ['2026-11-06', 'reel', 1000, 6, 1000],
  ]);
});

test('thresholds are obeyed: a higher line trips what the default would not', async () => {
  const w = await world();
  await establish(w);
  await seedDays(w.db, w.tenant, w.ref, '2026-11-08', [7000, 7000, 7000]);
  at(w, '2026-11-08');
  assert.equal(await w.evaluate(), 'normal');
  await w.db.platform.query('UPDATE reach_guard_state SET reach_drop_percent = 75 WHERE tenant_id = $1', [w.tenant.id]);
  w.clock.t += HOUR;
  assert.equal(await w.evaluate(), 'tripped');
});

test('80002 sets Watch, even while Learning, and it ends when the hold ends', async () => {
  const w = await world();
  await w.inside(() => w.compliance.observeCall('instagram', IG, { kind: 'buc_throttled', usage: { percent: 100, regainMinutes: 30 } }));
  assert.equal(await w.evaluate(), 'watch');
  const s = await w.status();
  assert.equal(s.state, 'watch');
  assert.deepEqual([s.slowMode.active, s.slowMode.trigger, s.slowMode.canOverride], [true, 'buc_80002', false]);
  w.clock.t += 2 * HOUR;
  assert.equal(await w.evaluate(), 'learning');
});

test('an open trip stays Tripped through an 80002, and slow mode then can not be overridden', async () => {
  const w = await world();
  await tripped(w);
  await w.inside(() => w.compliance.observeCall('instagram', IG, { kind: 'buc_throttled', usage: { regainMinutes: 30 } }));
  w.clock.t += HOUR / 2;
  assert.equal(await w.evaluate(), 'tripped');
  assert.equal((await w.slow()).canOverride, false);
});

test('N-34: insights denied is Permission needed and slow mode, once; a later grant lifts it', async () => {
  const w = await world();
  await establish(w);
  at(w, '2026-11-05');
  assert.equal(await w.evaluate(), 'normal');

  await w.db.platform.query(`UPDATE analytics_accounts SET permission = 'denied' WHERE id = $1`, [w.ref]);
  assert.equal(await w.evaluate(), 'permission_needed');
  let slow = await w.slow();
  assert.deepEqual([slow.active, slow.trigger, slow.canOverride], [true, 'insights_denied', false]);
  const s = await w.status();
  assert.equal(s.state, 'permission_needed');
  assert.match(s.message, /^Permission needed\./);

  w.clock.t += HOUR;
  assert.equal(await w.evaluate(), 'permission_needed');
  assert.equal((await w.alertRows()).filter((a) => a.kind === 'reach_guard.permission_needed').length, 1);
  assert.deepEqual((await w.reasonRows()).map((r) => r.details.trigger), ['insights_denied']);

  await w.db.platform.query(`UPDATE analytics_accounts SET permission = 'ok' WHERE id = $1`, [w.ref]);
  w.clock.t += HOUR;
  assert.equal(await w.evaluate(), 'normal');
  slow = await w.slow();
  assert.deepEqual([slow.active, slow.restoring, slow.multiplier], [false, true, 0.75]);
});

test('N-34: a revoked scope is Permission needed without waiting for a refused call', async () => {
  const w = await world();
  await w.db.platform.query('UPDATE ig_accounts SET granted_scopes = $2 WHERE ig_user_id = $1', [IG, ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments']]);
  assert.equal(await w.evaluate(), 'permission_needed');
  assert.equal((await w.slow()).trigger, 'insights_denied');
});

test('an account with no permissions on record is not treated as denied', async () => {
  const w = await world({ scopes: [] });
  assert.equal(await w.evaluate(), 'learning');
  assert.equal((await w.slow()).active, false);
});

test('no trip while insights are denied, and the slow mode from it is real on the gate', async () => {
  const w = await world();
  await establish(w);
  await seedDays(w.db, w.tenant, w.ref, '2026-11-08', [1000, 1000, 1000]);
  await w.db.platform.query(`UPDATE analytics_accounts SET permission = 'denied' WHERE id = $1`, [w.ref]);
  at(w, '2026-11-08');
  assert.equal(await w.evaluate(), 'permission_needed');
  assert.equal((await w.tripRows()).length, 0);
  const rate = await w.inside(() => w.compliance.gate.rateState('instagram', IG));
  assert.equal(budgetMultiplier({ rate }, w.clock.t, COMPLIANCE_LIMITS), COMPLIANCE_LIMITS.reducedBudgetMultiplier);
});

test('slow mode is kept on while a trip lasts, past the 7 day hold', async () => {
  const w = await world();
  await tripped(w);
  for (let i = 0; i < 12; i++) {
    w.clock.t += DAY;
    await w.evaluate();
  }
  assert.equal((await w.slow()).active, true);
});

test('the owner\'s override stands across evaluations, is written on the trip, and the trip stays open', async () => {
  const w = await world();
  await tripped(w);
  const owner = await w.inside(() => w.platform.users.create({ name: 'Owner', phone: '9000000099', password: 'owner-pass-1', role: 'manager' }));
  await w.inside(() => w.compliance.overrideSlowMode('instagram', IG));
  await w.inside(() => w.platform.audit.record({ actor: `user:${owner.id}`, action: 'compliance.slow_mode_override', target: String(w.tenant.id) }));
  w.clock.t += HOUR;
  assert.equal(await w.evaluate(), 'tripped');
  assert.equal((await w.slow()).active, false, 'still overridden after asking again');

  const [trip] = await w.tripRows();
  assert.equal(trip.override_by, owner.id);
  assert.equal(+trip.override_at, noonSettling('2026-11-08'));

  const s = await w.status();
  assert.equal(+new Date(s.trip.overriddenAt), +trip.override_at);
  assert.match(s.message, /turned slow mode off/);
});

test('one business never sees or changes another\'s', async () => {
  const w = await world();
  await tripped(w);
  const other = await w.platform.tenants.create({ slug: 'second-shop', name: 'Second' });
  await connectAccount(w.db, w.platform, other, 'IG-B');
  const otherRef = await addAnalyticsAccount(w.db, other, 'IG-B');
  const asOther = (fn) => withTenant(other, fn);

  const s = await asOther(() => w.guard.status());
  assert.deepEqual([s.state, s.trip], ['learning', null]);
  assert.deepEqual(await asOther(() => w.platform.reachGuard.trips({ limit: 10 })), { items: [], nextCursor: null });
  assert.equal(await asOther(() => w.platform.reachGuard.account(w.ref)), null);
  assert.equal(await asOther(() => w.platform.reachGuard.state(w.ref)), null);
  assert.equal(await asOther(() => w.platform.reachGuard.openTrip(w.ref)), null);

  await asOther(() => w.platform.reachGuard.ensureState(otherRef, new Date(w.clock.t)));
  await asOther(() => w.platform.reachGuard.setThresholds({ reachDropPercent: 75 }, 'user:1'));
  const [mine] = await w.db.platform.query('SELECT reach_drop_percent FROM reach_guard_state WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(mine.reach_drop_percent, 60);
  assert.equal((await asOther(() => w.compliance.slowMode.status('instagram', IG))).active, false, 'its slow mode can\'t be seen from here');
  assert.equal((await w.slow()).active, true);
});

test('another business\'s account can\'t be linked to a trip, by the database itself', async () => {
  const w = await world();
  const other = await w.platform.tenants.create({ slug: 'third-shop', name: 'Third' });
  await assert.rejects(() => withTenant(other, () => w.db.query(`INSERT INTO reach_guard_trips (tenant_id, account_ref, trigger) VALUES ($1, $2, 'reach_days')`, [other.id, w.ref])));
});

test('a Facebook Page is looked after the same way, and only its own slow mode changes', async () => {
  const w = await world();
  await w.db.platform.query(`INSERT INTO fb_pages (page_id, tenant_id, name, access_token_enc, granted_scopes) VALUES ('PAGE-1', $1, 'Page', 'x', $2)`, [w.tenant.id, ['pages_messaging', 'pages_manage_metadata', 'pages_read_engagement']]);
  const [row] = await w.db.platform.query(`INSERT INTO analytics_accounts (tenant_id, channel, fb_page_id, collecting_since) VALUES ($1, 'facebook', 'PAGE-1', '2025-01-01') RETURNING id`, [w.tenant.id]);
  await seedDays(w.db, w.tenant, row.id, '2026-11-08', [...Array(28).fill(10_000), 5000, 5000, 5000]);
  await seedMedia(w.db, w.tenant, row.id, normalMedia(6));
  at(w, '2026-11-08');
  const page = await w.inside(() => w.platform.reachGuard.account(row.id));
  assert.equal(await w.inside(() => w.guard.evaluate(page)), 'tripped');
  assert.equal((await w.inside(() => w.compliance.slowMode.status('facebook', 'PAGE-1'))).active, true);
  assert.equal((await w.slow()).active, false, 'the Instagram account is untouched');
  assert.equal((await w.reasonRows())[0].channel, 'facebook');
  const s = await w.status();
  assert.equal(s.state, 'tripped', 'the business shows its worst account');

  assert.deepEqual((await w.inside(() => w.guard.computeHealth(page))).deductions.map((d) => d.code), ['reach_guard_tripped']);
  await w.db.platform.query(`UPDATE fb_pages SET status = 'reconnect_needed' WHERE page_id = 'PAGE-1'`);
  const lost = await w.inside(() => w.guard.computeHealth(page));
  assert.equal(lost.score, 0);
  assert.match(lost.deductions[0].fix, /Reconnect Facebook/);
});

test('every repo call refuses to run outside a business', async () => {
  const w = await world();
  await assert.rejects(() => w.platform.reachGuard.accounts(), /tenant context/);
  await assert.rejects(() => w.platform.reachGuard.trips({ limit: 1 }), /tenant context/);
  await assert.rejects(() => w.guard.status(), /tenant context/);
});

test('the sweep looks at what is due, in each account\'s own business, and skips a closed one', async () => {
  const w = await world();
  await tripped(w);
  const other = await w.platform.tenants.create({ slug: 'fourth-shop', name: 'Fourth' });
  await connectAccount(w.db, w.platform, other, 'IG-D');
  await addAnalyticsAccount(w.db, other, 'IG-D');
  const closed = await w.platform.tenants.create({ slug: 'fifth-shop', name: 'Fifth' });
  await connectAccount(w.db, w.platform, closed, 'IG-E');
  const closedRef = await addAnalyticsAccount(w.db, closed, 'IG-E');
  await w.db.platform.query(`UPDATE tenants SET status = 'closed' WHERE id = $1`, [closed.id]);

  assert.equal(await w.guard.sweep(), 1, 'the first account was looked at a moment ago');
  const [row] = await w.db.platform.query('SELECT state, evaluated_at FROM reach_guard_state WHERE tenant_id = $1', [other.id]);
  assert.equal(row.state, 'learning');
  assert.equal((await w.db.platform.query('SELECT 1 FROM reach_guard_state WHERE account_ref = $1', [closedRef])).length, 0);
  assert.equal(await w.guard.sweep(), 0, 'nothing is due now');

  w.clock.t += 16 * 60_000;
  assert.equal(await w.guard.sweep(), 2);
  const [health] = await w.db.platform.query('SELECT score FROM account_health WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(health.score, 80, 'the sweep also works out Account Health, -20 for the trip');
});

test('the worker runs the sweep through the queue, once per interval', async () => {
  const w = await world();
  const work = new Map();
  const every = [];
  const ctx = { db: w.db, repos: w.platform, compliance: w.compliance, platform: { queue: { work: (name, fn) => work.set(name, fn), every: async (name, ms) => every.push([name, ms]) } } };
  const schedule = reachGuard.jobs(ctx);
  await schedule();
  assert.deepEqual(every, [[SWEEP, 60_000]]);
  assert.equal(await work.get(SWEEP)(), 1);
  const [row] = await w.db.platform.query('SELECT state FROM reach_guard_state WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(row.state, 'learning');
});

test('the module answers its five routes, and reading the route ids needs no app', () => {
  assert.deepEqual(Object.keys(reachGuard.api({ repos: {}, config: {}, ig: {}, auth: {} })).sort(), ['accountHealth.get', 'accountHealth.history', 'reachGuard.setThresholds', 'reachGuard.status', 'reachGuard.trips']);
});

test('nothing here sends: the guard has no way to Meta', async () => {
  const w = await world();
  await tripped(w);
  const jobs = await w.db.platform.query('SELECT count(*)::int AS n FROM outbound_jobs WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(jobs[0].n, 0);
});

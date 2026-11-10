// PRD 4.12, 4.13: the per-business breaker, and the guard across businesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, MINUTE, metaError, privateReply, scriptedIg, world } from './support.js';

const enqueue = (w, action, options) => w.inBusiness(() => w.compliance.enqueue(action, options));
const permission = () => metaError({ code: 200 });
const newJob = (w, n) => enqueue(w, privateReply(w, { personId: `p${n}`, expiresAt: new Date(w.clock.t + 20 * HOUR) }));

/** Trips the breaker with five permission errors, two minutes apart. */
async function tripped(w) {
  for (let i = 0; i < 5; i++) {
    await newJob(w, `trip${i}`);
    await w.turn();
    w.clock.advance(2 * MINUTE);
  }
}

test('C-42: five permission errors in 10 minutes open this business\'s breaker and no other\'s', async () => {
  const a = await world({ ig: scriptedIg(Array.from({ length: 5 }, permission)) });
  const b = await world({ base: a, at: a.clock.t });
  await tripped(a);
  assert.equal((await a.breakerState()).state, 'open');
  assert.deepEqual((await a.alerts()).map((al) => al.kind), ['breaker.open']);

  await newJob(a, 'after');
  await a.turn();
  assert.deepEqual((await a.jobs()).at(-1).status, 'held');
  assert.deepEqual((await a.jobs()).at(-1).reason, 'paused.breaker');
  assert.equal(a.ig.calls.length, 5);

  b.clock.t = a.clock.t;
  await newJob(b, 'b1');
  await b.turn();
  assert.equal((await b.jobs())[0].status, 'sent');
});

test('four errors, or five spread over more than 15 minutes, do not trip it', async () => {
  const w = await world({ ig: scriptedIg(Array.from({ length: 6 }, permission)) });
  for (let i = 0; i < 4; i++) {
    await newJob(w, i);
    await w.turn();
  }
  assert.equal((await w.breakerState()).state, 'closed');
  w.clock.advance(16 * MINUTE);
  await newJob(w, 'late');
  await w.turn();
  assert.equal((await w.breakerState()).state, 'closed');
});

test('over 20% send errors across 50 sends trips it', async () => {
  const unknown = () => metaError({ status: 500, kind: 'server_error', delivery: 'unknown' });
  const script = [...Array.from({ length: 39 }, () => null), ...Array.from({ length: 11 }, unknown)];
  const w = await world({ ig: scriptedIg(script), limits: { privateRepliesPerHour: 1_000_000 } });
  for (let i = 0; i < 50; i++) await newJob(w, i);
  await w.settle();
  assert.equal(w.ig.calls.length, 50);
  assert.equal((await w.breakerState()).state, 'open');
  assert.equal((await w.breakerState()).trip_reason, 'error_rate');
});

test('at exactly 20% it stays closed', async () => {
  const unknown = () => metaError({ status: 500, kind: 'server_error', delivery: 'unknown' });
  const script = [...Array.from({ length: 40 }, () => null), ...Array.from({ length: 10 }, unknown)];
  const w = await world({ ig: scriptedIg(script), limits: { privateRepliesPerHour: 1_000_000 } });
  for (let i = 0; i < 50; i++) await newJob(w, i);
  await w.settle();
  assert.equal((await w.breakerState()).state, 'closed');
});

test('three throttle cycles in a row trip it, and a success in between starts the count over', async () => {
  const throttle = () => metaError({ code: 613 });
  const w = await world({ ig: scriptedIg([throttle(), throttle(), null, throttle(), throttle()]) });
  await newJob(w, 0);
  await w.turn();
  w.clock.advance(5 * MINUTE);
  await w.turn();
  w.clock.advance(10 * MINUTE);
  await w.turn();
  assert.equal((await w.jobs())[0].status, 'sent');
  assert.equal((await w.breakerState()).throttle_cycles, 0);

  await newJob(w, 1);
  await w.turn();
  w.clock.advance(5 * MINUTE);
  await w.turn();
  assert.equal((await w.breakerState()).state, 'closed');
  w.ig.script.push(throttle());
  w.clock.advance(10 * MINUTE);
  await w.turn();
  assert.equal((await w.breakerState()).state, 'open');
  assert.equal((await w.breakerState()).trip_reason, 'throttle');
});

test('after 30 minutes one probe goes, and success closes it at half speed for 15 minutes', async () => {
  const w = await world({ ig: scriptedIg(Array.from({ length: 5 }, permission)), limits: { privateRepliesPerHour: 60 } });
  await tripped(w);
  for (let i = 0; i < 3; i++) await newJob(w, `held${i}`);
  await w.turn();
  assert.deepEqual((await w.jobs()).slice(-3).map((j) => j.status), ['held', 'held', 'held']);

  w.clock.advance(27 * MINUTE);
  await w.turn();
  assert.equal(w.ig.calls.length, 5, 'not yet');

  w.clock.advance(5 * MINUTE);
  await w.turn();
  assert.equal(w.ig.calls.length, 6, 'one probe, not a burst');
  const state = await w.breakerState();
  assert.equal(state.state, 'closed');
  assert.ok(state.reduced_until && +new Date(state.reduced_until) === w.clock.t + 15 * MINUTE);
});

test('a failed probe reopens it and doubles the wait', async () => {
  const w = await world({ ig: scriptedIg(Array.from({ length: 6 }, permission)) });
  await tripped(w);
  await newJob(w, 'held');
  await w.turn();
  w.clock.advance(31 * MINUTE);
  await w.turn();
  assert.equal(w.ig.calls.length, 6);
  const state = await w.breakerState();
  assert.equal(state.state, 'open');
  assert.equal(state.wait_minutes, 60);
  assert.equal(+new Date(state.open_until), w.clock.t + 60 * MINUTE);

  w.clock.advance(59 * MINUTE);
  await w.turn();
  assert.equal(w.ig.calls.length, 6, 'the longer wait holds');
});

test('a stale read of the breaker can\'t open it early or block a probe that is due', async () => {
  const w = await world({ ig: scriptedIg(Array.from({ length: 5 }, permission)) });
  await tripped(w);
  assert.equal(await w.inBusiness(() => w.compliance.breaker.tryProbe('instagram', 60_000)), false, 'not due');
  await w.inTenant(`UPDATE breakers SET open_until = $2::timestamptz WHERE tenant_id = $1`, [w.tenant.id, new Date(w.clock.t - 1)]);
  assert.equal(await w.inBusiness(() => w.compliance.breaker.tryProbe('instagram', 60_000)), true, 'due, whatever was cached');
});

test('only one worker gets the probe', async () => {
  const w = await world({ ig: scriptedIg(Array.from({ length: 5 }, permission)) });
  await tripped(w);
  await w.inTenant(`UPDATE breakers SET open_until = $2::timestamptz WHERE tenant_id = $1`, [w.tenant.id, new Date(w.clock.t - 1)]);
  w.compliance.invalidateSwitches();
  const results = await w.inBusiness(() => Promise.all([
    w.compliance.breaker.tryProbe('instagram', 60_000),
    w.compliance.breaker.tryProbe('instagram', 60_000),
  ]));
  assert.deepEqual(results.sort(), [false, true]);
});

test('a probe whose worker died can be taken again once its lease has passed', async () => {
  const w = await world({ ig: scriptedIg(Array.from({ length: 5 }, permission)) });
  await tripped(w);
  await w.inTenant(`UPDATE breakers SET state = 'half_open', updated_at = $2::timestamptz WHERE tenant_id = $1`, [w.tenant.id, new Date(w.clock.t - 61_000)]);
  w.compliance.invalidateSwitches();
  assert.equal(await w.inBusiness(() => w.compliance.breaker.tryProbe('instagram', 60_000)), true);
});

test('any token-invalid error trips it, and reconnecting closes it', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 190, status: 401 })]) });
  await newJob(w, 0);
  await w.turn();
  assert.equal((await w.breakerState()).trip_reason, 'token.rejected');

  w.clock.advance(MINUTE);
  await w.inTenant(`UPDATE ig_accounts SET status = 'active', token_updated_at = $2::timestamptz WHERE tenant_id = $1`, [w.tenant.id, new Date(w.clock.t)]);
  await w.settle();
  assert.equal((await w.breakerState()).state, 'closed');
  assert.equal((await w.jobs())[0].status, 'sent');
});

test('a problem on Facebook leaves Instagram alone', async () => {
  const w = await world({ ig: scriptedIg(Array.from({ length: 5 }, permission)) });
  await w.inBusiness(() => w.compliance.breaker.trip('facebook', 'test'));
  w.compliance.invalidateSwitches();
  await newJob(w, 0);
  await w.settle();
  assert.equal(w.ig.calls.length, 1);
  const [ig] = await w.inTenant(`SELECT count(*)::int AS n FROM breakers WHERE tenant_id = $1 AND channel = 'instagram' AND state = 'open'`, [w.tenant.id]);
  assert.equal(ig.n, 0);
});

test('C-48: three businesses tripping within 40 minutes pages ops and freezes activations', async () => {
  const a = await world({ fresh: true, ig: scriptedIg(Array.from({ length: 5 }, permission)) });
  const b = await world({ base: a, at: a.clock.t + 10 * MINUTE });
  const c = await world({ base: a, at: a.clock.t + 30 * MINUTE });
  await a.inBusiness(() => a.compliance.breaker.trip('instagram', 'policy'));
  await b.inBusiness(() => b.compliance.breaker.trip('instagram', 'policy'));
  assert.equal(await a.inBusiness(() => a.compliance.activationsFrozen()), false);
  await c.inBusiness(() => c.compliance.breaker.trip('instagram', 'policy'));
  assert.equal(await a.inBusiness(() => a.compliance.activationsFrozen()), true);
  const alerts = await a.db.platform.query(`SELECT kind, audience, tenant_id FROM alerts WHERE audience = 'ops'`);
  assert.deepEqual(alerts, [{ kind: 'breakers.cross_tenant', audience: 'ops', tenant_id: null }]);
});

test('a score above the threshold halves the budget until ops review it', async () => {
  const w = await world({ fresh: true, limits: { privateRepliesPerHour: 60 } });
  await w.inBusiness(() => w.platform.compliance.settings());
  for (let i = 0; i < 200; i++) await w.inBusiness(() => w.platform.compliance.record({ channel: 'instagram', kind: 'dm', decision: 'sent', at: new Date(w.clock.t) }));
  for (let i = 0; i < 12; i++) await w.inBusiness(() => w.platform.compliance.record({ channel: 'instagram', kind: 'optout', decision: 'skipped', reason: 'optout', at: new Date(w.clock.t) }));
  await w.compliance.maintain();
  const [settings] = await w.inTenant('SELECT score, score_review_needed FROM compliance_settings WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(Number(settings.score), 60);
  assert.equal(settings.score_review_needed, true);
});

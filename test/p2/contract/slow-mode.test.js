// compliance.slowMode: the interface Reach Guard uses. It only changes the rate state the gate reads, and it sends nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCompliance } from '../../../src/modules/compliance/index.js';
import { budgetMultiplier } from '../../../src/modules/compliance/gate.js';
import { COMPLIANCE_LIMITS } from '../../../src/contracts/compliance.js';
import { withTenant } from '../../../src/tenancy.js';
import { IG_ACCOUNT, setup, startApp } from '../../helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-11-01T10:00:00.000Z');
const ACCOUNT = 'IG-A';

async function world() {
  const base = await setup();
  const clock = { t: START };
  const compliance = createCompliance({ db: base.db, repos: base.platform, ig: {}, config: { complianceNow: () => clock.t }, platform: {} });
  const inside = (fn) => withTenant(base.tenant, fn);
  return { ...base, clock, compliance, inside, slowMode: compliance.slowMode };
}

const status = (w) => w.inside(() => w.slowMode.status('instagram', ACCOUNT));
const enter = (w, trigger, options) => w.inside(() => w.slowMode.enter('instagram', ACCOUNT, trigger, options));
const leave = (w, trigger) => w.inside(() => w.slowMode.leave('instagram', ACCOUNT, trigger));

test('entering slow mode for a reach drop is on the rate state the gate reads, and the owner can override it', async () => {
  const w = await world();
  assert.deepEqual((await status(w)).active, false);
  await enter(w, 'reach_drop');
  const s = await status(w);
  assert.deepEqual([s.active, s.trigger, s.canOverride, s.multiplier], [true, 'reach_drop', true, COMPLIANCE_LIMITS.reducedBudgetMultiplier]);
  assert.equal(+new Date(s.until), START + 7 * DAY);
});

test('when the reach drop clears, restoring starts at 75% and is over in 48h (for N-26)', async () => {
  const w = await world();
  await enter(w, 'reach_drop');
  w.clock.t += DAY;
  assert.equal(await leave(w, 'reach_drop'), true);
  let s = await status(w);
  assert.deepEqual([s.active, s.restoring, s.multiplier], [false, true, 0.75]);
  w.clock.t += 48 * HOUR;
  s = await status(w);
  assert.deepEqual([s.restoring, s.multiplier], [false, 1]);
  assert.equal(await leave(w, 'reach_drop'), false, 'nothing left to end');
});

test('while 80002 is also a cause the owner can\'t override, and a reach drop arriving later does not change that (for N-28)', async () => {
  const w = await world();
  await enter(w, 'buc_80002', { until: new Date(START + 2 * HOUR) });
  await enter(w, 'reach_drop');
  const s = await status(w);
  assert.deepEqual([s.trigger, s.canOverride, s.triggers.sort()], ['buc_80002', false, ['buc_80002', 'reach_drop']]);
  const overridden = await w.inside(() => w.compliance.overrideSlowMode('instagram', ACCOUNT));
  assert.equal(overridden, false);
});

test('one cause ending can\'t end another that is still in force', async () => {
  const w = await world();
  const until80002 = new Date(START + 2 * HOUR);
  await enter(w, 'reach_drop');
  await enter(w, 'buc_80002', { until: until80002 });
  await leave(w, 'reach_drop');
  let s = await status(w);
  assert.deepEqual([s.active, s.trigger, s.triggers], [true, 'buc_80002', ['buc_80002']]);
  assert.equal(+new Date(s.until), +until80002);
  w.clock.t = +until80002 + 1;
  s = await status(w);
  assert.equal(s.active, false);
});

test('Reach Guard asking again keeps the owner\'s override; a new cause ends it', async () => {
  const w = await world();
  await enter(w, 'reach_drop');
  assert.equal(await w.inside(() => w.compliance.overrideSlowMode('instagram', ACCOUNT)), true);
  assert.deepEqual([(await status(w)).active, (await status(w)).overridden], [false, true]);
  w.clock.t += HOUR;
  await enter(w, 'reach_drop');
  assert.equal((await status(w)).active, false, 'the override stands');
  await enter(w, 'insights_denied');
  assert.equal((await status(w)).active, true, 'a different cause is not overridden');
});

test('a second trigger extends slow mode and does not restart it', async () => {
  const w = await world();
  await enter(w, 'reach_drop');
  const started = (await status(w)).startedAt;
  w.clock.t += HOUR;
  await enter(w, 'insights_denied');
  assert.equal(+new Date((await status(w)).startedAt), +new Date(started));
});

test('slow mode is per account and refuses an unknown cause', async () => {
  const w = await world();
  await enter(w, 'reach_drop');
  assert.equal((await w.inside(() => w.slowMode.status('instagram', 'IG-OTHER'))).active, false);
  assert.throws(() => w.slowMode.enter('instagram', ACCOUNT, 'made_up'), /Unknown slow mode trigger/);
  await assert.rejects(() => w.slowMode.status('instagram', ACCOUNT), /tenant context/);
});

test('the slow-mode multiplier is the gate\'s own', () => {
  assert.equal(budgetMultiplier({ rate: null }, START, COMPLIANCE_LIMITS), 1);
});

test('insightsGuard applies the 4.3 classes and feeds 80002 back into the rate state', async () => {
  const w = await world();
  const guard = w.compliance.insightsGuard('instagram', ACCOUNT);
  await w.inside(async () => {
    assert.equal((await guard.check('insights')).allow, true);
    await guard.observe({ usage: { percent: 80, regainMinutes: 0 } });
    assert.deepEqual([(await guard.check('insights')).allow, (await guard.check('story_insights')).allow], [false, true]);
    await guard.observe({ kind: 'buc_throttled', usage: { percent: 100, regainMinutes: 30 } });
    const paused = await guard.check('story_insights');
    assert.equal(paused.allow, false);
    assert.equal(+new Date(paused.retryAt), START + 30 * 60_000);
  });
  const s = await status(w);
  assert.deepEqual([s.active, s.canOverride], [true, false]);
});

test('a read receipt reaches consumers as a seen event with a hashed person, and no text', async () => {
  const seen = [];
  const probe = { name: 'probe', onInboundEvent: async (event) => { if (event.type === 'seen') seen.push(event); return false; } };
  const { MODULES } = await import('../../../src/modules/index.js');
  const app = await startApp({ ig: {}, modules: [probe, ...MODULES], overrides: { complianceInline: true } });
  try {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: IG_ACCOUNT.igUserId, time: START, messaging: [{ sender: { id: 'person-1' }, recipient: { id: IG_ACCOUNT.igUserId }, timestamp: START, read: { mid: 'm_abc' } }] }] });
    const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
    assert.equal((await fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body })).status, 200);
    const rows = await app.db.platform.query(`SELECT field FROM inbound_events WHERE field = 'messaging_seen'`);
    assert.equal(rows.length, 1);
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].mid, 'm_abc');
    assert.match(seen[0].subject, /^[0-9a-f]{64}$/);
    assert.equal(seen[0].text, '');
  } finally {
    app.close();
  }
});

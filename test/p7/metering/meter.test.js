// The DM meter, the hold at 100% and the alerts (PRD 5.12: F-81, F-82, F-86, F-112), on the real send gate with a Meta stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DM_LIMIT_REASON, dmUsageKey } from '../../../src/contracts/billing.js';
import { createCompliance } from '../../../src/modules/compliance/index.js';
import { createNotify } from '../../../src/modules/notifications/index.js';
import { usage as usageModule } from '../../../src/modules/usage/index.js';
import { createUsage } from '../../../src/modules/usage/service.js';
import { HOUR, MINUTE, dm, privateReply, world } from '../../p1/compliance/support.js';

const NOV_30_EVENING = Date.parse('2026-11-30T18:00:00.000Z'); // 23:30 in India: half an hour before December

/** Registers the usage module's meter with a world's gate, as setup(ctx) does in the app and the worker. */
function metered(w, { compliance = w.compliance, notify = null, config = {} } = {}) {
  const service = createUsage({ db: w.db, config: { usageNow: w.clock.now, ...config }, notify, compliance });
  compliance.useQuota({ hasDmsLeft: (call) => service.meter.hasDmsLeft(call) });
  compliance.onAccepted((event) => service.meter.accepted(event));
  return service;
}
const limitTo = (w, limit) => w.inBusiness(() => w.platform.entitlements.setOverride('dms.monthly', { enabled: true, limit }));
const monthRows = (w) => w.inTenant(`SELECT meter, to_char(month, 'YYYY-MM-DD') AS month, used::int AS used, cost_paise::int AS cost FROM usage_months WHERE tenant_id = $1 ORDER BY month, meter`, [w.tenant.id]);
const dmsUsed = async (w, month = '2026-11-01') => (await monthRows(w)).find((r) => r.meter === 'dms' && r.month === month)?.used ?? 0;
const statuses = async (w) => (await w.jobs()).filter((j) => !j.is_test && j.kind !== 'public_reply').map((j) => j.status);
const count = (list, value) => list.filter((x) => x === value).length;
const event = (w, jobId, extra = {}) => ({ tenantId: w.tenant.id, jobId, key: dmUsageKey(jobId), channel: 'instagram', kind: 'private_reply', purpose: 'trigger', automated: true, automationId: null, at: new Date(w.clock.t), ...extra });

/** A second worker on the same database and the same Meta stand-in. */
function secondWorker(w) {
  return createCompliance({
    db: w.db, repos: w.platform, ig: w.ig, platform: { metrics: { inc() {} } },
    config: { complianceNow: w.clock.now, complianceRandom: () => 0.5, complianceInline: false },
  });
}

/** Both workers drain at the same time until neither has anything to send, with the minute's releases (the gate's and the usage job's) in between. */
async function drainBoth(w, other, service, rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    w.compliance.invalidateSwitches();
    other.invalidateSwitches();
    await w.compliance.release();
    await service.sweepHeld();
    const [a, b] = await Promise.all([w.compliance.drainOutbound(), other.drainOutbound()]);
    if (!a && !b) {
      const [again] = await w.inTenant(`SELECT count(*)::int AS n FROM outbound_jobs WHERE tenant_id = $1 AND status = 'queued'`, [w.tenant.id]);
      if (!again.n) return;
    }
  }
}

test('a send is counted once however often its event arrives, and two workers counting at once lose and double nothing', async () => {
  const w = await world();
  const service = metered(w);
  const { meter } = service;

  const same = event(w, 900001);
  const results = await w.inBusiness(() => Promise.all(Array.from({ length: 25 }, () => meter.accepted(same))));
  assert.equal(results.filter(Boolean).length, 1, 'one of the 25 deliveries counted it');
  assert.equal(await dmsUsed(w), 1);

  // Two workers, each counting its own sends, at the same moment, with repeats mixed in.
  const other = createUsage({ db: w.db, config: { usageNow: w.clock.now } }).meter;
  const ids = Array.from({ length: 40 }, (_, i) => 910000 + i);
  await w.inBusiness(() => Promise.all(ids.flatMap((id) => [meter.accepted(event(w, id)), other.accepted(event(w, id)), meter.accepted(event(w, id))])));
  assert.equal(await dmsUsed(w), 41, 'every distinct send once');
  const [{ events }] = await w.inTenant(`SELECT count(*)::int AS events FROM usage_events WHERE tenant_id = $1`, [w.tenant.id]);
  assert.equal(events, 41, 'one row per send, and the month row agrees with the rows');

  // Through the real gate: each accepted reply is told once, even when the same job is settled again.
  await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { personId: 'asha' })));
  await w.settle();
  await w.settle();
  assert.equal(await dmsUsed(w), 42);
  // A listener given another business's event, or something that is not a DM, counts nothing.
  assert.equal(await w.inBusiness(() => meter.accepted(event(w, 920001, { tenantId: w.tenant.id + 1000 }))), false);
  assert.equal(await w.inBusiness(() => meter.accepted(event(w, 920002, { kind: 'public_reply' }))), false);
  assert.equal(await dmsUsed(w), 42);
});

test('F-82: test-mode sends and operator previews are never counted; the owner\'s own reply is counted but never held', async () => {
  const w = await world();
  const service = metered(w);
  for (let i = 0; i < 10; i++) await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { personId: `tester-${i}`, isTest: true })));
  await w.settle();
  assert.equal(count(await w.jobs().then((jobs) => jobs.map((j) => j.status)), 'sent'), 10, 'the test sends went');
  // Belt and braces: an event that says it is a test is not counted even if one were told.
  await w.inBusiness(() => Promise.all(Array.from({ length: 300 }, (_, i) => service.meter.accepted(event(w, 930000 + i, { purpose: 'test' })))));
  // Operator previews read the meter and change nothing.
  for (let i = 0; i < 50; i++) await w.inBusiness(() => service.meter.view());
  assert.equal(await dmsUsed(w), 0);
  assert.deepEqual(await monthRows(w), []);

  await limitTo(w, 0);
  await w.messaged('owner-thread');
  const manual = await w.inBusiness(() => w.compliance.send(dm(w, { recipientId: 'owner-thread', personId: 'owner-thread', purpose: 'manual' })));
  assert.equal(manual.outcome, 'sent', 'the owner can always answer, even with nothing left');
  assert.equal(await dmsUsed(w), 1, 'and Meta accepted it, so it is on the meter');
});

test('F-112: at 100% the hold is decided at send time, and two workers sending at the boundary cannot pass it', async () => {
  const w = await world();
  const other = secondWorker(w);
  const service = metered(w);
  metered(w, { compliance: other });
  await limitTo(w, 3);

  for (let i = 0; i < 8; i++) await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { personId: `p${i}` })));
  await drainBoth(w, other, service);
  const after = await statuses(w);
  assert.equal(count(after, 'sent'), 3, `exactly the allowance went (${after.join(', ')})`);
  assert.equal(count(after, 'held'), 5, 'the rest wait, not dropped');
  assert.equal(w.ig.calls.length, 3, 'Meta was asked three times and no more');
  assert.equal(await dmsUsed(w), 3);
  assert.ok((await w.jobs()).filter((j) => j.status === 'held').every((j) => j.reason === DM_LIMIT_REASON));

  // More turns change nothing while the month is full.
  await drainBoth(w, other, service, 5);
  assert.equal(w.ig.calls.length, 3);
});

test('F-81 and F-112: held DMs go when a pack is added or the plan goes up mid-month, each applied at once from the data', async () => {
  const w = await world();
  const service = metered(w);
  const { meter } = service;
  await w.inBusiness(() => meter.record({ meter: 'dms', quantity: 500, key: 'bulk-free-month' }));
  assert.equal(await w.inBusiness(() => meter.hasDmsLeft({ kind: 'private_reply', purpose: 'trigger' })), false, 'Free: 500 used of 500');

  // The plan goes up: tier 1 includes 5,000, at once, for this month.
  await w.db.platform.query(`INSERT INTO plan_changes (tenant_id, to_plan, to_cycle, actor, source, reason) VALUES ($1, 't1', 'monthly', 'platform:1', 'console', 'test')`, [w.tenant.id]);
  assert.equal(await w.inBusiness(() => meter.hasDmsLeft({ kind: 'private_reply', purpose: 'trigger' })), true);
  let view = await w.inBusiness(() => meter.view());
  assert.deepEqual((({ used, included, packUnits, allowance }) => ({ used, included, packUnits, allowance }))(view.meters[0]), { used: 500, included: 5000, packUnits: 0, allowance: 5000 });
  assert.equal(view.canBuyPacks, true, 'tier 1 may buy packs');

  // F-81: tier 1 sends 6,000 with one pack: 5,000 included and 1,000 from the pack.
  await w.inBusiness(() => meter.record({ meter: 'dms', quantity: 4500, key: 'bulk-t1-month' }));
  assert.equal(await w.inBusiness(() => meter.hasDmsLeft({ kind: 'dm', purpose: 'trigger' })), false);
  for (let i = 0; i < 3; i++) await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { personId: `waiting-${i}` })));
  await w.settle();
  assert.deepEqual(await statuses(w), ['held', 'held', 'held']);
  view = await w.inBusiness(() => meter.view());
  assert.equal(view.heldDms, 3);
  assert.equal(view.meters[0].over, true);

  await w.inTenant(
    `INSERT INTO subscription_items (tenant_id, addon_code, kind, quantity, unit_price_paise, cycle, starts_at, created_by, request_key) VALUES ($1, 'dm_pack', 'pack', 1, 29900, 'monthly', $2::timestamptz, 'user:1', 'pack-request-0001')`,
    [w.tenant.id, new Date(w.clock.t - MINUTE)],
  );
  assert.equal(await w.inBusiness(() => meter.allowanceChanged()), 3, 'the three held replies are back in the queue');
  await w.settle();
  assert.deepEqual(await statuses(w), ['sent', 'sent', 'sent']);
  await w.inBusiness(() => meter.record({ meter: 'dms', quantity: 997, key: 'bulk-pack-month' }));
  view = await w.inBusiness(() => meter.view());
  assert.deepEqual((({ used, included, packUnits, allowance, left }) => ({ used, included, packUnits, allowance, left }))(view.meters[0]), { used: 6000, included: 5000, packUnits: 10000, allowance: 15000, left: 9000 });

  // And down again: a downgrade applies at once too.
  await w.db.platform.query(`INSERT INTO plan_changes (tenant_id, to_plan, to_cycle, actor, source) VALUES ($1, 'free', 'monthly', 'platform:1', 'console')`, [w.tenant.id]);
  assert.equal((await w.inBusiness(() => meter.view())).meters[0].allowance, 10500, 'Free 500 plus the running pack');
});

test('months turn over at midnight in India: no send in two months, the new month releases what waited, and an expired DM is never sent', async () => {
  const w = await world({ at: NOV_30_EVENING });
  const service = metered(w);
  await limitTo(w, 1);
  await w.inBusiness(() => service.meter.record({ meter: 'dms', key: 'edge-before', at: new Date('2026-11-30T18:29:59.999Z') }));
  await w.inBusiness(() => service.meter.record({ meter: 'dms', key: 'edge-after', at: new Date('2026-11-30T18:30:00.000Z') }));
  assert.deepEqual((await monthRows(w)).map((r) => [r.month, r.used]), [['2026-11-01', 1], ['2026-12-01', 1]]);

  await w.messaged('soon');
  await w.inBusiness(() => w.compliance.enqueue(dm(w, { recipientId: 'soon', personId: 'soon' }))); // its window closes in an hour
  await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { personId: 'later' })));
  await w.settle();
  assert.deepEqual(await statuses(w), ['held', 'held'], 'November is full');

  w.clock.advance(HOUR + MINUTE); // 00:31 on 1 December in India; the DM's window has closed
  await w.inBusiness(() => w.compliance.expire());
  // December already has one (edge-after), and the allowance is 1: still full.
  assert.equal(await service.sweepHeld(), 0);
  await w.inBusiness(() => w.platform.entitlements.setOverride('dms.monthly', { enabled: true, limit: 5 }));
  assert.equal(await service.sweepHeld(), 1, 'only the reply still inside its seven days goes back');
  await w.settle();
  const jobs = await w.jobs();
  assert.deepEqual(jobs.map((j) => j.status), ['expired', 'sent']);
  assert.equal(w.ig.calls.length, 1, 'the expired DM never reached Meta');
  assert.deepEqual((await monthRows(w)).map((r) => [r.month, r.used]), [['2026-11-01', 1], ['2026-12-01', 2]], 'the send counts in December only');
});

test('F-86: the 80% and 100% alerts go once per business and month, with the counts and the pack option, however many workers cross the line', async () => {
  const w = await world();
  const notify = createNotify({ db: w.db, providers: {}, config: {} });
  const service = metered(w, { notify });
  const { meter } = service;
  await limitTo(w, 10);
  const alerts = () => w.inTenant(`SELECT kind, event_key, data FROM notification_events WHERE tenant_id = $1 AND kind LIKE 'dm.usage_%' ORDER BY id`, [w.tenant.id]);

  await w.inBusiness(() => Promise.all(Array.from({ length: 7 }, (_, i) => meter.accepted(event(w, 940000 + i)))));
  assert.deepEqual(await alerts(), [], '70%: nothing yet');
  // Two workers count the eighth and ninth at once, and the sweep runs at the same moment.
  const other = createUsage({ db: w.db, config: { usageNow: w.clock.now }, notify }).meter;
  await w.inBusiness(() => Promise.all([meter.accepted(event(w, 940007)), other.accepted(event(w, 940008)), meter.checkAlerts(), other.checkAlerts()]));
  await service.sweepAlerts();
  let sent = await alerts();
  assert.equal(sent.length, 1, 'one alert at 80%');
  assert.equal(sent[0].kind, 'dm.usage_80');
  assert.equal(sent[0].event_key, 'dm.usage_80:2026-11-01');
  // Decided (R3-MONEY-P1): the alert carries the count at the moment it crossed the line. With two workers counting the
  // eighth and ninth at once, the caller that claims the alert may have seen 8 or 9; either is that moment's count, and
  // the alert's percent is worked out from the same count. Nothing below 80% and nothing above what was counted.
  const crossedAt = sent[0].data.used;
  assert.ok(crossedAt === 8 || crossedAt === 9, `the count when 80% was crossed: 8 or 9 of 10, got ${crossedAt}`);
  assert.equal(sent[0].data.percent, crossedAt * 10, 'the percent is the same moment as the count');
  assert.equal(await dmsUsed(w), 9, 'both sends counted');
  assert.deepEqual([sent[0].data.allowance, sent[0].data.included, sent[0].data.packSize, sent[0].data.packPricePaise], [10, 10, 10000, 29900]);
  assert.doesNotMatch(JSON.stringify(sent[0].data), /asha|person|token/i);

  // A bigger allowance puts the meter back under 80%; reaching 80% of it again in the same month tells nobody again.
  await limitTo(w, 12);
  await w.inBusiness(() => meter.accepted(event(w, 940009)));
  assert.equal((await alerts()).length, 1);

  await w.inBusiness(() => Promise.all([10, 11, 12].map((i) => meter.accepted(event(w, 940000 + i)))));
  await w.inBusiness(() => Promise.all([meter.checkAlerts(), other.checkAlerts()]));
  sent = await alerts();
  assert.deepEqual(sent.map((a) => a.kind), ['dm.usage_80', 'dm.usage_100'], 'and once at 100%');
  assert.equal(sent[1].data.percent, 100);

  // A new month starts the marks again; a business jumping straight past 100% is told about 100% only.
  w.clock.advance(31 * 24 * HOUR);
  await w.inBusiness(() => meter.record({ meter: 'dms', quantity: 20, key: 'december-burst', at: new Date(w.clock.t) }));
  await w.inBusiness(() => meter.checkAlerts());
  sent = await alerts();
  assert.deepEqual(sent.map((a) => a.event_key).slice(2), ['dm.usage_100:2026-12-01']);
  const [december] = await w.inTenant(`SELECT alert_80_at, alert_100_at FROM usage_months WHERE tenant_id = $1 AND meter = 'dms' AND month = '2026-12-01'`, [w.tenant.id]);
  assert.ok(december.alert_80_at && december.alert_100_at, 'both marks set, so 80% is not sent afterwards');
});

test('WhatsApp messages and AI units have their own meters at cost; WhatsApp is never held for the DM limit', async () => {
  const w = await world();
  const service = metered(w, { config: { usageCostPaise: { whatsapp_messages: 78 } } });
  await limitTo(w, 0);
  assert.equal(await w.inBusiness(() => service.meter.hasDmsLeft({ channel: 'whatsapp', kind: 'dm', purpose: 'trigger' })), true);
  assert.equal(await w.inBusiness(() => service.meter.hasDmsLeft({ channel: 'instagram', kind: 'dm', purpose: 'trigger' })), false);
  await w.inBusiness(() => Promise.all([1, 2, 2, 3].map((id) => service.meter.accepted(event(w, 950000 + id, { channel: 'whatsapp', kind: 'dm' })))));
  await w.inBusiness(() => service.meter.record({ meter: 'ai_units', quantity: 220, costPaise: 31, key: 'ai:reply:1' }));
  await w.inBusiness(() => service.meter.record({ meter: 'ai_units', quantity: 220, costPaise: 31, key: 'ai:reply:1' }));
  assert.deepEqual((await monthRows(w)).map((r) => [r.meter, r.used, r.cost]), [['ai_units', 220, 31], ['whatsapp_messages', 3, 234]]);
  const view = await w.inBusiness(() => service.meter.view());
  assert.deepEqual(view.meters.map((m) => [m.meter, m.used, m.allowance]), [['dms', 0, 0], ['whatsapp_messages', 3, null], ['ai_units', 220, null]]);
  await assert.rejects(() => w.inBusiness(() => service.meter.record({ meter: 'ai_units', quantity: 1.5, key: 'x' })), /whole number/);
  await assert.rejects(() => w.inBusiness(() => service.meter.record({ meter: 'sms', key: 'x' })), /Unknown meter/);
  await assert.rejects(() => service.meter.record({ meter: 'dms', key: 'no-business' }), /business|tenant/i, 'never outside a business');
});

test('the demo business is never counted or held, and one business\'s meter is never another\'s', async () => {
  const a = await world();
  const b = await world({ base: a });
  const service = metered(a);
  const { meter } = service;
  await a.inBusiness(() => meter.record({ meter: 'dms', quantity: 7, key: 'shared-key' }));
  await b.inBusiness(() => meter.record({ meter: 'dms', quantity: 2, key: 'shared-key' }));
  assert.equal(await dmsUsed(a), 7);
  assert.equal(await dmsUsed(b), 2, 'the same key in another business is its own');
  assert.equal((await b.inBusiness(() => meter.view())).meters[0].used, 2);
  const [seen] = await b.inTenant(`SELECT count(*)::int AS n FROM usage_months WHERE meter = 'dms'`);
  assert.equal(seen.n, 1, 'inside B, even a query that forgets its WHERE sees only B');

  const demo = await world({ base: a });
  await a.db.platform.query('UPDATE tenants SET is_demo = false WHERE is_demo');
  await a.db.platform.query('UPDATE tenants SET is_demo = true WHERE id = $1', [demo.tenant.id]);
  await limitTo(demo, 0);
  assert.equal(await demo.inBusiness(() => meter.record({ meter: 'dms', key: 'demo-1' })), false);
  assert.equal(await demo.inBusiness(() => meter.accepted(event(demo, 960001))), false);
  assert.equal(await demo.inBusiness(() => meter.hasDmsLeft({ kind: 'dm', purpose: 'trigger' })), true, 'never held: it never sends anyway');
  assert.deepEqual(await monthRows(demo), []);
  await a.db.platform.query('UPDATE tenants SET is_demo = false WHERE id = $1', [demo.tenant.id]);
});

test('a send Meta accepted whose count was lost is counted by the reconcile job, once', async () => {
  const w = await world();
  // The gate with no meter registered: sends go, nobody counts them.
  for (const person of ['x', 'y']) await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { personId: person })));
  await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { personId: 'tester', isTest: true })));
  await w.settle();
  const service = createUsage({ db: w.db, config: { usageNow: w.clock.now } });
  assert.equal(await service.sweepUncounted(), 0, 'not before two minutes, while the listener may still be writing');
  w.clock.advance(5 * MINUTE);
  assert.equal(await service.sweepUncounted(), 2, 'the two real ones, not the test send');
  assert.equal(await service.sweepUncounted(), 0);
  assert.equal(await dmsUsed(w), 2);
});

test('the module registers with the gate in setup and answers billing.usage without reading ctx when built', async () => {
  assert.deepEqual(Object.keys(usageModule.api({})), ['billing.usage']);
  const w = await world();
  const ctx = { db: w.db, config: { usageNow: w.clock.now }, compliance: w.compliance, notify: null, platform: {} };
  usageModule.setup(ctx);
  await limitTo(w, 1);
  for (const person of ['m', 'n']) await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { personId: person })));
  await w.settle();
  assert.deepEqual(await statuses(w), ['sent', 'held']);
  const view = await w.inBusiness(() => usageModule.api(ctx)['billing.usage']({}));
  assert.equal(view.month, '2026-11-01');
  assert.equal(view.resetsAt.toISOString(), '2026-11-30T18:30:00.000Z', 'midnight in India');
  assert.deepEqual([view.meters[0].used, view.meters[0].percent, view.meters[0].over, view.heldDms, view.canBuyPacks], [1, 100, true, 1, false]);
  w.compliance.useQuota(null);
});

// The metering hook in the send gate (PRD 5.12) and the pure rules of src/contracts/billing.js. The usage module registers
// with compliance.useQuota and compliance.onAccepted; until it does, nothing is limited and nobody is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as billing from '../../../src/contracts/billing.js';
import { REASON_CODES } from '../../../src/contracts/compliance.js';
import { DAY, HOUR, automation, dm, privateReply, world } from '../../p1/compliance/support.js';

const enqueue = (w, action, options) => w.inBusiness(() => w.compliance.enqueue(action, options));
const send = (w, action, options) => w.inBusiness(() => w.compliance.send(action, options));
const jobsOf = async (w) => (await w.jobs()).map((j) => [j.status, j.reason]);

test('until a usage module registers, nothing is held for the limit', async () => {
  const w = await world();
  for (let i = 0; i < 3; i++) await enqueue(w, privateReply(w, { personId: `p${i}` }));
  assert.equal(await w.settle(), 3);
  assert.deepEqual(await jobsOf(w), [['sent', ''], ['sent', ''], ['sent', '']]);
  assert.ok(REASON_CODES.includes(billing.DM_LIMIT_REASON));
  assert.throws(() => w.compliance.useQuota({}), /hasDmsLeft/);
  assert.throws(() => w.compliance.onAccepted('x'), /function/);
});

test('F-82: a send Meta accepted is told once, with ids only; test sends, dry runs and public replies are never told', async () => {
  const w = await world();
  const told = [];
  w.compliance.onAccepted((event) => told.push(event));
  w.compliance.onAccepted(() => {
    throw new Error('a listener that fails');
  });
  const automationId = await automation(w);

  await enqueue(w, privateReply(w, { personId: 'asha', automationId }));
  await w.messaged('ravi');
  await enqueue(w, dm(w, { recipientId: 'ravi', personId: 'ravi', automationId }));
  await enqueue(w, privateReply(w, { personId: 'tester', isTest: true }));
  await enqueue(w, { kind: 'public_reply', accountId: w.igUserId, commentId: 'c-public', idempotencyKey: 'public_reply:c-public', expiresAt: new Date(w.clock.t + HOUR), message: { text: 'Sent you a message' } });
  const dry = await automation(w, { dryRun: true });
  await enqueue(w, privateReply(w, { personId: 'dry', automationId: dry }));
  await w.settle();
  await w.settle();

  const jobs = await w.jobs();
  assert.equal(told.length, 2, 'the two real messages, and nothing else');
  const [first, second] = [...told].sort((a, b) => a.jobId - b.jobId); // the two go on different streams, in either order
  assert.deepEqual(Object.keys(first).sort(), ['at', 'automated', 'automationId', 'channel', 'jobId', 'key', 'kind', 'purpose', 'tenantId']);
  assert.deepEqual([first.tenantId, first.kind, first.channel, first.automated, first.automationId, first.key], [w.tenant.id, 'private_reply', 'instagram', true, automationId, billing.dmUsageKey(first.jobId)]);
  assert.equal(second.kind, 'dm');
  assert.deepEqual([first.jobId, second.jobId], jobs.filter((j) => j.status === 'sent' && !j.is_test && j.kind !== 'public_reply').map((j) => Number(j.id)));
  assert.doesNotMatch(JSON.stringify(told), /asha|ravi|hello/, 'no person and no words');
  assert.ok(jobs.some((j) => j.kind === 'public_reply' && j.status === 'sent'), 'the public reply went, uncounted');
  assert.ok(jobs.some((j) => j.is_test), 'the test send has its job, uncounted');

  // Settling the same job again tells nobody again.
  const before = told.length;
  await w.settle();
  assert.equal(told.length, before);
});

test('F-112: with the month\'s DMs used up, automated DMs are held with held.dm_limit, not dropped, and go when there is room again', async () => {
  const w = await world();
  let left = 1;
  const asked = [];
  const told = [];
  w.compliance.useQuota({
    hasDmsLeft(call) {
      asked.push(call);
      return left > 0;
    },
  });
  w.compliance.onAccepted((event) => {
    told.push(event);
    left -= 1;
  });

  for (const person of ['a', 'b', 'c']) await enqueue(w, privateReply(w, { personId: person }));
  await w.settle();
  assert.deepEqual(await jobsOf(w), [['sent', ''], ['held', billing.DM_LIMIT_REASON], ['held', billing.DM_LIMIT_REASON]], 'one left: one goes, two wait');
  assert.equal(w.ig.calls.length, 1, 'nothing more reached Meta');
  assert.ok((await w.reasons()).includes(billing.DM_LIMIT_REASON), 'the log says why');
  assert.deepEqual(Object.keys(asked[0]).sort(), ['automationId', 'channel', 'kind', 'purpose']);

  // Never held for the limit: the owner's own reply and a test send. A send asked for now is refused as held.
  await w.messaged('owner-thread');
  const manual = await send(w, dm(w, { recipientId: 'owner-thread', personId: 'owner-thread', purpose: 'manual' }));
  assert.equal(manual.outcome, 'sent', 'the owner can always answer');
  left = 0; // the owner's reply is not what used the last one
  await enqueue(w, privateReply(w, { personId: 'tester', isTest: true }));
  await w.settle();
  assert.equal((await w.jobs()).find((j) => j.is_test).status, 'sent');
  await w.messaged('now');
  const direct = await send(w, dm(w, { recipientId: 'now', personId: 'now' }));
  assert.deepEqual([direct.outcome, direct.reason], ['held', billing.DM_LIMIT_REASON]);

  // Still none: a worker turn changes nothing.
  await w.settle();
  assert.equal((await w.jobs()).filter((j) => j.status === 'held').length, 2);

  // A pack is added: the held ones go, at the normal budget, in the order they came.
  left = 10;
  assert.equal(await w.inBusiness(() => w.compliance.releaseDmLimit()), 2);
  await w.settle();
  assert.deepEqual((await jobsOf(w)).filter(([status]) => status === 'held'), []);
  assert.equal((await w.jobs()).filter((j) => j.status === 'sent' && !j.is_test && j.purpose !== 'manual').length, 3);
  assert.equal(told.filter((e) => e.automated).length, 3, 'each counted once');
});

test('a held DM that expires while waiting is not sent later, and the worker releases the rest by itself', async () => {
  const w = await world();
  let left = 0;
  w.compliance.useQuota({ hasDmsLeft: () => left > 0 });
  await w.messaged('soon');
  await enqueue(w, dm(w, { recipientId: 'soon', personId: 'soon' })); // expires in an hour
  await enqueue(w, privateReply(w, { personId: 'later' })); // expires in six days
  await w.settle();
  assert.deepEqual((await jobsOf(w)).map(([status]) => status), ['held', 'held']);

  w.clock.advance(2 * HOUR);
  await w.inBusiness(() => w.compliance.expire());
  left = 5; // the month turned
  await w.settle(); // release() runs first, as it does every minute in the worker
  const jobs = await w.jobs();
  assert.equal(jobs[0].status, 'expired', 'the DM whose window closed is not sent');
  assert.equal(jobs[1].status, 'sent', 'the reply still inside its seven days is');
  assert.equal(w.ig.calls.length, 1);
  assert.ok(6 * DAY > 2 * HOUR);
});

test('one business at its limit does not hold another\'s, and a metering fault never stops a send', async () => {
  const base = await world({ fresh: true });
  const other = await world({ base });
  // One engine serves every business: the provider is asked inside each business.
  const limited = new Set([base.tenant.id]);
  const { tenantId } = await import('../../../src/tenancy.js');
  base.compliance.useQuota({ hasDmsLeft: () => !limited.has(tenantId()) });
  await enqueue(base, privateReply(base, { personId: 'a' }));
  await base.inBusiness(() => base.compliance.drainOutbound());
  assert.deepEqual(await jobsOf(base), [['held', billing.DM_LIMIT_REASON]]);
  const own = await world({ base });
  own.compliance.useQuota({ hasDmsLeft: () => !limited.has(tenantId()) });
  await enqueue(own, privateReply(own, { personId: 'b' }));
  await own.settle();
  assert.deepEqual(await jobsOf(own), [['sent', '']], 'the other business is not at its limit');
  assert.deepEqual(await jobsOf(other), []);

  const faulty = await world();
  faulty.compliance.useQuota({
    hasDmsLeft() {
      throw new Error('the meter is down');
    },
  });
  await enqueue(faulty, privateReply(faulty, { personId: 'c' }));
  await faulty.settle();
  assert.deepEqual(await jobsOf(faulty), [['sent', '']], 'a fault in metering is reported and the message still goes');
  faulty.compliance.useQuota(null);
});

test('the pure rules: the meter, the alerts, tax, the yearly fee, the offer, proration and flags', () => {
  // F-81: 5,000 included and one pack of 10,000; 6,000 sent.
  const meter = billing.meterOf({ used: 6000, included: 5000, packUnits: 10000 });
  assert.deepEqual(meter, { used: 6000, included: 5000, packUnits: 10000, allowance: 15000, left: 9000, percent: 40, over: false });
  assert.deepEqual(billing.meterOf({ used: 500, included: 500 }), { used: 500, included: 500, packUnits: 0, allowance: 500, left: 0, percent: 100, over: true }, 'F-112');
  assert.deepEqual(billing.meterOf({ used: 9, included: null }), { used: 9, included: null, packUnits: 0, allowance: null, left: null, percent: 0, over: false });
  assert.equal(billing.meterOf({ used: 0, included: 0 }).over, true, 'nothing included is nothing left');

  // F-86: once at 80%, once at 100%.
  const at80 = billing.meterOf({ used: 4000, included: 5000 });
  assert.deepEqual(billing.alertsDue(at80, {}), [80]);
  assert.deepEqual(billing.alertsDue(at80, { alert80At: new Date() }), [], 'told once');
  assert.deepEqual(billing.alertsDue(billing.meterOf({ used: 5000, included: 5000 }), { alert80At: new Date() }), [100]);
  assert.deepEqual(billing.alertsDue(billing.meterOf({ used: 5000, included: 5000 }), {}), [80, 100]);
  assert.deepEqual(billing.alertsDue(billing.meterOf({ used: 99999, included: null }), {}), []);

  // F-54: the same state is CGST and SGST in equal halves; another state is IGST.
  assert.deepEqual(billing.taxFor(49900, { rateBp: 1800, sellerState: '27', buyerState: '27' }), { cgstPaise: 4491, sgstPaise: 4491, igstPaise: 0, totalPaise: 58882 });
  assert.deepEqual(billing.taxFor(49900, { rateBp: 1800, sellerState: '27', buyerState: '29' }), { cgstPaise: 0, sgstPaise: 0, igstPaise: 8982, totalPaise: 58882 });
  assert.deepEqual(billing.taxFor(49900, { rateBp: 1800, sellerState: '27', buyerState: '' }), { cgstPaise: 0, sgstPaise: 0, igstPaise: 8982, totalPaise: 58882 });
  assert.equal(billing.taxFor(0, { sellerState: '27', buyerState: '27' }).totalPaise, 0);
  assert.throws(() => billing.taxFor(499.5), /whole paise/);

  assert.equal(billing.yearlyPaise(149900), 1499000, 'F-115: ten months for twelve');
  assert.equal(billing.offerDiscountPaise(49900, 30), 14970, 'the launch offer');
  assert.equal(billing.offerDiscountPaise(49900, 0), 0);
  assert.equal(billing.proratedPaise(30000, { rule: 'none', daysLeft: 10, daysInCycle: 30 }), 30000, 'the rule today: a full line');
  assert.equal(billing.proratedPaise(30000, { rule: 'daily', daysLeft: 10, daysInCycle: 30 }), 10000);
  assert.equal(billing.proratedPaise(30000, { rule: 'daily', daysLeft: 45, daysInCycle: 30 }), 30000, 'never more than the price');

  assert.equal(billing.usageMonthOf(new Date('2026-11-30T18:29:59Z')), '2026-11-01');
  assert.equal(billing.usageMonthOf(new Date('2026-11-30T18:30:00Z')), '2026-12-01', 'the month turns at midnight in India');
  assert.equal(billing.financialYearOf(new Date('2027-03-31T18:29:59Z')), 2026, 'F-55');
  assert.equal(billing.financialYearOf(new Date('2027-03-31T18:30:00Z')), 2027);

  assert.deepEqual([billing.isUpgrade('free', 't3'), billing.isUpgrade('t3', 't2'), billing.isUpgrade('t2', 't2')], [true, false, false]);
  assert.equal(billing.flagOn({ enabled: false, percent: 0 }, undefined, 7), false, 'off by default');
  assert.equal(billing.flagOn({ enabled: false, percent: 0 }, true, 7), true, 'staged for one business');
  assert.equal(billing.flagOn({ enabled: true, percent: 0 }, false, 7), false, 'or held back from one');
  const on = Array.from({ length: 1000 }, (_, i) => billing.flagOn({ percent: 25 }, undefined, i + 1)).filter(Boolean).length;
  assert.ok(on > 150 && on < 350, `about a quarter at 25% (${on})`);
  const at25 = Array.from({ length: 200 }, (_, i) => billing.flagOn({ percent: 25 }, undefined, i + 1));
  const at50 = Array.from({ length: 200 }, (_, i) => billing.flagOn({ percent: 50 }, undefined, i + 1));
  assert.ok(at25.every((was, i) => !was || at50[i]), 'a business that has it keeps it as the percentage grows');
  assert.equal(billing.isStaleBillingEvent('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'), true);
  assert.equal(billing.isStaleBillingEvent('2026-11-03T00:00:00Z', null), false);
});

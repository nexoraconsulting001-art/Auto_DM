// The load test's judgement: what passes, what fails, and that a missing reading is never a pass (Q-05 to Q-07).
import assert from 'node:assert/strict';
import test from 'node:test';
import { BASELINE_FLOOR_MS, MIN_SAMPLES, judgeMemory, judgeMix, judgeRestart, judgeStorm } from '../../../tools/load/analyze.mjs';
import { loadBudgets } from '../../../tools/load/stack.mjs';

const budgets = loadBudgets();
const good = () => Object.fromEntries(budgets.mix.map(({ class: name }) => [name, { requests: 500, failed: 0, p95: budgets.p95Ms[name] - 1 }]));
const byName = (checks, name) => checks.find((c) => c.name === name);

test('Q-05: every class inside its p95 and no failed request is a pass; one over, one failed request or too few answers is a fail', () => {
  assert.ok(judgeMix({ budgets, byClass: good() }).every((c) => c.ok));
  const slow = good();
  slow.beacon.p95 = budgets.p95Ms.beacon + 0.1;
  const checks = judgeMix({ budgets, byClass: slow });
  assert.equal(byName(checks, 'p95 beacon').ok, false);
  assert.equal(byName(checks, 'p95 buyer_page').ok, true, 'one class over does not fail another');
  const failed = good();
  failed.webhook.failed = 1;
  assert.equal(byName(judgeMix({ budgets, byClass: failed }), 'failed requests').ok, false);
  const few = good();
  few.store_api.requests = MIN_SAMPLES - 1;
  assert.equal(byName(judgeMix({ budgets, byClass: few }), 'p95 store_api').ok, false, 'a p95 over fewer than the minimum answers proves nothing');
  const none = good();
  none.seller_api_read = { requests: 0, failed: 0, p95: null };
  assert.equal(byName(judgeMix({ budgets, byClass: none }), 'p95 seller_api_read').ok, false);
  const nothing = Object.fromEntries(Object.keys(good()).map((k) => [k, { requests: 0, failed: 0, p95: null }]));
  assert.equal(judgeMix({ budgets, byClass: nothing })[0].ok, false, 'no requests at all is not zero failures');
});

test('Q-05: memory is judged against each process own limit, exactly, and no reading fails', () => {
  const peaks = (web, worker, postgres) => ({ memoryMb: { web, worker, postgres } });
  assert.ok(judgeMemory({ budgets, peaks: peaks(512, 384, 512) }).every((c) => c.ok), 'at the limit is inside it');
  const over = judgeMemory({ budgets, peaks: peaks(513, 384, 512) });
  assert.deepEqual(over.map((c) => c.ok), [false, true, true]);
  const unread = judgeMemory({ budgets, peaks: peaks(100, null, 100) });
  assert.deepEqual(unread.map((c) => c.ok), [true, false, true]);
  assert.match(unread[1].measured, /could not be read/);
});

test('Q-06: the storm page limit is relative to the baseline with a floor, the send delay is absolute, and a stormed business is not judged', () => {
  const base = { budgets, baselinePages: 100, stormPages: 100, delays: Array.from({ length: 50 }, () => 2), others: { accepted: 300, handled: 300, unsent: 0 }, stormAccepted: 2000, stormExpected: 2000 };
  const judged = (extra) => judgeStorm({ ...base, ...extra });
  const pages = 'other businesses: page p95 during the storm';
  assert.ok(judged({ baselinePageP95: 200, stormPageP95: 300 }).every((c) => c.ok), '1.5 times the baseline is inside');
  assert.equal(byName(judged({ baselinePageP95: 200, stormPageP95: 301 }), pages).ok, false);
  assert.equal(byName(judged({ baselinePageP95: 10, stormPageP95: 150 }), pages).ok, true, `a baseline under ${BASELINE_FLOOR_MS} ms counts as ${BASELINE_FLOOR_MS} ms`);
  assert.equal(byName(judged({ baselinePageP95: 10, stormPageP95: 151 }), pages).ok, false);
  assert.equal(byName(judged({ baselinePageP95: 10, stormPageP95: null }), pages).ok, false);
  const delay = 'other businesses: send delay p95';
  const late = Array.from({ length: 50 }, (_, i) => (i < 46 ? 2 : 31));
  assert.equal(byName(judged({ baselinePageP95: 10, stormPageP95: 20, delays: late }), delay).ok, false, 'the 95th of 50 is the 48th: 31 s is over 30 s');
  assert.equal(byName(judged({ baselinePageP95: 10, stormPageP95: 20, delays: [] }), delay).ok, false, 'no DMs at all is not a pass');
  assert.equal(byName(judged({ baselinePageP95: 10, stormPageP95: 20, others: { accepted: 300, handled: 299, unsent: 0 } }), 'other businesses: every webhook stored and handled').ok, false);
  assert.equal(byName(judged({ baselinePageP95: 10, stormPageP95: 20, others: { accepted: 300, handled: 300, unsent: 1 } }), 'other businesses: every DM went out (none left waiting or failed)').ok, false, 'a DM that never went out has no delay to measure, so it is counted on its own');
  assert.equal(judged({ baselinePageP95: 10, stormPageP95: 20, stormAccepted: 1999 })[0].ok, false, 'a storm webhook that was not answered 200 fails');
});

test('Q-07: a lost webhook, an unhandled one, a send twice, a slow return or a failure after the return each fail alone', () => {
  const verify = { accepted: 400, lost: 0, unhandled: 0, duplicateSends: 0 };
  const timing = { backMs: 12_000 };
  const all = (v = verify, t = timing, f = 0) => judgeRestart({ budgets, verify: v, timing: t, failedAfterBack: f });
  assert.ok(all().every((c) => c.ok));
  assert.equal(all({ ...verify, lost: 1 })[0].ok, false);
  assert.equal(all({ ...verify, unhandled: 1 })[1].ok, false);
  assert.equal(all({ ...verify, duplicateSends: 1 })[2].ok, false);
  assert.equal(all(verify, { backMs: 30_001 })[3].ok, false);
  assert.equal(all(verify, { backMs: null })[3].ok, false);
  assert.equal(all(verify, timing, 1)[4].ok, false);
  assert.equal(all({ ...verify, accepted: 0 })[0].ok, false, 'a restart with no webhooks in it proves nothing');
});

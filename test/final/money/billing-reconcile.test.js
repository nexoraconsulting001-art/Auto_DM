// M-3 (review-money-compliance.md, R6-RECON): billing state must not hang on webhooks alone. A failed billing event waits
// its back-off from its last attempt, not from when it arrived, so its tries are not all used up an hour after it came in;
// and a reconcile job reads each live subscription from Razorpay (the simulator here) and puts what the business missed
// through the same webhook path, once, however often it runs and alongside the webhooks themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBilling } from '../../p7/billing/support.js';

const eventsOf = (w, type) => w.sql(`SELECT id, event_id, status, outcome, attempts, last_error FROM provider_webhook_events WHERE scope = 'billing' AND event_type = $1 ORDER BY id`, [type]);

test('M-3: a failed billing event waits its back-off from its last attempt, not from when it arrived', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  assert.equal((await shop.change('t1')).status, 200);
  // Bhava's SAC is cleared after the plan was picked: the charge cannot be invoiced, so its event fails (billing_not_ready).
  await w.sql(`UPDATE billing_settings SET sac = ''`);
  await shop.charge();
  const [charged] = await eventsOf(w, 'subscription.charged');
  assert.deepEqual([charged.status, charged.attempts], ['received', 1], 'one failed try, waiting for the next');

  // It arrived two hours ago, but its last try was just now: the 5 s back-off has not passed since that try.
  await w.sql(`UPDATE provider_webhook_events SET received_at = now() - interval '2 hours', last_attempt_at = now() WHERE id = $1`, [charged.id]);
  await w.billing.webhooks.drain();
  assert.equal((await w.one('SELECT attempts FROM provider_webhook_events WHERE id = $1', [charged.id])).attempts, 1, 'not tried again before its back-off from the last try');

  // Once the back-off from the last try has passed, it is tried again, and the try is noted as the new last attempt.
  await w.sql(`UPDATE provider_webhook_events SET last_attempt_at = now() - interval '10 seconds' WHERE id = $1`, [charged.id]);
  await w.billing.webhooks.drain();
  const after = await w.one(`SELECT attempts, last_attempt_at > now() - interval '5 seconds' AS fresh FROM provider_webhook_events WHERE id = $1`, [charged.id]);
  assert.deepEqual([after.attempts, after.fresh], [2, true]);
});

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

const alertsOf = (w, kind) => w.sql(`SELECT * FROM alerts WHERE audience = 'ops' AND kind = $1 ORDER BY id`, [kind]);

test('M-3: a renewal charge whose webhook never came lifts the business out of grace once, however often the reconcile runs and whenever the webhook turns up', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const s = await shop.sub();
  await w.rzp.post('/clock', { advanceMs: 5_000 });
  await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, outcome: 'failed' });
  await w.settle();
  assert.equal((await shop.sub()).status, 'grace', 'the renewal failed: grace');

  // Razorpay's retry takes the money, but its webhook is lost (held back and never delivered here).
  await w.rzp.post('/clock', { advanceMs: 5_000 });
  const retry = await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, outcome: 'charged', hold: true });
  await w.settle();
  assert.equal((await shop.sub()).status, 'grace', 'nothing came in: still in grace although it paid');

  // Two reconcile runs at once (the worker on two processes): one payment, one invoice, out of grace.
  const runs = await Promise.all([w.billing.reconcile.run(), w.billing.reconcile.run()]);
  await w.settle();
  assert.ok(runs.some((r) => r.stored >= 1), JSON.stringify(runs));
  const after = await shop.sub();
  assert.deepEqual([after.status, after.grace_until], ['active', null], 'paid: out of grace');
  assert.equal(+new Date(after.current_period_end), retry.subscription.current_end * 1000, 'the period paid for');
  const payments = await shop.payments();
  assert.deepEqual(payments.map((p) => p.status), ['captured', 'failed', 'captured'], 'the first charge, the failed renewal, the retry the reconcile found');
  assert.equal(payments[2].provider_payment_id, retry.payment.id);
  assert.equal((await shop.invoices()).length, 2, 'one invoice per captured payment');
  assert.equal((await alertsOf(w, 'billing.reconcile_missed')).length, 1, 'Bhava’s team is told a webhook was missed');

  // Again, then the lost webhook itself finally arrives: nothing more.
  assert.equal((await w.billing.reconcile.run()).stored, 0);
  await w.rzp.post('/webhooks/flush', {});
  await w.settle();
  assert.equal((await shop.invoices()).length, 2);
  assert.equal((await shop.payments()).filter((p) => p.status === 'captured').length, 2);
  assert.deepEqual((await eventsOf(w, 'subscription.charged')).map((e) => [e.status, e.outcome]).slice(-2), [['processed', 'processed'], ['ignored', 'duplicate']]);
});

test('M-3: a halt or a cancellation whose webhook never came ends the paid service once the period is over', async (t) => {
  const w = await openBilling(t);
  const halted = await w.business({ state: '29' });
  const cancelled = await w.business({ state: '29' });
  for (const shop of [halted, cancelled]) await shop.subscribe('t1');
  await w.rzp.post('/clock', { advanceMs: 5_000 });
  await w.rzp.post('/subscriptions/charge', { id: (await halted.sub()).provider_subscription_id, outcome: 'halted', hold: true });
  await w.rzp.post('/subscriptions/cancel', { id: (await cancelled.sub()).provider_subscription_id, hold: true });
  await w.settle();

  // Mid-period nothing is asked of Razorpay for a paid, active subscription.
  assert.equal((await w.billing.reconcile.run()).checked, 0);
  // The period ends with no webhook: before, both stayed 'active' on their paid plan for good.
  await w.sql(`UPDATE subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 minute' WHERE tenant_id = ANY($1::int[])`, [[halted.tenant.id, cancelled.tenant.id]]);
  const run = await w.billing.reconcile.run();
  await w.settle();
  assert.deepEqual([run.checked, run.stored, run.failed], [2, 2, 0]);
  assert.equal((await halted.sub()).status, 'grace', 'halted at Razorpay: grace, then suspension, as a delivered halt would');
  assert.equal((await cancelled.sub()).status, 'cancelled', 'ended at Razorpay: ended here');
  assert.equal((await cancelled.tenantRow()).plan, 'free', 'and, its period over, the business is on Free');

  // The lost webhooks arrive late: no second change.
  await w.rzp.post('/webhooks/flush', {});
  await w.settle();
  assert.equal((await halted.sub()).status, 'grace');
  assert.equal((await cancelled.sub()).status, 'cancelled');
  assert.equal((await alertsOf(w, 'billing.reconcile_missed')).length, 2);
});

test('M-3: a charge that failed every try (Bhava’s SAC not set) is applied by the reconcile once the SAC is set, its own dead event put back', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  assert.equal((await shop.change('t1')).status, 200);
  await w.sql(`UPDATE billing_settings SET sac = ''`);
  await shop.charge();
  await w.billing.reconcile.run();
  // Every try used: the webhook's event and the reconcile's are both dead.
  await w.sql(`UPDATE provider_webhook_events SET status = 'failed', attempts = 8 WHERE scope = 'billing' AND event_type = 'subscription.charged'`);
  assert.equal((await shop.tenantRow()).plan, 'free', 'paid, but nothing applied');
  assert.equal((await shop.invoices()).length, 0);

  await w.sql(`UPDATE billing_settings SET sac = '998314'`);
  const run = await w.billing.reconcile.run();
  await w.settle();
  assert.equal(run.stored, 1, 'the reconcile’s dead event is put back');
  assert.equal((await shop.tenantRow()).plan, 't1', 'the plan the business paid for');
  assert.equal((await shop.invoices()).length, 1);
  assert.equal((await shop.payments()).length, 1);
  const charged = await eventsOf(w, 'subscription.charged');
  assert.deepEqual(charged.filter((e) => e.event_id.startsWith('reconcile:')).map((e) => [e.status, e.outcome]), [['processed', 'processed']]);
});

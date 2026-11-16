// money-11: a scheduled monthly-to-yearly change on the same plan is applied only by a charge for the yearly plan, never by
// a monthly charge (a past-due retry) for the same plan code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBilling } from '../../p7/billing/support.js';

test('money-11: a monthly charge of the same plan does not apply a scheduled move to yearly', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1', 'monthly');
  const res = await shop.change('t1', 'yearly');
  assert.equal(res.status, 200, res.text);
  let s = await shop.sub();
  assert.deepEqual([s.cycle, s.next_plan, s.next_cycle], ['monthly', 't1', 'yearly'], 'scheduled for the end of the period');

  // A monthly charge (a retry of this period's payment) arrives before the period ends.
  const monthlyPlan = (await w.rzp.get('/state')).subscriptions.find((x) => x.id === s.provider_subscription_id).plan_id;
  const sent = await w.rzp.post('/webhooks/send', {
    accountId: 'billing', event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: s.provider_subscription_id, plan_id: monthlyPlan, status: 'active', current_start: Math.floor(new Date(s.current_period_start) / 1000), current_end: Math.floor(new Date(s.current_period_end) / 1000), notes: { tenant: String(shop.tenant.id) } } },
      payment: { entity: { id: 'pay_retry_monthly1', amount: 49900, status: 'captured', method: 'card' } },
    },
  });
  assert.equal(sent.status, 200);
  await w.settle();
  s = await shop.sub();
  assert.deepEqual([s.cycle, s.next_plan, s.next_cycle], ['monthly', 't1', 'yearly'], 'still monthly, and the move to yearly still waits');
});

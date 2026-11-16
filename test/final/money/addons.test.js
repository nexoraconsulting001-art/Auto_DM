// money-4: an add-on removed before it is charged is never charged, and its end is never pushed out.
// money-10: nothing is granted on a subscription that has not been paid, or that is ending; pending charges are dropped
// when the business schedules its move to Free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { item, openBilling } from '../../p7/billing/support.js';

const lastLines = async (shop) => {
  const invoices = await shop.invoices();
  return shop.lines(invoices.at(-1).id);
};
const providerAddons = async (w, shop) => {
  const s = await shop.sub();
  return (await w.rzp.get('/state')).addons.filter((a) => a.subscription_id === s.provider_subscription_id);
};

test('money-4: an add-on removed before its first charge is taken off the provider and not charged, and its end stays', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const res = await shop.api('POST', '/billing/items', item('reel_management'));
  assert.equal(res.status, 201, res.text);
  assert.equal((await providerAddons(w, shop)).length, 1, 'queued at the provider for the next charge');

  assert.equal((await shop.api('DELETE', `/billing/items/${res.json.item.id}`)).status, 204);
  assert.equal((await providerAddons(w, shop)).length, 0, 'the pending provider line is deleted');
  const row = await w.one('SELECT * FROM subscription_items WHERE id = $1', [res.json.item.id]);
  assert.ok(row.provider_item_id === null || row.provider_item_id.startsWith('free:'), 'nothing is left to charge for it');
  const endedAt = new Date(row.ends_at);
  assert.ok(endedAt <= new Date());

  await w.sql(`UPDATE subscriptions SET current_period_end = now() + interval '1 hour' WHERE tenant_id = $1`, [shop.tenant.id]);
  assert.equal((await w.billing.renewals()).queued, 0, 'the removed item is never queued again');
  const out = await shop.charge();
  const lines = await lastLines(shop);
  assert.deepEqual(lines.map((l) => l.code), ['t1'], 'only the plan is invoiced');
  assert.equal(Number((await shop.invoices()).at(-1).total_paise), out.payment.amount, 'and only the plan was charged');
  const after = await w.one('SELECT ends_at FROM subscription_items WHERE id = $1', [res.json.item.id]);
  assert.equal(new Date(after.ends_at).getTime(), endedAt.getTime(), 'its end is not pushed out');
});

test('money-4: an add-on whose first queue answer was lost and that is then removed is never queued', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  await w.rzp.post('/faults', { kind: 'partial', then: 'timeout', times: 1, match: { method: 'POST', path: '/v1/subscriptions/*/addons' } });
  const res = await shop.api('POST', '/billing/items', item('reel_management'));
  assert.equal(res.status, 201, res.text);
  // The partial fault made the line at the provider but lost the answer: the delete finds it by its key.
  assert.equal((await shop.api('DELETE', `/billing/items/${res.json.item.id}`)).status, 204);
  await w.billing.renewals();
  assert.equal((await providerAddons(w, shop)).length, 0, 'nothing is left to charge');
  const out = await shop.charge();
  assert.deepEqual((await lastLines(shop)).map((l) => l.code), ['t1']);
  assert.equal(Number((await shop.invoices()).at(-1).total_paise), out.payment.amount);
});

test('money-10: nothing is bought on a plan whose first payment has not gone through', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  assert.equal((await shop.change('t1')).status, 200);
  // A one-time setup is open to every plan, so only the unpaid subscription stands in the way.
  const res = await shop.api('POST', '/billing/items', item('setup_automation'));
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.reason ?? res.json.details?.reason ?? 'needs_subscription', 'needs_subscription');
  assert.equal((await w.one('SELECT count(*)::int AS n FROM subscription_items WHERE tenant_id = $1', [shop.tenant.id])).n, 0);
  assert.equal((await providerAddons(w, shop)).length, 0);
});

test('money-10: a business moving to Free buys nothing more, and what it bought but has not paid for ends with no charge', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const bought = await shop.api('POST', '/billing/items', item('reel_management'));
  assert.equal(bought.status, 201, bought.text);
  assert.equal((await shop.change('free')).status, 200);
  assert.equal((await w.one('SELECT next_plan FROM subscriptions WHERE tenant_id = $1', [shop.tenant.id])).next_plan, 'free');
  assert.equal((await providerAddons(w, shop)).length, 0, 'the pending line is dropped: the provider will never charge it');
  const row = await w.one('SELECT * FROM subscription_items WHERE id = $1', [bought.json.item.id]);
  assert.ok(row.ends_at && new Date(row.ends_at) <= new Date(), 'unpaid, so it ends now');
  const more = await shop.api('POST', '/billing/items', item('dm_pack'));
  assert.equal(more.status, 409, more.text);
});

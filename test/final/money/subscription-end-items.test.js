// money-10 (the same cause, at the other end of the subscription): an add-on is paid for by the subscription that charges
// it. When that subscription ends (moved to Free at the period end, cancelled, or ended after grace), nothing will charge
// the add-on again, so what it brings must end with what was paid for, not run on for free on the Free plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { item, openBilling } from '../../p7/billing/support.js';

test('money-10: a paid add-on ends with the subscription that paid for it; its feature is not kept on Free', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const bought = await shop.api('POST', '/billing/items', item('whatsapp'));
  assert.equal(bought.status, 201, bought.text);
  await shop.charge(); // the add-on is paid for with this charge
  const paid = await w.one('SELECT billed_through FROM subscription_items WHERE id = $1', [bought.json.item.id]);
  assert.ok(paid.billed_through, 'charged');
  const feature = () => w.one(`SELECT enabled FROM tenant_features WHERE tenant_id = $1 AND feature = 'whatsapp_automation'`, [shop.tenant.id]);
  assert.equal((await feature())?.enabled, true, 'on while it is paid for');

  // The owner moves to Free at the period end; the period ends and the provider cancels the subscription.
  assert.equal((await shop.change('free')).status, 200);
  await w.sql(`UPDATE subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 second' WHERE tenant_id = $1`, [shop.tenant.id]);
  const s = await shop.sub();
  await w.rzp.post('/subscriptions/cancel', { id: s.provider_subscription_id });
  await w.settle();
  assert.equal((await shop.sub()).status, 'cancelled');
  await w.billing.renewals();
  await w.billing.graceSweep();

  const row = await w.one('SELECT ends_at FROM subscription_items WHERE id = $1', [bought.json.item.id]);
  assert.ok(row.ends_at && new Date(row.ends_at) <= new Date(), 'the add-on ended with the subscription');
  assert.notEqual((await feature())?.enabled, true, 'and WhatsApp is not kept on the Free plan for nothing');
});

test('money-10: cancelled mid-period, a paid add-on runs to the end of the paid period and then ends; a paid one-time purchase stays', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const wa = await shop.api('POST', '/billing/items', item('whatsapp'));
  const form = await shop.api('POST', '/billing/items', item('lead_form'));
  assert.equal(wa.status, 201, wa.text);
  assert.equal(form.status, 201, form.text);
  await shop.charge();
  const feature = async (name) => (await w.one(`SELECT enabled FROM tenant_features WHERE tenant_id = $1 AND feature = $2`, [shop.tenant.id, name]))?.enabled === true;

  const s = await shop.sub();
  assert.ok(new Date(s.current_period_end) > new Date(), 'a paid period still running');
  await w.rzp.post('/subscriptions/cancel', { id: s.provider_subscription_id });
  await w.settle();
  assert.equal((await shop.sub()).status, 'cancelled');
  const row = await w.one('SELECT ends_at FROM subscription_items WHERE id = $1', [wa.json.item.id]);
  assert.equal(new Date(row.ends_at).getTime(), new Date(s.current_period_end).getTime(), 'WhatsApp runs to the end of what was paid');
  assert.equal(await feature('whatsapp_automation'), true, 'and is on until then');

  // The paid period ends.
  await w.sql(`UPDATE subscription_items SET ends_at = starts_at WHERE id = $1`, [wa.json.item.id]);
  await w.billing.renewals();
  assert.equal(await feature('whatsapp_automation'), false, 'then it is off');
  assert.equal((await w.one('SELECT ends_at FROM subscription_items WHERE id = $1', [form.json.item.id])).ends_at, null, 'the lead form was bought outright');
  assert.equal(await feature('lead_form'), true);
});

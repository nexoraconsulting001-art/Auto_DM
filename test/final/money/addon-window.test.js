// money-6 (the rest of it): Razorpay's add-on list is the whole account's, every business on Bhava's billing account, for
// ever. Reading all of it before every new line costs a page per 100 add-ons ever made, and the adapter gives up past its
// page bound, so once the account is old enough no add-on could be added at all. The repeat check is bounded by `from`:
// a line with a given key cannot be older than the first attempt to make it, which the caller knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRazorpay } from '../../../src/adapters/razorpay/index.js';
import { createRazorpay as createRazorpaySim } from '../../../tools/sim/razorpay/index.mjs';

const configFor = (sim) => ({ razorpayBaseUrl: sim.url, razorpayKeyId: sim.keyId, razorpayKeySecret: sim.keySecret, razorpayBillingWebhookSecret: sim.billingWebhookSecret });
const DAY = 86_400_000;

test('money-6: the repeat check reads only add-ons made since the line was first asked for, and still finds a repeat', async (t) => {
  const sim = createRazorpaySim();
  await sim.start();
  t.after(() => sim.close());
  const { billing } = createRazorpay(configFor(sim), { env: {} });
  const plan = await billing.ensurePlan({ code: 't1', cycle: 'monthly', amountPaise: 49900, name: 'Automation' });
  const subscribe = async (n) => {
    const customer = await billing.createCustomer({ name: `Shop ${n}`, email: `o${n}@example.test`, phone: `90000000${String(n).padStart(2, '0')}`, reference: `tenant:${n}` });
    return billing.createSubscription({ customerId: customer.id, planId: plan.id, notes: { tenant: String(n) } });
  };
  const other = await subscribe(2);
  const mine = await subscribe(1);

  // Months ago: 250 lines of other businesses (made straight at the gateway, as old history would be).
  const start = Date.now();
  await sim.post('/clock', { now: start - 90 * DAY });
  const auth = `Basic ${Buffer.from(`${sim.keyId}:${sim.keySecret}`).toString('base64')}`;
  for (let i = 0; i < 250; i++) {
    const res = await fetch(`${sim.url}/v1/subscriptions/${other.id}/addons`, {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ item: { name: 'Extra DMs', amount: 29900, currency: 'INR' }, quantity: 1, notes: { key: `old-${i}` } }),
    });
    assert.equal(res.status, 200);
  }
  await sim.post('/clock', { now: start });

  const since = new Date(start);
  const listed = async () => (await sim.get('/calls')).calls.filter((c) => c.method === 'GET' && String(c.path).startsWith('/v1/addons')).length;
  const before = await listed();
  const first = await billing.addCharge(mine.id, { name: 'Reel management', amountPaise: 300000, idempotencyKey: 'item:7:first', since });
  assert.equal(await listed() - before, 1, 'one page: only what was made since the line was first asked for');

  // A retry a day later (the answer was lost) finds the same line, still in one page.
  await sim.post('/clock', { now: start + DAY });
  const again = await billing.addCharge(mine.id, { name: 'Reel management', amountPaise: 300000, idempotencyKey: 'item:7:first', since });
  assert.equal(again.id, first.id, 'the same line, not a second charge');
  assert.equal(await listed() - before, 2);
  assert.equal((await sim.get('/state')).addons.filter((a) => a.subscription_id === mine.id).length, 1);
  // And taken back by its key, the same way.
  assert.equal(await billing.removeCharge(mine.id, { idempotencyKey: 'item:7:first', since }), true);
  assert.equal(await listed() - before, 3);
});

test('money-6: billing bounds every repeat check: a new item, its renewal and a closed month of pass-through costs', async (t) => {
  const { item, openBilling } = await import('../../p7/billing/support.js');
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const searches = async () => (await w.rzp.get('/calls')).calls.filter((c) => c.method === 'GET' && String(c.path).startsWith('/v1/addons'));
  await w.rzp.delete('/calls');
  const res = await shop.api('POST', '/billing/items', item('reel_management'));
  assert.equal(res.status, 201, res.text);
  const row = await w.one('SELECT created_at FROM subscription_items WHERE id = $1', [res.json.item.id]);
  let seen = await searches();
  assert.ok(seen.length >= 1, 'the repeat check ran');
  for (const c of seen) {
    assert.ok(c.query.from, 'bounded by from');
    assert.ok(Number(c.query.from) * 1000 <= +new Date(row.created_at) && Number(c.query.from) * 1000 >= +new Date(row.created_at) - 2 * DAY, 'from the item\'s first attempt, less a day');
  }

  // Last month's WhatsApp cost, charged with the next renewal: no older than the month's close.
  await shop.in(() => w.app.db.query(`INSERT INTO usage_events (tenant_id, meter, quantity, cost_paise, idempotency_key, occurred_at) VALUES ($1, 'whatsapp_messages', 2000, 157000, 'wa:last', date_trunc('month', now()) - interval '10 days')`, [shop.tenant.id]));
  // The item is charged with the next charge, then comes up for renewal with the period after.
  await shop.charge();
  await w.sql(`UPDATE subscriptions SET current_period_end = now() + interval '1 hour' WHERE tenant_id = $1`, [shop.tenant.id]);
  await w.sql(`UPDATE subscription_items i SET billed_through = s.current_period_end, provider_item_id = NULL FROM subscriptions s WHERE i.id = $1 AND s.id = i.subscription_id`, [res.json.item.id]);
  await w.rzp.delete('/calls');
  const done = await w.billing.renewals();
  assert.ok(done.passThrough >= 1 && done.queued >= 1, JSON.stringify(done));
  seen = await searches();
  assert.ok(seen.length >= 2, 'the renewal line and the pass-through line were both checked');
  for (const c of seen) {
    assert.ok(c.query.from, 'bounded by from');
    assert.ok(Date.now() - Number(c.query.from) * 1000 <= 45 * DAY, 'not the whole account history');
  }
});

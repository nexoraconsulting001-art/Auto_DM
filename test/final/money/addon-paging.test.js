// money-6: the add-on repeat check reads every page of Razorpay's add-on list (count at most 100, no subscription filter),
// so a retry after a lost answer finds its own line among many other businesses' and never charges twice. And money-4:
// a line not yet charged can be taken back, by its id or by its key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRazorpay } from '../../../src/adapters/razorpay/index.js';
import { createRazorpay as createRazorpaySim } from '../../../tools/sim/razorpay/index.mjs';

const configFor = (sim) => ({ razorpayBaseUrl: sim.url, razorpayKeyId: sim.keyId, razorpayKeySecret: sim.keySecret, razorpayBillingWebhookSecret: sim.billingWebhookSecret });

async function world(t) {
  const sim = createRazorpaySim();
  await sim.start();
  t.after(() => sim.close());
  const { billing } = createRazorpay(configFor(sim), { env: {} });
  const plan = await billing.ensurePlan({ code: 't1', cycle: 'monthly', amountPaise: 49900, name: 'Automation' });
  const subscribe = async (n) => {
    const customer = await billing.createCustomer({ name: `Shop ${n}`, email: `o${n}@example.test`, phone: `90000000${String(n).padStart(2, '0')}`, reference: `tenant:${n}` });
    return billing.createSubscription({ customerId: customer.id, planId: plan.id, notes: { tenant: String(n) } });
  };
  return { sim, billing, subscribe };
}

test('money-6: a repeated add-on is found past the first page of the account’s add-ons, and is not made twice', async (t) => {
  const { sim, billing, subscribe } = await world(t);
  const mine = await subscribe(1);
  const first = await billing.addCharge(mine.id, { name: 'WhatsApp messages, at cost', amountPaise: 157000, idempotencyKey: 'pt:1:whatsapp:2026-10' });
  // Then 150 lines for other businesses on Bhava's account, all newer than ours.
  const others = [await subscribe(2), await subscribe(3)];
  for (let i = 0; i < 150; i++) await billing.addCharge(others[i % 2].id, { name: 'Extra DMs', amountPaise: 29900, idempotencyKey: `item-${i}` });
  const again = await billing.addCharge(mine.id, { name: 'WhatsApp messages, at cost', amountPaise: 157000, idempotencyKey: 'pt:1:whatsapp:2026-10' });
  assert.equal(again.id, first.id, 'the same line, found on a later page');
  const ours = (await sim.get('/state')).addons.filter((a) => a.subscription_id === mine.id);
  assert.equal(ours.length, 1, 'charged once');
  // The same key on another subscription is another line: the match is by subscription too.
  const elsewhere = await billing.addCharge(others[0].id, { name: 'WhatsApp messages, at cost', amountPaise: 157000, idempotencyKey: 'pt:1:whatsapp:2026-10' });
  assert.notEqual(elsewhere.id, first.id);
});

test('money-4: a line not yet charged is taken back by id or by key; a charged one is refused', async (t) => {
  const { sim, billing, subscribe } = await world(t);
  const mine = await subscribe(1);
  const a = await billing.addCharge(mine.id, { name: 'Reel management', amountPaise: 300000, idempotencyKey: 'item:1:first' });
  const b = await billing.addCharge(mine.id, { name: 'Extra seat', amountPaise: 19900, idempotencyKey: 'item:2:first' });
  assert.equal(await billing.removeCharge(mine.id, { addonId: a.id }), true);
  assert.equal(await billing.removeCharge(mine.id, { idempotencyKey: 'item:2:first' }), true);
  assert.equal(await billing.removeCharge(mine.id, { idempotencyKey: 'item:9:first' }), false, 'nothing by that key');
  assert.deepEqual((await sim.get('/state')).addons.filter((x) => [a.id, b.id].includes(x.id)), []);
  const c = await billing.addCharge(mine.id, { name: 'Extra seat', amountPaise: 19900, idempotencyKey: 'item:3:first' });
  await sim.post('/subscriptions/authorize', { id: mine.id });
  await sim.post('/subscriptions/charge', { id: mine.id });
  await assert.rejects(() => billing.removeCharge(mine.id, { addonId: c.id }), (err) => err.kind === 'rejected' && err.delivery === 'none');
});

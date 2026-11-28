// R7-MONEY-2 (M-8): a launch-offer place is only held while the owner pays. Picking a paid plan reserves a place for
// billing_settings.offer_hold_hours; the first captured payment makes it the business's for good. A reservation nobody paid
// for is given back (the unpaid Razorpay subscription priced with the offer is cancelled with it), and so is one whose unpaid
// subscription ends, so closed payment pages can never use up the offer for real payers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBilling } from '../../p7/billing/support.js';

const launch = (w) => w.one(`SELECT claimed, max_accounts FROM offers WHERE code = 'launch'`);
const claimOf = (w, shop) => w.one('SELECT * FROM offer_claims WHERE tenant_id = $1', [shop.tenant.id]);
const expire = (w, shop) => w.sql(`UPDATE offer_claims SET hold_until = now() - interval '1 minute' WHERE tenant_id = $1`, [shop.tenant.id]);

test('M-8: an unpaid reservation of the last place is given back when it runs out, and the next payer gets the offer', async (t) => {
  const w = await openBilling(t);
  const [closer, late, payer] = [await w.business({ state: '29' }), await w.business({ state: '29' }), await w.business({ state: '29' })];
  await w.sql(`UPDATE offers SET claimed = max_accounts - 1 WHERE code = 'launch'`);

  assert.equal((await closer.change('t1')).status, 200);
  const held = await claimOf(w, closer);
  assert.ok(held?.hold_until, 'picking a plan only reserves the place');
  assert.equal((await closer.sub()).offer_code, 'launch');
  assert.equal((await launch(w)).claimed, 100, 'reserved: no one else can take it meanwhile');
  assert.equal((await late.change('t1')).status, 200);
  assert.equal((await late.sub()).offer_code, null, 'full while it is reserved');

  // The owner closed the payment page. Nothing happens before the reservation runs out...
  await w.billing.renewals();
  assert.equal((await launch(w)).claimed, 100);
  // ...and then the place comes back, and the unpaid subscription priced with the offer is ended at Razorpay.
  await expire(w, closer);
  await w.billing.renewals();
  assert.equal((await launch(w)).claimed, 99, 'the place is free again');
  assert.equal(await claimOf(w, closer), undefined);
  const ended = await closer.sub();
  assert.deepEqual([ended.status, ended.offer_code, ended.provider_cancel_pending], ['cancelled', null, null]);
  const state = await w.rzp.get('/state');
  assert.equal(state.subscriptions.find((s) => s.id === ended.provider_subscription_id).status, 'cancelled', 'its link can no longer be paid at the offer price');
  assert.equal((await closer.tenantRow()).plan, 'free', 'never paid: still Free');

  // The next owner who pays takes the place, for good.
  await payer.subscribe('t1');
  assert.equal((await payer.sub()).offer_code, 'launch');
  const kept = await claimOf(w, payer);
  assert.equal(kept.hold_until, null, 'paid: the place is final');
  await w.billing.renewals();
  assert.ok(await claimOf(w, payer), 'a paid place is never given back');
  assert.equal((await launch(w)).claimed, 100);
  const [line] = await payer.lines((await payer.invoices())[0].id);
  assert.equal(Number(line.discount_paise), 14970, 'the payer was charged the offer price');

  // The owner who closed the page can come back: a new subscription, and no place is left for it.
  assert.equal((await closer.change('t1')).status, 200);
  assert.equal((await closer.sub()).offer_code, null);
});

test('M-8: an unpaid subscription that ends gives its reserved place back at once', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  assert.equal((await shop.change('t1')).status, 200);
  assert.equal((await launch(w)).claimed, 1);
  assert.equal((await shop.change('free')).status, 200, 'back to Free before paying');
  assert.equal((await launch(w)).claimed, 0);
  assert.equal(await claimOf(w, shop), undefined);

  // Razorpay ending an unpaid subscription does the same.
  const other = await w.business({ state: '29' });
  assert.equal((await other.change('t1')).status, 200);
  assert.equal((await launch(w)).claimed, 1);
  await w.rzp.post('/subscriptions/cancel', { id: (await other.sub()).provider_subscription_id });
  await w.settle();
  assert.equal((await other.sub()).status, 'cancelled');
  assert.equal((await launch(w)).claimed, 0);
});

test('M-8: a payment that arrives after its reservation was given back keeps the offer when a place is left, else ops is told', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  assert.equal((await shop.change('t1')).status, 200);
  // The reservation ran out a moment before the payment arrived, before the renewals job ended the subscription.
  await w.sql(`DELETE FROM offer_claims WHERE tenant_id = $1`, [shop.tenant.id]);
  await w.sql(`UPDATE offers SET claimed = max_accounts WHERE code = 'launch'`);
  await shop.charge();
  assert.equal((await shop.tenantRow()).plan, 't1');
  const alerts = await w.sql(`SELECT * FROM alerts WHERE kind = 'billing.offer_full'`);
  assert.equal(alerts.length, 1, 'paid at the offer price with no place left: ops decides');
  const [inv] = await shop.invoices();
  assert.equal(Number(inv.total_paise), Number((await shop.payments())[0].amount_paise), 'the invoice still says what was taken');
});

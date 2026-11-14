// Bhava's own billing on the Razorpay simulator (PRD 3, 5.12): a paid plan from Free, the charge webhook once and only once
// however it arrives (F-51), a bad signature (F-52), GST by state (F-54), the yearly price (F-115) and the launch offer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBilling } from './support.js';

const sumOf = (rows, key) => rows.reduce((total, r) => total + Number(r[key]), 0);

test('a paid plan from Free: the hosted page, then one charge makes one payment and one GST invoice that adds up, and the plan moves', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });

  const picked = await shop.change('t1', 'monthly');
  assert.equal(picked.status, 200, picked.text);
  assert.match(picked.json.checkoutUrl, /^https:\/\/rzp\.io\/i\//, 'the provider’s own hosted page: no card data comes to Bhava');
  assert.equal(picked.json.plan.plan, 'free', 'nothing paid yet: still Free');
  assert.equal(picked.json.plan.nextPlan, 't1');
  assert.deepEqual((({ plan, cycle, status }) => ({ plan, cycle, status }))(await shop.sub()), { plan: 't1', cycle: 'monthly', status: 'active' });

  const charged = await shop.charge({ duplicates: 3 });
  assert.equal(charged.payment.status, 'captured');
  assert.equal((await shop.tenantRow()).plan, 't1', 'paid: the plan is in effect');
  const payments = await shop.payments();
  assert.equal(payments.length, 1, 'three deliveries, one payment');
  const invoices = await shop.invoices();
  assert.equal(invoices.length, 1, 'and one invoice');
  const [inv] = invoices;
  assert.equal(Number(payments[0].invoice_id), Number(inv.id));
  assert.match(inv.number, /^BH\/\d{2}-\d{2}\/00001$/);
  assert.equal(inv.doc_type, 'invoice');
  assert.equal(inv.seller.legalName, 'Bhava Commerce Private Limited');

  // The launch offer: the first paying accounts get 30% off, for life.
  const lines = await shop.lines(inv.id);
  assert.equal(lines.length, 1);
  const [plan] = lines;
  assert.deepEqual([plan.kind, plan.code, Number(plan.gross_paise), Number(plan.discount_paise), Number(plan.taxable_paise)], ['plan', 't1', 49900, 14970, 34930]);
  // Same state as Bhava: CGST and SGST, equal halves of 18%, and no IGST.
  assert.equal(Number(plan.cgst_paise), Number(plan.sgst_paise));
  assert.equal(Number(plan.igst_paise), 0);
  assert.equal(Number(plan.cgst_paise), Math.floor((34930 * 900 + 5000) / 10000));
  assert.equal(Number(inv.total_paise), Number(inv.taxable_paise) + Number(inv.cgst_paise) + Number(inv.sgst_paise) + Number(inv.igst_paise));
  assert.equal(Number(inv.taxable_paise), sumOf(lines, 'taxable_paise'), 'the totals are the sum of the lines');
  assert.equal(Number(inv.total_paise), Number(charged.payment.amount), 'what the provider took is what the invoice says');
  assert.equal((await w.one(`SELECT count(*)::int AS n FROM alerts WHERE kind = 'billing.amount_mismatch'`)).n, 0);
  assert.equal((await shop.sub()).offer_code, 'launch');

  // The same delivery again, much later, and the event replayed under a new id: still one payment and one invoice.
  const sent = (await w.rzp.get('/webhooks')).deliveries.filter((d) => d.body?.event === 'subscription.charged');
  await w.rzp.post('/webhooks/redeliver', { id: sent.at(-1).id, times: 2 });
  const replay = sent.at(-1).body;
  assert.equal((await w.hook(replay)).status, 200);
  await w.settle();
  assert.equal((await shop.payments()).length, 1);
  assert.equal((await shop.invoices()).length, 1);

  // The owner's view.
  const view = await shop.api('GET', '/billing');
  assert.equal(view.status, 200, view.text);
  assert.deepEqual([view.json.plan, view.json.status, view.json.hasPaymentMethod, view.json.offer.code], ['t1', 'active', true, 'launch']);
  assert.equal(view.json.nextChargePaise, 34930, 'next charge before tax, after the offer');
  const list = await shop.api('GET', '/billing/invoices');
  assert.equal(list.status, 200, list.text);
  assert.deepEqual([list.json.items.length, list.json.items[0].paid, list.json.items[0].lines.length], [1, true, 1]);
});

test('F-52: a bad, missing or malformed signature is 400 and stores nothing; a body that is not an event is refused', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  assert.equal((await shop.change('t1')).status, 200);
  const s = await shop.sub();
  await w.rzp.post('/subscriptions/authorize', { id: s.provider_subscription_id });
  const before = (await w.events()).length;
  const bad = await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, signature: 'bad' });
  assert.equal(bad.webhooks.at(-1).status, 400);
  const none = await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, signature: 'none' });
  assert.equal(none.webhooks.at(-1).status, 400);
  const body = { entity: 'event', event: 'subscription.charged', payload: {}, created_at: 1 };
  assert.equal((await w.hook(body, { signature: 'zzénot-hex' })).status, 400, 'a signature with odd bytes is a refusal, not a crash');
  assert.equal((await w.hook(body, { signature: 'a'.repeat(64) })).status, 400);
  assert.equal((await w.hook('{"event":', { })).status, 400, 'not JSON');
  await w.settle();
  assert.equal((await w.events()).length, before, 'nothing stored');
  assert.equal((await shop.payments()).length, 0, 'and no payment');
  assert.equal((await shop.tenantRow()).plan, 'free');
});

test('F-51 and S-24 for billing: a failure held back and delivered after a later charge changes nothing; both payments are kept', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const s = await shop.sub();
  await w.rzp.post('/clock', { advanceMs: 5_000 });
  await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, outcome: 'failed', hold: true });
  await w.rzp.post('/clock', { advanceMs: 5_000 });
  await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, outcome: 'charged', hold: true });
  await w.rzp.post('/webhooks/flush', { order: 'reverse' });
  await w.settle();
  const after = await shop.sub();
  assert.equal(after.status, 'active', 'the older failure is stale');
  assert.equal(after.grace_until, null);
  const payments = await shop.payments();
  assert.deepEqual(payments.map((p) => p.status).sort(), ['captured', 'captured', 'failed']);
  assert.equal((await shop.invoices()).length, 2, 'one invoice per captured payment');
  const outcomes = (await w.events()).filter((e) => e.event_type === 'subscription.pending').map((e) => e.outcome);
  assert.deepEqual(outcomes, ['stale']);
});

test('F-54 and F-115: another state pays IGST; yearly is ten months for twelve', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '27' });
  const catalog = await shop.api('GET', '/billing/catalog');
  assert.equal(catalog.status, 200, catalog.text);
  const t2 = catalog.json.plans.find((p) => p.code === 't2');
  assert.deepEqual([t2.monthlyPaise, t2.yearlyPaise], [149900, 1499000]);
  assert.equal(catalog.json.plans.find((p) => p.code === 'free').includedDms, 500);
  await w.sql(`UPDATE offers SET active = false WHERE code = 'launch'`);
  const out = await shop.subscribe('t2', 'yearly');
  const [inv] = await shop.invoices();
  const [line] = await shop.lines(inv.id);
  assert.deepEqual([Number(line.gross_paise), Number(line.discount_paise), Number(line.cgst_paise), Number(line.sgst_paise), Number(line.igst_paise)], [1499000, 0, 0, 0, 269820]);
  assert.equal(inv.place_of_supply, '27');
  assert.equal(Number(inv.total_paise), out.payment.amount);
  assert.deepEqual(Object.values(await shop.tenantRow()), ['t2', 'yearly']);
  const end = new Date((await shop.sub()).current_period_end);
  const start = new Date((await shop.sub()).current_period_start);
  assert.ok(end - start > 360 * 86_400_000, 'paid for twelve months');
});

test('no card data is stored: the event keeps ids, amounts and statuses only', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const s = await shop.sub();
  const res = await w.rzp.post('/webhooks/send', {
    accountId: 'billing', event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: s.provider_subscription_id, plan_id: 'plan_x', status: 'active', current_start: 1, current_end: 2, notes: { tenant: String(shop.tenant.id) } } },
      payment: { entity: { id: 'pay_cardtest1', amount: 100, status: 'captured', method: 'card', card: { last4: '4242', name: 'Asha Rao', number: '4111111111111111' }, email: 'asha@example.com', contact: '+919876543210', vpa: 'asha@upi' } },
    },
  });
  assert.equal(res.status, 200);
  await w.settle();
  const stored = JSON.stringify((await w.events()).map((e) => e.payload));
  for (const secret of ['4242', '4111', 'Asha', 'asha@', '9876543210']) assert.equal(stored.includes(secret), false, `${secret} is not stored`);
  const payment = (await shop.payments()).find((p) => p.provider_payment_id === 'pay_cardtest1');
  assert.equal(payment.method, 'card');
});

// The billing provider against its simulator (PRD 5.12): Razorpay Subscriptions on our own account, the events it sends
// (signed, repeated, out of order, with a bad signature, on the controlled clock), and the settlement report a monthly
// statement is checked against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ProviderError } from '../../../src/adapters/http.js';
import { createRazorpay } from '../../../src/adapters/razorpay/index.js';
import { createStoreAdapters } from '../../../src/adapters/store.js';
import { BILLING_EVENTS, BILLING_WEBHOOK } from '../../../src/contracts/billing.js';
import { SIGNATURE_HEADERS, STORE_PROVIDER_PATHS } from '../../../src/contracts/store-routes.js';
import { createRazorpay as createRazorpaySim } from '../../../tools/sim/razorpay/index.mjs';

async function start(t, sim) {
  await sim.start();
  t.after(() => sim.close());
  return sim;
}

/** A stand-in for the app's webhook route: keeps the exact bytes and headers of what arrived. */
async function receiver(t) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      got.push({ raw, headers: req.headers, body: JSON.parse(raw.toString() || 'null') });
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { got, url: `http://127.0.0.1:${server.address().port}${BILLING_WEBHOOK.path}` };
}

const configFor = (sim, extra = {}) => ({ razorpayBaseUrl: sim.url, razorpayKeyId: sim.keyId, razorpayKeySecret: sim.keySecret, razorpayBillingWebhookSecret: sim.billingWebhookSecret, ...extra });
const DAY = 86_400_000;

async function subscribed(t, { monthlyPaise = 49900 } = {}) {
  const sim = await start(t, createRazorpaySim());
  const hook = await receiver(t);
  await sim.post('/billing/webhook-url', { url: hook.url });
  const { billing } = createRazorpay(configFor(sim), { env: {} });
  const customer = await billing.createCustomer({ name: 'Brass and Co', email: 'owner@example.test', phone: '9000000001', reference: 'tenant:7' });
  const plan = await billing.ensurePlan({ code: 't1', cycle: 'monthly', amountPaise: monthlyPaise, name: 'Automation' });
  const subscription = await billing.createSubscription({ customerId: customer.id, planId: plan.id, notes: { tenant: '7' } });
  return { sim, hook, billing, customer, plan, subscription };
}

test('the billing webhook has its own address, apart from every store webhook', () => {
  assert.deepEqual([BILLING_WEBHOOK.method, BILLING_WEBHOOK.path, BILLING_WEBHOOK.provider, BILLING_WEBHOOK.scope, BILLING_WEBHOOK.badSignatureStatus], ['POST', '/webhooks/billing/razorpay', 'razorpay', 'billing', 400]);
  // '/webhooks/razorpay/:key' is a business's own gateway: the billing address must not be read as a business's key.
  for (const { path } of Object.values(STORE_PROVIDER_PATHS)) {
    const pattern = new RegExp(`^${path.replace(/:[a-z]+/gi, '[^/]+')}$`);
    assert.equal(pattern.test(BILLING_WEBHOOK.path), false, `${path} does not answer the billing address`);
  }
  for (const event of ['subscription.charged', 'subscription.pending', 'subscription.halted', 'subscription.cancelled']) assert.ok(BILLING_EVENTS[event], event);
  assert.equal(typeof createStoreAdapters({}, { env: {} }).razorpay.billing.createSubscription, 'function', 'ctx.providers.razorpay.billing');
});

test('a subscription: the hosted page, a charge on the controlled clock, and one payment id per charge', async (t) => {
  const { sim, hook, billing, customer, plan, subscription } = await subscribed(t);
  assert.deepEqual([subscription.status, subscription.planId, subscription.customerId, subscription.notes.tenant], ['created', plan.id, customer.id, '7']);
  assert.match(subscription.hostedUrl, /^https:\/\//, 'the payer goes to the provider’s own page: no card data comes here');
  assert.equal((await billing.createCustomer({ name: 'Brass and Co', email: 'owner@example.test', phone: '9000000001' })).id, customer.id, 'the same customer for the same person');

  const at = Date.parse('2026-11-12T06:00:00.000Z');
  await sim.post('/clock', { now: at, freeze: true });
  const { payment } = await sim.post('/subscriptions/charge', { id: subscription.id });
  assert.deepEqual([payment.amount, payment.status], [49900, 'captured']);
  const now = await billing.fetch(subscription.id);
  assert.deepEqual([now.status, now.paidCount, +now.currentStart, +now.currentEnd], ['active', 1, at, Date.parse('2026-12-12T06:00:00.000Z')], 'the period runs from the clock');

  assert.deepEqual(hook.got.map((g) => g.body.event), ['subscription.activated', 'subscription.charged']);
  const charged = hook.got[1];
  assert.equal(billing.verifyWebhook(charged.raw, charged.headers[SIGNATURE_HEADERS.razorpay]), true, 'signed with the billing secret, over the exact bytes');
  assert.ok(charged.headers[SIGNATURE_HEADERS.razorpayEventId], 'each event has its id');
  assert.deepEqual([charged.body.payload.subscription.entity.id, charged.body.payload.payment.entity.id, charged.body.payload.payment.entity.amount, charged.body.payload.subscription.entity.notes.tenant], [subscription.id, payment.id, 49900, '7']);
  assert.equal(createRazorpay(configFor(sim, { razorpayBillingWebhookSecret: sim.webhookSecret }), { env: {} }).billing.verifyWebhook(charged.raw, charged.headers[SIGNATURE_HEADERS.razorpay]), false, 'the store’s webhook secret does not open it');
  assert.equal(createRazorpay(configFor(sim, { razorpayBillingWebhookSecret: '' }), { env: {} }).billing.verifyWebhook(charged.raw, charged.headers[SIGNATURE_HEADERS.razorpay]), false, 'with no secret set, nothing verifies');
  assert.equal(billing.verifyWebhook(Buffer.concat([charged.raw, Buffer.from(' ')]), charged.headers[SIGNATURE_HEADERS.razorpay]), false, 'one byte more and it does not');
  assert.equal(billing.verifyWebhook(charged.raw.toString(), charged.headers[SIGNATURE_HEADERS.razorpay]), false, 'only the raw bytes');
  assert.equal(billing.verifyWebhook(charged.raw, undefined), false);

  // A month on: the next charge, and a second payment id.
  await sim.post('/clock', { advanceMs: 30 * DAY });
  const next = await sim.post('/subscriptions/charge', { id: subscription.id });
  assert.notEqual(next.payment.id, payment.id);
  assert.equal((await billing.fetch(subscription.id)).paidCount, 2);
});

test('events arrive twice, in the wrong order, and with a bad signature', async (t) => {
  const { sim, hook, billing, subscription } = await subscribed(t);
  // F-51: the same event again carries the same id and the same bytes.
  await sim.post('/subscriptions/charge', { id: subscription.id, duplicates: 2 });
  const charged = hook.got.filter((g) => g.body.event === 'subscription.charged');
  assert.equal(charged.length, 2);
  assert.equal(charged[0].headers[SIGNATURE_HEADERS.razorpayEventId], charged[1].headers[SIGNATURE_HEADERS.razorpayEventId], 'one event id, delivered twice');
  assert.deepEqual(charged[0].raw, charged[1].raw);

  // F-52: a signature that is not ours.
  hook.got.length = 0;
  await sim.post('/subscriptions/charge', { id: subscription.id, signature: 'bad' });
  const forged = hook.got.find((g) => g.body.event === 'subscription.charged');
  assert.equal(billing.verifyWebhook(forged.raw, forged.headers[SIGNATURE_HEADERS.razorpay]), false);
  hook.got.length = 0;
  await sim.post('/subscriptions/charge', { id: subscription.id, signature: 'none' });
  assert.equal(billing.verifyWebhook(hook.got[0].raw, hook.got[0].headers[SIGNATURE_HEADERS.razorpay]), false, 'and one with no signature at all');

  // A failed charge held back and delivered after the charge that followed it.
  hook.got.length = 0;
  await sim.post('/subscriptions/charge', { id: subscription.id, outcome: 'failed', hold: true });
  await sim.post('/subscriptions/charge', { id: subscription.id });
  await sim.post('/webhooks/flush', {});
  assert.deepEqual(hook.got.map((g) => g.body.event), ['subscription.charged', 'subscription.pending'], 'the older event arrives last');
  assert.ok(hook.got[1].body.created_at <= hook.got[0].body.created_at, 'and says when it really happened');
  assert.equal(hook.got[1].body.payload.payment.entity.status, 'failed');
});

test('a failed renewal, a halt, and a cancellation', async (t) => {
  const { sim, hook, billing, subscription } = await subscribed(t);
  await sim.post('/subscriptions/charge', { id: subscription.id });
  hook.got.length = 0;
  const failed = await sim.post('/subscriptions/charge', { id: subscription.id, outcome: 'failed' });
  assert.deepEqual([failed.payment.status, (await billing.fetch(subscription.id)).status], ['failed', 'pending']);
  await sim.post('/subscriptions/charge', { id: subscription.id, outcome: 'halted' });
  assert.equal((await billing.fetch(subscription.id)).status, 'halted');
  assert.equal((await billing.cancel(subscription.id)).status, 'cancelled');
  await sim.post('/subscriptions/cancel', { id: subscription.id });
  assert.deepEqual(hook.got.map((g) => g.body.event), ['subscription.pending', 'subscription.halted', 'subscription.cancelled']);
  assert.equal((await sim.post('/subscriptions/charge', { id: subscription.id }).catch((err) => err)) instanceof Error, true, 'an ended subscription is not charged');
});

test('an upgrade is now, a downgrade waits for the cycle, and a one-off charge is added once', async (t) => {
  const { sim, billing, subscription } = await subscribed(t);
  await sim.post('/subscriptions/charge', { id: subscription.id });
  const store = await billing.ensurePlan({ code: 't3', cycle: 'monthly', amountPaise: 399900, name: 'Store' });
  const catalog = await billing.ensurePlan({ code: 't2', cycle: 'monthly', amountPaise: 149900, name: 'Catalog' });
  assert.equal((await billing.changeSubscription(subscription.id, { planId: store.id, at: 'now' })).planId, store.id, 'F-33: an upgrade applies at once');
  assert.equal((await billing.changeSubscription(subscription.id, { planId: catalog.id, at: 'cycle_end' })).planId, store.id, 'a downgrade keeps the paid plan until the cycle ends');
  await assert.rejects(() => billing.changeSubscription(subscription.id, { planId: catalog.id, at: 'whenever' }), /now or at cycle_end/);

  // F-85, F-116: a pack or a setup bought mid-cycle is its own line on the next charge, once.
  const first = await billing.addCharge(subscription.id, { name: 'Extra DMs', amountPaise: 29900, idempotencyKey: 'item-0001' });
  const again = await billing.addCharge(subscription.id, { name: 'Extra DMs', amountPaise: 29900, idempotencyKey: 'item-0001' });
  assert.equal(again.id, first.id, 'the same key is the same line');
  const other = await billing.addCharge(subscription.id, { name: 'Reel backlog', amountPaise: 1500000, idempotencyKey: 'item-0002' });
  assert.notEqual(other.id, first.id);
  await assert.rejects(() => billing.addCharge(subscription.id, { name: 'Extra DMs', amountPaise: 29900 }), /idempotency key/);
  await assert.rejects(() => billing.addCharge(subscription.id, { name: 'Extra DMs', amountPaise: 299.5, idempotencyKey: 'item-0003' }), /whole paise/);

  const renewal = await sim.post('/subscriptions/charge', { id: subscription.id });
  assert.equal(renewal.payment.amount, 149900 + 29900 + 1500000, 'the downgraded plan, and each one-off line once');
  assert.equal((await billing.fetch(subscription.id)).planId, catalog.id);
  assert.equal((await sim.post('/subscriptions/charge', { id: subscription.id })).payment.amount, 149900, 'a one-off line is not charged again');
});

test('yearly plans, and a provider that refuses or is not ours', async (t) => {
  const sim = await start(t, createRazorpaySim());
  const { billing } = createRazorpay(configFor(sim), { env: {} });
  const customer = await billing.createCustomer({ name: 'Brass and Co', email: 'owner@example.test' });
  const yearly = await billing.ensurePlan({ code: 't2', cycle: 'yearly', amountPaise: 1499000, name: 'Catalog, yearly' });
  const subscription = await billing.createSubscription({ customerId: customer.id, planId: yearly.id });
  const at = Date.parse('2026-11-12T06:00:00.000Z');
  await sim.post('/clock', { now: at, freeze: true });
  assert.equal((await sim.post('/subscriptions/charge', { id: subscription.id })).payment.amount, 1499000, 'F-115: ten months’ fee, charged once for the year');
  assert.equal(+(await billing.fetch(subscription.id)).currentEnd, Date.parse('2027-11-12T06:00:00.000Z'));

  await assert.rejects(() => billing.ensurePlan({ code: 't2', cycle: 'weekly', amountPaise: 100, name: 'x' }), /monthly or yearly/);
  await assert.rejects(() => billing.createSubscription({ customerId: customer.id, planId: 'plan_missing' }), (err) => err instanceof ProviderError && err.kind === 'rejected');
  await assert.rejects(() => billing.fetch('sub_missing'), (err) => err instanceof ProviderError);
  const stranger = createRazorpay(configFor(sim, { razorpayBillingKeyId: 'rzp_test_other', razorpayBillingKeySecret: 'wrong' }), { env: {} }).billing;
  await assert.rejects(() => stranger.fetch(subscription.id), (err) => err instanceof ProviderError, 'the billing keys are used when they are set');
});

test('the settlement report for one linked account: what a statement is reconciled against', async (t) => {
  const sim = await start(t, createRazorpaySim());
  const { route } = createRazorpay(configFor(sim), { env: {} });
  const at = Date.parse('2026-11-12T06:00:00.000Z');
  await sim.post('/clock', { now: at, freeze: true });
  const accountOf = async (reference) => {
    const account = await route.createLinkedAccount({ email: `${reference}@example.test`, phone: '9000000001', legalName: reference, businessType: 'proprietorship', contactName: 'Asha', reference });
    await sim.post('/accounts/kyc', { id: account.id, status: 'activated' });
    return { linkedAccountId: account.id };
  };
  const a = await accountOf('tenant-a');
  const b = await accountOf('tenant-b');
  const paid = async (account, amountPaise) => {
    const order = await route.createOrder(account, { amountPaise, receipt: `R-${amountPaise}` });
    return (await sim.post('/pay', { orderId: order.id, webhook: false })).payment;
  };
  const first = await paid(a, 100000);
  const second = await paid(a, 50000);
  await paid(b, 70000);
  await route.refund(a, second.id, { amountPaise: 20000, idempotencyKey: 'refund-0001' });
  const [transfer] = (await sim.get('/state')).transfers;
  await sim.post('/transfers/settle', { id: transfer.id });

  const report = await route.settlementReport(a, { year: 2026, month: 11 });
  const transfers = report.filter((row) => row.kind === 'transfer');
  assert.deepEqual(transfers.map((row) => row.amountPaise).sort((x, y) => x - y), [50000, 100000], 'F-83: the whole of each sale, to this business only');
  assert.deepEqual(transfers.map((row) => row.paymentId).sort(), [first.id, second.id].sort());
  assert.ok(transfers.every((row) => row.feePaise > 0 && row.taxPaise > 0), 'F-113: the gateway fee at cost is all that is taken');
  assert.deepEqual(transfers.map((row) => row.settled).sort(), [false, true]);
  assert.ok(transfers.find((row) => row.settled).settlementId);
  assert.deepEqual(report.filter((row) => row.kind === 'reversal').map((row) => row.amountPaise), [20000], 'a refund takes its part back');
  assert.deepEqual((await route.settlementReport(b, { year: 2026, month: 11 })).map((row) => row.amountPaise), [70000], 'another business’s report holds only its own');
  assert.deepEqual(await route.settlementReport(a, { year: 2026, month: 12 }), [], 'and another month is empty');
  await assert.rejects(() => route.settlementReport({ linkedAccountId: 'acc_missing' }, { year: 2026, month: 11 }), (err) => err instanceof ProviderError);
  await assert.rejects(() => route.settlementReport({}, { year: 2026, month: 11 }), /linked account/);
});

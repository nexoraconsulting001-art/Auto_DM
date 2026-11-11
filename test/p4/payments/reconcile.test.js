// Reconciliation (PRD 9.7): the pending check that finds a payment whose webhook never came (S-26), the daily match with the
// gateway, and events left waiting in the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { PAYMENT_JOBS, payments as paymentsModule } from '../../../src/modules/payments/index.js';
import { REFUND_JOBS, refunds as refundsModule } from '../../../src/modules/refunds/index.js';
import { openWorld } from './support.js';

const MINUTE = 60_000;

test('S-26: a payment whose webhook never arrives is found by the pending check after 15 minutes and marked paid', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder({ totalPaise: 99900 });
  const placed = await shop.start(order.id);
  await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, webhook: false });

  // Too soon: the shopper may still be on the gateway's page.
  assert.deepEqual(await world.ctx.payments.reconcile.pendingCheck(), []);
  await world.age(16 * MINUTE);
  const checked = await world.ctx.payments.reconcile.pendingCheck();
  assert.deepEqual(checked.map((c) => c.outcome), ['processed']);
  await world.settle();
  const now = await shop.order(order.id);
  assert.equal(now.payment_status, 'paid');
  assert.equal(now.fulfilment_status, 'new');
  const history = await shop.sql(`SELECT actor FROM order_status_history WHERE tenant_id = $1 AND order_id = $2 AND machine = 'payment'`, [shop.tenant.id, order.id]);
  assert.deepEqual(history.map((h) => h.actor), ['job:payment-check']);
  assert.equal((await shop.lines(order.id)).filter((l) => l.kind === 'sale').length, 1);
  // Paid orders are not asked about again.
  await world.age(5 * MINUTE);
  assert.deepEqual(await world.ctx.payments.reconcile.pendingCheck(), []);
});

test('the pending check waits between asks, and a payment that arrives after the hold ran out brings the order back', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder({ totalPaise: 50000 });
  const placed = await shop.start(order.id);
  await world.age(16 * MINUTE);
  // Nothing paid yet: asked once, then left alone for a while.
  assert.deepEqual((await world.ctx.payments.reconcile.pendingCheck()).map((c) => c.outcome), ['nothing']);
  assert.deepEqual(await world.ctx.payments.reconcile.pendingCheck(), []);

  // The hold runs out, then the shopper's payment goes through anyway.
  await shop.inTenant(() => world.db.tx((tx) => changeOrder(tx, order.id, { fulfilment: 'cancelled', cancelReason: 'hold_expired', actor: 'job:hold-expiry' })));
  await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, webhook: false });
  await world.age(2 * MINUTE);
  assert.deepEqual((await world.ctx.payments.reconcile.pendingCheck()).map((c) => c.outcome), ['processed']);
  const now = await shop.order(order.id);
  assert.equal(now.payment_status, 'paid');
  assert.equal(now.fulfilment_status, 'new', 'reinstated: the money arrived after the hold');
});

test('the daily match writes missing statement lines and flags transfers that never arrived and refunds made at the gateway', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 70000 });
  const [payment] = await shop.payments(order.id);
  await shop.sql('DELETE FROM settlement_lines WHERE tenant_id = $1 AND order_id = $2', [shop.tenant.id, order.id]);
  // A refund made at the gateway itself, which this business never heard about.
  const auth = `Basic ${Buffer.from(`${world.rzp.keyId}:${world.rzp.keySecret}`).toString('base64')}`;
  const made = await fetch(`${world.rzp.url}/v1/payments/${payment.gateway_payment_id}/refund`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 5000 }) });
  assert.equal(made.status, 200);
  await world.age(25 * 60 * MINUTE);

  const [result] = await world.ctx.payments.reconcile.daily();
  assert.equal(result.tenantId, shop.tenant.id);
  assert.equal(result.repaired, 1);
  assert.deepEqual((await shop.lines(order.id)).map((l) => l.kind), ['sale', 'gateway_fee', 'gateway_fee_tax']);
  const gaps = await shop.sql('SELECT kind, ref FROM reconciliation_gaps WHERE tenant_id = $1 ORDER BY kind', [shop.tenant.id]);
  assert.deepEqual(gaps.map((g) => g.kind), ['refund_mismatch', 'transfer_missing']);
  assert.ok(gaps.every((g) => g.ref === `payment:${payment.id}`));
  // Run again the same day: nothing is flagged twice.
  await world.ctx.payments.reconcile.daily();
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM reconciliation_gaps WHERE tenant_id = $1', [shop.tenant.id]))[0].n, 2);
  assert.equal((await shop.sql(`SELECT * FROM alerts WHERE tenant_id = $1 AND audience = 'ops' AND kind = 'payment.reconciliation'`, [shop.tenant.id])).length, 1);
});

test('a refund webhook for a refund made at the gateway is recorded, so the order’s totals stay true', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 70000 });
  const [payment] = await shop.payments(order.id);
  const entity = { id: 'rfnd_outside00001', entity: 'refund', payment_id: payment.gateway_payment_id, amount: 7000, currency: 'INR', status: 'processed' };
  await world.hook('refund.processed', { refund: { entity } });
  await world.hook('refund.processed', { refund: { entity } });
  await world.settle();
  const refunds = await shop.refunds(order.id);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].gateway_refund_id, 'rfnd_outside00001');
  assert.equal((await shop.order(order.id)).payment_status, 'partially_refunded');
  assert.equal(Number((await shop.order(order.id)).refunded_paise), 7000);
});

test('events stored but not worked through are picked up by the sweep; one that keeps failing is given up and ops are told', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder({ totalPaise: 30000 });
  const placed = await shop.start(order.id);
  const paid = await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, webhook: false });
  // As if the web process stopped straight after storing it.
  const { webhooks } = world.ctx.payments;
  await webhooks.store({ provider: 'razorpay', scope: 'managed', eventId: 'evt_left_behind', eventType: 'payment.captured', payload: { event: 'payment.captured', payment: { id: paid.payment.id, orderId: placed.gateway.gatewayOrderId, status: 'captured', amountPaise: 30000, currency: 'INR', method: 'upi', feePaise: 0, taxPaise: 0 }, linked: [] } });
  const done = await webhooks.drain();
  assert.deepEqual(done.map((d) => d.status), ['processed']);
  assert.equal((await shop.order(order.id)).payment_status, 'paid');

  // An event the code can't work through: tried with backoff, then failed for a person.
  await webhooks.store({ provider: 'razorpay', scope: 'managed', eventId: 'evt_broken', eventType: 'payment.captured', payload: { event: 'payment.captured', payment: { id: paid.payment.id, orderId: placed.gateway.gatewayOrderId, status: 'captured', amountPaise: 30000, currency: 'INR' }, linked: 5 } });
  for (let i = 0; i < 8; i++) {
    await world.db.platform.query(`UPDATE provider_webhook_events SET received_at = received_at - interval '2 hours' WHERE event_id = 'evt_broken'`);
    await webhooks.drain();
  }
  const [broken] = await world.db.platform.query(`SELECT * FROM provider_webhook_events WHERE event_id = 'evt_broken'`);
  assert.equal(broken.status, 'failed');
  assert.equal(broken.attempts, 8);
  assert.doesNotMatch(broken.last_error, /pay_|order_/);
  assert.equal((await world.db.platform.query(`SELECT * FROM alerts WHERE audience = 'ops' AND kind = 'payment.webhook_failed'`)).length, 1);
});

test('the worker runs the webhook sweep, the pending check, the daily match and the refund sweep on their own schedules', async () => {
  const work = new Map();
  const every = new Map();
  const queue = { work: (name, handler) => work.set(name, handler), every: async (name, ms) => every.set(name, ms) };
  // Building the services touches nothing outside, so a context with a queue is enough to see what is registered.
  const ctx = { platform: { queue }, db: {}, repos: {}, config: {}, providers: {} };
  await paymentsModule.jobs(ctx)();
  await refundsModule.jobs(ctx)();
  const names = [PAYMENT_JOBS.daily, PAYMENT_JOBS.pending, PAYMENT_JOBS.webhooks, REFUND_JOBS.sweep].sort();
  assert.deepEqual([...work.keys()].sort(), names);
  assert.deepEqual([...every.keys()].sort(), names);
  assert.ok(every.get(PAYMENT_JOBS.pending) <= 2 * MINUTE, 'often enough to find a missed payment within 20 minutes (S-26)');
  assert.equal(every.get(PAYMENT_JOBS.daily), 24 * 60 * MINUTE);
});

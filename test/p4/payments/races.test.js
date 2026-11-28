// Payment webhooks worked by two processes at once (R4-WH-1): the web app works an event as it arrives and the worker's
// sweep works whatever is left, from the same table. Each event must be applied once, one payment's events in the order they
// came (a refund never before the capture it refunds), and Bhava's own billing events are not the store's to touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRazorpayEvent, createWebhooks } from '../../../src/modules/payments/webhooks.js';
import { openWorld } from './support.js';

/** Counts and times each call of `obj[name]` while the test runs, keyed by what `keyOf` says the call is about. */
function spy(t, obj, name, keyOf, calls) {
  const real = obj[name];
  obj[name] = async (...args) => {
    const call = { key: keyOf(...args), start: calls.length, end: null };
    calls.push(call);
    try {
      return await real.apply(obj, args);
    } finally {
      call.end = calls.length;
      calls.push({ endOf: call.key });
    }
  };
  t.after(() => { obj[name] = real; });
}

test('two drainers at once (the web app and the worker) apply each payment and refund event once and in order, and leave billing events alone', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder({ totalPaise: 99900 });
  const placed = await shop.start(order.id);
  const gwOrder = placed.gateway.gatewayOrderId;
  await world.settle();

  // Stored and not yet worked through, as a busy minute leaves them: a failed attempt, the captured retry, then a refund
  // of that capture made at the gateway itself. And one of Bhava's own billing events, under its own scope.
  const at = Math.floor(Date.now() / 1000);
  const store = (scope, event, payload) => world.db.platform.query(
    `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload) VALUES ('razorpay', $1, $2, $3, $4::jsonb) RETURNING id`,
    [scope, `evt_race_${event}_${Math.random().toString(36).slice(2)}`, event, JSON.stringify(payload)],
  );
  const clean = (event, entities) => cleanRazorpayEvent({ event, created_at: at, payload: entities });
  await store('managed', 'payment.failed', clean('payment.failed', { payment: { entity: { id: 'pay_raceA0000001', order_id: gwOrder, amount: 99900, currency: 'INR', status: 'failed', method: 'upi', error_code: 'BAD_REQUEST_ERROR' } } }));
  await store('managed', 'payment.captured', clean('payment.captured', { payment: { entity: { id: 'pay_raceB0000001', order_id: gwOrder, amount: 99900, currency: 'INR', status: 'captured', method: 'upi', fee: 2000, tax: 300 } } }));
  await store('managed', 'refund.processed', clean('refund.processed', { refund: { entity: { id: 'rfnd_race0000001', payment_id: 'pay_raceB0000001', amount: 20000, status: 'processed' } } }));
  const [billingRow] = await store('billing', 'subscription.charged', { event: 'subscription.charged', createdAt: at, subscription: { id: 'sub_race0000001' }, payment: { id: 'pay_raceC0000001', status: 'captured' } });

  const calls = [];
  const service = world.ctx.payments;
  spy(t, service, 'applyGatewayPayment', ({ gp }) => `${gp.id}:${gp.status}`, calls);
  spy(t, service.refunds, 'applyGatewayRefund', ({ refund }) => `${refund.id}:${refund.status}`, calls);
  const worker = createWebhooks(world.ctx, service);
  await Promise.all([service.webhooks.drain(), worker.drain(), service.webhooks.drain(), worker.drain()]);
  await world.settle();

  const started = calls.filter((c) => c.key).map((c) => c.key);
  assert.deepEqual(started, ['pay_raceA0000001:failed', 'pay_raceB0000001:captured', 'rfnd_race0000001:processed'], 'each event applied once, in the order it came');
  for (const c of calls.filter((x) => x.key)) assert.equal(c.end, c.start + 1, `${c.key} finished before anything else of this payment began`);

  const rows = (await world.webhookRows()).filter((r) => String(r.event_id).startsWith('evt_race_'));
  assert.deepEqual(rows.filter((r) => r.scope === 'managed').map((r) => [r.event_type, r.status, r.outcome, r.attempts]), [
    ['payment.failed', 'processed', 'processed', 1],
    ['payment.captured', 'processed', 'processed', 1],
    ['refund.processed', 'processed', 'processed', 1],
  ]);
  const billing = rows.find((r) => Number(r.id) === Number(billingRow.id));
  assert.deepEqual([billing.status, billing.attempts, billing.last_error, billing.tenant_id], ['received', 0, '', null], 'a billing event is never worked by the store’s drainer');

  assert.equal((await shop.order(order.id)).payment_status, 'partially_refunded');
  assert.deepEqual((await shop.payments(order.id)).map((p) => [p.gateway_payment_id, p.status]), [['pay_raceB0000001', 'captured']]);
  assert.deepEqual((await shop.refunds(order.id)).map((r) => [r.gateway_refund_id, r.status, Number(r.amount_paise)]), [['rfnd_race0000001', 'processed', 20000]], 'the gateway’s refund recorded once');
});

test('Bhava’s own billing events (provider razorpay, scope billing) are never worked by the store’s payment drainer', async (t) => {
  const world = await openWorld(t);
  const [row] = await world.db.platform.query(
    `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload) VALUES ('razorpay', 'billing', 'evt_race_billing', 'subscription.charged', $1::jsonb) RETURNING id`,
    [JSON.stringify({ event: 'subscription.charged', createdAt: Math.floor(Date.now() / 1000), subscription: { id: 'sub_race0000001' }, payment: { id: 'pay_raceC0000001', status: 'captured' } })],
  );
  await world.ctx.payments.webhooks.drain();
  const [after] = await world.db.platform.query('SELECT status, outcome, attempts, last_error, tenant_id FROM provider_webhook_events WHERE id = $1', [row.id]);
  assert.deepEqual(after, { status: 'received', outcome: '', attempts: 0, last_error: '', tenant_id: null }, 'left for billing, untouched');
});

test('a refund waits for the capture it refunds while that capture is still to be tried again, then both apply in order', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder({ totalPaise: 99900 });
  const placed = await shop.start(order.id);
  await world.settle();
  const at = Math.floor(Date.now() / 1000);
  const store = async (event, entities) => (await world.db.platform.query(
    `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload) VALUES ('razorpay', 'managed', $1, $2, $3::jsonb) RETURNING id`,
    [`evt_race_${event}`, event, JSON.stringify(cleanRazorpayEvent({ event, created_at: at, payload: entities }))],
  ))[0].id;
  const capture = await store('payment.captured', { payment: { entity: { id: 'pay_raceD0000001', order_id: placed.gateway.gatewayOrderId, amount: 99900, currency: 'INR', status: 'captured', method: 'upi' } } });
  const refund = await store('refund.processed', { refund: { entity: { id: 'rfnd_raceD000001', payment_id: 'pay_raceD0000001', amount: 30000, status: 'processed' } } });
  const state = async (id) => (await world.db.platform.query('SELECT status, outcome, attempts FROM provider_webhook_events WHERE id = $1', [id]))[0];

  // The capture fails once (a database blip): it is let go to be tried again after its back-off.
  const service = world.ctx.payments;
  const real = service.applyGatewayPayment;
  let blips = 1;
  service.applyGatewayPayment = async (...args) => {
    if (blips-- > 0) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    return real.apply(service, args);
  };
  t.after(() => { service.applyGatewayPayment = real; });
  await service.webhooks.drain();
  assert.deepEqual(await state(capture), { status: 'received', outcome: '', attempts: 1 });
  assert.deepEqual(await state(refund), { status: 'received', outcome: '', attempts: 0 }, 'the refund is not weighed before its capture');
  assert.equal((await shop.refunds(order.id)).length, 0);

  // Its back-off over, the capture applies, and then the refund.
  await world.db.platform.query(`UPDATE provider_webhook_events SET received_at = received_at - interval '1 minute', last_attempt_at = last_attempt_at - interval '1 minute' WHERE id = $1`, [capture]);
  await service.webhooks.drain();
  assert.deepEqual(await state(capture), { status: 'processed', outcome: 'processed', attempts: 2 });
  assert.deepEqual(await state(refund), { status: 'processed', outcome: 'processed', attempts: 1 });
  assert.equal((await shop.order(order.id)).payment_status, 'partially_refunded');
  assert.deepEqual((await shop.refunds(order.id)).map((r) => [r.gateway_refund_id, r.status, Number(r.amount_paise)]), [['rfnd_raceD000001', 'processed', 30000]]);
});

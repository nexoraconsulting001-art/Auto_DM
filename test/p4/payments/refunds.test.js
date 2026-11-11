// Refunds (PRD 9.8): owner only after the password again, never more than was captured even at the same moment, through the
// gateway with the transfer taken back in managed mode, by hand for cash, retried with one key, and on a shopper's cancel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { refundBody, openWorld } from './support.js';

const cancel = (world, shop, orderId, cancelReason) => shop.inTenant(() => world.db.tx((t) => changeOrder(t, orderId, { fulfilment: 'cancelled', cancelReason, actor: 'user:1' })));

test('S-27, S-75: refunding ₹200 of ₹999 shows partially refunded, takes ₹200 back from the seller’s transfer and is on the statement', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  const res = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(20000));
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.status, 'processed');
  assert.equal(res.json.method, 'gateway');
  assert.equal(res.json.reversalStatus, 'reversed');
  assert.equal(res.json.reversalPaise, 20000);
  await world.settle();

  const now = await shop.order(order.id);
  assert.equal(now.payment_status, 'partially_refunded');
  assert.equal(Number(now.refunded_paise), 20000);
  const [payment] = await shop.payments(order.id);
  assert.equal(Number(payment.refunded_paise), 20000);
  assert.equal(Number(payment.reversed_paise), 20000, 'the seller’s transfer is reduced by ₹200');
  const state = await world.rzp.get('/state');
  assert.equal(state.refunds.length, 1);
  assert.equal(state.refunds[0].amount, 20000);
  assert.equal(state.transfers.find((x) => x.source === payment.gateway_payment_id).amount_reversed, 20000);
  const lines = (await shop.lines(order.id)).filter((l) => ['refund', 'transfer_reversal'].includes(l.kind));
  assert.deepEqual(lines.map((l) => [l.kind, Number(l.amount_paise)]), [['refund', -20000], ['transfer_reversal', -20000]]);
  const audit = await shop.sql(`SELECT action, actor FROM audit_log WHERE tenant_id = $1 AND action LIKE 'refund.%' ORDER BY id`, [shop.tenant.id]);
  assert.deepEqual(audit.map((a) => a.action), ['refund.request', 'refund.processed']);
  assert.match(audit[0].actor, /^user:\d+$/);
  // The order's refunds, and the one refund, as the console reads them.
  assert.equal((await shop.api('GET', `/orders/${order.id}/refunds`)).json.items.length, 1);
  assert.equal((await shop.api('GET', `/refunds/${res.json.id}`)).json.amountPaise, 20000);
  // The rest, refunded: the order is refunded in full.
  assert.equal((await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(79900))).status, 201);
  assert.equal((await shop.order(order.id)).payment_status, 'refunded');
});

test('S-28, S-29: more than was captured is refused, a manager gets 403, and a wrong password refunds nothing', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  const over = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(100000));
  assert.equal(over.status, 400);
  assert.match(over.json.fields.amountPaise, /at most ₹999/);

  const manager = await shop.member('manager', '9000000005');
  const denied = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(100, { password: 'member-pass' }), { as: manager.token });
  assert.equal(denied.status, 403);
  // The manager may still read them.
  assert.equal((await shop.api('GET', `/orders/${order.id}/refunds`, undefined, { as: manager.token })).status, 200);

  const wrong = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(100, { password: 'not-the-password' }));
  assert.equal(wrong.status, 400);
  assert.ok(wrong.json.fields.password);
  assert.equal((await shop.refunds(order.id)).length, 0);
  assert.equal((await world.rzp.get('/state')).refunds.length, 0);
  // Guessing is limited.
  for (let i = 0; i < 5; i++) await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(100, { password: `guess-${i}` }));
  assert.equal((await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(100))).status, 429);
});

test('S-28: two refunds at the same moment cannot both pass what was captured, and the same key twice is one refund', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  const answers = await Promise.all([shop.api('POST', `/orders/${order.id}/refunds`, refundBody(60000)), shop.api('POST', `/orders/${order.id}/refunds`, refundBody(60000))]);
  assert.deepEqual(answers.map((a) => a.status).sort(), [201, 400], answers.map((a) => a.text).join(' | '));
  const total = (await shop.refunds(order.id)).filter((r) => r.status !== 'failed').reduce((sum, r) => sum + Number(r.amount_paise), 0);
  assert.equal(total, 60000);

  const body = refundBody(10000);
  const [a, b] = await Promise.all([shop.api('POST', `/orders/${order.id}/refunds`, body), shop.api('POST', `/orders/${order.id}/refunds`, body)]);
  assert.equal(a.json.id, b.json.id, 'a double tap is one refund');
  assert.equal((await shop.refunds(order.id)).length, 2);
  assert.equal((await world.rzp.get('/state')).refunds.length, 2);
  // The database holds the limit even for SQL that goes round the service.
  const [payment] = await shop.payments(order.id);
  await assert.rejects(
    shop.inTenant(() => world.db.query(`INSERT INTO refunds (tenant_id, order_id, payment_id, amount_paise, method, requested_by, idempotency_key) VALUES ($1, $2, $3, 50000, 'gateway', 'user:1', 'direct-sql-1')`, [shop.tenant.id, order.id, payment.id])),
    (err) => err.constraint === 'refunds_within_captured',
  );
});

test('a refund whose gateway answer is lost is finished by the sweep with the same key: one refund at the gateway', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 50000 });
  await world.rzp.fault({ kind: 'partial', then: 'server_error', match: { method: 'POST', path: '/v1/payments/*/refund' }, times: 3 });
  const res = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(50000));
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.status, 'requested', 'still with the gateway');
  assert.equal((await shop.order(order.id)).payment_status, 'paid');
  // Nothing else may take the amount it holds.
  assert.equal((await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(100))).status, 400);

  await world.age(3 * 60_000);
  const swept = await shop.run(() => world.ctx.refunds.sweep());
  assert.equal(swept.length, 1);
  assert.equal(swept[0].status, 'processed');
  await world.settle();
  assert.equal((await shop.order(order.id)).payment_status, 'refunded');
  assert.equal((await world.rzp.get('/state')).refunds.length, 1, 'the gateway made one refund however often it was asked');
});

test('a refund the gateway refuses is failed, frees its amount, and can be tried again', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 50000 });
  // Throttled on every try: the gateway answered, so it did nothing.
  await world.rzp.fault({ kind: 'rate_limit', match: { method: 'POST', path: '/v1/payments/*/refund' }, times: 3 });
  const res = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(30000));
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.status, 'failed');
  assert.equal((await shop.alerts('refund.failed')).length, 1);
  assert.equal((await shop.order(order.id)).payment_status, 'paid');

  const retried = await shop.api('POST', `/refunds/${res.json.id}/retry`);
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.status, 'processed');
  assert.equal((await shop.order(order.id)).payment_status, 'partially_refunded');
  // Processed is final: trying again changes nothing.
  assert.equal((await shop.api('POST', `/refunds/${res.json.id}/retry`)).json.status, 'processed');
  assert.equal((await world.rzp.get('/state')).refunds.length, 1);
});

test('cash on delivery is refunded by hand with a reference; the door’s cash is recorded on delivery', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder({ mode: 'cod', totalPaise: 60000 });
  await shop.inTenant(() => world.db.tx((tx) => changeOrder(tx, order.id, { payment: 'cod_due', fulfilment: 'new', actor: 'shopper' })));
  // Nothing collected yet: nothing to refund.
  assert.equal((await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(100))).status, 409);
  await shop.inTenant(() => world.db.tx(async (tx) => {
    await changeOrder(tx, order.id, { fulfilment: 'shipped', actor: 'user:1' });
    await changeOrder(tx, order.id, { fulfilment: 'delivered', actor: 'user:1' });
  }));
  await world.settle();
  let now = await shop.order(order.id);
  assert.equal(now.payment_status, 'paid', 'delivered: the courier collected the cash');
  const [cash] = await shop.payments(order.id);
  assert.equal(cash.provider, 'cod');
  assert.equal(Number(cash.amount_paise), 60000);

  const missing = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(10000));
  assert.equal(missing.status, 400);
  assert.ok(missing.json.fields.reference);
  const res = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(10000, { reference: 'UPI 412233445566' }));
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.method, 'manual');
  assert.equal(res.json.status, 'processed');
  assert.equal(res.json.reversalStatus, 'none');
  now = await shop.order(order.id);
  assert.equal(now.payment_status, 'partially_refunded');
  assert.equal((await world.rzp.get('/state')).refunds.length, 0, 'nothing went to the gateway');
});

test('S-56, S-69: a shopper’s cancellation refunds what was paid online and clears the balance; a seller’s prompts the owner', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.api('PATCH', '/payment-settings', { partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
  await shop.payReady();
  const { order } = await shop.paidOrder({ mode: 'part_advance', totalPaise: 99900, advancePaise: 10000 });
  assert.equal(order.payment_status, 'advance_paid');
  await cancel(world, shop, order.id, 'shopper');
  await world.settle();
  let now = await shop.order(order.id);
  assert.equal(now.fulfilment_status, 'cancelled');
  assert.equal(now.payment_status, 'refunded', 'the advance is refunded and nothing is left for the door');
  const [refund] = await shop.refunds(order.id);
  assert.equal(Number(refund.amount_paise), 10000);
  assert.equal(refund.status, 'processed');
  assert.equal(refund.requested_by, 'job:refund-on-cancel');
  // The event again changes nothing.
  await shop.run(() => world.ctx.refunds.onCancelled(order.id));
  assert.equal((await shop.refunds(order.id)).length, 1);

  const second = await shop.paidOrder({ totalPaise: 50000 });
  await cancel(world, shop, second.order.id, 'seller');
  await world.settle();
  now = await shop.order(second.order.id);
  assert.equal(now.payment_status, 'paid', 'a seller’s cancellation waits for the owner to refund');
  assert.equal((await shop.refunds(second.order.id)).length, 0);
  const [due] = await shop.alerts('refund.due');
  assert.match(due.message, /Refund ₹500/);
});

test('one business cannot see, refund or retry another business’s payments', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 50000 });
  const refund = (await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000))).json;
  const other = await world.secondBusiness();
  assert.equal((await other.api('GET', `/orders/${order.id}/payments`)).status, 404);
  assert.equal((await other.api('GET', `/orders/${order.id}/refunds`)).status, 404);
  assert.equal((await other.api('GET', `/refunds/${refund.id}`)).status, 404);
  assert.equal((await other.api('POST', `/refunds/${refund.id}/retry`)).status, 404);
  const tried = await other.api('POST', `/orders/${order.id}/refunds`, refundBody(1000, { password: 'owner-pass-2' }));
  assert.equal(tried.status, 404);
  assert.equal((await other.api('GET', '/settlements')).json.items.length, 0);
  assert.equal((await shop.refunds(order.id)).length, 1);
});

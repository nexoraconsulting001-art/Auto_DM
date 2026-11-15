// money-7: Route's transfer.reversed for an ordinary refund is matched to that refund, not flagged as an unexplained payout
// taken back; repeated reversed events with a growing total are applied; and a reversal already recorded is never counted
// twice when the refund's own answer brings it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, refundBody } from '../../p4/payments/support.js';

async function lostRefund(world, shop, order, amountPaise) {
  // The gateway never answers (and never makes it): the refund waits as requested.
  await world.rzp.fault({ kind: 'timeout', times: 3, match: { method: 'POST', path: '/v1/payments/*/refund' } });
  const res = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(amountPaise));
  assert.ok(res.status < 300, res.text);
  await world.rzp.delete('/faults');
  const [row] = (await shop.refunds(order.id)).filter((r) => Number(r.id) === Number(res.json.id));
  assert.equal(row.status, 'requested');
  return row;
}

const reversed = (shop, payment, total) => shop.run((p) => p.applyTransfer({ paymentId: Number(payment.id), transfer: { id: payment.transfer_id, amountPaise: Number(payment.transfer_paise), amountReversedPaise: total }, type: 'transfer.reversed' }));
const processedByWebhook = (shop, payment, refund, id) => shop.run((p) => p.refunds.applyGatewayRefund({ paymentId: Number(payment.id), refund: { id, amountPaise: Number(refund.amount_paise), status: 'processed', noteRefund: Number(refund.id) }, type: 'refund.processed' }));

test('money-7: a refund finished by webhook, then Route\'s transfer.reversed, raises no false alarm, and a second one adds on', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 100000 });
  let [payment] = await shop.payments(order.id);
  assert.ok(payment.transfer_id);

  const first = await lostRefund(world, shop, order, 30000);
  await processedByWebhook(shop, payment, first, 'rfnd_hook00000001');
  assert.equal((await reversed(shop, payment, 30000)).outcome, 'processed');
  [payment] = await shop.payments(order.id);
  assert.equal(payment.needs_review, false, 'an ordinary refund is not a payout taken back');
  assert.equal(Number(payment.reversed_paise), 30000);
  assert.equal((await shop.alerts('payment.transfer_review')).length, 0);
  let [r1] = await shop.refunds(order.id);
  assert.deepEqual([r1.reversal_status, Number(r1.reversal_paise)], ['reversed', 30000]);

  const second = await lostRefund(world, shop, order, 20000);
  await processedByWebhook(shop, payment, second, 'rfnd_hook00000002');
  assert.equal((await reversed(shop, payment, 50000)).outcome, 'processed', 'a later reversed event with a larger total is applied');
  [payment] = await shop.payments(order.id);
  assert.equal(Number(payment.reversed_paise), 50000);
  assert.equal(payment.needs_review, false);
  const lines = (await shop.lines(order.id)).filter((l) => l.kind === 'transfer_reversal').map((l) => [Number(l.amount_paise), l.status]);
  assert.deepEqual(lines, [[-30000, 'ok'], [-20000, 'ok']]);
  [r1] = await shop.refunds(order.id);
  assert.equal(r1.reversal_status, 'reversed');

  // What no refund explains is still flagged.
  assert.equal((await reversed(shop, payment, 60000)).outcome, 'processed');
  [payment] = await shop.payments(order.id);
  assert.equal(payment.needs_review, true, 'Rs 100 more taken back than refunds explain');
  assert.equal((await shop.alerts('payment.transfer_review')).length, 2);
});

test('money-7: transfer.reversed before the refund\'s own answer: the reversal is counted once', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 100000 });
  let [payment] = await shop.payments(order.id);
  const refund = await lostRefund(world, shop, order, 30000);
  await reversed(shop, payment, 30000);
  [payment] = await shop.payments(order.id);
  assert.equal(Number(payment.reversed_paise), 30000);
  assert.equal(payment.needs_review, false);
  // The sweep asks again with the same key: the gateway makes the refund and answers with its reversal.
  await shop.run((p) => p.refunds.submit(Number(refund.id)));
  const [after] = await shop.refunds(order.id);
  assert.equal(after.status, 'processed');
  [payment] = await shop.payments(order.id);
  assert.equal(Number(payment.reversed_paise), 30000, 'not 60000');
  const lines = (await shop.lines(order.id)).filter((l) => l.kind === 'transfer_reversal');
  assert.equal(lines.length, 1);
  assert.equal(Number(after.reversal_paise), 30000);
});

// money-9 (the same cause, the other order of events): a part-advance order whose hold ran out is cancelled before it is
// paid, so nothing is invoiced when it is cancelled. Its advance then arrives late (S-41) and the full value is invoiced
// on a cancelled order. If the owner refunds the advance rather than bringing the order back, the balance was never
// collected and must be credited too, or 80% of the order stays invoiced and taxed though nothing was supplied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { changeOrder, changeRow } from '../../../src/modules/orders/state.js';
import { openWorld } from '../../p4/invoices-returns/support.js';

const credits = async (shop, orderId) => (await shop.invoices(orderId)).filter((i) => i.doc_type === 'credit_note');

async function latePay(world, shop, order) {
  return shop.tx(async (t) => {
    const [p] = await t.query(
      `INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, gateway_order_id, amount_paise, method) VALUES ($1, $2, 'advance', 'razorpay', 'managed', $3, $4, 'upi') RETURNING id`,
      [shop.tenant.id, order.id, `order_late${order.id}`, Number(order.advance_paise)],
    );
    await changeRow(t, 'payments', p.id, 'captured', { set: { gateway_payment_id: `pay_late${order.id}`, captured_at: new Date() } });
    await changeOrder(t, order.id, { payment: 'advance_paid', actor: 'webhook:razorpay', set: { paid_paise: Number(order.advance_paise) } });
    return p.id;
  });
}

test('money-9: a late-paid advance on a cancelled part-advance order, refunded, leaves nothing of the order invoiced', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const lamp = await shop.product({ pricePaise: 100000 });
  const order = await shop.placeOrder({ lines: [{ product: lamp }], mode: 'part_advance', advancePaise: 20000 });
  await shop.tx((tx) => changeOrder(tx, order.id, { fulfilment: 'cancelled', cancelReason: 'hold_expired', actor: 'system' }));
  await world.settle();
  assert.equal((await shop.invoices(order.id)).length, 0, 'nothing paid, nothing invoiced');
  // The stock went to someone else meanwhile, so the late payment cannot bring the order back by itself (S-41).
  await shop.sql('UPDATE products SET stock = 0 WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, lamp.id]);

  const paymentId = await latePay(world, shop, order);
  await world.settle();
  const [invoice] = await shop.invoices(order.id);
  assert.equal(Number(invoice?.total_paise), 100000, 'the advance came: the order is invoiced in full (9.13)');
  assert.equal((await shop.order(order.id)).fulfilment_status, 'cancelled', 'paid, out of stock, waiting for the owner');
  assert.equal((await credits(shop, order.id)).length, 0, 'not credited yet: the owner may still bring the order back');

  // The owner refunds the advance instead.
  const [refund] = await shop.sql(
    `INSERT INTO refunds (tenant_id, order_id, payment_id, amount_paise, method, status, requested_by, idempotency_key, processed_at)
     VALUES ($1, $2, $3, 20000, 'gateway', 'processed', 'user:1', $4, now()) RETURNING id`,
    [shop.tenant.id, order.id, paymentId, `rf-${crypto.randomUUID()}`],
  );
  await shop.inTenant(() => world.ctx.invoices.onEvent({ type: 'refund.processed', orderId: order.id, entityId: refund.id }));
  const notes = await credits(shop, order.id);
  assert.deepEqual(notes.map((n) => Number(n.total_paise)).sort((a, b) => a - b), [20000, 80000], 'the refunded advance and the balance never collected');
  assert.equal(notes.reduce((s, n) => s + Number(n.total_paise), 0), Number(invoice.total_paise), 'nothing of the order stays invoiced');
});

test('money-9: a late-paid cancelled part-advance order that is brought back gets no balance credit', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder({ lines: [{ product: await shop.product({ pricePaise: 100000 }) }], mode: 'part_advance', advancePaise: 20000 });
  await shop.tx((tx) => changeOrder(tx, order.id, { fulfilment: 'cancelled', cancelReason: 'hold_expired', actor: 'system' }));
  await world.settle();
  await latePay(world, shop, order);
  await world.settle();
  await shop.tx((tx) => changeOrder(tx, order.id, { fulfilment: 'new', actor: 'user:1', reason: 'Brought back' }));
  await world.settle();
  assert.equal((await credits(shop, order.id)).length, 0, 'the balance is still to be collected at the door');
});

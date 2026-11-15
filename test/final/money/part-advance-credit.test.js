// money-9: a part-advance order is invoiced in full when the advance is paid (PRD 9.13). If the balance is then never
// collected (the parcel came back, or the order was cancelled), a credit note takes the uncollected balance off, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { openWorld } from '../../p4/invoices-returns/support.js';

const credits = async (shop, orderId) => (await shop.invoices(orderId)).filter((i) => i.doc_type === 'credit_note');

test('money-9: a part-advance parcel that comes back gets a credit note for the balance never collected', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder({ lines: [{ product: await shop.product({ pricePaise: 100000 }) }], mode: 'part_advance', advancePaise: 20000 });
  await shop.pay(order);
  const [invoice] = await shop.invoices(order.id);
  assert.equal(Number(invoice.total_paise), 100000);
  for (const to of ['packed', 'shipped', 'rto_initiated', 'rto_delivered']) await shop.tx((tx) => changeOrder(tx, order.id, { fulfilment: to, actor: 'user:1' }));
  await world.settle();
  const notes = await credits(shop, order.id);
  assert.equal(notes.length, 1, 'one credit note for the balance');
  assert.equal(Number(notes[0].total_paise), 80000, 'Rs 800 never collected at the door');
  assert.equal(Number(notes[0].original_invoice_id), Number(invoice.id));
  assert.equal(notes[0].refund_id, null);
  // Running the listener again issues nothing more.
  await shop.inTenant(() => world.ctx.invoices.onEvent({ type: 'order.rto_delivered', orderId: order.id }));
  assert.equal((await credits(shop, order.id)).length, 1);
});

test('money-9: a cancelled part-advance order gets the balance credited, and its advance refund credited on its own', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder({ lines: [{ product: await shop.product({ pricePaise: 100000 }) }], mode: 'part_advance', advancePaise: 20000 });
  await shop.pay(order);
  await shop.tx((tx) => changeOrder(tx, order.id, { fulfilment: 'cancelled', cancelReason: 'out_of_stock', actor: 'user:1' }));
  await world.settle();
  const notes = await credits(shop, order.id);
  assert.deepEqual(notes.map((n) => Number(n.total_paise)), [80000], 'the balance; the advance is credited when it is refunded');
  const sum = notes.reduce((s, n) => s + Number(n.total_paise), 0);
  assert.ok(sum <= 100000);
});

test('money-9: a delivered part-advance order whose balance was collected gets no credit note', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder({ lines: [{ product: await shop.product({ pricePaise: 100000 }) }], mode: 'part_advance', advancePaise: 20000 });
  await shop.pay(order);
  await shop.deliver(order);
  assert.equal((await credits(shop, order.id)).length, 0);
});

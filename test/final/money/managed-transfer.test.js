// money-1: in Bhava-managed mode the seller's Route transfer is the sale less the gateway fee and its GST (PRD 9.6, S-70,
// F-113), and a courier charge taken "from the payout" really comes off the payout (9.10, PRD 3185).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorld } from '../../p4/payments/support.js';

test('S-70: a Rs 1,000 managed capture transfers Rs 1,000 minus the gateway fee to the linked account, and the statement closes at zero', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 100000 });
  await world.settle();
  const [payment] = await shop.payments(order.id);
  const fee = Number(payment.fee_paise) + Number(payment.fee_tax_paise);
  assert.equal(fee, 2360, 'the sim charges 2% and GST on it');
  assert.equal(Number(payment.transfer_paise), 100000 - fee, 'the transfer is net of the fee');
  const { transfers } = await world.rzp.get('/state');
  const mine = transfers.filter((x) => x.source === payment.gateway_payment_id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].recipient, shop.linkedAccount);
  assert.equal(mine[0].amount, 100000 - fee, 'Bhava keeps the fee it paid the gateway, and nothing else');
  assert.equal(payment.transfer_id, mine[0].id);
  assert.equal(payment.transfer_status, 'created');

  await world.rzp.post('/transfers/settle', { id: mine[0].id });
  await world.settle();
  const lines = await shop.lines(order.id);
  const sum = lines.reduce((s, l) => s + Number(l.amount_paise), 0);
  assert.deepEqual(lines.map((l) => [l.kind, Number(l.amount_paise)]), [['sale', 100000], ['gateway_fee', -2000], ['gateway_fee_tax', -360], ['transfer', 100000 - fee]]);
  assert.equal(sum - 2 * Number(lines.find((l) => l.kind === 'transfer').amount_paise), 0, 'sale - fees - payout = 0: Bhava keeps exactly the fee it paid');
});

test('money-1: a lost transfer answer is sent again without paying the seller twice', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  await world.rzp.fault({ kind: 'partial', then: 'timeout', times: 1, match: { method: 'POST', path: '/v1/payments/*/transfers' } });
  const { order } = await shop.paidOrder({ totalPaise: 50000 });
  let [payment] = await shop.payments(order.id);
  assert.equal(payment.status, 'captured');
  await shop.run((p) => p.sendTransfer(Number(payment.id)));
  [payment] = await shop.payments(order.id);
  const mine = (await world.rzp.get('/state')).transfers.filter((x) => x.source === payment.gateway_payment_id);
  assert.equal(mine.length, 1, 'one transfer, however often it is asked');
  assert.equal(mine[0].amount, 50000 - 1180);
  assert.equal(payment.transfer_id, mine[0].id);
});

test('money-1: a courier charge taken from the payout is reversed from the seller\'s transfer; a monthly-billed one is not', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 100000 });
  const [payment] = await shop.payments(order.id);
  // The courier booked the parcel on Bhava's account: Rs 85 on the statement (S-77), taken at payout (the default).
  await shop.sql(`INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref) VALUES ($1, $2, 'shipping_charge', -8500, 'shipment:901')`, [shop.tenant.id, order.id]);
  await shop.run((p) => p.takeShipping(order.id));
  await shop.run((p) => p.takeShipping(order.id)); // a repeat takes nothing more
  const [after] = await shop.payments(order.id);
  assert.equal(Number(after.reversed_paise), 8500);
  const transfer = (await world.rzp.get('/state')).transfers.find((x) => x.source === payment.gateway_payment_id);
  assert.equal(transfer.amount_reversed, 8500, 'the charge came back to Bhava from the payout');
  const lines = (await shop.lines(order.id)).filter((l) => l.kind === 'transfer_reversal');
  assert.deepEqual(lines.map((l) => [Number(l.amount_paise), l.ref]), [[-8500, 'shipment:901']]);

  // A seller billed monthly for shipping keeps the payout whole: the charge is on the bill instead.
  const second = await shop.paidOrder({ totalPaise: 50000 });
  await shop.sql(`INSERT INTO shipping_settings (tenant_id, charge_billing) VALUES ($1, 'monthly') ON CONFLICT (tenant_id) DO UPDATE SET charge_billing = 'monthly'`, [shop.tenant.id]);
  await shop.sql(`INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref) VALUES ($1, $2, 'shipping_charge', -6000, 'shipment:902')`, [shop.tenant.id, second.order.id]);
  await shop.run((p) => p.takeShipping(second.order.id));
  const [p2] = await shop.payments(second.order.id);
  assert.equal(Number(p2.reversed_paise), 0);
});

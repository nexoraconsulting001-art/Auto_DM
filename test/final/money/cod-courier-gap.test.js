// R7-MONEY-4 (M-7, part): a courier charge on Bhava's account taken "from the payout" for an order with no managed online
// payment (cash on delivery) has nothing to be taken from. Until the COD money path is decided (PRD 9.10 "to confirm"),
// it must at least be a reconciliation gap for ops, raised when it is booked and found again by the payments check,
// instead of silently never being taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorld } from '../../p4/payments/support.js';

const gapsFor = (shop, ref) => shop.sql(`SELECT kind, details FROM reconciliation_gaps WHERE tenant_id = $1 AND ref = $2`, [shop.tenant.id, ref]);

test('M-7: a courier charge on a cash-on-delivery order is a gap for ops, never silently untaken', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder({ mode: 'cod', totalPaise: 80000 });
  await shop.sql(`INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref) VALUES ($1, $2, 'shipping_charge', -7000, 'shipment:cod-1')`, [shop.tenant.id, order.id]);
  assert.deepEqual(await shop.run((p) => p.takeShipping(order.id)), [], 'nothing can be taken');
  const gaps = await gapsFor(shop, 'shipment:cod-1');
  assert.equal(gaps.length, 1, 'ops is told the charge has nothing to be taken from');
  assert.deepEqual([gaps[0].kind, gaps[0].details.reason, gaps[0].details.amountPaise], ['settlement_missing', 'shipping_uncollected', 7000]);

  // The payments check finds such a charge on its own too (here: one booked with no take attempt).
  const other = await shop.placeOrder({ mode: 'cod', totalPaise: 60000 });
  await shop.sql(`INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref, occurred_at) VALUES ($1, $2, 'shipping_charge', -5000, 'shipment:cod-2', now() - interval '1 hour')`, [shop.tenant.id, other.id]);
  await world.ctx.payments.reconcile.pendingCheck();
  assert.equal((await gapsFor(shop, 'shipment:cod-2')).length, 1);

  // A monthly-billed seller's charge is on Bhava's invoice instead: no gap.
  await shop.sql(`INSERT INTO shipping_settings (tenant_id, charge_billing) VALUES ($1, 'monthly') ON CONFLICT (tenant_id) DO UPDATE SET charge_billing = 'monthly'`, [shop.tenant.id]);
  const third = await shop.placeOrder({ mode: 'cod', totalPaise: 50000 });
  await shop.sql(`INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref) VALUES ($1, $2, 'shipping_charge', -4000, 'shipment:cod-3')`, [shop.tenant.id, third.id]);
  await shop.run((p) => p.takeShipping(third.id));
  assert.equal((await gapsFor(shop, 'shipment:cod-3')).length, 0);
});

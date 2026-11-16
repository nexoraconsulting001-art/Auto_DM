// commerce-6 (PRD 9.17): each return has its own reverse pickup. A second return on an order whose first pickup is still live
// must get its own shipment, linked to it, not be left with none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorld } from '../../p4/shipping/support.js';

test('commerce-6: a second return gets its own reverse shipment, and asking again for either finds its own', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder({});
  const shipment = await shop.ship(order);
  await shop.track(shipment.awb, 'PICKED UP');
  await shop.track(shipment.awb, 'DELIVERED');
  const mk = async () => (await shop.sql('INSERT INTO returns (tenant_id, order_id, status) VALUES ($1, $2, $3) RETURNING id', [shop.tenant.id, order.id, 'approved']))[0].id;
  const r1 = await mk();
  const r2 = await mk();
  const first = await shop.run((s) => s.bookReturn({ orderId: order.id, returnId: r1, actor: 'test:returns' }));
  const second = await shop.run((s) => s.bookReturn({ orderId: order.id, returnId: r2, actor: 'test:returns' }));
  assert.notEqual(second.id, first.id, 'the second return has its own pickup');
  const linked = (await shop.sql('SELECT id, shipment_id FROM returns WHERE tenant_id = $1 ORDER BY id', [shop.tenant.id]));
  assert.deepEqual(linked.map((r) => Number(r.shipment_id)), [Number(first.id), Number(second.id)]);
  assert.equal((await shop.run((s) => s.bookReturn({ orderId: order.id, returnId: r1, actor: 'test:returns' }))).id, first.id);
  assert.equal((await shop.run((s) => s.bookReturn({ orderId: order.id, returnId: r2, actor: 'test:returns' }))).id, second.id);
});

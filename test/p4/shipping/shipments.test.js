// "Ready to ship" (PRD 9.10): the shipment, its AWB, the pickup and the label, on the master account or the seller's own;
// failures and retries that never make a shipment twice; cancelling; the courier charge at cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeOrder, holdOrder } from '../../../src/modules/orders/state.js';
import { OWN_LOGIN, openWorld } from './support.js';

const CREATE = { method: 'POST', path: '/v1/external/orders/create/adhoc' };
const AWB = { method: 'POST', path: '/v1/external/courier/assign/awb' };
const PICKUP = { method: 'POST', path: '/v1/external/courier/generate/pickup' };
const live = (rows) => rows.filter((s) => !['cancelled', 'lost', 'rto_delivered'].includes(s.status));

test('S-77: Ready to ship in managed mode books the courier, labels the seller as shipper and puts the charge on its statement at cost', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder();
  const shipment = await shop.ship(order);
  assert.equal(shipment.mode, 'managed');
  assert.equal(shipment.kind, 'forward');
  assert.equal(shipment.status, 'pickup_scheduled', 'the pickup is booked too');
  assert.match(shipment.awb, /^SIM\d+$/);
  assert.equal(shipment.hasLabel, true);
  assert.equal(shipment.weightGrams, 500);
  assert.deepEqual([shipment.lengthCm, shipment.breadthCm, shipment.heightCm], [10, 10, 10]);
  assert.equal(shipment.codPaise, 0, 'a prepaid parcel collects nothing at the door');
  assert.equal(shipment.chargePaise, 4900);
  const url = new URL(shipment.trackingUrl);
  assert.equal(url.hostname, 'shop.test', 'the tracking link is on the seller’s own address');
  assert.match(url.pathname, /^\/track\/[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);

  const atCourier = await world.simShipment(shipment.awb);
  assert.equal(atCourier.shipper.name, 'Lamp House Dispatch');
  assert.equal(atCourier.shipper.address, '4 Mill Lane');
  assert.equal(atCourier.payment_method, 'Prepaid');
  assert.equal(atCourier.channel_order_id, order.order_number);
  assert.equal(atCourier.status, 'PICKUP SCHEDULED');

  assert.deepEqual(await shop.lines(order.id), [{ kind: 'shipping_charge', amount_paise: -4900, ref: `shipment:${shipment.id}` }], 'the courier’s charge, at cost, once');
  const label = await shop.api('GET', `/shipments/${shipment.id}/label`);
  assert.equal(label.status, 200);
  assert.match(label.json.url, /\/labels\/\d+\.pdf$/);

  // Tapping again answers with the same shipment and asks the courier for nothing new.
  const again = await shop.api('POST', `/orders/${order.id}/shipments`, {});
  assert.equal(again.status, 201);
  assert.equal(again.json.id, shipment.id);
  assert.equal(await world.creates(), 1);
  const listed = await shop.api('GET', `/orders/${order.id}/shipments`);
  assert.equal(listed.json.items.length, 1);
  assert.deepEqual(listed.json.items[0].events, []);
  assert.equal((await shop.order(order.id)).fulfilment_status, 'new', 'the order moves when the courier picks it up, not before');

  // Another business sees none of it.
  const other = await world.business();
  for (const path of [`/shipments/${shipment.id}`, `/shipments/${shipment.id}/label`, `/orders/${order.id}/shipments`]) assert.equal((await other.api('GET', path)).status, 404, path);
  assert.equal((await other.api('POST', `/shipments/${shipment.id}/cancel`)).status, 404);
  assert.equal((await other.api('POST', `/orders/${order.id}/shipments`, {})).status, 404);
  assert.equal((await other.lines(order.id)).length, 0);
});

test('S-21: cash on delivery and part-advance labels collect the order’s balance at the door', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const cod = await shop.placeOrder({ mode: 'cod' });
  const s1 = await shop.ship(cod);
  assert.equal(s1.codPaise, Number(cod.balance_paise));
  const c1 = await world.simShipment(s1.awb);
  assert.equal(c1.payment_method, 'COD');
  assert.equal(Math.round(c1.cod_amount * 100), Number(cod.balance_paise));

  const part = await shop.placeOrder({ mode: 'part_advance', advancePaise: 10000 });
  const s2 = await shop.ship(part);
  assert.equal(s2.codPaise, Number(part.total_paise) - 10000);
  assert.equal(Math.round((await world.simShipment(s2.awb)).cod_amount * 100), Number(part.balance_paise));
});

test('S-34: a product with no weight blocks the shipment by name; an unpaid, held, cancelled or another business’s order is refused', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const bell = await shop.product({ name: 'Brass bell', weightGrams: 300 });
  const runner = await shop.product({ name: 'Cotton runner XL', weightGrams: 450 });
  await shop.sql('UPDATE products SET weight_grams = NULL WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, runner.id]);
  const order = await shop.placeOrder({ lines: [{ product: bell, qty: 1 }, { product: runner, qty: 1 }] });
  const res = await shop.api('POST', `/orders/${order.id}/shipments`, {});
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'Add weight to Cotton runner XL');
  assert.equal((await shop.shipments(order.id)).length, 0);
  assert.equal(await world.creates(), 0, 'nothing reached the courier');
  for (const body of [{ weightGrams: 0 }, { weightGrams: 500001 }, { lengthCm: 0 }, { heightCm: 501 }, { weightGrams: 1.5 }, { weightGrams: '500' }]) {
    assert.equal((await shop.api('POST', `/orders/${order.id}/shipments`, body)).status, 400, JSON.stringify(body));
  }
  // No size for a product, and none typed: refused by name too.
  await shop.sql('UPDATE products SET weight_grams = 450, height_cm = NULL WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, runner.id]);
  const size = await shop.api('POST', `/orders/${order.id}/shipments`, {});
  assert.equal(size.status, 400);
  assert.match(size.json.error, /size to Cotton runner XL/);
  // With the weight and the size in place: the weights add up, and the box fits the items stacked.
  await shop.sql('UPDATE products SET height_cm = 4 WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, runner.id]);
  const shipment = await shop.ship(order);
  assert.equal(shipment.weightGrams, 750);
  assert.equal(shipment.heightCm, 14);

  const unpaid = await shop.placeOrder({ confirm: false });
  assert.equal((await shop.api('POST', `/orders/${unpaid.id}/shipments`, {})).status, 409);
  const held = await shop.placeOrder();
  await shop.inTenant(() => world.db.tx((tx) => holdOrder(tx, held.id, 'review', { actor: 'test:setup' })));
  assert.equal((await shop.api('POST', `/orders/${held.id}/shipments`, {})).status, 409);
  const cancelled = await shop.placeOrder();
  await shop.inTenant(() => world.db.tx((tx) => changeOrder(tx, cancelled.id, { fulfilment: 'cancelled', cancelReason: 'seller', actor: 'test:setup' })));
  await world.settle();
  assert.equal((await shop.api('POST', `/orders/${cancelled.id}/shipments`, {})).status, 409);
  assert.equal((await shop.api('POST', '/orders/2147483647/shipments', {})).status, 404);
  assert.equal(await world.creates(), 1);
});

test('a courier that hangs while the order is made: no second shipment, and the retry after the lease books it once', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder();
  await world.ship.fault({ kind: 'timeout', match: CREATE });
  const started = Date.now();
  const first = await shop.api('POST', `/orders/${order.id}/shipments`, {});
  assert.equal(first.status, 409, first.text);
  assert.ok(Date.now() - started < 6000, 'the request waited past the provider timeout');
  assert.match(first.json.error, /didn’t answer/);
  let [row] = await shop.shipments(order.id);
  assert.equal(row.status, 'created');
  assert.equal(row.provider_order_id, '', 'the create is claimed while its answer is unknown');

  // Tapping again straight away sends nothing: the first try may still have reached the courier.
  const second = await shop.api('POST', `/orders/${order.id}/shipments`, {});
  assert.equal(second.status, 409);
  assert.match(second.json.error, /being booked/);
  assert.equal(await world.creates(), 1);
  assert.equal((await shop.shipments(order.id)).length, 1);

  // After the lease, the worker's sweep sends it again and finishes every step; ops are told it was sent twice.
  await world.age(120_000);
  await world.resume();
  [row] = await shop.shipments(order.id);
  assert.equal(row.status, 'pickup_scheduled');
  assert.ok(row.awb);
  assert.equal(await world.creates(), 2);
  assert.equal((await world.ship.get('/state')).shipments.filter((s) => s.channel_order_id === order.order_number).length, 1, 'the hung call never reached the courier, so there is one order there');
  assert.equal((await world.opsAlerts('shipping.possible_duplicate')).length, 1);
  assert.equal(live(await shop.shipments(order.id)).length, 1);
});

test('the courier made the order but its answer was lost: the resend has an AWB on one courier order only, and ops are told', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder();
  await world.ship.fault({ kind: 'partial', then: 'server_error', match: CREATE });
  assert.equal((await shop.api('POST', `/orders/${order.id}/shipments`, {})).status, 409);
  await world.age(120_000);
  await world.resume();
  const [row] = await shop.shipments(order.id);
  assert.ok(row.awb);
  const atCourier = (await world.ship.get('/state')).shipments.filter((s) => s.channel_order_id === order.order_number);
  assert.equal(atCourier.length, 2, 'the simulator keeps both courier orders');
  assert.deepEqual(atCourier.filter((s) => s.awb_code).map((s) => s.awb_code), [row.awb], 'only one has a courier booked');
  const [alert] = await world.opsAlerts('shipping.possible_duplicate');
  assert.match(alert.message, /cancel the one with no AWB/);
  assert.doesNotMatch(alert.message, /Asha|Lake Road|9876543210/);
});

test('an AWB answer that can’t be read is asked for again on the same courier shipment, never a new one', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder();
  await world.ship.fault({ kind: 'malformed', mode: 'garbage', match: AWB });
  const res = await shop.api('POST', `/orders/${order.id}/shipments`, {});
  assert.equal(res.status, 409);
  let [row] = await shop.shipments(order.id);
  assert.ok(row.provider_shipment_id);
  assert.equal(row.awb, null);
  // Not before its backoff, then once it is due.
  await world.resume();
  assert.equal((await shop.shipments(order.id))[0].awb, null);
  await world.age(120_000);
  await world.resume();
  [row] = await shop.shipments(order.id);
  assert.equal(row.status, 'pickup_scheduled');
  assert.equal(await world.creates(), 1, 'the courier order was made once');
  assert.equal((await world.ship.calls(AWB)).length, 2);
  assert.equal((await shop.lines(order.id)).length, 1);
});

test('a pickup the courier didn’t confirm: the shipment has its AWB at once, and the pickup follows', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder();
  await world.ship.fault({ kind: 'server_error', status: 503, match: PICKUP });
  const shipment = await shop.ship(order);
  assert.equal(shipment.status, 'awb_assigned');
  assert.ok(shipment.awb);
  assert.equal(shipment.hasLabel, false);
  await world.age(120_000);
  await world.resume();
  const now = (await shop.api('GET', `/shipments/${shipment.id}`)).json;
  assert.equal(now.status, 'pickup_scheduled');
  assert.equal(now.hasLabel, true);
  assert.equal(await world.creates(), 1);
});

test('a courier that refuses the order: the shipment is closed with the reason, and a new one can be made', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder();
  await world.ship.fault({ kind: 'rate_limit', status: 422, match: CREATE });
  const res = await shop.api('POST', `/orders/${order.id}/shipments`, {});
  assert.equal(res.status, 409);
  assert.match(res.json.error, /didn’t accept/);
  assert.deepEqual((await shop.shipments(order.id)).map((s) => s.status), ['cancelled']);
  const shipment = await shop.ship(order);
  assert.ok(shipment.awb);
  assert.equal(live(await shop.shipments(order.id)).length, 1);
});

test('two taps at once make one shipment and one courier order', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder();
  const results = await Promise.all([1, 2, 3].map(() => shop.api('POST', `/orders/${order.id}/shipments`, {})));
  assert.ok(results.every((r) => r.status < 500), results.map((r) => r.status).join());
  assert.equal((await shop.shipments(order.id)).length, 1);
  assert.equal(await world.creates(), 1);
});

test('cancel before pickup calls it off at the courier and gives the charge back; after pickup it is refused', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder();
  const first = await shop.ship(order);
  const cancelled = await shop.api('POST', `/shipments/${first.id}/cancel`);
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal((await world.simShipment(first.awb)).status, 'CANCELED');
  assert.deepEqual((await shop.lines(order.id)).map((l) => [l.kind, Number(l.amount_paise)]), [['shipping_charge', -4900], ['adjustment', 4900]]);
  assert.equal((await shop.api('POST', `/shipments/${first.id}/cancel`)).status, 200, 'cancelling twice changes nothing');

  const second = await shop.ship(order);
  assert.notEqual(second.id, first.id);
  assert.equal((await world.simShipment(second.awb)).channel_order_id, `${order.order_number}-2`);
  await shop.track(second.awb, 'PICKED UP');
  const late = await shop.api('POST', `/shipments/${second.id}/cancel`);
  assert.equal(late.status, 409);
  assert.match(late.json.error, /already has this parcel/);
});

test('an order cancelled before pickup has its shipment called off at the courier', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder({ mode: 'cod' });
  const shipment = await shop.ship(order);
  await shop.inTenant(() => world.db.tx((tx) => changeOrder(tx, order.id, { fulfilment: 'cancelled', payment: 'voided', cancelReason: 'shopper', actor: 'test:setup' })));
  await world.settle();
  assert.equal((await shop.shipments(order.id))[0].status, 'cancelled');
  assert.equal((await world.simShipment(shipment.awb)).status, 'CANCELED');
});

test('bring your own: shipments run on the seller’s own account with no platform charge, and a switch applies to new ones only', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const set = await shop.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: OWN_LOGIN.email, ownPassword: OWN_LOGIN.password });
  assert.equal(set.status, 200, set.text);
  const order = await shop.placeOrder();
  const own = await shop.ship(order);
  assert.equal(own.mode, 'own');
  assert.equal((await world.simShipment(own.awb)).owner, OWN_LOGIN.email);
  assert.deepEqual(await shop.lines(order.id), [], 'on its own account the seller pays the courier itself');

  await shop.api('PATCH', '/shipping-settings', { mode: 'managed' });
  const next = await shop.placeOrder();
  const managed = await shop.ship(next);
  assert.equal(managed.mode, 'managed');
  assert.equal((await world.simShipment(managed.awb)).owner, 'sim@bhava.test');
  assert.equal((await shop.api('GET', `/shipments/${own.id}`)).json.mode, 'own', 'the earlier shipment keeps its mode');
  // Cancelling the earlier one still goes to the seller's own account.
  assert.equal((await shop.api('POST', `/shipments/${own.id}/cancel`)).status, 200);
  assert.equal((await world.simShipment(own.awb)).status, 'CANCELED');
});

test('shipping needs a pickup address first, and making shipments is a tier 3 feature', async (t) => {
  const world = await openWorld(t, { pickup: false });
  const { shop } = world;
  const order = await shop.placeOrder();
  const res = await shop.api('POST', `/orders/${order.id}/shipments`, {});
  assert.equal(res.status, 409);
  assert.match(res.json.error, /pickup address/);
  assert.equal((await shop.shipments(order.id)).length, 0);
  await world.db.platform.query(`UPDATE tenants SET plan = 't2' WHERE id = $1`, [shop.tenant.id]);
  assert.equal((await shop.api('POST', `/orders/${order.id}/shipments`, {})).status, 403);
});

// Tracking (PRD 9.10): the courier's webhook and polling, applied once, in time order, never backwards, each event routed to
// its own business; the order following its parcel; the seller's own tracking page; serviceability; the return's pickup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWN_LOGIN, openWorld } from './support.js';

const shipped = async (world, shop = world.shop, mode) => {
  const order = await shop.placeOrder(mode ? { mode } : {});
  return { order, shipment: await shop.ship(order) };
};
const fulfilment = async (shop, id) => (await shop.order(id)).fulfilment_status;

test('S-35: "delivered" arriving three times and redelivered twice is one scan, one move and one event; a late older scan changes nothing', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { order, shipment } = await shipped(world);
  await shop.track(shipment.awb, 'PICKED UP', { location: 'Pune hub' });
  assert.equal(await fulfilment(shop, order.id), 'shipped');
  await shop.track(shipment.awb, 'DELIVERED', { duplicates: 3 });
  const sent = (await world.ship.get('/webhooks')).deliveries.at(-1);
  await world.ship.post('/webhooks/redeliver', { id: sent.id, times: 2 });
  await world.settle();

  assert.equal(await fulfilment(shop, order.id), 'delivered');
  const [row] = await shop.shipments(order.id);
  assert.equal(row.status, 'delivered');
  assert.ok(row.delivered_at);
  assert.equal((await shop.scans(shipment.id)).filter((e) => e.status === 'delivered').length, 1);
  assert.equal((await shop.history(order.id)).filter((h) => h.to_status === 'delivered').length, 1);
  assert.equal((await shop.sql(`SELECT * FROM order_events WHERE tenant_id = $1 AND order_id = $2 AND type = 'order.delivered'`, [shop.tenant.id, order.id])).length, 1);
  assert.equal((await world.courierRows()).filter((r) => r.event_type === 'DELIVERED').length, 1, 'the same event is stored once however often it came');
  assert.equal((await shop.history(order.id)).at(-1).actor, 'courier:shiprocket');

  await shop.track(shipment.awb, 'IN TRANSIT', { at: '2020-01-01 10:00:00' });
  assert.equal(await fulfilment(shop, order.id), 'delivered', 'a late scan moved a delivered order back');
  const late = (await shop.scans(shipment.id)).find((e) => e.status === 'in_transit');
  assert.equal(late.applied, false, 'kept for the record, changed nothing');
});

test('out of order: "delivered" before "in transit" walks the parcel and the order forward, and the late one is a duplicate', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { order, shipment } = await shipped(world);
  await world.ship.post('/track', { awb: shipment.awb, status: 'IN TRANSIT', at: '2026-11-11 10:00:00', hold: true });
  await world.ship.post('/track', { awb: shipment.awb, status: 'DELIVERED', at: '2026-11-11 12:00:00', hold: true });
  await world.ship.post('/webhooks/flush', { order: 'reverse' });
  await world.settle();
  assert.equal((await shop.shipments(order.id))[0].status, 'delivered');
  assert.equal(await fulfilment(shop, order.id), 'delivered');
  assert.deepEqual((await shop.history(order.id)).map((h) => `${h.from_status}>${h.to_status}`), ['pending>new', 'new>shipped', 'shipped>delivered'], 'S-30: never new straight to delivered');
  assert.deepEqual((await shop.scans(shipment.id)).map((e) => e.status).sort(), ['delivered', 'in_transit']);
  const rows = await world.courierRows();
  assert.deepEqual(rows.map((r) => [r.event_type, r.status]).sort(), [['DELIVERED', 'processed'], ['IN TRANSIT', 'ignored']]);
});

test('S-35: a tracking webhook with a wrong or missing token is 401 and nothing is stored; a body that isn’t an event is refused', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { order, shipment } = await shipped(world);
  const body = { awb: shipment.awb, current_status: 'DELIVERED', current_timestamp: '2026-11-11 12:00:00' };
  assert.equal((await world.ship.post('/track', { awb: shipment.awb, status: 'DELIVERED', signature: 'bad' })).webhook.status, 401);
  assert.equal((await world.ship.post('/track', { awb: shipment.awb, status: 'DELIVERED', signature: 'none' })).webhook.status, 401);
  assert.equal((await world.hook(body, { token: '' })).status, 401);
  assert.equal((await world.hook(body, { token: null })).status, 401);
  assert.equal((await world.hook(body, { token: `${world.ship.webhookToken}x` })).status, 401);
  assert.equal((await world.hook(body, { token: 'é'.repeat(world.ship.webhookToken.length) })).status, 401);
  assert.equal((await world.hook([body])).status, 400);
  assert.equal((await world.hook('{"awb":')).status, 400);
  assert.equal((await world.hook({})).status, 200, 'the courier’s test ping gets its 200');
  await world.settle();
  assert.equal((await world.courierRows()).length, 0);
  assert.notEqual(await fulfilment(shop, order.id), 'delivered');
});

test('S-79: an event is routed by its AWB; one naming B’s AWB with A’s pickup location is stored, ignored and flagged', async (t) => {
  const world = await openWorld(t);
  const a = world.shop;
  const b = await world.business({ name: 'Brass Bazaar' });
  const { order: orderA, shipment: sa } = await shipped(world, a);
  const { order: orderB, shipment: sb } = await shipped(world, b);
  await b.track(sb.awb, 'PICKED UP');
  assert.equal(await fulfilment(b, orderB.id), 'shipped');
  assert.equal(await fulfilment(a, orderA.id), 'new', 'A’s order moved on B’s scan');
  assert.equal((await a.scans(sa.id)).length, 0);

  const aPickup = (await a.shipments(orderA.id))[0].pickup_location;
  const forged = await world.hook({ awb: sb.awb, current_status: 'DELIVERED', current_timestamp: '2026-11-11 13:00:00', order_id: orderA.order_number, pickup_location: aPickup, scans: [] });
  assert.equal(forged.status, 200);
  const otherOrder = await world.hook({ awb: sb.awb, current_status: 'DELIVERED', current_timestamp: '2026-11-11 13:05:00', sr_order_id: (await a.shipments(orderA.id))[0].provider_order_id });
  assert.equal(otherOrder.status, 200);
  const unknown = await world.hook({ awb: 'SIM999999999', current_status: 'DELIVERED', current_timestamp: '2026-11-11 13:00:00' });
  assert.equal(unknown.status, 200);
  await world.settle();

  const rows = await world.courierRows();
  const flagged = rows.filter((r) => r.security);
  assert.equal(flagged.length, 2);
  assert.ok(flagged.every((r) => r.status === 'ignored' && r.outcome === 'tenant_mismatch' && r.tenant_id === null));
  assert.equal(rows.find((r) => r.payload.awb === 'SIM999999999').outcome, 'unknown_shipment');
  assert.equal(await fulfilment(b, orderB.id), 'shipped', 'B’s order did not move on a forged event');
  assert.equal(await fulfilment(a, orderA.id), 'new');
  assert.equal((await a.shipments(orderA.id))[0].status, sa.status);
  assert.equal((await b.sql(`SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'shipping.webhook_mismatch'`, [b.tenant.id])).length, 2);
  assert.equal((await world.opsAlerts('shipping.webhook_mismatch')).length, 2);
});

test('a parcel the courier brings back: picked up, return to origin started and delivered back moves the order to returned', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { order, shipment } = await shipped(world, shop, 'cod');
  await shop.track(shipment.awb, 'PICKED UP');
  await shop.track(shipment.awb, 'UNDELIVERED');
  assert.equal((await shop.alerts('shipping.undelivered')).length, 1, 'the owner is told about a failed attempt');
  assert.doesNotMatch((await shop.alerts('shipping.undelivered'))[0].message, /Asha|Lake Road/);
  await shop.track(shipment.awb, 'RTO INITIATED');
  await shop.track(shipment.awb, 'RTO DELIVERED');
  assert.equal(await fulfilment(shop, order.id), 'rto_delivered');
  assert.equal((await shop.shipments(order.id))[0].status, 'rto_delivered');
  assert.deepEqual((await shop.history(order.id)).map((h) => h.to_status), ['new', 'shipped', 'rto_initiated', 'rto_delivered']);
});

test('polling: a parcel on the seller’s own account (no webhook to us) is tracked by looking it up, and a scan already heard is not stored again', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  // A managed parcel whose webhook did arrive: the poll finds the same scan and stores nothing new.
  const managed = await shipped(world);
  await shop.track(managed.shipment.awb, 'PICKED UP', { location: 'Pune hub' });
  const before = (await shop.scans(managed.shipment.id)).length;

  const set = await shop.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: OWN_LOGIN.email, ownPassword: OWN_LOGIN.password });
  assert.equal(set.status, 200, set.text);
  const own = await shipped(world);
  assert.equal(own.shipment.mode, 'own');
  await world.ship.post('/track', { awb: own.shipment.awb, status: 'PICKED UP', webhook: false });
  await world.ship.post('/track', { awb: own.shipment.awb, status: 'OUT FOR DELIVERY', webhook: false });
  await world.poll();
  assert.equal(await fulfilment(shop, own.order.id), 'new', 'not polled before its turn');
  await world.age(20 * 60_000);
  await world.poll();
  assert.equal((await shop.shipments(own.order.id))[0].status, 'out_for_delivery');
  assert.equal(await fulfilment(shop, own.order.id), 'out_for_delivery');
  assert.equal((await shop.scans(managed.shipment.id)).length, before, 'the webhook’s scan and the poll’s are the same scan');
  const calls = await world.ship.calls({ method: 'GET', path: '/v1/external/courier/track/awb/*' });
  assert.ok(calls.length >= 2);

  await world.age(20 * 60_000);
  await world.poll();
  assert.equal((await shop.scans(own.shipment.id)).length, 2, 'polling again stores nothing twice');
});

test('S-78: the tracking link opens the seller’s own page on its own address: where the parcel is, never who it is for', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { order, shipment } = await shipped(world);
  const path = new URL(shipment.trackingUrl).pathname;
  const packed = await shop.open(path);
  assert.equal(packed.status, 200);
  assert.match(packed.text, /Packed/);
  await shop.track(shipment.awb, 'PICKED UP', { location: 'Pune hub' });
  const page = await shop.open(path);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers.location, undefined, 'no redirect');
  assert.match(page.text, /On its way/);
  assert.match(page.text, /Pune hub/);
  assert.ok(page.text.includes('Lamp House'));
  assert.ok(page.text.includes(order.order_number));
  assert.ok(page.text.includes(shipment.awb));
  assert.doesNotMatch(page.text, /shiprocket|bhava/i);
  assert.doesNotMatch(JSON.stringify(page.headers), /shiprocket|bhava/i);
  assert.doesNotMatch(page.text, /<iframe/i);
  assert.doesNotMatch(page.text, /Asha|Lake Road|9876543210|411001/, 'the shopper’s details are not on a page a link opens');
  assert.ok(!page.text.includes(order.public_token), 'the order page’s own token is not given away');

  const other = await world.business({ name: 'Brass Bazaar' });
  const elsewhere = await other.open(path);
  assert.equal(elsewhere.status, 404);
  assert.ok(elsewhere.text.includes('Brass Bazaar'), 'B’s own branded 404');
  for (const bad of [`/track/${'x'.repeat(24)}`, `${path.slice(0, -1)}${path.endsWith('A') ? 'B' : 'A'}`, '/track/1.%00', `/track/${'z'.repeat(9)}.${'a'.repeat(22)}`]) {
    const res = await shop.open(bad);
    assert.equal(res.status, 404, bad);
    assert.doesNotMatch(res.text, /bhava/i);
  }
  await shop.track(shipment.awb, 'DELIVERED');
  assert.match((await shop.open(path)).text, /Delivered/);
});

test('S-33: serviceability says no for a PIN no courier serves, says when cash on delivery isn’t offered, and is cached', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await world.ship.post('/serviceability', { pincode: '799001', serviceable: false });
  await world.ship.post('/serviceability', { pincode: '560002', serviceable: true, cod: false });
  const none = await shop.open('/api/store/serviceability?pincode=799001');
  assert.equal(none.status, 200);
  assert.equal(none.json.serviceable, false);
  assert.match(none.json.message, /don’t deliver/);
  const noCod = await shop.open('/api/store/serviceability?pincode=560002');
  assert.deepEqual([noCod.json.serviceable, noCod.json.cod], [true, false]);
  const calls = (await world.ship.calls({ method: 'GET', path: '/v1/external/courier/serviceability' })).length;
  await shop.open('/api/store/serviceability?pincode=560002');
  assert.equal((await world.ship.calls({ method: 'GET', path: '/v1/external/courier/serviceability' })).length, calls, 'asked once, then cached');
  const bad = await shop.open('/api/store/serviceability?pincode=012345');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'Enter a 6-digit PIN code');
  assert.equal((await shop.open('/api/store/serviceability')).status, 400);
  // The console asks the same question.
  const seller = await shop.api('GET', '/shipping/serviceability?pincode=799001');
  assert.equal(seller.status, 200);
  assert.equal(seller.json.serviceable, false);
  // Checkout's own question, from inside its transaction, answers without waiting on the database behind it.
  shop.inTenant(() => world.ctx.shipping.settings.forget());
  world.ctx.shipping.serviceability.forget();
  const inside = await shop.inTenant(() => world.db.tx(async (tx) => {
    await tx.query('SELECT 1');
    const started = Date.now();
    const answer = await world.ctx.shipping.serviceable('799001');
    return { answer, ms: Date.now() - started };
  }));
  assert.ok(inside.ms < 4000, `${inside.ms} ms`);
  assert.equal(typeof inside.answer.serviceable, 'boolean');
  // Handed the transaction, it reads through it and gives the exact answer.
  shop.inTenant(() => world.ctx.shipping.settings.forget());
  world.ctx.shipping.serviceability.forget();
  const exact = await shop.inTenant(() => world.db.tx((tx) => world.ctx.shipping.serviceable('799001', tx)));
  assert.deepEqual(exact, { serviceable: false, cod: false, checked: true });
});

test('S-33: a courier that hangs or answers junk never holds a shopper up and never breaks the call', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  for (const [i, fault] of [{ kind: 'timeout' }, { kind: 'malformed', mode: 'garbage' }, { kind: 'server_error', status: 503 }].entries()) {
    await world.ship.fault({ ...fault, times: 'forever', match: { path: '/v1/external/courier/serviceability' } });
    const started = Date.now();
    const res = await shop.open(`/api/store/serviceability?pincode=56010${i}`);
    assert.ok(Date.now() - started < 5000, `${fault.kind}: ${Date.now() - started} ms`);
    assert.equal(res.status, 200, `${fault.kind}: ${res.text}`);
    assert.equal(res.json.serviceable, true, 'a courier that is down never closes the store');
    await world.ship.delete('/faults');
  }
});

test('9.17: the return’s pickup runs on the business’s courier mode, is booked once, and its scans never move the order', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { order, shipment } = await shipped(world);
  const early = await shop.run((s) => s.bookReturn({ orderId: order.id, actor: 'test:returns' }).catch((err) => err));
  assert.equal(early.code, 'conflict', 'no return pickup before delivery');
  await shop.track(shipment.awb, 'PICKED UP');
  await shop.track(shipment.awb, 'DELIVERED');
  const reverse = await shop.run((s) => s.bookReturn({ orderId: order.id, actor: 'test:returns' }));
  assert.equal(reverse.kind, 'reverse');
  assert.equal(reverse.mode, 'managed');
  assert.equal(reverse.codPaise, 0);
  assert.equal(reverse.trackingUrl, '');
  assert.ok(reverse.awb);
  assert.equal((await world.ship.calls({ method: 'POST', path: '/v1/external/orders/create/return' })).length, 1);
  const again = await shop.run((s) => s.bookReturn({ orderId: order.id, actor: 'test:returns' }));
  assert.equal(again.id, reverse.id);
  assert.equal((await world.ship.calls({ method: 'POST', path: '/v1/external/orders/create/return' })).length, 1);
  const atCourier = await world.simShipment(reverse.awb);
  assert.equal(atCourier.kind, 'reverse');
  assert.equal(atCourier.channel_order_id, `${order.order_number}-R1`);
  await shop.track(reverse.awb, 'PICKED UP');
  await shop.track(reverse.awb, 'DELIVERED');
  assert.equal((await shop.shipments(order.id)).find((s) => s.kind === 'reverse').status, 'delivered');
  assert.equal(await fulfilment(shop, order.id), 'delivered');
  assert.equal((await shop.history(order.id)).length, 3);
});

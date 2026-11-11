// PRD 9.10 (Shiprocket) and 9.12 (stock with reservations). S-34, S-35, S-39 to S-41, S-77 to S-79.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, STORE_LIMITS, SIGNATURE_HEADERS, STORE_PROVIDER_PATHS, assertBranded404, assertSellerBrandOnly, addP4Shop, buyer, hit, need, newPhone, noCrash, ok, refused, sum, textOf, unique, useP4World } from './kit.js';

const world = useP4World();
const line = (product, qty = 1, variantId = null) => ({ productId: product.id, variantId, qty });
const scans = async (shop, shipmentId) => shop.sql('SELECT * FROM shipment_events WHERE tenant_id = $1 AND shipment_id = $2 ORDER BY id', [shop.tenantId, shipmentId]);
const courierRows = async () => (await world.sql(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'shiprocket'`))[0].n;

async function paid(shop, fields = {}) {
  const product = fields.product ?? await shop.item({ pricePaise: 49900, stock: 5, ...fields.item });
  const b = buyer(world, shop);
  const row = await b.buy({ lines: [line(product, fields.qty ?? 1)], email: fields.email ?? '', address: fields.address, ...fields.order });
  return { b, product, row };
}

// ---- shipping ----

test('S-34: a product with no weight blocks the shipment, by name, and nothing reaches the courier', async () => {
  const shop = await addP4Shop(world);
  const weighed = await shop.item({ name: 'Brass bell', pricePaise: 30000, weightGrams: 300 });
  const unweighed = await shop.item({ name: 'Cotton runner XL', pricePaise: 45000, weightGrams: null });
  const b = buyer(world, shop);
  const row = await b.buy({ lines: [line(weighed), line(unweighed)] });
  const res = refused(await shop.send('POST', `/orders/${row.id}/shipments`, {}), 'Ready to ship with a product that has no weight', [400, 409, 422]);
  assert.ok(res.text.includes('Add weight to Cotton runner XL'), `The refusal does not name the product: ${res.text.slice(0, 200)}`);
  assert.ok(!res.text.includes('Add weight to Brass bell'));
  assert.equal((await shop.shipments(row.id)).length, 0);
  assert.equal((await world.ship.calls({ method: 'POST', path: '/v1/external/orders/create/adhoc' })).length, 0, 'The courier was asked to ship it anyway');
  for (const body of [{ weightGrams: 0 }, { weightGrams: -5 }, { weightGrams: 500001 }, { lengthCm: 0 }, { heightCm: 501 }, { weightGrams: 1.5 }, { weightGrams: '500' }]) {
    refused(await shop.send('POST', `/orders/${row.id}/shipments`, body), `Ready to ship with ${JSON.stringify(body)}`, [400, 409, 422]);
  }
  await shop.sql('UPDATE products SET weight_grams = 450 WHERE tenant_id = $1 AND id = $2', [shop.tenantId, unweighed.id]);
  const shipment = await shop.ship(row);
  assert.equal(shipment.weightGrams, 750, 'The parcel’s weight is not its products’ weights');
  assert.ok(shipment.awb);
});

test('S-34: an unpaid, a cancelled or another business’s order cannot be shipped, and a courier that hangs breaks nothing', async () => {
  const shop = await addP4Shop(world);
  const other = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 30000 });
  const unpaid = await shop.order((await buyer(world, shop).order({ lines: [line(product)] })).orderNumber);
  refused(await shop.send('POST', `/orders/${unpaid.id}/shipments`, {}), 'Shipping an unpaid prepaid order');
  const { row } = await paid(shop);
  refused(await other.send('POST', `/orders/${row.id}/shipments`, {}), 'Another business shipping this order', 404);
  await world.ship.fault({ kind: 'timeout', times: 1, match: { method: 'POST', path: '/v1/external/orders/create/adhoc' } });
  const started = Date.now();
  const hung = noCrash(await shop.send('POST', `/orders/${row.id}/shipments`, {}), 'Ready to ship while the courier hangs');
  assert.ok(Date.now() - started < STORE_LIMITS.providerTimeoutMs + 5000, 'The call waited past the provider timeout');
  await world.ship.fault({ kind: 'malformed', mode: 'garbage', times: 1, match: { method: 'POST', path: '/v1/external/courier/assign/awb' } });
  noCrash(await shop.send('POST', `/orders/${row.id}/shipments`, {}), 'Ready to ship while the courier answers junk');
  await world.ship.delete('/faults');
  const live = (await shop.shipments(row.id)).filter((s) => !['cancelled', 'lost'].includes(s.status));
  assert.ok(live.length <= 1, `${live.length} live shipments for one order`);
  if (hung.status === 201) assert.ok(live.length === 1);
});

test('S-35: "delivered" arriving twice leaves the order delivered and alerts once per channel', async () => {
  const shop = await addP4Shop(world);
  const email = `asha${unique()}@mail.example`;
  const { row } = await paid(shop, { email });
  const shipment = await shop.ship(row);
  await shop.track(shipment.awb, 'PICKED UP');
  await shop.orderWhen(row.order_number, (o) => o.fulfilment_status === 'shipped');
  await shop.track(shipment.awb, 'DELIVERED', { duplicates: 2 });
  const sent = (await world.ship.get('/webhooks')).deliveries.at(-1);
  await world.ship.post('/webhooks/redeliver', { id: sent.id, times: 2 });
  const order = await shop.orderWhen(row.order_number, (o) => o.fulfilment_status === 'delivered');
  assert.equal(order.fulfilment_status, 'delivered');
  await world.quiet(2500);
  const delivered = (await scans(shop, shipment.id)).filter((e) => e.status === 'delivered');
  assert.equal(delivered.length, 1, 'The same delivered scan was stored more than once');
  assert.equal((await shop.history(row.id)).filter((h) => h.to_status === 'delivered').length, 1);
  assert.equal((await shop.orderEventRows(row.id, 'order.delivered')).length, 1);
  const alerts = await shop.alertsOf(row.id, 'delivered');
  for (const channel of ['whatsapp', 'email']) assert.ok(alerts.filter((a) => a.channel === channel).length <= 1, `More than one delivered alert by ${channel}`);
  const mails = (await world.emailsTo(email)).filter((m) => /deliver/i.test(m.subject));
  assert.ok(mails.length <= 1, `${mails.length} delivered emails`);
  // An older scan arriving now changes nothing.
  await world.ship.post('/track', { awb: shipment.awb, status: 'IN TRANSIT', at: '2020-01-01 10:00:00' });
  await world.quiet(1200);
  assert.equal((await shop.order(row.order_number)).fulfilment_status, 'delivered', 'A late scan moved a delivered order back');
});

test('S-35: a tracking webhook with the wrong token gets 401 and changes nothing', async () => {
  const shop = await addP4Shop(world);
  const { row } = await paid(shop);
  const shipment = await shop.ship(row);
  const before = await courierRows();
  const out = await world.ship.post('/track', { awb: shipment.awb, status: 'DELIVERED', signature: 'bad' });
  assert.equal(out.webhook.status, 401, `A bad courier token answered ${out.webhook.status}`);
  const none = await world.ship.post('/track', { awb: shipment.awb, status: 'DELIVERED', signature: 'none' });
  assert.equal(none.webhook.status, 401);
  const hand = await hit(world, STORE_PROVIDER_PATHS.courier.path, { method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADERS.courier]: '' }, body: { awb: shipment.awb, current_status: 'DELIVERED' } });
  assert.equal(hand.status, 401);
  await world.quiet(1000);
  assert.equal(await courierRows(), before, 'A tracking webhook with a bad token was stored');
  assert.notEqual((await shop.order(row.order_number)).fulfilment_status, 'delivered');
});

test('S-77: a managed label shows the seller as shipper from its pickup address, and the charge is on its statement at cost', async () => {
  const a = await addP4Shop(world, { name: 'Leafy Corner' });
  const b = await addP4Shop(world, { name: 'Brass Bazaar' });
  await b.pickupReady({ pickupName: 'Brass Bazaar Dispatch', pickupLine1: '9 Copper Street', pickupPincode: '110006', pickupCity: 'Delhi', pickupStateCode: '07' });
  const { row } = await paid(a);
  const { row: rowB } = await paid(b);
  const shipment = await a.ship(row);
  const other = await b.ship(rowB);
  assert.equal(shipment.mode, 'managed');
  const label = await world.ship.get(`/state`);
  const mine = label.shipments.find((s) => s.awb_code === shipment.awb);
  assert.ok(mine.shipper, 'The label has no shipper');
  assert.equal(mine.shipper.name, 'Leafy Corner Dispatch', 'The label does not show the seller as shipper');
  assert.match(mine.shipper.address, /4 Mill Lane/);
  assert.equal(mine.shipper.pin_code, '411002');
  const theirs = label.shipments.find((s) => s.awb_code === other.awb);
  assert.equal(theirs.shipper.name, 'Brass Bazaar Dispatch');
  assert.notEqual(mine.pickup_location, theirs.pickup_location, 'Two sellers share one pickup location');
  assert.ok(!/bhava/i.test(JSON.stringify(mine.shipper)), 'The label names the platform');
  const freight = Math.round(Number(mine.freight_charges ?? 49) * 100);
  assert.equal(shipment.chargePaise, freight, `The charge on the shipment is ${shipment.chargePaise}, the courier charged ${freight}`);
  const lines = (await a.settlement(row.id)).filter((l) => l.kind === 'shipping_charge');
  assert.equal(lines.length, 1, 'The courier charge is not on the seller’s statement');
  assert.equal(Math.abs(Number(lines[0].amount_paise)), freight, 'The courier charge carries a markup');
  assert.equal((await b.settlement(row.id)).length, 0);
  const labelFile = need(await a.send('GET', `/shipments/${shipment.id}/label`), 200, 'The label file').json();
  assert.ok(labelFile.url);
  need(await b.send('GET', `/shipments/${shipment.id}/label`), 404, 'Another business reading this label');
});

test('S-78: the tracking link opens the seller’s own tracking page, on its domain, with no courier page or platform name', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const other = await addP4Shop(world, { name: 'Brass Bazaar' });
  const email = `asha${unique()}@mail.example`;
  const { b, row } = await paid(shop, { email });
  const shipment = await shop.ship(row);
  const url = new URL(shipment.trackingUrl);
  assert.equal(url.hostname, shop.host, 'The tracking link is not on the seller’s domain');
  assert.match(url.pathname, /^\/track\/[^/]+$/);
  assert.ok(!/shiprocket|courier\.|bhava/i.test(shipment.trackingUrl));
  await shop.track(shipment.awb, 'PICKED UP', { location: 'Pune hub' });
  await shop.orderWhen(row.order_number, (o) => o.fulfilment_status === 'shipped');
  const page = need(await b.open(url.pathname), 200, 'The tracking page');
  assertSellerBrandOnly(page, 'The tracking page');
  assert.ok(textOf(page.text).includes('Leafy Corner'));
  assert.match(textOf(page.text), /shipped|picked up|on its way|in transit/i, 'The tracking page does not show where the parcel is');
  assert.doesNotMatch(page.text, /shiprocket/i, 'The tracking page shows the courier aggregator');
  assert.doesNotMatch(page.text, /<iframe/i);
  assert.equal(page.headers.location, undefined, 'The tracking link redirects');
  assertBranded404(await other.open(url.pathname), other, 'A’s tracking page on B’s domain');
  assertBranded404(await shop.open(`/track/${'x'.repeat(24)}`), shop, 'A made-up tracking link');
  await world.quiet(1500);
  for (const m of await world.emailsTo(email)) {
    if (!/ship/i.test(m.subject)) continue;
    assert.ok(m.html.includes(url.pathname) || m.text.includes(url.pathname), 'The shipped email does not link to the seller’s tracking page');
    assert.doesNotMatch(`${m.html}${m.text}`, /shiprocket\.(co|in)|bhava/i);
  }
});

test('S-79: a tracking event for B’s AWB changes only B’s order', async () => {
  const a = await addP4Shop(world);
  const b = await addP4Shop(world);
  const { row: rowA } = await paid(a);
  const { row: rowB } = await paid(b);
  const sa = await a.ship(rowA);
  const sb = await b.ship(rowB);
  await b.track(sb.awb, 'PICKED UP');
  await b.orderWhen(rowB.order_number, (o) => o.fulfilment_status === 'shipped');
  await world.quiet(800);
  assert.equal((await a.order(rowA.order_number)).fulfilment_status, 'new', 'A’s order moved on B’s scan');
  assert.equal((await scans(a, sa.id)).length, 0);
  // B’s AWB with A’s pickup location named in the body: A still never moves.
  const [aLoc] = await a.sql('SELECT pickup_location FROM shipments WHERE tenant_id = $1 AND id = $2', [a.tenantId, sa.id]);
  const forged = await hit(world, STORE_PROVIDER_PATHS.courier.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADERS.courier]: world.ship.webhookToken },
    body: { awb: sb.awb, current_status: 'DELIVERED', shipment_status: 'DELIVERED', current_timestamp: '2030-01-01 10:00:00', order_id: rowA.order_number, pickup_location: aLoc.pickup_location, scans: [] },
  });
  noCrash(forged, 'A scan naming B’s AWB and A’s pickup');
  const unknown = await hit(world, STORE_PROVIDER_PATHS.courier.path, { method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE_HEADERS.courier]: world.ship.webhookToken }, body: { awb: 'SIM999999999', current_status: 'DELIVERED', current_timestamp: '2030-01-01 10:00:00' } });
  noCrash(unknown, 'A scan for an AWB nobody has');
  await world.quiet(1500);
  assert.equal((await a.order(rowA.order_number)).fulfilment_status, 'new', 'A’s order moved on a scan of B’s parcel');
  assert.equal((await a.shipments(rowA.id))[0].status, sa.status);
});

// ---- stock ----

test('S-39: a prepaid order unpaid for 31 minutes is cancelled and its stock returned', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 49900, stock: 2 });
  const placed = await buyer(world, shop).order({ lines: [line(product, 2)] });
  assert.deepEqual(await shop.stockOf(product.id), { stock: 2, reserved: 2 });
  refused(await buyer(world, shop).place(buyer(world, shop).checkoutBody({ lines: [line(product)] })), 'Buying what is held');
  await world.age((STORE_LIMITS.holdMinutes - 2) * MINUTE);
  await world.quiet(1000);
  assert.equal((await shop.order(placed.orderNumber)).fulfilment_status, 'pending', 'Cancelled before the hold ran out');
  await world.age(3 * MINUTE);
  const order = await shop.orderWhen(placed.orderNumber, (o) => o.fulfilment_status === 'cancelled');
  assert.equal(order.fulfilment_status, 'cancelled');
  assert.equal(order.cancel_reason, 'hold_expired');
  assert.deepEqual(await shop.stockOf(product.id), { stock: 2, reserved: 0 });
  assert.ok((await shop.reservations(order.id)).every((r) => r.status === 'released'));
  ok(await buyer(world, shop).place(buyer(world, shop).checkoutBody({ lines: [line(product, 2)] })), 'Buying the released stock');
});

test('S-39: the owner’s own hold time applies, and a COD order is never cancelled by a hold', async () => {
  const shop = await addP4Shop(world);
  await shop.payOptions({ holdMinutes: 10 });
  await shop.codOn();
  const product = await shop.item({ pricePaise: 49900, stock: 5 });
  const prepaid = await buyer(world, shop).order({ lines: [line(product)] });
  const b = buyer(world, shop);
  await b.signIn();
  const cod = await b.orderCod({ lines: [line(product)] });
  const held = await shop.order(prepaid.orderNumber);
  assert.ok(Math.abs(new Date(held.hold_expires_at) - new Date(held.created_at) - 10 * MINUTE) < 5000, 'The hold ignores the owner’s setting');
  await world.age(11 * MINUTE);
  await shop.orderWhen(prepaid.orderNumber, (o) => o.fulfilment_status === 'cancelled');
  assert.equal((await shop.order(prepaid.orderNumber)).fulfilment_status, 'cancelled');
  await world.age(60 * MINUTE);
  await world.quiet(1000);
  const codRow = await shop.order(cod.orderNumber);
  assert.equal(codRow.fulfilment_status, 'new', 'A COD order was cancelled by the hold');
  assert.equal(Number((await shop.stockOf(product.id)).stock), 4, 'A COD order does not keep its stock');
});

test('S-40: size M has none and L has three: M shows sold out, L can be ordered', async () => {
  const shop = await addP4Shop(world);
  const tee = await shop.item({ name: 'Linen shirt', pricePaise: 120000, options: [{ name: 'Size', values: ['M', 'L'] }], variants: [{ optionValues: ['M'], pricePaise: 120000, sku: `M-${unique()}` }, { optionValues: ['L'], pricePaise: 120000, sku: `L-${unique()}` }] });
  const [m, l] = [tee.variants.find((v) => v.optionValues?.[0] === 'M') ?? tee.variants[0], tee.variants.find((v) => v.optionValues?.[0] === 'L') ?? tee.variants[1]];
  need(await shop.send('POST', '/inventory/adjust', { productId: tee.id, variantId: m.id, stock: 0 }), 200, 'Setting M to 0');
  need(await shop.send('POST', '/inventory/adjust', { productId: tee.id, variantId: l.id, stock: 3 }), 200, 'Setting L to 3');
  const list = need(await shop.send('GET', `/inventory?search=${encodeURIComponent('Linen shirt')}`), 200, 'The stock list').json().items;
  assert.equal(list.find((x) => x.variantId === m.id).available, 0);
  assert.equal(list.find((x) => x.variantId === l.id).available, 3);
  const page = need(await shop.open(`/p/${tee.slug}`), 200, 'The product page');
  assert.match(textOf(page.text), /sold out/i, 'The product page does not show M sold out');
  const b = buyer(world, shop);
  const quote = ok(await b.quote({ lines: [line(tee, 1, m.id), line(tee, 1, l.id)] }), 'Quoting both').data;
  assert.equal(quote.lines.find((x) => x.variantId === m.id).state, 'sold_out');
  assert.equal(quote.lines.find((x) => x.variantId === l.id).state, 'ok');
  refused(await b.place(b.checkoutBody({ lines: [line(tee, 1, m.id)] })), 'Ordering M');
  ok(await b.place(b.checkoutBody({ lines: [line(tee, 2, l.id)] })), 'Ordering two L');
  assert.deepEqual(await shop.variantStock(l.id), { stock: 3, reserved: 2 });
  assert.deepEqual(await shop.variantStock(m.id), { stock: 0, reserved: 0 });
  const second = buyer(world, shop);
  refused(await second.place(second.checkoutBody({ lines: [line(tee, 2, l.id)] })), 'Two more L with one left');
  refused(await shop.send('POST', '/inventory/adjust', { productId: tee.id, variantId: l.id, delta: -5 }), 'Taking stock below zero', [400, 409, 422]);
  refused(await shop.send('POST', '/inventory/adjust', { productId: tee.id, variantId: l.id, stock: 1 }), 'Setting stock below what orders hold', [400, 409, 422]);
  const other = await addP4Shop(world);
  refused(await other.send('POST', '/inventory/adjust', { productId: tee.id, variantId: l.id, stock: 100 }), 'Another business setting this stock', [400, 404]);
  assert.deepEqual(await shop.variantStock(l.id), { stock: 3, reserved: 2 });
});

test('S-41: paid after the hold ran out with the stock gone: flagged "Paid, out of stock" and the owner prompted', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 49900, stock: 1 });
  const late = buyer(world, shop);
  const placed = await late.order({ lines: [line(product)] });
  await world.age((STORE_LIMITS.holdMinutes + 1) * MINUTE);
  await shop.orderWhen(placed.orderNumber, (o) => o.fulfilment_status === 'cancelled');
  const quick = buyer(world, shop);
  await quick.buy({ lines: [line(product)] });
  assert.deepEqual(await shop.stockOf(product.id), { stock: 0, reserved: 0 });
  const alertsBefore = (await shop.ownerAlerts()).length;
  await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, webhook: true });
  const order = await shop.orderWhen(placed.orderNumber, (o) => o.hold_reason === 'paid_out_of_stock');
  assert.equal(order.hold_reason, 'paid_out_of_stock', 'The late payment is not flagged');
  assert.equal(order.payment_status, 'paid');
  assert.equal(order.fulfilment_status, 'cancelled');
  const detail = await shop.orderApi(order.id);
  assert.equal(detail.holdReason, 'paid_out_of_stock');
  assert.ok((await shop.ownerAlerts()).length > alertsBefore, 'The owner is not prompted');
  assert.deepEqual(await shop.stockOf(product.id), { stock: 0, reserved: 0 }, 'A late payment took stock that is not there');
  refused(await shop.send('POST', `/orders/${order.id}/reinstate`), 'Reinstating with no stock', [409, 422]);
  need(await shop.send('POST', '/inventory/adjust', { productId: product.id, stock: 1 }), 200, 'New stock arrives');
  const back = need(await shop.send('POST', `/orders/${order.id}/reinstate`), 200, 'Reinstating').json();
  assert.equal(back.fulfilmentStatus, 'new');
  assert.equal((await shop.order(placed.orderNumber)).fulfilment_status, 'new');
  const fresh = await shop.stockOf(product.id);
  assert.equal(Number(fresh.stock) - Number(fresh.reserved), 0, 'The reinstated order does not hold the new unit');
  assert.ok(sum(await shop.history(order.id), () => 1) >= 3);
});

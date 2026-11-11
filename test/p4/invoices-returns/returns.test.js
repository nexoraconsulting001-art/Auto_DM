// PRD 9.17: returns through the return machine, with proof in private storage, the reverse pickup on the forward courier
// mode, stock back once and only for good items, and the owner's refund closing the return with its credit note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WINDOW_QUEUE, returnOption, returnsFor } from '../../../src/modules/returns/index.js';
import { openWorld, photo, raw, video } from './support.js';

/** A shop with returns on and a shopper whose order was delivered. */
async function delivered(world, { qty = 1, stock = 5, mode = 'cod', settings = {}, pricePaise = 99900 } = {}) {
  const { shop } = world;
  await shop.returnsOn(settings);
  await shop.shippingReady();
  const product = await shop.product({ pricePaise, stock });
  const shopper = await shop.shopper();
  const order = await shop.placeOrder({ lines: [{ product, qty }], mode, shopperId: shopper.id });
  await shop.pay(order);
  const row = await shop.deliver(order);
  const [item] = await shop.sql('SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2', [shop.tenant.id, order.id]);
  return { product, shopper, order: row, item };
}

/** Moves an order's delivery back in time, as if that many days had passed. */
const daysAgo = (world, order, days) => world.db.platform.tx(async (tx) => {
  await tx.exec('ALTER TABLE orders DISABLE TRIGGER USER');
  await tx.query(`UPDATE orders SET delivered_at = now() - make_interval(days => $2) WHERE id = $1`, [order.id, days]);
  await tx.exec('ALTER TABLE orders ENABLE TRIGGER USER');
});

test('S-57: the return form opens inside the window and not after it, and a request after the window is refused', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order, item } = await delivered(world, { settings: { windowDays: 7 } });
  const page = await shopper.page(`/account/orders/${order.order_number}/return`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<form id="return-form"/);
  assert.match(page.text, /Add a photo or video of the item/, 'The page does not block a request with no proof');
  assert.match(page.text, /<meta name="shopper-csrf" content="[^"]+">/);
  assert.doesNotMatch(page.text, /bhava/i, 'The buyer page names the platform');
  const option = () => shop.inTenant(async () => returnOption(world.ctx, await shop.order(order.id)));
  assert.equal(await option(), `/account/orders/${order.order_number}/return`);
  await daysAgo(world, order, 10);
  assert.equal(await option(), null, 'The account would still offer a return after the window');
  const late = await shopper.page(`/account/orders/${order.order_number}/return`);
  assert.equal(late.status, 404);
  assert.doesNotMatch(late.text, /<form/i);
  assert.match(late.text, /return window for this order has closed/);
  const asked = await shopper.askReturn(order.order_number, { items: [{ orderItemId: item.id, qty: 1 }], files: [await photo()] });
  assert.equal(asked.status, 409);
  assert.equal((await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenant.id])).length, 0);
  // Signed out, the page asks for sign-in.
  const guest = await raw(world.port, `/account/orders/${order.order_number}/return`, { host: shop.host });
  assert.equal(guest.status, 303);
  assert.match(guest.headers.location, /^\/login\?next=/);
});

test('S-57: returns off, an ineligible category, an undelivered order, too many, another order’s line, or another shopper are refused', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order, item, product } = await delivered(world);
  const ask = (who, number, items) => who.askReturn(number, { items, files: [video()] });
  await shop.api('PATCH', '/return-settings', { enabled: false });
  assert.equal((await ask(shopper, order.order_number, [{ orderItemId: item.id, qty: 1 }])).status, 409, 'Returns off');
  const [cat] = await shop.sql(`INSERT INTO categories (tenant_id, name, slug) VALUES ($1, 'Returnable', 'returnable') RETURNING id`, [shop.tenant.id]);
  await shop.returnsOn({ eligibleCategoryIds: [cat.id] });
  const outside = await ask(shopper, order.order_number, [{ orderItemId: item.id, qty: 1 }]);
  assert.equal(outside.status, 409, 'A product outside the eligible categories');
  await shop.returnsOn({ eligibleCategoryIds: [] });
  const fresh = await shop.placeOrder({ lines: [{ product }], mode: 'cod', shopperId: shopper.id });
  await shop.pay(fresh);
  const [freshItem] = await shop.sql('SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2', [shop.tenant.id, fresh.id]);
  assert.equal((await ask(shopper, fresh.order_number, [{ orderItemId: freshItem.id, qty: 1 }])).status, 409, 'Not delivered');
  assert.equal((await ask(shopper, order.order_number, [{ orderItemId: item.id, qty: 2 }])).status, 400, 'More than was bought');
  assert.equal((await ask(shopper, order.order_number, [{ orderItemId: freshItem.id, qty: 1 }])).status, 400, 'Another order’s line');
  for (const items of [[], [{ orderItemId: item.id, qty: 0 }], [{ orderItemId: item.id, qty: 1, pricePaise: 1 }], [{ orderItemId: item.id, qty: 1 }, { orderItemId: item.id, qty: 1 }], 'nonsense']) {
    const res = await shopper.askReturn(order.order_number, { items, files: [video()] });
    assert.equal(res.status, 400, `items ${JSON.stringify(items)} answered ${res.status}`);
  }
  const stranger = await shop.shopper();
  assert.equal((await ask(stranger, order.order_number, [{ orderItemId: item.id, qty: 1 }])).status, 404, 'Another shopper');
  const other = await world.secondBusiness();
  const elsewhere = await other.shopper();
  const res = await raw(world.port, `/api/store/orders/${order.order_number}/returns`, { method: 'POST', host: other.host, headers: { cookie: shopper.cookie, 'x-shopper-csrf': shopper.csrf, 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--\r\n' });
  assert.ok([401, 403, 404].includes(res.status), `A session of this store at another store answered ${res.status}`);
  assert.equal((await ask(elsewhere, order.order_number, [{ orderItemId: item.id, qty: 1 }])).status, 404);
  const noSession = await raw(world.port, `/api/store/orders/${order.order_number}/returns`, { method: 'POST', host: shop.host, headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--\r\n' });
  assert.equal(noSession.status, 401);
  const json = await raw(world.port, `/api/store/orders/${order.order_number}/returns`, { method: 'POST', host: shop.host, headers: { cookie: shopper.cookie, 'x-shopper-csrf': shopper.csrf }, body: { items: [] } });
  assert.equal(json.status, 415);
  const forged = await raw(world.port, `/api/store/orders/${order.order_number}/returns`, { method: 'POST', host: shop.host, headers: { cookie: shopper.cookie, 'x-shopper-csrf': 'wrong', 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--\r\n' });
  assert.equal(forged.status, 403, 'A request without the session’s CSRF token');
  assert.equal((await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenant.id])).length, 0);
});

test('S-80: no photo or video is refused with "Add a photo or video of the item"; fakes and pages are refused; proof is stored privately and cleaned', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order, item } = await delivered(world, { settings: { proof: 'either' } });
  const items = [{ orderItemId: item.id, qty: 1 }];
  const none = await shopper.askReturn(order.order_number, { items });
  assert.equal(none.status, 400);
  assert.equal(none.json.error, 'Add a photo or video of the item');
  assert.equal(none.json.fields.proof, 'Add a photo or video of the item');
  const fake = await shopper.askReturn(order.order_number, { items, files: [{ filename: 'item.png', type: 'image/png', data: Buffer.from('this is not a picture at all') }] });
  assert.equal(fake.status, 400);
  const page = await shopper.askReturn(order.order_number, { items, files: [{ filename: 'x.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') }] });
  assert.equal(page.status, 400);
  const disguised = await shopper.askReturn(order.order_number, { items, files: [{ ...(await photo()), type: 'text/html' }] });
  assert.equal(disguised.status, 400, 'A photo the browser calls a page');
  const tooMany = await shopper.askReturn(order.order_number, { items, files: [video(), video(), video(), video(), video()] });
  assert.equal(tooMany.status, 400);
  assert.equal((await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenant.id])).length, 0);

  const made = await shopper.askReturn(order.order_number, { items, files: [await photo({ note: 'secret-place-42' })] });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual(Object.keys(made.json).sort(), ['id', 'items', 'orderNumber', 'status']);
  assert.equal(made.json.status, 'requested');
  const [proof] = await shop.sql('SELECT * FROM return_proofs WHERE tenant_id = $1', [shop.tenant.id]);
  assert.equal(proof.kind, 'photo');
  assert.equal(proof.content_type, 'image/webp', 'The photo was stored as it arrived');
  assert.match(proof.file_key, new RegExp(`^t/${shop.tenant.id}/returns/[0-9a-f-]{36}\\.webp$`));
  const bytes = await world.ctx.platform.storage.get(proof.file_key);
  assert.ok(bytes && !bytes.toString('latin1').includes('secret-place-42'), 'The photo kept its metadata');
  assert.equal((await raw(world.port, `/media/${proof.file_key}`, { host: shop.host })).status, 404);
  const alerts = await shop.sql(`SELECT * FROM alerts WHERE tenant_id = $1 AND kind = 'return.requested'`, [shop.tenant.id]);
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(alerts[0].message, /Asha|\+91/, 'The alert names the shopper');
  const events = await shop.sql(`SELECT type FROM order_events WHERE tenant_id = $1 AND order_id = $2 AND entity = 'return'`, [shop.tenant.id, order.id]);
  assert.deepEqual(events.map((e) => e.type), ['return.requested']);
  // The unit is asked for already: a second request for it is refused.
  assert.equal((await shopper.askReturn(order.order_number, { items, files: [video()] })).status, 409);
});

test('S-80: when the owner asks for a video a photo is not enough, and the other way round', async (t) => {
  const world = await openWorld(t);
  const { shopper, order, item } = await delivered(world, { qty: 2, settings: { proof: 'video' } });
  const items = [{ orderItemId: item.id, qty: 1 }];
  const photoOnly = await shopper.askReturn(order.order_number, { items, files: [await photo()] });
  assert.equal(photoOnly.status, 400);
  assert.equal(photoOnly.json.error, 'Add a short video of the item');
  assert.equal((await shopper.askReturn(order.order_number, { items, files: [video()] })).status, 201);
  await world.shop.returnsOn({ proof: 'photo' });
  assert.equal((await shopper.askReturn(order.order_number, { items, files: [video()] })).json.error, 'Add a photo of the item');
  assert.equal((await shopper.askReturn(order.order_number, { items, files: [await photo()] })).status, 201);
});

test('the owner and order staff see the proof by a short-lived signed link; others see nothing', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order, item } = await delivered(world);
  const made = await shopper.askReturn(order.order_number, { items: [{ orderItemId: item.id, qty: 1 }], reason: 'Torn', files: [await photo(), video()] });
  const seen = await shop.api('GET', `/returns/${made.json.id}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.json.reason, 'Torn');
  assert.deepEqual(seen.json.items.map((i) => i.qty), [1]);
  assert.equal(seen.json.proofs.length, 2);
  const [first] = seen.json.proofs;
  const url = new URL(first.fileUrl, 'http://x');
  assert.equal(url.pathname, `/returns/proofs/${first.id}`);
  const open = (path, token, host = shop.host) => raw(world.port, path, { host, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const file = await open(first.fileUrl, shop.token);
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'image/webp');
  assert.match(file.headers['content-security-policy'], /sandbox/);
  assert.equal((await open(first.fileUrl, null)).status, 401);
  assert.equal((await open(`${url.pathname}?exp=${url.searchParams.get('exp')}&sig=${'A'.repeat(43)}`, shop.token)).status, 403, 'A forged link');
  assert.equal((await open(`${url.pathname}?exp=${Math.floor(Date.now() / 1000) - 5}&sig=${url.searchParams.get('sig')}`, shop.token)).status, 403, 'An expired link');
  const catalogStaff = await shop.member('staff', { permissions: ['catalog'] });
  assert.equal((await shop.api('GET', `/returns/${made.json.id}`, undefined, { as: catalogStaff.token })).status, 403);
  assert.equal((await open(first.fileUrl, catalogStaff.token)).status, 403);
  const orderStaff = await shop.member('staff', { permissions: ['orders'] });
  assert.equal((await open(first.fileUrl, orderStaff.token)).status, 200);
  const other = await world.secondBusiness();
  assert.equal((await other.api('GET', `/returns/${made.json.id}`)).status, 404);
  assert.equal((await open(first.fileUrl, other.token, other.host)).status, 403, 'Another business’s owner opening the proof');
  assert.deepEqual((await other.api('GET', '/returns')).json.items, []);
  const listed = await shop.api('GET', '/returns?status=requested');
  assert.deepEqual(listed.json.items.map((r) => r.id), [made.json.id]);
  // The shopper's own pages never show where the proof is kept.
  const [proof] = await shop.sql('SELECT file_key FROM return_proofs WHERE tenant_id = $1 LIMIT 1', [shop.tenant.id]);
  assert.ok(!(await shopper.page(`/account/orders/${order.order_number}`)).text.includes(proof.file_key));
});

test('S-58: approved, picked up on the forward courier mode, received damaged: refunded, credit note for the returned unit, stock unchanged', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.invoiceSettings({ gstin: '27ABCDE1234F1Z5' });
  await shop.shippingReady();
  const { shopper, order, item, product } = await delivered(world, { qty: 2, stock: 5 });
  const stockBefore = (await shop.stockOf(product.id)).stock;
  const made = await shopper.askReturn(order.order_number, { items: [{ orderItemId: item.id, qty: 1 }], files: [await photo()] });
  const id = made.json.id;
  const approved = await shop.api('POST', `/returns/${id}/approve`);
  assert.equal(approved.status, 200, approved.text);
  assert.ok(approved.json.shipmentId, 'Approving did not book the reverse pickup');
  assert.equal(approved.json.status, 'pickup_scheduled');
  const [reverse] = await shop.sql(`SELECT * FROM shipments WHERE tenant_id = $1 AND order_id = $2 AND kind = 'reverse'`, [shop.tenant.id, order.id]);
  assert.equal(reverse.mode, 'managed');
  assert.equal(reverse.status, 'pickup_scheduled');
  assert.match(reverse.awb, /^SIM/);
  const simState = await world.ship.get('/state');
  assert.equal(simState.shipments.filter((s) => s.kind === 'reverse').length, 1, 'The courier has no return order');
  assert.equal((await shop.api('POST', `/returns/${id}/approve`)).status, 409, 'Approved twice');

  await shop.track(reverse.id, 'picked_up', 'in_transit');
  assert.equal((await shop.returnRow(id)).status, 'picked_up');
  await shop.track(reverse.id, 'delivered');
  const arrived = await shop.returnRow(id);
  assert.equal(arrived.status, 'received', 'The parcel back with the seller is not received');
  assert.equal(arrived.condition, null, 'Received before the seller looked at it');

  const received = await shop.api('POST', `/returns/${id}/receive`, { condition: 'not_restockable' });
  assert.equal(received.status, 200, received.text);
  assert.equal(received.json.restocked, false);
  assert.equal(received.json.condition, 'not_restockable');
  await world.settle();
  assert.equal((await shop.stockOf(product.id)).stock, stockBefore, 'A not-restockable item went back into stock');
  assert.equal((await shop.api('POST', `/returns/${id}/receive`, { condition: 'good' })).status, 409, 'Received again as good');
  assert.equal((await shop.api('POST', `/returns/${id}/close`, { resolution: 'refund' })).status, 409, 'Closed as refunded with no refund');

  // The owner refunds it, naming the return: the refund closes it and the credit note is for the returned unit.
  await shop.refundByHand(order, Number(item.price_paise), { returnId: id });
  await world.settle();
  const done = await shop.returnRow(id);
  assert.equal(done.status, 'refunded');
  assert.ok(done.refund_id, 'The refund was not linked to the return');
  const [note] = (await shop.invoices(order.id)).filter((i) => i.doc_type === 'credit_note');
  assert.equal(Number(note.total_paise), Number(item.price_paise));
  assert.deepEqual(note.lines.map((l) => [l.orderItemId, l.qty, l.grossPaise]), [[item.id, 1, Number(item.price_paise)]]);
  assert.equal((await shop.stockOf(product.id)).stock, stockBefore);
  const types = (await shop.sql(`SELECT type FROM order_events WHERE tenant_id = $1 AND order_id = $2 AND entity = 'return' ORDER BY id`, [shop.tenant.id, order.id])).map((e) => e.type);
  assert.deepEqual(types, ['return.requested', 'return.approved', 'return.pickup_scheduled', 'return.picked_up', 'return.received', 'return.refunded']);
});

test('S-58: a good return goes back into stock exactly once, however often it is heard, and can be closed as an exchange', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order, item, product } = await delivered(world, { stock: 5 });
  const before = (await shop.stockOf(product.id)).stock;
  const made = await shopper.askReturn(order.order_number, { items: [{ orderItemId: item.id, qty: 1 }], resolution: 'exchange', files: [await photo()] });
  const id = made.json.id;
  assert.equal((await shop.api('POST', `/returns/${id}/receive`, { condition: 'good' })).status, 409, 'Received before it was approved');
  await shop.api('POST', `/returns/${id}/approve`);
  const received = await shop.api('POST', `/returns/${id}/receive`, { condition: 'good' });
  assert.equal(received.status, 200);
  assert.equal(received.json.restocked, true);
  await world.settle();
  // The inventory listener hears return.received too; and the courier's late "delivered" changes nothing.
  const ret = await shop.returnRow(id);
  await shop.track(ret.shipment_id, 'picked_up', 'delivered');
  await world.settle();
  assert.equal((await shop.stockOf(product.id)).stock, before + 1, 'A good return did not restock exactly once');
  const moves = await shop.sql(`SELECT * FROM stock_movements WHERE tenant_id = $1 AND reason = 'return'`, [shop.tenant.id]);
  assert.equal(moves.length, 1);
  const closed = await shop.api('POST', `/returns/${id}/close`, { resolution: 'exchange' });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.status, 'exchanged');
  assert.equal((await shop.api('POST', `/returns/${id}/close`, { resolution: 'refund' })).status, 409, 'Closed twice two ways');
});

test('a declined return says why, takes no stock or pickup, and frees the unit for another request', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order, item } = await delivered(world);
  const made = await shopper.askReturn(order.order_number, { items: [{ orderItemId: item.id, qty: 1 }], files: [await photo()] });
  assert.equal((await shop.api('POST', `/returns/${made.json.id}/decline`, { note: '' })).status, 400, 'Declined without a reason');
  const declined = await shop.api('POST', `/returns/${made.json.id}/decline`, { note: 'The tag was removed' });
  assert.equal(declined.status, 200);
  assert.equal(declined.json.status, 'rejected');
  const row = await shop.returnRow(made.json.id);
  assert.equal(row.decline_note, 'The tag was removed');
  assert.match(row.decided_by, /^user:\d+$/);
  assert.equal(row.shipment_id, null);
  assert.equal((await shop.api('POST', `/returns/${made.json.id}/approve`)).status, 409);
  assert.equal((await shop.api('POST', `/returns/${made.json.id}/receive`, { condition: 'good' })).status, 409);
  assert.equal((await shopper.askReturn(order.order_number, { items: [{ orderItemId: item.id, qty: 1 }], files: [await photo()] })).status, 201);
  const audit = await shop.sql(`SELECT action, details FROM audit_log WHERE tenant_id = $1 AND action LIKE 'return.%'`, [shop.tenant.id]);
  assert.deepEqual(audit.map((a) => a.action), ['return.decline']);
  assert.doesNotMatch(JSON.stringify(audit), /tag was removed/, 'The audit row copies the note');
});

test('a pickup the courier refuses leaves the return approved with its parcel, tells the owner, and approving again retries', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order, item } = await delivered(world);
  const made = await shopper.askReturn(order.order_number, { items: [{ orderItemId: item.id, qty: 1 }], files: [await photo()] });
  await world.ship.fault({ kind: 'server_error', match: { method: 'POST', path: '/v1/external/courier/assign/awb' }, times: 1 });
  const first = await shop.api('POST', `/returns/${made.json.id}/approve`);
  assert.equal(first.status, 200);
  assert.equal(first.json.status, 'approved');
  assert.ok(first.json.shipmentId);
  const alerts = await shop.sql(`SELECT * FROM alerts WHERE tenant_id = $1 AND kind = 'return.pickup_failed'`, [shop.tenant.id]);
  assert.equal(alerts.length, 1);
  // The AWB this time, but the courier refuses the pickup request: still approved, the parcel has its AWB.
  await world.ship.fault({ kind: 'server_error', match: { method: 'POST', path: '/v1/external/courier/generate/pickup' }, times: 1 });
  const second = await shop.api('POST', `/returns/${made.json.id}/approve`);
  assert.equal(second.json.status, 'approved');
  const [parcel] = await shop.sql('SELECT * FROM shipments WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, first.json.shipmentId]);
  assert.equal(parcel.status, 'awb_assigned');
  const again = await shop.api('POST', `/returns/${made.json.id}/approve`);
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'pickup_scheduled');
  assert.equal(again.json.shipmentId, first.json.shipmentId, 'Retrying made a second parcel');
  const [after] = await shop.sql('SELECT * FROM shipments WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, first.json.shipmentId]);
  assert.equal(after.awb, parcel.awb, 'Retrying took a second AWB');
  assert.equal(after.status, 'pickup_scheduled');
  const reverse = (await world.ship.get('/state')).shipments.filter((s) => s.kind === 'reverse');
  assert.equal(reverse.length, 1, 'Retrying made a second return order at the courier');
  assert.equal((await shop.api('POST', `/returns/${made.json.id}/approve`)).status, 409, 'Approved once booked');
});

test('two requests for the last unit at the same moment make one return', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order, item } = await delivered(world);
  const files = [await photo()];
  const answers = await Promise.all([0, 1, 2].map(() => shopper.askReturn(order.order_number, { items: [{ orderItemId: item.id, qty: 1 }], files })));
  assert.deepEqual(answers.map((a) => a.status).sort(), [201, 409, 409]);
  assert.equal((await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenant.id])).length, 1);
  const stored = await shop.sql('SELECT * FROM return_proofs WHERE tenant_id = $1', [shop.tenant.id]);
  assert.equal(stored.length, 1, 'A refused request kept its proof');
});

test('return settings: managers set them, only this business’s categories, and the window closing is told once per order', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const other = await world.secondBusiness();
  const [theirs] = await other.sql(`INSERT INTO categories (tenant_id, name, slug) VALUES ($1, 'Theirs', 'theirs') RETURNING id`, [other.tenant.id]);
  assert.equal((await shop.api('PATCH', '/return-settings', { enabled: true, eligibleCategoryIds: [theirs.id] })).status, 400, 'Another business’s category');
  assert.equal((await shop.api('PATCH', '/return-settings', { windowDays: 91 })).status, 400);
  const manager = await shop.member('manager');
  const saved = await shop.api('PATCH', '/return-settings', { enabled: true, windowDays: 3, proof: 'photo' }, { as: manager.token });
  assert.deepEqual(saved.json, { enabled: true, windowDays: 3, eligibleCategoryIds: [], proof: 'photo' });
  const staff = await shop.member('staff', { permissions: ['orders'] });
  assert.equal((await shop.api('PATCH', '/return-settings', { windowDays: 5 }, { as: staff.token })).status, 403);
  assert.equal((await other.api('GET', '/return-settings')).json.enabled, false);

  const { order } = await delivered(world, { settings: { windowDays: 3 } });
  const run = () => shop.inTenant(() => returnsFor(world.ctx).closeWindows());
  await run();
  const told = () => shop.sql(`SELECT * FROM order_events WHERE tenant_id = $1 AND order_id = $2 AND type = 'order.return_window_closed'`, [shop.tenant.id, order.id]);
  assert.equal((await told()).length, 0, 'The window closed on delivery');
  await daysAgo(world, order, 4);
  await run();
  await run();
  assert.equal((await told()).length, 1);
  assert.equal(typeof WINDOW_QUEUE, 'string');
});

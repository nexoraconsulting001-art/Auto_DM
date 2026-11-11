// Orders admin and statuses (PRD 9.9) and the shopper's cancel (9.17): only allowed moves, cancel before shipment with stock
// back and a refund prompt, one timeline for web and app, filters, the CSV file, and one business never sees another's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login } from '../../helpers.js';
import {
  hit, markPaid, orderByNumber, otherStore, ownerToken, payments, place, placeBody, product, q, shopper, stockOf, storeApp,
} from './support.js';

async function paidOrder(app, { stock = 3, qty = 1, pricePaise = 50000 } = {}) {
  await payments(app);
  const lamp = await product(app, { stock, pricePaise });
  const res = await place(app, placeBody(lamp.id, { lines: [{ productId: lamp.id, variantId: null, qty }] }));
  assert.equal(res.status, 201, res.text);
  const order = await orderByNumber(app, res.json.orderNumber);
  await markPaid(app, order.id);
  return { lamp, order: await orderByNumber(app, res.json.orderNumber), token: res.json.token };
}

const api = (app, token, path, { method = 'GET', body } = {}) => hit(app, `/api/v1${path}`, { method, token, body });

test('S-30 a new order can\'t jump straight to delivered; packing is a move, and the timeline says who made it', async () => {
  const app = await storeApp();
  try {
    const { order } = await paidOrder(app);
    assert.deepEqual([order.fulfilment_status, order.payment_status], ['new', 'paid']);
    const token = await ownerToken(app);
    const jump = await api(app, token, `/orders/${order.id}/advance`, { method: 'POST', body: { to: 'delivered' } });
    assert.equal(jump.status, 409);
    assert.match(jump.json.error, /can’t go from New to Delivered/);
    assert.equal((await orderByNumber(app, order.order_number)).fulfilment_status, 'new');

    const packed = await api(app, token, `/orders/${order.id}/advance`, { method: 'POST', body: { to: 'packed', note: 'Wrapped in tissue' } });
    assert.equal(packed.status, 200, packed.text);
    assert.equal(packed.json.fulfilmentStatus, 'packed');
    assert.deepEqual(packed.json.nextFulfilment, ['shipped']);
    const timeline = await api(app, token, `/orders/${order.id}/timeline`);
    const moves = timeline.json.items.map((e) => [e.kind, e.from, e.to, e.actor]);
    assert.deepEqual(moves.find((m) => m[0] === 'fulfilment' && m[2] === 'packed'), ['fulfilment', 'new', 'packed', 'Owner']);
    assert.ok(timeline.json.items.some((e) => e.kind === 'note' && e.note === 'Wrapped in tissue'));
    assert.ok(timeline.json.items.some((e) => e.kind === 'payment' && e.to === 'paid' && e.actor === 'Payment gateway'));
    // A Phase 0 status can't be set on a checkout order.
    const set = await api(app, token, `/orders/${order.id}/status`, { method: 'POST', body: { status: 'delivered' } });
    assert.equal(set.status, 409);
  } finally {
    app.close();
  }
});

test('S-31 cancelling a packed, paid order restores the stock, prompts the refund, and the timeline logs it', async () => {
  const app = await storeApp();
  try {
    const { lamp, order } = await paidOrder(app, { stock: 3, qty: 2 });
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 1, reserved: 0 }, 'paying turned the hold into a sale');
    const token = await ownerToken(app);
    assert.equal((await api(app, token, `/orders/${order.id}/advance`, { method: 'POST', body: { to: 'packed' } })).status, 200);
    const cancelled = await api(app, token, `/orders/${order.id}/cancel`, { method: 'POST', body: { reason: 'out_of_stock', note: 'Damaged in packing' } });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.deepEqual([cancelled.json.fulfilmentStatus, cancelled.json.cancelReason, cancelled.json.refundDuePaise, cancelled.json.canCancel], ['cancelled', 'out_of_stock', 100000, false]);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 3, reserved: 0 });
    await app.ctx.orderEvents.settle();
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 3, reserved: 0 }, 'the order.cancelled listener gives nothing back twice');
    const timeline = await api(app, token, `/orders/${order.id}/timeline`);
    assert.ok(timeline.json.items.some((e) => e.kind === 'fulfilment' && e.from === 'packed' && e.to === 'cancelled' && e.actor === 'Owner'));
    const again = await api(app, token, `/orders/${order.id}/cancel`, { method: 'POST', body: {} });
    assert.equal(again.status, 409);
  } finally {
    app.close();
  }
});

test('S-32 the app (bearer) and the web console (cookie) read the same status and timeline', async () => {
  const app = await storeApp();
  try {
    const { order } = await paidOrder(app);
    const token = await ownerToken(app);
    assert.equal((await api(app, token, `/orders/${order.id}/advance`, { method: 'POST', body: { to: 'shipped' } })).status, 200);
    const session = await login(app.base);
    const web = await hit(app, `/api/v1/orders/${order.id}`, { cookie: session.cookie });
    const webTimeline = await hit(app, `/api/v1/orders/${order.id}/timeline`, { cookie: session.cookie });
    const appView = await api(app, token, `/orders/${order.id}`);
    const appTimeline = await api(app, token, `/orders/${order.id}/timeline`);
    assert.equal(web.status, 200);
    assert.deepEqual([web.json.fulfilmentStatus, web.json.status], ['shipped', 'shipped']);
    assert.deepEqual(web.json, appView.json);
    assert.deepEqual(webTimeline.json, appTimeline.json);
    const list = await api(app, token, '/orders?fulfilment=shipped');
    assert.deepEqual(list.json.items.map((o) => o.id), [order.id]);
    assert.equal(list.json.items[0].itemCount, 1);
    assert.deepEqual((await api(app, token, '/orders?fulfilment=new')).json.items, []);
  } finally {
    app.close();
  }
});

test('S-56 a shopper cancels their own unshipped prepaid order: the stock comes back, and nobody else can cancel it', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 2 });
    const asha = await shopper(app);
    const res = await place(app, placeBody(lamp.id), { cookie: asha.cookie });
    const order = await orderByNumber(app, res.json.orderNumber);
    await markPaid(app, order.id);
    const stranger = await shopper(app, { phone: '+919000022222' });
    const theirs = await hit(app, `/api/store/orders/${order.order_number}/cancel`, { method: 'POST', body: {}, cookie: stranger.cookie });
    assert.equal(theirs.status, 404);
    const guest = await hit(app, `/api/store/orders/${order.order_number}/cancel`, { method: 'POST', body: {} });
    assert.equal(guest.status, 401);
    const mine = await hit(app, `/api/store/orders/${order.order_number}/cancel`, { method: 'POST', body: {}, cookie: asha.cookie });
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual([mine.json.fulfilmentStatus, mine.json.refundDuePaise], ['cancelled', 50000]);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 2, reserved: 0 });
    assert.equal((await orderByNumber(app, order.order_number)).cancel_reason, 'shopper');
  } finally {
    app.close();
  }
});

test('S-69 cancelling a part-advance order before shipment prompts the advance back, and cash on delivery leaves nothing to collect', async () => {
  const app = await storeApp();
  try {
    await payments(app, { cod: true, partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
    const saree = await product(app, { pricePaise: 99900, stock: 2 });
    const asha = await shopper(app);
    const placed = await place(app, placeBody(saree.id, { paymentMode: 'part_advance' }), { cookie: asha.cookie });
    assert.equal(placed.status, 201, placed.text);
    const order = await orderByNumber(app, placed.json.orderNumber);
    await markPaid(app, order.id);
    assert.equal((await orderByNumber(app, order.order_number)).payment_status, 'advance_paid');
    const token = await ownerToken(app);
    const cancelled = await api(app, token, `/orders/${order.id}/cancel`, { method: 'POST', body: { reason: 'seller' } });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.deepEqual([cancelled.json.fulfilmentStatus, cancelled.json.refundDuePaise, cancelled.json.balancePaise], ['cancelled', 10000, 89900]);
    assert.deepEqual(await stockOf(app, saree.id), { stock: 2, reserved: 0 });

    const cod = await place(app, placeBody(saree.id, { paymentMode: 'cod' }), { cookie: asha.cookie });
    assert.equal(cod.status, 201, cod.text);
    assert.deepEqual(await stockOf(app, saree.id), { stock: 1, reserved: 0 });
    const done = await hit(app, `/api/store/orders/${cod.json.orderNumber}/cancel`, { method: 'POST', body: {}, cookie: asha.cookie });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual([done.json.paymentStatus, done.json.refundDuePaise], ['voided', 0]);
    assert.deepEqual(await stockOf(app, saree.id), { stock: 2, reserved: 0 });
  } finally {
    app.close();
  }
});

test('S-99 one business never sees, moves or downloads another business\'s orders', async () => {
  const app = await storeApp();
  try {
    const { order } = await paidOrder(app);
    const other = await otherStore(app);
    const { repos } = app;
    void repos;
    const { withTenant } = await import('../../../src/tenancy.js');
    await withTenant(other.tenant, () => app.platform.users.ensureOwner({ phone: '9000000099', password: 'other-pass' }));
    const login2 = await hit(app, '/api/v1/auth/login', { method: 'POST', host: other.host, body: { phone: '9000000099', password: 'other-pass' } });
    const token = login2.json.token;
    assert.ok(token, login2.text);
    assert.deepEqual((await hit(app, '/api/v1/orders', { token, host: other.host })).json.items, []);
    assert.equal((await hit(app, `/api/v1/orders/${order.id}`, { token, host: other.host })).status, 404);
    assert.equal((await hit(app, `/api/v1/orders/${order.id}/timeline`, { token, host: other.host })).status, 404);
    assert.equal((await hit(app, `/api/v1/orders/${order.id}/advance`, { method: 'POST', token, host: other.host, body: { to: 'packed' } })).status, 404);
    assert.equal((await hit(app, `/api/v1/orders/${order.id}/cancel`, { method: 'POST', token, host: other.host, body: {} })).status, 404);
    assert.equal((await orderByNumber(app, order.order_number)).fulfilment_status, 'new');
    const mine = await hit(app, '/api/v1/order-downloads', { method: 'POST', token: await ownerToken(app), body: {} });
    assert.equal(mine.status, 201, mine.text);
    assert.equal((await hit(app, `/api/v1/order-downloads/${mine.json.id}`, { token, host: other.host })).status, 404);
  } finally {
    app.close();
  }
});

test('orders download as a CSV file for this business, with cells a spreadsheet won\'t run, for those allowed to see orders', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 5 });
    const res = await place(app, placeBody(lamp.id, { address: { name: '=HYPERLINK("x")', phone: '9876543210', line1: '12 Lake Road', city: 'Pune', stateCode: '27', pincode: '411001' } }));
    assert.equal(res.status, 201, res.text);
    const token = await ownerToken(app);
    const made = await api(app, token, '/order-downloads', { method: 'POST', body: { fulfilment: 'pending' } });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.json.status, made.json.rowCount], ['ready', 1]);
    assert.match(made.json.fileUrl, /^\/orders\/downloads\/\d+\/file$/);
    const file = await hit(app, made.json.fileUrl, { token });
    assert.equal(file.status, 200);
    assert.match(file.headers['content-type'], /text\/csv/);
    assert.match(file.headers['content-disposition'], /attachment/);
    assert.match(file.text, new RegExp(res.json.orderNumber));
    assert.match(file.text, /"'=HYPERLINK\(""x""\)"/, 'a formula is written as text');
    assert.equal((await hit(app, made.json.fileUrl)).status, 401);
    const listed = await api(app, token, '/order-downloads');
    assert.deepEqual(listed.json.items.map((d) => d.id), [made.json.id]);
    const none = await api(app, token, '/order-downloads', { method: 'POST', body: { fulfilment: 'delivered' } });
    assert.equal(none.json.rowCount, 0);
  } finally {
    app.close();
  }
});

test('a hold blocks moving the order until it is released, and the list filters held orders', async () => {
  const app = await storeApp();
  try {
    const { order } = await paidOrder(app);
    const { withTenant } = await import('../../../src/tenancy.js');
    const { holdOrder } = await import('../../../src/modules/orders/state.js');
    await withTenant(app.tenant, () => app.db.tx((t) => holdOrder(t, order.id, 'review', { actor: 'system' })));
    const token = await ownerToken(app);
    assert.deepEqual((await api(app, token, '/orders?held=true')).json.items.map((o) => o.id), [order.id]);
    assert.equal((await api(app, token, `/orders/${order.id}`)).json.nextFulfilment.length, 0);
    const blocked = await api(app, token, `/orders/${order.id}/advance`, { method: 'POST', body: { to: 'packed' } });
    assert.equal(blocked.status, 409);
    const released = await api(app, token, `/orders/${order.id}/release-hold`, { method: 'POST', body: { note: 'Checked with the buyer' } });
    assert.equal(released.status, 200, released.text);
    assert.equal(released.json.holdReason, null);
    assert.deepEqual((await api(app, token, '/orders?held=true')).json.items, []);
    assert.equal((await api(app, token, `/orders/${order.id}/advance`, { method: 'POST', body: { to: 'packed' } })).status, 200);
    const note = await api(app, token, `/orders/${order.id}/notes`, { method: 'POST', body: { note: 'Gift wrap' } });
    assert.equal(note.status, 201);
    assert.deepEqual([note.json.kind, note.json.note, note.json.actor], ['note', 'Gift wrap', 'Owner']);
  } finally {
    app.close();
  }
});

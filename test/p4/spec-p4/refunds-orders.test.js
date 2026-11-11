// PRD 9.8 (refunds) and 9.9 (orders admin and statuses). S-27 to S-32, S-75, S-76.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addP4Shop, addStaff, buyer, hit, idemKey, need, noCrash, ok, ownGateway, platformAuth, refused, sum, textOf, together, useP4World } from './kit.js';
import { signInCookie } from '../../p0/spec-p0/support.js';

const world = useP4World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });

async function paidOrder(shop, { pricePaise = 99900, stock = 5, qty = 1 } = {}) {
  const product = await shop.item({ pricePaise, stock });
  const b = buyer(world, shop);
  const row = await b.buy({ lines: [line(product, qty)] });
  return { b, product, row, paymentId: row.paid.payment.id };
}
const gatewayRefunds = async (paymentId) => (await world.rzp.get('/state')).refunds.filter((r) => r.payment_id === paymentId);
const refundSettled = (shop, order, status) => shop.orderWhen(order.order_number, (o) => o.payment_status === status);

test('S-27: refunding Rs 200 of Rs 999 shows "Partially refunded Rs 200" on the order', async () => {
  const shop = await addP4Shop(world);
  await shop.invoiceReady();
  const { b, row, paymentId } = await paidOrder(shop);
  const res = need(await shop.refund(row.id, { amountPaise: 20000, reason: 'One item was short' }), 201, 'Refunding Rs 200');
  assert.equal(res.json().amountPaise, 20000);
  assert.equal(res.json().method, 'gateway');
  const order = await refundSettled(shop, row, 'partially_refunded');
  assert.equal(order.payment_status, 'partially_refunded');
  assert.equal(Number(order.refunded_paise), 20000);
  const detail = await shop.orderApi(row.id);
  assert.equal(detail.paymentStatus, 'partially_refunded');
  assert.equal(detail.refundedPaise, 20000);
  assert.equal(sum(await gatewayRefunds(paymentId), (r) => r.amount), 20000, 'The gateway did not refund Rs 200');
  const [refund] = await shop.refunds(row.id);
  assert.equal(refund.status, 'processed');
  assert.match(refund.requested_by, /^user:\d+$/);
  assert.ok((await shop.audit('refund')).length >= 1, 'The refund is not in the audit log');
  const notes = (await shop.invoices(row.id)).filter((i) => i.doc_type === 'credit_note');
  assert.equal(notes.length, 1, 'No credit note for the refund');
  assert.equal(Number(notes[0].total_paise), 20000);
  const page = need(await b.open(`/order/${row.placed.token}`), 200, 'The shopper’s order page');
  assert.match(textOf(page.text), /refund/i, 'The shopper’s page does not show the refund');
  assert.match(textOf(page.text), /200/);
  need(await shop.refund(row.id, { amountPaise: 79900 }), 201, 'Refunding the rest');
  assert.equal((await refundSettled(shop, row, 'refunded')).payment_status, 'refunded');
});

test('S-28: a refund above what was captured is blocked, at the API and when two refunds race', async () => {
  const shop = await addP4Shop(world);
  const { row, paymentId } = await paidOrder(shop);
  const over = refused(await shop.refund(row.id, { amountPaise: 100000 }), 'Refunding Rs 1,000 on Rs 999');
  assert.ok(over.json().error);
  for (const amountPaise of [0, -100, 1.5, '20000', 2 ** 53, Number.MAX_SAFE_INTEGER, null]) refused(await shop.refund(row.id, { amountPaise }), `Refund amount ${amountPaise}`, 400);
  assert.equal((await gatewayRefunds(paymentId)).length, 0, 'The gateway was asked for a refund that was blocked');
  assert.equal((await shop.refunds(row.id)).length, 0);
  const race = await together(2, () => shop.refund(row.id, { amountPaise: 60000 }));
  race.forEach((r) => noCrash(r, 'Two refunds at once'));
  assert.equal(race.filter((r) => r.status === 201).length, 1, 'Two refunds of Rs 600 on Rs 999 were both taken');
  await world.quiet(1500);
  const taken = (await shop.refunds(row.id)).filter((r) => r.status !== 'failed');
  assert.ok(sum(taken, (r) => r.amount_paise) <= 99900);
  assert.ok(sum(await gatewayRefunds(paymentId), (r) => r.amount) <= 99900);
  refused(await shop.refund(row.id, { amountPaise: 39901 }), 'One paisa more than is left');
  need(await shop.refund(row.id, { amountPaise: 39900 }), 201, 'Exactly what is left');
});

test('S-28: the same tap twice is one refund, and a wrong password or an unpaid order gets none', async () => {
  const shop = await addP4Shop(world);
  const { row, paymentId } = await paidOrder(shop);
  const key = idemKey();
  const body = { amountPaise: 10000, idempotencyKey: key };
  const [x, y] = await together(2, () => shop.refund(row.id, body));
  assert.ok([x, y].every((r) => r.status < 300), `A repeated refund tap was refused: ${x.status} ${y.status}`);
  assert.equal(x.json().id, y.json().id);
  assert.equal((await shop.refunds(row.id)).length, 1);
  await world.quiet(800);
  assert.equal(sum(await gatewayRefunds(paymentId), (r) => r.amount), 10000, 'The gateway refunded twice');
  refused(await shop.refund(row.id, { amountPaise: 1000, password: 'not-my-password' }), 'A refund with the wrong password', [401, 403]);
  refused(await shop.refund(row.id, { amountPaise: 1000, password: undefined }), 'A refund with no password', [400, 401, 403]);
  const product = await shop.item({ pricePaise: 50000 });
  const unpaid = await buyer(world, shop).order({ lines: [line(product)] });
  const unpaidRow = await shop.order(unpaid.orderNumber);
  refused(await shop.refund(unpaidRow.id, { amountPaise: 1000 }), 'Refunding an unpaid order');
  const other = await addP4Shop(world);
  refused(await shop.as(other.token)('POST', `/orders/${row.id}/refunds`, { amountPaise: 1000, idempotencyKey: idemKey(), password: other.owner.password }), 'Another business’s owner refunding this order', [403, 404]);
  assert.equal((await shop.refunds(row.id)).length, 1);
});

test('S-28: a refund whose answer is lost at the gateway is never made twice', async () => {
  const shop = await addP4Shop(world);
  const { row, paymentId } = await paidOrder(shop);
  await world.rzp.fault({ kind: 'partial', then: 'timeout', times: 1, match: { method: 'POST', path: `/v1/payments/${paymentId}/refund` } });
  const first = noCrash(await shop.refund(row.id, { amountPaise: 30000 }), 'A refund whose answer is lost');
  assert.ok(first.status < 500);
  await world.quiet(4000);
  const [refund] = await shop.refunds(row.id);
  if (refund?.status === 'failed') noCrash(await shop.send('POST', `/refunds/${refund.id}/retry`), 'Retrying it');
  await world.quiet(2500);
  assert.equal(sum(await gatewayRefunds(paymentId), (r) => r.amount), 30000, 'A lost answer led to a second refund at the gateway');
  assert.ok(sum((await shop.refunds(row.id)).filter((r) => r.status !== 'failed'), (r) => r.amount_paise) <= 30000);
});

test('S-28: cash collected at the door is refunded by hand, with the reference of how it was paid back', async () => {
  const shop = await addP4Shop(world);
  await shop.codOn();
  const product = await shop.item({ pricePaise: 49900 });
  const b = buyer(world, shop);
  await b.signIn();
  const placed = await b.orderCod({ lines: [line(product)] });
  const order = await shop.order(placed.orderNumber);
  await shop.handDeliver(order);
  const collected = await shop.orderWhen(order.order_number, (o) => o.payment_status === 'paid', 4000);
  assert.equal(collected.payment_status, 'paid', 'A delivered COD order does not record the cash collected at the door');
  refused(await shop.refund(order.id, { amountPaise: 10000 }), 'A COD refund with no reference', 400);
  const res = need(await shop.refund(order.id, { amountPaise: 10000, reference: 'UPI-UTR-0099' }), 201, 'A COD refund with its reference');
  assert.equal(res.json().method, 'manual');
  assert.equal(res.json().reference, 'UPI-UTR-0099');
  assert.equal((await world.rzp.calls({ method: 'POST', path: '/v1/payments/*/refund' })).length, 0, 'A COD refund went to the gateway');
  refused(await shop.refund(order.id, { amountPaise: 49900, reference: 'UPI-UTR-0100' }), 'A manual refund past the cash collected');
});

test('S-29: a manager, staff or a shopper cannot refund; only the owner', async () => {
  const shop = await addP4Shop(world);
  const { row, b } = await paidOrder(shop);
  const manager = await shop.manager();
  const asManager = await manager.send('POST', `/orders/${row.id}/refunds`, { amountPaise: 1000, idempotencyKey: idemKey(), password: manager.password });
  assert.equal(asManager.status, 403, `A manager refunded: ${asManager.status}`);
  assert.match(asManager.json().error, /owner/i);
  const staff = await addStaff(world, shop, { permissions: ['orders'] });
  need(await shop.as(staff.token)('POST', `/orders/${row.id}/refunds`, { amountPaise: 1000, idempotencyKey: idemKey(), password: staff.password }), 403, 'Staff with orders refunding');
  need(await shop.as(staff.token)('POST', '/refunds/1/retry'), [403, 404], 'Staff retrying a refund');
  await b.signIn();
  const asShopper = await b.api('POST', `/api/v1/orders/${row.id}/refunds`, { amountPaise: 1000, idempotencyKey: idemKey(), password: 'x' });
  assert.ok([401, 403].includes(asShopper.status), `A shopper reached the refund call: ${asShopper.status}`);
  assert.equal((await shop.refunds(row.id)).length, 0);
  const seen = need(await manager.send('GET', `/orders/${row.id}/refunds`), 200, 'A manager reading refunds');
  assert.deepEqual(seen.json().items, []);
});

test('S-75: a Rs 200 refund on a managed order returns Rs 200 to the shopper and takes Rs 200 off the seller’s transfer', async () => {
  const shop = await addP4Shop(world);
  const { row, paymentId } = await paidOrder(shop, { pricePaise: 100000 });
  const transferBefore = (await world.rzp.get('/state')).transfers.find((t) => t.source === paymentId);
  assert.ok(transferBefore, 'No transfer to reverse');
  need(await shop.refund(row.id, { amountPaise: 20000 }), 201, 'Refunding Rs 200');
  await refundSettled(shop, row, 'partially_refunded');
  const state = await world.rzp.get('/state');
  assert.equal(sum(state.refunds.filter((r) => r.payment_id === paymentId), (r) => r.amount), 20000, 'The shopper did not get Rs 200 back');
  const transfer = state.transfers.find((t) => t.source === paymentId);
  assert.equal(transfer.amount_reversed, 20000, 'The seller’s transfer was not reduced by Rs 200');
  const [refund] = await shop.refunds(row.id);
  assert.equal(refund.reversal_status, 'reversed');
  assert.equal(Number(refund.reversal_paise), 20000);
  const [payment] = await shop.payments(row.id);
  assert.equal(Number(payment.reversed_paise), 20000);
  const lines = await shop.settlement(row.id);
  assert.ok(lines.some((l) => l.kind === 'refund' && Math.abs(Number(l.amount_paise)) === 20000), 'The statement does not show the refund');
  assert.ok(lines.some((l) => l.kind === 'transfer_reversal' && Math.abs(Number(l.amount_paise)) === 20000), 'The statement does not show the reversal');
  const api = need(await shop.send('GET', `/refunds/${refund.id}`), 200, 'Reading the refund').json();
  assert.equal(api.reversalStatus, 'reversed');
  assert.equal(api.reversalPaise, 20000);
});

test('S-76: a refund on an own-gateway order goes through the seller’s own account, with no Route reversal', async () => {
  const shop = await addP4Shop(world);
  await ownGateway(world, shop);
  const { row, paymentId } = await paidOrder(shop, { pricePaise: 100000 });
  assert.equal(row.gateway_mode, 'own');
  need(await shop.refund(row.id, { amountPaise: 20000 }), 201, 'Refunding Rs 200');
  await refundSettled(shop, row, 'partially_refunded');
  const [call] = await world.rzp.calls({ method: 'POST', path: `/v1/payments/${paymentId}/refund` });
  assert.ok(call, 'The refund never reached the gateway');
  assert.notEqual(call.headers.authorization, platformAuth(world), 'The refund ran on the platform’s account');
  assert.ok(!call.body?.reverse_all, 'An own-gateway refund asked for a Route reversal');
  const [refund] = await shop.refunds(row.id);
  assert.equal(refund.reversal_status, 'none');
  assert.equal(Number(refund.reversal_paise), 0);
  assert.ok(!(await shop.settlement(row.id)).some((l) => l.kind === 'transfer_reversal'));
});

// ---- statuses ----

test('S-30: a new order cannot jump to delivered, by the API or behind its back in the database', async () => {
  const shop = await addP4Shop(world);
  const { row } = await paidOrder(shop);
  const res = refused(await shop.advance(row.id, 'delivered'), 'New straight to delivered', [400, 409, 422]);
  assert.ok(res.json().error);
  for (const to of ['out_for_delivery', 'rto_delivered', 'pending', 'new', 'paid', '']) refused(await shop.advance(row.id, to), `Advancing to ${JSON.stringify(to)}`, [400, 409, 422]);
  assert.equal((await shop.order(row.order_number)).fulfilment_status, 'new');
  const detail = await shop.orderApi(row.id);
  assert.ok(!detail.nextFulfilment.includes('delivered'), `The console offers delivered for a new order: ${detail.nextFulfilment}`);
  await assert.rejects(world.sql(`UPDATE orders SET fulfilment_status = 'delivered' WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, row.id]), /cannot go from new to delivered|orders_transition/, 'The database let new go to delivered');
  await assert.rejects(world.sql(`UPDATE orders SET total_paise = 1, subtotal_paise = 1 WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, row.id]), /fixed|orders_/);
  // Unpaid, cancelled and delivered orders refuse the hand moves too.
  const product = await shop.item({ pricePaise: 50000 });
  const unpaid = await shop.order((await buyer(world, shop).order({ lines: [line(product)] })).orderNumber);
  refused(await shop.advance(unpaid.id, 'packed'), 'Packing an unpaid order', [400, 409, 422]);
  const done = await shop.handDeliver(row);
  refused(await shop.advance(done.id, 'packed'), 'Packing a delivered order', [400, 409, 422]);
  refused(await shop.cancel(done.id), 'Cancelling a delivered order', [400, 409, 422]);
  const other = await addP4Shop(world);
  refused(await other.advance(unpaid.id, 'packed'), 'Another business moving this order', 404);
});

test('S-31: cancelling a packed, paid order restores stock, prompts the refund and logs it on the timeline', async () => {
  const shop = await addP4Shop(world);
  const { row, product } = await paidOrder(shop, { stock: 4, qty: 2 });
  assert.equal((await shop.stockOf(product.id)).stock, 2, 'Paying did not take the stock');
  ok(await shop.advance(row.id, 'packed'), 'Packing');
  const res = need(await shop.cancel(row.id, { reason: 'out_of_stock', note: 'Damaged in the shop' }), 200, 'Cancelling the packed order').json();
  assert.equal(res.fulfilmentStatus, 'cancelled');
  assert.equal(res.refundDuePaise, Number(row.total_paise), 'The owner is not prompted to refund what was paid');
  const stock = await shop.stockOf(product.id);
  assert.equal(stock.stock, 4, 'The stock was not restored');
  assert.equal(stock.reserved, 0);
  const timeline = await shop.timeline(row.id);
  const entry = timeline.find((e) => e.kind === 'fulfilment' && e.from === 'packed' && e.to === 'cancelled');
  assert.ok(entry, 'The timeline does not log the cancellation');
  assert.ok(entry.actor && !/asha|rao/i.test(entry.actor), `The timeline actor is ${entry.actor}`);
  const movements = await shop.sql(`SELECT * FROM stock_movements WHERE tenant_id = $1 AND order_id = $2 AND reason = 'cancel'`, [shop.tenantId, row.id]);
  assert.equal(sum(movements, (m) => m.delta), 2);
  noCrash(await shop.cancel(row.id), 'Cancelling twice');
  await world.quiet(1000);
  assert.equal((await shop.stockOf(product.id)).stock, 4, 'Cancelling twice gave the stock back twice');
  need(await shop.refund(row.id, { amountPaise: res.refundDuePaise }), 201, 'The owner acting on the prompt');
  await refundSettled(shop, row, 'refunded');
  assert.equal((await shop.orderApi(row.id)).refundDuePaise ?? 0, 0, 'The prompt stays after the refund');
});

test('S-31: a shipped order cannot be cancelled by the seller or the shopper', async () => {
  const shop = await addP4Shop(world);
  const { row, b } = await paidOrder(shop);
  ok(await shop.advance(row.id, 'packed'), 'Packing');
  ok(await shop.advance(row.id, 'shipped'), 'Shipping');
  refused(await shop.cancel(row.id), 'Cancelling a shipped order', [400, 409, 422]);
  refused(await b.cancelOrder(row.order_number), 'The shopper cancelling a shipped order');
  assert.equal((await shop.order(row.order_number)).fulfilment_status, 'shipped');
});

test('S-32: a status changed in the app shows the same in the web admin, with the same timeline entry', async () => {
  const shop = await addP4Shop(world);
  const { row } = await paidOrder(shop);
  const app = (method, path, body) => hit(world, `/api/v1${path}`, { host: shop.host, method, token: shop.token, headers: { 'user-agent': 'BhavaBusiness/1.0 (Android 14)' }, ...(body ? { body } : {}) });
  need(await app('POST', `/orders/${row.id}/advance`, { to: 'packed', note: 'Packed from the app' }), 200, 'Packing from the app');
  // The web admin in a browser: its cookie session, or, where /api/v1 takes bearer tokens only, a second sign-in of its own.
  let webAuth = { cookie: await signInCookie(world, shop) };
  let web = await hit(world, `/api/v1/orders/${row.id}`, { host: shop.host, ...webAuth });
  if (web.status === 401) {
    webAuth = { token: need(await hit(world, '/api/v1/auth/login', { host: shop.host, method: 'POST', body: { phone: shop.owner.phone, password: shop.owner.password } }), 201, 'A web sign-in').json().token };
    web = await hit(world, `/api/v1/orders/${row.id}`, { host: shop.host, ...webAuth });
  }
  need(web, 200, 'The order in the web admin');
  assert.equal(web.json().fulfilmentStatus, 'packed');
  const appView = need(await app('GET', `/orders/${row.id}/timeline`), 200, 'The timeline in the app').json().items;
  const webItems = need(await hit(world, `/api/v1/orders/${row.id}/timeline`, { host: shop.host, ...webAuth }), 200, 'The timeline on the web').json().items;
  assert.deepEqual(webItems, appView, 'The web and the app show different timelines');
  const entry = appView.find((e) => e.to === 'packed');
  assert.ok(entry, 'No timeline entry for the change');
  assert.equal(entry.note, 'Packed from the app');
  const list = need(await shop.send('GET', `/orders?fulfilment=packed`), 200, 'Filtering by packed').json();
  assert.ok(list.items.some((o) => o.id === row.id));
});

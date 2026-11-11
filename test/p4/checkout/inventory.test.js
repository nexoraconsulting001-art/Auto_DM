// Inventory with reservations (PRD 9.12): a hold while payment is pending, released when it runs out, taken when paid,
// never below zero, late money flagged when the stock is gone, the stock screens, and low-stock alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expireHolds } from '../../../src/modules/inventory/stock.js';
import {
  hit, inTenant, markPaid, orderByNumber, ownerToken, payments, place, placeBody, product, q, stockOf, storeApp, variantStock, withSizes,
} from './support.js';

const api = (app, token, path, { method = 'GET', body } = {}) => hit(app, `/api/v1${path}`, { method, token, body });
const later = (minutes) => new Date(Date.now() + minutes * 60_000);

test('S-39 a prepaid order unpaid for 31 minutes is cancelled and its stock returned', async () => {
  const app = await storeApp();
  try {
    await payments(app, { holdMinutes: 30 });
    const lamp = await product(app, { stock: 2 });
    const res = await place(app, placeBody(lamp.id, { lines: [{ productId: lamp.id, variantId: null, qty: 2 }] }));
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 2, reserved: 2 });
    assert.equal((await place(app, placeBody(lamp.id))).status, 409, 'the held units are not for sale');

    assert.deepEqual(await expireHolds(app.ctx, { now: later(29) }), { due: 0, cancelled: 0 });
    assert.deepEqual(await expireHolds(app.ctx, { now: later(31) }), { due: 1, cancelled: 1 });
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.deepEqual([order.fulfilment_status, order.cancel_reason, order.payment_status], ['cancelled', 'hold_expired', 'unpaid']);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 2, reserved: 0 });
    await app.ctx.orderEvents.settle();
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 2, reserved: 0 }, 'the cancel listener gives back nothing twice');
    assert.deepEqual(await expireHolds(app.ctx, { now: later(60) }), { due: 0, cancelled: 0 });
    const page = await hit(app, `/order/${res.json.token}`);
    assert.match(page.text, /wasn’t completed in time/);
  } finally {
    app.close();
  }
});

test('S-68 a part-advance order whose advance never arrives stays pending, then is cancelled when the hold ends', async () => {
  const app = await storeApp();
  try {
    await payments(app, { partAdvance: true, advanceKind: 'percent', advanceValue: 2000, holdMinutes: 15 });
    const saree = await product(app, { pricePaise: 100000, stock: 1 });
    const res = await place(app, placeBody(saree.id, { paymentMode: 'part_advance' }));
    assert.equal(res.status, 201, res.text);
    let order = await orderByNumber(app, res.json.orderNumber);
    assert.deepEqual([Number(order.advance_paise), Number(order.balance_paise), order.fulfilment_status], [20000, 80000, 'pending']);
    await expireHolds(app.ctx, { now: later(10) });
    assert.equal((await orderByNumber(app, order.order_number)).fulfilment_status, 'pending');
    await expireHolds(app.ctx, { now: later(16) });
    order = await orderByNumber(app, order.order_number);
    assert.deepEqual([order.fulfilment_status, order.cancel_reason], ['cancelled', 'hold_expired']);
    assert.deepEqual(await stockOf(app, saree.id), { stock: 1, reserved: 0 });
  } finally {
    app.close();
  }
});

test('paying turns the hold into a sale once, however often the event comes; cash on delivery takes its stock when placed', async () => {
  const app = await storeApp();
  try {
    await payments(app, { cod: true });
    const lamp = await product(app, { stock: 5 });
    const res = await place(app, placeBody(lamp.id, { lines: [{ productId: lamp.id, variantId: null, qty: 2 }] }));
    const order = await orderByNumber(app, res.json.orderNumber);
    await markPaid(app, order.id);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 3, reserved: 0 });
    // The same order.paid delivered again moves nothing.
    const { stockListeners } = await import('../../../src/modules/inventory/stock.js');
    await inTenant(app, () => stockListeners(app.ctx).commit({ orderId: order.id, type: 'order.paid' }, app.ctx));
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 3, reserved: 0 });
    const moves = await q(app, 'SELECT delta, reason FROM stock_movements WHERE tenant_id = $1 AND product_id = $2', [app.tenant.id, lamp.id]);
    assert.deepEqual(moves.map((m) => [m.delta, m.reason]), [[-2, 'sale']]);

    app.ctx.shoppers = { otps: { codVerified: async () => true } };
    const cod = await place(app, placeBody(lamp.id, { paymentMode: 'cod', idempotencyKey: 'cod-attempt-0001' }));
    assert.equal(cod.status, 201, cod.text);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 2, reserved: 0 });
    await app.ctx.orderEvents.settle();
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 2, reserved: 0 }, 'order.cod_confirmed takes nothing more');
  } finally {
    app.close();
  }
});

test('S-41 paid after the hold expired and the stock is gone: flagged "Paid, out of stock"; with stock there, the order comes back', async () => {
  const app = await storeApp();
  try {
    await payments(app, { holdMinutes: 30 });
    const lamp = await product(app, { stock: 1 });
    const first = await place(app, placeBody(lamp.id));
    await expireHolds(app.ctx, { now: later(31) });
    // Someone else buys the last unit, then the first shopper's money arrives.
    const second = await place(app, placeBody(lamp.id, { address: { name: 'Ravi Kumar', phone: '9123412345', line1: '4 Hill Road', city: 'Pune', stateCode: '27', pincode: '411002' } }));
    assert.equal(second.status, 201, second.text);
    await markPaid(app, (await orderByNumber(app, second.json.orderNumber)).id);
    const late = await orderByNumber(app, first.json.orderNumber);
    await markPaid(app, late.id);
    const flagged = await orderByNumber(app, first.json.orderNumber);
    assert.deepEqual([flagged.fulfilment_status, flagged.payment_status, flagged.hold_reason], ['cancelled', 'paid', 'paid_out_of_stock']);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 0, reserved: 0 }, 'stock never goes below zero');
    const token = await ownerToken(app);
    const listed = await api(app, token, '/orders?held=true');
    assert.deepEqual(listed.json.items.map((o) => [o.orderNumber, o.holdReason, o.refundDuePaise]), [[flagged.order_number, 'paid_out_of_stock', 50000]]);
    const noStock = await api(app, token, `/orders/${flagged.id}/reinstate`, { method: 'POST' });
    assert.equal(noStock.status, 409);
    // The owner adds stock and brings it back.
    assert.equal((await api(app, token, '/inventory/adjust', { method: 'POST', body: { productId: lamp.id, stock: 1 } })).status, 200);
    const back = await api(app, token, `/orders/${flagged.id}/reinstate`, { method: 'POST' });
    assert.equal(back.status, 200, back.text);
    assert.deepEqual([back.json.fulfilmentStatus, back.json.holdReason, back.json.refundDuePaise], ['new', null, 0]);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 0, reserved: 0 });

    // Late money with the stock still there brings the order back on its own.
    const pot = await product(app, { name: 'Clay pot', stock: 1 });
    const third = await place(app, placeBody(pot.id));
    await expireHolds(app.ctx, { now: later(31) });
    await markPaid(app, (await orderByNumber(app, third.json.orderNumber)).id);
    const revived = await orderByNumber(app, third.json.orderNumber);
    assert.deepEqual([revived.fulfilment_status, revived.payment_status, revived.hold_reason], ['new', 'paid', null]);
    assert.deepEqual(await stockOf(app, pot.id), { stock: 0, reserved: 0 });

    // The gateway's own move can bring the order back (cancelled -> new for late money). With the stock gone it waits on
    // hold, and releasing the hold takes the stock first.
    const vase = await product(app, { name: 'Vase', stock: 1 });
    const fourth = await place(app, placeBody(vase.id));
    await expireHolds(app.ctx, { now: later(31) });
    await q(app, 'UPDATE products SET stock = 0 WHERE tenant_id = $1 AND id = $2', [app.tenant.id, vase.id]);
    await markPaid(app, (await orderByNumber(app, fourth.json.orderNumber)).id, { confirm: true });
    const waiting = await orderByNumber(app, fourth.json.orderNumber);
    assert.deepEqual([waiting.fulfilment_status, waiting.payment_status, waiting.hold_reason], ['new', 'paid', 'paid_out_of_stock']);
    assert.equal((await api(app, token, `/orders/${waiting.id}/release-hold`, { method: 'POST', body: {} })).status, 409);
    await q(app, 'UPDATE products SET stock = 2 WHERE tenant_id = $1 AND id = $2', [app.tenant.id, vase.id]);
    const released = await api(app, token, `/orders/${waiting.id}/release-hold`, { method: 'POST', body: {} });
    assert.equal(released.status, 200, released.text);
    assert.equal(released.json.holdReason, null);
    assert.deepEqual(await stockOf(app, vase.id), { stock: 1, reserved: 0 });
  } finally {
    app.close();
  }
});

test('the stock screens: a product\'s plain variant is the product, options have their own rows, and stock never goes below what is held', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 4 });
    await q(app, `INSERT INTO product_variants (tenant_id, product_id, option_values, sku, price_paise) VALUES ($1, $2, '{}', 'LAMP-1', 50000)`, [app.tenant.id, lamp.id]);
    const kurti = await product(app, { name: 'Kurti', stock: null });
    const sizes = await withSizes(app, kurti.id, [{ value: 'M', stock: 1, sku: 'KURTI-M' }, { value: 'L', stock: 5, sku: 'KURTI-L' }]);
    const res = await place(app, placeBody(lamp.id, { lines: [{ productId: lamp.id, variantId: null, qty: 3 }] }));
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 4, reserved: 3 }, 'held on the product, not on its plain variant');
    const token = await ownerToken(app);
    const list = await api(app, token, '/inventory');
    const rows = list.json.items.map((l) => [l.name, l.option, l.sku, l.stock, l.reserved, l.available, l.low]);
    assert.deepEqual(rows, [['Brass lamp', '', 'LAMP-1', 4, 3, 1, true], ['Kurti', 'M', 'KURTI-M', 1, 0, 1, true], ['Kurti', 'L', 'KURTI-L', 5, 0, 5, false]]);
    assert.deepEqual((await api(app, token, '/inventory?show=low')).json.items.map((l) => l.sku), ['LAMP-1', 'KURTI-M']);
    const below = await api(app, token, '/inventory/adjust', { method: 'POST', body: { productId: lamp.id, stock: 2 } });
    assert.equal(below.status, 409);
    const needsOption = await api(app, token, '/inventory/adjust', { method: 'POST', body: { productId: kurti.id, delta: 1 } });
    assert.equal(needsOption.status, 400);
    const up = await api(app, token, '/inventory/adjust', { method: 'POST', body: { productId: kurti.id, variantId: sizes.M, delta: 4 } });
    assert.equal(up.status, 200, up.text);
    assert.deepEqual(await variantStock(app, sizes.M), { stock: 5, reserved: 0 });
    const moves = await api(app, token, `/inventory/movements?productId=${kurti.id}`);
    assert.deepEqual(moves.json.items.map((m) => [m.delta, m.reason, m.actor]), [[4, 'manual', 'Team']]);
    assert.equal((await api(app, token, '/inventory/settings', { method: 'PATCH', body: { lowStockThreshold: 0 } })).status, 200);
    assert.deepEqual((await api(app, token, '/inventory/settings')).json, { lowStockThreshold: 0 });
  } finally {
    app.close();
  }
});

test('a sale that leaves an item at or below its threshold tells the owner once', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 4 });
    const res = await place(app, placeBody(lamp.id, { lines: [{ productId: lamp.id, variantId: null, qty: 2 }] }));
    await markPaid(app, (await orderByNumber(app, res.json.orderNumber)).id);
    const alerts = await q(app, `SELECT kind, severity, message FROM alerts WHERE tenant_id = $1 AND kind = 'stock.low'`, [app.tenant.id]);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].message, /Brass lamp is running low: 2 left/);
  } finally {
    app.close();
  }
});

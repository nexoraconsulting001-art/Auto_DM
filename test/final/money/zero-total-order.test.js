// R7-MONEY (M-9): an order with nothing to pay online (a coupon that covers the whole bag, free delivery) is confirmed when
// it is placed: paid, new, its stock taken and its coupon use kept, with no gateway order. A total online can't take (under
// Rs 1, the gateway's least) is not offered as "pay online", so no order waits on a payment that can never happen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS, inTenant, orderByNumber, payments, place, placeBody, product, q, quote, stockOf, storeApp } from '../../p4/checkout/support.js';

const modeOf = (res, mode) => res.json.paymentModes.find((m) => m.mode === mode);
const flatCoupon = (app, code, amountPaise) => inTenant(app, () => app.db.query(`INSERT INTO coupons (tenant_id, code, kind, amount_paise) VALUES ($1, $2, 'flat', $3)`, [app.tenant.id, code, amountPaise]));

test('M-9: a prepaid order whose coupon covers it all is confirmed at once, with no gateway', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { pricePaise: 50000, stock: 3 });
    await flatCoupon(app, 'GIFT500', 50000);
    const seen = await quote(app, { lines: [{ productId: lamp.id, variantId: null, qty: 1 }], address: { ...ADDRESS }, paymentMode: 'prepaid', couponCode: 'GIFT500' });
    assert.equal(seen.json.totalPaise, 0);
    assert.equal(modeOf(seen, 'prepaid').available, true);

    const res = await place(app, placeBody(lamp.id, { couponCode: 'GIFT500' }));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.next, 'done', 'nothing to pay: the shopper is not sent to a pay step');
    assert.equal(res.json.gateway, null);
    await app.ctx.orderEvents.settle();
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.deepEqual([order.payment_status, order.fulfilment_status, Number(order.total_paise), Number(order.paid_paise)], ['paid', 'new', 0, 0]);
    assert.equal(order.hold_expires_at, null, 'no hold to run out');
    const rows = await q(app, 'SELECT id FROM payments WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, order.id]);
    assert.equal(rows.length, 0, 'no gateway payment is made for Rs 0');
    const stock = await stockOf(app, lamp.id);
    assert.deepEqual([Number(stock.stock), Number(stock.reserved)], [2, 0], 'the stock is taken, not left held');
    const uses = await q(app, 'SELECT count(*)::int AS n FROM coupon_redemptions WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, order.id]);
    assert.equal(uses[0].n, 1);

    // The same key again answers with the same order, still done.
    const again = await place(app, { ...placeBody(lamp.id, { couponCode: 'GIFT500' }), idempotencyKey: order.idempotency_key });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual([again.json.orderNumber, again.json.next], [order.order_number, 'done']);
  } finally {
    app.close();
  }
});

test('M-9: a prepaid total under Rs 1 is not offered online, and placing it that way is refused', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { pricePaise: 50000, stock: 3 });
    await flatCoupon(app, 'ALMOST', 49950);
    const seen = await quote(app, { lines: [{ productId: lamp.id, variantId: null, qty: 1 }], address: { ...ADDRESS }, paymentMode: 'prepaid', couponCode: 'ALMOST' });
    assert.equal(seen.json.totalPaise, 50);
    assert.equal(modeOf(seen, 'prepaid').available, false);
    assert.match(modeOf(seen, 'prepaid').reason, /₹1/);
    const res = await place(app, placeBody(lamp.id, { couponCode: 'ALMOST' }));
    assert.equal(res.status, 409, res.text);
    const [{ n }] = await q(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]);
    assert.equal(n, 0);
  } finally {
    app.close();
  }
});

// commerce-3 (PRD 9.14): a cancelled order that comes back (order.reinstated) keeps its discount, so its coupon use counts again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { inTenant, markPaid, orderByNumber, payments, place, placeBody, product, q, storeApp } from '../../p4/checkout/support.js';

const expire = async (app, orderId) => {
  await inTenant(app, () => app.db.tx((t) => changeOrder(t, orderId, { fulfilment: 'cancelled', cancelReason: 'hold_expired', actor: 'job:hold-expiry' })));
  await app.ctx.orderEvents.settle();
};
const state = async (app) => ({
  used: (await q(app, `SELECT used_count FROM coupons WHERE tenant_id = $1 AND code = 'LONE'`, [app.tenant.id]))[0].used_count,
  status: (await q(app, `SELECT status FROM coupon_redemptions WHERE tenant_id = $1`, [app.tenant.id])).map((r) => r.status),
});
const bring = (app, orderId) => markPaid(app, orderId, { confirm: true });

test('commerce-3: reinstating a cancelled order counts its coupon use again', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    await q(app, `INSERT INTO coupons (tenant_id, code, kind, percent_bp, max_uses) VALUES ($1, 'LONE', 'percent', 1000, 1)`, [app.tenant.id]);
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const res = await place(app, placeBody(lamp.id, { couponCode: 'LONE' }));
    assert.equal(res.status, 201, res.text);
    const order = await orderByNumber(app, res.json.orderNumber);
    await expire(app, order.id);
    assert.deepEqual(await state(app), { used: 0, status: ['released'] });
    await bring(app, order.id);
    assert.deepEqual(await state(app), { used: 1, status: ['applied'] });
  } finally {
    app.close();
  }
});

test('commerce-3: if the code was used up meanwhile, the revived order is kept, the count stays within max_uses, and the owner is alerted', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    await q(app, `INSERT INTO coupons (tenant_id, code, kind, percent_bp, max_uses) VALUES ($1, 'LONE', 'percent', 1000, 1)`, [app.tenant.id]);
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const first = await orderByNumber(app, (await place(app, placeBody(lamp.id, { couponCode: 'LONE' }))).json.orderNumber);
    await expire(app, first.id);
    const second = await place(app, placeBody(lamp.id, { couponCode: 'LONE' }));
    assert.equal(second.status, 201, second.text);
    await bring(app, first.id);
    const back = await orderByNumber(app, first.order_number);
    assert.equal(back.fulfilment_status, 'new');
    assert.equal(Number(back.discount_paise), 10000);
    assert.equal((await state(app)).used, 1, 'used_count must not pass max_uses');
    assert.deepEqual((await state(app)).status.sort(), ['applied', 'applied']);
    const alerts = await q(app, `SELECT kind FROM alerts WHERE tenant_id = $1 AND kind = 'coupon.over_limit'`, [app.tenant.id]);
    assert.equal(alerts.length, 1);
  } finally {
    app.close();
  }
});

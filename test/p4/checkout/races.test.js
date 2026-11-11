// Races (PRD 9.5, 9.12, 9.14): many checkouts at once for a few units, repeated taps, a payment arriving as its hold runs out.
// On PGlite these run one at a time; on Postgres (TEST_DATABASE_URL) they really overlap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expireHolds } from '../../../src/modules/inventory/stock.js';
import { ADDRESS, markPaid, orderByNumber, payments, place, placeBody, product, q, stockOf, storeApp, withSizes } from './support.js';

const phone = (n) => `91234${String(n).padStart(5, '0')}`;

test('S-16 ten shoppers at once for three units: exactly three orders, and stock never held past what is on hand', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 3 });
    const kurti = await product(app, { name: 'Kurti', stock: null });
    const sizes = await withSizes(app, kurti.id, [{ value: 'S', stock: 2 }]);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => place(app, placeBody(lamp.id, {
      lines: i % 2 ? [{ productId: lamp.id, variantId: null, qty: 1 }, { productId: kurti.id, variantId: sizes.S, qty: 1 }] : [{ productId: lamp.id, variantId: null, qty: 1 }],
      address: { ...ADDRESS, phone: phone(i) },
    }))));
    const won = results.filter((r) => r.status === 201);
    assert.equal(won.length, 3, results.map((r) => `${r.status}`).join(','));
    assert.ok(results.every((r) => r.status === 201 || (r.status === 409 && /Sold out/.test(r.json.error))));
    const [lampStock] = await q(app, 'SELECT stock, reserved FROM products WHERE tenant_id = $1 AND id = $2', [app.tenant.id, lamp.id]);
    assert.deepEqual(lampStock, { stock: 3, reserved: 3 });
    const [held] = await q(app, `SELECT COALESCE(sum(qty), 0)::int AS n FROM stock_reservations WHERE tenant_id = $1 AND product_id = $2 AND status = 'held'`, [app.tenant.id, kurti.id]);
    const [variant] = await q(app, 'SELECT stock, reserved FROM product_variants WHERE tenant_id = $1 AND id = $2', [app.tenant.id, sizes.S]);
    assert.equal(variant.reserved, held.n, 'what is held matches the holds');
    assert.ok(variant.reserved <= 2);
  } finally {
    app.close();
  }
});

test('S-15 five shoppers each tapping three times: five orders, one per attempt', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 20 });
    const bodies = Array.from({ length: 5 }, (_, i) => placeBody(lamp.id, { address: { ...ADDRESS, phone: phone(i) } }));
    const results = await Promise.all(bodies.flatMap((body) => [place(app, body), place(app, body), place(app, body)]));
    assert.ok(results.every((r) => [200, 201].includes(r.status)), results.map((r) => r.text).join(' | '));
    const numbers = new Set(results.map((r) => r.json.orderNumber));
    assert.equal(numbers.size, 5);
    assert.equal((await q(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]))[0].n, 5);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 20, reserved: 5 });
  } finally {
    app.close();
  }
});

test('S-39 a payment arriving as its hold runs out: the order ends paid, its stock taken once, whichever went first', async () => {
  const app = await storeApp();
  try {
    await payments(app, { holdMinutes: 30 });
    for (let round = 0; round < 3; round += 1) {
      const lamp = await product(app, { name: `Lamp ${round}`, stock: 1 });
      const res = await place(app, placeBody(lamp.id, { address: { ...ADDRESS, phone: phone(round) } }));
      const order = await orderByNumber(app, res.json.orderNumber);
      await Promise.all([expireHolds(app.ctx, { now: new Date(Date.now() + 31 * 60_000) }), markPaid(app, order.id)]);
      await app.ctx.orderEvents.settle();
      const after = await orderByNumber(app, res.json.orderNumber);
      assert.deepEqual([after.payment_status, after.fulfilment_status, after.hold_reason], ['paid', 'new', null], `round ${round}`);
      assert.deepEqual(await stockOf(app, lamp.id), { stock: 0, reserved: 0 }, `round ${round}`);
      const moves = await q(app, 'SELECT delta, reason FROM stock_movements WHERE tenant_id = $1 AND product_id = $2', [app.tenant.id, lamp.id]);
      assert.deepEqual(moves.map((m) => [m.delta, m.reason]), [[-1, 'sale']], `round ${round}`);
    }
  } finally {
    app.close();
  }
});

test('S-47 a coupon with one use left, tried by five checkouts at once, discounts exactly one', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    await q(app, `INSERT INTO coupons (tenant_id, code, kind, amount_paise, max_uses, used_count) VALUES ($1, 'LAST', 'flat', 5000, 3, 2)`, [app.tenant.id]);
    const lamp = await product(app, { stock: null });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => place(app, placeBody(lamp.id, { couponCode: 'LAST', address: { ...ADDRESS, phone: phone(i) } }))));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    const [{ used_count: used }] = await q(app, `SELECT used_count FROM coupons WHERE tenant_id = $1 AND code = 'LAST'`, [app.tenant.id]);
    assert.equal(used, 3);
    assert.equal((await q(app, `SELECT count(*)::int AS n FROM coupon_redemptions WHERE tenant_id = $1 AND status = 'applied'`, [app.tenant.id]))[0].n, 1);
  } finally {
    app.close();
  }
});

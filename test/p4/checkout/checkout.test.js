// Checkout and order creation (PRD 9.4, 9.5): the server prices everything, one order per attempt, the last unit sold once,
// guest and cash-on-delivery rules, the order's source, and the shared limit on attempts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../../../src/server.js';
import {
  ADDRESS, hit, inTenant, noPlatformName, orderByNumber, payments, place, placeBody, product, q, quote, shopper, stockOf, storeApp, withSizes,
} from './support.js';

test('S-05 checkout uses the database price: a price in the body is refused, and the order is priced from the catalog', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { pricePaise: 50000 });
    const forged = await place(app, placeBody(lamp.id, { lines: [{ productId: lamp.id, variantId: null, qty: 1, pricePaise: 100 }] }));
    assert.equal(forged.status, 400, 'an unknown field in a line is refused, not ignored');
    assert.equal(forged.json.code, 'validation_failed');
    const total = await place(app, { ...placeBody(lamp.id), totalPaise: 100 });
    assert.equal(total.status, 400);
    assert.equal((await q(app, 'SELECT count(*)::int AS n FROM orders'))[0].n, 0);

    // The page saw ₹500; the seller changed the price before the order: the order takes the database's price.
    const seen = await quote(app, { lines: [{ productId: lamp.id, variantId: null, qty: 2 }] });
    assert.equal(seen.json.totalPaise, 100000);
    await q(app, 'UPDATE products SET price_paise = 45000 WHERE tenant_id = $1 AND id = $2', [app.tenant.id, lamp.id]);
    const res = await place(app, placeBody(lamp.id, { lines: [{ productId: lamp.id, variantId: null, qty: 2 }] }));
    assert.equal(res.status, 201, res.text);
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.equal(Number(order.subtotal_paise), 90000);
    assert.equal(Number(order.total_paise), 90000);
    assert.equal(order.flow, 'checkout');
    const [line] = await q(app, 'SELECT price_paise, qty FROM order_items WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, order.id]);
    assert.deepEqual([Number(line.price_paise), line.qty], [45000, 2]);
  } finally {
    app.close();
  }
});

test('S-15 double-tapping Place order makes exactly one order, and the same key again answers with it', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 5 });
    const body = placeBody(lamp.id);
    const [a, b] = await Promise.all([place(app, body), place(app, body)]);
    assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status), `${a.text} ${b.text}`);
    assert.equal(a.json.orderNumber, b.json.orderNumber);
    assert.equal(a.json.token, b.json.token);
    const again = await place(app, body);
    assert.equal(again.status, 200);
    assert.equal(again.json.orderNumber, a.json.orderNumber);
    assert.equal((await q(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]))[0].n, 1);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 5, reserved: 1 }, 'one hold, not two');
    // Another phone can't read back an order by a key it didn't make.
    const stranger = await place(app, { ...body, address: { ...ADDRESS, phone: '9123456789' } });
    assert.equal(stranger.status, 409);
    assert.equal(stranger.json.token, undefined);
  } finally {
    app.close();
  }
});

test('S-16 two shoppers buy the last unit at once: one order, and the other sees Sold out', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 1 });
    const results = await Promise.all([
      place(app, placeBody(lamp.id, { address: { ...ADDRESS, phone: '9876500001' } })),
      place(app, placeBody(lamp.id, { address: { ...ADDRESS, phone: '9876500002' } })),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409], results.map((r) => r.text).join(' | '));
    const lost = results.find((r) => r.status === 409);
    assert.match(lost.json.error, /Sold out/);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 1, reserved: 1 });
    assert.equal((await q(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]))[0].n, 1);
  } finally {
    app.close();
  }
});

test('S-93 a guest pays by UPI with no sign-in and no code: the order waits for payment with its stock held', async () => {
  const app = await storeApp();
  try {
    await payments(app, { holdMinutes: 30 });
    const lamp = await product(app, { stock: 3 });
    const res = await place(app, placeBody(lamp.id));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.next, 'pay');
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.deepEqual([order.fulfilment_status, order.payment_status, order.payment_mode, order.shopper_id], ['pending', 'unpaid', 'prepaid', null]);
    assert.equal(order.phone, '+919876543210');
    const holdMinutes = (new Date(order.hold_expires_at) - new Date(order.created_at)) / 60_000;
    assert.ok(holdMinutes > 29 && holdMinutes < 31, `held for ${holdMinutes} minutes`);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 3, reserved: 1 });
    // No payments module answers yet: the order stands, and its page offers the payment.
    assert.equal(res.json.gateway, null);
    const page = await hit(app, `/order/${res.json.token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Waiting for payment/);
    assert.match(page.text, /data-pay/);
  } finally {
    app.close();
  }
});

test('S-94 a guest choosing cash on delivery is asked for the code first, and the order is made only once the phone is proved', async () => {
  const app = await storeApp();
  try {
    await payments(app, { cod: true, codFeePaise: 3000 });
    const lamp = await product(app, { stock: 2 });
    const body = placeBody(lamp.id, { paymentMode: 'cod' });
    const first = await place(app, body);
    assert.equal(first.status, 200);
    assert.deepEqual([first.json.next, first.json.orderNumber], ['verify_phone', '']);
    assert.equal((await q(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]))[0].n, 0, 'no order before the code');

    // The shoppers module answers whether this phone proved itself for this attempt.
    const asked = [];
    app.ctx.shoppers = { otps: { codVerified: async (args) => (asked.push(args), args.checkoutKey === body.idempotencyKey && args.phone === '+919876543210') } };
    const second = await place(app, body);
    assert.equal(second.status, 201, second.text);
    assert.equal(second.json.next, 'done');
    assert.deepEqual(asked.at(-1), { phone: '+919876543210', checkoutKey: body.idempotencyKey });
    const order = await orderByNumber(app, second.json.orderNumber);
    assert.deepEqual([order.fulfilment_status, order.payment_status], ['new', 'cod_due']);
    assert.deepEqual([Number(order.cod_fee_paise), Number(order.total_paise), Number(order.balance_paise)], [3000, 53000, 53000]);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 1, reserved: 0 }, 'cash on delivery takes its stock when placed');
  } finally {
    app.close();
  }
});

test('S-95 while the COD code is not proved (three wrong tries), no order is made and paying online still works', async () => {
  const app = await storeApp();
  try {
    await payments(app, { cod: true });
    const lamp = await product(app, { stock: 2 });
    app.ctx.shoppers = { otps: { codVerified: async () => false } };
    const body = placeBody(lamp.id, { paymentMode: 'cod' });
    for (let i = 0; i < 3; i += 1) assert.equal((await place(app, body)).json.next, 'verify_phone');
    assert.equal((await q(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]))[0].n, 0);
    assert.deepEqual(await stockOf(app, lamp.id), { stock: 2, reserved: 0 });
    const online = await place(app, { ...body, paymentMode: 'prepaid', idempotencyKey: crypto.randomUUID() });
    assert.equal(online.status, 201);
  } finally {
    app.close();
  }
});

test('S-94 a signed-in shopper whose number is verified skips the code for cash on delivery', async () => {
  const app = await storeApp();
  try {
    await payments(app, { cod: true });
    const lamp = await product(app, { stock: 2 });
    const asha = await shopper(app, { phone: '+919876543210' });
    const res = await place(app, placeBody(lamp.id, { paymentMode: 'cod' }), { cookie: asha.cookie });
    assert.equal(res.status, 201, res.text);
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.equal(order.shopper_id, asha.id);
    // Another number than the verified one still needs its code.
    const other = await place(app, placeBody(lamp.id, { paymentMode: 'cod', address: { ...ADDRESS, phone: '9123456780' } }), { cookie: asha.cookie });
    assert.equal(other.json.next, 'verify_phone');
  } finally {
    app.close();
  }
});

test('S-21 part-advance: ₹100 advance on ₹999 is charged online, and ₹899 is what the courier collects', async () => {
  const app = await storeApp();
  try {
    await payments(app, { partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
    const saree = await product(app, { pricePaise: 99900, stock: 3 });
    const seen = await quote(app, { lines: [{ productId: saree.id, variantId: null, qty: 1 }], paymentMode: 'part_advance' });
    assert.deepEqual([seen.json.totalPaise, seen.json.advancePaise, seen.json.balancePaise], [99900, 10000, 89900]);
    const res = await place(app, placeBody(saree.id, { paymentMode: 'part_advance' }));
    assert.equal(res.status, 201, res.text);
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.deepEqual([Number(order.advance_paise), Number(order.balance_paise), order.fulfilment_status, order.payment_status], [10000, 89900, 'pending', 'unpaid']);
  } finally {
    app.close();
  }
});

test('S-22 an order above the COD cap: cash on delivery is unavailable, with the reason, and placing it that way is refused', async () => {
  const app = await storeApp();
  try {
    await payments(app, { cod: true, codMaxPaise: 200000 });
    const tv = await product(app, { pricePaise: 250000, stock: 3 });
    const seen = await quote(app, { lines: [{ productId: tv.id, variantId: null, qty: 1 }] });
    const cod = seen.json.paymentModes.find((m) => m.mode === 'cod');
    assert.equal(cod.available, false);
    assert.match(cod.reason, /up to ₹2,000/);
    assert.equal(seen.json.paymentModes.find((m) => m.mode === 'prepaid').available, true);
    app.ctx.shoppers = { otps: { codVerified: async () => true } };
    const res = await place(app, placeBody(tv.id, { paymentMode: 'cod' }));
    assert.equal(res.status, 409);
    assert.match(res.json.error, /up to ₹2,000/);
  } finally {
    app.close();
  }
});

test('S-12 a PIN starting with 0 is refused with the PIN message', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app);
    const res = await place(app, placeBody(lamp.id, { address: { ...ADDRESS, pincode: '012345' } }));
    assert.equal(res.status, 400);
    assert.equal(res.json.fields['address.pincode'], 'Enter a 6-digit PIN code');
  } finally {
    app.close();
  }
});

test('S-13 a signed-in shopper\'s default address is chosen on the checkout page; S-14 the order keeps its own copy', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app);
    const asha = await shopper(app);
    const rows = await q(
      app,
      `INSERT INTO shopper_addresses (tenant_id, shopper_id, name, phone, line1, city, state_code, pincode, is_default)
       VALUES ($1, $2, 'Asha Rao', '+919876543210', '1 First Street', 'Pune', '27', '411001', false), ($1, $2, 'Asha Rao', '+919876543210', '2 Second Street', 'Mumbai', '27', '400001', true)
       RETURNING id`,
      [app.tenant.id, asha.id],
    );
    const page = await hit(app, '/checkout', { cookie: asha.cookie });
    assert.equal(page.status, 200);
    const checked = /<input type="radio" name="addressId" value="(\d+)"[^>]*checked>/.exec(page.text);
    assert.equal(Number(checked?.[1]), rows[1].id, 'the default, though it was saved second');

    const res = await place(app, { ...placeBody(lamp.id), address: undefined, addressId: rows[1].id }, { cookie: asha.cookie });
    assert.equal(res.status, 201, res.text);
    await q(app, `UPDATE shopper_addresses SET line1 = '99 New Road', city = 'Nashik' WHERE tenant_id = $1 AND id = $2`, [app.tenant.id, rows[1].id]);
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.deepEqual([order.shipping_address.line1, order.shipping_address.city, order.city], ['2 Second Street', 'Mumbai', 'Mumbai']);
    // Someone else's saved address can't be used.
    const other = await shopper(app, { phone: '+919000011111' });
    const theirs = await place(app, { ...placeBody(lamp.id), address: undefined, addressId: rows[1].id }, { cookie: other.cookie });
    assert.equal(theirs.status, 400);
  } finally {
    app.close();
  }
});

test('S-17 an order after a DM link for reel X has reel X as its source', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app);
    const reel = await inTenant(app, () => app.platform.reels.save('17900000000000001', { headline: 'Lamp reel', keywords: 'LAMP', productIds: [lamp.id], active: 'on' }));
    const [page] = await q(app, 'SELECT id, slug FROM reels WHERE tenant_id = $1 AND ig_media_id = $2', [app.tenant.id, '17900000000000001']);
    assert.ok(page && reel);
    const res = await place(app, placeBody(lamp.id, { pageSlug: page.slug, utm: { utm_source: 'instagram', utm_medium: 'dm', utm_campaign: 'lamp' } }));
    assert.equal(res.status, 201, res.text);
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.deepEqual([order.page_id, order.reel_id, order.source, order.utm.utm_campaign], [page.id, '17900000000000001', 'dm', 'lamp']);
    // A page slug that isn't this business's is not believed.
    const made = await place(app, placeBody(lamp.id, { pageSlug: 'someone-elses-reel' }));
    assert.equal((await orderByNumber(app, made.json.orderNumber)).page_id, null);
  } finally {
    app.close();
  }
});

test('S-18 the order-attempt limit holds across two instances: the 21st attempt from one address in 10 minutes is refused', async () => {
  const app = await storeApp();
  const second = createApp({ db: app.db, config: app.config });
  const server = second.listen(0);
  const other = { port: server.address().port };
  try {
    await payments(app);
    const lamp = await product(app, { stock: null });
    for (let i = 0; i < 20; i += 1) {
      const res = await place(i % 2 ? other : app, placeBody(lamp.id));
      assert.equal(res.status, 201, `attempt ${i + 1}: ${res.text}`);
    }
    const refused = await place(other, placeBody(lamp.id));
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers['retry-after']) > 0);
    assert.equal((await place(app, placeBody(lamp.id))).status, 429);
  } finally {
    server.close();
    app.close();
  }
});

test('S-45 GST is worked out on the discounted value, and every total adds up from its lines', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const kurta = await product(app, { pricePaise: 105000, gstRateBp: 500, stock: 5 });
    const dupatta = await product(app, { name: 'Dupatta', pricePaise: 95000, gstRateBp: 1200, stock: 5 });
    await inTenant(app, () => app.db.query(`INSERT INTO coupons (tenant_id, code, kind, percent_bp, max_discount_paise) VALUES ($1, 'REEL10', 'percent', 1000, 15000)`, [app.tenant.id]));
    const lines = [{ productId: kurta.id, variantId: null, qty: 1 }, { productId: dupatta.id, variantId: null, qty: 1 }];
    const res = await place(app, placeBody(kurta.id, { lines, couponCode: 'reel10' }));
    assert.equal(res.status, 201, res.text);
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.deepEqual([Number(order.subtotal_paise), Number(order.discount_paise), Number(order.total_paise), order.coupon_code], [200000, 15000, 185000, 'REEL10']);
    const items = await q(app, 'SELECT price_paise, qty, discount_paise, tax_paise, gst_rate_bp FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [app.tenant.id, order.id]);
    assert.equal(items.reduce((s, i) => s + Number(i.discount_paise), 0), 15000, 'the shares add up to the discount');
    // 15000 split 105000:95000 is 7875 and 7125; GST inside what is left.
    assert.deepEqual(items.map((i) => Number(i.discount_paise)), [7875, 7125]);
    const inside = (gross, bp) => gross - Math.round((gross * 10000) / (10000 + bp));
    assert.deepEqual(items.map((i) => Number(i.tax_paise)), [inside(105000 - 7875, 500), inside(95000 - 7125, 1200)]);
    assert.equal(Number(order.tax_paise), items.reduce((s, i) => s + Number(i.tax_paise), 0));
  } finally {
    app.close();
  }
});

test('one business never sells another business\'s product: its id in a bag is not available', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const { otherStore } = await import('./support.js');
    const other = await otherStore(app);
    const theirs = await product(app, { tenant: other.tenant, stock: 5 });
    const res = await place(app, placeBody(theirs.id));
    assert.equal(res.status, 409);
    assert.equal(res.json.quote.lines[0].state, 'inactive');
    assert.equal(res.json.quote.lines[0].name, '', 'nothing of the other business is shown');
    assert.deepEqual(await stockOf(app, theirs.id, other.tenant), { stock: 5, reserved: 0 });
  } finally {
    app.close();
  }
});

test('S-40 options carry their own stock: a sold-out size is refused, another size can be ordered', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const kurti = await product(app, { pricePaise: 70000, stock: null });
    const sizes = await withSizes(app, kurti.id, [{ value: 'M', stock: 0 }, { value: 'L', stock: 3, pricePaise: 72000 }]);
    const seen = await quote(app, { lines: [{ productId: kurti.id, variantId: sizes.M, qty: 1 }, { productId: kurti.id, variantId: sizes.L, qty: 1 }] });
    assert.deepEqual(seen.json.lines.map((l) => [l.option, l.state]), [['M', 'sold_out'], ['L', 'ok']]);
    assert.equal(seen.json.totalPaise, 72000);
    const noOption = await quote(app, { lines: [{ productId: kurti.id, variantId: null, qty: 1 }] });
    assert.equal(noOption.json.lines[0].state, 'inactive', 'a product with options needs one chosen');
    assert.equal((await place(app, placeBody(kurti.id, { lines: [{ productId: kurti.id, variantId: sizes.M, qty: 1 }] }))).status, 409);
    const res = await place(app, placeBody(kurti.id, { lines: [{ productId: kurti.id, variantId: sizes.L, qty: 2 }] }));
    assert.equal(res.status, 201, res.text);
    const { variantStock } = await import('./support.js');
    assert.deepEqual(await variantStock(app, sizes.L), { stock: 3, reserved: 2 });
    assert.deepEqual(await stockOf(app, kurti.id), { stock: null, reserved: 0 });
  } finally {
    app.close();
  }
});

test('a changed bag is never placed silently: a line capped to what is left is refused with the new quote', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 2 });
    const res = await place(app, placeBody(lamp.id, { lines: [{ productId: lamp.id, variantId: null, qty: 3 }] }));
    assert.equal(res.status, 409);
    assert.equal(res.json.quote.lines[0].state, 'capped');
    assert.equal(res.json.quote.lines[0].qty, 2);
    assert.match(res.json.quote.notices.join(' '), /Only 2 left/);
  } finally {
    app.close();
  }
});

test('checkout refuses what it can\'t take: online payment not set up, no terms, an email too long to be one', async () => {
  const app = await storeApp();
  try {
    const lamp = await product(app);
    const notReady = await place(app, placeBody(lamp.id));
    assert.equal(notReady.status, 409);
    assert.match(notReady.json.error, /Online payment isn’t available/);
    await payments(app);
    const noTerms = await place(app, { ...placeBody(lamp.id), acceptTerms: false });
    assert.equal(noTerms.status, 400);
    const started = Date.now();
    const long = await place(app, placeBody(lamp.id, { email: `${'a'.repeat(60000)}@` }));
    assert.equal(long.status, 400);
    assert.ok(Date.now() - started < 2000);
    const notJson = await hit(app, '/api/store/checkout', { method: 'POST', body: 'lines=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(notJson.status, 415);
    const crossSite = await place(app, placeBody(lamp.id), { headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
    assert.equal((await q(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]))[0].n, 0);
  } finally {
    app.close();
  }
});

test('S-71 the checkout and order pages carry the seller\'s brand only; a business without the store keeps the Phase 0 checkout', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app);
    const page = await hit(app, '/checkout');
    assert.equal(page.status, 200);
    assert.match(page.text, /Neel Studio/);
    assert.ok(noPlatformName(page.text), 'no platform name on the checkout page');
    assert.match(page.text, /href="\/policies\/terms"/);
    const res = await place(app, placeBody(lamp.id));
    const order = await hit(app, `/order/${res.json.token}`);
    assert.equal(order.status, 200);
    assert.match(order.text, /Neel Studio/);
    assert.ok(noPlatformName(order.text) && noPlatformName(JSON.stringify(order.headers)));
    assert.equal((await hit(app, '/order/not-a-real-token-at-all')).status, 404);

    const { otherStore } = await import('./support.js');
    const basic = await otherStore(app, { slug: 'basic', name: 'Basic Shop', plan: 'free' });
    const old = await hit(app, '/checkout', { host: basic.host });
    assert.notEqual(old.status, 200, 'the Phase 0 checkout still asks a free-plan shopper to sign in');
    const call = await hit(app, '/api/store/checkout/quote', { method: 'POST', host: basic.host, body: { lines: [{ productId: lamp.id, variantId: null, qty: 1 }] } });
    assert.equal(call.status, 404);
  } finally {
    app.close();
  }
});

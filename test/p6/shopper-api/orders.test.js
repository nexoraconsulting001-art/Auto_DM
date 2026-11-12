// The shopper's orders in the app (PRD 10.7): the list and one order, one-tap reorder at today's prices (P-64), app-only
// coupons (P-63) and the order's channel, which only the server sets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppOrder, AppOrderState, AppOrderSummary, AppReorder } from '../../../src/contracts/store-routes.js';
import { APP_ONLY_MESSAGE } from '../../../src/modules/coupons/rules.js';
import { OWNER, shopperApp } from '../../helpers.js';
import { hit, shopper } from '../../p4/checkout/support.js';
import { as, signedIn } from '../../p4/engagement/support.js';
import {
  ADDRESS, appWorld, assertBrandOnly, guestApp, json, markPaid, orderByNumber, payments, placeBody, product, q, signedInApp, withSizes,
} from './support.js';

const PHONE = '9876543210';
const OTHER_PHONE = '9811111111';
const line = (p, qty = 1, variantId = null) => ({ productId: p.id ?? p, variantId, qty });
const count = async (app, table) => (await app.db.platform.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [app.tenant.id]))[0].n;

/** Places an order in the app and gives its row. */
async function placeInApp(w, a, lines, over = {}) {
  const res = await json(await a.fetch('/api/store/checkout', { method: 'POST', body: placeBody(lines[0].productId, { lines, ...over }) }));
  assert.equal(res.status, 201, `placing an order in the app: ${res.text}`);
  return orderByNumber(w.app, res.body.orderNumber);
}

test('P-64: reorder fills the cart at today’s price, names what is gone, preselects the saved address and places nothing', async () => {
  const w = await appWorld();
  try {
    const tid = w.app.tenant.id;
    await payments(w.app);
    const lamp = await product(w.app, { name: 'Brass lamp', pricePaise: 50000, stock: 5 });
    const vase = await product(w.app, { name: 'Clay vase', pricePaise: 30000, stock: 5 });
    const shawl = await product(w.app, { name: 'Wool shawl', pricePaise: 120000, stock: 5 });
    const tee = await product(w.app, { name: 'Block tee', pricePaise: 80000, stock: null });
    const sizes = await withSizes(w.app, tee.id, [{ value: 'M', pricePaise: 80000, stock: 5 }, { value: 'L', pricePaise: 85000, stock: 5 }]);

    const a = await signedInApp(w, { phone: PHONE });
    const work = await json(await a.fetch('/api/store/addresses', { method: 'POST', body: { ...ADDRESS, name: 'Asha Office', line1: '9 Mill Lane', pincode: '411002', isDefault: false } }));
    assert.equal(work.status, 201, work.text);
    const home = await json(await a.fetch('/api/store/addresses', { method: 'POST', body: { ...ADDRESS } }));
    assert.equal(home.status, 201, home.text);

    const order = await placeInApp(w, a, [line(lamp, 2), line(vase), line(shawl), line(tee, 1, sizes.M)]);
    assert.equal(order.channel, 'app', 'an order placed in the app is the app’s');
    await markPaid(w.app, order.id);

    // Today: the lamp costs more, the vase is sold out, the shawl is off the shelf, the tee's size costs more.
    await q(w.app, 'UPDATE products SET price_paise = 55000 WHERE tenant_id = $1 AND id = $2', [tid, lamp.id]);
    await q(w.app, 'UPDATE products SET in_stock = false WHERE tenant_id = $1 AND id = $2', [tid, vase.id]);
    await q(w.app, 'UPDATE products SET active = false WHERE tenant_id = $1 AND id = $2', [tid, shawl.id]);
    await q(w.app, 'UPDATE product_variants SET price_paise = 82000 WHERE tenant_id = $1 AND id = $2', [tid, sizes.M]);

    const ordersBefore = await count(w.app, 'orders');
    const paymentsBefore = await count(w.app, 'payments');
    // The route takes no amount: whatever a caller sends is not read.
    const res = await json(await a.fetch(`/api/store/app/orders/${encodeURIComponent(order.order_number)}/reorder`, {
      method: 'POST', body: { lines: [{ productId: lamp.id, variantId: null, qty: 9, unitPaise: 1 }], totalPaise: 1, channel: 'web' },
    }));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = AppReorder.parse(res.body);
    assertBrandOnly(res.text, 'reorder');

    const byName = Object.fromEntries(body.lines.map((l) => [l.name, l]));
    assert.deepEqual(Object.keys(byName).sort(), ['Block tee', 'Brass lamp'], 'only what can be bought today');
    assert.deepEqual([byName['Brass lamp'].qty, byName['Brass lamp'].unitPaise, byName['Brass lamp'].linePaise], [2, 55000, 110000], 'today’s price, the old quantity');
    assert.deepEqual([byName['Block tee'].variantId, byName['Block tee'].unitPaise, byName['Block tee'].option], [sizes.M, 82000, 'M'], 'the variant at today’s price');
    assert.equal(body.added, 2);
    assert.deepEqual(body.missing.map((m) => [m.name, m.reason]).sort(), [['Clay vase', 'sold_out'], ['Wool shawl', 'inactive']], 'what is gone is named');
    assert.ok(body.notices.some((n) => /2 items can’t be ordered again/.test(n)), JSON.stringify(body.notices));
    assert.ok(body.notices.some((n) => /prices have changed/.test(n)), 'the shopper is told prices changed');
    assert.equal(body.addressId, home.body.address.id, 'the address the order went to is preselected');

    // Nothing was ordered or paid: the cart holds the lines, at today's prices.
    assert.equal(await count(w.app, 'orders'), ordersBefore, 'reorder never places an order');
    assert.equal(await count(w.app, 'payments'), paymentsBefore);
    const cart = await json(await a.fetch('/api/store/cart'));
    assert.equal(cart.status, 200);
    assert.deepEqual(cart.body.lines.map((l) => [l.productId, l.variantId, l.qty, l.unitPaise]).sort(), [[lamp.id, null, 2, 55000], [tee.id, sizes.M, 1, 82000]].sort());

    // Tapping it again adds to the bag, held to today's stock: 5 lamps, 2 of them on the paid order.
    const again = await json(await a.fetch(`/api/store/app/orders/${encodeURIComponent(order.order_number)}/reorder`, { method: 'POST' }));
    assert.equal(again.status, 200);
    assert.equal(again.body.lines.find((l) => l.productId === lamp.id).qty, 3);
    assert.deepEqual(again.body.capped, [{ name: 'Brass lamp', qty: 3 }]);
    assert.ok(again.body.notices.includes('Brass lamp: only 3 can be ordered right now.'), JSON.stringify(again.body.notices));
    assert.equal(await count(w.app, 'orders'), ordersBefore);

    // Only the shopper's own order: another shopper, a guest, the web and another business get nothing.
    const other = await signedInApp(w, { phone: OTHER_PHONE });
    const theirs = await json(await other.fetch(`/api/store/app/orders/${encodeURIComponent(order.order_number)}/reorder`, { method: 'POST' }));
    assert.equal(theirs.status, 404);
    assertBrandOnly(theirs.text, 'not found');
    assert.deepEqual((await json(await other.fetch('/api/store/cart'))).body.lines, [], 'nothing reached the other shopper’s bag');
    const guest = await guestApp(w);
    assert.equal((await guest.fetch(`/api/store/app/orders/${encodeURIComponent(order.order_number)}/reorder`, { method: 'POST' })).status, 401);
    const web = await hit(w.app, `/api/store/app/orders/${encodeURIComponent(order.order_number)}/reorder`, { method: 'POST', cookie: (await shopper(w.app, { phone: `+91${PHONE}` })).cookie });
    assert.equal(web.status, 404, 'the web never reaches the app’s routes');
    const haldi = await w.addStore('haldi', 'Haldi House');
    const there = await signedInApp(w, { phone: PHONE, tenantId: haldi.tenant.id, host: haldi.host });
    assert.equal((await there.fetch(`/api/store/app/orders/${encodeURIComponent(order.order_number)}/reorder`, { method: 'POST' })).status, 404, 'another business’s order');
  } finally {
    await w.close();
  }
});

test('orders in the app: only this shopper’s, at this business; one order with its lines; an order by its token names no one', async () => {
  const w = await appWorld();
  try {
    await payments(w.app);
    const lamp = await product(w.app, { name: 'Brass lamp', pricePaise: 50000, stock: 9 });
    const a = await signedInApp(w, { phone: PHONE });
    const first = await placeInApp(w, a, [line(lamp)]);
    const second = await placeInApp(w, a, [line(lamp, 2)]);
    await markPaid(w.app, second.id);
    const b = await signedInApp(w, { phone: OTHER_PHONE });
    const theirs = await placeInApp(w, b, [line(lamp)]);

    const list = await json(await a.fetch('/api/store/app/orders?limit=1'));
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.items.map((o) => AppOrderSummary.parse(o).orderNumber), [second.order_number], 'newest first');
    assert.ok(list.body.nextCursor);
    const next = await json(await a.fetch(`/api/store/app/orders?limit=1&cursor=${list.body.nextCursor}`));
    assert.deepEqual(next.body.items.map((o) => o.orderNumber), [first.order_number]);
    assert.equal(next.body.nextCursor, null);
    assert.equal((await a.fetch('/api/store/app/orders?cursor=x%27')).status, 400);

    const one = await json(await a.fetch(`/api/store/app/orders/${encodeURIComponent(second.order_number)}`));
    assert.equal(one.status, 200, one.text);
    const order = AppOrder.parse(one.body);
    assert.deepEqual([order.totalPaise, order.itemCount, order.lines[0].unitPaise, order.lines[0].qty, order.paymentStatus], [100000, 2, 50000, 2, 'paid']);
    assert.equal(order.canReorder, true);
    assertBrandOnly(one.text, 'an order');
    assert.equal((await a.fetch(`/api/store/app/orders/${encodeURIComponent(theirs.order_number)}`)).status, 404, 'another shopper’s order');
    for (const junk of ['A%00B', 'x'.repeat(41), '%E2%80%8B']) {
      assert.equal((await a.fetch(`/api/store/app/orders/${junk}`)).status, 404, `junk order number ${junk.slice(0, 10)}`);
      assert.equal((await a.fetch(`/api/store/app/orders/${junk}/reorder`, { method: 'POST' })).status, 404);
    }

    // The payment tab's answer: state only, for any app session holding the token.
    const guest = await guestApp(w);
    const state = await json(await guest.fetch(`/api/store/app/order/${encodeURIComponent(first.public_token)}`));
    assert.equal(state.status, 200, state.text);
    AppOrderState.parse(state.body);
    assert.equal(state.body.next, 'pay');
    assert.ok(!state.text.includes(ADDRESS.line1) && !state.text.includes(PHONE) && !state.text.includes(ADDRESS.name), 'no name, phone or address');
    assert.equal((await guest.fetch('/api/store/app/order/not-a-real-token-at-all')).status, 404);
    assert.equal((await guest.fetch('/api/store/app/orders')).status, 401, 'a guest has no order list');
  } finally {
    await w.close();
  }
});

test('the channel is the server’s: an app order is the app’s, a web order is the web’s whatever it sends, and it never changes', async () => {
  const w = await appWorld();
  try {
    await payments(w.app);
    const lamp = await product(w.app, { pricePaise: 50000, stock: 9 });
    const asked = await hit(w.app, '/api/store/checkout', { method: 'POST', body: placeBody(lamp.id, { channel: 'app' }) });
    assert.equal(asked.status, 400, 'a body cannot name a channel');
    const web = await hit(w.app, '/api/store/checkout', { method: 'POST', body: placeBody(lamp.id) });
    assert.equal(web.status, 201, web.text);
    const webOrder = await orderByNumber(w.app, web.json.orderNumber);
    assert.equal(webOrder.channel, 'web');

    // The app's headers from a browser, with no app token, place nothing.
    const browser = shopperApp(w.app.base, { tenantId: w.app.tenant.id });
    const pretend = await browser.fetch('/api/store/checkout', { method: 'POST', body: placeBody(lamp.id) });
    assert.equal(pretend.status, 401);
    const forged = await browser.fetch('/api/store/checkout', { method: 'POST', body: placeBody(lamp.id), headers: { authorization: `Shopper sa_${'x'.repeat(43)}` } });
    assert.equal(forged.status, 401);

    const a = await guestApp(w);
    const appOrder = await placeInApp(w, a, [line(lamp)]);
    assert.equal(appOrder.channel, 'app');
    await assert.rejects(q(w.app, `UPDATE orders SET channel = 'app' WHERE tenant_id = $1 AND id = $2`, [w.app.tenant.id, webOrder.id]), /never changes/);
    await assert.rejects(q(w.app, `UPDATE orders SET channel = 'web' WHERE tenant_id = $1 AND id = $2`, [w.app.tenant.id, appOrder.id]), /never changes/);
  } finally {
    await w.close();
  }
});

test('P-63: an app-only coupon is rejected on the web store, works in the app, and the app’s header alone never claims it', async () => {
  const w = await appWorld();
  try {
    const tid = w.app.tenant.id;
    await payments(w.app);
    const lamp = await product(w.app, { pricePaise: 50000, stock: 9 });
    const login = await hit(w.app, '/api/v1/auth/login', { method: 'POST', body: OWNER });
    const token = login.json?.token;
    assert.ok(token, login.text);
    const made = await hit(w.app, '/api/v1/coupons', { method: 'POST', token, body: { code: 'APPLOVE', kind: 'flat', amountPaise: 5000, appOnly: true } });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.appOnly, true, 'the seller marks a coupon App only');
    const listed = await hit(w.app, '/api/v1/coupons', { token });
    assert.equal(listed.json.items.find((c) => c.code === 'APPLOVE').appOnly, true);

    const check = { code: 'applove', lines: [line(lamp)] };
    // The web store: a guest, and a signed-in shopper with a cookie.
    const webCheck = await hit(w.app, '/api/store/coupons/check', { method: 'POST', body: check });
    assert.equal(webCheck.status, 200, webCheck.text);
    assert.deepEqual([webCheck.json.applied, webCheck.json.message, webCheck.json.discountPaise], [false, APP_ONLY_MESSAGE, 0]);
    assert.equal(APP_ONLY_MESSAGE, 'This offer works only in the app');
    const placed = await hit(w.app, '/api/store/checkout', { method: 'POST', body: placeBody(lamp.id, { couponCode: 'APPLOVE' }) });
    assert.equal(placed.status, 409, placed.text);
    assert.equal(placed.json.error, APP_ONLY_MESSAGE);
    const asha = await signedIn(w.app, { phone: `+91${PHONE}` });
    const withCookie = await hit(w.app, '/api/store/checkout/quote', { method: 'POST', ...as(asha), body: { lines: [line(lamp)], couponCode: 'APPLOVE' } });
    assert.equal(withCookie.status, 200, withCookie.text);
    assert.deepEqual([withCookie.json.coupon.applied, withCookie.json.coupon.message, withCookie.json.discountPaise ?? 0], [false, APP_ONLY_MESSAGE, 0]);

    // The app's headers on a browser session, without an app token: refused before any coupon is looked at.
    // The browser's session is a good one, CSRF token and all: the app's headers alone never make it the app.
    const headers = { ...as(asha).headers, ...shopperApp(w.app.base, { tenantId: tid }).headers };
    const pretend = await hit(w.app, '/api/store/coupons/check', { method: 'POST', body: check, cookie: asha.cookie, headers });
    assert.equal(pretend.status, 401);
    const pretendPlace = await hit(w.app, '/api/store/checkout', { method: 'POST', body: placeBody(lamp.id, { couponCode: 'APPLOVE' }), cookie: asha.cookie, headers });
    assert.equal(pretendPlace.status, 401);
    const pretendQuote = await hit(w.app, '/api/store/checkout/quote', { method: 'POST', body: { lines: [line(lamp)], couponCode: 'APPLOVE' }, cookie: asha.cookie, headers });
    assert.equal(pretendQuote.status, 401);
    assert.equal(await count(w.app, 'coupon_redemptions'), 0);

    // In the app (a guest session is in the app too): it applies, and the order is the app's.
    const a = await guestApp(w);
    const appCheck = await json(await a.fetch('/api/store/coupons/check', { method: 'POST', body: check }));
    assert.equal(appCheck.status, 200, appCheck.text);
    assert.deepEqual([appCheck.body.applied, appCheck.body.discountPaise], [true, 5000]);
    const order = await placeInApp(w, a, [line(lamp)], { couponCode: 'APPLOVE' });
    assert.deepEqual([order.channel, Number(order.discount_paise), Number(order.total_paise)], ['app', 5000, 45000]);
    assert.equal(await count(w.app, 'coupon_redemptions'), 1);

    // The database's own lock: an app-only redemption on a web order is refused whatever the code does.
    const webOrder = await hit(w.app, '/api/store/checkout', { method: 'POST', body: placeBody(lamp.id) });
    assert.equal(webOrder.status, 201, webOrder.text);
    const row = await orderByNumber(w.app, webOrder.json.orderNumber);
    const [coupon] = await q(w.app, `SELECT id FROM coupons WHERE tenant_id = $1 AND code = 'APPLOVE'`, [tid]);
    await assert.rejects(
      q(w.app, `INSERT INTO coupon_redemptions (tenant_id, coupon_id, order_id, customer_key, discount_paise) VALUES ($1, $2, $3, 'k', 5000)`, [tid, coupon.id, row.id]),
      /works only in the app/,
    );

    // Off again, it is an ordinary code on the web.
    const off = await hit(w.app, `/api/v1/coupons/${coupon.id}`, { method: 'PATCH', token, body: { appOnly: false } });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.appOnly, false);
    const now = await hit(w.app, '/api/store/coupons/check', { method: 'POST', body: check });
    assert.equal(now.json.applied, true);
  } finally {
    await w.close();
  }
});

// PRD 9.21: loyalty points. A ledger that never goes below zero, points earned and taken back through order events exactly
// once, redemptions capped and checked again inside the order's transaction so parallel checkouts can't overspend, and the
// whole program behind the `loyalty` add-on.
import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointsFor, redeemable, keptAfterRefund, addressKey, dueToExpire } from '../../../src/modules/loyalty/rules.js';
import {
  ADDRESS, OWNER, accountOf, advance, as, consoleApi, delivered, hit, ledgerOf, loyaltyOn, markPaid, member, one, orderByNumber, ordered, otherShop, payments,
  place, placeBody, product, rows, setFeature, setPlan, signedIn, storeApp, textOf, noPlatformName, withTenant,
} from './support.js';

const quote = (app, who, body) => hit(app, '/api/store/checkout/quote', { method: 'POST', body: { lines: [], ...body }, ...(who ? as(who) : {}) });
const line = (p) => ({ productId: p.id, variantId: null, qty: 1 });
const loyalty = (app) => app.ctx.loyalty;
const inShop = (app, fn) => withTenant(app.tenant, fn);
/** Makes an order's pending points due now, as if its return window had passed. */
const windowPassed = (app, orderId) => rows(app, `UPDATE loyalty_ledger SET available_at = now() - interval '1 minute' WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending'`, [app.tenant.id, orderId]);
const returnsWindow = (app, days) => rows(app, `INSERT INTO return_settings (tenant_id, enabled, window_days) VALUES ($1, true, $2) ON CONFLICT (tenant_id) DO UPDATE SET enabled = true, window_days = $2`, [app.tenant.id, days]);

async function world({ cod = false } = {}) {
  const app = await storeApp();
  await payments(app, { cod });
  return app;
}

test('the arithmetic: points per amount, the cap and its notice, what a refund leaves, one address, and FIFO expiry', () => {
  assert.equal(pointsFor(100000, { earnPoints: 1, earnPerPaise: 10000 }), 10, 'S-87: Rs 1,000 at 1 per Rs 100');
  assert.equal(pointsFor(99999, { earnPoints: 1, earnPerPaise: 10000 }), 9);
  assert.equal(pointsFor(0, { earnPoints: 1, earnPerPaise: 10000 }), 0);
  assert.equal(pointsFor(5_000_000_000_000, { earnPoints: 2_000_000_000, earnPerPaise: 1 }), 100_000_000, 'never more than one entry may hold');
  const capped = redeemable({ requested: 120, balance: 200, cap: 50, pointValuePaise: 100, orderPaise: 100000 });
  assert.deepEqual([capped.points, capped.valuePaise], [50, 5000]);
  assert.match(capped.notice, /up to 50 points/);
  assert.equal(redeemable({ requested: 500, balance: 200, cap: 1000, pointValuePaise: 100, orderPaise: 100000 }).points, 200);
  assert.equal(redeemable({ requested: 500, balance: 2000, cap: 1000, pointValuePaise: 100, orderPaise: 30000 }).points, 300, 'never more than the items are worth');
  assert.equal(redeemable({ requested: 10, balance: 200, cap: 0, pointValuePaise: 100, orderPaise: 100000 }).points, 0, 'a cap of 0 turns redemption off');
  assert.equal(redeemable({ requested: -5, balance: 200, cap: 50, pointValuePaise: 100, orderPaise: 100000 }).points, 0);
  assert.equal(redeemable({ requested: 10, balance: -3, cap: 50, pointValuePaise: 100, orderPaise: 100000 }).points, 0);
  assert.equal(keptAfterRefund(10, 100000, 100000), 0);
  assert.equal(keptAfterRefund(10, 100000, 20000), 8);
  assert.equal(keptAfterRefund(10, 0, 0), 10);
  assert.equal(addressKey({ line1: '12 Lake Road', pincode: '411001' }), addressKey({ line1: '12, LAKE  road.', pincode: '411 001' }));
  assert.notEqual(addressKey({ line1: '12 Lake Road', pincode: '411001' }), addressKey({ line1: '14 Lake Road', pincode: '411001' }));
  assert.equal(addressKey({ line1: '', pincode: '411001' }), '');
  assert.equal(dueToExpire({ expiredCredit: 100, debits: 30 }), 70);
  assert.equal(dueToExpire({ expiredCredit: 100, debits: 130 }), 0);
});

test('S-91: without the add-on every loyalty route is 403, the points page is the store’s 404, nothing is earned or spent', async () => {
  const app = await world();
  try {
    const api = await consoleApi(app);
    for (const [method, path, body] of [['GET', '/loyalty/settings'], ['PATCH', '/loyalty/settings', { enabled: true }], ['GET', '/loyalty/members'], ['GET', '/loyalty/referrals'],
      ['POST', '/loyalty/members/1/adjust', { points: 10, note: 'x' }], ['GET', '/loyalty/members/1/ledger']]) {
      const res = await api(method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.json.reason, 'plan');
    }
    const lamp = await product(app, { pricePaise: 100000, stock: 5 });
    const asha = await signedIn(app);
    assert.equal((await hit(app, '/account/points', as(asha))).status, 404);
    assert.doesNotMatch(textOf((await hit(app, '/account', as(asha))).text), /\bpoints\b|refer a friend/i);
    const q = await quote(app, asha, { lines: [line(lamp)], redeemPoints: 50 });
    assert.equal(q.json.pointsUsed, 0);
    const order = await ordered(app, asha, lamp.id);
    await markPaid(app, order.id);
    assert.deepEqual(await ledgerOf(app, asha.id), []);

    // The add-on for this business only (tier 3), and tier 4 has it in its plan.
    await setFeature(app, 'loyalty', true);
    const on = await api('GET', '/loyalty/settings');
    assert.equal(on.status, 200);
    assert.deepEqual([on.json.available, on.json.enabled, on.json.maxRedeemPoints], [true, false, 0]);
    assert.equal((await hit(app, '/account/points', as(asha))).status, 404, 'the program is not enabled yet');
    await setFeature(app, 'loyalty', false);
    await setPlan(app, app.tenant.id, 't4');
    assert.equal((await api('GET', '/loyalty/settings')).status, 403, 'a tenant_features row turning it off wins over the plan');
    await rows(app, 'DELETE FROM tenant_features WHERE tenant_id = $1', [app.tenant.id]);
    assert.equal((await api('GET', '/loyalty/settings')).status, 200, 'tier 4 includes it');
  } finally {
    app.close();
  }
});

test('settings: managers change them, staff can’t, bad numbers are refused, and every change is in the audit log', async () => {
  const app = await world();
  try {
    await setFeature(app, 'loyalty', true);
    const api = await consoleApi(app);
    const saved = await api('PATCH', '/loyalty/settings', { enabled: true, earnPoints: 2, earnPerPaise: 5000, expiryDays: 90, referralEnabled: true, referrerPoints: 100 });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual([saved.json.earnPoints, saved.json.earnPerPaise, saved.json.expiryDays, saved.json.pointValuePaise], [2, 5000, 90, 100]);
    const partial = await api('PATCH', '/loyalty/settings', { maxRedeemPoints: 500 });
    assert.deepEqual([partial.json.earnPoints, partial.json.maxRedeemPoints], [2, 500], 'a partial change kept the rest');
    for (const bad of [{ earnPerPaise: 0 }, { pointValuePaise: 0 }, { expiryDays: 0 }, { earnPoints: -1 }, { earnPoints: 1.5 }, { maxRedeemPoints: 200_000_000 }]) {
      assert.equal((await api('PATCH', '/loyalty/settings', bad)).status, 400, JSON.stringify(bad));
    }
    const manager = await member(app, { role: 'manager' });
    assert.equal((await manager('PATCH', '/loyalty/settings', { earnPoints: 3 })).status, 200);
    const staff = await member(app, { role: 'staff', permissions: ['customers', 'orders'], phone: '9111100003' });
    assert.equal((await staff('PATCH', '/loyalty/settings', { earnPoints: 9 })).status, 403);
    assert.equal((await staff('GET', '/loyalty/members')).status, 200);
    const audit = await rows(app, `SELECT action, details FROM audit_log WHERE tenant_id = $1 AND action = 'loyalty.settings_updated' ORDER BY id`, [app.tenant.id]);
    assert.equal(audit.length, 3);
    assert.deepEqual(audit[2].details, { earnPoints: 3 });
  } finally {
    app.close();
  }
});

test('S-87: Rs 1,000 paid at 1 per Rs 100 earns 10 pending points that post once the return window closes, exactly once', async () => {
  const app = await world();
  try {
    await loyaltyOn(app);
    await returnsWindow(app, 7);
    const lamp = await product(app, { pricePaise: 100000, stock: 5 });
    const asha = await signedIn(app);

    const unpaid = await ordered(app, asha, lamp.id);
    await app.ctx.orderEvents.settle();
    assert.deepEqual(await ledgerOf(app, asha.id), [], 'an unpaid order earned points');
    await delivered(app, null, lamp.id);
    assert.equal((await rows(app, 'SELECT count(*)::int AS n FROM loyalty_ledger WHERE tenant_id = $1', [app.tenant.id]))[0].n, 0, 'a guest order earned points');

    const order = await ordered(app, asha, lamp.id);
    await markPaid(app, order.id);
    let [earn] = await ledgerOf(app, asha.id);
    assert.deepEqual([earn.kind, earn.points, earn.status, earn.available_at, earn.entry_key], ['earn', 10, 'pending', null, `earn:order:${order.id}`]);
    assert.deepEqual(await accountOf(app, asha.id), { balance: 0, pending: 10 });
    const page = await hit(app, '/account/points', as(asha));
    assert.equal(page.status, 200);
    assert.match(textOf(page.text), /10 points more are on the way/);
    assert.ok(noPlatformName(page.text) && noPlatformName(JSON.stringify(page.headers)), 'the points page names the platform');

    // Not delivered: nothing is due, however long it waits.
    assert.equal((await loyalty(app).sweep()).posted, 0);
    await advance(app, order.id, ['packed', 'shipped', 'delivered']);
    [earn] = await ledgerOf(app, asha.id);
    const row = await orderByNumber(app, order.order_number);
    assert.equal(new Date(earn.available_at).getTime() - new Date(row.delivered_at).getTime(), 7 * 86_400_000, 'due when the 7-day window closes');
    assert.equal((await loyalty(app).sweep()).posted, 0, 'posted inside the return window');

    // The same events again change nothing.
    await inShop(app, () => loyalty(app).earn(order.id));
    await inShop(app, () => loyalty(app).delivered(order.id));
    await windowPassed(app, order.id);
    assert.equal((await loyalty(app).sweep()).posted, 1);
    assert.equal((await loyalty(app).sweep()).posted, 0);
    await inShop(app, () => loyalty(app).earn(order.id));
    const all = await ledgerOf(app, asha.id);
    assert.deepEqual(all.map((e) => [e.kind, e.status, e.points]), [['earn', 'posted', 10]], 'the order earned twice');
    assert.deepEqual(await accountOf(app, asha.id), { balance: 10, pending: 0 });
    assert.match(textOf((await hit(app, '/account/points', as(asha))).text), /You have 10 points/);
    assert.match(textOf((await hit(app, '/account', as(asha))).text), /Your points 10 to use/);
    void unpaid;
  } finally {
    app.close();
  }
});

test('S-87: points are earned after discount and before shipping; an open return holds them; the window-closed event posts them', async () => {
  const app = await world();
  try {
    await loyaltyOn(app);
    await returnsWindow(app, 0);
    const api = await consoleApi(app);
    assert.equal((await api('POST', '/coupons', { code: 'HALF', kind: 'percent', percentBp: 5000 })).status, 201);
    await withTenant(app.tenant, () => app.platform.settings.update({ shipping_fee_paise: '5000', free_shipping_above_paise: '0' }));
    const lamp = await product(app, { pricePaise: 100000, stock: 5 });
    const asha = await signedIn(app);
    const order = await ordered(app, asha, lamp.id, { couponCode: 'HALF' });
    assert.equal(Number(order.discount_paise), 50000);
    await markPaid(app, order.id);
    const [earn] = await ledgerOf(app, asha.id);
    assert.equal(earn.points, 5, 'points were not worked out on the discounted amount before shipping');

    // A return asked for inside the window keeps the points pending.
    await advance(app, order.id, ['packed', 'shipped', 'delivered']);
    await withTenant(app.tenant, () => app.db.query(`INSERT INTO returns (tenant_id, order_id, shopper_id, status) VALUES ($1, $2, $3, 'requested')`, [app.tenant.id, order.id, asha.id]));
    await loyalty(app).sweep();
    assert.equal((await ledgerOf(app, asha.id))[0].status, 'pending', 'posted with a return still open');
    await withTenant(app.tenant, () => app.db.query(`UPDATE returns SET status = 'rejected' WHERE tenant_id = $1 AND order_id = $2`, [app.tenant.id, order.id]));
    await withTenant(app.tenant, () => app.db.tx((t) => app.ctx.orderEvents.emit(t, { type: 'order.return_window_closed', orderId: order.id, dedupeKey: `window:${order.id}` })));
    await app.ctx.orderEvents.settle();
    assert.equal((await ledgerOf(app, asha.id))[0].status, 'posted');
    assert.deepEqual(await accountOf(app, asha.id), { balance: 5, pending: 0 });
  } finally {
    app.close();
  }
});

test('S-88: a redemption above the cap applies the cap with a notice, is checked again when placed, and never takes more than the balance', async () => {
  const app = await world();
  try {
    const api = await loyaltyOn(app, { maxRedeemPoints: 50, pointValuePaise: 100 });
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const asha = await signedIn(app);
    const adjusted = await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: 200, note: 'Welcome gift' });
    assert.equal(adjusted.status, 200, adjusted.text);
    assert.deepEqual([adjusted.json.balance, adjusted.json.name], [200, 'Asha Rao']);

    const q = await quote(app, asha, { lines: [line(lamp)], redeemPoints: 120 });
    assert.deepEqual([q.json.pointsUsed, q.json.loyaltyPaise], [50, 5000]);
    assert.ok(q.json.notices.some((n) => /50/.test(n)), JSON.stringify(q.json.notices));
    assert.deepEqual(await accountOf(app, asha.id), { balance: 200, pending: 0 }, 'a quote spent points');
    const placed = await place(app, placeBody(lamp.id, { redeemPoints: 120 }), as(asha));
    assert.equal(placed.status, 201, placed.text);
    const order = await orderByNumber(app, placed.json.orderNumber);
    assert.deepEqual([order.loyalty_points, Number(order.loyalty_paise), Number(order.total_paise)], [50, 5000, 95000]);
    assert.deepEqual(await accountOf(app, asha.id), { balance: 150, pending: 0 });
    const redeem = (await ledgerOf(app, asha.id)).find((e) => e.kind === 'redeem');
    assert.deepEqual([redeem.points, redeem.order_id, redeem.entry_key], [-50, order.id, `redeem:order:${order.id}`]);

    for (const bad of [-10, 1.5, '5']) assert.equal((await quote(app, asha, { lines: [line(lamp)], redeemPoints: bad })).status, 400, `redeemPoints ${bad}`);
    assert.equal((await quote(app, null, { lines: [line(lamp)], redeemPoints: 50 })).json.pointsUsed, 0, 'a guest spent points');

    // Checked again inside the order's own transaction: asked straight, it refuses more than the cap or the balance.
    await assert.rejects(inShop(app, () => app.db.tx((t) => loyalty(app).redeem(t, { shopperId: asha.id, orderId: order.id, points: 60, valuePaise: 6000 }))), /up to 50/);
    await rows(app, `UPDATE loyalty_settings SET max_redeem_points = 1000 WHERE tenant_id = $1`, [app.tenant.id]);
    await assert.rejects(inShop(app, () => app.db.tx((t) => loyalty(app).redeem(t, { shopperId: asha.id, orderId: order.id, points: 151, valuePaise: 15100 }))), /enough points/);
    await assert.rejects(inShop(app, () => app.db.tx((t) => loyalty(app).redeem(t, { shopperId: asha.id, orderId: order.id, points: 10, valuePaise: 1000 }))), /already used/, 'the same order spent twice');
    await assert.rejects(rows(app, 'UPDATE loyalty_accounts SET balance = -1 WHERE tenant_id = $1 AND shopper_id = $2', [app.tenant.id, asha.id]), /check/i, 'the database let a balance go below zero');
    assert.deepEqual(await accountOf(app, asha.id), { balance: 150, pending: 0 });
  } finally {
    app.close();
  }
});

test('S-88: checkouts at the same moment can’t spend the same points', async () => {
  const app = await world();
  try {
    const api = await loyaltyOn(app, { maxRedeemPoints: 1000, pointValuePaise: 100 });
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const asha = await signedIn(app);
    await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: 200, note: 'Gift' });
    const answers = await Promise.all([0, 1, 2, 3].map(() => place(app, placeBody(lamp.id, { redeemPoints: 150 }), as(asha))));
    for (const res of answers) assert.ok(res.status < 500, `a racing redemption failed: ${res.status} ${res.text}`);
    const orders = await rows(app, 'SELECT loyalty_points FROM orders WHERE tenant_id = $1', [app.tenant.id]);
    const spent = orders.reduce((n, o) => n + o.loyalty_points, 0);
    assert.ok(spent <= 200, `${spent} points spent from 200`);
    assert.equal(spent, 200, 'the points were all used across the orders');
    assert.deepEqual(await accountOf(app, asha.id), { balance: 0, pending: 0 });
    const redeemed = (await ledgerOf(app, asha.id)).filter((e) => e.kind === 'redeem').reduce((n, e) => n - e.points, 0);
    assert.equal(redeemed, spent, 'the ledger and the orders disagree');
  } finally {
    app.close();
  }
});

test('S-89: a refund takes back the points the order earned, in proportion; points already spent can’t go below zero', async () => {
  const app = await world({ cod: true });
  try {
    await loyaltyOn(app, { maxRedeemPoints: 100 });
    await returnsWindow(app, 7);
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const asha = await signedIn(app);
    const api = await consoleApi(app);
    const refund = (orderId, amountPaise) => api('POST', `/orders/${orderId}/refunds`, { amountPaise, reason: 'Damaged', idempotencyKey: `rf-${crypto.randomUUID()}`, password: OWNER.password, reference: 'UPI 412233445566' });
    // Cash on delivery: paid at the door, so the refund is by hand.
    const codOrder = async () => {
      const order = await ordered(app, asha, lamp.id, { paymentMode: 'cod', address: { ...ADDRESS, phone: asha.phone } });
      await advance(app, order.id, ['packed', 'shipped', 'delivered']);
      return orderByNumber(app, order.order_number);
    };

    // Pending: a part refunded cuts the points; the rest refunded voids them.
    const first = await codOrder();
    assert.equal(first.payment_status, 'paid');
    assert.deepEqual(await accountOf(app, asha.id), { balance: 0, pending: 10 });
    assert.equal((await refund(first.id, 20000)).status, 201);
    await app.ctx.orderEvents.settle();
    assert.deepEqual(await accountOf(app, asha.id), { balance: 0, pending: 8 });
    assert.equal((await refund(first.id, 80000)).status, 201);
    await app.ctx.orderEvents.settle();
    assert.deepEqual(await accountOf(app, asha.id), { balance: 0, pending: 0 });
    assert.ok((await ledgerOf(app, asha.id)).filter((e) => e.order_id === first.id).every((e) => e.status === 'void'));

    // Posted: taken back out of the balance; what was already spent stays spent.
    const second = await codOrder();
    await windowPassed(app, second.id);
    await loyalty(app).sweep();
    assert.deepEqual(await accountOf(app, asha.id), { balance: 10, pending: 0 });
    assert.equal((await refund(second.id, 50000)).status, 201);
    await app.ctx.orderEvents.settle();
    assert.deepEqual(await accountOf(app, asha.id), { balance: 5, pending: 0 });
    const spend = await place(app, placeBody(lamp.id, { redeemPoints: 5 }), as(asha));
    assert.equal(spend.status, 201, spend.text);
    assert.equal((await refund(second.id, 50000)).status, 201);
    await app.ctx.orderEvents.settle();
    await app.ctx.orderEvents.settle();
    const reversals = (await ledgerOf(app, asha.id)).filter((e) => e.kind === 'reverse');
    assert.deepEqual(reversals.map((e) => e.points), [-5], 'the second refund took points the shopper no longer had');
    assert.deepEqual(await accountOf(app, asha.id), { balance: 0, pending: 0 });
  } finally {
    app.close();
  }
});

test('S-89: points spent on a cancelled order come back once, and are taken again if the order is reinstated', async () => {
  const app = await world();
  try {
    const api = await loyaltyOn(app, { maxRedeemPoints: 100 });
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const asha = await signedIn(app);
    await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: 40, note: 'Gift' });
    const order = await ordered(app, asha, lamp.id, { redeemPoints: 40 });
    assert.deepEqual(await accountOf(app, asha.id), { balance: 0, pending: 0 });
    // The hold runs out before the payment arrives.
    const { changeOrder } = await import('../../../src/modules/orders/state.js');
    await inShop(app, () => app.db.tx((t) => changeOrder(t, order.id, { fulfilment: 'cancelled', cancelReason: 'hold_expired', actor: 'job:hold-expiry' })));
    await app.ctx.orderEvents.settle();
    assert.deepEqual(await accountOf(app, asha.id), { balance: 40, pending: 0 });
    await inShop(app, () => loyalty(app).cancelled(order.id));
    assert.deepEqual(await accountOf(app, asha.id), { balance: 40, pending: 0 }, 'points were given back twice');
    // The money arrives late, and the order comes back: its points are taken again.
    await markPaid(app, order.id, { confirm: true });
    const back = await orderByNumber(app, order.order_number);
    assert.equal(back.fulfilment_status, 'new');
    await inShop(app, () => loyalty(app).reinstated(order.id));
    const ledger = await ledgerOf(app, asha.id);
    assert.deepEqual(ledger.filter((e) => e.kind !== 'earn').map((e) => [e.kind, e.points]), [['adjust', 40], ['redeem', -40], ['restore', 40], ['redeem', -40]]);
    // Paid at last, it earns once, on what was paid after the points: Rs 960 at 1 per Rs 100.
    assert.deepEqual(ledger.filter((e) => e.kind === 'earn').map((e) => [e.points, e.status]), [[9, 'pending']]);
    assert.deepEqual(await accountOf(app, asha.id), { balance: 0, pending: 9 });
  } finally {
    app.close();
  }
});

test('expiry: posted points lapse when their time comes, oldest first, and what was spent is not lapsed again', async () => {
  const app = await world();
  try {
    const api = await loyaltyOn(app, { maxRedeemPoints: 100, expiryDays: 30 });
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const asha = await signedIn(app);
    await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: 30, note: 'Old gift' });
    const [gift] = await ledgerOf(app, asha.id);
    assert.ok(gift.expires_at && new Date(gift.expires_at) > new Date(Date.now() + 29 * 86_400_000));
    await place(app, placeBody(lamp.id, { redeemPoints: 10 }), as(asha));
    await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: 25, note: 'New gift' });
    // The old gift's time comes, after the account last changed.
    await rows(app, `UPDATE loyalty_ledger SET expires_at = now() - interval '1 hour' WHERE tenant_id = $1 AND id = $2`, [app.tenant.id, gift.id]);
    await rows(app, `UPDATE loyalty_accounts SET updated_at = now() - interval '2 hours' WHERE tenant_id = $1 AND shopper_id = $2`, [app.tenant.id, asha.id]);
    // Pages and quotes leave the lapsed points out before the sweep has run.
    assert.match(textOf((await hit(app, '/account/points', as(asha))).text), /You have 25 points/);
    assert.equal((await quote(app, asha, { lines: [line(lamp)], redeemPoints: 100 })).json.pointsUsed, 25);
    const swept = await loyalty(app).sweep();
    assert.equal(swept.lapsed, 1);
    const expired = (await ledgerOf(app, asha.id)).filter((e) => e.kind === 'expire');
    assert.deepEqual(expired.map((e) => e.points), [-20], 'the 10 already spent came from the old points first');
    assert.deepEqual(await accountOf(app, asha.id), { balance: 25, pending: 0 });
    assert.equal((await loyalty(app).sweep()).lapsed, 0, 'lapsed twice');
    assert.deepEqual(await accountOf(app, asha.id), { balance: 25, pending: 0 });
  } finally {
    app.close();
  }
});

test('the owner alone adjusts points, never below zero; one business never reaches another’s shoppers; members and ledger read back', async () => {
  const app = await world();
  try {
    const api = await loyaltyOn(app);
    const asha = await signedIn(app);
    assert.equal((await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: 0, note: 'x' })).status, 400);
    assert.equal((await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: 10, note: '' })).status, 400, 'no reason given');
    assert.equal((await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: 10, note: 'Gift' })).status, 200);
    const over = await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: -11, note: 'Mistake' });
    assert.equal(over.status, 400, over.text);
    assert.equal((await api('POST', `/loyalty/members/${asha.id}/adjust`, { points: -4, note: 'Mistake' })).json.balance, 6);
    assert.equal((await api('POST', '/loyalty/members/999999/adjust', { points: 5, note: 'x' })).status, 404);
    const manager = await member(app, { role: 'manager' });
    assert.equal((await manager('POST', `/loyalty/members/${asha.id}/adjust`, { points: 1000, note: 'x' })).status, 403);

    const other = await otherShop(app);
    const theirs = await consoleApi(app, { host: other.host });
    assert.equal((await theirs('POST', `/loyalty/members/${asha.id}/adjust`, { points: 1000, note: 'x' })).status, 403, 'without the add-on there');
    await setFeature(app, 'loyalty', true, other.tenant);
    assert.equal((await theirs('POST', `/loyalty/members/${asha.id}/adjust`, { points: 1000, note: 'x' })).status, 404, 'another business’s shopper');
    assert.equal((await theirs('GET', `/loyalty/members/${asha.id}/ledger`)).status, 404);
    assert.deepEqual((await theirs('GET', '/loyalty/members')).json.items, []);

    const members = await api('GET', '/loyalty/members');
    assert.deepEqual(members.json.items.map((m) => [m.shopperId, m.balance, m.pending]), [[asha.id, 6, 0]]);
    const ledger = await api('GET', `/loyalty/members/${asha.id}/ledger?limit=1`);
    assert.deepEqual(ledger.json.items.map((e) => [e.kind, e.points, e.status]), [['adjust', -4, 'posted']]);
    assert.ok(ledger.json.nextCursor);
    const audit = await rows(app, `SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'loyalty.adjusted' ORDER BY id`, [app.tenant.id]);
    assert.deepEqual(audit.map((a) => a.details.points), [10, -4]);
    assert.equal(await one(app, 'SELECT 1 AS x FROM loyalty_ledger WHERE tenant_id = $1', [other.tenant.id]), undefined);
  } finally {
    app.close();
  }
});

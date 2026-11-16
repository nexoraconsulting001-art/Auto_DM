// commerce-5 (PRD 9.21): "The friend gets a first-order reward." The referred friend's first order is priced with the
// owner's friend_reward_paise (after the coupon), the referral is recorded in the order's own transaction with what was
// given, and a retry of the same checkout (answered 200) still has its referral.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS, as, hit, loyaltyOn, orderByNumber, payments, place, placeBody, product, q, rows, signedIn, storeApp } from '../../p4/engagement/support.js';

const referralsOf = (app) => rows(app, 'SELECT * FROM referrals WHERE tenant_id = $1 ORDER BY id', [app.tenant.id]);

async function world() {
  const app = await storeApp();
  await payments(app);
  await loyaltyOn(app, { referralEnabled: true, referrerPoints: 100, friendRewardPaise: 10000 });
  return app;
}

async function codeOf(app, who) {
  const page = await hit(app, '/account/points', as(who));
  assert.equal(page.status, 200, page.text);
  return /\/refer\/([A-Z0-9]{6,12})/.exec(page.text)[1];
}

const friendAddress = (phone) => ({ ...ADDRESS, line1: '7 Hill View', pincode: '560001', phone });

test('commerce-5: the friend’s first order gets the reward, stored on the order and the referral; a retry keeps one referral', async () => {
  const app = await world();
  try {
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const asha = await signedIn(app);
    const code = await codeOf(app, asha);
    const ravi = await signedIn(app, { phone: '+919000011111', name: 'Ravi K' });

    const quote = await hit(app, '/api/store/checkout/quote', { method: 'POST', body: { lines: [{ productId: lamp.id, variantId: null, qty: 1 }], address: friendAddress(ravi.phone), referralCode: code }, ...as(ravi) });
    assert.equal(quote.status, 200, quote.text);
    assert.deepEqual([quote.json.discountPaise, quote.json.referralPaise], [10000, 10000]);
    assert.equal(quote.json.totalPaise, 100000 - 10000 + quote.json.shippingPaise);
    assert.ok(quote.json.notices.some((n) => /welcome reward/.test(n)), 'the shopper is told why the price is lower');
    assert.doesNotMatch(JSON.stringify(quote.json), /bhava/i);

    const body = placeBody(lamp.id, { address: friendAddress(ravi.phone) });
    const options = { ...as(ravi), cookie: `${as(ravi).cookie}; _ref=${code}` };
    const res = await place(app, body, options);
    assert.equal(res.status, 201, res.text);
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.equal(Number(order.discount_paise), 10000);
    assert.equal(Number(order.total_paise), 100000 - 10000 + Number(order.shipping_paise));
    const items = await q(app, 'SELECT discount_paise FROM order_items WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, order.id]);
    assert.equal(items.reduce((sum, i) => sum + Number(i.discount_paise), 0), 10000, 'the reward is in the lines, so GST is on what is paid');

    // Recorded with the order, not after the answer: no waiting.
    const [ref] = await referralsOf(app);
    assert.deepEqual([ref.status, ref.order_id, Number(ref.friend_reward_paise)], ['pending', order.id, 10000]);

    // The same checkout sent again (its first answer lost) answers 200 with the same order and the one referral.
    const again = await place(app, body, options);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.orderNumber, res.json.orderNumber);
    assert.equal((await referralsOf(app)).length, 1);

    // A friend is rewarded once: their next order is full price.
    const next = await hit(app, '/api/store/checkout/quote', { method: 'POST', body: { lines: [{ productId: lamp.id, variantId: null, qty: 1 }], address: friendAddress(ravi.phone), referralCode: code }, ...as(ravi) });
    assert.deepEqual([next.json.discountPaise, next.json.referralPaise], [0, 0]);
  } finally {
    app.close();
  }
});

test('commerce-5: the reward comes after the coupon, and never on a blocked self-referral', async () => {
  const app = await world();
  try {
    await q(app, `INSERT INTO coupons (tenant_id, code, kind, percent_bp) VALUES ($1, 'TEN', 'percent', 1000)`, [app.tenant.id]);
    const lamp = await product(app, { pricePaise: 100000, stock: 10 });
    const asha = await signedIn(app);
    const code = await codeOf(app, asha);
    const meera = await signedIn(app, { phone: '+919000022222', name: 'Meera' });
    const res = await place(app, placeBody(lamp.id, { couponCode: 'TEN', referralCode: code, address: friendAddress(meera.phone) }), as(meera));
    assert.equal(res.status, 201, res.text);
    const order = await orderByNumber(app, res.json.orderNumber);
    assert.equal(Number(order.discount_paise), 10000 + 10000);
    const [redemption] = await q(app, 'SELECT discount_paise FROM coupon_redemptions WHERE tenant_id = $1 AND order_id = $2', [app.tenant.id, order.id]);
    assert.equal(Number(redemption.discount_paise), 10000, 'the coupon keeps its own amount');

    // The referrer's own number as a guest: blocked (S-90), full price.
    const own = await place(app, placeBody(lamp.id, { referralCode: code, address: { ...ADDRESS, line1: '1 Far Away Street', pincode: '110001', stateCode: '07', city: 'Delhi', phone: asha.phone } }));
    assert.equal(own.status, 201, own.text);
    const ownOrder = await orderByNumber(app, own.json.orderNumber);
    assert.equal(Number(ownOrder.discount_paise), 0);
    const blocked = (await referralsOf(app)).find((r) => r.order_id === ownOrder.id);
    assert.deepEqual([blocked.status, blocked.block_reason, Number(blocked.friend_reward_paise)], ['blocked', 'same_phone', 0]);
  } finally {
    app.close();
  }
});

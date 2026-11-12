// The shopper app's buying code against a real running store: a guest session from the first call, sign-in by WhatsApp code, sign
// out and account deletion wiping the device, the quote (the server's totals, never the app's), guest checkout with prepaid asking
// for no code and cash on delivery asking for one, a double tap making one order, Paid only after the server says so, and push.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNotifier } from '../../../apps/shopper/src/features/notifications/flow.js';
import { payAndSettle } from '../../../apps/shopper/src/features/payment/flow.js';
import { consentBody, placeExtra } from '../../../apps/shopper/src/features/checkout/placing.js';
import { ADDRESS, appWorld, markPaid, orderByNumber, payments, product, q, shopperSide } from './support.js';

const PHONE = '9876543210';
const count = async (w, table) => (await q(w.app, `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [w.app.tenant.id]))[0].n;

/** A phone's notification module that answers as set. */
function phoneNotifications({ granted = true, token = 'fcm-token-0123456789abcdef' } = {}) { // secret-scan:allow
  const asked = [];
  return {
    asked,
    getPermissionsAsync: async () => ({ granted: false, canAskAgain: true, status: 'undetermined' }),
    requestPermissionsAsync: async () => { asked.push('system prompt'); return granted ? { granted: true, status: 'granted' } : { granted: false, canAskAgain: false, status: 'denied' }; },
    getDevicePushTokenAsync: async () => ({ data: token }),
  };
}

test('session: a guest from the first call, sign-in by code, sign-out and account deletion wipe the phone', async () => {
  const w = await appWorld();
  try {
    const s = shopperSide(w);
    // Browsing needs nothing from the shopper: a guest session starts by itself, and the first call is not held back for it.
    assert.equal(await s.session.getAccessToken(), null, 'a brand-new phone has no token yet');
    await s.session.start();
    const home = await s.client.call('appHome');
    assert.ok(Array.isArray(home.blocks));
    assert.equal(s.session.getState().status, 'guest');
    assert.equal(s.net.calls.filter((c) => c.path === '/api/store/app/session').length, 1);
    assert.ok(await s.store.getRefreshToken(), 'the refresh token is kept in the secure store');

    // Sign in with a WhatsApp code.
    await s.session.sendCode(PHONE);
    await s.session.signInWithCode(PHONE, await w.lastCode(PHONE));
    assert.equal(s.session.getState().status, 'signedIn');
    const me = await s.client.call('appMe');
    assert.ok(me.shopper && me.shopper.phoneMasked && !String(JSON.stringify(me)).includes(PHONE), 'only a masked number comes back');

    // Signed in, the bag follows the shopper to the server.
    const lamp = await product(w.app, { name: 'Brass lamp', pricePaise: 50000 });
    await s.cart.add({ productId: lamp.id, qty: 2 });
    const kept = await s.client.call('cartGet');
    assert.equal(kept.lines[0].qty, 2);

    // Sign out: the refresh token the phone held is dead, the phone is a fresh guest, the bag and cached answers are wiped.
    const before = await s.store.getRefreshToken();
    await s.session.signOut();
    assert.equal(s.session.getState().status, 'guest');
    assert.notEqual(await s.store.getRefreshToken(), before);
    assert.equal(s.cart.count, 0);
    assert.ok(s.wiped.length >= 1);
    const dead = await fetch(`${w.app.base}/api/store/app/session/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-app': 'shopper', 'x-app-tenant': String(w.app.tenant.id), 'x-app-version': '1.0.0', 'x-app-platform': 'android' }, body: JSON.stringify({ refreshToken: before }) });
    assert.ok(dead.status === 401 || dead.status === 403, `the old refresh token is refused (${dead.status})`);

    // Sign in again and delete the account in the app.
    await s.session.sendCode(PHONE);
    await s.session.signInWithCode(PHONE, await w.lastCode(PHONE));
    const signedInToken = await s.store.getRefreshToken();
    const gone = await s.session.deleteAccount();
    assert.ok(['completed', 'waiting'].includes(gone.status));
    assert.equal(s.session.getState().status, 'guest');
    assert.notEqual(await s.store.getRefreshToken(), signedInToken);
    assert.equal(s.cart.count, 0);
  } finally {
    await w.close();
  }
});

test('buying: the server prices, a double tap makes one order, Paid comes only from the server, cash on delivery asks for a code and prepaid does not', async () => {
  const w = await appWorld();
  try {
    await payments(w.app, { cod: true });
    const lamp = await product(w.app, { name: 'Brass lamp', pricePaise: 50000, stock: 9 });
    const s = shopperSide(w, { delayMs: 40 });
    await s.session.start();
    await s.cart.add({ productId: lamp.id, qty: 2 });

    // The quote: the server's own numbers; the request carried only what was chosen.
    const quote = await s.buy.quote({ lines: s.cart.lines, address: { ...ADDRESS }, paymentMode: 'prepaid' });
    assert.equal(quote.subtotalPaise, 100000);
    assert.equal(quote.totalPaise, 100000);
    assert.ok(Number.isInteger(quote.totalPaise));
    const quoteCall = s.net.calls.find((c) => c.path === '/api/store/checkout/quote');
    assert.deepEqual(Object.keys(quoteCall.body).sort(), ['address', 'lines', 'paymentMode']);
    assert.deepEqual(quoteCall.body.lines, [{ productId: lamp.id, variantId: null, qty: 2 }]);

    // Prepaid, a guest, two taps on Place order at once: one request, one order, no code asked.
    const draft = { lines: s.cart.lines, address: { ...ADDRESS }, paymentMode: 'prepaid', email: '' };
    const consent = consentBody({ noticeVersion: 1 });
    const tap = () => s.attempt.place(draft, (key) => s.buy.place(draft, placeExtra({ key, consent })));
    const [one, two] = await Promise.all([tap(), tap()]);
    assert.equal(one.orderNumber, two.orderNumber);
    assert.equal(one.next, 'pay');
    assert.equal(await count(w, 'orders'), 1);
    assert.equal(s.net.calls.filter((c) => c.path === '/api/store/checkout').length, 1, 'one request left the phone');
    assert.ok(!s.net.calls.some((c) => c.path === '/api/store/otp/send'), 'prepaid sends no code');
    const placeCall = s.net.calls.find((c) => c.path === '/api/store/checkout');
    assert.ok(!JSON.stringify(placeCall.body).match(/paise|total|price|discount/i), 'no amount in the order request');
    assert.equal(placeCall.body.acceptTerms, true);
    assert.deepEqual(placeCall.body.consent.marketing, { whatsapp: false, email: false }, 'marketing is off unless ticked');

    // The payment page closes with a success-looking link, but nothing was paid: not Paid, and the bag is intact.
    const unpaid = await payAndSettle({ pay: s.pay.pay, order: one, cart: s.cart, attempt: s.attempt });
    assert.equal(unpaid.outcome, 'cancelled');
    assert.equal(s.cart.count, 2, 'a payment that did not happen leaves the bag as it was');
    assert.ok(s.opened[0].startsWith(`${w.app.base}/order/`), 'the hosted page is on the store’s own address');
    assert.equal((await s.client.call('appOrderByToken', { params: { token: one.token } })).paymentStatus, 'unpaid');

    // The shopper really pays: the server marks it paid, then the app says Paid and empties the bag.
    const row = await orderByNumber(w.app, one.orderNumber);
    await markPaid(w.app, row.id);
    const paid = await payAndSettle({ pay: s.pay.pay, order: one, cart: s.cart, attempt: s.attempt });
    assert.equal(paid.outcome, 'paid');
    assert.equal(paid.state.paymentStatus, 'paid');
    assert.equal(s.cart.count, 0);

    // The server's checkout asks ctx.shoppers.otps.codVerified, which nothing wires to the real service yet (reported in the handoff), so this
    // stands in for it the way the checkout tests do: it answers true once the code for this attempt was entered and used.
    w.app.ctx.shoppers = { otps: { codVerified: async ({ checkoutKey }) => (await q(w.app, "SELECT 1 FROM shopper_otps WHERE tenant_id = $1 AND purpose = 'cod' AND checkout_key = $2 AND consumed_at IS NOT NULL", [w.app.tenant.id, checkoutKey])).length > 0 } };

    // Cash on delivery asks for a WhatsApp code to the phone on the order; without it the order is refused.
    await s.cart.add({ productId: lamp.id, qty: 1 });
    const cod = { lines: s.cart.lines, address: { ...ADDRESS }, paymentMode: 'cod', email: '' };
    const key = s.attempt.keyFor(cod);
    const refused = await s.buy.place(cod, placeExtra({ key, consent }));
    assert.equal(refused.next, 'verify_phone', 'no code, no cash-on-delivery order');
    assert.equal(refused.orderNumber, '');
    assert.equal(await count(w, 'orders'), 1);
    await s.buy.sendCodFor({ phone: PHONE, checkoutKey: key });
    await s.buy.verifyCodFor({ phone: PHONE, code: await w.lastCode(PHONE), checkoutKey: key });
    const placed = await s.attempt.place(cod, (k) => s.buy.place(cod, placeExtra({ key: k, consent })));
    assert.equal(placed.next, 'done');
    const state = await s.client.call('appOrderByToken', { params: { token: placed.token } });
    assert.equal(state.next, 'done');
    assert.notEqual(state.paymentStatus, 'paid', 'cash on delivery is not Paid');
    assert.equal(await count(w, 'orders'), 2);
  } finally {
    await w.close();
  }
});

test('push: asked only through the explainer, Order updates only, Offers and New reels stay off, and a refusal costs nothing', async () => {
  const w = await appWorld();
  try {
    const s = shopperSide(w);
    await s.session.start();
    const flag = { held: new Map(), get(n) { return this.held.get(n) ?? null; }, set(n, v) { this.held.set(n, v); } };
    const phone = phoneNotifications();
    const notifier = createNotifier({ client: s.client, notifications: phone, flag });

    const fresh = await notifier.prefs();
    assert.deepEqual([fresh.permission, fresh.orderUpdates, fresh.offers, fresh.newReels], ['not_asked', false, false, false]);
    assert.deepEqual(phone.asked, [], 'browsing never asks the phone');
    assert.equal(await notifier.shouldExplain(), true);

    const answer = await notifier.accept({ orderToken: 'unused-order-token-value' });
    assert.equal(answer.registered, true);
    assert.deepEqual(phone.asked, ['system prompt']);
    const after = await notifier.prefs();
    assert.deepEqual([after.permission, after.orderUpdates, after.offers, after.newReels], ['granted', true, false, false]);
    assert.equal(await notifier.shouldExplain(), false, 'asked once');

    // Offers turn on only when the shopper turns them on, and off again.
    assert.equal((await notifier.enable({ offers: true })).saved, true);
    assert.equal((await notifier.prefs()).offers, true);
    await notifier.save({ offers: false });
    const calls = s.net.calls.filter((c) => c.path === '/api/store/app/push/prefs' && c.method === 'PUT');
    assert.ok(calls.every((c) => c.body.source), 'every save says where it came from');
    assert.equal(calls[0].body.source, 'first_order_prompt');
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['orderUpdates', 'source']);

    // A shopper whose phone says no: the explainer's accept changes nothing else, and the app carries on.
    const other = shopperSide(w);
    await other.session.start();
    const refusing = createNotifier({ client: other.client, notifications: phoneNotifications({ granted: false }), flag: { get: () => null, set: () => {} } });
    const refused = await refusing.accept({});
    assert.equal(refused.registered, false);
    const prefs = await refusing.prefs();
    assert.deepEqual([prefs.permission, prefs.orderUpdates, prefs.offers, prefs.newReels], ['denied', false, false, false]);
    assert.equal((await refusing.enable({ offers: true })).saved, false, 'a denied phone cannot be turned on from inside the app');
    assert.equal((await other.buy.quote({ lines: [{ productId: (await product(w.app, { name: 'Pot' })).id, variantId: null, qty: 1 }] })).totalPaise > 0, true, 'the app works fully without push');
  } finally {
    await w.close();
  }
});

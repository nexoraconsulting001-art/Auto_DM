// The owner app's store and account screens (PRD 10.4; P-17, P-18): the pure rules they share, checked against the
// server's own contract. Every body a screen builds must pass the route's zod schema as it is, every pattern must accept
// and refuse what the server does, and the app must never send an amount for an order: only a refund a person types.
// The screens themselves are tested with jest beside the code (apps/owner/src/features/*/*.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routes } from '../../../src/contracts/api/index.js';
import * as server from '../../../src/contracts/orders.js';
import {
  HAND_MOVES, SELLER_CANCEL_REASONS, WRITE_ONLY_FIELDS, actionBody, couponBody, couponForm, filledOnly, formatPaise, isOnlyOwner, newRefundKey,
  orderActions, parseRupees, quickAction, refundBody, refundable, rupeesText, teamBody,
} from '../../../apps/owner/src/features/orders/kit/rules.js';
import {
  GSTIN, HOLD_MINUTES, INDIAN_STATES, INVOICE_PREFIX, KEY_ID, PINCODE, SHOP_DOMAIN, alertSettingsBody, alertSettingsForm, grievanceBody, invoiceSettingsBody,
  inviteBody, linkedAccountBody, loyaltySettingsBody, loyaltySettingsForm, noticeBody, paymentOptionsBody, paymentOptionsForm, pointsAdjustBody, razorpayKeysBody,
  returnSettingsBody, shippingBody, shippingForm, shopifyConnectBody, stockBody, stockForm, storeSettingsBody, storeSettingsForm, upiBody, whatsappConnectBody,
} from '../../../apps/owner/src/features/orders/kit/forms.js';

/** The body passes the route's own schema, unchanged in meaning. */
function accepted(id, body) {
  const parsed = routes[id].body.safeParse(body);
  assert.ok(parsed.success, `${id} refused ${JSON.stringify(body)}: ${parsed.error?.message}`);
  return parsed.data;
}
const built = (result) => {
  assert.equal(result.problems, undefined, `problems: ${JSON.stringify(result.problems)}`);
  return result.body;
};

// ---- money ----

test('money is integer paise both ways, worked out on the digits and never through a float', () => {
  assert.equal(parseRupees('0.29'), 29);
  assert.equal(parseRupees('1,299.5'), 129950);
  assert.equal(parseRupees('₹ 20.05'), 2005);
  assert.equal(parseRupees('12.345'), null);
  assert.equal(parseRupees('-5'), null);
  assert.equal(parseRupees('21474836.48'), null, 'more than one money field holds');
  assert.equal(rupeesText(49950), '499.50');
  assert.equal(rupeesText(49900), '499');
  assert.equal(formatPaise(12345650), '₹1,23,456.50');
  assert.equal(formatPaise(-500), '−₹5');
});

// ---- orders (P-18): never an amount ----

const order = (over = {}) => ({ flow: 'checkout', paymentMode: 'cod', fulfilmentStatus: 'new', holdReason: null, nextFulfilment: ['packed', 'cancelled'], canCancel: true, paidPaise: 0, refundedPaise: 0, ...over });

test('P-18 Confirm on a cash on delivery order is the move to packed, and every order action body carries no amount', () => {
  assert.deepEqual(quickAction(order()), { key: 'confirm', kind: 'advance', to: 'packed' });
  assert.equal(quickAction(order({ holdReason: 'cod_risk' })), null, 'a held order is released first, from its own screen');
  assert.equal(quickAction(order({ paymentMode: 'prepaid' })), null);
  const actions = orderActions(order({ holdReason: 'cod_risk' }));
  assert.deepEqual(actions.map((a) => a.key), ['releaseCod', 'packed', 'cancel'], 'a held order is released first; Confirm is for one that is not held');
  for (const action of [...orderActions(order()), ...orderActions({ status: 'payment_submitted' }), { kind: 'release' }, { kind: 'cancel' }]) {
    const body = actionBody(action, { note: ' called her ', reason: 'out_of_stock' }) ?? {};
    assert.doesNotMatch(JSON.stringify(body), /paise|amount|total|price/i, `${action.kind} sent an amount`);
  }
  accepted('orders.advance', actionBody({ kind: 'advance', to: 'packed' }));
  accepted('orders.cancel', actionBody({ kind: 'cancel' }, { reason: 'fraud', note: 'x' }));
  accepted('orders.releaseHold', actionBody({ kind: 'release' }, { note: 'called' }));
  accepted('orders.setStatus', actionBody({ kind: 'setStatus', status: 'paid' }));
  assert.deepEqual(actionBody({ kind: 'cancel' }, { reason: 'anything' }), { reason: 'seller' }, 'only a reason the seller may give');
  assert.deepEqual([...HAND_MOVES], ['packed', 'shipped', 'delivered']);
  assert.ok(SELLER_CANCEL_REASONS.every((r) => routes['orders.cancel'].body.safeParse({ reason: r }).success));
});

test('the moves offered are exactly the ones the server says are next', () => {
  assert.deepEqual(orderActions(order({ nextFulfilment: [], canCancel: false })), []);
  assert.deepEqual(orderActions(order({ paymentMode: 'prepaid', fulfilmentStatus: 'packed', nextFulfilment: ['shipped'], canCancel: false })).map((a) => a.key), ['shipped']);
  assert.deepEqual(orderActions(order({ fulfilmentStatus: 'cancelled', cancelReason: 'hold_expired', paymentStatus: 'paid', nextFulfilment: [], canCancel: false })).map((a) => a.key), ['reinstate']);
});

// ---- refunds: the one amount the app sends ----

test('a refund sends the amount the person typed, held inside what can still go back, with one key per visit', () => {
  const most = refundable({ paidPaise: 99900, refundedPaise: 50000 });
  assert.equal(most, 49900);
  const typed = { password: 'pw' };
  assert.deepEqual(refundBody({ ...typed, amountText: '1000' }, { most: 99900 }).problems, { amount: 'refunds.problem.tooMuch' }, 'S-28: ₹1,000 on ₹999');
  assert.deepEqual(refundBody({ ...typed, amountText: 'abc' }, { most }).problems, { amount: 'refunds.problem.amount' });
  assert.deepEqual(refundBody({ ...typed, amountText: '10' }, { most, byHand: true }).problems, { reference: 'refunds.problem.reference' });
  const key = newRefundKey(1_700_000_000_000, () => 0.123456789);
  assert.deepEqual(refundBody({ amountText: '499', idempotencyKey: key }, { most }).problems, { password: 'refunds.problem.password' }, 'the contract checks the owner’s password on the call');
  const body = built(refundBody({ amountText: '499', reason: ' damaged ', idempotencyKey: key, password: ' typed ' }, { most }));
  assert.deepEqual(body, { amountPaise: 49900, reason: 'damaged', idempotencyKey: key, password: ' typed ' });
  accepted('refunds.create', body);
  assert.notEqual(newRefundKey(), newRefundKey());
});

// ---- keys that are written and never read back (P-17) ----

test('P-17 every secret a key route takes is a write-only field, and no route that reads settings sends one back', () => {
  const secretName = /secret|password|token/i;
  const fresh = Object.entries(routes).filter(([, r]) => r.fresh && r.body?.shape);
  const typed = new Set(fresh.flatMap(([, r]) => Object.keys(r.body.shape)).filter((name) => secretName.test(name)));
  for (const name of typed) assert.ok(WRITE_ONLY_FIELDS.includes(name), `${name} is typed into a fresh route but is not a write-only field`);
  for (const id of ['settings.get', 'paymentAccount.get', 'shippingSettings.get', 'shopify.get', 'whatsappAccount.get']) {
    const shape = routes[id].response.shape;
    for (const name of WRITE_ONLY_FIELDS) assert.equal(name in shape, false, `${id} would send ${name} back`);
  }
  // A field left empty keeps what is saved; a secret is sent exactly as typed.
  assert.deepEqual(filledOnly({ ownEmail: ' a@b.in ', ownPassword: ' p w ', other: '' }), { ownEmail: 'a@b.in', ownPassword: ' p w ' });
});

test('P-17 the key forms build what the fresh routes take', () => {
  accepted('settings.updatePayment', built(razorpayKeysBody({ razorpayKeyId: ' rzp_live_ABC123def ', razorpayKeySecret: 's3cr3t' })));
  assert.deepEqual(razorpayKeysBody({ razorpayKeyId: 'pk_live_1', razorpayKeySecret: '' }).problems, { razorpayKeyId: 'payments.problem.keyId', razorpayKeySecret: 'settings.secret.required' });
  accepted('shopify.connect', built(shopifyConnectBody({ shopDomain: 'My-Shop.myshopify.com', accessToken: 'shpat_x', webhookSecret: 'whsec', mode: 'two_way' })));
  assert.ok(shopifyConnectBody({ shopDomain: 'shop.example.com', accessToken: 'a', webhookSecret: 'b' }).problems.shopDomain);
  accepted('whatsappAccount.connect', built(whatsappConnectBody({ wabaId: '123456789', phoneNumberId: '987654321', accessToken: 'EAAG', displayNumber: '' })));
  const shipping = built(shippingBody({ ...shippingForm({ mode: 'own' }), ownEmail: 'ops@example.in' }, { ownPassword: 'typed once' }));
  assert.equal(shipping.ownPassword, 'typed once');
  accepted('shippingSettings.update', shipping);
  assert.equal('ownPassword' in built(shippingBody(shippingForm({ mode: 'own', ownPasswordSet: true }))), false, 'an empty password field keeps the saved one');
  assert.equal('ownPassword' in shippingForm({ mode: 'own', ownPasswordSet: true }), false, 'the form never holds a saved password');
});

test('the patterns accept and refuse what the server does', () => {
  assert.equal(PINCODE.source, server.PINCODE.source);
  assert.deepEqual(INDIAN_STATES, server.INDIAN_STATES);
  const samples = {
    keyId: [['rzp_live_ABC123def', true], ['rzp_test_abcdef', true], ['rzp_live_ab', false], ['pk_live_123456', false]],
    domain: [['shop-1.myshopify.com', true], ['shop.example.com', false], ['-shop.myshopify.com', false]],
    prefix: [['INV', true], ['AB12', true], ['abc', false], ['ABCDE', false]],
    gstin: [['27AAPFU0939F1ZV', true], ['27AAPFU0939F1Z', false]],
  };
  for (const [value, ok] of samples.keyId) {
    assert.equal(KEY_ID.test(value), ok, value);
    assert.equal(routes['settings.updatePayment'].body.safeParse({ razorpayKeyId: value }).success, ok, `server: ${value}`);
  }
  for (const [value, ok] of samples.domain) {
    assert.equal(SHOP_DOMAIN.test(value), ok, value);
    assert.equal(routes['shopify.connect'].body.safeParse({ shopDomain: value, accessToken: 'a', webhookSecret: 'b' }).success, ok, `server: ${value}`);
  }
  for (const [value, ok] of samples.prefix) {
    assert.equal(INVOICE_PREFIX.test(value), ok, value);
    assert.equal(routes['invoiceSettings.update'].body.safeParse({ invoicePrefix: value }).success, ok, `server: ${value}`);
  }
  for (const [value, ok] of samples.gstin) {
    assert.equal(GSTIN.test(value), ok, value);
    assert.equal(routes['invoiceSettings.update'].body.safeParse({ gstin: value }).success, ok, `server: ${value}`);
  }
  for (const minutes of [HOLD_MINUTES.min - 1, HOLD_MINUTES.min, HOLD_MINUTES.max, HOLD_MINUTES.max + 1]) {
    const ours = paymentOptionsBody({ ...paymentOptionsForm({}), holdMinutes: String(minutes) }).problems?.holdMinutes === undefined;
    assert.equal(ours, routes['paymentSettings.update'].body.safeParse({ ...built(paymentOptionsBody(paymentOptionsForm({}))), holdMinutes: minutes }).success, `${minutes} minutes`);
  }
});

// ---- the other store and account forms: what they build, the server takes ----

test('payments: the ways to pay and the KYC details', () => {
  const options = { upi: true, card: true, netbanking: false, wallet: false, cod: true, partAdvance: true, codFeePaise: 4900, codMaxOrderPaise: null, codPincodes: ['411001'], codBlockRtoCount: 3, advanceKind: 'percent', advanceValue: 2500, holdMinutes: 30, onlineReady: true };
  const form = paymentOptionsForm(options);
  assert.deepEqual([form.codFee, form.codMax, form.advanceValue], ['49', '', '25']);
  const body = accepted('paymentSettings.update', built(paymentOptionsBody(form)));
  assert.deepEqual([body.codFeePaise, body.codMaxOrderPaise, body.advanceValue, body.codPincodes], [4900, null, 2500, ['411001']]);
  assert.deepEqual(paymentOptionsBody({ ...form, codPins: '41100, 411001', advanceValue: '0' }).problems, { codPins: 'payments.problem.pins', advanceValue: 'payments.problem.advance' });
  accepted('paymentAccount.startLinked', built(linkedAccountBody({ legalName: 'A Traders', contactName: 'Asha', email: 'a@b.in', phone: '+91 98000 00001', businessType: 'llp' })));
  accepted('settings.updatePayment', built(upiBody({ upiId: 'shop@okbank', upiPayee: 'Shop' })));
});

test('coupons, stock, invoices, returns and loyalty', () => {
  const coupon = built(couponBody({ ...couponForm(null), code: 'diwali20', kind: 'percent', percent: '20', maxDiscount: '200', endsOn: '2026-12-31', maxUses: '100' }));
  assert.deepEqual([coupon.code, coupon.percentBp, coupon.maxDiscountPaise, coupon.endsAt], ['DIWALI20', 2000, 20000, '2026-12-31T23:59:59+05:30']);
  accepted('coupons.create', coupon);
  assert.deepEqual(couponBody({ ...couponForm(null), code: 'X', kind: 'flat', amount: '', scope: 'products' }).problems, { code: 'coupons.problem.code', amount: 'coupons.problem.amount', scope: 'coupons.problem.scope' });

  const line = { productId: 4, variantId: null, stock: 3, lowStockThreshold: null };
  accepted('inventory.adjust', built(stockBody({ ...stockForm(line), way: 'move', amount: '-2' }, line)));
  assert.deepEqual(stockBody({ ...stockForm(line), way: 'move', amount: '-5' }, line).problems, { amount: 'inventory.problem.below' });
  assert.deepEqual(built(stockBody({ ...stockForm(line), way: 'unlimited' }, line)), { productId: 4, variantId: null, stock: null });

  accepted('invoiceSettings.update', built(invoiceSettingsBody({ legalName: 'A', gstin: '27aapfu0939f1zv', stateCode: '27', address: 'Pune', invoicePrefix: 'inv' })));
  assert.equal(invoiceSettingsBody({ gstin: '27AAPFU0939F1ZV', stateCode: '29' }).problems.stateCode, 'invoices.problem.state');
  accepted('returnSettings.update', built(returnSettingsBody({ enabled: true, windowDays: '7', eligibleCategoryIds: ['3', 3], proof: 'photo' })));
  assert.ok(returnSettingsBody({ windowDays: '91' }).problems.windowDays);

  const loyalty = loyaltySettingsForm({ enabled: true, earnPoints: 1, earnPerPaise: 10000, pointValuePaise: 100, maxRedeemPoints: 500, expiryDays: null, referralEnabled: false, friendRewardPaise: 0, referrerPoints: 0 });
  accepted('loyaltySettings.update', built(loyaltySettingsBody(loyalty)));
  assert.equal(loyaltySettingsBody({ ...loyalty, pointValue: '0' }).problems.pointValue, 'loyalty.problem.amount');
  accepted('loyalty.adjust', built(pointsAdjustBody({ points: '-20', note: 'Goodwill' })));
  assert.deepEqual(pointsAdjustBody({ points: '0', note: '' }).problems, { points: 'loyalty.problem.points', note: 'loyalty.problem.note' });
});

test('settings, privacy, messages and the team', () => {
  const settings = storeSettingsForm({ storeName: 'Alpha', instagramHandle: '@alpha', supportWhatsapp: '+91 98000 00001', shippingFeePaise: 4900, freeShippingAbovePaise: 0 });
  const body = accepted('settings.update', built(storeSettingsBody(settings)));
  assert.deepEqual([body.instagramHandle, body.supportWhatsapp, body.shippingFeePaise], ['alpha', '919800000001', 4900]);
  assert.equal(storeSettingsBody({ ...settings, storeName: ' ' }).problems.storeName, 'settings.problem.storeName');
  accepted('privacy.update', built(grievanceBody({ grievanceName: 'Asha', grievanceEmail: 'g@a.in', grievancePhone: '', grievanceAddress: '' })));
  accepted('consentNotice.publish', built(noticeBody({ bodyEn: 'We use your details to deliver.', bodyHi: 'हम आपकी जानकारी डिलीवरी के लिए इस्तेमाल करते हैं।' })));
  const alerts = alertSettingsForm({ whatsapp: true, email: false, events: ['shipped', 'placed', 'bogus'], emailFrom: 'own', emailFromAddress: 'orders@alpha.in', emailReplyTo: '' });
  const alertBody = accepted('alertSettings.update', built(alertSettingsBody(alerts)));
  assert.deepEqual([alertBody.events, alertBody.emailFromLocal], [['placed', 'shipped'], 'orders']);
  accepted('team.invite', built(inviteBody({ contact: '+91 98000 00009', role: 'staff', permissions: ['orders', 'orders'] })));
  accepted('team.invite', built(inviteBody({ contact: 'New@Example.com', role: 'manager', permissions: ['orders'] })));
  assert.deepEqual(inviteBody({ contact: '12', role: 'staff', permissions: [] }).problems, { contact: 'team.problem.contact', permissions: 'team.problem.permissions' });
  assert.deepEqual(teamBody({ role: 'manager', permissions: ['orders'] }), { role: 'manager', permissions: [] }, 'permissions count only for staff');
  accepted('team.update', teamBody({ role: 'staff', permissions: ['catalog'] }));
});

test('F-49 the only owner is never offered a demotion or removal', () => {
  const owner = { id: 1, role: 'owner' };
  assert.equal(isOnlyOwner([owner, { id: 2, role: 'manager' }], owner), true);
  assert.equal(isOnlyOwner([owner, { id: 3, role: 'owner' }], owner), false);
  assert.equal(isOnlyOwner([owner], { id: 2, role: 'manager' }), false);
});

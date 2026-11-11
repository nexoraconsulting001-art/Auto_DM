// The Phase 4 forms and small rules, run in Node: what each form sends is exactly what the API takes (parsed through the
// contract's own schemas), money is integer paise without a floating-point rupee, and the rules the screens show by agree with
// the PRD's scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../../src/contracts/api/index.js';
import { formToOptions, optionsToForm, percentToBp, splitPins } from '../../../console/src/features/payments/form.js';
import { formToSettings as formToShipping, settingsToForm as shippingToForm } from '../../../console/src/features/shipping/form.js';
import { EMPTY_COUPON, couponState, couponSummary, couponToForm, formToCoupon } from '../../../console/src/features/coupons/form.js';
import { formToAdjust, lineToForm, signed } from '../../../console/src/features/inventory/form.js';
import { formToSettings as formToLoyalty, settingsToForm as loyaltyToForm } from '../../../console/src/features/loyalty/form.js';
import * as rules from '../../../console/src/features/orders/shared/rules.js';

const parses = (schema, body, what) => {
  const result = schema.safeParse(body);
  assert.ok(result.success, `${what}: ${JSON.stringify(result.error?.issues ?? '')}`);
  return result.data;
};

// ---- payments ----

const OPTIONS = { upi: true, card: true, netbanking: false, wallet: false, cod: true, partAdvance: false, codFeePaise: 4900, codMaxOrderPaise: null, codPincodes: [], codBlockRtoCount: null, advanceKind: 'fixed', advanceValue: 0, holdMinutes: 30, onlineReady: true };

test('payment options go back unchanged, and what is sent is what the API takes', () => {
  const { body } = formToOptions(optionsToForm(OPTIONS));
  const { onlineReady, ...rest } = OPTIONS;
  assert.equal(onlineReady, true);
  assert.deepEqual(body, rest);
  parses(api.PaymentOptionsUpdate, body, 'payment options');
});

test('cash on delivery: a fee in rupees, a cap, PIN codes and a repeat-refusal block become the API\'s numbers', () => {
  const values = { ...optionsToForm(OPTIONS), codFee: '29.50', codMax: '5,000', codPins: '411001, 411002\n560001 411001', codBlock: '3' };
  const { body } = formToOptions(values);
  assert.equal(body.codFeePaise, 2950);
  assert.equal(body.codMaxOrderPaise, 500000);
  assert.deepEqual(body.codPincodes, ['411001', '411002', '560001']);
  assert.equal(body.codBlockRtoCount, 3);
  parses(api.PaymentOptionsUpdate, body, 'cod options');
  assert.deepEqual(splitPins(' , '), []);
  assert.match(formToOptions({ ...values, codPins: '41100' }).errors.codPins, /41100 isn’t a 6-digit PIN code/);
  assert.ok(formToOptions({ ...values, codBlock: '21' }).errors.codBlock);
  assert.ok(formToOptions({ ...values, codFee: '12.345' }).errors.codFee);
  assert.ok(formToOptions({ ...values, holdMinutes: '4' }).errors.holdMinutes);
  assert.ok(formToOptions({ ...values, holdMinutes: '1441' }).errors.holdMinutes);
});

test('a part advance is a fixed amount in rupees or a percentage in hundredths, and never nothing', () => {
  assert.equal(percentToBp('12.5'), 1250);
  assert.equal(percentToBp('10%'), 1000);
  assert.equal(percentToBp(''), null);
  assert.ok(Number.isNaN(percentToBp('1.234')));
  const base = { ...optionsToForm(OPTIONS), partAdvance: true };
  const percent = formToOptions({ ...base, advanceKind: 'percent', advanceValue: '25' }).body;
  assert.deepEqual([percent.advanceKind, percent.advanceValue], ['percent', 2500]);
  const fixed = formToOptions({ ...base, advanceKind: 'fixed', advanceValue: '199' }).body;
  assert.deepEqual([fixed.advanceKind, fixed.advanceValue], ['fixed', 19900]);
  parses(api.PaymentOptionsUpdate, fixed, 'fixed advance');
  assert.ok(formToOptions({ ...base, advanceKind: 'percent', advanceValue: '101' }).errors.advanceValue);
  assert.ok(formToOptions({ ...base, advanceKind: 'fixed', advanceValue: '0' }).errors.advanceValue);
  assert.equal(optionsToForm({ ...OPTIONS, advanceKind: 'percent', advanceValue: 2500 }).advanceValue, '25');
});

// ---- shipping ----

const SHIPPING = { mode: 'managed', pickupName: 'Kesar Dispatch', pickupPhone: '9811100001', pickupLine1: '4 Mill Lane', pickupLine2: '', pickupCity: 'Pune', pickupStateCode: '27', pickupPincode: '411002', pickupRegistered: true, ownEmail: '', ownPasswordSet: false, chargeBilling: 'payout' };

test('courier settings: the pickup address goes all together, and the own account\'s password only when typed', () => {
  const { body } = formToShipping(shippingToForm(SHIPPING));
  parses(api.ShippingSettingsUpdate, body, 'shipping settings');
  assert.equal(body.ownPassword, undefined);
  assert.equal(body.pickupPincode, '411002');

  const empty = formToShipping({ ...shippingToForm({ ...SHIPPING, pickupName: '', pickupPhone: '', pickupLine1: '', pickupCity: '', pickupStateCode: '', pickupPincode: '' }) }).body;
  assert.equal(empty.pickupName, undefined, 'no pickup address: none is sent');
  parses(api.ShippingSettingsUpdate, empty, 'mode only');

  const half = formToShipping({ ...shippingToForm(SHIPPING), pickupCity: '', pickupPincode: '01234' });
  assert.deepEqual(Object.keys(half.errors).sort(), ['pickupCity', 'pickupPincode']);

  const own = formToShipping({ ...shippingToForm(SHIPPING), mode: 'own', ownEmail: 'api@seller.example', ownPassword: 'secret-1' }).body;
  assert.deepEqual([own.mode, own.ownEmail, own.ownPassword], ['own', 'api@seller.example', 'secret-1']);
  parses(api.ShippingSettingsUpdate, own, 'own courier account');
  assert.ok(formToShipping({ ...shippingToForm(SHIPPING), mode: 'own', ownEmail: 'not-an-email' }).errors.ownEmail);
});

// ---- coupons ----

test('S-45: REEL10 at 10% with a ₹150 cap is sent as the API takes it, and reads back the same', () => {
  const { body } = formToCoupon({ ...EMPTY_COUPON, code: ' reel10 ', kind: 'percent', percent: '10', cap: '150' });
  assert.deepEqual({ code: body.code, kind: body.kind, percentBp: body.percentBp, maxDiscountPaise: body.maxDiscountPaise, amountPaise: body.amountPaise, minOrderPaise: body.minOrderPaise }, { code: 'REEL10', kind: 'percent', percentBp: 1000, maxDiscountPaise: 15000, amountPaise: null, minOrderPaise: 0 });
  const parsed = parses(api.CouponCreate, body, 'coupon');
  const coupon = { id: 1, usedCount: 0, createdAt: new Date().toISOString(), ...parsed };
  assert.equal(couponSummary(coupon), '10% off, up to ₹150');
  assert.deepEqual(formToCoupon(couponToForm(coupon)).body, body);
});

test('a flat or free-delivery coupon, with dates, limits and a scope', () => {
  const starts = '2026-12-01T10:00';
  const ends = '2026-12-31T23:59';
  const flat = formToCoupon({ ...EMPTY_COUPON, code: 'FLAT100', kind: 'flat', amount: '100', minOrder: '999', startsAt: starts, endsAt: ends, maxUses: '50', maxUsesPerCustomer: '1', firstOrderOnly: true, scope: 'categories', scopeIds: [3, 4] }).body;
  assert.deepEqual([flat.amountPaise, flat.minOrderPaise, flat.maxUses, flat.maxUsesPerCustomer, flat.firstOrderOnly, flat.scopeIds], [10000, 99900, 50, 1, true, [3, 4]]);
  parses(api.CouponCreate, flat, 'flat coupon');
  assert.equal(couponSummary({ ...flat, percentBp: null }), '₹100 off on ₹999 or more');
  const free = formToCoupon({ ...EMPTY_COUPON, code: 'SHIPFREE', kind: 'free_shipping' }).body;
  parses(api.CouponCreate, free, 'free delivery');
  assert.equal(couponSummary(free), 'Free delivery');

  assert.ok(formToCoupon({ ...EMPTY_COUPON, code: 'X' }).errors.code);
  assert.ok(formToCoupon({ ...EMPTY_COUPON, code: 'OK1', percent: '0' }).errors.percent);
  assert.ok(formToCoupon({ ...EMPTY_COUPON, code: 'OK1', kind: 'flat', amount: '' }).errors.amount);
  assert.ok(formToCoupon({ ...EMPTY_COUPON, code: 'OK1', percent: '5', startsAt: ends, endsAt: starts }).errors.endsAt);
  assert.ok(formToCoupon({ ...EMPTY_COUPON, code: 'OK1', percent: '5', scope: 'products', scopeIds: [] }).errors.scopeIds);
  assert.ok(formToCoupon({ ...EMPTY_COUPON, code: 'OK1', percent: '5', maxUsesPerCustomer: '1001' }).errors.maxUsesPerCustomer);
});

test('a used coupon keeps its code and kind: the edit sends neither', () => {
  const coupon = { id: 9, code: 'REEL10', kind: 'percent', percentBp: 1000, amountPaise: null, maxDiscountPaise: 15000, minOrderPaise: 0, startsAt: null, endsAt: null, maxUses: 100, maxUsesPerCustomer: 1, usedCount: 4, firstOrderOnly: false, scope: 'all', scopeIds: [], pageId: null, active: true, createdAt: new Date().toISOString() };
  const { body } = formToCoupon({ ...couponToForm(coupon), active: false }, { locked: true });
  assert.equal(body.code, undefined);
  assert.equal(body.kind, undefined);
  assert.equal(body.active, false);
  parses(api.CouponUpdate, body, 'locked edit');
});

test('a coupon says whether it is running', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const base = { active: true, startsAt: null, endsAt: null, maxUses: null, usedCount: 0 };
  assert.equal(couponState(base, now).text, 'Running');
  assert.equal(couponState({ ...base, active: false }, now).text, 'Off');
  assert.equal(couponState({ ...base, endsAt: '2026-11-10T00:00:00Z' }, now).text, 'Ended');
  assert.equal(couponState({ ...base, maxUses: 5, usedCount: 5 }, now).text, 'Used up');
  assert.equal(couponState({ ...base, startsAt: '2026-12-01T00:00:00Z' }, now).text, 'Starts later');
});

// ---- stock ----

const LINE = { productId: 7, variantId: 12, name: 'Kurta', option: 'M', sku: 'K-M', stock: 5, reserved: 1, available: 4, lowStockThreshold: null, low: false };

test('a stock change sends exactly one of a new count or a change, as the API requires', () => {
  const set = formToAdjust({ ...lineToForm(LINE), amount: '9' }, LINE).body;
  assert.deepEqual(set, { productId: 7, variantId: 12, stock: 9 });
  parses(api.StockAdjust, set, 'set');
  const moved = formToAdjust({ way: 'move', amount: '-3', lowAt: '', note: 'Damaged' }, LINE).body;
  assert.deepEqual(moved, { productId: 7, variantId: 12, delta: -3, note: 'Damaged' });
  parses(api.StockAdjust, moved, 'move');
  const added = formToAdjust({ way: 'move', amount: '+4', lowAt: '' }, LINE).body;
  assert.equal(added.delta, 4);
  const unlimited = formToAdjust({ way: 'unlimited', amount: '', lowAt: '' }, LINE).body;
  assert.equal(unlimited.stock, null);
  parses(api.StockAdjust, unlimited, 'unlimited');
  const lowOnly = formToAdjust({ way: 'set', amount: '5', lowAt: '2' }, LINE).body;
  assert.deepEqual([lowOnly.stock, lowOnly.lowStockThreshold], [5, 2]);
  parses(api.StockAdjust, lowOnly, 'with an alert level');
});

test('stock never goes below zero, and an uncounted item is set before it is moved', () => {
  assert.match(formToAdjust({ way: 'move', amount: '-6', lowAt: '' }, LINE).errors.amount, /Only 5 on hand/);
  assert.ok(formToAdjust({ way: 'move', amount: '0', lowAt: '' }, LINE).errors.amount);
  assert.ok(formToAdjust({ way: 'set', amount: '-1', lowAt: '' }, LINE).errors.amount);
  assert.match(formToAdjust({ way: 'move', amount: '2', lowAt: '' }, { ...LINE, stock: null }).errors.amount, /Set its stock first/);
  assert.deepEqual(lineToForm({ ...LINE, stock: null }).way, 'unlimited');
  assert.equal(signed(3), '+3');
  assert.equal(signed(-2), '−2');
});

// ---- loyalty ----

test('S-87: 1 point for every ₹100 is sent as 1 point per 10,000 paise, and reads back the same', () => {
  const settings = { available: true, enabled: true, earnPoints: 1, earnPerPaise: 10000, pointValuePaise: 100, maxRedeemPoints: 50, expiryDays: null, referralEnabled: true, friendRewardPaise: 5000, referrerPoints: 20 };
  const { body } = formToLoyalty(loyaltyToForm(settings));
  const { available, ...rest } = settings;
  assert.equal(available, true);
  assert.deepEqual(body, rest);
  parses(api.LoyaltySettingsUpdate, body, 'loyalty');
  assert.ok(formToLoyalty({ ...loyaltyToForm(settings), earnPer: '0' }).errors.earnPer);
  assert.ok(formToLoyalty({ ...loyaltyToForm(settings), expiryDays: '0' }).errors.expiryDays);
  assert.ok(formToLoyalty({ ...loyaltyToForm(settings), maxRedeemPoints: '1.5' }).errors.maxRedeemPoints);
});

// ---- the screens' rules ----

const ORDER = { flow: 'checkout', fulfilmentStatus: 'packed', paymentStatus: 'paid', holdReason: null, paidPaise: 99900, refundedPaise: 0, cancelReason: null };

test('an order shows its two statuses apart, and any hold; a Phase 0 order shows its one status', () => {
  assert.deepEqual(rules.orderBadges(ORDER).map((b) => b.text), ['Packed', 'Paid']);
  assert.deepEqual(rules.orderBadges({ ...ORDER, holdReason: 'paid_out_of_stock' }).map((b) => b.text), ['Packed', 'Paid', 'Paid, out of stock']);
  assert.deepEqual(rules.orderBadges({ ...ORDER, fulfilmentStatus: 'pending', paymentStatus: 'unpaid' }).map((b) => b.text), ['Awaiting payment', 'Unpaid']);
  assert.equal(rules.orderBadges({ flow: 'manual' }), null);
});

test('S-27, S-28: what can be refunded is what was paid less what was refunded', () => {
  assert.equal(rules.refundable(ORDER), 99900);
  assert.equal(rules.refundable({ ...ORDER, refundedPaise: 20000 }), 79900);
  assert.equal(rules.refundable({ ...ORDER, refundedPaise: 99900 }), 0);
  assert.equal(rules.refundable({ flow: 'checkout' }), 0);
});

test('S-41: only an order cancelled for late payment, and then paid, can be brought back', () => {
  assert.equal(rules.canReinstate({ ...ORDER, fulfilmentStatus: 'cancelled', cancelReason: 'hold_expired' }), true);
  assert.equal(rules.canReinstate({ ...ORDER, fulfilmentStatus: 'cancelled', cancelReason: 'seller' }), false);
  assert.equal(rules.canReinstate({ ...ORDER, fulfilmentStatus: 'cancelled', cancelReason: 'hold_expired', paymentStatus: 'refunded' }), false);
});

test('the courier is offered for a confirmed order that hasn\'t left and has no live parcel', () => {
  assert.equal(rules.canBookCourier(ORDER, []), true);
  assert.equal(rules.canBookCourier({ ...ORDER, fulfilmentStatus: 'new' }, [{ kind: 'forward', status: 'cancelled' }]), true);
  assert.equal(rules.canBookCourier(ORDER, [{ kind: 'forward', status: 'awb_assigned' }]), false);
  assert.equal(rules.canBookCourier(ORDER, [{ kind: 'reverse', status: 'in_transit' }]), true);
  assert.equal(rules.canBookCourier({ ...ORDER, fulfilmentStatus: 'pending' }, []), false);
  assert.equal(rules.canBookCourier({ ...ORDER, fulfilmentStatus: 'shipped' }, []), false);
  assert.equal(rules.canBookCourier({ ...ORDER, holdReason: 'review' }, []), false);
  assert.equal(rules.canBookCourier({ ...ORDER, flow: 'manual' }, []), false);
});

test('the timeline says what changed and who, as a role, in the seller\'s words', () => {
  const at = '2026-11-11T06:30:00Z';
  const packed = rules.timelineStep({ id: 1, kind: 'fulfilment', from: 'new', to: 'packed', actor: 'Owner', reason: '', note: '', at });
  assert.equal(packed.title, 'Packed');
  assert.match(packed.meta, /^From New · Owner · /);
  assert.equal(rules.timelineStep({ id: 2, kind: 'payment', from: 'unpaid', to: 'paid', actor: 'Payment gateway', reason: '', note: '', at }).title, 'Payment: Paid');
  assert.equal(rules.timelineStep({ id: 3, kind: 'hold', from: '', to: 'payment_mismatch', actor: 'System', reason: '', note: '', at }).title, 'On hold: Payment needs review');
  assert.equal(rules.timelineStep({ id: 4, kind: 'hold', from: 'review', to: '', actor: 'Manager', reason: '', note: '', at }).title, 'Hold released');
  const note = rules.timelineStep({ id: 5, kind: 'note', from: '', to: '', actor: 'Staff', reason: '', note: 'Called the customer', at });
  assert.deepEqual([note.title, note.note], ['Note', 'Called the customer']);
  assert.equal(rules.timelineStep({ id: 6, kind: 'created', from: '', to: '', actor: 'Customer', reason: '', note: '', at }).title, 'Order placed');
});

test('a return, a review and a data request offer only their next steps, and read in words', () => {
  assert.deepEqual(rules.returnMoves({ status: 'requested' }), ['approve', 'decline']);
  for (const status of ['approved', 'pickup_scheduled', 'picked_up']) assert.deepEqual(rules.returnMoves({ status }), ['receive'], status);
  assert.deepEqual(rules.returnMoves({ status: 'received' }), ['refund', 'exchange']);
  for (const status of ['rejected', 'refunded', 'exchanged', 'cancelled']) assert.deepEqual(rules.returnMoves({ status }), [], status);
  const order = { items: [{ id: 1, pricePaise: 50000, qty: 2, discountPaise: 10000 }, { id: 2, pricePaise: 30000, qty: 1, discountPaise: 0 }] };
  assert.equal(rules.returnValue({ items: [{ orderItemId: 1, qty: 1 }] }, order), 45000, 'one of two, less its share of the discount');
  assert.equal(rules.returnValue({ items: [{ orderItemId: 1, qty: 2 }, { orderItemId: 2, qty: 1 }] }, order), 120000);
  assert.equal(rules.returnValue({ items: [{ orderItemId: 9, qty: 1 }] }, order), 0, 'a line not on the order counts for nothing');
  assert.deepEqual(rules.reviewMoves({ status: 'pending' }), { approve: true, hide: true, reply: true });
  assert.deepEqual(rules.reviewMoves({ status: 'approved' }), { approve: false, hide: true, reply: true });
  assert.deepEqual(rules.reviewMoves({ status: 'hidden' }), { approve: true, hide: false, reply: true });
  assert.equal(rules.summaryText({ ordersMasked: 3, addresses_removed: 2, reviews: 0 }), 'orders masked: 3 · addresses removed: 2');
  assert.deepEqual(rules.shopperBadges({ signedIn: false, marketing: { whatsapp: true, email: false } }).map((b) => b.text), ['Guest', 'WhatsApp offers: yes']);
});

test('S-42: tax reads as CGST and SGST in the same state and IGST otherwise; the GST form checks as the API does', () => {
  assert.equal(rules.taxLine({ cgstPaise: 2500, sgstPaise: 2500, igstPaise: 0 }), 'CGST ₹25 · SGST ₹25');
  assert.equal(rules.taxLine({ cgstPaise: 0, sgstPaise: 0, igstPaise: 5000 }), 'IGST ₹50');
  assert.equal(rules.taxLine({ cgstPaise: 0, sgstPaise: 0, igstPaise: 0 }), 'No GST');
  assert.deepEqual(rules.invoiceErrors({ gstin: '27ABCDE1234F1Z5', stateCode: '27', invoicePrefix: 'INV' }), {});
  assert.deepEqual(rules.invoiceErrors({ gstin: '', stateCode: '', invoicePrefix: 'inv' }), {}, 'no GSTIN is a bill of supply; the prefix is made capital');
  assert.deepEqual(Object.keys(rules.invoiceErrors({ gstin: '27ABCDE1234F1Z5', stateCode: '07', invoicePrefix: 'TOOLONG' })).sort(), ['invoicePrefix', 'stateCode']);
  assert.ok(rules.invoiceErrors({ gstin: 'bad', stateCode: '', invoicePrefix: 'A' }).gstin);
});

test('a refund key is unique per opening and is a key the API takes; numbers typed are whole or not at all', () => {
  const one = rules.freshKey('refund');
  assert.notEqual(one, rules.freshKey('refund'));
  assert.match(one, /^[\w-]{8,80}$/);
  assert.equal(api.RefundCreate.shape.idempotencyKey.safeParse(one).success, true);
  assert.equal(rules.toWhole(' 12 '), 12);
  assert.equal(rules.toWhole(''), null);
  assert.ok(Number.isNaN(rules.toWhole('1.5')));
  assert.equal(rules.toSigned('-20'), -20);
  assert.equal(rules.toSigned('+5'), 5);
  assert.ok(Number.isNaN(rules.toSigned('5-')));
  assert.equal(rules.skipText('template_pending'), 'Template pending');
  assert.equal(rules.skipText('something_new'), 'something_new');
});

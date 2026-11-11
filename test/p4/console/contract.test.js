// The console can import nothing from the server but the API's access rules, so the Phase 4 store screens carry their own copy
// of the contract's statuses, words and limits (console/src/features/orders/shared). This keeps each copy equal to the server's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as orders from '../../../src/contracts/orders.js';
import { PLAN_REASON } from '../../../src/contracts/catalog.js';
import * as api from '../../../src/contracts/api/index.js';
import { PaiseInput } from '../../../src/contracts/api/common.js';
import * as mirror from '../../../console/src/features/orders/shared/contract.js';
import * as labels from '../../../console/src/features/orders/shared/labels.js';
import * as filters from '../../../console/src/features/orders/shared/filters.js';
import { ONLINE_METHODS } from '../../../console/src/features/payments/form.js';
import { ADJUST_WAYS, MOVEMENT_REASONS } from '../../../console/src/features/inventory/form.js';
import { PICKUP_FIELDS } from '../../../console/src/features/shipping/form.js';
import { DOC_TYPES } from '../../../console/src/features/orders/shared/rules.js';

/** The enum inside a schema, through optional, nullable, default and array. */
function inner(schema) {
  let s = schema;
  while (s && !s.options && typeof s.unwrap === 'function') s = s.unwrap();
  return s;
}
const enumOf = (schema, field) => [...inner(schema.shape[field]).options];
const queryEnum = (routeId, field) => enumOf(api.routes[routeId].query, field);
const keys = (pairs) => pairs.map(([key]) => key);
const sorted = (list) => [...list].sort();

test('the order statuses, ways of paying, holds and reasons are the server\'s', () => {
  for (const name of ['ORDER_FLOWS', 'FULFILMENT_STATUSES', 'PAYMENT_STATUSES', 'PAYMENT_MODES', 'HOLD_REASONS', 'CANCEL_REASONS', 'PAYMENT_ATTEMPT_STATUSES', 'REFUND_STATUSES', 'SHIPMENT_STATUSES', 'RETURN_STATUSES', 'SHIPPED_OR_LATER']) {
    assert.deepEqual([...mirror[name]], [...orders[name]], name);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(mirror.STATUS_LABELS)), JSON.parse(JSON.stringify(orders.STATUS_LABELS)));
  assert.deepEqual({ ...mirror.INDIAN_STATES }, { ...orders.INDIAN_STATES });
  assert.equal(String(mirror.PINCODE), String(orders.PINCODE));
  assert.equal(mirror.PINCODE_MESSAGE, orders.PINCODE_MESSAGE);
});

test('the seller\'s own moves are the ones the API takes, and only moves the state machine has', () => {
  assert.deepEqual(sorted(mirror.SELLER_CANCEL_REASONS), sorted(enumOf(api.OrderCancel, 'reason')));
  assert.deepEqual(sorted(mirror.HAND_MOVES), sorted(enumOf(api.OrderAdvance, 'to')));
  const reachable = new Set(orders.TRANSITIONS.fulfilment.map((move) => move.to));
  for (const move of mirror.HAND_MOVES) assert.ok(reachable.has(move), move);
  for (const reason of mirror.SELLER_CANCEL_REASONS) assert.ok(orders.CANCEL_REASONS.includes(reason), reason);
});

test('the store\'s other lists are the API\'s', () => {
  assert.deepEqual(sorted(mirror.SETTLEMENT_KINDS), sorted(enumOf(api.SettlementLine, 'kind')));
  assert.deepEqual(sorted(mirror.BUSINESS_TYPES), sorted(enumOf(api.LinkedAccountStart, 'businessType')));
  assert.deepEqual(sorted(mirror.COUPON_KINDS), sorted(enumOf(api.Coupon, 'kind')));
  assert.deepEqual(sorted(mirror.COUPON_SCOPES), sorted(enumOf(api.Coupon, 'scope')));
  assert.deepEqual(sorted(mirror.REVIEW_STATUSES), sorted(enumOf(api.Review, 'status')));
  assert.deepEqual(sorted(mirror.LOYALTY_KINDS), sorted(enumOf(api.LoyaltyEntry, 'kind')));
  assert.deepEqual(sorted(mirror.REFERRAL_STATUSES), sorted(enumOf(api.Referral, 'status')));
  assert.deepEqual(sorted(mirror.DATA_REQUEST_KINDS), sorted(enumOf(api.DataRequest, 'kind')));
  assert.deepEqual(sorted(mirror.DATA_REQUEST_STATUSES), sorted(enumOf(api.DataRequest, 'status')));
  assert.deepEqual([...mirror.POLICY_KINDS], [...api.POLICY_KINDS]);
  assert.deepEqual([...mirror.ALERT_EVENTS], enumOf(api.AlertSettings, 'events'));
  assert.deepEqual(sorted(mirror.ORDER_ALERT_STATUSES), sorted(enumOf(api.OrderAlert, 'status')));
  assert.deepEqual(sorted(mirror.TEMPLATE_STATUSES), sorted(enumOf(api.WhatsappTemplate, 'status')));
  assert.deepEqual(keys(ONLINE_METHODS), ['upi', 'card', 'netbanking', 'wallet']);
  for (const [method] of ONLINE_METHODS) assert.ok(api.PaymentOptionsUpdate.shape[method], method);
  for (const field of PICKUP_FIELDS) assert.ok(api.ShippingSettingsUpdate.shape[field], field);
  assert.deepEqual(sorted(Object.keys(DOC_TYPES)), sorted(enumOf(api.Invoice, 'docType')));
});

test('the limits the forms check are the API\'s', () => {
  assert.equal(PaiseInput.safeParse(mirror.MAX_PAISE).success, true);
  assert.equal(PaiseInput.safeParse(mirror.MAX_PAISE + 1).success, false);
  const hold = inner(api.PaymentOptionsUpdate.shape.holdMinutes);
  assert.deepEqual({ ...mirror.HOLD_MINUTES }, { min: hold.minValue, max: hold.maxValue });
  const windowDays = inner(api.ReturnSettingsUpdate.shape.windowDays);
  assert.deepEqual({ ...mirror.RETURN_WINDOW_DAYS }, { min: windowDays.minValue, max: windowDays.maxValue });
  // The codes, GSTINs and prefixes the forms accept are exactly the ones the API accepts.
  const code = api.CouponCreate.shape.code;
  for (const value of ['REEL10', 'DIWALI-50', 'A1', 'X', '-BAD', 'BAD CODE', 'A'.repeat(40), 'A'.repeat(41), 'ok_2']) {
    assert.equal(mirror.COUPON_CODE.test(value.trim().toUpperCase()), code.safeParse(value).success, value);
  }
  const gstin = api.InvoiceSettingsUpdate.shape.gstin;
  for (const value of ['27ABCDE1234F1Z5', '07AAACB1234A1ZV', '27ABCDE1234F1Y5', 'abc', '2ABCDE1234F1Z5']) {
    assert.equal(mirror.GSTIN.test(value), gstin.safeParse(value).success, value);
  }
  const prefix = api.InvoiceSettingsUpdate.shape.invoicePrefix;
  for (const value of ['INV', 'A1', 'ABCDE', 'inv', '']) assert.equal(mirror.INVOICE_PREFIX.test(value), prefix.safeParse(value).success, value);
});

test('a refusal for a feature the plan lacks is recognised however the server words its reason', () => {
  assert.ok(mirror.PLAN_REASONS.includes(PLAN_REASON));
  assert.ok(mirror.PLAN_REASONS.includes('plan'), 'Phase 4 modules refuse with reason "plan"');
});

test('every status the console shows has words and a tone, and none it doesn\'t know', () => {
  const TONES = new Set(['neutral', 'neel', 'good', 'warn', 'bad', 'ink']);
  const tables = {
    FULFILMENT: orders.FULFILMENT_STATUSES, PAYMENT: orders.PAYMENT_STATUSES, HOLD: orders.HOLD_REASONS, PAYMENT_ATTEMPT: orders.PAYMENT_ATTEMPT_STATUSES,
    REFUND: orders.REFUND_STATUSES, SHIPMENT: orders.SHIPMENT_STATUSES, RETURN: orders.RETURN_STATUSES, REVIEW: mirror.REVIEW_STATUSES, REFERRAL: mirror.REFERRAL_STATUSES,
    DATA_REQUEST: mirror.DATA_REQUEST_STATUSES, ORDER_ALERT: mirror.ORDER_ALERT_STATUSES, TEMPLATE: mirror.TEMPLATE_STATUSES, KYC: inner(api.PaymentAccount.shape.kycStatus).options,
  };
  for (const [name, statuses] of Object.entries(tables)) {
    assert.deepEqual(sorted(Object.keys(labels[name])), sorted(statuses), name);
    for (const [status, { label, tone }] of Object.entries(labels[name])) {
      assert.ok(label, `${name}.${status}: no words`);
      assert.ok(TONES.has(tone), `${name}.${status}: tone ${tone}`);
    }
  }
  const words = {
    PAYMENT_MODE_LABELS: orders.PAYMENT_MODES, CANCEL_REASON_LABELS: orders.CANCEL_REASONS, SELLER_CANCEL_LABELS: mirror.SELLER_CANCEL_REASONS, HAND_MOVE_LABELS: mirror.HAND_MOVES,
    HAND_MOVE_DONE: mirror.HAND_MOVES, PAYMENT_PURPOSE: inner(api.Payment.shape.purpose).options, TRANSFER: inner(api.Payment.shape.transferStatus).options,
    REVERSAL: inner(api.Refund.shape.reversalStatus).options, SHIPMENT_MODE: inner(api.Shipment.shape.mode).options, SETTLEMENT: mirror.SETTLEMENT_KINDS,
    BUSINESS_TYPE_LABELS: mirror.BUSINESS_TYPES, COUPON_KIND_LABELS: mirror.COUPON_KINDS, COUPON_SCOPE_LABELS: mirror.COUPON_SCOPES, LOYALTY_KIND_LABELS: mirror.LOYALTY_KINDS,
    LOYALTY_ENTRY: inner(api.LoyaltyEntry.shape.status).options, DATA_REQUEST_KIND_LABELS: mirror.DATA_REQUEST_KINDS, DATA_REQUEST_SOURCE: inner(api.DataRequest.shape.source).options,
    POLICY_LABELS: mirror.POLICY_KINDS, ALERT_EVENT_LABELS: mirror.ALERT_EVENTS, COD_RISK: inner(api.Order.shape.codRisk).options,
  };
  for (const [name, list] of Object.entries(words)) assert.deepEqual(sorted(Object.keys(labels[name])), sorted(list), name);
  assert.deepEqual(sorted(Object.keys(MOVEMENT_REASONS)), sorted(['sale', 'cancel', 'rto', 'return', 'manual', 'import', 'shopify', 'correction']), 'stock_movements.reason (migration 405)');
  assert.deepEqual(keys(ADJUST_WAYS), ['set', 'move', 'unlimited']);
});

test('S-53: a WhatsApp template still in review reads "Template pending"', () => {
  assert.equal(labels.SKIP_REASONS.template_pending, 'Template pending');
});

test('every filter chip is a value the API\'s list takes', () => {
  assert.deepEqual(keys(filters.STOCK_SHOW), queryEnum('inventory.list', 'show'));
  assert.deepEqual(keys(filters.COUPON_SHOW), queryEnum('coupons.list', 'show'));
  assert.deepEqual(keys(filters.DATA_REQUEST_SHOW), queryEnum('dataRequests.list', 'status'));
  assert.deepEqual(keys(filters.ALERT_SHOW), queryEnum('orderAlerts.list', 'status'));
  for (const status of filters.RETURN_SHOW) assert.ok(queryEnum('returns.list', 'status').includes(status), status);
  assert.deepEqual(sorted(['all', ...mirror.REVIEW_STATUSES]), sorted(queryEnum('reviews.list', 'status')));
  assert.deepEqual([...mirror.FULFILMENT_STATUSES], queryEnum('orders.list', 'fulfilment'));
  assert.deepEqual([...mirror.PAYMENT_STATUSES], queryEnum('orders.list', 'payment'));
});

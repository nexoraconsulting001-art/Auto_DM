/**
 * Orders as data (PRD 9.5 to 9.10, 9.12, 9.17): every status, every allowed move, every order event, and the store's limits.
 * No imports, so the server, the worker and the console read the same rules. The functions that change an order are in
 * src/modules/orders/state.js, and migration 402 holds the same moves in `status_transitions`, where a database trigger
 * refuses anything else. A test keeps the two in step: change a move here and in a new migration together.
 *
 * An order has two statuses, kept apart (9.9):
 *   fulfilment_status  where the parcel is
 *   payment_status     where the money is
 * and may be on hold (`hold_reason`) without changing either.
 *
 * `orders.status` is the Phase 0 column. The database now derives it from the two above, so Phase 0 to 3 readers (home
 * numbers, traffic, the funnel) keep working unchanged: see legacyStatus().
 */

/** `flow` says which rules made the order: the Phase 0 manual-UPI store, or Phase 4 checkout. Only checkout orders obey the machines below. */
export const ORDER_FLOWS = Object.freeze(['manual', 'checkout']);

export const FULFILMENT_STATUSES = Object.freeze(['pending', 'new', 'packed', 'ready_to_ship', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'rto_initiated', 'rto_delivered']);
/** `submitted` is the Phase 0 "I've paid" claim: a manual order can hold it, no checkout order can reach it. */
export const PAYMENT_STATUSES = Object.freeze(['unpaid', 'submitted', 'cod_due', 'advance_paid', 'paid', 'partially_refunded', 'refunded', 'voided']);
export const PAYMENT_MODES = Object.freeze(['prepaid', 'cod', 'part_advance', 'manual']);
export const HOLD_REASONS = Object.freeze(['payment_mismatch', 'paid_out_of_stock', 'cod_risk', 'review']);
export const CANCEL_REASONS = Object.freeze(['shopper', 'seller', 'hold_expired', 'payment_failed', 'out_of_stock', 'fraud', 'other']);

/** One payment attempt at the gateway (`payments.status`), a refund, a shipment and a return each have their own small machine. */
export const PAYMENT_ATTEMPT_STATUSES = Object.freeze(['created', 'authorized', 'captured', 'failed', 'cancelled']);
export const REFUND_STATUSES = Object.freeze(['requested', 'processed', 'failed']);
export const SHIPMENT_STATUSES = Object.freeze(['created', 'awb_assigned', 'pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'delivered', 'rto_initiated', 'rto_delivered', 'cancelled', 'lost']);
export const RETURN_STATUSES = Object.freeze(['requested', 'approved', 'rejected', 'pickup_scheduled', 'picked_up', 'received', 'refunded', 'exchanged', 'cancelled']);

/**
 * Guards: a move that also needs something else to be true. The database checks the same ones.
 *   confirmed_payment  the money side says the order may go ahead: paid, advance paid, or cash on delivery confirmed (S-68)
 *   late_payment       a cancelled order comes back only if its hold ran out and the money then arrived (S-41)
 *   mode_prepaid / mode_cod / mode_part_advance   the order was placed with that way of paying
 */
export const GUARDS = Object.freeze(['confirmed_payment', 'late_payment', 'mode_prepaid', 'mode_cod', 'mode_part_advance']);

const move = (from, to, guard = '') => Object.freeze({ from, to, guard });

/**
 * Every allowed move, per machine. Anything not listed is refused, in code and by the database. Nothing moves backwards:
 * a late "failed" never undoes "captured", a late "in transit" never undoes "delivered".
 */
export const TRANSITIONS = Object.freeze({
  fulfilment: Object.freeze([
    move('pending', 'new', 'confirmed_payment'),
    move('pending', 'cancelled'),
    move('new', 'packed'),
    move('new', 'ready_to_ship'),
    move('new', 'shipped'), // the seller ships it themselves
    move('new', 'cancelled'),
    move('packed', 'ready_to_ship'),
    move('packed', 'shipped'),
    move('packed', 'cancelled'),
    move('ready_to_ship', 'shipped'),
    move('ready_to_ship', 'cancelled'),
    move('shipped', 'out_for_delivery'),
    move('shipped', 'delivered'),
    move('shipped', 'rto_initiated'),
    move('out_for_delivery', 'delivered'),
    move('out_for_delivery', 'rto_initiated'),
    move('rto_initiated', 'rto_delivered'),
    move('rto_initiated', 'delivered'),
    move('cancelled', 'new', 'late_payment'),
  ]),
  payment: Object.freeze([
    move('unpaid', 'paid', 'mode_prepaid'),
    move('unpaid', 'advance_paid', 'mode_part_advance'),
    move('unpaid', 'cod_due', 'mode_cod'),
    move('cod_due', 'paid'), // collected at the door
    move('cod_due', 'voided'), // cancelled or returned to origin: nothing was or will be collected
    move('advance_paid', 'paid'), // the balance was collected at the door
    move('advance_paid', 'partially_refunded'),
    move('advance_paid', 'refunded'),
    move('paid', 'partially_refunded'),
    move('paid', 'refunded'),
    move('partially_refunded', 'refunded'),
  ]),
  payment_attempt: Object.freeze([
    move('created', 'authorized'),
    move('created', 'captured'),
    move('created', 'failed'),
    move('created', 'cancelled'),
    move('authorized', 'captured'),
    move('authorized', 'failed'),
    move('failed', 'authorized'), // the gateway's events can arrive out of order
    move('failed', 'captured'),
  ]),
  refund: Object.freeze([
    move('requested', 'processed'),
    move('requested', 'failed'),
    move('failed', 'processed'),
  ]),
  shipment: Object.freeze([
    move('created', 'awb_assigned'), move('created', 'cancelled'),
    move('awb_assigned', 'pickup_scheduled'), move('awb_assigned', 'picked_up'), move('awb_assigned', 'in_transit'), move('awb_assigned', 'cancelled'),
    move('pickup_scheduled', 'picked_up'), move('pickup_scheduled', 'in_transit'), move('pickup_scheduled', 'cancelled'),
    move('picked_up', 'in_transit'), move('picked_up', 'out_for_delivery'), move('picked_up', 'delivered'), move('picked_up', 'rto_initiated'), move('picked_up', 'lost'),
    move('in_transit', 'out_for_delivery'), move('in_transit', 'undelivered'), move('in_transit', 'delivered'), move('in_transit', 'rto_initiated'), move('in_transit', 'lost'),
    move('out_for_delivery', 'delivered'), move('out_for_delivery', 'undelivered'), move('out_for_delivery', 'rto_initiated'), move('out_for_delivery', 'lost'),
    move('undelivered', 'out_for_delivery'), move('undelivered', 'delivered'), move('undelivered', 'rto_initiated'), move('undelivered', 'lost'),
    move('rto_initiated', 'rto_delivered'), move('rto_initiated', 'delivered'), move('rto_initiated', 'lost'),
  ]),
  return: Object.freeze([
    move('requested', 'approved'), move('requested', 'rejected'), move('requested', 'cancelled'),
    move('approved', 'pickup_scheduled'), move('approved', 'received'), move('approved', 'cancelled'),
    move('pickup_scheduled', 'picked_up'), move('pickup_scheduled', 'received'), move('pickup_scheduled', 'cancelled'),
    move('picked_up', 'received'),
    move('received', 'refunded'), move('received', 'exchanged'),
  ]),
});
export const MACHINES = Object.freeze(Object.keys(TRANSITIONS));

const INITIAL = Object.freeze({ fulfilment: 'pending', payment: 'unpaid', payment_attempt: 'created', refund: 'requested', shipment: 'created', return: 'requested' });
export const initialStatus = (machine) => INITIAL[machine];

/** The move from `from` to `to` in `machine`, or null when it isn't allowed. Staying where it is is never a move. */
export function findTransition(machine, from, to) {
  return TRANSITIONS[machine]?.find((t) => t.from === from && t.to === to) ?? null;
}
export const nextStatuses = (machine, from) => (TRANSITIONS[machine] ?? []).filter((t) => t.from === from).map((t) => t.to);
export const isTerminal = (machine, status) => nextStatuses(machine, status).length === 0;

/** True when `order` ({ payment_status, payment_mode, cancel_reason }, as it will be after the move) passes `guard`. */
export function passesGuard(guard, order) {
  switch (guard) {
    case '': return true;
    case 'confirmed_payment': return ['paid', 'advance_paid', 'cod_due'].includes(order.payment_status);
    case 'late_payment': return order.cancel_reason === 'hold_expired' && ['paid', 'advance_paid'].includes(order.payment_status);
    case 'mode_prepaid': return order.payment_mode === 'prepaid';
    case 'mode_cod': return order.payment_mode === 'cod';
    case 'mode_part_advance': return order.payment_mode === 'part_advance';
    default: return false;
  }
}

/** Shipped or later: the parcel has left, so "cancel before shipment" no longer applies (9.9, 9.17). */
export const SHIPPED_OR_LATER = Object.freeze(['shipped', 'out_for_delivery', 'delivered', 'rto_initiated', 'rto_delivered']);
export const canCancelBeforeShipment = (order) => !SHIPPED_OR_LATER.includes(order.fulfilment_status) && order.fulfilment_status !== 'cancelled';

/** The Phase 0 status for an order's two statuses, exactly as migration 402 derives it. A confirmed order counts as 'paid' there, cash on delivery included. */
export function legacyStatus(fulfilment, payment) {
  if (fulfilment === 'cancelled' || fulfilment === 'rto_initiated' || fulfilment === 'rto_delivered') return 'cancelled';
  if (fulfilment === 'delivered') return 'delivered';
  if (fulfilment === 'shipped' || fulfilment === 'out_for_delivery') return 'shipped';
  if (fulfilment === 'pending') return payment === 'submitted' ? 'payment_submitted' : 'awaiting_payment';
  return 'paid';
}

/** What a seller reads. Buyer pages write their own words, in the seller's brand. */
export const STATUS_LABELS = Object.freeze({
  fulfilment: Object.freeze({ pending: 'Awaiting payment', new: 'New', packed: 'Packed', ready_to_ship: 'Ready to ship', shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', rto_initiated: 'Returning to you', rto_delivered: 'Returned to you' }),
  payment: Object.freeze({ unpaid: 'Unpaid', submitted: 'Payment claimed', cod_due: 'Cash on delivery', advance_paid: 'Advance paid', paid: 'Paid', partially_refunded: 'Partially refunded', refunded: 'Refunded', voided: 'Nothing due' }),
  hold: Object.freeze({ payment_mismatch: 'Payment needs review', paid_out_of_stock: 'Paid, out of stock', cod_risk: 'High refusal risk', review: 'On hold' }),
});

/**
 * Order events (the outbox, migration 403). The database writes one in the same transaction as the change, for every row
 * it names: an order, a payment, a refund, a shipment, a return. Modules may add the ones marked `emitted` with
 * orderEvents.emit(t, ...) in their own transaction. Listeners get { id, type, tenantId, orderId, entity, entityId, from, to, data, createdAt }:
 * ids and statuses only, never a name, phone number, address or message text. Load what you need by id.
 */
const ORDER_EVENT_OF_PAYMENT = Object.freeze({ paid: 'order.paid', advance_paid: 'order.advance_paid', cod_due: 'order.cod_confirmed', voided: 'order.cod_voided', partially_refunded: 'order.partially_refunded', refunded: 'order.refunded' });
/** The event type the database writes for a move. Kept here so tests can hold the trigger to it. */
export function eventTypeFor(entity, from, to) {
  if (entity === 'order.fulfilment') {
    if (to === 'new') return from === 'cancelled' ? 'order.reinstated' : 'order.confirmed';
    return `order.${to}`;
  }
  if (entity === 'order.payment') return ORDER_EVENT_OF_PAYMENT[to] ?? null;
  return `${entity}.${to}`;
}

export const ORDER_EVENTS = Object.freeze([
  'order.created', 'order.confirmed', 'order.reinstated', 'order.packed', 'order.ready_to_ship', 'order.shipped', 'order.out_for_delivery', 'order.delivered',
  'order.cancelled', 'order.rto_initiated', 'order.rto_delivered',
  'order.paid', 'order.advance_paid', 'order.cod_confirmed', 'order.cod_voided', 'order.partially_refunded', 'order.refunded',
  'order.held', 'order.released',
  ...PAYMENT_ATTEMPT_STATUSES.map((s) => `payment.${s}`),
  ...REFUND_STATUSES.map((s) => `refund.${s}`),
  ...SHIPMENT_STATUSES.map((s) => `shipment.${s}`),
  ...RETURN_STATUSES.map((s) => `return.${s}`),
  // emitted by modules, with orderEvents.emit:
  'invoice.issued', 'credit_note.issued', 'order.return_window_closed', 'order.note_added', 'stock.committed', 'stock.released', 'stock.restocked',
]);
export const EMITTED_EVENTS = Object.freeze(['invoice.issued', 'credit_note.issued', 'order.return_window_closed', 'order.note_added', 'stock.committed', 'stock.released', 'stock.restocked']);
export const ORDER_EVENT_ENTITIES = Object.freeze(['order', 'payment', 'refund', 'shipment', 'return', 'invoice', 'stock']);

/** Numbers the store runs on. A track reads them from here; none is typed anywhere else. */
export const STORE_LIMITS = Object.freeze({
  maxQtyPerLine: 10, // 9.2
  maxCartLines: 50,
  searchQueryChars: 80, // 9.1
  holdMinutes: 30, // 9.12: an unpaid prepaid order keeps its stock this long (payment_settings.hold_minutes overrides)
  pendingCheckAfterMinutes: 15, // 9.7: ask the gateway about orders still pending
  orderAttempts: Object.freeze({ limit: 20, windowMs: 10 * 60_000 }), // 9.5, per IP, across every instance (platform.rateLimit)
  otp: Object.freeze({ digits: 6, validMs: 5 * 60_000, wrongTries: 3, sendsPerHour: 5, sendsPerIpPerHour: 20 }), // 9.3
  reminders: Object.freeze({ max: 2, afterMs: Object.freeze([3_600_000, 24 * 3_600_000]), quietFromHour: 21, quietToHour: 9 }), // 9.15, shopper time
  wishlistItems: 200, // 9.20
  review: Object.freeze({ minStars: 1, maxStars: 5, textChars: 1000, photos: 3 }), // 9.19
  providerTimeoutMs: 10_000, // 9.10
  maxOrderPaise: 100_000_000_000 * 50, // 50 lines of the dearest product the catalog accepts
});

/** A 6-digit PIN that doesn't start with 0 (9.4). */
export const PINCODE = /^[1-9][0-9]{5}$/;
export const PINCODE_MESSAGE = 'Enter a 6-digit PIN code';

/** Indian states and union territories, by GST state code (9.4 picks from this list; 9.13 compares the codes). */
export const INDIAN_STATES = Object.freeze({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam',
  19: 'West Bengal', 20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra',
  29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh',
});
export const stateCodeOf = (name) => Object.entries(INDIAN_STATES).find(([, n]) => n.toLowerCase() === String(name ?? '').trim().toLowerCase())?.[0] ?? null;

/**
 * Money rules every total obeys, in whole paise (9.5, 9.13, 9.14). The server works these out from database prices; a
 * client never sends an amount.
 *
 *   subtotal = sum(line price x qty)
 *   total    = subtotal - discount - loyalty + shipping + cod fee        (never below 0)
 *   advance + balance = total for a part-advance order; balance = total for cash on delivery
 *   Prices include GST: taxable = round(gross x 10000 / (10000 + rate_bp)); tax = gross - taxable (S-42)
 *   Same state: CGST = floor(tax / 2), SGST = tax - CGST. Otherwise IGST = tax.
 */
export function orderTotal({ subtotalPaise, discountPaise = 0, loyaltyPaise = 0, shippingPaise = 0, codFeePaise = 0 }) {
  const parts = [subtotalPaise, discountPaise, loyaltyPaise, shippingPaise, codFeePaise];
  if (!parts.every((n) => Number.isSafeInteger(n) && n >= 0)) throw new RangeError('Order amounts are whole paise, zero or more');
  const total = subtotalPaise - discountPaise - loyaltyPaise + shippingPaise + codFeePaise;
  if (total < 0) throw new RangeError('A discount can’t be more than the order');
  return total;
}

/** GST inside a tax-inclusive amount. rateBp is the rate in hundredths of a percent: 5% is 500. */
export function taxInside(grossPaise, rateBp) {
  if (!Number.isSafeInteger(grossPaise) || grossPaise < 0) throw new RangeError('Amount is whole paise, zero or more');
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) throw new RangeError('GST rate is 0 to 10000 basis points');
  const taxable = Number((BigInt(grossPaise) * 10000n + BigInt(10000 + rateBp) / 2n) / BigInt(10000 + rateBp));
  return { taxablePaise: taxable, taxPaise: grossPaise - taxable };
}

export function splitGst(taxPaise, { sellerState, buyerState }) {
  if (sellerState && buyerState && String(sellerState) === String(buyerState)) {
    const cgst = Math.floor(taxPaise / 2);
    return { cgstPaise: cgst, sgstPaise: taxPaise - cgst, igstPaise: 0 };
  }
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise };
}

/** The financial year a moment falls in, in India: 2026 means April 2026 to March 2027 (9.13). The database works out the same in migration 408. */
export function financialYear(at = new Date()) {
  const ist = new Date(new Date(at).getTime() + 5.5 * 3_600_000);
  return ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
}
export const financialYearLabel = (fy) => `${String(fy % 100).padStart(2, '0')}-${String((fy + 1) % 100).padStart(2, '0')}`;

/**
 * The parts of the Phase 4 contract (src/contracts/orders.js and the store route files) the console's store screens need. The
 * console may import nothing from the contract but the access rules, so these are the server's values written out here, and
 * test/p4/console/contract.test.js fails the moment one differs from the server's own copy. Change them there first.
 */

/** A feature the plan lacks: 403 with one of these reasons (Phase 3 sends the long one, Phase 4 modules the short one). */
export const PLAN_REASONS = Object.freeze(['plan', 'plan.not_included']);

export const ORDER_FLOWS = Object.freeze(['manual', 'checkout']);
export const FULFILMENT_STATUSES = Object.freeze(['pending', 'new', 'packed', 'ready_to_ship', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'rto_initiated', 'rto_delivered']);
export const PAYMENT_STATUSES = Object.freeze(['unpaid', 'submitted', 'cod_due', 'advance_paid', 'paid', 'partially_refunded', 'refunded', 'voided']);
export const PAYMENT_MODES = Object.freeze(['prepaid', 'cod', 'part_advance', 'manual']);
export const HOLD_REASONS = Object.freeze(['payment_mismatch', 'paid_out_of_stock', 'cod_risk', 'review']);
export const CANCEL_REASONS = Object.freeze(['shopper', 'seller', 'hold_expired', 'payment_failed', 'out_of_stock', 'fraud', 'other']);
/** What a seller may give as the reason when they cancel (OrderCancel). */
export const SELLER_CANCEL_REASONS = Object.freeze(['seller', 'out_of_stock', 'fraud', 'other']);
/** The moves a seller makes by hand (OrderAdvance). */
export const HAND_MOVES = Object.freeze(['packed', 'shipped', 'delivered']);
export const PAYMENT_ATTEMPT_STATUSES = Object.freeze(['created', 'authorized', 'captured', 'failed', 'cancelled']);
export const REFUND_STATUSES = Object.freeze(['requested', 'processed', 'failed']);
export const SHIPMENT_STATUSES = Object.freeze(['created', 'awb_assigned', 'pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'delivered', 'rto_initiated', 'rto_delivered', 'cancelled', 'lost']);
export const RETURN_STATUSES = Object.freeze(['requested', 'approved', 'rejected', 'pickup_scheduled', 'picked_up', 'received', 'refunded', 'exchanged', 'cancelled']);
export const SHIPPED_OR_LATER = Object.freeze(['shipped', 'out_for_delivery', 'delivered', 'rto_initiated', 'rto_delivered']);

export const SETTLEMENT_KINDS = Object.freeze(['sale', 'gateway_fee', 'gateway_fee_tax', 'shipping_charge', 'refund', 'transfer', 'transfer_reversal', 'cod_remittance', 'adjustment']);
export const BUSINESS_TYPES = Object.freeze(['individual', 'proprietorship', 'partnership', 'private_limited', 'llp', 'other']);
export const COUPON_KINDS = Object.freeze(['percent', 'flat', 'free_shipping']);
export const COUPON_SCOPES = Object.freeze(['all', 'products', 'categories']);
export const REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'hidden']);
export const LOYALTY_KINDS = Object.freeze(['earn', 'redeem', 'reverse', 'restore', 'expire', 'referral', 'adjust']);
export const REFERRAL_STATUSES = Object.freeze(['pending', 'rewarded', 'blocked', 'void']);
export const DATA_REQUEST_KINDS = Object.freeze(['erasure', 'access']);
export const DATA_REQUEST_STATUSES = Object.freeze(['requested', 'processing', 'completed', 'rejected']);
export const POLICY_KINDS = Object.freeze(['privacy', 'terms', 'refund', 'shipping']);
export const ALERT_EVENTS = Object.freeze(['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']);
export const ORDER_ALERT_STATUSES = Object.freeze(['queued', 'sent', 'delivered', 'failed', 'skipped']);
export const TEMPLATE_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'paused']);

/** The largest amount one money field takes (the API's PaiseInput). */
export const MAX_PAISE = 2_147_483_647;
export const HOLD_MINUTES = Object.freeze({ min: 5, max: 1440 });
export const RETURN_WINDOW_DAYS = Object.freeze({ min: 0, max: 90 });
export const COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
export const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
export const PINCODE = /^[1-9][0-9]{5}$/;
export const PINCODE_MESSAGE = 'Enter a 6-digit PIN code';
export const INVOICE_PREFIX = /^[A-Z0-9]{1,4}$/;

/** Indian states and union territories, by GST state code. */
export const INDIAN_STATES = Object.freeze({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam',
  19: 'West Bengal', 20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra',
  29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh',
});

/** What a seller reads: the server's STATUS_LABELS, word for word. */
export const STATUS_LABELS = Object.freeze({
  fulfilment: Object.freeze({ pending: 'Awaiting payment', new: 'New', packed: 'Packed', ready_to_ship: 'Ready to ship', shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', rto_initiated: 'Returning to you', rto_delivered: 'Returned to you' }),
  payment: Object.freeze({ unpaid: 'Unpaid', submitted: 'Payment claimed', cod_due: 'Cash on delivery', advance_paid: 'Advance paid', paid: 'Paid', partially_refunded: 'Partially refunded', refunded: 'Refunded', voided: 'Nothing due' }),
  hold: Object.freeze({ payment_mismatch: 'Payment needs review', paid_out_of_stock: 'Paid, out of stock', cod_risk: 'High refusal risk', review: 'On hold' }),
});

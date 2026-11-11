import { STATUS_LABELS } from './contract.js';

/**
 * How each Phase 4 status reads and looks in the console. Words are the seller's; tones are the design system's badge tones
 * (neutral, neel, good, warn, bad, ink). A test keeps every key one for one with the contract's lists.
 */
const tones = (labels, toneOf) => Object.freeze(Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, Object.freeze({ label, tone: toneOf[key] ?? 'neutral' })])));

export const FULFILMENT = tones(STATUS_LABELS.fulfilment, {
  pending: 'warn', new: 'neel', packed: 'neel', ready_to_ship: 'neel', shipped: 'neel', out_for_delivery: 'neel', delivered: 'good', cancelled: 'bad', rto_initiated: 'warn', rto_delivered: 'bad',
});
export const PAYMENT = tones(STATUS_LABELS.payment, {
  unpaid: 'warn', submitted: 'neel', cod_due: 'neutral', advance_paid: 'neel', paid: 'good', partially_refunded: 'warn', refunded: 'neutral', voided: 'neutral',
});
export const HOLD = tones(STATUS_LABELS.hold, { payment_mismatch: 'bad', paid_out_of_stock: 'bad', cod_risk: 'warn', review: 'warn' });

export const PAYMENT_MODE_LABELS = Object.freeze({ prepaid: 'Paid online', cod: 'Cash on delivery', part_advance: 'Part advance', manual: 'UPI, paid by hand' });
export const CANCEL_REASON_LABELS = Object.freeze({
  shopper: 'Cancelled by the customer', seller: 'Cancelled by you', hold_expired: 'Not paid in time', payment_failed: 'Payment failed', out_of_stock: 'Out of stock', fraud: 'Suspected fraud', other: 'Other reason',
});
/** The words for the seller's own choice of reason, in the cancel sheet. */
export const SELLER_CANCEL_LABELS = Object.freeze({ seller: 'I can’t fulfil it', out_of_stock: 'Out of stock', fraud: 'Looks like fraud', other: 'Another reason' });
/** What the button for each hand move says. */
export const HAND_MOVE_LABELS = Object.freeze({ packed: 'Mark as packed', shipped: 'Mark as shipped', delivered: 'Mark as delivered' });
export const HAND_MOVE_DONE = Object.freeze({ packed: 'Marked as packed.', shipped: 'Marked as shipped.', delivered: 'Marked as delivered.' });
export const COD_RISK = Object.freeze({ none: null, elevated: { label: 'Some refusal risk', tone: 'warn' }, high: { label: 'High refusal risk', tone: 'bad' } });

export const PAYMENT_ATTEMPT = tones({ created: 'Started', authorized: 'Authorised', captured: 'Captured', failed: 'Failed', cancelled: 'Cancelled' }, { created: 'neutral', authorized: 'neel', captured: 'good', failed: 'bad', cancelled: 'neutral' });
export const PAYMENT_PURPOSE = Object.freeze({ full: 'Full payment', advance: 'Advance', cod: 'Collected at the door' });
export const TRANSFER = Object.freeze({ none: '', created: 'Transfer started', processed: 'Transferred', settled: 'Settled to your bank', failed: 'Transfer failed', reversed: 'Transfer reversed' });
export const REFUND = tones({ requested: 'Requested', processed: 'Refunded', failed: 'Failed' }, { requested: 'neel', processed: 'good', failed: 'bad' });
export const REVERSAL = Object.freeze({ none: '', pending: 'Taking it back from your transfer', reversed: 'Taken back from your transfer', failed: 'Reversal failed', recover: 'Recovered from your next payout' });

export const SHIPMENT = tones({
  created: 'Created', awb_assigned: 'AWB assigned', pickup_scheduled: 'Pickup booked', picked_up: 'Picked up', in_transit: 'In transit', out_for_delivery: 'Out for delivery', undelivered: 'Delivery failed',
  delivered: 'Delivered', rto_initiated: 'Returning to you', rto_delivered: 'Returned to you', cancelled: 'Cancelled', lost: 'Lost',
}, { created: 'neutral', awb_assigned: 'neel', pickup_scheduled: 'neel', picked_up: 'neel', in_transit: 'neel', out_for_delivery: 'neel', undelivered: 'warn', delivered: 'good', rto_initiated: 'warn', rto_delivered: 'bad', cancelled: 'neutral', lost: 'bad' });
export const SHIPMENT_MODE = Object.freeze({ managed: 'Bhava courier account', own: 'Your Shiprocket account', self: 'Shipped by you' });

export const RETURN = tones({
  requested: 'Requested', approved: 'Approved', rejected: 'Declined', pickup_scheduled: 'Pickup booked', picked_up: 'Picked up', received: 'Received', refunded: 'Refunded', exchanged: 'Exchanged', cancelled: 'Cancelled',
}, { requested: 'warn', approved: 'neel', rejected: 'neutral', pickup_scheduled: 'neel', picked_up: 'neel', received: 'neel', refunded: 'good', exchanged: 'good', cancelled: 'neutral' });

export const SETTLEMENT = Object.freeze({
  sale: 'Sale', gateway_fee: 'Gateway fee', gateway_fee_tax: 'GST on gateway fee', shipping_charge: 'Courier charge', refund: 'Refund', transfer: 'Transfer to you',
  transfer_reversal: 'Transfer taken back', cod_remittance: 'Cash on delivery paid to you', adjustment: 'Adjustment',
});
export const BUSINESS_TYPE_LABELS = Object.freeze({ individual: 'Individual', proprietorship: 'Sole proprietor', partnership: 'Partnership', private_limited: 'Private limited company', llp: 'LLP', other: 'Other' });
export const KYC = tones({ not_started: 'Not started', pending: 'Being checked', verified: 'Verified', rejected: 'Not accepted' }, { not_started: 'neutral', pending: 'warn', verified: 'good', rejected: 'bad' });

export const COUPON_KIND_LABELS = Object.freeze({ percent: 'Percentage off', flat: 'Amount off', free_shipping: 'Free delivery' });
export const COUPON_SCOPE_LABELS = Object.freeze({ all: 'Whole order', products: 'Some products', categories: 'Some categories' });
export const REVIEW = tones({ pending: 'Waiting for you', approved: 'Showing', hidden: 'Hidden' }, { pending: 'warn', approved: 'good', hidden: 'neutral' });
export const LOYALTY_KIND_LABELS = Object.freeze({ earn: 'Earned', redeem: 'Spent', reverse: 'Taken back', restore: 'Given back', expire: 'Expired', referral: 'Referral reward', adjust: 'Changed by you' });
export const LOYALTY_ENTRY = Object.freeze({ pending: 'Pending', posted: '', void: 'Cancelled' });
export const REFERRAL = tones({ pending: 'Waiting', rewarded: 'Rewarded', blocked: 'Blocked', void: 'Cancelled' }, { pending: 'neutral', rewarded: 'good', blocked: 'bad', void: 'neutral' });
export const DATA_REQUEST = tones({ requested: 'Requested', processing: 'In progress', completed: 'Done', rejected: 'Declined' }, { requested: 'warn', processing: 'neel', completed: 'good', rejected: 'neutral' });
export const DATA_REQUEST_KIND_LABELS = Object.freeze({ erasure: 'Delete their data', access: 'A copy of their data' });
export const DATA_REQUEST_SOURCE = Object.freeze({ account: 'From their account', seller: 'Made by you', grievance: 'Through your grievance contact' });
export const POLICY_LABELS = Object.freeze({ privacy: 'Privacy policy', terms: 'Terms of sale', refund: 'Refunds and returns', shipping: 'Shipping and delivery' });
export const ALERT_EVENT_LABELS = Object.freeze({ placed: 'Order placed', paid: 'Payment received', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded' });
export const ORDER_ALERT = tones({ queued: 'Waiting to send', sent: 'Sent', delivered: 'Delivered', failed: 'Failed', skipped: 'Not sent' }, { queued: 'neutral', sent: 'neel', delivered: 'good', failed: 'bad', skipped: 'warn' });
/** Why an alert was not sent, in the seller's words. "Template pending" is the PRD's own (S-53). */
export const SKIP_REASONS = Object.freeze({
  template_pending: 'Template pending',
  off: 'This alert is off',
  no_consent: 'The customer didn’t agree to this channel',
  no_channel: 'No WhatsApp account or email to send from',
  no_address: 'No phone number or email for this customer',
  platform_name: 'The message named the platform, so it wasn’t sent',
  invalid: 'The message was missing its unsubscribe link',
  unknown_delivery: 'The answer was lost, so it wasn’t sent again',
});
export const TEMPLATE = tones({ pending: 'Pending review', approved: 'Approved', rejected: 'Not approved', paused: 'Paused' }, { pending: 'warn', approved: 'good', rejected: 'bad', paused: 'warn' });

export const statusOf = (table, status) => table[status] ?? { label: String(status ?? ''), tone: 'neutral' };

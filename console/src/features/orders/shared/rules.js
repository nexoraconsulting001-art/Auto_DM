import { formatDateTime, formatPaise } from '../../../lib/format.js';
import { GSTIN, INVOICE_PREFIX } from './contract.js';
import { FULFILMENT, HOLD, PAYMENT, SKIP_REASONS, statusOf } from './labels.js';

/**
 * The store screens' small rules, kept out of the components so they are tested in Node: what an order's badges say, what a
 * seller may do next with a return or a review, when a courier can be booked, what can still be refunded, and how the
 * timeline, invoices and data requests read.
 */

/** An order's badges: its two statuses and any hold for a checkout order; null for a Phase 0 order, which shows its one status. */
export function orderBadges(order) {
  if (order.flow !== 'checkout') return null;
  const fulfilment = statusOf(FULFILMENT, order.fulfilmentStatus);
  const payment = statusOf(PAYMENT, order.paymentStatus);
  const hold = order.holdReason ? statusOf(HOLD, order.holdReason) : null;
  return [
    { tone: fulfilment.tone, text: fulfilment.label },
    payment.label !== fulfilment.label && { tone: payment.tone, text: payment.label },
    hold && { tone: hold.tone, text: hold.label },
  ].filter(Boolean);
}

/** What can still go back to the customer: what was paid, less what has been refunded. */
export const refundable = (order) => Math.max(0, (order.paidPaise ?? 0) - (order.refundedPaise ?? 0));

/** A cancelled order whose money came after its hold ran out (S-41): the seller may bring it back. */
export const canReinstate = (order) => order.fulfilmentStatus === 'cancelled' && order.cancelReason === 'hold_expired' && ['paid', 'advance_paid'].includes(order.paymentStatus);

const ENDED_SHIPMENTS = new Set(['cancelled', 'rto_delivered', 'lost']);
/** True when the order is going ahead, hasn't left yet, has no hold, and has no live parcel of its own. */
export function canBookCourier(order, shipments) {
  if (order.flow !== 'checkout' || order.holdReason) return false;
  if (!['new', 'packed'].includes(order.fulfilmentStatus)) return false;
  return !shipments.some((shipment) => shipment.kind === 'forward' && !ENDED_SHIPMENTS.has(shipment.status));
}
export const CANCELLABLE_SHIPMENTS = Object.freeze(['created', 'awb_assigned', 'pickup_scheduled']);

/** One line of the timeline in words. `actor` is already a role or "System": never anyone's name (9.9). */
export function timelineStep(entry) {
  const meta = `${entry.actor} · ${formatDateTime(entry.at)}`;
  const note = [entry.reason, entry.note].filter(Boolean).join(' · ');
  switch (entry.kind) {
    case 'created':
      return { key: entry.id, title: 'Order placed', meta, note };
    case 'fulfilment':
      return { key: entry.id, title: statusOf(FULFILMENT, entry.to).label, meta: `${entry.from ? `From ${statusOf(FULFILMENT, entry.from).label} · ` : ''}${meta}`, note };
    case 'payment':
      return { key: entry.id, title: `Payment: ${statusOf(PAYMENT, entry.to).label}`, meta, note };
    case 'hold':
      return { key: entry.id, title: entry.to ? `On hold: ${statusOf(HOLD, entry.to).label}` : 'Hold released', meta, note };
    default:
      return { key: entry.id, title: 'Note', meta, note };
  }
}

const RECEIVABLE = new Set(['approved', 'pickup_scheduled', 'picked_up']);
/** What the seller may do next with a return, by its status (9.17). */
export function returnMoves(ret) {
  if (ret.status === 'requested') return ['approve', 'decline'];
  if (RECEIVABLE.has(ret.status)) return ['receive'];
  if (ret.status === 'received') return ['refund', 'exchange'];
  return [];
}

/**
 * What the returned lines were sold for, less their share of the discount: the refund a return suggests. The owner may change
 * it, and the server holds any refund inside what was paid.
 */
export function returnValue(ret, order) {
  const lines = new Map((order.items ?? []).map((item) => [item.id, item]));
  return ret.items.reduce((sum, line) => {
    const item = lines.get(line.orderItemId);
    if (!item || !item.qty) return sum;
    const each = item.pricePaise - Math.floor((item.discountPaise ?? 0) / item.qty);
    return sum + Math.max(0, each) * Math.min(line.qty, item.qty);
  }, 0);
}

/** What the seller may do with a review: approve or hide it, and reply once. The shopper's words are never edited (9.19). */
export const reviewMoves = (review) => ({ approve: review.status !== 'approved', hide: review.status !== 'hidden', reply: true });

/** The badges of one customer: signed in or a guest, and the offers they said yes to here, never at another store (S-104). */
export function shopperBadges(shopper) {
  return [
    shopper.signedIn ? { tone: 'neel', text: 'Signed in' } : { tone: 'neutral', text: 'Guest' },
    shopper.marketing.whatsapp && { tone: 'good', text: 'WhatsApp offers: yes' },
    shopper.marketing.email && { tone: 'good', text: 'Email offers: yes' },
  ].filter(Boolean);
}

/** "orders masked: 3" from { ordersMasked: 3 }: the counts of what a data request erased, numbers only. */
export function summaryText(summary) {
  return Object.entries(summary ?? {})
    .filter(([, n]) => Number(n) > 0)
    .map(([key, n]) => `${key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().trim()}: ${n}`)
    .join(' · ');
}

/** What each GST document is called (9.13). Without a GSTIN the document is a bill of supply. */
export const DOC_TYPES = Object.freeze({ invoice: 'Tax invoice', bill_of_supply: 'Bill of supply', credit_note: 'Credit note' });

/** The tax of one document in words: CGST and SGST in the same state, IGST otherwise (S-42). */
export function taxLine(invoice) {
  if (invoice.igstPaise) return `IGST ${formatPaise(invoice.igstPaise)}`;
  if (invoice.cgstPaise || invoice.sgstPaise) return `CGST ${formatPaise(invoice.cgstPaise)} · SGST ${formatPaise(invoice.sgstPaise)}`;
  return 'No GST';
}

/** The invoice settings form checked as the API checks it, and the GSTIN against the state picked. */
export function invoiceErrors(values) {
  const errors = {};
  const gstin = String(values.gstin ?? '').trim().toUpperCase();
  if (gstin && !GSTIN.test(gstin)) errors.gstin = 'Enter a valid GSTIN';
  if (gstin && values.stateCode && gstin.slice(0, 2) !== values.stateCode) errors.stateCode = 'The GSTIN starts with another state’s code';
  if (!INVOICE_PREFIX.test(String(values.invoicePrefix ?? '').trim().toUpperCase())) errors.invoicePrefix = 'Use up to 4 capital letters or digits';
  return errors;
}

/** Why a message wasn't sent, in words; "Template pending" for a WhatsApp template still in review (S-53). */
export const skipText = (reason) => SKIP_REASONS[reason] ?? reason;

/** A fresh key for a change that must happen once however many times it is tapped. Works without a secure context. */
export function freshKey(prefix = 'console') {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Whole numbers typed in a form: '' is null, anything else not a whole number is NaN. */
export function toWhole(text) {
  const value = String(text ?? '').trim();
  if (value === '') return null;
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

/** A signed whole number ("-3", "+5", "5"): '' is null, anything else NaN. */
export function toSigned(text) {
  const value = String(text ?? '').trim().replace(/^\+/, '');
  if (value === '') return null;
  return /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
}

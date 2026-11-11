import { z } from 'zod';
import { CANCEL_REASONS, FULFILMENT_STATUSES, HOLD_REASONS, ORDER_FLOWS, PAYMENT_MODES, PAYMENT_STATUSES } from '../orders.js';
import { staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Paise, Timestamp, page, required, text } from './common.js';

const access = staffWith('orders');

export const ORDER_STATUSES = Object.freeze(['awaiting_payment', 'payment_submitted', 'paid', 'shipped', 'delivered', 'cancelled']);
const OrderStatus = z.enum(ORDER_STATUSES);

export const Order = z.object({
  id: Id,
  orderNumber: z.string(),
  status: OrderStatus,
  customerName: z.string(),
  phone: z.string(),
  email: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  pincode: z.string(),
  subtotalPaise: Paise,
  shippingPaise: Paise,
  totalPaise: Paise,
  reelId: z.string().nullable(),
  source: z.string(),
  notes: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /**
   * Phase 4 (PRD 9.9): the two statuses kept apart, and the money in full. `status` above is derived from them and stays
   * for earlier screens. Optional only because the Phase 0 handler doesn't send them; the orders module always does.
   */
  flow: z.enum(ORDER_FLOWS).optional(),
  fulfilmentStatus: z.enum(FULFILMENT_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  paymentMode: z.enum(PAYMENT_MODES).optional(),
  holdReason: z.enum(HOLD_REASONS).nullable().optional(),
  cancelReason: z.enum(CANCEL_REASONS).nullable().optional(),
  discountPaise: Paise.optional(),
  loyaltyPaise: Paise.optional(),
  codFeePaise: Paise.optional(),
  taxPaise: Paise.optional(),
  advancePaise: Paise.optional(),
  balancePaise: Paise.optional(),
  paidPaise: Paise.optional(),
  refundedPaise: Paise.optional(),
  couponCode: z.string().optional(),
  /** A label only: never where it came from (9.22, S-103). */
  codRisk: z.enum(['none', 'elevated', 'high']).nullable().optional(),
  gatewayMode: z.enum(['managed', 'own']).nullable().optional(),
  /** What the seller may do next, worked out by the server from the state machine: the console shows exactly these. */
  nextFulfilment: z.array(z.enum(FULFILMENT_STATUSES)).optional(),
  canCancel: z.boolean().optional(),
  /** A cancelled order that was paid: the owner is prompted to refund this much (S-31). */
  refundDuePaise: Paise.optional(),
  confirmedAt: Timestamp.nullable().optional(),
  shippedAt: Timestamp.nullable().optional(),
  deliveredAt: Timestamp.nullable().optional(),
  cancelledAt: Timestamp.nullable().optional(),
});
export const OrderSummary = Order.extend({ itemCount: Count });
export const OrderItem = z.object({
  id: Id,
  productId: Id.nullable(),
  name: z.string(),
  image: z.string(),
  pricePaise: Paise,
  option: z.string(),
  qty: Count,
  variantId: Id.nullable().optional(),
  sku: z.string().optional(),
  hsnCode: z.string().optional(),
  gstRateBp: z.number().int().min(0).max(10000).optional(),
  discountPaise: Paise.optional(),
  taxPaise: Paise.optional(),
});
export const OrderDetail = Order.extend({ items: z.array(OrderItem) });

export const OrderListQuery = ListQuery.extend({
  status: OrderStatus.optional(),
  search: text(80).optional(),
  fulfilment: z.enum(FULFILMENT_STATUSES).optional(),
  payment: z.enum(PAYMENT_STATUSES).optional(),
  held: z.enum(['true', 'false']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export const OrderStatusUpdate = z.object({ status: OrderStatus, notes: text(1000).optional() });

/** One line of an order's timeline (9.9): who changed what and when. `actor` is a role or "System", never a shopper's name. */
export const OrderTimelineEntry = z.object({
  id: Id,
  kind: z.enum(['created', 'fulfilment', 'payment', 'hold', 'note']),
  from: z.string(),
  to: z.string(),
  actor: z.string(),
  reason: z.string(),
  note: z.string(),
  at: Timestamp,
});
/** The moves a seller makes by hand. What a courier or a gateway reports is not theirs to set (S-30). */
export const OrderAdvance = z.object({ to: z.enum(['packed', 'shipped', 'delivered']), note: text(1000).optional() });
export const OrderCancel = z.object({ reason: z.enum(['seller', 'out_of_stock', 'fraud', 'other']).default('seller'), note: text(1000).optional() });
export const OrderNote = z.object({ note: required(1000, 'Write a note first') });

/** Orders as a CSV file, for this business only (9.9). A download is a file, like every other one a seller takes away. */
export const OrderDownload = z.object({
  id: Id,
  status: z.enum(['queued', 'ready', 'failed', 'expired']),
  rowCount: Count,
  fileUrl: z.string().nullable(),
  createdAt: Timestamp,
  expiresAt: Timestamp.nullable(),
});
export const OrderDownloadCreate = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  fulfilment: z.enum(FULFILMENT_STATUSES).optional(),
  payment: z.enum(PAYMENT_STATUSES).optional(),
});

/**
 * orders.list, .get and .setStatus are answered by admin-api (Phase 0); the orders module replaces them through takesOver.
 * setStatus stays for Phase 0 orders only: a checkout order moves through advance, cancel, a shipment or a payment.
 */
export const orderRoutes = {
  'orders.list': { method: 'GET', path: '/orders', access, query: OrderListQuery, response: page(OrderSummary) },
  'orders.get': { method: 'GET', path: '/orders/:id', access, params: IdParams, response: OrderDetail },
  'orders.setStatus': { method: 'POST', path: '/orders/:id/status', access, params: IdParams, body: OrderStatusUpdate, response: OrderDetail },
  // Phase 4, answered by src/modules/orders
  'orders.timeline': { method: 'GET', path: '/orders/:id/timeline', access, params: IdParams, response: z.object({ items: z.array(OrderTimelineEntry) }) },
  'orders.advance': { method: 'POST', path: '/orders/:id/advance', access, params: IdParams, body: OrderAdvance, response: OrderDetail },
  /** Before shipment only. Releases the stock; a paid order comes back with refundDuePaise for the owner to act on. */
  'orders.cancel': { method: 'POST', path: '/orders/:id/cancel', access, params: IdParams, body: OrderCancel, response: OrderDetail },
  'orders.releaseHold': { method: 'POST', path: '/orders/:id/release-hold', access, params: IdParams, body: OrderNote.partial(), response: OrderDetail },
  /** A cancelled order whose money arrived after its hold ran out, when there is stock for it after all (S-41). */
  'orders.reinstate': { method: 'POST', path: '/orders/:id/reinstate', access, params: IdParams, response: OrderDetail },
  'orders.addNote': { method: 'POST', path: '/orders/:id/notes', access, params: IdParams, body: OrderNote, status: 201, response: OrderTimelineEntry },
  'orderDownloads.list': { method: 'GET', path: '/order-downloads', access, query: ListQuery, response: page(OrderDownload) },
  'orderDownloads.create': { method: 'POST', path: '/order-downloads', access, body: OrderDownloadCreate, status: 201, response: OrderDownload },
  'orderDownloads.get': { method: 'GET', path: '/order-downloads/:id', access, params: IdParams, response: OrderDownload },
};

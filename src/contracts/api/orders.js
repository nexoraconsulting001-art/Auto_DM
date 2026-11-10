import { z } from 'zod';
import { staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Paise, Timestamp, page, text } from './common.js';

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
});
export const OrderDetail = Order.extend({ items: z.array(OrderItem) });

export const OrderListQuery = ListQuery.extend({
  status: OrderStatus.optional(),
  search: text(80).optional(),
});
export const OrderStatusUpdate = z.object({ status: OrderStatus, notes: text(1000).optional() });

export const orderRoutes = {
  'orders.list': { method: 'GET', path: '/orders', access, query: OrderListQuery, response: page(OrderSummary) },
  'orders.get': { method: 'GET', path: '/orders/:id', access, params: IdParams, response: OrderDetail },
  'orders.setStatus': { method: 'POST', path: '/orders/:id/status', access, params: IdParams, body: OrderStatusUpdate, response: OrderDetail },
};

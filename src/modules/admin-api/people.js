import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { refusedByState } from './errors.js';
import { mapPage } from './paging.js';

const toOrder = (o) => ({
  id: o.id,
  orderNumber: o.order_number,
  status: o.status,
  customerName: o.customer_name,
  phone: o.phone,
  email: o.email,
  address: o.address,
  city: o.city,
  state: o.state,
  pincode: o.pincode,
  subtotalPaise: o.subtotal_paise,
  shippingPaise: o.shipping_paise,
  totalPaise: o.total_paise,
  reelId: o.reel_id,
  source: o.source,
  notes: o.notes,
  createdAt: o.created_at,
  updatedAt: o.updated_at,
});

const toOrderDetail = (o) => ({
  ...toOrder(o),
  items: o.items.map((i) => ({ id: i.id, productId: i.product_id, name: i.name, image: i.image, pricePaise: i.price_paise, option: i.option_value, qty: i.qty })),
});

const toCustomer = (u) => ({
  id: u.id,
  name: u.name,
  phone: u.phone,
  email: u.email,
  role: u.role,
  orderCount: u.order_count,
  spentPaise: Number(u.spent),
  createdAt: u.created_at,
});

const toActivity = (a) => ({
  id: a.id,
  commentId: a.comment_id,
  reelId: a.reel_id,
  reelHeadline: a.headline,
  reelSlug: a.slug,
  username: a.username,
  text: a.text,
  result: a.result,
  error: a.error,
  createdAt: a.created_at,
});

/** Eight easy-to-read characters, to pass on over WhatsApp. */
const temporaryPassword = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);

export function peopleApi({ repos }) {
  return {
    'orders.list': async ({ query }) => mapPage(await repos.adminLists.orders(query), (o) => ({ ...toOrder(o), itemCount: o.item_count })),

    'orders.get': async ({ params }) => {
      const order = await repos.orders.get(params.id);
      return order && toOrderDetail(order);
    },

    // The status itself is already valid, so a refusal here is about this order: a cancelled one can't be reopened.
    'orders.setStatus': async ({ params, body }) => {
      const order = await repos.orders.get(params.id);
      if (!order) return null;
      await refusedByState(() => repos.orders.setStatus(order.id, body.status, body.notes));
      return toOrderDetail(await repos.orders.get(order.id));
    },

    'customers.list': async ({ query }) => mapPage(await repos.adminLists.customers(query), toCustomer),

    // Forgot-password flow without SMS: the seller sets a fresh password and passes it on.
    'customers.resetPassword': async ({ params }) => {
      const person = await repos.users.get(params.id);
      if (!person) return null;
      if (person.role !== 'customer') throw new ApiError('forbidden', 'Only a shopper’s password can be reset here.');
      const password = temporaryPassword();
      await repos.users.setPassword(person.id, password);
      return { temporaryPassword: password };
    },

    'activity.list': async ({ query }) => mapPage(await repos.adminLists.activity(query), toActivity),
  };
}

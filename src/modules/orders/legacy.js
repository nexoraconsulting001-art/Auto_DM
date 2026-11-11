import crypto from 'node:crypto';
import { ValidationError, normalizePhone } from '../../util.js';
import { shippingFor } from '../../repos/settings.js';
import { tenantId } from '../../tenancy.js';
import { OrderStateError, setManualStatus } from './state.js';

/**
 * The Phase 0 order repo (repos.orders), moved here with its behaviour unchanged so the orders track owns it: manual UPI
 * orders (flow 'manual'), placed by the Phase 0 store in src/modules/checkout/legacy.js. Phase 4 checkout replaces create();
 * the read methods serve the console's order screens until the orders track takes those routes over. Status changes go
 * through state.js like every other.
 */

export const ORDER_STATUSES = {
  awaiting_payment: 'Awaiting payment',
  payment_submitted: 'Payment submitted',
  paid: 'Paid',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};
export const MAX_QTY_PER_LINE = 10;

export function normalizeCustomer(input = {}) {
  const t = (v) => String(v ?? '').trim();
  const name = t(input.name);
  if (name.length < 2) throw new ValidationError('Enter your full name');
  const phone = normalizePhone(input.phone);
  if (!phone) throw new ValidationError('Enter a 10-digit Indian mobile number');
  const email = t(input.email);
  // Length first: the pattern is slow on a very long address, and no real one is this long.
  if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ValidationError('Enter a valid email, or leave it empty');
  const address = t(input.address);
  if (address.length < 5) throw new ValidationError('Enter your full address');
  const city = t(input.city);
  if (!city) throw new ValidationError('Enter your city');
  const state = t(input.state);
  if (!state) throw new ValidationError('Enter your state');
  const pincode = t(input.pincode);
  if (!/^[1-9]\d{5}$/.test(pincode)) throw new ValidationError('Enter a 6-digit PIN code');
  return {
    name: name.slice(0, 80), phone, email: email.slice(0, 120), address: address.slice(0, 300),
    city: city.slice(0, 60), state: state.slice(0, 60), pincode,
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length) throw new ValidationError('Your bag is empty');
  const merged = new Map();
  for (const it of items.slice(0, 50)) {
    const productId = Number(it?.productId);
    const qty = Math.floor(Number(it?.qty));
    const option = String(it?.option ?? '').trim();
    if (!productId || !(qty > 0)) throw new ValidationError('Your bag has an invalid item. Remove it and try again.');
    const key = `${productId}|${option}`;
    const prev = merged.get(key);
    merged.set(key, { productId, option, qty: Math.min(MAX_QTY_PER_LINE, (prev?.qty || 0) + qty) });
  }
  return [...merged.values()];
}

const orderPrefix = (storeName) =>
  (String(storeName).match(/[A-Za-z0-9]+/g) || ['ORD']).map((w) => w[0]).join('').toUpperCase().slice(0, 4) || 'ORD';

export function ordersRepo(db) {
  async function withItems(order) {
    if (!order) return null;
    order.items = await db.query('SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [order.tenant_id, order.id]);
    return order;
  }

  return {
    /**
     * Places an order. Prices, shipping and stock come from the database, never from the browser.
     * Stock is reserved (decremented) immediately and restored if the order is cancelled.
     */
    async create({ items, customer, reelId = null, source = '', userId = null, visitorId = null }, settings) {
      const lines = normalizeItems(items);
      const c = normalizeCustomer(customer);
      const tid = tenantId();

      return db.tx(async (t) => {
        let subtotal = 0;
        const priced = [];
        for (const line of lines) {
          const [p] = await t.query('SELECT * FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, line.productId]);
          if (!p || !p.active) throw new ValidationError('An item in your bag is no longer available. Remove it and try again.');
          if (p.option_values.length && !p.option_values.includes(line.option)) {
            throw new ValidationError(`Choose a ${p.option_label.toLowerCase() || 'option'} for ${p.name}`);
          }
          if (!p.option_values.length) line.option = '';
          if (p.stock != null) {
            if (p.stock < line.qty) {
              throw new ValidationError(p.stock === 0 ? `${p.name} is sold out` : `Only ${p.stock} left of ${p.name}`);
            }
            await t.query('UPDATE products SET stock = stock - $3 WHERE tenant_id = $1 AND id = $2', [tid, p.id, line.qty]);
          }
          subtotal += p.price_paise * line.qty;
          priced.push({ p, line });
        }
        const shipping = shippingFor(subtotal, settings);

        let validReel = null;
        if (reelId) [validReel] = await t.query('SELECT ig_media_id FROM reels WHERE tenant_id = $1 AND ig_media_id = $2', [tid, String(reelId)]);

        // Order numbers count up per business.
        const [{ n }] = await t.query(
          'UPDATE tenants SET next_order_number = next_order_number + 1 WHERE id = $1 RETURNING next_order_number - 1 AS n',
          [tid],
        );
        const [order] = await t.query(
          `INSERT INTO orders (tenant_id, order_number, public_token, reel_id, source, customer_name, phone, email, address, city,
             state, pincode, subtotal_paise, shipping_paise, total_paise, user_id, visitor_id)
           VALUES ($16, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $17) RETURNING *`,
          [`${orderPrefix(settings.store_name)}-${n}`, crypto.randomBytes(16).toString('base64url'),
            validReel?.ig_media_id ?? null, String(source).slice(0, 20), c.name, c.phone, c.email, c.address, c.city,
            c.state, c.pincode, subtotal, shipping, subtotal + shipping, userId ? Number(userId) : null, tid, visitorId],
        );
        for (const { p, line } of priced) {
          await t.query(
            `INSERT INTO order_items (tenant_id, order_id, product_id, name, image, price_paise, option_value, qty)
             VALUES ($8, $1, $2, $3, $4, $5, $6, $7)`,
            [order.id, p.id, p.name, p.images[0] || '', p.price_paise, line.option, line.qty, tid],
          );
        }
        return order;
      });
    },
    async get(id) {
      const [o] = await db.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(id) || 0]);
      return withItems(o);
    },
    async listForUser(userId) {
      const orders = await db.query('SELECT * FROM orders WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 100', [tenantId(), Number(userId)]);
      for (const o of orders) await withItems(o);
      return orders;
    },
    async getByToken(token) {
      const [o] = await db.query('SELECT * FROM orders WHERE tenant_id = $1 AND public_token = $2', [tenantId(), String(token)]);
      return withItems(o);
    },
    async list({ status = '', search = '' } = {}) {
      return db.query(
        `SELECT o.*, (SELECT coalesce(sum(qty), 0)::int FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS item_count
         FROM orders o
         WHERE o.tenant_id = $3 AND ($1 = '' OR status = $1)
           AND ($2 = '' OR order_number ILIKE '%' || $2 || '%' OR customer_name ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%')
         ORDER BY created_at DESC LIMIT 200`,
        [status, search.trim(), tenantId()],
      );
    },
    /** Shopper tapped "I've paid" on the payment page. */
    async markPaymentSubmitted(token) {
      const tid = tenantId();
      await db.tx(async (t) => {
        const [o] = await t.query('SELECT id, flow FROM orders WHERE tenant_id = $1 AND public_token = $2', [tid, String(token)]);
        if (o?.flow === 'manual') await setManualStatus(t, o.id, 'payment_submitted', { onlyFrom: 'awaiting_payment', actor: 'shopper' });
      });
    },
    async setStatus(id, status, notes) {
      if (!(status in ORDER_STATUSES)) throw new ValidationError('Unknown status');
      const tid = tenantId();
      return db.tx(async (t) => {
        try {
          const { order: o, previous } = await setManualStatus(t, id, status, { notes });
          if (status === 'cancelled' && previous !== 'cancelled') {
            const items = await t.query('SELECT product_id, qty FROM order_items WHERE tenant_id = $1 AND order_id = $2', [tid, o.id]);
            for (const it of items) {
              if (it.product_id) {
                await t.query('UPDATE products SET stock = stock + $3 WHERE tenant_id = $1 AND id = $2 AND stock IS NOT NULL', [tid, it.product_id, it.qty]);
              }
            }
          }
        } catch (err) {
          if (err instanceof OrderStateError) throw new ValidationError(err.code === 'not_found' ? 'Order not found' : err.message);
          throw err;
        }
      });
    },
  };
}

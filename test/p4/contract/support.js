// What the Phase 4 contract tests share: a business with a product, and a checkout order written the way checkout will.
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { setup } from '../../helpers.js';

export const ADDRESS = { name: 'Asha Rao', phone: '+919876543210', line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' };

/** A fresh database with one business and one product in it. `inTenant(fn)` runs fn as that business. */
export async function world({ logins } = {}) {
  const base = await setup(logins ? { logins } : {});
  const product = await base.repos.products.create({ name: 'Brass lamp', price: '500', active: 'on' });
  return { ...base, product, inTenant: (fn) => withTenant(base.tenant, fn) };
}

/** A second business in the same database. */
export async function otherBusiness(w, slug = 'other') {
  const tenant = await w.platform.tenants.ensure({ slug, name: 'Other store' });
  return { tenant, inTenant: (fn) => withTenant(tenant, fn) };
}

/**
 * Inserts a checkout order and its lines in one transaction, as checkout will. `lines` are { pricePaise, qty, discountPaise?, taxPaise? };
 * totals are worked out from them unless given in `order`, which lets a test write a wrong one on purpose.
 */
export async function placeOrder(w, { mode = 'prepaid', lines = [{ pricePaise: 50000, qty: 1 }], shippingPaise = 0, order = {}, t: outer } = {}) {
  const tenantId = w.tenant.id;
  const subtotal = lines.reduce((sum, l) => sum + l.pricePaise * l.qty, 0);
  const discount = lines.reduce((sum, l) => sum + (l.discountPaise ?? 0), 0);
  const tax = lines.reduce((sum, l) => sum + (l.taxPaise ?? 0), 0);
  const total = subtotal - discount + shippingPaise;
  const advance = mode === 'part_advance' ? Math.min(10000, total - 1) : 0;
  const row = {
    order_number: `T-${crypto.randomInt(1e9)}`, public_token: crypto.randomBytes(12).toString('base64url'), flow: 'checkout', payment_mode: mode,
    customer_name: ADDRESS.name, phone: ADDRESS.phone, address: ADDRESS.line1, city: ADDRESS.city, state: 'Maharashtra', pincode: ADDRESS.pincode,
    subtotal_paise: subtotal, discount_paise: discount, shipping_paise: shippingPaise, tax_paise: tax, total_paise: total,
    advance_paise: advance, balance_paise: mode === 'cod' ? total : mode === 'part_advance' ? total - advance : 0,
    idempotency_key: crypto.randomUUID(), shipping_address: JSON.stringify(ADDRESS), ...order,
  };
  const columns = Object.keys(row);
  const run = async (t) => {
    const [created] = await t.query(
      `INSERT INTO orders (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
      [tenantId, ...columns.map((c) => row[c])],
    );
    for (const line of lines) {
      await t.query(
        `INSERT INTO order_items (tenant_id, order_id, product_id, name, price_paise, qty, discount_paise, tax_paise) VALUES ($1, $2, $3, 'Brass lamp', $4, $5, $6, $7)`,
        [tenantId, created.id, w.product.id, line.pricePaise, line.qty, line.discountPaise ?? 0, line.taxPaise ?? 0],
      );
    }
    return created;
  };
  return outer ? run(outer) : w.inTenant(() => w.db.tx(run));
}

/** Runs fn(t) in one transaction as the business. */
export const tx = (w, fn) => w.inTenant(() => w.db.tx(fn));
export const query = (w, sql, params) => w.inTenant(() => w.db.query(sql, params));

/** The constraint a database refusal names, or the error's own code. */
export async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    return err.constraint ?? err.code ?? err.message;
  }
  return null;
}

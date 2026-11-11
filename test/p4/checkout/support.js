// What the checkout track's tests share: a store business (tier 3), products with stock and options, payment settings,
// shopper sessions, and requests with any Host header.
import crypto from 'node:crypto';
import http from 'node:http';
import { withTenant } from '../../../src/tenancy.js';
import { OWNER, startApp } from '../../helpers.js';

export const ADDRESS = Object.freeze({ name: 'Asha Rao', phone: '9876543210', line1: '12 Lake Road', city: 'Pune', stateCode: '27', pincode: '411001' });

/** An app whose default business has the Phase 4 store, with Phase 0 shipping turned off so totals are easy to read. */
export async function storeApp(options = {}) {
  const app = await startApp(options);
  await setPlan(app, app.tenant.id, 't3');
  await inTenant(app, () => app.platform.settings.update({ shipping_fee_paise: '0', free_shipping_above_paise: '0', store_name: 'Neel Studio' }));
  return app;
}

export const setPlan = (app, tenantId, plan) => app.db.platform.query('UPDATE tenants SET plan = $2 WHERE id = $1', [tenantId, plan]);
export const inTenant = (app, fn, tenant = app.tenant) => withTenant(tenant, fn);
export const q = (app, sql, params = [], tenant = app.tenant) => withTenant(tenant, () => app.db.query(sql, params));

/** A second business on its own address (<slug>.bhava.test). */
export async function otherStore(app, { slug = 'other', name = 'Haldi House', plan = 't3' } = {}) {
  const tenant = await app.platform.tenants.ensure({ slug, name });
  await setPlan(app, tenant.id, plan);
  await withTenant(tenant, () => app.platform.settings.update({ shipping_fee_paise: '0', free_shipping_above_paise: '0', store_name: name }));
  return { tenant, host: `${slug}.bhava.test` };
}

/** A product with stock on the product row (null is unlimited). */
export async function product(app, { name = 'Brass lamp', pricePaise = 50000, stock = 5, tenant = app.tenant, gstRateBp = 0, mrpPaise = null } = {}) {
  return withTenant(tenant, async () => {
    const created = await app.platform.products.create({ name, price: String(pricePaise / 100), stock: stock === null ? '' : String(stock), active: 'on' });
    await app.db.query('UPDATE products SET gst_rate_bp = $3, mrp_paise = $4 WHERE tenant_id = $1 AND id = $2', [tenant.id, created.id, gstRateBp, mrpPaise]);
    return { ...created, id: created.id, slug: created.slug };
  });
}

/** Options on a product: one variant per value, each with its own price and stock. Returns the variants by value. */
export async function withSizes(app, productId, sizes, { tenant = app.tenant } = {}) {
  return withTenant(tenant, async () => {
    await app.db.query(`INSERT INTO product_options (tenant_id, product_id, position, name, "values") VALUES ($1, $2, 0, 'Size', $3::text[])`, [tenant.id, productId, sizes.map((s) => s.value)]);
    const out = {};
    for (const [i, s] of sizes.entries()) {
      const [row] = await app.db.query(
        `INSERT INTO product_variants (tenant_id, product_id, position, option_values, sku, price_paise, stock) VALUES ($1, $2, $3, ARRAY[$4]::text[], $5, $6, $7) RETURNING id`,
        [tenant.id, productId, i, s.value, s.sku ?? '', s.pricePaise ?? 50000, s.stock ?? null],
      );
      out[s.value] = row.id;
    }
    return out;
  });
}

/** Payment settings: online payment ready (managed, KYC passed) unless `online: false`, and cash on delivery as asked. */
export async function payments(app, { online = true, cod = false, codFeePaise = 0, codMaxPaise = null, partAdvance = false, advanceKind = 'fixed', advanceValue = 0, holdMinutes = 30, tenant = app.tenant } = {}) {
  await withTenant(tenant, () => app.db.query(
    `INSERT INTO payment_settings (tenant_id, mode, kyc_status, linked_account_id, cod, cod_fee_paise, cod_max_order_paise, part_advance, advance_kind, advance_value, hold_minutes)
     VALUES ($1, 'managed', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id) DO UPDATE SET kyc_status = EXCLUDED.kyc_status, linked_account_id = EXCLUDED.linked_account_id, cod = EXCLUDED.cod, cod_fee_paise = EXCLUDED.cod_fee_paise,
       cod_max_order_paise = EXCLUDED.cod_max_order_paise, part_advance = EXCLUDED.part_advance, advance_kind = EXCLUDED.advance_kind, advance_value = EXCLUDED.advance_value, hold_minutes = EXCLUDED.hold_minutes`,
    [tenant.id, online ? 'verified' : 'pending', online ? `acc_${tenant.id}` : null, cod, codFeePaise, codMaxPaise, partAdvance, advanceKind, advanceValue, holdMinutes],
  ));
}

/** A shopper signed in at one business, and the cookie of one of their sessions (each call is another device). */
export async function shopper(app, { phone = '+919876543210', tenant = app.tenant, verified = true } = {}) {
  return withTenant(tenant, async () => {
    const [row] = await app.db.query(
      `INSERT INTO shoppers (tenant_id, phone, phone_verified_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END)
       ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL DO UPDATE SET last_seen_at = now() RETURNING id`,
      [tenant.id, phone, verified],
    );
    return { id: row.id, phone, cookie: await sessionCookie(app, row.id, tenant) };
  });
}

export async function sessionCookie(app, shopperId, tenant = app.tenant) {
  const token = crypto.randomBytes(32).toString('base64url');
  await withTenant(tenant, () => app.db.query(
    `INSERT INTO shopper_sessions (tenant_id, shopper_id, token_hash, method, expires_at) VALUES ($1, $2, $3, 'whatsapp_otp', now() + interval '1 day')`,
    [tenant.id, shopperId, crypto.createHash('sha256').update(token).digest('hex')],
  ));
  return `_sid=${token}`;
}

/** Any request, with any Host header (fetch can't set one). JSON bodies are sent as JSON. */
export function hit(app, path, { host, method = 'GET', headers = {}, body, cookie, token } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { ...headers };
    if (host) sent.host = host;
    if (cookie) sent.cookie = cookie;
    if (token) sent.authorization = `Bearer ${token}`;
    let payload = body;
    if (body !== undefined && typeof body !== 'string') {
      payload = JSON.stringify(body);
      sent['content-type'] ??= 'application/json';
    }
    if (payload !== undefined) sent['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port: app.port, path, method, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export const quote = (app, body, opts = {}) => hit(app, '/api/store/checkout/quote', { method: 'POST', body, ...opts });

/** A checkout body: one of `productId` unless `lines` are given, guest address, prepaid. */
export function placeBody(productId, over = {}) {
  return {
    lines: [{ productId, variantId: null, qty: 1 }], address: { ...ADDRESS }, paymentMode: 'prepaid', idempotencyKey: crypto.randomUUID(),
    acceptTerms: true, consent: { noticeVersion: 1 }, ...over,
  };
}
export const place = (app, body, opts = {}) => hit(app, '/api/store/checkout', { method: 'POST', body, ...opts });

export async function orderByNumber(app, number, tenant = app.tenant) {
  const [order] = await q(app, 'SELECT * FROM orders WHERE tenant_id = $1 AND order_number = $2', [tenant.id, number], tenant);
  return order;
}
export const stockOf = async (app, productId, tenant = app.tenant) => (await q(app, 'SELECT stock, reserved FROM products WHERE tenant_id = $1 AND id = $2', [tenant.id, productId], tenant))[0];
export const variantStock = async (app, variantId, tenant = app.tenant) => (await q(app, 'SELECT stock, reserved FROM product_variants WHERE tenant_id = $1 AND id = $2', [tenant.id, variantId], tenant))[0];

/** The owner's bearer token for /api/v1. */
export async function ownerToken(app, host) {
  const res = await hit(app, '/api/v1/auth/login', { method: 'POST', body: OWNER, host });
  return res.json.token;
}

/**
 * Marks an order paid as the payments module will: the payment and the order move together, in one transaction, with
 * ifAllowed. `confirm: true` always asks for fulfilment 'new' too, which brings back an order whose hold had run out.
 */
export async function markPaid(app, orderId, { tenant = app.tenant, confirm = false } = {}) {
  const { changeOrder } = await import('../../../src/modules/orders/state.js');
  await withTenant(tenant, () => app.db.tx(async (t) => {
    const [o] = await t.query('SELECT total_paise, advance_paise, payment_mode, fulfilment_status FROM orders WHERE tenant_id = $1 AND id = $2', [tenant.id, orderId]);
    const advance = o.payment_mode === 'part_advance';
    const payment = advance ? 'advance_paid' : 'paid';
    const paid = Number(advance ? o.advance_paise : o.total_paise);
    await changeOrder(t, orderId, { payment, ...(confirm || o.fulfilment_status === 'pending' ? { fulfilment: 'new' } : {}), actor: 'webhook:razorpay', set: { paid_paise: paid }, ifAllowed: true });
  }));
  await app.ctx.orderEvents.settle();
}

export const noPlatformName = (text) => !/bhava/i.test(String(text));

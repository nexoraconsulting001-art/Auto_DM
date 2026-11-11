// What the invoice and return tests share: the real app on a fresh database with the Shiprocket simulator for reverse
// pickups, a business on the store's plan, products with a GST rate and HSN, and checkout orders written the way checkout
// writes them (lines, stock held), then moved through the order state machine as payments and shipping would.
import '../../../tools/net-guard.mjs';
import crypto from 'node:crypto';
import http from 'node:http';
import { bindTenant } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { reserve } from '../../../src/modules/inventory/stock.js';
import { changeOrder, changeRow } from '../../../src/modules/orders/state.js';
import { shopperServices } from '../../../src/modules/shoppers/index.js';
import { csrfFor } from '../../../src/modules/shoppers/keys.js';
import { createShiprocket } from '../../../tools/sim/shiprocket/index.mjs';
import { OWNER, startApp } from '../../helpers.js';

export const PLATFORM_NAME = /bhava/i;

/** One request with any Host header; redirects are not followed. `body` may be an object (JSON) or a Buffer. */
export function raw(port, path, { method = 'GET', host = '127.0.0.1', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { host, ...headers };
    const payload = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (payload !== null) {
      sent['content-type'] ??= 'application/json';
      sent['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json, buffer });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** A multipart body as a browser sends a form with files. */
export function multipart(fields = {}, files = []) {
  const boundary = `----t${crypto.randomUUID().replace(/-/g, '')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'proof'}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

let sharpLib;
/** A real JPEG photo of the item, carrying camera metadata that must not survive storage. */
export async function photo({ color = '#884422', note = 'secret-place-42' } = {}) {
  sharpLib ??= (await import('sharp')).default;
  const data = await sharpLib({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().withExif({ IFD0: { Copyright: note, Artist: note } }).toBuffer();
  return { field: 'proof', filename: 'item.jpg', type: 'image/jpeg', data };
}
/** A few bytes that start like an MP4. */
export const video = () => ({ field: 'proof', filename: 'item.mp4', type: 'video/mp4', data: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(512, 1)]) });

const setPlan = (db, plan, tenant) => db.platform.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, tenant.id]);

async function signIn(port, who, host) {
  const res = await raw(port, '/api/v1/auth/login', { method: 'POST', host, body: who });
  if (!res.json?.token) throw new Error(`sign-in failed with ${res.status}`);
  return res.json.token;
}

let serial = 0;
const next = () => ++serial;

/** A business in the world: calls as its owner, its rows, and orders moved the way the other modules move them. */
function asBusiness(world, { tenant, repos, host, token }) {
  const shop = { tenant, repos, host, token };
  const sql = (text, params = []) => world.db.platform.query(text, params);
  shop.sql = sql;
  shop.one = async (text, params = []) => (await sql(text, params))[0];
  shop.inTenant = (fn) => withTenant(tenant, fn);
  shop.tx = (fn) => withTenant(tenant, () => world.db.tx(fn));
  shop.api = (method, path, body, { as = shop.token, headers = {} } = {}) => raw(world.port, `/api/v1${path}`, { method, host, body, headers: { ...(as ? { authorization: `Bearer ${as}` } : {}), ...headers } });
  shop.page = (path, headers = {}) => raw(world.port, path, { host, headers });
  shop.invoices = (orderId) => sql(`SELECT * FROM invoices WHERE tenant_id = $1 ${orderId ? 'AND order_id = $2' : ''} ORDER BY id`, orderId ? [tenant.id, orderId] : [tenant.id]);
  shop.order = (id) => shop.one('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenant.id, id]);
  shop.stockOf = async (productId) => (await shop.one('SELECT stock, reserved FROM products WHERE tenant_id = $1 AND id = $2', [tenant.id, productId]));
  shop.returnRow = (id) => shop.one('SELECT * FROM returns WHERE tenant_id = $1 AND id = $2', [tenant.id, id]);

  shop.member = async (role, { permissions } = {}) => {
    const phone = `93${String(1e7 + next()).slice(-8)}`;
    const user = await shop.inTenant(() => repos.users.create({ name: `A ${role}`, phone, password: 'member-pass-1', role }));
    if (permissions) await shop.inTenant(() => repos.users.setPermissions(user.id, permissions));
    return { user, token: await signIn(world.port, { phone, password: 'member-pass-1' }, host) };
  };

  shop.invoiceSettings = (body) => shop.api('PATCH', '/invoice-settings', body);
  shop.returnsOn = async (patch = {}) => {
    const res = await shop.api('PATCH', '/return-settings', { enabled: true, windowDays: 7, proof: 'either', ...patch });
    if (res.status !== 200) throw new Error(`turning returns on answered ${res.status}: ${res.text}`);
    return res.json;
  };

  /** A product with a price, GST rate, HSN and stock (null is unlimited). */
  shop.product = async ({ name = `Kurta ${next()}`, pricePaise = 99900, gstRateBp = 500, hsn = '6109', stock = 10, weightGrams = 400 } = {}) => {
    const row = await shop.inTenant(() => repos.products.create({ name, price: String(pricePaise / 100), active: 'on' }));
    await sql('UPDATE products SET price_paise = $3, gst_rate_bp = $4, hsn_code = $5, stock = $6, weight_grams = $7 WHERE tenant_id = $1 AND id = $2', [tenant.id, row.id, pricePaise, gstRateBp, hsn, stock, weightGrams]);
    return { ...row, price_paise: pricePaise, gstRateBp, hsn };
  };

  /** A shopper of this business, signed in: the cookie and the session's CSRF token. */
  shop.shopper = async () => {
    const phone = `+9197${String(1e7 + next()).slice(-8)}`;
    const [row] = await sql('INSERT INTO shoppers (tenant_id, phone, phone_verified_at, name) VALUES ($1, $2, now(), $3) RETURNING *', [tenant.id, phone, 'Asha Rao']);
    const token = await shop.inTenant(() => shopperServices(world.ctx).service.sessions.create(row.id, 'whatsapp_otp'));
    const cookie = `_sid=${token}`;
    const csrf = csrfFor(world.config, token);
    const headers = (extra = {}) => ({ cookie, 'x-shopper-csrf': csrf, origin: `http://${host}`, ...extra });
    return {
      ...row,
      cookie,
      csrf,
      page: (path) => raw(world.port, path, { host, headers: { cookie } }),
      /** A return request as the return page sends it. */
      askReturn: (orderNumber, { items, reason = 'The seam is torn', resolution = 'refund', files = [], extra = {} } = {}) => {
        const form = multipart({ items: JSON.stringify(items), reason, resolution, ...extra }, files);
        return raw(world.port, `/api/store/orders/${encodeURIComponent(orderNumber)}/returns`, { method: 'POST', host, body: form.body, headers: headers({ 'content-type': form.type, accept: 'application/json' }) });
      },
    };
  };

  /**
   * A checkout order with its lines and stock held, in one transaction, as checkout writes one. Money is worked out the way
   * checkout does: each line's coupon share and the GST inside what is left.
   */
  shop.placeOrder = async ({ lines, mode = 'prepaid', shippingPaise = 0, codFeePaise = 0, discounts = [], stateCode = '27', shopperId = null, advancePaise = 10000 } = {}) => {
    const subtotal = lines.reduce((sum, l) => sum + l.product.price_paise * (l.qty ?? 1), 0);
    const discount = discounts.reduce((a, b) => a + b, 0);
    const total = subtotal - discount + shippingPaise + codFeePaise;
    const address = { name: 'Asha Rao', phone: '+919876543210', line1: '12 Lake Road', line2: '', landmark: '', city: stateCode === '07' ? 'New Delhi' : 'Pune', stateCode, pincode: stateCode === '07' ? '110001' : '411001' };
    const n = next();
    const row = {
      order_number: `T-${n}-${crypto.randomInt(1e6)}`, public_token: crypto.randomBytes(16).toString('base64url'), flow: 'checkout', payment_mode: mode, shopper_id: shopperId,
      customer_name: address.name, phone: address.phone, address: address.line1, city: address.city, state: stateCode === '07' ? 'Delhi' : 'Maharashtra', pincode: address.pincode,
      subtotal_paise: subtotal, discount_paise: discount, shipping_paise: shippingPaise, cod_fee_paise: codFeePaise, tax_paise: 0, total_paise: total,
      advance_paise: mode === 'part_advance' ? advancePaise : 0, balance_paise: mode === 'cod' ? total : mode === 'part_advance' ? total - advancePaise : 0,
      idempotency_key: crypto.randomUUID(), shipping_address: JSON.stringify(address),
    };
    const columns = Object.keys(row);
    return shop.tx(async (t) => {
      const [created] = await t.query(
        `INSERT INTO orders (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [tenant.id, ...columns.map((c) => row[c])],
      );
      const held = [];
      for (const [i, l] of lines.entries()) {
        const qty = l.qty ?? 1;
        const [item] = await t.query(
          `INSERT INTO order_items (tenant_id, order_id, product_id, name, price_paise, qty, hsn_code, gst_rate_bp, discount_paise, weight_grams)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [tenant.id, created.id, l.product.id, l.product.name, l.product.price_paise, qty, l.product.hsn ?? '', l.product.gstRateBp ?? 0, discounts[i] ?? 0, 400],
        );
        held.push({ orderItemId: item.id, productId: l.product.id, variantId: null, qty });
      }
      await reserve(t, { orderId: created.id, items: held });
      return created;
    });
  };

  /** Moves an order as payments would: prepaid paid, COD confirmed, part-advance's advance paid. */
  shop.pay = async (order) => {
    await shop.tx(async (t) => {
      if (order.payment_mode === 'cod') return changeOrder(t, order.id, { payment: 'cod_due', fulfilment: 'new', actor: 'shopper' });
      const amount = order.payment_mode === 'part_advance' ? Number(order.advance_paise) : Number(order.total_paise);
      const [p] = await t.query(
        `INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, gateway_order_id, amount_paise, method) VALUES ($1, $2, $3, 'razorpay', 'managed', $4, $5, 'upi') RETURNING id`,
        [tenant.id, order.id, order.payment_mode === 'part_advance' ? 'advance' : 'full', `order_t${tenant.id}x${order.id}`, amount],
      );
      await changeRow(t, 'payments', p.id, 'captured', { set: { gateway_payment_id: `pay_t${tenant.id}x${order.id}`, captured_at: new Date() } });
      return changeOrder(t, order.id, { payment: order.payment_mode === 'part_advance' ? 'advance_paid' : 'paid', fulfilment: 'new', actor: 'webhook:razorpay', set: { paid_paise: amount } });
    });
    await world.settle();
    return shop.order(order.id);
  };

  /** Packed, shipped and delivered by hand. Cash on delivery is then collected by the payments module's own listener. */
  shop.deliver = async (order) => {
    for (const to of ['packed', 'shipped', 'delivered']) await shop.tx((t) => changeOrder(t, order.id, { fulfilment: to, actor: 'user:1' }));
    await world.settle();
    return shop.order(order.id);
  };

  /** A refund paid back by hand (cash on delivery), through the refunds module, as the owner. */
  shop.refundByHand = (order, amountPaise, { returnId } = {}) => shop.inTenant(() => world.ctx.refunds.create(order.id, {
    amountPaise, reason: 'Returned', reference: `UTR${next()}`, returnId, idempotencyKey: `rf-${crypto.randomUUID()}`, actor: 'user:1',
  }));

  /** The reverse parcel moved as the courier's tracking would move it. */
  shop.track = async (shipmentId, ...steps) => {
    for (const to of steps) await shop.tx((t) => changeRow(t, 'shipments', shipmentId, to, { ifAllowed: true }));
    await world.settle();
  };
  return shop;
}

/**
 * The app, the Shiprocket simulator, the default business on the store's plan with its owner signed in. Closed after the test.
 */
export async function openWorld(t, options = {}) {
  const world = await createWorld(options);
  t.after(() => world.close());
  return world;
}

/** The same, closed by the caller with world.close() (the browser tests). */
export async function createWorld({ overrides = {}, plan = 't3' } = {}) {
  const ship = createShiprocket();
  await ship.start();
  let app;
  try {
    app = await startApp({
      overrides: { shiprocketBaseUrl: ship.url, shiprocketEmail: 'sim@bhava.test', shiprocketPassword: 'sim-shiprocket-password', providerTimeoutMs: 1500, queuePollMs: 20, ...overrides },
    });
  } catch (err) {
    await ship.close();
    throw err;
  }
  const world = { ...app, ship };
  world.settle = async () => {
    for (let i = 0; i < 4; i++) await app.ctx.orderEvents.settle();
  };
  world.close = async () => {
    await world.settle().catch(() => {});
    app.close();
    await app.ctx.platform.queue.close().catch(() => {});
    await ship.close();
    await app.db.close().catch(() => {});
  };
  try {
    await setPlan(app.db, plan, app.tenant);
  } catch (err) {
    await world.close();
    throw err;
  }
  world.shop = asBusiness(world, { tenant: app.tenant, repos: app.repos, host: '127.0.0.1', token: await signIn(app.port, OWNER, '127.0.0.1') });

  /** Another business on its own address, with its own owner. */
  world.secondBusiness = async (slug = `other-${next()}`) => {
    const tenant = await app.platform.tenants.create({ slug, name: 'Leaf and Clay' });
    await setPlan(app.db, plan, tenant);
    const repos = bindTenant(app.platform, tenant);
    const phone = `90000${String(next()).padStart(5, '0')}`;
    await repos.users.ensureOwner({ phone, password: 'owner-pass-2' });
    await repos.settings.update({ store_name: 'Leaf and Clay' });
    const host = `${slug}.bhava.test`;
    return asBusiness(world, { tenant, repos, host, token: await signIn(app.port, { phone, password: 'owner-pass-2' }, host) });
  };

  /** Runs the queue's ready jobs of one queue with its real handler, as the worker would. */
  world.runJobs = (queue, handler) => app.ctx.platform.queue.drain(queue, handler);
  return world;
}

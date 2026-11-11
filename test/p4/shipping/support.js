// What the shipping tests share: the real app on a fresh database, the Shiprocket simulator sending its tracking webhooks to
// the app, businesses on their own addresses with a pickup address, and checkout orders written the way checkout writes them
// and confirmed through the order state machine.
import '../../../tools/net-guard.mjs';
import crypto from 'node:crypto';
import http from 'node:http';
import { SIGNATURE_HEADERS, STORE_PROVIDER_PATHS } from '../../../src/contracts/store-routes.js';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { bindTenant } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { createShiprocket } from '../../../tools/sim/shiprocket/index.mjs';
import { OWNER, startApp } from '../../helpers.js';

export const OWN_LOGIN = Object.freeze({ email: 'own-api@seller.example', password: 'own-api-pass-1' });
export const DOMAIN = 'shops.example';
export const ADDRESS = { name: 'Asha Rao', phone: '+919876543210', line1: '12 Lake Road', line2: '', landmark: 'Near the park', city: 'Pune', stateCode: '27', pincode: '411001' };
export const PICKUP = { mode: 'managed', pickupName: 'Lamp House Dispatch', pickupPhone: '98111 00001', pickupLine1: '4 Mill Lane', pickupLine2: '', pickupCity: 'Pune', pickupStateCode: '27', pickupPincode: '411002' };

/** One request with any Host header; redirects are not followed. */
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
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function signIn(port, who, host) {
  const res = await raw(port, '/api/v1/auth/login', { method: 'POST', host, body: who });
  if (!res.json?.token) throw new Error(`sign-in failed with ${res.status}`);
  return res.json.token;
}

const setPlan = (world, plan, tenant) => world.db.platform.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, tenant.id]);

function asBusiness(world, { tenant, repos, host, token, name }) {
  const shop = { tenant, repos, host, token, name };
  shop.inTenant = (fn) => withTenant(tenant, fn);
  shop.api = (method, path, body, { as = shop.token } = {}) => raw(world.port, `/api/v1${path}`, { method, host, body, headers: as ? { authorization: `Bearer ${as}` } : {} });
  shop.open = (path, headers = {}) => raw(world.port, path, { host, headers });
  shop.sql = (text, params = []) => world.db.platform.query(text, params);
  shop.one = async (text, params = []) => (await shop.sql(text, params))[0];
  shop.order = (id) => shop.one('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenant.id, id]);
  shop.shipments = (orderId) => shop.sql('SELECT * FROM shipments WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenant.id, orderId]);
  shop.scans = (shipmentId) => shop.sql('SELECT * FROM shipment_events WHERE tenant_id = $1 AND shipment_id = $2 ORDER BY id', [tenant.id, shipmentId]);
  shop.lines = (orderId) => shop.sql('SELECT kind, amount_paise, ref FROM settlement_lines WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenant.id, orderId]);
  shop.history = (orderId) => shop.sql(`SELECT * FROM order_status_history WHERE tenant_id = $1 AND order_id = $2 AND machine = 'fulfilment' ORDER BY id`, [tenant.id, orderId]);
  shop.alerts = (kind) => shop.sql('SELECT * FROM alerts WHERE tenant_id = $1 AND kind = $2 ORDER BY id', [tenant.id, kind]);
  shop.settingsRow = () => shop.one('SELECT * FROM shipping_settings WHERE tenant_id = $1', [tenant.id]);
  shop.run = (fn) => shop.inTenant(() => fn(world.ctx.shipping));

  shop.pickupReady = async (fields = {}) => {
    const res = await shop.api('PATCH', '/shipping-settings', { ...PICKUP, pickupName: `${name} Dispatch`, ...fields });
    if (res.status !== 200) throw new Error(`saving the pickup address answered ${res.status}: ${res.text}`);
    return res.json;
  };

  /** A product with a weight and size (written to the row: the product API has no weight field). */
  shop.product = async ({ name: productName = 'Brass lamp', pricePaise = 99900, weightGrams = 500, size = 10 } = {}) => {
    const product = await shop.inTenant(() => repos.products.create({ name: productName, price: String(pricePaise / 100), active: 'on' }));
    await shop.sql('UPDATE products SET weight_grams = $3, length_cm = $4, breadth_cm = $4, height_cm = $4 WHERE tenant_id = $1 AND id = $2', [tenant.id, product.id, weightGrams, size]);
    return product;
  };

  /**
   * A checkout order and its lines, in one transaction, as checkout writes one, then confirmed through the state machine:
   * prepaid and paid, cash on delivery confirmed, or the advance paid. `confirm: false` leaves it waiting for payment.
   */
  shop.placeOrder = async ({ mode = 'prepaid', lines, advancePaise = 10000, confirm = true, address = ADDRESS } = {}) => {
    const items = lines ?? [{ product: shop.defaultProduct ?? (shop.defaultProduct = await shop.product()), qty: 1 }];
    const total = items.reduce((sum, l) => sum + Number(l.pricePaise ?? 99900) * l.qty, 0);
    const row = {
      order_number: `T-${crypto.randomInt(1e9)}`, public_token: crypto.randomBytes(12).toString('base64url'), flow: 'checkout', payment_mode: mode,
      customer_name: address.name, phone: address.phone, address: address.line1, city: address.city, state: 'Maharashtra', pincode: address.pincode,
      subtotal_paise: total, discount_paise: 0, shipping_paise: 0, tax_paise: 0, total_paise: total,
      advance_paise: mode === 'part_advance' ? advancePaise : 0, balance_paise: mode === 'cod' ? total : mode === 'part_advance' ? total - advancePaise : 0,
      idempotency_key: crypto.randomUUID(), shipping_address: JSON.stringify(address),
    };
    const columns = Object.keys(row);
    const placed = await shop.inTenant(() => world.db.tx(async (t) => {
      const [created] = await t.query(
        `INSERT INTO orders (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [tenant.id, ...columns.map((c) => row[c])],
      );
      for (const l of items) {
        await t.query('INSERT INTO order_items (tenant_id, order_id, product_id, name, price_paise, qty) VALUES ($1, $2, $3, $4, $5, $6)', [tenant.id, created.id, l.product.id, l.product.name, Number(l.pricePaise ?? 99900), l.qty]);
      }
      if (confirm) {
        const payment = { prepaid: 'paid', cod: 'cod_due', part_advance: 'advance_paid' }[mode];
        await changeOrder(t, created.id, { payment, fulfilment: 'new', actor: 'test:setup' });
      }
      return created;
    }));
    await world.settle();
    return shop.order(placed.id);
  };

  shop.ship = async (order, body = {}) => {
    const res = await shop.api('POST', `/orders/${order.id}/shipments`, body);
    if (res.status !== 201) throw new Error(`Ready to ship answered ${res.status}: ${res.text}`);
    return res.json;
  };
  /** The courier reports a scan for an AWB, by webhook, and the app works it through. */
  shop.track = async (awb, status, extra = {}) => {
    const out = await world.ship.post('/track', { awb, status, ...extra });
    await world.settle();
    return out;
  };
  return shop;
}

/**
 * The app with the Shiprocket simulator (Bhava's master login and one seller's own API user), the default business on tier 3
 * with its owner signed in, and the simulator's webhooks pointed at the app. Closed after the test.
 */
export async function openWorld(t, { overrides = {}, plan = 't3', pickup = true } = {}) {
  const ship = createShiprocket({ users: [OWN_LOGIN] });
  await ship.start();
  let app;
  try {
    app = await startApp({
      overrides: {
        platformDomain: DOMAIN, shiprocketBaseUrl: ship.url, shiprocketEmail: 'sim@bhava.test', shiprocketPassword: 'sim-shiprocket-password',
        shiprocketWebhookToken: ship.webhookToken, providerTimeoutMs: 1500, ...overrides,
      },
    });
  } catch (err) {
    await ship.close();
    throw err;
  }
  const world = { ...app, ship };
  world.close = async () => {
    await world.settle().catch(() => {});
    app.close();
    await ship.close();
    await app.db.close().catch(() => {});
  };
  // node:test passes its context; a browser test calls world.close() itself.
  t?.after(world.close);
  await setPlan(world, plan, app.tenant);
  await app.repos.settings.update({ store_name: 'Lamp House' });
  await ship.post('/webhooks/url', { url: `${app.base}${STORE_PROVIDER_PATHS.courier.path}` });

  /** Lets every tracking event and order event in flight finish. */
  world.settle = async () => {
    for (let i = 0; i < 4; i++) {
      await world.ctx.shipping.webhooks.settle();
      await world.ctx.orderEvents.settle();
    }
  };
  world.shop = asBusiness(world, { tenant: app.tenant, repos: app.repos, host: '127.0.0.1', token: await signIn(app.port, OWNER, '127.0.0.1'), name: 'Lamp House' });
  if (pickup) await world.shop.pickupReady();

  let n = 0;
  /** Another business on its own address, with its own owner and pickup address. */
  world.business = async ({ name = `Leaf and Clay ${++n}`, ready = true } = {}) => {
    const slug = `shop-${crypto.randomBytes(4).toString('hex')}`;
    const tenant = await app.platform.tenants.create({ slug, name });
    await setPlan(world, plan, tenant);
    const repos = bindTenant(app.platform, tenant);
    const who = { phone: `9${crypto.randomInt(100000000, 999999999)}`, password: 'owner-pass-2' };
    await repos.users.ensureOwner(who);
    await repos.settings.update({ store_name: name });
    const host = `${slug}.${DOMAIN}`;
    const shop = asBusiness(world, { tenant, repos, host, token: await signIn(app.port, who, host), name });
    if (ready) await shop.pickupReady();
    return shop;
  };

  /** A tracking webhook posted by hand, with the token (the real one unless given). */
  world.hook = (body, { token = ship.webhookToken } = {}) => raw(app.port, STORE_PROVIDER_PATHS.courier.path, { method: 'POST', body, headers: token === null ? {} : { [SIGNATURE_HEADERS.courier]: token } });
  world.courierRows = () => app.db.platform.query(`SELECT * FROM provider_webhook_events WHERE provider = 'shiprocket' ORDER BY id`);
  world.opsAlerts = (kind) => app.db.platform.query(`SELECT * FROM alerts WHERE audience = 'ops' AND kind = $1 ORDER BY id`, [kind]);
  world.creates = async () => (await ship.calls({ method: 'POST', path: '/v1/external/orders/create/adhoc' })).length;
  world.simShipment = async (awb) => (await ship.get('/state')).shipments.find((s) => s.awb_code === awb);
  /** Makes shipments look `ms` older since they were last touched, as if that long had passed (the guard trigger is set aside). */
  world.age = async (ms, { created = false } = {}) => {
    const interval = `${Math.round(ms)} milliseconds`;
    await app.db.platform.tx(async (tx) => {
      await tx.exec('ALTER TABLE shipments DISABLE TRIGGER USER');
      await tx.exec(`UPDATE shipments SET updated_at = updated_at - interval '${interval}'${created ? `, created_at = created_at - interval '${interval}'` : ''}`);
      await tx.exec('ALTER TABLE shipments ENABLE TRIGGER USER');
    });
  };
  /** The worker's sweep for shipments that stopped part-way, run once now. */
  world.resume = async () => {
    const shipping = world.ctx.shipping;
    await shipping.shipments.resume({}, (tenant, fn) => withTenant(tenant, fn));
    await world.settle();
  };
  world.poll = async () => {
    await world.ctx.shipping.tracking.poll({}, (tenant, fn) => withTenant(tenant, fn));
    await world.settle();
  };
  return world;
}

export const noPlatformName = (text) => !/bhava/i.test(String(text));

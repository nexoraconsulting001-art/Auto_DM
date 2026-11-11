// What the payments and refunds tests share: the real app on a fresh database, the Razorpay simulator sending its webhooks
// to the app, a business ready to take money in managed mode, and checkout orders written the way checkout writes them.
import '../../../tools/net-guard.mjs';
import crypto from 'node:crypto';
import http from 'node:http';
import { SIGNATURE_HEADERS, STORE_PROVIDER_PATHS } from '../../../src/contracts/store-routes.js';
import { bindTenant } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { createRazorpay as createRazorpaySim } from '../../../tools/sim/razorpay/index.mjs';
import { OWNER, startApp } from '../../helpers.js';

export const ADDRESS = { name: 'Asha Rao', phone: '+919876543210', line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' };

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

/** A business in the world: its repos, its address, its owner's token, and calls as it. */
function asBusiness(world, { tenant, repos, host, token }) {
  const shop = { tenant, repos, host, token };
  shop.inTenant = (fn) => withTenant(tenant, fn);
  shop.api = (method, path, body, { as = shop.token } = {}) => raw(world.port, `/api/v1${path}`, { method, host, body, headers: as ? { authorization: `Bearer ${as}` } : {} });
  shop.store = (method, path, body) => raw(world.port, path, { method, host, body });
  shop.sql = (text, params = []) => world.db.platform.query(text, params);
  shop.one = async (text, params = []) => (await shop.sql(text, params))[0];
  shop.order = (id) => shop.one('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenant.id, id]);
  shop.payments = (orderId) => shop.sql('SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenant.id, orderId]);
  shop.refunds = (orderId) => shop.sql('SELECT * FROM refunds WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenant.id, orderId]);
  shop.lines = (orderId) => shop.sql('SELECT kind, amount_paise, ref, status FROM settlement_lines WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenant.id, orderId]);
  shop.alerts = (kind) => shop.sql('SELECT * FROM alerts WHERE tenant_id = $1 AND kind = $2 ORDER BY id', [tenant.id, kind]);
  shop.service = () => world.ctx.payments;
  shop.run = (fn) => shop.inTenant(() => fn(world.ctx.payments));

  /** A user of this business with a role, signed in. */
  shop.member = async (role, phone, password = 'member-pass') => {
    const user = await repos.users.create({ name: `A ${role}`, phone, password, role });
    return { user, token: await signIn(world.port, { phone, password }, host) };
  };

  /** Managed mode, ready to take money: the Route linked account through the console, and KYC passed at the gateway. */
  shop.payReady = async () => {
    const res = await shop.api('POST', '/payment-account/linked', { legalName: 'Lamp House Traders', contactName: 'Meera Shah', email: `owner-${tenant.id}@seller.example`, phone: '+919811100000', businessType: 'proprietorship' });
    if (res.status !== 200) throw new Error(`starting the linked account answered ${res.status}: ${res.text}`);
    const { linked_account_id: id } = await shop.one('SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [tenant.id]);
    await world.rzp.post('/accounts/kyc', { id, status: 'activated' });
    await world.settle();
    shop.linkedAccount = id;
    return id;
  };

  /**
   * A checkout order and its lines, in one transaction, as checkout writes one. `totalPaise` is one line; part-advance takes
   * `advancePaise` online and the rest at the door.
   */
  shop.placeOrder = async ({ mode = 'prepaid', totalPaise = 99900, advancePaise = 10000, phone = ADDRESS.phone } = {}) => {
    const product = shop.product ?? (shop.product = await shop.inTenant(() => repos.products.create({ name: 'Brass lamp', price: '999', active: 'on' })));
    const row = {
      order_number: `T-${crypto.randomInt(1e9)}`, public_token: crypto.randomBytes(12).toString('base64url'), flow: 'checkout', payment_mode: mode,
      customer_name: ADDRESS.name, phone, address: ADDRESS.line1, city: ADDRESS.city, state: 'Maharashtra', pincode: ADDRESS.pincode,
      subtotal_paise: totalPaise, discount_paise: 0, shipping_paise: 0, tax_paise: 0, total_paise: totalPaise,
      advance_paise: mode === 'part_advance' ? advancePaise : 0, balance_paise: mode === 'cod' ? totalPaise : mode === 'part_advance' ? totalPaise - advancePaise : 0,
      idempotency_key: crypto.randomUUID(), shipping_address: JSON.stringify(ADDRESS),
    };
    const columns = Object.keys(row);
    return shop.inTenant(() => world.db.tx(async (t) => {
      const [created] = await t.query(
        `INSERT INTO orders (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [tenant.id, ...columns.map((c) => row[c])],
      );
      await t.query(`INSERT INTO order_items (tenant_id, order_id, product_id, name, price_paise, qty) VALUES ($1, $2, $3, 'Brass lamp', $4, 1)`, [tenant.id, created.id, product.id, totalPaise]);
      return created;
    }));
  };

  /** Starts paying for an order, as checkout does after placing it. */
  shop.start = (orderId) => shop.run((p) => p.start(orderId, { baseUrl: 'https://shop.test' }));

  /** Places a prepaid order and pays for it at the gateway, confirmed by the webhook. -> { order, placed, paid } */
  shop.paidOrder = async ({ totalPaise = 99900, method = 'upi', mode = 'prepaid', advancePaise } = {}) => {
    const order = await shop.placeOrder({ totalPaise, mode, advancePaise });
    const placed = await shop.start(order.id);
    const paid = await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, method });
    await world.settle();
    return { order: await shop.order(order.id), placed, paid };
  };
  return shop;
}

/**
 * The app with the Razorpay simulator, the default business on tier 3 with its owner signed in, and the simulator's managed
 * webhooks pointed at the app. Closed after the test.
 */
export async function openWorld(t, { overrides = {}, plan = 't3' } = {}) {
  const rzp = createRazorpaySim();
  await rzp.start();
  let app;
  try {
    app = await startApp({
      overrides: {
        razorpayBaseUrl: rzp.url, razorpayAuthBaseUrl: rzp.url, razorpayKeyId: rzp.keyId, razorpayKeySecret: rzp.keySecret, razorpayWebhookSecret: rzp.webhookSecret,
        razorpayPartnerClientId: rzp.partner.clientId, razorpayPartnerClientSecret: rzp.partner.clientSecret, paymentMode: 'managed', providerTimeoutMs: 1500, ...overrides,
      },
    });
  } catch (err) {
    await rzp.close();
    throw err;
  }
  const world = { ...app, rzp };
  t.after(async () => {
    await world.settle().catch(() => {});
    app.close();
    await rzp.close();
    await app.db.close().catch(() => {});
  });
  await setPlan(world, plan, app.tenant);
  await rzp.post('/webhooks/url', { url: `${app.base}${STORE_PROVIDER_PATHS.razorpayManaged.path}` });

  /** Lets every webhook and order event in flight finish. */
  world.settle = async () => {
    for (let i = 0; i < 3; i++) {
      await world.ctx.payments.webhooks.settle();
      await world.ctx.orderEvents.settle();
    }
  };
  world.shop = asBusiness(world, { tenant: app.tenant, repos: app.repos, host: '127.0.0.1', token: await signIn(app.port, OWNER, '127.0.0.1') });

  /** A second business on its own address, with its own owner. */
  world.secondBusiness = async (slug = 'leaf-and-clay') => {
    const tenant = await app.platform.tenants.create({ slug, name: 'Leaf and Clay' });
    await setPlan(world, plan, tenant);
    const repos = bindTenant(app.platform, tenant);
    await repos.users.ensureOwner({ phone: '9000000002', password: 'owner-pass-2' });
    await repos.settings.update({ store_name: 'Leaf and Clay' });
    const host = `${slug}.bhava.test`;
    return asBusiness(world, { tenant, repos, host, token: await signIn(app.port, { phone: '9000000002', password: 'owner-pass-2' }, host) });
  };

  /** A Razorpay webhook posted by hand, signed with `secret` (the managed one unless given). */
  world.hook = (event, payload, { secret = rzp.webhookSecret, signature, eventId = `evt_test_${crypto.randomBytes(6).toString('hex')}`, path = STORE_PROVIDER_PATHS.razorpayManaged.path, accountId = 'acc_platform' } = {}) => {
    const body = JSON.stringify({ entity: 'event', account_id: accountId, event, contains: Object.keys(payload), payload, created_at: Math.floor(Date.now() / 1000) });
    const sig = signature === undefined ? crypto.createHmac('sha256', secret).update(body).digest('hex') : signature;
    return raw(app.port, path, { method: 'POST', body, headers: { ...(sig === null ? {} : { [SIGNATURE_HEADERS.razorpay]: sig }), [SIGNATURE_HEADERS.razorpayEventId]: eventId } });
  };
  world.webhookRows = () => app.db.platform.query(`SELECT * FROM provider_webhook_events WHERE provider = 'razorpay' ORDER BY id`);
  /** Makes a business's payments and refunds look `ms` older, as if that much time had passed. */
  world.age = async (ms) => {
    const interval = `${Math.round(ms)} milliseconds`;
    await app.db.platform.tx(async (tx) => {
      for (const table of ['payments', 'refunds']) {
        const captured = table === 'payments' ? `, captured_at = captured_at - interval '${interval}'` : '';
        await tx.exec(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        await tx.exec(`UPDATE ${table} SET created_at = created_at - interval '${interval}', updated_at = updated_at - interval '${interval}'${captured}`);
        await tx.exec(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
    });
  };
  return world;
}

/** The owner's refund body. */
export const refundBody = (amountPaise, extra = {}) => ({ amountPaise, reason: 'Damaged in transit', idempotencyKey: `rf-${crypto.randomUUID()}`, password: OWNER.password, ...extra });

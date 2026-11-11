// Shared by the Phase 4 spec tests. Written from the PRD (section 9) and the Phase 4 contract only: src/contracts/store-routes.js
// (the buyer's store), src/contracts/api (the console), src/contracts/orders.js (statuses, limits, money rules), the tables of
// migrations 400 to 416 and the simulators in tools/sim. Nothing here looks inside a module.
//
// The world is the Phase 3 spec world (the app, its worker, the database, Meta and outside sites) with the store's providers
// simulated behind it: Razorpay, Shiprocket, WhatsApp, an HTTP mail API, Google sign-in and Shopify Admin. Each simulator
// sends its webhooks to the app, signed as the provider signs them.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before } from 'node:test';
import { createEmail } from '../../../tools/sim/email/index.mjs';
import { createGoogle } from '../../../tools/sim/google/index.mjs';
import { createRazorpay } from '../../../tools/sim/razorpay/index.mjs';
import { createShiprocket } from '../../../tools/sim/shiprocket/index.mjs';
import { createShopify } from '../../../tools/sim/shopify/index.mjs';
import { createWhatsApp } from '../../../tools/sim/whatsapp/index.mjs';
import { createApp } from '../../../src/server.js';
import { createPlatform } from '../../../src/platform/index.js';
import { SHOPPER_COOKIE, SIGNATURE_HEADERS, STORE_PROVIDER_PATHS } from '../../../src/contracts/store-routes.js';
import { STORE_LIMITS } from '../../../src/contracts/orders.js';
import { UA, addP3Shop, hit, need, noPlatformName, openP3World, pause, png, setFeature, unique } from '../../p3/spec-p3/kit.js';

export * from '../../p3/spec-p3/kit.js';
export { SHOPPER_COOKIE, SIGNATURE_HEADERS, STORE_PROVIDER_PATHS, STORE_LIMITS };
export { INDIAN_STATES, PINCODE_MESSAGE, TRANSITIONS, financialYear, financialYearLabel, splitGst, taxInside } from '../../../src/contracts/orders.js';
export { quietUntil } from '../../../src/contracts/shopper-messages.js';
export { addStaff } from '../../p0/spec-p0/support.js';

export const NEUTRAL_MAIL = 'mail-neutral.example';
export const RUPEE = 100;

/** Tables whose stored times make up "now" for the store. Shopper sessions stay out, so sign-ins survive. Invoices too: their date is their series. */
const P4_CLOCK_TABLES = ['orders', 'order_status_history', 'order_events', 'order_event_deliveries', 'payments', 'refunds', 'stock_reservations', 'carts', 'cart_lines', 'cart_reminders', 'shopper_otps', 'rate_limit_hits', 'shipments', 'shipment_events', 'order_alerts', 'returns', 'loyalty_ledger', 'loyalty_accounts', 'serviceability_cache', 'provider_webhook_events', 'consent_records', 'reviews', 'referrals', 'coupon_redemptions', 'settlement_lines', 'shopify_order_pushes'];

const json = (res) => {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
};

/** The answer with its JSON body (or null) as `data`. */
const withData = (res) => Object.assign(res, { data: json(res) });

/** Fails with what was attempted when the answer is not 2xx. */
export function ok(res, what) {
  assert.ok(res.status >= 200 && res.status < 300, `${what}: expected success, got HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  return res;
}

/** A refusal: 4xx (never 5xx, never success), optionally one of `statuses`. */
export function refused(res, what, statuses) {
  assert.ok(res.status >= 400 && res.status < 500, `${what}: expected a refusal, got HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  if (statuses) assert.ok([statuses].flat().includes(res.status), `${what}: expected HTTP ${[statuses].flat().join(' or ')}, got ${res.status}: ${res.text.slice(0, 300)}`);
  return res;
}

/** Never a server error, whatever else it is. */
export function noCrash(res, what) {
  assert.ok(res.status < 500, `${what}: the server failed with HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  return res;
}

export const digits = (phone) => String(phone).replace(/\D/g, '');
let phoneSerial = crypto.randomInt(1000, 8000) * 1000;
/** A fresh Indian mobile number in international form. */
export const newPhone = () => `+9198${String(++phoneSerial).padStart(8, '0')}`;
export const idemKey = () => `spec-${crypto.randomUUID()}`;
export const address = (fields = {}) => ({ name: 'Asha Rao', phone: newPhone(), line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001', ...fields });

// ---- the world ------------------------------------------------------------------------------------------------------------

export async function openP4World({ overrides = {}, worker = true, defaultTenant = '' } = {}) {
  const rzp = createRazorpay();
  const ship = createShiprocket();
  const wa = createWhatsApp();
  const mail = createEmail();
  const google = createGoogle();
  const shopifyAdmin = createShopify();
  const sims = [rzp, ship, wa, mail, google, shopifyAdmin];
  for (const sim of sims) await sim.start();
  let world;
  try {
    world = await openP3World({
      worker,
      defaultTenant,
      overrides: {
        providerTimeoutMs: 1500,
        orderEventsPollMs: 40,
        paymentMode: 'managed',
        razorpayBaseUrl: rzp.url,
        razorpayAuthBaseUrl: rzp.url,
        razorpayKeyId: rzp.keyId,
        razorpayKeySecret: rzp.keySecret,
        razorpayWebhookSecret: rzp.webhookSecret,
        razorpayPartnerClientId: rzp.partner.clientId,
        razorpayPartnerClientSecret: rzp.partner.clientSecret,
        shiprocketBaseUrl: ship.url,
        shiprocketEmail: 'sim@bhava.test',
        shiprocketPassword: 'sim-shiprocket-password',
        shiprocketWebhookToken: ship.webhookToken,
        shopifyBaseUrl: shopifyAdmin.url,
        whatsappBaseUrl: wa.url,
        whatsappAppSecret: wa.appSecret,
        whatsappVerifyToken: 'spec-wa-verify',
        emailDriver: 'http',
        emailBaseUrl: mail.url,
        emailHosts: mail.url,
        emailApiKey: 'sim-email-key',
        emailNeutralDomain: NEUTRAL_MAIL,
        googleClientId: 'sim-google-client',
        googleClientSecret: 'sim-google-secret',
        googleOauthBaseUrl: google.url,
        ...overrides,
      },
    });
  } catch (err) {
    await Promise.all(sims.map((s) => s.close()));
    throw err;
  }
  await rzp.post('/webhooks/url', { url: `${world.base}${STORE_PROVIDER_PATHS.razorpayManaged.path}` });
  await ship.post('/webhooks/url', { url: `${world.base}${STORE_PROVIDER_PATHS.courier.path}` });
  await wa.post('/webhooks/url', { url: `${world.base}${STORE_PROVIDER_PATHS.whatsapp.path}` });
  await shopifyAdmin.post('/webhooks/url', { url: `${world.base}${STORE_PROVIDER_PATHS.shopify.path}` });
  await mail.post('/dkim', { domain: NEUTRAL_MAIL, pass: true });

  const closeWorld = world.close;
  const extra = [];
  const sql = (text, params = []) => world.rawDb.platform.query(text, params);

  return Object.assign(world, {
    rzp, ship, wa, mail, google, shopifyAdmin, sql,

    /** Runs the worker and asks again until `check` gives something, or `ms` passes. The last answer either way. */
    async until(check, ms = 9000) {
      const end = Date.now() + ms;
      let value;
      for (;;) {
        await world.tick();
        value = await check();
        if (value || Date.now() > end) return value;
        await pause(120);
      }
    },
    /** Lets everything in flight finish: for "and nothing else happened". */
    async quiet(ms = 1500) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await world.tick();
        await pause(150);
      }
    },
    /** Makes everything the store has stored `ms` older, and moves every simulator's clock on by as much. */
    async age(ms) {
      const interval = `${Math.round(ms)} milliseconds`;
      await world.rawDb.platform.tx(async (t) => {
        const columns = await t.query(
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'timestamp with time zone' AND table_name = ANY($1)`,
          [P4_CLOCK_TABLES],
        );
        const byTable = new Map();
        for (const { table_name: table, column_name: column } of columns) byTable.set(table, [...(byTable.get(table) ?? []), column]);
        for (const [table, list] of byTable) {
          await t.exec(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
          await t.exec(`UPDATE "${table}" SET ${list.map((c) => `"${c}" = "${c}" - interval '${interval}'`).join(', ')}`);
          await t.exec(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
        }
      });
      await world.travel(ms, { sim: true });
      for (const sim of sims) await sim.post('/clock', { advanceMs: ms });
    },
    /** The last one-time code WhatsApp carried to this number, read from what the simulator received. */
    async codeFor(phone, { must = true } = {}) {
      const { sent } = await wa.get('/sent');
      const mine = sent.filter((m) => m.to === digits(phone));
      for (const m of mine.reverse()) {
        const code = /(?<![0-9])[0-9]{6}(?![0-9])/.exec(JSON.stringify(m.body.template ?? m.body.text ?? {}))?.[0];
        if (code) return code;
      }
      if (must) assert.fail(`No WhatsApp code reached ${mine.length ? 'this number in a readable form' : 'this number at all'} (${sent.length} messages sent in all)`);
      return null;
    },
    /** WhatsApp messages to a number, oldest first. */
    async whatsappTo(phone) {
      return (await wa.get('/sent')).sent.filter((m) => m.to === digits(phone));
    },
    async emailsTo(email) {
      return (await mail.get('/sent')).sent.filter((m) => m.to.includes(email));
    },
    /** A second web server on the same database, as a second instance behind the load balancer would be. */
    async secondInstance() {
      const app = createApp({ db: world.db, ig: world.ig, config: world.config, platform: createPlatform(world.config, { db: world.db }) });
      const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      extra.push(server);
      return { port: server.address().port };
    },
    /** A signed (or badly signed) Razorpay webhook body, posted by hand. */
    razorpayHook(payload, { secret = rzp.webhookSecret, signature, eventId = `evt_spec_${unique()}`, path = STORE_PROVIDER_PATHS.razorpayManaged.path } = {}) {
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const sig = signature ?? crypto.createHmac('sha256', secret).update(raw).digest('hex');
      return hit(world, path, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig === null ? {} : { [SIGNATURE_HEADERS.razorpay]: sig }), [SIGNATURE_HEADERS.razorpayEventId]: eventId }, body: raw });
    },
    webhookRows: (provider) => sql('SELECT * FROM provider_webhook_events WHERE provider = $1 ORDER BY id', [provider]),
    async close() {
      for (const server of extra) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
      await closeWorld();
      await Promise.all(sims.map((s) => s.close()));
    },
  });
}

/** One world per test file, opened before its first test. Each test makes its own businesses in it. */
export function useP4World(options) {
  let current;
  before(async () => { current = await openP4World(options); });
  after(async () => { await current?.close(); });
  return new Proxy({}, { get: (_, key) => current?.[key] });
}

// ---- a business with a store ----------------------------------------------------------------------------------------------

/**
 * A tier 3 business with its store ready: WhatsApp connected with approved templates, online payments in managed mode with
 * KYC passed, a pickup address, a consent notice, and policy pages. Each step goes through the console API; where that is
 * refused the rows are written directly and the step is named in `shop.shortcuts`, which the setup spec fails on.
 */
export async function addP4Shop(world, { whatsapp = true, pay = true, pickup = true, notice = true, stateCode = '27', ...options } = {}) {
  const shop = await addP3Shop(world, options);
  const { sql, tenantId: id } = shop;
  const shortcuts = [];
  const tryApi = async (what, method, path, body, statuses = [200, 201, 202, 204]) => {
    const res = await shop.send(method, path, body);
    if (statuses.includes(res.status)) return json(res) ?? {};
    shortcuts.push(`${what}: ${method} ${path} answered ${res.status}`);
    return null;
  };
  const n = unique();

  Object.assign(shop, {
    shortcuts,
    waPhoneId: `ph${n}`,
    one: async (text, params = []) => (await sql(text, params))[0],

    async whatsappOn() {
      await tryApi('Connecting WhatsApp', 'PUT', '/whatsapp-account', { wabaId: `waba${n}`, phoneNumberId: shop.waPhoneId, accessToken: 'sim-whatsapp-token', displayNumber: '+919000000000' });
      const first = await tryApi('Submitting templates', 'POST', '/whatsapp-templates/sync');
      for (const t of first?.items ?? []) await world.wa.post('/templates', { name: t.name, language: t.language, category: t.category, status: 'APPROVED' });
      await tryApi('Reading template reviews', 'POST', '/whatsapp-templates/sync');
      const rows = await sql('SELECT status FROM whatsapp_templates WHERE tenant_id = $1', [id]);
      if (rows.some((r) => r.status !== 'approved')) {
        shortcuts.push('Templates approved at WhatsApp were not read back as approved');
        await sql(`UPDATE whatsapp_templates SET status = 'approved', checked_at = now() WHERE tenant_id = $1`, [id]);
      }
    },
    /** Sets one template's review status at WhatsApp and reads it back into the app. */
    async templateStatus(purpose, status) {
      const [row] = await sql('SELECT name, language, category FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = $2', [id, purpose]);
      assert.ok(row, `The business has no WhatsApp template for ${purpose}`);
      await world.wa.post('/templates', { name: row.name, language: row.language, category: row.category, status: status.toUpperCase() });
      await shop.send('POST', '/whatsapp-templates/sync');
      const [now] = await sql('SELECT status FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = $2', [id, purpose]);
      if (now.status !== status) await sql('UPDATE whatsapp_templates SET status = $3 WHERE tenant_id = $1 AND purpose = $2', [id, purpose, status]);
    },

    /** Managed payments: a Route linked account whose KYC has passed. */
    async payReady() {
      await tryApi('Starting the linked account', 'POST', '/payment-account/linked', { legalName: `${shop.name} Traders`, contactName: 'Meera Shah', email: `owner${n}@seller.example`, phone: '+919811100000', businessType: 'proprietorship' });
      let row = await shop.one('SELECT * FROM payment_settings WHERE tenant_id = $1', [id]);
      if (row?.linked_account_id) {
        await world.rzp.post('/accounts/kyc', { id: row.linked_account_id, status: 'activated' });
        row = await world.until(async () => {
          const r = await shop.one('SELECT * FROM payment_settings WHERE tenant_id = $1', [id]);
          return r.kyc_status === 'verified' ? r : null;
        }, 4000);
      }
      if (!row || row.kyc_status !== 'verified') {
        shortcuts.push('KYC passing at the gateway did not make the account verified');
        const auth = `Basic ${Buffer.from(`${world.rzp.keyId}:${world.rzp.keySecret}`).toString('base64')}`;
        const account = await (await fetch(`${world.rzp.url}/v2/accounts`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ email: `owner${n}@seller.example`, legal_business_name: `${shop.name} Traders`, reference_id: `spec-${id}` }) })).json();
        await world.rzp.post('/accounts/kyc', { id: account.id, status: 'activated', signature: 'none' });
        await sql(
          `INSERT INTO payment_settings (tenant_id, mode, linked_account_id, kyc_status) VALUES ($1, 'managed', $2, 'verified')
           ON CONFLICT (tenant_id) DO UPDATE SET mode = 'managed', linked_account_id = EXCLUDED.linked_account_id, kyc_status = 'verified'`,
          [id, account.id],
        );
      }
      shop.linkedAccount = (await shop.one('SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [id])).linked_account_id;
    },
    /** Payment options through the console. */
    payOptions: (patch) => shop.must('PATCH', '/payment-settings', patch, 200, 'Saving payment options'),

    async pickupReady(fields = {}) {
      const body = { mode: 'managed', pickupName: `${shop.name} Dispatch`, pickupPhone: '9811100001', pickupLine1: '4 Mill Lane', pickupCity: 'Pune', pickupStateCode: stateCode, pickupPincode: '411002', ...fields };
      shop.pickup = body;
      if (await tryApi('Saving the pickup address', 'PATCH', '/shipping-settings', body)) return;
      await sql(
        `INSERT INTO shipping_settings (tenant_id, mode, pickup_name, pickup_phone, pickup_line1, pickup_city, pickup_state_code, pickup_pincode) VALUES ($1, 'managed', $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id) DO UPDATE SET pickup_name = EXCLUDED.pickup_name, pickup_line1 = EXCLUDED.pickup_line1, pickup_pincode = EXCLUDED.pickup_pincode`,
        [id, body.pickupName, body.pickupPhone, body.pickupLine1, body.pickupCity, body.pickupStateCode, body.pickupPincode],
      );
    },
    async noticeReady() {
      const made = await tryApi('Publishing the consent notice', 'POST', '/consent-notice', { bodyEn: `${shop.name} uses your details to deliver your order.`, bodyHi: `${shop.name} आपके विवरण का उपयोग आपका ऑर्डर पहुंचाने के लिए करता है।` });
      if (!made) await sql(`INSERT INTO consent_notices (tenant_id, version, body_en, body_hi) VALUES ($1, 1, 'We use your details to deliver your order.', 'हम आपके विवरण का उपयोग करते हैं।') ON CONFLICT DO NOTHING`, [id]);
      shop.noticeVersion = (await shop.one('SELECT max(version) AS v FROM consent_notices WHERE tenant_id = $1', [id])).v ?? 1;
    },
    async invoiceReady({ gstin = `${stateCode}ABCDE1234F1Z5`, prefix = 'INV' } = {}) {
      const body = { legalName: `${shop.name} Traders`, gstin, stateCode, address: '4 Mill Lane, Pune', invoicePrefix: prefix };
      if (await tryApi('Saving invoice settings', 'PATCH', '/invoice-settings', body)) return;
      await sql(
        `INSERT INTO invoice_settings (tenant_id, legal_name, gstin, state_code, address, invoice_prefix) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, gstin = EXCLUDED.gstin, state_code = EXCLUDED.state_code, invoice_prefix = EXCLUDED.invoice_prefix`,
        [id, body.legalName, gstin, stateCode, body.address, prefix],
      );
    },

    /**
     * A product ready to sell and ship. Weight, size, HSN and GST rate are not fields of the Phase 4 product API contract, so
     * they are written to the product row (named in the report).
     */
    async item({ weightGrams = 500, gstRateBp = 0, hsn = '', ...fields } = {}) {
      const product = await shop.product({ pricePaise: 49900, ...fields });
      await sql('UPDATE products SET weight_grams = $3, length_cm = 10, breadth_cm = 10, height_cm = 10, gst_rate_bp = $4, hsn_code = $5 WHERE tenant_id = $1 AND id = $2', [id, product.id, weightGrams, gstRateBp, hsn]);
      const row = await shop.one('SELECT * FROM products WHERE tenant_id = $1 AND id = $2', [id, product.id]);
      return { ...product, slug: product.slug ?? row.slug };
    },
    stockOf: async (productId) => shop.one('SELECT stock, reserved FROM products WHERE tenant_id = $1 AND id = $2', [id, productId]),
    variantStock: async (variantId) => shop.one('SELECT stock, reserved FROM product_variants WHERE tenant_id = $1 AND id = $2', [id, variantId]),

    // What the store holds, read from its tables
    orders: (where = 'true', params = []) => sql(`SELECT * FROM orders WHERE tenant_id = $1 AND flow = 'checkout' AND (${where}) ORDER BY id`, [id, ...params]),
    order: async (number) => shop.one('SELECT * FROM orders WHERE tenant_id = $1 AND order_number = $2', [id, number]),
    orderItems: (orderId) => sql('SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [id, orderId]),
    payments: (orderId) => sql('SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [id, orderId]),
    refunds: (orderId) => sql('SELECT * FROM refunds WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [id, orderId]),
    history: (orderId) => sql('SELECT * FROM order_status_history WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [id, orderId]),
    shipments: (orderId) => sql('SELECT * FROM shipments WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [id, orderId]),
    invoices: (orderId) => sql(`SELECT * FROM invoices WHERE tenant_id = $1 ${orderId ? 'AND order_id = $2' : ''} ORDER BY id`, orderId ? [id, orderId] : [id]),
    settlement: (orderId) => sql('SELECT * FROM settlement_lines WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [id, orderId]),
    orderAlerts: (orderId) => sql('SELECT * FROM order_alerts WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [id, orderId]),
    shopperRows: () => sql('SELECT * FROM shoppers WHERE tenant_id = $1 ORDER BY id', [id]),
    consent: (where = 'true', params = []) => sql(`SELECT * FROM consent_records WHERE tenant_id = $1 AND (${where}) ORDER BY id`, [id, ...params]),
    security: () => sql(`SELECT * FROM audit_log WHERE tenant_id = $1 AND (action ~* 'security|forged|signature|mismatch' OR target ~* 'security|forged|signature') ORDER BY id`, [id]),

    /** Waits for the order to satisfy `check(row)`. The row either way. */
    async orderWhen(number, check, ms = 9000) {
      await world.until(async () => {
        const row = await shop.order(number);
        return row && check(row);
      }, ms);
      return shop.order(number);
    },

    // The seller's moves
    advance: (orderId, to, note) => shop.send('POST', `/orders/${orderId}/advance`, { to, ...(note ? { note } : {}) }),
    cancel: (orderId, body = {}) => shop.send('POST', `/orders/${orderId}/cancel`, body),
    /** Packed, shipped and delivered by hand, for tests that are not about the courier. */
    async handDeliver(order) {
      for (const to of ['packed', 'shipped', 'delivered']) ok(await shop.advance(order.id, to), `Moving order ${order.order_number} to ${to}`);
      return shop.orderWhen(order.order_number, (o) => o.fulfilment_status === 'delivered');
    },
    /** "Ready to ship" through the courier: the shipment row with its AWB. */
    async ship(order, body = {}) {
      const res = await shop.send('POST', `/orders/${order.id}/shipments`, body);
      need(res, 201, `Creating the shipment of order ${order.order_number}`);
      return json(res);
    },
    /** The courier reports a scan for an AWB, by webhook. */
    track: (awb, status, extra = {}) => world.ship.post('/track', { awb, status, ...extra }),
    /** A refund by the owner. */
    refund: (orderId, body, { token = shop.token } = {}) => hit(world, `/api/v1/orders/${orderId}/refunds`, { host: shop.host, method: 'POST', token, body: { idempotencyKey: idemKey(), password: shop.owner.password, ...body } }),

    /** A manager of this business, signed in. */
    async manager() {
      const who = { phone: `92${String(crypto.randomInt(1e7, 9e7))}`, password: 'manager-pass-1' };
      await shop.repos.users.create({ name: 'Mina Manager', ...who, role: 'manager' });
      const res = need(await hit(world, '/api/v1/auth/login', { host: shop.host, method: 'POST', body: who }), 201, 'Manager sign-in');
      const token = res.json().token;
      return { ...who, token, send: (method, path, body) => hit(world, `/api/v1${path}`, { host: shop.host, method, token, ...(body === undefined ? {} : { body }) }) };
    },
    /** Calls the console API with another token (a manager's, staff's, another business's). */
    as: (token) => (method, path, body) => hit(world, `/api/v1${path}`, { host: shop.host, method, token, ...(body === undefined ? {} : { body }) }),

    // Settings the specs turn on, each through the console
    codOn: (patch = {}) => shop.payOptions({ cod: true, codFeePaise: 0, ...patch }),
    coupon: (fields) => shop.must('POST', '/coupons', { kind: 'percent', ...fields }, 201, `Creating the coupon ${fields.code}`),
    returnsOn: (patch = {}) => shop.must('PATCH', '/return-settings', { enabled: true, windowDays: 7, proof: 'either', ...patch }, 200, 'Turning returns on'),
    async loyaltyOn(patch = {}) {
      await setFeature(shop, 'loyalty', true);
      return shop.must('PATCH', '/loyalty/settings', { enabled: true, earnPoints: 1, earnPerPaise: 10000, pointValuePaise: 100, maxRedeemPoints: 50, ...patch }, 200, 'Turning loyalty on');
    },
    remindersOn: () => shop.must('PATCH', '/cart-reminders', { enabled: true }, 200, 'Turning cart reminders on'),
    alertsSet: (patch) => shop.must('PATCH', '/alert-settings', patch, 200, 'Saving alert settings'),
    orderApi: (orderId) => shop.must('GET', `/orders/${orderId}`, undefined, 200, 'Reading an order'),
    timeline: async (orderId) => (await shop.must('GET', `/orders/${orderId}/timeline`, undefined, 200, 'Reading an order timeline')).items,
    orderEventRows: (orderId, type) => sql(`SELECT * FROM order_events WHERE tenant_id = $1 AND order_id = $2 ${type ? 'AND type = $3' : ''} ORDER BY id`, type ? [id, orderId, type] : [id, orderId]),
    alertsOf: (orderId, event) => sql(`SELECT * FROM order_alerts WHERE tenant_id = $1 AND order_id = $2 ${event ? 'AND event = $3' : ''} ORDER BY id`, event ? [id, orderId, event] : [id, orderId]),
    reservations: (orderId) => sql('SELECT * FROM stock_reservations WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [id, orderId]),
    ledger: (shopperId) => sql('SELECT * FROM loyalty_ledger WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id', [id, shopperId]),
    securityEvents: () => securityEvents(world, id),
  });

  if (whatsapp) await shop.whatsappOn();
  if (pay) await shop.payReady();
  if (pickup) await shop.pickupReady();
  if (notice) await shop.noticeReady();
  return shop;
}

// ---- a shopper's browser --------------------------------------------------------------------------------------------------

const CSRF_PATTERNS = [/name="_csrf"\s+value="([^"]+)"/, /data-csrf="([^"]+)"/, /<meta\s+name="csrf-token"\s+content="([^"]+)"/i, /value="([^"]+)"\s+name="_csrf"/];

/**
 * A shopper with a cookie jar on one business's own host. JSON calls go to /api/store with the page's Origin and, once
 * signed in, the session's CSRF token.
 */
export function buyer(world, shop, { ua = UA.phone, ip = `203.0.113.${crypto.randomInt(1, 250)}`, app = world } = {}) {
  const jar = {};
  let csrf = '';
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    for (const line of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line) || /max-age=0/i.test(line)) delete jar[name];
      else jar[name] = value;
    }
    return res;
  };
  const base = (extra = {}) => ({ 'user-agent': ua, 'x-forwarded-for': ip, ...(cookie() ? { cookie: cookie() } : {}), ...extra });

  let primed = false;
  const self = {
    jar, ip, shop,
    get signedIn() { return Boolean(jar[SHOPPER_COOKIE]); },
    get cookie() { return cookie(); },
    set csrf(value) { csrf = value; },
    get csrf() { return csrf; },
    /** A page, as the phone loads it. */
    async open(path, headers = {}) {
      primed = true;
      const res = absorb(await hit(app, path, { host: shop.host, headers: base({ accept: 'text/html', ...headers }) }));
      for (const p of CSRF_PATTERNS) {
        const found = p.exec(res.text)?.[1];
        if (found) { csrf = found; break; }
      }
      return res;
    },
    /**
     * A JSON call. `body` undefined sends none. A shopper always has a page open before a page posts anything, so the
     * first POST of a fresh browser loads the checkout page first (cookies and any CSRF token come from there).
     */
    async api(method, path, body, headers = {}) {
      if (method !== 'GET' && !primed && !csrf) await self.open('/checkout');
      const h = base({ accept: 'application/json', origin: `https://${shop.host}`, ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...headers });
      const res = withData(absorb(await hit(app, path, { host: shop.host, method, headers: h, ...(body === undefined ? {} : { body }) })));
      if (res.data?.csrf) csrf = res.data.csrf;
      if (res.data?.csrfToken) csrf = res.data.csrfToken;
      return res;
    },

    // sign-in
    sendCode: (phone, purpose = 'sign_in', extra = {}) => self.api('POST', '/api/store/otp/send', { phone, purpose, ...extra }),
    verifyCode: (phone, code, purpose = 'sign_in', extra = {}) => self.api('POST', '/api/store/otp/verify', { phone, purpose, code, ...extra }),
    /** Signs in with a WhatsApp code, as the sign-in page does. */
    async signIn(phone = newPhone()) {
      ok(await self.sendCode(phone), 'Asking for a sign-in code');
      const code = await world.codeFor(phone);
      ok(await self.verifyCode(phone, code), 'Entering the sign-in code');
      assert.ok(jar[SHOPPER_COOKIE], `Signing in set no ${SHOPPER_COOKIE} cookie`);
      if (!csrf) await self.open('/account');
      self.phone = phone;
      return phone;
    },
    /** The signed-in shopper's row. */
    async me() {
      return shop.one('SELECT * FROM shoppers WHERE tenant_id = $1 AND phone = $2', [shop.tenantId, self.phone]);
    },

    // cart and checkout
    putCart: (lines) => self.api('PUT', '/api/store/cart', { lines }),
    getCart: () => self.api('GET', '/api/store/cart'),
    quote: (body) => self.api('POST', '/api/store/checkout/quote', body),
    /** The body the checkout page sends for these lines. */
    checkoutBody({ lines, paymentMode = 'prepaid', address: addr, addressId, consent, ...rest } = {}) {
      return {
        lines,
        paymentMode,
        ...(addressId ? { addressId } : { address: addr ?? address() }),
        idempotencyKey: idemKey(),
        acceptTerms: true,
        consent: { noticeVersion: shop.noticeVersion ?? 1, orderUpdates: { whatsapp: true, email: true }, marketing: { whatsapp: false, email: false }, ...consent },
        ...rest,
      };
    },
    place: (body) => self.api('POST', '/api/store/checkout', body),
    /** Places an order that must be taken, and answers the PlacedOrder. */
    async order(fields) {
      const body = self.checkoutBody(fields);
      const res = ok(await self.place(body), 'Placing an order');
      return { ...res.data, body };
    },
    /**
     * Cash on delivery as a guest: the page is told to verify the phone, the code arrives by WhatsApp, and the same
     * checkout is sent again.
     */
    async orderCod(fields) {
      const body = self.checkoutBody({ ...fields, paymentMode: fields.paymentMode ?? 'cod' });
      let res = ok(await self.place(body), 'Placing a cash-on-delivery order');
      if (res.data.next === 'verify_phone') {
        const phone = body.address?.phone ?? self.phone;
        ok(await self.sendCode(phone, 'cod', { checkoutKey: body.idempotencyKey }), 'Asking for the cash-on-delivery code');
        ok(await self.verifyCode(phone, await world.codeFor(phone), 'cod', { checkoutKey: body.idempotencyKey }), 'Entering the cash-on-delivery code');
        res = ok(await self.place(body), 'Placing the order after the code');
      }
      return { ...res.data, body };
    },
    /** The shopper pays at the gateway; unless `back` is false the page then brings the signed result back. */
    async pay(placed, { back = true, webhook = false, ...options } = {}) {
      assert.ok(placed.gateway?.gatewayOrderId, `The order has no gateway order to pay: ${JSON.stringify(placed).slice(0, 300)}`);
      const paid = await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, webhook, ...options });
      const res = back ? await self.paymentReturn(placed, paid) : null;
      return { ...paid, res };
    },
    paymentReturn: (placed, paid, change = {}) => self.api('POST', '/api/store/payments/return', { orderToken: placed.token, gatewayOrderId: placed.gateway.gatewayOrderId, gatewayPaymentId: paid.payment.id, signature: paid.signature, ...change }),
    /** Places a prepaid order, pays it, and waits until the store says it is paid. The order row. */
    async buy(fields, payOptions = {}) {
      const placed = await self.order(fields);
      const paid = await self.pay(placed, payOptions);
      const row = await shop.orderWhen(placed.orderNumber, (o) => o.payment_status === 'paid' || o.payment_status === 'advance_paid');
      return Object.assign(row, { placed, paid });
    },
    /** A paid order taken through packed, shipped and delivered by hand. The delivered row, with `placed`. */
    async delivered(fields, payOptions) {
      const row = await self.buy(fields, payOptions);
      const done = await shop.handDeliver(row);
      return Object.assign(done, { placed: row.placed, paid: row.paid });
    },

    // the account
    addresses: () => self.api('GET', '/api/store/addresses'),
    addAddress: (fields = {}) => self.api('POST', '/api/store/addresses', address(fields)),
    updateAddress: (id, fields) => self.api('PUT', `/api/store/addresses/${id}`, fields),
    removeAddress: (id) => self.api('DELETE', `/api/store/addresses/${id}`),
    cancelOrder: (orderNumber, body = {}) => self.api('POST', `/api/store/orders/${encodeURIComponent(orderNumber)}/cancel`, body),
    consent: () => self.api('GET', '/api/store/consent'),
    saveConsent: (choices) => self.api('POST', '/api/store/consent', { choices: { noticeVersion: shop.noticeVersion ?? 1, ...choices } }),
    dataRequest: (kind = 'erasure') => self.api('POST', '/api/store/data-requests', { kind }),
    review: (body) => self.api('POST', '/api/store/reviews', body),
    /** A return request as the return page sends it: multipart, with the proof files given. */
    async askReturn(orderNumber, { fields = {}, files = [] } = {}) {
      const form = multipartBody(fields, files);
      if (!primed && !csrf) await self.open(`/account/orders/${encodeURIComponent(orderNumber)}/return`);
      const res = await hit(app, `/api/store/orders/${encodeURIComponent(orderNumber)}/returns`, {
        host: shop.host,
        method: 'POST',
        headers: base({ accept: 'application/json', origin: `https://${shop.host}`, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...form.headers }),
        body: form.body,
      });
      return withData(absorb(res));
    },
    /** Gives the shared-profile consent on the one screen that names the platform (9.22). */
    async shareProfile() {
      await world.sql(`INSERT INTO shared_consent_notices (version, body_en, body_hi) VALUES (1, 'Shared profile notice', 'साझा प्रोफ़ाइल सूचना') ON CONFLICT DO NOTHING`);
      const [{ v }] = await world.sql('SELECT max(version)::int AS v FROM shared_consent_notices');
      await self.open('/account/shared-profile');
      // The contract names the call but not its body: the forms a page would most plausibly send, first accepted wins.
      let last;
      for (const body of [{ noticeVersion: v }, { noticeVersion: v, agree: true }, { noticeVersion: v, granted: true }, { consent: true, noticeVersion: v }]) {
        last = await self.api('POST', '/api/store/shared-profile', body);
        if (last.status < 300) return last;
      }
      return last;
    },
    revokeShared: () => self.api('DELETE', '/api/store/shared-profile'),
    /** Google sign-in, following each redirect as the browser would. `user` is who Google says signed in. */
    async googleSignIn(user = {}, { next } = {}) {
      await world.google.post('/next-user', { sub: `g-${unique()}`, email: `shopper${unique()}@mail.example`, name: 'Asha Rao', ...user });
      const start = await self.open(`/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`);
      assert.ok([302, 303].includes(start.status), `Google sign-in did not start with a redirect: ${start.status} ${start.text.slice(0, 200)}`);
      const consent = await fetch(start.headers.location, { redirect: 'manual' });
      const back = new URL(consent.headers.get('location'));
      const res = await self.open(`${back.pathname}${back.search}`);
      return { start, back, res };
    },
  };
  return self;
}

/**
 * The business on a second domain of its own ending in .localhost, which the Google simulator accepts as a redirect address.
 * The store answers there as on its own host; buyer(world, onLocalDomain(...)) shops on it.
 */
export async function onLocalDomain(world, shop) {
  const domain = `${shop.slug ?? `shop-${unique()}`}-${unique()}.localhost`.toLowerCase();
  await world.sql(`INSERT INTO tenant_domains (domain, tenant_id, status, verified_at) VALUES ($1, $2, 'verified', now())`, [domain, shop.tenantId]);
  return Object.assign(Object.create(shop), { host: domain });
}

/** A multipart/form-data body with text fields and files ({ field, filename, type, data }). */
export function multipartBody(fields = {}, files = []) {
  const boundary = `----spec${crypto.randomUUID().replace(/-/g, '')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${typeof value === 'string' ? value : JSON.stringify(value)}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'proof'}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** A small real PNG and a few bytes that start like an MP4, for return proofs. */
export const proofPhoto = () => ({ field: 'proof', filename: 'item.png', type: 'image/png', data: png({ width: 64, height: 64, color: '#884422' }) });
export const proofVideo = () => ({ field: 'proof', filename: 'item.mp4', type: 'video/mp4', data: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(512, 1)]) });

/**
 * Security events for a business, wherever the store records them: the audit log (the business's or the platform's),
 * provider events flagged `security`, and alerts to the owner or to ops. The contract names the flag on provider events
 * only, so the specs accept any of these places.
 */
export async function securityEvents(world, tenantId) {
  const audit = await world.sql(`SELECT 'audit' AS place, action AS what FROM audit_log WHERE (tenant_id = $1 OR tenant_id IS NULL) AND (action ~* 'security|forg|signature|mismatch|tamper' OR target ~* 'security|forg|signature')`, [tenantId]);
  const hooks = await world.sql(`SELECT 'webhook' AS place, outcome AS what FROM provider_webhook_events WHERE security AND (tenant_id = $1 OR tenant_id IS NULL)`, [tenantId]);
  const alerts = await world.sql(`SELECT 'alert' AS place, kind AS what FROM alerts WHERE (tenant_id = $1 OR tenant_id IS NULL) AND (kind ~* 'security|forg|signature|mismatch|tamper')`, [tenantId]);
  return [...audit, ...hooks, ...alerts];
}

/** Runs `n` copies of `make(i)` at the same moment. */
export const together = (n, make) => Promise.all(Array.from({ length: n }, (_, i) => make(i)));

/** No platform name in a page, its headers, or a JSON answer a buyer receives. */
export function assertSellerBrandOnly(res, what) {
  noPlatformName(`${what} (body)`, res.text);
  noPlatformName(`${what} (headers)`, res.headers);
}

/** Every amount of an order row as numbers. */
export const money = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => k.endsWith('_paise')).map(([k, v]) => [k, Number(v)]));
export const sum = (list, f = (x) => x) => list.reduce((total, x) => total + Number(f(x)), 0);

/**
 * The seller connects its own Razorpay account and switches to it (S-72, S-76): Partner OAuth for API calls, and the key
 * saved through the payment settings for checkout signatures. The simulator accepts a seller's own account by OAuth token only.
 */
export async function ownGateway(world, shop) {
  const start = await shop.send('POST', '/payment-account/connect');
  need(start, 200, 'Starting the own-account connection');
  const state = new URL(JSON.parse(start.text).url).searchParams.get('state');
  const own = await world.rzp.post('/oauth/code', { accountId: `acc_own${unique()}` });
  need(await shop.open(`${STORE_PROVIDER_PATHS.razorpayOauth.path}?code=${own.code}&state=${encodeURIComponent(state ?? '')}`), [200, 302, 303], 'The gateway coming back from the connection');
  need(await shop.send('PATCH', '/settings/payment', { razorpayKeyId: `rzp_test_own${unique().replace(/[^A-Za-z0-9]/g, '')}`, razorpayKeySecret: own.keySecret }), 200, 'Saving the own key');
  need(await shop.send('PUT', '/payment-account/mode', { mode: 'own' }), 200, 'Switching to own mode');
  return own;
}

/** The Authorization header the platform's own Razorpay keys make. */
export const platformAuth = (world) => `Basic ${Buffer.from(`${world.rzp.keyId}:${world.rzp.keySecret}`).toString('base64')}`;

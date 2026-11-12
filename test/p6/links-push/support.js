// What the links-push track's tests share: an app with every module, the push simulator wired in as the brands' own FCM and
// APNs, a stand-in for the app-api gate (that track's), shoppers, devices, orders and the seller's API.
import crypto from 'node:crypto';
import { MODULES } from '../../../src/modules/index.js';
import { shopperPushFor } from '../../../src/modules/shopper-push/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { createPush as createPushSim } from '../../../tools/sim/push/index.mjs';
import { OWNER, REEL_ID, enableApp, seedReel, startApp } from '../../helpers.js';

export const BUNDLE = 'com.example.kesarapp';
export const SIM_PROJECT = 'kesar-shop-app';

/**
 * The app-api gate is another track's (src/modules/app-api/gate.js). These tests stand in for it on /api/store/ only, the
 * way its contract says it ends: req.appSession set from the session the test names in x-test-app-session (JSON), and
 * req.user null. It replaces app-api in its own place in MODULES, so the order of everything else is the real one.
 */
const standInGate = {
  name: 'app-api',
  routes(app) {
    app.use('/api/store/', (req, _res, next) => {
      const raw = req.get('x-test-app-session');
      if (raw) {
        req.appSession = JSON.parse(raw);
        req.user = null;
      }
      next();
    });
  },
};
export const modulesWithGate = () => MODULES.map((m) => (m.name === 'app-api' ? standInGate : m));

/** A clock at 12:00 IST on a Wednesday, outside quiet hours; `set` moves it. */
export function testClock(start = '2026-11-11T06:30:00Z') {
  let at = new Date(start).getTime();
  return { now: () => new Date(at), set: (date) => (at = new Date(date).getTime()), advance: (ms) => (at += ms) };
}

export const deviceId = () => crypto.randomBytes(12).toString('hex');
export const androidToken = () => `fcm-${crypto.randomBytes(16).toString('hex')}`;
export const iosToken = () => crypto.randomBytes(32).toString('hex');

/**
 * An app with the push simulator, a business with its shopper app (both platforms) and, unless `credentials: false`, the
 * brand's own FCM and APNs credentials (the simulator's). `w.service` is shopperPushFor(app.ctx) on a test clock.
 */
export async function startWorld({ credentials = true, platforms = ['android', 'ios'], overrides = {} } = {}) {
  const sim = createPushSim({ project: SIM_PROJECT, topic: BUNDLE, keyId: 'KESARKEY01', teamId: 'KESARTEAM1' });
  await sim.start();
  const app = await startApp({ modules: modulesWithGate(), overrides: { fcmBaseUrl: sim.url, apnsBaseUrl: sim.apnsUrl, providerTimeoutMs: 700, ...overrides } });
  await enableApp(app, { platforms, config: { ios_bundle_id: BUNDLE } });
  const clock = testClock();
  const service = shopperPushFor(app.ctx);
  service.now = clock.now;
  service.retryDelayMs = () => 5;
  const owner = await app.repos.users.findByPhone(OWNER.phone);
  const { token } = await (await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) })).json();
  const sql = (text, params) => app.db.platform.query(text, params);
  const w = {
    app, sim, clock, service, owner, token, sql,
    tenant: app.tenant,
    inTenant: (fn, tenant = app.tenant) => withTenant(tenant, fn),
    /** The seller's API, as the owner. */
    async api(method, path, body, { bearer = token, host } = {}) {
      const res = await fetch(`${app.base}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(host ? { 'x-forwarded-host': host } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch { /* not JSON */ }
      return { status: res.status, body: json, text };
    },
    /** A call of the app on this install. `session` is what the gate would have set. */
    async appCall(session, method, path, body, { host } = {}) {
      const res = await fetch(`${app.base}${path}`, {
        method,
        headers: {
          ...(session ? { 'x-test-app-session': JSON.stringify(session) } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(host ? { 'x-forwarded-host': host } : {}),
        },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch { /* not JSON */ }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    async saveCredentials({ fcm = true, apns = true } = {}) {
      const body = {};
      if (fcm) body.fcm = { serviceAccount: sim.fcmCredentials().serviceAccount };
      if (apns) {
        const a = sim.apnsCredentials();
        body.apns = { keyId: a.keyId, teamId: a.teamId, key: a.key, env: 'sandbox' };
      }
      return w.inTenant(() => service.credentials.save(body, owner));
    },
    async received(token) {
      const all = await sim.received();
      return token ? all.filter((r) => r.token === token) : all;
    },
    async close() {
      app.ctx.notify?.close?.();
      app.close();
      await sim.close();
    },
  };
  if (credentials) await w.saveCredentials();
  return w;
}

/** A shopper of `tenant` (default: the world's business). */
export async function makeShopper(w, { tenant = w.tenant } = {}) {
  const phone = `+9198${crypto.randomInt(10_000_000, 99_999_999)}`;
  const [row] = await w.sql('INSERT INTO shoppers (tenant_id, phone) VALUES ($1, $2) RETURNING id', [tenant.id, phone]);
  return Number(row.id);
}

/** What the gate sets for an install: a guest one unless `shopperId`. */
export const sessionFor = ({ shopperId = null, platform = 'android', device = deviceId() } = {}) => ({
  id: crypto.randomInt(1, 1e9), familyId: crypto.randomInt(1, 1e9), deviceId: device, platform, version: '1.0.0', method: shopperId ? 'whatsapp_otp' : 'guest', guest: !shopperId, shopperId,
});

/** An install that registered a token with the permission granted, and turned on `toggles` from settings. */
export async function installApp(w, { shopperId = null, platform = 'android', toggles = {}, host } = {}) {
  const session = sessionFor({ shopperId, platform });
  const token = platform === 'ios' ? iosToken() : androidToken();
  const registered = await w.appCall(session, 'PUT', '/api/store/app/push/device', { token, permission: 'granted' }, { host });
  if (registered.status !== 200) throw new Error(`register ${registered.status} ${registered.text}`);
  if (Object.keys(toggles).length) {
    const saved = await w.appCall(session, 'PUT', '/api/store/app/push/prefs', { ...toggles, source: 'settings' }, { host });
    if (saved.status !== 200) throw new Error(`prefs ${saved.status} ${saved.text}`);
  }
  return { session, token };
}

/** An order of the business (as checkout writes one), optionally a shopper's. */
export async function placeOrder(w, { shopperId = null, tenant = w.tenant } = {}) {
  const [product] = await w.sql(
    `INSERT INTO products (tenant_id, name, slug, price_paise, active) VALUES ($1, 'Brass lamp', $2, 50000, true) RETURNING id`,
    [tenant.id, `brass-lamp-${crypto.randomBytes(4).toString('hex')}`],
  );
  const row = {
    order_number: `KS-${crypto.randomInt(100_000, 999_999)}`, public_token: crypto.randomBytes(12).toString('base64url'), flow: 'checkout', payment_mode: 'prepaid',
    customer_name: 'Asha Rao', phone: '+919876543210', address: '12 Lake Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
    subtotal_paise: 50000, discount_paise: 0, shipping_paise: 0, tax_paise: 0, total_paise: 50000, advance_paise: 0, balance_paise: 0,
    idempotency_key: crypto.randomUUID(), shipping_address: JSON.stringify({ name: 'Asha Rao', phone: '+919876543210', line1: '12 Lake Road', city: 'Pune', stateCode: '27', pincode: '411001' }),
    ...(shopperId ? { shopper_id: shopperId } : {}),
  };
  const columns = Object.keys(row);
  return withTenant(tenant, () => w.app.db.tx(async (t) => {
    const [created] = await t.query(
      `INSERT INTO orders (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
      [tenant.id, ...columns.map((c) => row[c])],
    );
    await t.query(`INSERT INTO order_items (tenant_id, order_id, product_id, name, price_paise, qty) VALUES ($1, $2, $3, 'Brass lamp', 50000, 1)`, [tenant.id, created.id, product.id]);
    return created;
  }));
}

/** An order event as the bus hands it to a listener. */
export async function orderEvent(w, order, type = 'order.shipped', { tenant = w.tenant } = {}) {
  const [row] = await w.sql(
    `INSERT INTO order_events (tenant_id, type, order_id, entity, entity_id) VALUES ($1, $2, $3, 'order', $4) RETURNING id`,
    [tenant.id, type, order.id, order.id],
  );
  return { id: Number(row.id), type, tenantId: tenant.id, orderId: order.id, entity: 'order', entityId: order.id, from: '', to: '', data: {}, createdAt: new Date() };
}

/** A reel with live products, in a visible category: the trigger writes the outbox row. */
export async function reelInCategory(w, { name = 'Diwali edit', slug = 'diwali', igId = REEL_ID } = {}) {
  await w.inTenant(() => seedReel(w.app.repos));
  const [reel] = await w.sql('SELECT id, slug FROM reels WHERE tenant_id = $1 AND ig_media_id = $2', [w.tenant.id, igId]);
  const [category] = await w.sql(`INSERT INTO categories (tenant_id, name, slug, visible) VALUES ($1, $2, $3, true) RETURNING id`, [w.tenant.id, name, slug]);
  await w.sql('INSERT INTO category_reels (tenant_id, category_id, page_id, position) VALUES ($1, $2, $3, 0)', [w.tenant.id, category.id, reel.id]);
  return { reel, category };
}

/**
 * Another business on the same app, with its own Android app and (unless `credentials: false`) its own FCM project: the
 * simulator's, so its pushes arrive there too. `host` is its own address; `run(fn)` runs fn as that business.
 */
export async function newBusiness(w, slug, { credentials = true } = {}) {
  const tenant = await w.app.platform.tenants.ensure({ slug, name: slug });
  await enableApp(w.app, { tenant, platforms: ['android'] });
  const run = (fn) => withTenant(tenant, fn);
  if (credentials) await run(() => w.service.credentials.save({ fcm: { serviceAccount: w.sim.fcmCredentials().serviceAccount } }, null));
  return { tenant, host: `${slug}.bhava.test`, run };
}

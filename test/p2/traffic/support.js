// What the traffic tests share: a running app on a controlled clock, with a real business on a chosen plan, and small helpers for hits and API calls.
import crypto from 'node:crypto';
import http from 'node:http';
import { config } from '../../../src/config.js';
import { VISITOR_COOKIE, TRAFFIC_PATHS } from '../../../src/contracts/analytics.js';
import { createGoogleAdapters } from '../../../src/adapters/google/index.js';
import { createMetaAdapters } from '../../../src/adapters/meta/index.js';
import { servicesFor } from '../../../src/modules/traffic/services.js';
import { createPlatform } from '../../../src/platform/index.js';
import { bindTenant } from '../../../src/repos/index.js';
import { createApp } from '../../../src/server.js';
import { withTenant } from '../../../src/tenancy.js';
import { IG_ACCOUNT, OWNER, TEST_DATA_KEY, fakeIg, setup } from '../../helpers.js';

export const INSTAGRAM_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 Instagram 300.0.0.0.0 Android';
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const WHATSAPP_CRAWLER_UA = 'WhatsApp/2.23.20.0 A';
export const NOW = Date.parse('2026-11-05T06:30:00Z'); // noon in India

export const newVisitor = () => crypto.randomUUID();

/** Starts the real app on a fresh database. `consent` replaces platform.consent, which says no until Phase 4. */
export async function startTraffic({ plan = 't3', overrides = {}, consent = null, at = NOW } = {}) {
  const { db, repos, platform, tenant } = await setup();
  await db.platform.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, tenant.id]);
  await repos.users.ensureOwner(OWNER);
  await platform.tenants.linkIgAccount(tenant.id, IG_ACCOUNT.igUserId, IG_ACCOUNT.username);
  await repos.igAccounts.setToken(IG_ACCOUNT.igUserId, IG_ACCOUNT.token);
  const clock = { now: at };
  const appConfig = { ...config, storageDriver: 'memory', queueDriver: 'pg', analyticsDriver: 'pg', cacheDriver: 'memory', defaultTenant: 'default', platformDomain: 'bhava.test', adminPhone: OWNER.phone, adminPassword: OWNER.password, sessionSecret: 'test-secret', verifyToken: 'vt', appSecret: 'secret', publicBaseUrl: 'https://shop.test', dataKey: TEST_DATA_KEY, dryRun: false, oneDmPerUser: false, trafficNow: () => clock.now, ...overrides };
  const drivers = createPlatform(appConfig, { db });
  const appPlatform = consent ? { ...drivers, consent } : drivers;
  const app = createApp({ db, ig: fakeIg(), config: appConfig, platform: appPlatform });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const token = await signIn(base, OWNER);
  // The worker's view of the same database and drivers, for the jobs a test runs by hand.
  const jobContext = { db, repos: platform, platform: appPlatform, config: appConfig, meta: createMetaAdapters(appConfig), google: createGoogleAdapters(appConfig), modules: [] };
  return { db, repos, platform, tenant, drivers, platformDrivers: appPlatform, config: appConfig, clock, base, port, token, jobContext, services: () => servicesFor(jobContext), inTenant: (fn) => withTenant(tenant, fn), close: () => server.close() };
}

export async function secondBusiness(world, { slug = 'leaf-and-clay', plan = 't3' } = {}) {
  const other = await world.platform.tenants.create({ slug, name: 'Leaf and Clay' });
  await world.db.platform.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, other.id]);
  const repos = bindTenant(world.platform, other);
  await repos.users.ensureOwner({ phone: '9000000002', password: 'owner-pass-2' });
  return { tenant: other, repos, host: `${slug}.bhava.test`, token: await signIn(world.base, { phone: '9000000002', password: 'owner-pass-2' }, `${slug}.bhava.test`, world.port) };
}

export function raw(port, path, { method = 'GET', host = '127.0.0.1', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function signIn(base, who, host, port) {
  if (host) {
    const res = await raw(port, '/api/v1/auth/login', { method: 'POST', host, body: who });
    return JSON.parse(res.text).token;
  }
  const res = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) });
  return (await res.json()).token;
}

export { signIn };

/** A person's API token, with a role and permissions. */
export async function staffToken(world, { role = 'staff', permissions = [], phone = '9123456780' } = {}) {
  const user = await world.repos.users.create({ name: 'Ravi S', phone, password: 'secret12', role: 'customer' });
  await world.repos.users.setRole(user.id, role);
  if (permissions.length) await world.repos.users.setPermissions(user.id, permissions);
  return signIn(world.base, { phone, password: 'secret12' });
}

export async function api(world, path, { method = 'GET', body, token = world.token, host } = {}) {
  const headers = { authorization: `Bearer ${token}`, ...(host ? { host } : {}) };
  const res = await raw(world.port, `/api/v1${path}`, { method, body, headers });
  return { status: res.status, body: res.text ? JSON.parse(res.text) : null };
}

/** A beacon from a browser. `visitor` is the cookie it holds, null for cookies blocked. Answers the raw response. */
export function beacon(world, fields, { visitor, ua = CHROME_UA, host = '127.0.0.1', query = '', headers = {} } = {}) {
  const body = { path: '/', utm: {}, ...fields };
  return raw(world.port, `${TRAFFIC_PATHS.event}${query}`, { method: 'POST', host, body, headers: { 'user-agent': ua, ...(visitor ? { cookie: `${VISITOR_COOKIE}=${visitor}` } : {}), ...headers } });
}

export function page(world, path, { ua = CHROME_UA, host = '127.0.0.1', cookie = '' } = {}) {
  return raw(world.port, path, { host, headers: { 'user-agent': ua, ...(cookie ? { cookie } : {}) } });
}

/** A paid order on this business, for the sales figures. */
export async function placeOrder(repos, { status = 'paid', reelId = null, productId } = {}) {
  const settings = await repos.settings.getAll();
  const order = await repos.orders.create({ items: [{ productId, qty: 1 }], customer: { name: 'A Shopper', phone: '9876543210', email: '', address: '12 Long Road', city: 'Pune', state: 'MH', pincode: '411001' }, reelId }, settings);
  if (status !== 'awaiting_payment') await repos.orders.setStatus(order.id, status);
  return order;
}

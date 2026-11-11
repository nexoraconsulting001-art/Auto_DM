import crypto from 'node:crypto';
import { APP_ROLE, openDb } from '../src/db/index.js';
import { bindTenant, createRepos } from '../src/repos/index.js';
import { createApp } from '../src/server.js';
import { config } from '../src/config.js';
import { createPlatform } from '../src/platform/index.js';
import { createSecrets } from '../src/platform/secrets.js';

export const REEL_ID = '18475694065114168';

/** Encrypts Instagram tokens in tests. Every repo and app in one test process shares it. */
export const TEST_DATA_KEY = crypto.randomBytes(32).toString('base64');

/** The Instagram account startApp connects to the default business. */
export const IG_ACCOUNT = { igUserId: 'ME', username: 'shop', token: 'test-ig-token' };

/** Stands in for createInstagram(). Each call takes the account first, like the real client; `calls` leaves it out and `accounts` has it. */
export function fakeIg({ failButton = false } = {}) {
  const calls = [];
  const accounts = [];
  const record = (kind) => async (account, ...a) => {
    accounts.push(account);
    calls.push([kind, ...a]);
  };
  const sendButton = record('button');
  return {
    calls,
    accounts,
    sendPrivateReplyButton: async (account, ...a) => {
      if (failButton) throw new Error('template not supported');
      await sendButton(account, ...a);
    },
    sendPrivateReply: record('text'),
    sendMessage: record('message'),
    replyToComment: record('reply'),
    listMedia: async () => ({ data: [{ id: REEL_ID, caption: 'Brunch look', media_product_type: 'REELS' }] }),
    getMedia: async (_account, id) => ({ id, caption: 'Brunch look', permalink: 'https://instagram.com/reel/x' }),
    getAccount: async () => ({ username: 'shop', user_id: 'ME' }),
  };
}

const DEFAULT_LOGINS = process.env.TEST_DB_LOGINS === '2' ? 2 : 1;

/** The app login's connection for an owner connection: the same database as the role bhava_app, with one password for the whole test server. */
export function appLoginUrl(ownerUrl) {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = crypto.createHash('sha256').update(`app-login:${process.env.TEST_DATABASE_URL}`).digest('hex').slice(0, 32);
  return url.href;
}

/**
 * A fresh, empty database: in memory by default, or a new database on the Postgres server at
 * TEST_DATABASE_URL (how CI proves everything also works on real Postgres).
 * `logins: 2` opens it the way production does, with the restricted app login for business work and the owner for
 * db.platform. That needs TEST_DATABASE_URL; the returned handle has `urls: { owner, app }`.
 * TEST_DB_LOGINS=2 makes that the default for every test, to see what still leans on the owner outside db.platform.
 */
export async function openTestDb({ migrate = true, logins = DEFAULT_LOGINS } = {}) {
  const url = process.env.TEST_DATABASE_URL;
  if (logins === 2 && !url) throw new Error('A two-login test database needs TEST_DATABASE_URL');
  if (!url) return openDb({ migrate });
  const admin = await openDb({ url, migrate: false, poolSize: 1 });
  const name = `t_${crypto.randomUUID().replace(/-/g, '')}`;
  await admin.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const target = new URL(url);
  target.pathname = `/${name}`;
  if (logins !== 2) return openDb({ url: target.href, poolSize: 3, migrate });
  const urls = { owner: target.href, app: appLoginUrl(target.href) };
  return Object.assign(await openDb({ url: urls.app, ownerUrl: urls.owner, poolSize: 3, migrate }), { urls });
}

/**
 * A fresh in-memory database with one business ("default", the DEFAULT_TENANT the app falls back to).
 * `repos` are bound to that business; `platform` are the unbound repos.
 */
export async function setup({ logins = DEFAULT_LOGINS } = {}) {
  const db = await openTestDb({ logins });
  const platform = createRepos(db, { secrets: createSecrets({ dataKey: TEST_DATA_KEY }) });
  const tenant = await platform.tenants.ensure({ slug: 'default', name: 'Test store' });
  return { db, repos: bindTenant(platform, tenant), platform, tenant };
}

/** Creates `n` products and a reel showing them. */
export async function seedReel(repos, { n = 2, keywords = 'LINK', active = 'on', stock = '' } = {}) {
  const products = [];
  for (let i = 0; i < n; i++) {
    products.push(await repos.products.create({ name: `Product ${i + 1}`, price: String(100 * (i + 1)), stock, active: 'on' }));
  }
  const reel = await repos.reels.save(REEL_ID, { headline: 'Brunch edit', keywords, productIds: products.map((p) => p.id), active });
  return { products, reel };
}

export const OWNER = { phone: '9000000001', password: 'owner-pass' };

/** Every test app has its own database; on a shared Redis it needs its own cache keys too (login limits, for one). */
function ownCacheKeys(cache) {
  const prefix = `${crypto.randomUUID()}:`;
  return { ...cache, get: (key) => cache.get(prefix + key), set: (key, ...rest) => cache.set(prefix + key, ...rest), del: (key) => cache.del(prefix + key) };
}

export async function startApp({ ig = fakeIg(), overrides = {}, modules, logins = DEFAULT_LOGINS } = {}) {
  const { db, repos, platform, tenant } = await setup({ logins });
  await repos.users.ensureOwner(OWNER);
  await platform.tenants.linkIgAccount(tenant.id, IG_ACCOUNT.igUserId, IG_ACCOUNT.username);
  await repos.igAccounts.setToken(IG_ACCOUNT.igUserId, IG_ACCOUNT.token);
  // Drivers follow the environment, so the CI production profile runs the whole app on Redis, S3 and ClickHouse.
  const appConfig = { ...config, storageDriver: process.env.STORAGE_DRIVER || 'memory', queueDriver: process.env.QUEUE_DRIVER || 'pg', analyticsDriver: process.env.ANALYTICS_DRIVER || 'pg', cacheDriver: process.env.CACHE_DRIVER || 'memory', defaultTenant: 'default', platformDomain: 'bhava.test', passwordLogin: true, adminPhone: OWNER.phone, adminPassword: OWNER.password, sessionSecret: 'test-secret', verifyToken: 'vt', appSecret: 'secret', publicBaseUrl: 'https://shop.test', dataKey: TEST_DATA_KEY, dryRun: false, oneDmPerUser: false, ...overrides };
  const drivers = createPlatform(appConfig, { db });
  const app = createApp({ db, ig, config: appConfig, platform: { ...drivers, cache: ownCacheKeys(drivers.cache) }, ...(modules ? { modules } : {}) });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, repos, platform, tenant, ig, base, port: server.address().port, config: appConfig, ctx: app.locals.ctx, close: () => server.close() };
}

/** Logs in through /login and returns the session cookie plus a CSRF token read from `csrfPage`. */
export async function login(base, { phone = OWNER.phone, password = OWNER.password, csrfPage = '/account' } = {}) {
  const res = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ phone, password }), redirect: 'manual' });
  if (res.status !== 303) throw new Error(`login failed with ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const page = await (await fetch(`${base}${csrfPage}`, { headers: { cookie } })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] || /data-csrf="([^"]+)"/.exec(page)?.[1];
  return { cookie, csrf, location: res.headers.get('location') };
}

/** The host where sellers sign in (PLATFORM_APP_HOST) in every test app: it belongs to no business. Send it as x-forwarded-host. */
export const APP_HOST = 'app.bhava.test';
const onAppHost = (headers = {}) => ({ 'x-forwarded-host': APP_HOST, 'content-type': 'application/json', ...headers });
const digitsOf = (phone) => String(phone).replace(/\D/g, '');

/**
 * The newest one-time code WhatsApp was asked to deliver to `phone`, read from the WhatsApp simulator's outbox
 * (`whatsapp` is createWhatsApp() from tools/sim/whatsapp, started by the test and wired into the app). The code is
 * the first 6-digit value among the message's template parameters, or in its text.
 */
export async function sellerCodeFor(whatsapp, phone) {
  const local = digitsOf(phone).slice(-10);
  const { sent } = await whatsapp.get('/sent');
  const message = [...sent].reverse().find((m) => digitsOf(m.to).endsWith(local));
  if (!message) throw new Error('No WhatsApp message was sent to that number');
  const texts = [];
  const walk = (value) => {
    if (typeof value === 'string') texts.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(message.body?.template?.components ?? message.body?.text ?? message.body);
  const code = texts.map((t) => /(?<!\d)\d{6}(?!\d)/.exec(t)?.[0]).find(Boolean);
  if (!code) throw new Error('The WhatsApp message to that number holds no 6-digit code');
  return code;
}

async function verifiedSession(base, { phone, whatsapp, transport, device, tenantId, headers }) {
  if (!whatsapp) throw new Error('Pass the WhatsApp simulator the app sends through: signIn(base, { phone, whatsapp })');
  const start = await fetch(`${base}/api/v1/auth/start`, { method: 'POST', headers: onAppHost(headers), body: JSON.stringify({ phone }) });
  if (start.status !== 202) throw new Error(`auth.start failed with ${start.status}`);
  const code = await sellerCodeFor(whatsapp, phone);
  const res = await fetch(`${base}/api/v1/auth/verify`, { method: 'POST', headers: onAppHost(headers), body: JSON.stringify({ phone, code, transport, ...(device ? { device } : {}), ...(tenantId ? { tenantId } : {}) }) });
  if (res.status !== 201) throw new Error(`auth.verify failed with ${res.status}`);
  return { res, session: await res.json() };
}

/**
 * Signs a seller in to the web console without a password: asks for a WhatsApp code on the sign-in host, reads it from
 * the WhatsApp simulator and verifies it. Returns { cookie, csrf, session, headers }; `headers` are what a later
 * request on the sign-in host sends (the cookie, the CSRF token and the host). login() is the Phase 0 password way.
 */
export async function signIn(base, { phone = OWNER.phone, whatsapp, tenantId } = {}) {
  const { res, session } = await verifiedSession(base, { phone, whatsapp, transport: 'cookie', tenantId });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, csrf: session.csrf, session, headers: onAppHost({ cookie, 'x-csrf-token': session.csrf }) };
}

/** A device as the owner app describes itself at sign-in. */
export const testDevice = (name = 'Pixel 8', id = crypto.randomBytes(16).toString('hex')) => ({ id, name, platform: 'android', app: 'owner', appVersion: '1.0.0' });

/**
 * Signs a seller in the way the owner app does. Returns { accessToken, refreshToken, session, device, headers };
 * `headers` are what the app sends on a later request: the access token and the sign-in host.
 */
export async function appSession(base, { phone = OWNER.phone, whatsapp, device = testDevice(), tenantId, app } = {}) {
  const appHeaders = app ? { 'x-app': app.name ?? 'owner', 'x-app-version': app.version, 'x-app-platform': app.platform ?? device.platform } : {};
  const { session } = await verifiedSession(base, { phone, whatsapp, transport: 'bearer', device, tenantId, headers: appHeaders });
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, session, device, headers: onAppHost({ authorization: `Bearer ${session.accessToken}`, ...appHeaders }) };
}

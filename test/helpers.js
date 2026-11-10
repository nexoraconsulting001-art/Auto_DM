import crypto from 'node:crypto';
import { openDb } from '../src/db/index.js';
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
    replyToComment: record('reply'),
    listMedia: async () => ({ data: [{ id: REEL_ID, caption: 'Brunch look', media_product_type: 'REELS' }] }),
    getMedia: async (_account, id) => ({ id, caption: 'Brunch look', permalink: 'https://instagram.com/reel/x' }),
    getAccount: async () => ({ username: 'shop', user_id: 'ME' }),
  };
}

/**
 * A fresh, empty database: in memory by default, or a new database on the Postgres server at
 * TEST_DATABASE_URL (how CI proves everything also works on real Postgres).
 */
export async function openTestDb({ migrate = true } = {}) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openDb({ migrate });
  const admin = await openDb({ url, migrate: false, poolSize: 1 });
  const name = `t_${crypto.randomUUID().replace(/-/g, '')}`;
  await admin.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const target = new URL(url);
  target.pathname = `/${name}`;
  return openDb({ url: target.href, poolSize: 3, migrate });
}

/**
 * A fresh in-memory database with one business ("default", the DEFAULT_TENANT the app falls back to).
 * `repos` are bound to that business; `platform` are the unbound repos.
 */
export async function setup() {
  const db = await openTestDb();
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

export async function startApp({ ig = fakeIg(), overrides = {}, modules } = {}) {
  const { db, repos, platform, tenant } = await setup();
  await repos.users.ensureOwner(OWNER);
  await platform.tenants.linkIgAccount(tenant.id, IG_ACCOUNT.igUserId, IG_ACCOUNT.username);
  await repos.igAccounts.setToken(IG_ACCOUNT.igUserId, IG_ACCOUNT.token);
  // Drivers follow the environment, so the CI production profile runs the whole app on Redis, S3 and ClickHouse.
  const appConfig = { ...config, storageDriver: process.env.STORAGE_DRIVER || 'memory', queueDriver: process.env.QUEUE_DRIVER || 'pg', analyticsDriver: process.env.ANALYTICS_DRIVER || 'pg', cacheDriver: process.env.CACHE_DRIVER || 'memory', defaultTenant: 'default', platformDomain: 'bhava.test', adminPhone: OWNER.phone, adminPassword: OWNER.password, sessionSecret: 'test-secret', verifyToken: 'vt', appSecret: 'secret', publicBaseUrl: 'https://shop.test', dataKey: TEST_DATA_KEY, dryRun: false, oneDmPerUser: false, ...overrides };
  const drivers = createPlatform(appConfig, { db });
  const app = createApp({ db, ig, config: appConfig, platform: { ...drivers, cache: ownCacheKeys(drivers.cache) }, ...(modules ? { modules } : {}) });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, repos, platform, tenant, ig, base, port: server.address().port, close: () => server.close() };
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

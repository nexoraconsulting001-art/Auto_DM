import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { APP_ROLE, MIGRATIONS_DIR, openDb } from '../src/db/index.js';
import { bindTenant, createRepos } from '../src/repos/index.js';
import { currentTenant } from '../src/tenancy.js';
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

// Every test opens its own database on the shared server, and most never close it. Left alone they pile up for the whole run (each
// with its pool of connections and its tables in Postgres' shared statistics), until the server's shared memory is full and it
// restarts. So each test file drops the databases it made when it finishes; DROP ... WITH (FORCE) also ends the connections.
const createdDatabases = new Set();

async function dropCreatedDatabases() {
  const names = [...createdDatabases];
  if (!names.length) return;
  const admin = await openDb({ url: process.env.TEST_DATABASE_URL, migrate: false, poolSize: 1 });
  try {
    for (const name of names) {
      await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      createdDatabases.delete(name);
    }
  } finally {
    await admin.close();
  }
}

// Registered while the file loads, so it belongs to the file and not to whichever test happens to open the first database.
if (process.env.TEST_DATABASE_URL) after(dropCreatedDatabases);

// The same for ClickHouse (the CI production profile). Every test app has a fresh Postgres database, so business ids start again at 1,
// while the ClickHouse server outlives it: on one shared analytics database a new business 2 would read the rollups an earlier test's
// business 2 wrote (R6-P2-6, downloads N-61 rowCount). So each test app gets an analytics database of its own, dropped with the file.
const createdAnalyticsDatabases = new Set();

async function clickhouseRequest(sql) {
  const url = new URL(process.env.CLICKHOUSE_URL);
  const auth = url.username ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` : undefined;
  url.username = '';
  url.password = '';
  url.searchParams.set('query', sql);
  const res = await fetch(url, { method: 'POST', headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ClickHouse error ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function ownAnalyticsDatabase() {
  const name = `${process.env.CLICKHOUSE_DB || 'bhava'}_w${crypto.randomUUID().replace(/-/g, '')}`;
  await clickhouseRequest(`CREATE DATABASE ${name}`);
  createdAnalyticsDatabases.add(name);
  return name;
}

async function dropAnalyticsDatabases() {
  for (const name of [...createdAnalyticsDatabases]) {
    await clickhouseRequest(`DROP DATABASE IF EXISTS ${name}`);
    createdAnalyticsDatabases.delete(name);
  }
}

if (process.env.ANALYTICS_DRIVER === 'clickhouse' && process.env.CLICKHOUSE_URL) after(dropAnalyticsDatabases);

// Every test needs a database with all the migrations applied, and applying them one by one (one transaction each, a hundred or so)
// is most of what a test costs on a real server: it is why the whole suite on the production drivers did not fit in 40 minutes.
// So the migrated database is made once per server and per set of migration files (a template named from a hash of their
// contents), and every test's database is a copy of it (CREATE DATABASE ... TEMPLATE), which is a file-level copy.
let templateName = null;

function migrationsHash() {
  const hash = crypto.createHash('sha256');
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort()) {
    hash.update(file).update('|').update(fs.readFileSync(path.join(MIGRATIONS_DIR, file))).update('|');
  }
  return hash.digest('hex').slice(0, 20);
}

/** The name of this server's migrated template database, made now if it is not there. Safe across test processes started together. */
function migratedTemplate(url) {
  templateName ??= (async () => {
    const name = `t_tpl_${migrationsHash()}`;
    const building = `${name}_wip`;
    const admin = await openDb({ url, migrate: false, poolSize: 1 });
    try {
      // One connection, so the lock is held until it is released (or the connection ends): one process builds, the rest wait.
      await admin.query('SELECT pg_advisory_lock($1)', [4_242_077]);
      const [{ found }] = await admin.query('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS found', [name]);
      if (!found) {
        // A build that was cut short leaves the _wip database behind; it is never used, only replaced.
        await admin.exec(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
        await admin.exec(`CREATE DATABASE ${building}`);
        const target = new URL(url);
        target.pathname = `/${building}`;
        const migrated = await openDb({ url: target.href, poolSize: 1 });
        await migrated.close();
        // A database that has a connection cannot be a template, and the name is what says it is complete.
        await admin.exec(`ALTER DATABASE ${building} RENAME TO ${name}`);
      }
      await admin.query('SELECT pg_advisory_unlock($1)', [4_242_077]);
    } finally {
      await admin.close();
    }
    return name;
  })().catch((err) => {
    templateName = null;
    throw err;
  });
  return templateName;
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
 * `poolSize` is the connections a Postgres handle may open (3; with two logins the owner gets half, at least 2): a test
 * that holds many statements waiting at once needs more.
 *
 * One login works like two outside a business (R5-PP-4): the business handle (db.query/exec/tx) with no business selected
 * runs as the app role with no business set, exactly what the restricted app login is in production, so a test or a product
 * path that leans on the owner outside db.platform fails in every run, not only on the production profile (check:r05).
 * db.platform stays the owner. `restricted: false` gives the bare one-login handle (whose business handle outside a
 * business is the owner); it is for the few tests about that handle itself. A database opened without its migrations has
 * no app role yet, so it is not restricted unless asked.
 */
export async function openTestDb({ migrate = true, logins = DEFAULT_LOGINS, poolSize = 3, restricted = migrate } = {}) {
  const db = await openTestDbOnce({ migrate, logins, poolSize });
  return restricted ? asAppLoginOutsideBusiness(db) : db;
}

/**
 * The one-login handle made to work as the app login does outside withTenant(): each statement, or transaction, outside a
 * business steps down to the app role with app.tenant_id empty for that transaction only. Inside a business the handle's own
 * fence already does the same with the business set. A two-login handle already is this, and is returned as it is.
 */
export function asAppLoginOutsideBusiness(db) {
  if (db.logins !== 1) return db;
  const stepDown = `SET LOCAL ROLE ${APP_ROLE}; SELECT set_config('app.tenant_id', '', true)`;
  const outside = (fn) => db.tx(async (t) => {
    await t.exec(stepDown);
    return fn(t);
  });
  return {
    ...db,
    restricted: true,
    query: (sql, params = []) => (currentTenant() ? db.query(sql, params) : outside((t) => t.query(sql, params))),
    exec: (sql) => (currentTenant() ? db.exec(sql) : outside((t) => t.exec(sql))),
    tx: (fn) => (currentTenant() ? db.tx(fn) : outside(fn)),
  };
}

async function openTestDbOnce({ migrate, logins, poolSize }) {
  const url = process.env.TEST_DATABASE_URL;
  if (logins === 2 && !url) throw new Error('A two-login test database needs TEST_DATABASE_URL');
  if (!url) return openDb({ migrate });
  const admin = await openDb({ url, migrate: false, poolSize: 1 });
  const name = `t_${crypto.randomUUID().replace(/-/g, '')}`;
  // Only a test that wants the migrations applied by the database itself starts from a copy of the migrated template.
  await admin.exec(migrate ? `CREATE DATABASE ${name} TEMPLATE ${await migratedTemplate(url)}` : `CREATE DATABASE ${name}`);
  createdDatabases.add(name);
  await admin.close();
  const target = new URL(url);
  target.pathname = `/${name}`;
  if (logins !== 2) return openDb({ url: target.href, poolSize, migrate });
  const urls = { owner: target.href, app: appLoginUrl(target.href) };
  return Object.assign(await openDb({ url: urls.app, ownerUrl: urls.owner, poolSize, migrate }), { urls });
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

/** The scopes a full Instagram connect grants. */
export const CONNECT_SCOPES = Object.freeze(['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments', 'instagram_business_manage_insights']);

/**
 * Puts a business where a real connect followed by the hourly gate check leaves it: the Instagram account holds the scopes it was
 * granted, and every Meta release gate (PRD 4.15) has passed. Only then may an automation go to Test or Live.
 */
export async function passReleaseGates(db, tenantId, igUserId = IG_ACCOUNT.igUserId) {
  await db.platform.query('UPDATE ig_accounts SET granted_scopes = $3 WHERE tenant_id = $1 AND ig_user_id = $2', [tenantId, igUserId, [...CONNECT_SCOPES]]);
  await db.platform.query(
    `INSERT INTO compliance_settings (tenant_id, subject_salt, access_level, app_role_ok, privacy_url_ok_at, deletion_callback_ok_at, gate_passed_at)
     VALUES ($1, $2, 'advanced', true, now(), now(), now())
     ON CONFLICT (tenant_id) DO UPDATE SET access_level = 'advanced', app_role_ok = true, privacy_url_ok_at = now(), deletion_callback_ok_at = now(), gate_passed_at = now()`,
    [tenantId, crypto.randomBytes(24).toString('hex')],
  );
}

/** `releaseGates: true` connects the default business the way a seller who may go live is connected (passReleaseGates). */
export async function startApp({ ig = fakeIg(), overrides = {}, modules, logins = DEFAULT_LOGINS, releaseGates = false } = {}) {
  const { db, repos, platform, tenant } = await setup({ logins });
  await repos.users.ensureOwner(OWNER);
  await platform.tenants.linkIgAccount(tenant.id, IG_ACCOUNT.igUserId, IG_ACCOUNT.username);
  await repos.igAccounts.setToken(IG_ACCOUNT.igUserId, IG_ACCOUNT.token);
  if (releaseGates) await passReleaseGates(db, tenant.id);
  // Drivers follow the environment, so the CI production profile runs the whole app on Redis, S3 and ClickHouse.
  const analyticsDriver = overrides.analyticsDriver ?? (process.env.ANALYTICS_DRIVER || 'pg');
  const analyticsDb = analyticsDriver === 'clickhouse' && !overrides.clickhouseDb ? { clickhouseDb: await ownAnalyticsDatabase() } : {};
  const appConfig = { ...config, ...analyticsDb, storageDriver: process.env.STORAGE_DRIVER || 'memory', queueDriver: process.env.QUEUE_DRIVER || 'pg', analyticsDriver: process.env.ANALYTICS_DRIVER || 'pg', cacheDriver: process.env.CACHE_DRIVER || 'memory', defaultTenant: 'default', platformDomain: 'bhava.test', passwordLogin: true, adminPhone: OWNER.phone, adminPassword: OWNER.password, sessionSecret: 'test-secret', verifyToken: 'vt', appSecret: 'secret', publicBaseUrl: 'https://shop.test', dataKey: TEST_DATA_KEY, dryRun: false, oneDmPerUser: false, ...overrides };
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

// ---- Phase 6: the branded shopper app ----

/** A Play App Signing fingerprint shaped like the real ones (32 pairs of hex digits). Made up. */
export const TEST_SIGNING_SHA256 = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');

/**
 * Gives a business its shopper app: the plan features for `platforms` (tenant_features overrides of app.android, app.ios) and a
 * valid app_configs row, upserted. `config` holds app_configs columns by their SQL names to change, as { app_name: 'Kesar' }.
 * `app` is what startApp() or setup() returned; `tenant` another business of the same database. Returns the row.
 */
export async function enableApp(app, { platforms = ['android'], config = {}, tenant = app.tenant } = {}) {
  const features = { android: 'app.android', ios: 'app.ios' };
  for (const platform of platforms) {
    await app.db.platform.query(
      `INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, $2, true, NULL)
       ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = true, limit_value = NULL`,
      [tenant.id, features[platform]],
    );
  }
  const row = {
    app_name: 'Test store', short_name: 'Test', android_package: `com.example.t${tenant.id}`, ios_bundle_id: `com.example.t${tenant.id}`, url_scheme: `shop${tenant.id}`,
    shop_domain: 'shop.test', support_email: 'help@shop.test', privacy_url: 'https://shop.test/policies/privacy', apple_team_id: 'ABCDE12345',
    play_account_id: '1234567890', play_signing_sha256: [TEST_SIGNING_SHA256], ...config,
  };
  const columns = Object.keys(row);
  const [saved] = await app.db.platform.query(
    `INSERT INTO app_configs (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (tenant_id) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now() RETURNING *`,
    [tenant.id, ...columns.map((c) => row[c])],
  );
  return saved;
}

/**
 * Stands in for the shopper app of business `tenantId` on `base`: every request carries X-App: shopper, X-App-Tenant,
 * X-App-Version and X-App-Platform, and once start() has opened a session, Authorization: Shopper <access token>.
 *   start(grant = 'guest' | { grant, ... })   POST /api/store/app/session with this device; keeps the tokens. -> { status, body }
 *   refresh()                                 POST /api/store/app/session/refresh; keeps the new tokens. -> { status, body }
 *   fetch(path, { method, body, headers })    a body that is an object goes as JSON. -> the Response
 * `host` is sent as x-forwarded-host, for a business's own address.
 */
export function shopperApp(base, { tenantId, platform = 'android', version = '1.0.0', device = { id: crypto.randomBytes(16).toString('hex'), name: 'Pixel 8' }, host } = {}) {
  const headers = { 'x-app': 'shopper', 'x-app-tenant': String(tenantId), 'x-app-version': version, 'x-app-platform': platform, ...(host ? { 'x-forwarded-host': host } : {}) };
  const tokens = { accessToken: '', refreshToken: '' };
  const call = (path, { body, headers: extra = {}, ...init } = {}) => fetch(`${base}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { ...headers, ...(tokens.accessToken ? { authorization: `Shopper ${tokens.accessToken}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const answer = async (res) => {
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch { /* not JSON */ }
    if (res.ok && parsed?.accessToken) Object.assign(tokens, { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken ?? tokens.refreshToken });
    return { status: res.status, body: parsed };
  };
  return {
    device,
    headers,
    tokens,
    fetch: call,
    async start(grant = 'guest') {
      const body = typeof grant === 'string' ? { grant } : grant;
      return answer(await call('/api/store/app/session', { method: 'POST', body: { ...body, device } }));
    },
    async refresh() {
      return answer(await call('/api/store/app/session/refresh', { method: 'POST', body: { refreshToken: tokens.refreshToken } }));
    },
  };
}

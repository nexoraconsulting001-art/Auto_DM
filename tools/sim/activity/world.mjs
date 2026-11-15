/**
 * The world the showcase runs in (Phase 8, Q-01 to Q-04): the app, its worker and the simulators behind them, all in this
 * process and all on loopback. It is what `npm run showcase` and the tests stand up around a database.
 *
 *   const world = await openShowcaseWorld({ db });      // db from openDb() / openRuntimeDb()
 *   world.base                                          the app's address; send the business's own host in `host`
 *   world.hit(path, { host, method, headers, body, token })   one request to the app, as a browser or the console would
 *   world.sims                                          { meta, razorpay, shiprocket, whatsapp }
 *   world.settle()                                      lets the worker finish what is queued
 *   world.travel(ms)                                    makes everything stored `ms` older
 *   world.close()
 *
 * Time. The app reads Date.now() and the database's now(), and neither can be frozen from outside, so time passes the way
 * the Phase 1 to 5 specs do it: travel(ms) makes everything already stored older. Nothing is inserted: every timestamp of
 * every table moves by the same amount, so every order, message and row keeps the gaps it had. The controlled clock of the
 * activity generator (createClock) says how far; travel makes the app agree.
 *
 * Nothing here reaches outside this machine: each provider's base URL is a simulator's, and openShowcaseWorld refuses to
 * start when NODE_ENV is production (assertShowcaseAllowed).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { config as baseConfig } from '../../../src/config.js';
import { STORE_PROVIDER_PATHS } from '../../../src/contracts/store-routes.js';
import { createInstagram } from '../../../src/instagram.js';
import { createPlatform } from '../../../src/platform/index.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { createRepos } from '../../../src/repos/index.js';
import { createApp } from '../../../src/server.js';
import { registerJobs } from '../../../src/worker.js';
import { assertSimulatorsAllowed, isSimulatorUrl } from '../guard.mjs';
import { createMeta } from '../meta/index.mjs';
import { createRazorpay } from '../razorpay/index.mjs';
import { createShiprocket } from '../shiprocket/index.mjs';
import { createWhatsApp } from '../whatsapp/index.mjs';

export class ShowcaseRefusedError extends Error {}

/** The environment names the app reads for a provider's address (src/config.js). Any of them set to a real address stops the showcase. */
export const PROVIDER_ENV = Object.freeze(['AI_BASE_URL', 'APNS_BASE_URL', 'APPLE_KEYS_BASE_URL', 'APPSTORE_BASE_URL', 'EAS_BASE_URL', 'EMAIL_BASE_URL', 'EMAIL_HOSTS', 'FB_DIALOG_BASE_URL', 'FB_GRAPH_BASE_URL', 'FCM_BASE_URL', 'GA4_BASE_URL', 'GOOGLE_KEYS_BASE_URL', 'GOOGLE_OAUTH_BASE_URL', 'GRAPH_BASE_URL', 'IG_API_BASE_URL', 'IG_DIALOG_BASE_URL', 'PLAY_BASE_URL', 'RAZORPAY_AUTH_BASE_URL', 'RAZORPAY_BASE_URL', 'SHIPROCKET_BASE_URL', 'SHOPIFY_BASE_URL', 'WHATSAPP_BASE_URL']);
const PAYMENT_KEYS = Object.freeze(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_BILLING_KEY_ID', 'RAZORPAY_BILLING_KEY_SECRET']);
const LIVE_KEY = /^rzp_live_/i;

/**
 * Throws ShowcaseRefusedError when the environment could reach a real provider or a production system: NODE_ENV production,
 * a provider base URL that is not a simulator, a live payment key. Pure: reads only `env`.
 */
export function assertShowcaseAllowed(env = process.env) {
  if (String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production') throw new ShowcaseRefusedError('The showcase never runs when NODE_ENV is production.');
  for (const name of PROVIDER_ENV) {
    const value = String(env[name] ?? '').trim();
    if (!value) continue;
    const addresses = name.endsWith('_HOSTS') ? value.split(',').map((v) => v.trim()).filter(Boolean) : [value];
    if (addresses.some((address) => !isSimulatorUrl(address))) throw new ShowcaseRefusedError(`${name} names a real provider address. The showcase only talks to the simulators: unset it.`);
  }
  for (const name of PAYMENT_KEYS) {
    if (LIVE_KEY.test(String(env[name] ?? ''))) throw new ShowcaseRefusedError(`${name} holds a live key. The showcase only uses test keys.`);
  }
  if (env.DATABASE_URL) {
    let host = '';
    try {
      host = new URL(env.DATABASE_URL).hostname;
    } catch {
      throw new ShowcaseRefusedError('DATABASE_URL is not a valid address.');
    }
    if (env.SHOWCASE_ALLOW_REMOTE_DB !== '1' && !isSimulatorUrl(`http://${host}`)) {
      throw new ShowcaseRefusedError('DATABASE_URL is not on this machine. Point the showcase at a local or throwaway database (SHOWCASE_ALLOW_REMOTE_DB=1 for a named test server).');
    }
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = http.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** Every table's stored times move, so a seller's setup, a shopper's cart and a refund all age together. */
const NEVER_SHIFTED = new Set(['schema_migrations']);

export async function openShowcaseWorld({ db, env = process.env, overrides = {}, worker = true } = {}) {
  assertShowcaseAllowed(env);
  assertSimulatorsAllowed(env);
  if (!db) throw new ShowcaseRefusedError('Give the database (openDb or openRuntimeDb).');

  const appSecret = crypto.randomBytes(12).toString('hex');
  const verifyToken = crypto.randomBytes(8).toString('hex');
  const meta = createMeta({ app: { id: 'sim-app', secret: appSecret, verifyToken }, facebookApp: { id: 'sim-fb-app', secret: crypto.randomBytes(12).toString('hex') } });
  const razorpay = createRazorpay();
  const courierLogin = { email: 'sim@showcase.test', password: crypto.randomBytes(8).toString('hex') };
  const shiprocket = createShiprocket(courierLogin);
  const whatsapp = createWhatsApp();
  const sims = { meta, razorpay, shiprocket, whatsapp };
  for (const sim of Object.values(sims)) await sim.start();

  const platformDomain = env.PLATFORM_DOMAIN || 'showcase.test';
  const dataKey = env.DATA_KEY || crypto.randomBytes(32).toString('base64');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config = {
    ...baseConfig,
    storageDriver: 'memory',
    queueDriver: 'pg',
    analyticsDriver: 'pg',
    cacheDriver: 'memory',
    queuePollMs: 15,
    defaultTenant: '',
    platformDomain,
    platformHost: '',
    publicBaseUrl: '',
    adminUi: 'console',
    adminPhone: '',
    adminPassword: '',
    passwordLogin: true,
    sessionSecret: crypto.randomBytes(16).toString('hex'),
    verifyToken,
    appSecret,
    igAppId: 'sim-app',
    fbAppId: 'sim-fb-app',
    graphBaseUrl: meta.url,
    igApiBaseUrl: '',
    igDialogBaseUrl: '',
    fbGraphBaseUrl: '',
    fbDialogBaseUrl: '',
    metaCallbackBaseUrl: base,
    metaTimeoutMs: 20_000,
    metaLogin: 'instagram',
    facebookPages: false,
    dataKey,
    dryRun: false,
    oneDmPerUser: false,
    backupStorageDriver: '',
    providerTimeoutMs: 20_000,
    // The link checker opens a business's own page the way a shopper would, through the app; any other address is not reachable here.
    linkCheckFetch: async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
      if (!url.hostname.endsWith(`.${platformDomain}`)) return new Response('Not reachable from the showcase.', { status: 404 });
      return fetch(`${base}${url.pathname}${url.search}`, { ...init, headers: { ...(init.headers ?? {}), 'x-forwarded-host': url.host } });
    },
    orderEventsPollMs: 40,
    paymentMode: 'managed',
    razorpayBaseUrl: razorpay.url,
    razorpayAuthBaseUrl: razorpay.url,
    razorpayKeyId: razorpay.keyId,
    razorpayKeySecret: razorpay.keySecret,
    razorpayWebhookSecret: razorpay.webhookSecret,
    razorpayPartnerClientId: razorpay.partner.clientId,
    razorpayPartnerClientSecret: razorpay.partner.clientSecret,
    shiprocketBaseUrl: shiprocket.url,
    shiprocketEmail: courierLogin.email,
    shiprocketPassword: courierLogin.password,
    shiprocketWebhookToken: shiprocket.webhookToken,
    whatsappBaseUrl: whatsapp.url,
    whatsappAppSecret: whatsapp.appSecret,
    whatsappVerifyToken: 'showcase-wa-verify',
    emailDriver: 'none',
    pushDriver: 'none',
    aiDriver: 'none',
    ...overrides,
  };

  const secrets = createSecrets({ dataKey });
  const ig = createInstagram(config);
  const webDrivers = createPlatform(config, { db });
  // The repos an operator's script uses share the app's file storage, so a file saved through them is one the app serves.
  const platform = createRepos(db, { secrets, storage: webDrivers.storage });
  const app = createApp({ db, ig, config, platform: webDrivers });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  await meta.post('/app', { webhookUrl: `${base}/webhook`, redirectUris: [`${base}/oauth/instagram/callback`], deauthorizeUrl: `${base}/meta/deauthorize`, deletionUrl: `${base}/meta/deletion` });
  await razorpay.post('/webhooks/url', { url: `${base}${STORE_PROVIDER_PATHS.razorpayManaged.path}` });
  await shiprocket.post('/webhooks/url', { url: `${base}${STORE_PROVIDER_PATHS.courier.path}` });
  await whatsapp.post('/webhooks/url', { url: `${base}${STORE_PROVIDER_PATHS.whatsapp.path}` });

  const workers = [];
  if (worker) {
    const drivers = createPlatform(config, { db });
    workers.push({ drivers, schedule: registerJobs({ db, platform: drivers, config, ig }) });
  }

  const hit = (path, { host, method = 'GET', headers = {}, body, token, cookie } = {}) => new Promise((resolve, reject) => {
    const sent = { ...headers };
    if (host) sent.host = host;
    if (token) sent.authorization = `Bearer ${token}`;
    if (cookie) sent.cookie = cookie;
    let payload = body;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body);
      sent['content-type'] ??= 'application/json';
    }
    if (payload !== undefined) sent['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          // Not JSON: a page.
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, text, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(45_000, () => req.destroy(new Error(`no answer to ${method} ${path} in 45 s`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });

  const sql = (text, params = []) => db.platform.query(text, params);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Runs every periodic job now, whatever its interval, by clearing the marks that say it already ran this interval. */
  async function tick() {
    await sql(`DELETE FROM jobs WHERE dedupe_key LIKE 'every:%' AND status NOT IN ('queued', 'running')`);
    for (const w of workers) await w.schedule();
  }

  async function pending() {
    const [{ n }] = await sql(
      `SELECT (SELECT count(*) FROM inbound_events WHERE status IN ('stored', 'processing'))
            + (SELECT count(*) FROM outbound_jobs WHERE status = 'sending' OR (status = 'queued' AND run_at <= now()))
            + (SELECT count(*) FROM jobs WHERE status = 'running' OR (status = 'queued' AND run_at <= now())) AS n`,
    );
    return Number(n);
  }

  async function signature() {
    const [row] = await sql(
      `SELECT (SELECT count(*) FROM compliance_events) AS events,
              (SELECT coalesce(string_agg(s, ','), '') FROM (SELECT status || count(*) AS s FROM outbound_jobs GROUP BY status ORDER BY status) x) AS jobs,
              (SELECT coalesce(string_agg(s, ','), '') FROM (SELECT status || count(*) AS s FROM inbound_events GROUP BY status ORDER BY status) y) AS inbound,
              (SELECT count(*) FROM order_events) AS orders`,
    );
    const { sent } = await meta.get('/sent');
    return `${row.events}|${row.jobs}|${row.inbound}|${row.orders}|${sent.length}`;
  }

  /** Runs the worker until nothing more happens: every queue idle and nothing changed over the last two rounds. */
  async function settle({ ms = 8000, roundMs = 1200 } = {}) {
    const end = Date.now() + ms;
    let last = null;
    let same = 0;
    while (Date.now() < end) {
      await tick();
      const idleBy = Math.min(end, Date.now() + roundMs);
      while (Date.now() < idleBy && await pending()) await pause(15);
      await pause(10);
      const now = await signature();
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 2) return;
    }
  }

  /** Waits (running the worker) until `check` answers something, or `ms` pass. The last answer either way. */
  async function until(check, ms = 9000) {
    const end = Date.now() + ms;
    let value;
    for (;;) {
      await tick();
      value = await check();
      if (value || Date.now() > end) return value;
      await pause(60);
    }
  }

  /** Makes everything stored `ms` older, in every table that has a time. { sims: true } moves the simulators' clocks on by as much (their own rate windows). */
  async function travel(ms, { sims: moveSims = false } = {}) {
    const interval = `${Math.round(ms)} milliseconds`;
    await db.platform.tx(async (t) => {
      const columns = await t.query(`SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE' WHERE c.table_schema = 'public' AND c.data_type = 'timestamp with time zone'`);
      const byTable = new Map();
      for (const { table_name: table, column_name: column } of columns) {
        if (NEVER_SHIFTED.has(table)) continue;
        byTable.set(table, [...(byTable.get(table) ?? []), column]);
      }
      const names = [...byTable.keys()];
      const filled = names.length
        ? await t.query(names.map((name) => `SELECT '${name}' AS t WHERE EXISTS (SELECT 1 FROM "${name}")`).join(' UNION ALL '))
        : [];
      // A time that is part of a unique key (an hourly counter) would collide with its neighbour for a moment while every row moves,
      // so those go out of the way first and come back by the same step: the net move is the same for every row.
      const keyed = new Set((await t.query(`SELECT DISTINCT c.relname AS t, a.attname AS col FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey) WHERE i.indisunique AND a.atttypid = 'timestamptz'::regtype`)).map((r) => `${r.t}.${r.col}`));
      for (const { t: table } of filled) {
        const columns = byTable.get(table);
        const aside = columns.filter((c) => keyed.has(`${table}.${c}`));
        await t.exec(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
        if (aside.length) await t.exec(`UPDATE "${table}" SET ${aside.map((c) => `"${c}" = "${c}" - interval '1000 years'`).join(', ')}`);
        await t.exec(`UPDATE "${table}" SET ${columns.map((c) => (aside.includes(c) ? `"${c}" = "${c}" + interval '1000 years' - interval '${interval}'` : `"${c}" = "${c}" - interval '${interval}'`)).join(', ')}`);
        await t.exec(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      }
    });
    if (moveSims) for (const sim of Object.values(sims)) await sim.post('/clock', { advanceMs: ms });
  }

  let closed = false;
  const world = {
    db, platform, config, base, port, sims, ctx: app.locals.ctx, secrets, ig, sql, hit, tick, settle, until, travel, pause, appSecret, verifyToken,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(workers.map((w) => w.drivers.queue.close()));
      await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
      await webDrivers.queue.close();
      for (const sim of Object.values(sims)) await sim.close();
    },
  };
  return world;
}

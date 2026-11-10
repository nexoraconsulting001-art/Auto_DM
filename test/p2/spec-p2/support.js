// Shared by the Phase 2 spec tests. They are written from the PRD and the contract only, and look at the product from the
// outside: HTTP, the tables in migrations 200 to 206, the simulators' records and the browser.
//
// Time. Three clocks matter and none can be frozen on every database:
//   the simulators'   POST /__sim/clock. world.travel(ms, { sim: true }) moves it forward.
//   what is stored    world.travel(ms) makes every stored time and day ms older, so "time passes" for the database's now().
//   the app's Date    atClock(when) shifts Date for this process. Only ever to a moment in the past, so jobs queued "now" are still due.
// A "just outside" case sits a second past its edge, because the seconds a test takes only push it further out. A "just
// inside" case keeps INSIDE_MS in hand so the time the worker takes can't carry it over the edge.
//
// Every shop lives in UTC unless a test says otherwise, so a day here is the simulator's day, whatever the hour the suite runs.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { after, before } from 'node:test';
import { config as baseConfig } from '../../../src/config.js';
import { ROLLUP_STORES, TRAFFIC_PATHS, VISITOR_COOKIE } from '../../../src/contracts/analytics.js';
import { createInstagram } from '../../../src/instagram.js';
import { createAnalytics } from '../../../src/platform/analytics.js';
import { createPlatform } from '../../../src/platform/index.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { createRepos } from '../../../src/repos/index.js';
import { createApp } from '../../../src/server.js';
import { tenantId, withTenant } from '../../../src/tenancy.js';
import { registerJobs } from '../../../src/worker.js';
import { createGoogle } from '../../../tools/sim/google/index.mjs';
import { DEFAULT_SCOPES, createMeta, hubSignature } from '../../../tools/sim/meta/index.mjs';
import { TEST_DATA_KEY, openTestDb } from '../../helpers.js';
import { addStaff as p0AddStaff, api, hit, need, nextPhone, pause, signIn } from '../../p0/spec-p0/support.js';
import { DAY, HOUR, MINUTE, SECOND, addShop, unique } from '../../p1/spec-p1/support.js';

export { DAY, HOUR, MINUTE, SECOND, addShop, unique, consoleUser, onConsole, hit, need, api, signIn, signInCookie, pause, nextPhone, captureLogs, assertNoPlatformText } from '../../p1/spec-p1/support.js';
export { noPlatformName, assertAttemptLogged, requestId, multipart } from '../../p0/spec-p0/support.js';
export { DEFAULT_SCOPES };
export { ANALYTICS_LIMITS, EXPLORE_METRICS, FIGURE_TEXT, REPORTING_BASE_PATH, REPORT_FILE_PATH, SOURCE_LABELS, TAG_HOSTS, TRAFFIC_PATHS, VISITOR_COOKIE } from '../../../src/contracts/analytics.js';

export const INSIDE_MS = 30 * SECOND;
export const OUTSIDE_MS = SECOND;

const APP_SECRET = 'spec-p2-app-secret';
const FB_APP_SECRET = 'spec-p2-fb-secret';
const VERIFY_TOKEN = 'spec-p2-verify';
const NEUTRAL = 'shops.example';
const IG_APP_ID = 'sim-app';
const FB_APP_ID = 'sim-fb-app';
const ALL_FIELDS = ['comments', 'messages', 'messaging_postbacks', 'mentions', 'messaging_seen'];

// ---- user agents ----

export const UA = Object.freeze({
  phone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  instagram: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240305.019; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36 Instagram 320.0.0.42.101 Android (34/14; 420dpi; 1080x2400; Google; Pixel 8; shiba; shiba; en_GB; 567067337)',
  facebook: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.33.109;]',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  whatsappCrawler: 'WhatsApp/2.23.20.0 A',
  facebookCrawler: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  googleBot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  telegramCrawler: 'TelegramBot (like TwitterBot)',
});

// ---- days and the clock ----

const RealDate = Date;
let clockShift = 0;

class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + clockShift);
    else super(...args);
  }
  static now() {
    return RealDate.now() + clockShift;
  }
  static [Symbol.hasInstance](value) {
    return value instanceof RealDate;
  }
}

/** Sets the app's Date to `whenMs`, still ticking. Returns the function that puts it back. Only ever into the past. */
export function atClock(whenMs) {
  assert.ok(whenMs <= RealDate.now(), 'atClock only goes to a moment already past: jobs queued "now" would otherwise never be due');
  globalThis.Date = ShiftedDate;
  clockShift = whenMs - RealDate.now();
  return () => {
    clockShift = 0;
    globalThis.Date = RealDate;
  };
}

const IST = 5.5 * HOUR;

/** The most recent moment, at least a minute ago, that is this weekday and time of day at this UTC offset. */
export function lastWeekdayAt({ weekday, hour, minute = 0, second = 0, offsetMs = IST }) {
  const cutoff = RealDate.now() - MINUTE;
  const local = new RealDate(cutoff + offsetMs);
  let at = RealDate.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, second) - offsetMs;
  while (at > cutoff || new RealDate(at + offsetMs).getUTCDay() !== weekday) at -= DAY;
  return at;
}

/** The most recent 1st of a month, at least a minute ago, at this time of day and UTC offset. */
export function lastFirstOfMonthAt({ hour, minute = 0, second = 0, offsetMs = IST }) {
  const cutoff = RealDate.now() - MINUTE;
  const local = new RealDate(cutoff + offsetMs);
  let month = local.getUTCMonth();
  let year = local.getUTCFullYear();
  let at = RealDate.UTC(year, month, 1, hour, minute, second) - offsetMs;
  if (at > cutoff) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    at = RealDate.UTC(year, month, 1, hour, minute, second) - offsetMs;
  }
  return at;
}

export const isoDay = (ms) => new RealDate(ms).toISOString().slice(0, 10);
export const dayAgo = (n) => isoDay(RealDate.now() - n * DAY);
export const addDays = (day, n) => isoDay(RealDate.parse(`${day}T00:00:00Z`) + n * DAY);
export const nowIso = () => new RealDate().toISOString();

/** A test that crosses midnight would see "today" change under it. Wait that out rather than be flaky. */
export async function awayFromMidnight(marginMs = 20 * SECOND) {
  for (const offset of [0, IST]) {
    const left = DAY - ((RealDate.now() + offset) % DAY);
    if (left < marginMs) await pause(left + 1000);
  }
}

// ---- a world: the app, its worker, its database, Meta and Google ----

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** Stands in for shopper consent (PRD 9.18), which is built in Phase 4. Says what a test tells it, and nothing until then. */
function consentDouble() {
  let answer = () => ({ granted: false, answered: false, reason: 'spec.unanswered' });
  return {
    built: false,
    grant() { answer = () => ({ granted: true, answered: true, reason: 'spec.accepted' }); },
    decline() { answer = () => ({ granted: false, answered: true, reason: 'spec.declined' }); },
    unanswered() { answer = () => ({ granted: false, answered: false, reason: 'spec.unanswered' }); },
    set(fn) { answer = fn; },
    async analyticsAndAds(who) {
      tenantId();
      return answer(who ?? {});
    },
  };
}

// The app has no one name for its clock, so anything that takes one takes this. It reads Date when called, so atClock() reaches it.
const liveClock = () => Date.now();
const CLOCK_KEYS = ['complianceNow', 'analyticsNow', 'insightsNow', 'reachGuardNow', 'reportsNow', 'trafficNow', 'tagsNow'];

const CLOCK_TABLES = [
  'inbound_events', 'inbound_unrouted', 'outbound_jobs', 'inbox_threads', 'inbox_messages', 'needs_human_items', 'cap_claims', 'opt_outs', 'breakers', 'account_rate_state', 'send_budgets', 'ig_accounts', 'fb_pages', 'automations', 'automation_triggers', 'message_templates', 'template_variants', 'tester_codes', 'testers', 'token_alerts', 'link_taps', 'link_checks', 'measurement_ids', 'jobs', 'compliance_settings', 'alerts', 'data_deletion_requests', 'fb_post_links', 'platform_switches', 'tenant_words', 'events', 'compliance_events', 'audit_log', 'orders', 'visits',
  'analytics_accounts', 'insight_daily', 'insight_demographics', 'insight_online_followers', 'insight_media', 'insight_snapshots', 'insight_polls', 'insight_settings',
  'traffic_visitors', 'traffic_sessions', 'traffic_events', 'traffic_previews', 'traffic_daily', 'traffic_items_daily', 'funnel_daily', 'meta_account_daily', 'meta_content_daily', 'funnel_events',
  'destination_connections', 'destination_uploads', 'destination_figures', 'reach_guard_state', 'reach_guard_baselines', 'reach_guard_trips', 'account_health', 'account_health_history', 'meta_call_stats',
  'saved_views', 'saved_view_pins', 'custom_funnels', 'report_downloads', 'scheduled_reports', 'scheduled_report_recipients', 'report_runs', 'report_deliveries', 'report_preferences', 'reporting_api_keys',
  'tag_settings', 'tag_outbox', 'tag_health_daily',
];
const INSERT_ONLY = new Set(['compliance_events', 'audit_log']);

export async function openP2World({ overrides = {}, defaultTenant = '' } = {}) {
  const meta = createMeta({ app: { id: IG_APP_ID, secret: APP_SECRET, verifyToken: VERIFY_TOKEN }, facebookApp: { id: FB_APP_ID, secret: FB_APP_SECRET } });
  await meta.start();
  const google = createGoogle();
  await google.start();
  const rawDb = await openTestDb();
  const secrets = createSecrets({ dataKey: TEST_DATA_KEY });
  const platform = createRepos(rawDb, { secrets });
  const consent = consentDouble();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config = {
    ...baseConfig,
    ...Object.fromEntries(CLOCK_KEYS.map((key) => [key, liveClock])),
    storageDriver: 'memory',
    queueDriver: 'pg',
    analyticsDriver: 'pg',
    cacheDriver: 'memory',
    queuePollMs: 15,
    defaultTenant,
    platformDomain: NEUTRAL,
    platformHost: '',
    publicBaseUrl: '',
    adminUi: 'console',
    adminPhone: '',
    adminPassword: '',
    sessionSecret: 'spec-p2-session-secret',
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    igAppId: IG_APP_ID,
    fbAppId: FB_APP_ID,
    fbAppSecret: FB_APP_SECRET,
    graphBaseUrl: meta.url,
    igApiBaseUrl: '',
    igDialogBaseUrl: '',
    fbGraphBaseUrl: '',
    fbDialogBaseUrl: '',
    ga4BaseUrl: google.url,
    metaCallbackBaseUrl: base,
    metaTimeoutMs: 1500,
    insightsBackfillPerRun: 2, // the Meta data these tests set up is at most 4 days old, and reading 33 days takes the worker about 25 seconds on PGlite
    metaLogin: 'instagram',
    facebookPages: true,
    readReceipts: true,
    dataKey: TEST_DATA_KEY,
    dryRun: false,
    oneDmPerUser: false,
    backupStorageDriver: '',
    linkCheckFetch: async () => new Response('', { status: 200 }),
    geoTable: { '203.0.113.10': { city: 'Pune', state: 'Maharashtra' }, '203.0.113.11': { city: 'Mumbai', state: 'Maharashtra' }, '203.0.113.12': { city: 'Delhi', state: 'Delhi' } },
    ...overrides,
  };
  const ig = createInstagram(config);
  const webDrivers = { ...createPlatform(config, { db: rawDb }), consent };
  const app = createApp({ db: rawDb, ig, config, platform: webDrivers });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  await meta.post('/app', { webhookUrl: `${base}/webhook`, deauthorizeUrl: `${base}/meta/deauthorize`, deletionUrl: `${base}/meta/deletion` });

  const gate = { open: true, waiters: [] };
  const workers = [];
  function addWorker() {
    const drivers = { ...createPlatform(config, { db: rawDb }), consent };
    const queue = {
      ...drivers.queue,
      work: (name, handler, options) => drivers.queue.work(name, async (job) => {
        while (!gate.open) await new Promise((resolve) => gate.waiters.push(resolve));
        return handler(job);
      }, options),
    };
    workers.push({ drivers, schedule: registerJobs({ db: rawDb, platform: { ...drivers, queue }, config, ig }) });
  }
  addWorker();

  const clearPeriodicMarks = () => rawDb.platform.query(`DELETE FROM jobs WHERE dedupe_key LIKE 'every:%' AND status NOT IN ('queued', 'running')`);

  /** Runs every periodic job now, whatever its interval. */
  async function tick() {
    if (!gate.open) return;
    await clearPeriodicMarks();
    for (const w of workers) await w.schedule();
  }

  /** Every worker's schedule at the same moment, for races. */
  async function tickTogether() {
    if (!gate.open) return;
    await clearPeriodicMarks();
    await Promise.all(workers.map((w) => w.schedule()));
  }

  async function pendingCount(id) {
    const own = id ? 'AND tenant_id = $1' : '';
    const [{ n }] = await rawDb.platform.query(
      `SELECT (SELECT count(*) FROM inbound_events WHERE status IN ('stored', 'processing') ${own})
            + (SELECT count(*) FROM outbound_jobs WHERE (status = 'sending' OR (status = 'queued' AND run_at <= now())) ${own})
            + (SELECT count(*) FROM jobs WHERE (status = 'running' OR (status = 'queued' AND run_at <= now())) ${id ? 'AND (tenant_id = $1 OR tenant_id IS NULL)' : ''})
            + (SELECT count(*) FROM insight_polls WHERE stopped_at IS NULL AND next_due_at <= now() AND (lease_until IS NULL OR lease_until <= now()) AND last_started_at IS NOT NULL AND last_started_at > coalesce(last_finished_at, '-infinity') ${own}) AS n`,
      id ? [id] : [],
    );
    return Number(n);
  }

  const P2_COUNTED = ['compliance_events', 'funnel_events', 'insight_daily', 'insight_media', 'insight_snapshots', 'report_runs', 'report_deliveries', 'report_downloads', 'reach_guard_trips', 'tag_outbox', 'account_health_history', 'traffic_sessions', 'traffic_daily', 'funnel_daily', 'alerts'];

  async function signature(id) {
    const own = id ? 'WHERE tenant_id = $1' : '';
    const params = id ? [id] : [];
    const counts = P2_COUNTED.map((table) => `(SELECT count(*) FROM ${table} ${own}) AS ${table}`).join(', ');
    const [row] = await rawDb.platform.query(
      `SELECT ${counts},
              (SELECT coalesce(string_agg(s, ','), '') FROM (SELECT status || count(*) AS s FROM outbound_jobs ${own} GROUP BY status ORDER BY status) x) AS jobs,
              (SELECT coalesce(string_agg(s, ','), '') FROM (SELECT status || count(*) AS s FROM inbound_events ${own} GROUP BY status ORDER BY status) y) AS inbound,
              (SELECT coalesce(max(last_finished_at)::text, '') FROM insight_polls ${own}) AS polled,
              (SELECT coalesce(max(evaluated_at)::text, '') FROM reach_guard_state ${own}) AS evaluated,
              (SELECT coalesce(sum(attempts), 0)::text FROM tag_outbox ${own}) AS tag_attempts`,
      params,
    );
    const { sent } = await meta.get('/sent');
    return `${JSON.stringify(row)}|${sent.length}|${(await meta.calls({})).length}`;
  }

  /** Runs the worker until nothing more happens: every queue idle, and nothing has changed over the last rounds. */
  async function settle({ tenantId: id, ms = 10_000, roundMs = 1000 } = {}) {
    if (!gate.open) return;
    const end = RealDate.now() + ms;
    let last = null;
    let same = 0;
    while (RealDate.now() < end) {
      await tick();
      const idleBy = Math.min(end, RealDate.now() + roundMs);
      while (RealDate.now() < idleBy && await pendingCount(id)) await pause(15);
      await pause(10);
      const now = await signature(id);
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 2) return;
    }
  }

  /** Makes everything already stored `ms` older, days included. `sim` also moves the simulator's clock, for what Meta itself enforces. */
  async function travel(ms, { sim = false } = {}) {
    const interval = `${Math.round(ms)} milliseconds`;
    const days = Math.floor(ms / DAY);
    await rawDb.platform.tx(async (t) => {
      const columns = await t.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND data_type IN ('timestamp with time zone', 'date') AND table_name = ANY($1)`,
        [CLOCK_TABLES],
      );
      const byTable = new Map();
      for (const c of columns) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c]);
      for (const [table, list] of byTable) {
        const stampColumns = list.filter((c) => c.data_type !== 'date').map((c) => c.column_name);
        const stamps = stampColumns.map((c) => `"${c}" = "${c}" - interval '${interval}' - interval '100000 days'`);
        const dates = days ? list.filter((c) => c.data_type === 'date').map((c) => c.column_name) : [];
        if (INSERT_ONLY.has(table)) await t.exec(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
        // Two steps, so a day or hour column in a unique key can't collide with the row ahead of it.
        const first = [...stamps, ...dates.map((c) => `"${c}" = "${c}" - ${days + 100000}`)];
        if (first.length) await t.exec(`UPDATE "${table}" SET ${first.join(', ')}`);
        const back = [...stampColumns.map((c) => `"${c}" = "${c}" + interval '100000 days'`), ...dates.map((c) => `"${c}" = "${c}" + 100000`)];
        if (back.length) await t.exec(`UPDATE "${table}" SET ${back.join(', ')}`);
        if (INSERT_ONLY.has(table)) await t.exec(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      }
    });
    if (sim) await meta.post('/clock', { advanceMs: ms });
  }

  function webhook(payload, { secret = APP_SECRET, headers = {} } = {}) {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return hit(world, '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': hubSignature(raw, secret), ...headers }, body: raw });
  }

  const fanId = (base) => String(base + BigInt(crypto.randomInt(1_000_000_000)));
  let closed = false;
  const world = {
    meta, google, consent, db: rawDb, rawDb, platform, config, ig, base, port, secrets, server, gate,
    rollups: createAnalytics({ analyticsDriver: 'pg' }, { db: rawDb }).rollups,
    tick, tickTogether, settle, travel, webhook, addWorker,
    stopWorker() { gate.open = false; },
    startWorker() {
      gate.open = true;
      gate.waiters.splice(0).forEach((resolve) => resolve());
    },
    fan: (label = 'fan') => ({ id: fanId(9_100_000_000_000_000n), username: `${label}_${unique()}_handle` }),
    async close() {
      if (closed) return;
      closed = true;
      world.startWorker();
      await Promise.all(workers.map((w) => w.drivers.queue.close()));
      await new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      });
      await webDrivers.queue.close();
      await google.close();
      await meta.close();
      await rawDb.close();
    },
  };
  return world;
}

/** One world per test file, opened before its first test. Each test makes its own businesses in it. */
export function useP2World(options) {
  let current;
  before(async () => { current = await openP2World(options); });
  after(async () => { await current?.close(); });
  return new Proxy({}, { get: (_, key) => current?.[key] });
}

// ---- reading what the API answers ----

export const qs = (query = {}) => {
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

/** Fails if `value` holds anything the contract says never leaves the server. */
export function assertNoImpressions(value, where) {
  assert.doesNotMatch(JSON.stringify(value).replaceAll('historicImpressions', ''), /impressions/i, `${where} mentions impressions`);
}

/** A rate may come back as 0.45 or 45. */
export const percent = (rate) => (rate > 1 ? rate : rate * 100);
export function assertRate(rate, expected, what = 'The rate') {
  assert.equal(typeof rate, 'number', `${what}: expected a number, got ${rate}`);
  assert.ok(Math.abs(percent(rate) - expected) < 0.6, `${what}: expected about ${expected}%, got ${rate}`);
}

/** A list row's "value or nothing", checked to be a real absence. */
export function assertNoFigure(value, what) {
  assert.ok(value === null || value === undefined, `${what}: expected no figure, got ${value}`);
}

export const stepOf = (funnel, stage) => {
  const step = funnel.steps.find((s) => s.stage === stage);
  assert.ok(step, `The funnel has no ${stage} step: ${JSON.stringify(funnel.steps.map((s) => s.stage))}`);
  return step;
};

/** A CSV as rows of cells, quotes understood. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---- a business ----

/** A business with Instagram connected, in UTC unless told otherwise, and the helpers the Phase 2 tests share. */
export async function addP2Shop(world, { timeZone = 'UTC', followers = 5000, scopes = [...DEFAULT_SCOPES], igConnected = true, plan = 't3', subscribe = true, slug, name, igUserId } = {}) {
  await awayFromMidnight();
  await world.meta.post('/clock', { now: RealDate.now() }); // a test before this one may have moved Meta's clock on
  // The tenant lookup caches a business for a minute, so a time zone set afterwards would be missed. This one is in place when the row is created.
  await world.rawDb.platform.exec(`ALTER TABLE tenants ALTER COLUMN timezone SET DEFAULT '${timeZone.replace(/'/g, '')}'`);
  const shop = await addShop(world, { plan, igConnected: false, slug, name, ...(igUserId ? { igUserId } : {}) });
  const { tenantId: id, sql } = shop;

  if (igConnected) {
    const { token } = await world.meta.post('/accounts', { igUserId: shop.igUserId, username: `${shop.slug}_ig`, subscribedFields: subscribe ? ALL_FIELDS : [], appRole: true, scopes, followersCount: followers });
    shop.igToken = token;
    await world.platform.tenants.linkIgAccount(id, shop.igUserId, `${shop.slug}_ig`);
    await shop.repos.igAccounts.setToken(shop.igUserId, token);
    await sql(
      `UPDATE ig_accounts SET status = 'active', granted_scopes = $3, subscribed_fields = $4, subscribed_at = now(), token_version = 1, token_issued_at = now() - interval '2 days',
         token_expires_at = now() + interval '50 days', next_refresh_at = now() + interval '30 days', connected_at = now() WHERE tenant_id = $1 AND ig_user_id = $2`,
      [id, shop.igUserId, scopes, subscribe ? ALL_FIELDS : []],
    );
  }

  const inside = (fn) => withTenant(shop.tenant, fn);
  const feedPost = shop.post;

  Object.assign(shop, {
    timeZone,
    inside,
    /** The Phase 1 helper that makes a feed post on Instagram: `post` below is the HTTP verb. */
    feedPost,
    as: (token, path, options = {}) => api(world, shop, token, path, options),

    /** GET that must answer 200, as JSON. */
    get: async (path, query, what) => need(await shop.api(`${path}${qs(query)}`), 200, what ?? `GET ${path}`).json(),
    /** The raw answer. */
    raw: (path, query, options = {}) => shop.api(`${path}${qs(query)}`, options),
    post: async (path, body, status = 200, what) => need(await shop.api(path, { method: 'POST', body: body ?? {} }), status, what ?? `POST ${path}`).json(),
    patch: async (path, body, status = 200, what) => need(await shop.api(path, { method: 'PATCH', body }), status, what ?? `PATCH ${path}`).json(),

    /** Who this business is to Meta in the cache. The worker makes the row; a test that only reads makes it itself if the worker hasn't. */
    async accountRef() {
      const find = async () => (await sql(`SELECT id FROM analytics_accounts WHERE tenant_id = $1 AND ig_user_id = $2`, [id, shop.igUserId]))[0]?.id;
      let ref = await find();
      if (!ref) { await shop.settle({ ms: 1500, roundMs: 200 }); ref = await find(); }
      if (!ref) ref = (await sql(`INSERT INTO analytics_accounts (tenant_id, channel, ig_user_id, collecting_since) VALUES ($1, 'instagram', $2, $3) ON CONFLICT (tenant_id, channel, account_id) DO UPDATE SET collecting_since = EXCLUDED.collecting_since RETURNING id`, [id, shop.igUserId, dayAgo(200)]))[0].id;
      return ref;
    },

    async setCollectingSince(day) {
      await shop.accountRef();
      await sql(`UPDATE analytics_accounts SET collecting_since = $3 WHERE tenant_id = $1 AND ig_user_id = $2`, [id, shop.igUserId, day]);
    },

    /** Makes every poll of this business due now, and runs the worker until it has been through them. */
    async poll({ jobs, rounds = 4 } = {}) {
      await shop.settle({ ms: 3000, roundMs: 300 });
      // One worker run covers every business that is due, so earlier tests' backfills wait, and this poll is about this business.
      await world.rawDb.platform.query(`UPDATE insight_polls SET next_due_at = now() + interval '1 hour' WHERE tenant_id <> $1 AND stopped_at IS NULL AND next_due_at <= now() + interval '1 minute'`, [id]);
      let known = (await shop.polls()).length;
      for (let i = 0; i < rounds; i++) {
        const due = await sql(
          `UPDATE insight_polls SET next_due_at = now() - interval '1 second', lease_until = NULL, locked_by = NULL WHERE tenant_id = $1 AND stopped_at IS NULL ${jobs ? 'AND job = ANY($2)' : ''} RETURNING id, now() AS at`,
          jobs ? [id, jobs] : [id],
        );
        if (!due.length && i > 0) break;
        await shop.settle({ ms: 5000, roundMs: 300 });
        const stopAt = RealDate.now() + 45_000;
        while (RealDate.now() < stopAt && due.length) {
          const [{ n }] = await sql(`SELECT count(*)::int AS n FROM insight_polls WHERE id = ANY($1) AND stopped_at IS NULL AND coalesce(last_finished_at, '-infinity') < $2 AND (next_due_at <= now() OR lease_until > now())`, [due.map((p) => p.id), due[0].at]);
          if (!n) break;
          await world.tick();
          await pause(100);
        }
        const count = (await shop.polls()).length;
        if (due.length && (jobs || count === known)) break; // named jobs have run, or nothing new appeared for another round to read
        known = count;
      }
    },

    /** Runs only what is due by the schedule itself. */
    runDue: () => shop.settle({ ms: 5000, roundMs: 300 }),

    polls: (where = 'true', params = []) => sql(`SELECT * FROM insight_polls WHERE tenant_id = $1 AND (${where}) ORDER BY id`, [id, ...params]),

    /** The calls Meta received for this business's account or media, by path pattern. */
    async metaCalls(path = '*/insights') {
      const calls = await world.meta.calls({ path });
      return calls.filter((c) => (c.headers?.authorization ?? '').includes(shop.igToken) || c.query?.access_token === shop.igToken);
    },
    clearMetaCalls: () => world.meta.delete('/calls'),

    /** One metric's daily figures, in the cache and in the simulator (so a re-fetch of a recent day finds the same number). points: { daysAgo: value }. */
    async seedDays(metric, points, { sim = true, rollupColumn = metric } = {}) {
      const ref = await shop.accountRef();
      for (const [back, value] of Object.entries(points)) {
        const day = dayAgo(Number(back));
        await sql(
          `INSERT INTO insight_daily (tenant_id, account_ref, day, metric, value, fetched_at) VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (tenant_id, account_ref, day, metric, breakdown, breakdown_value) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`,
          [id, ref, day, metric, value],
        );
        if (rollupColumn) {
          // A rollup write replaces the whole row, so what the day already holds is carried over.
          const [existing] = await sql(`SELECT * FROM meta_account_daily WHERE tenant_id = $1 AND day = $2`, [id, day]);
          const kept = existing ? Object.fromEntries(ROLLUP_STORES.meta_account_daily.columns.filter((c) => existing[c] !== null && existing[c] !== undefined).map((c) => [c, Number(existing[c])])) : {};
          await inside(() => world.rollups.write('meta_account_daily', [{ day, account_id: shop.igUserId, ...kept, [rollupColumn]: value }]));
        }
      }
      if (sim && world.meta) await world.meta.post('/insights/daily', { igUserId: shop.igUserId, metric, points: Object.entries(points).map(([back, value]) => ({ day: dayAgo(Number(back)), value })) });
      await sql(`UPDATE analytics_accounts SET last_refresh_at = now() WHERE tenant_id = $1 AND ig_user_id = $2`, [id, shop.igUserId]);
    },

    /** A post in the cache, with its snapshots. snapshots: [{ ageMinutes, metrics }]. */
    async seedMedia({ mediaId = `m${unique()}`, kind = 'reel', postedAgoMs = 3 * DAY, latest = {}, caption = 'A post', snapshots = [], deletedAt = null, historicImpressions = null, belowThreshold = false, storyFinalState = 'open', storyTracking = 'edge' } = {}) {
      const ref = await shop.accountRef();
      const [row] = await sql(
        `INSERT INTO insight_media (tenant_id, account_ref, media_id, kind, caption, permalink, thumbnail_url, posted_at, deleted_at, latest, latest_at, historic_impressions, below_threshold, story_final_state, story_tracking)
         VALUES ($1, $2, $3, $4, $5, 'https://www.instagram.com/p/x/', 'https://media.invalid/x.jpg', now() - ($6::bigint * interval '1 millisecond'), $7, $8::jsonb, now(), $9, $10, $11, $12) RETURNING id`,
        [id, ref, mediaId, kind, caption, Math.round(postedAgoMs), deletedAt, JSON.stringify(latest), historicImpressions, belowThreshold, storyFinalState, storyTracking],
      );
      for (const snap of snapshots) {
        await sql(
          `INSERT INTO insight_snapshots (tenant_id, media_ref, slot, captured_at, age_minutes, metrics) VALUES ($1, $2, now() - ($3::bigint * interval '1 millisecond'), now() - ($3::bigint * interval '1 millisecond'), $4, $5::jsonb)`,
          [id, row.id, Math.round(postedAgoMs - snap.ageMinutes * MINUTE), snap.ageMinutes, JSON.stringify(snap.metrics)],
        );
      }
      return { mediaId, ref: row.id };
    },

    /** Sessions in the rollups, one row each, plus the daily rollup that sums them. list: [{ count, day?, source, device, city, ...counters }]. */
    async seedSessions(list) {
      const sessions = [];
      const daily = new Map();
      const DIMS = ['source', 'referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'media_id', 'landing_page', 'device', 'os', 'browser', 'in_app', 'city', 'state', 'visitor_type'];
      const COUNTERS = ['page_views', 'landing_views', 'category_views', 'product_views', 'product_taps', 'outbound_taps', 'whatsapp_taps', 'add_to_cart', 'checkout_started', 'payment_success', 'orders', 'revenue_paise'];
      for (const { count = 1, day = dayAgo(1), hour = 10, weekday = 1, bounced = 0, engaged_ms: engagedMs = 1000, ...rest } of list) {
        for (let i = 0; i < count; i++) sessions.push({ session_id: crypto.randomUUID(), day, hour, weekday, started_at: new RealDate(), last_hit_at: new RealDate(), bounced, engaged_ms: engagedMs, ...rest });
        const dims = Object.fromEntries(DIMS.map((d) => [d, rest[d] ?? '']));
        const key = JSON.stringify([day, hour, weekday, dims]);
        const row = daily.get(key) ?? { day, hour, weekday, ...dims, sessions: 0, bounces: 0, ...Object.fromEntries(COUNTERS.map((c) => [c, 0])) };
        row.sessions += count;
        row.bounces += count * bounced;
        for (const c of COUNTERS) row[c] += count * (rest[c] ?? 0);
        daily.set(key, row);
      }
      await inside(async () => {
        await world.rollups.write('traffic_sessions', sessions);
        await world.rollups.write('traffic_daily', [...daily.values()]);
      });
    },

    /** Rows of the Bhava funnel for one piece of content. kinds: { comments: 40, dms: 38, ... }. */
    async seedFunnel(mediaId, { comments = 0, dms = 0, seen = 0, taps = 0, sales = [], origin = 'two_tap', label = 'bhava', day = 0, linkType = 'bhava_page', linkMode = 'two_tap', contentKind = 'reel' } = {}) {
      const occurred = new RealDate(RealDate.now() - day * DAY - MINUTE);
      const person = (n) => crypto.createHash('sha256').update(`person-${mediaId}-${n}`).digest('hex');
      const rows = [];
      const add = (stage, n, rowOrigin, rowLabel, amount = 0, key = '') => rows.push([stage, rowOrigin, rowLabel, n < 0 ? '' : person(n), amount, `${stage}:${key || n}:${mediaId}`]);
      for (let i = 0; i < comments; i++) add('comments', i, 'automation', 'bhava');
      for (let i = 0; i < dms; i++) add('dms', i, 'automation', 'bhava');
      for (let i = 0; i < seen; i++) add('seen', i, 'automation', 'bhava');
      for (let i = 0; i < taps; i++) add('taps_or_visits', i, origin, label);
      sales.forEach((sale, i) => add('sales', -1, sale.origin ?? 'bhava_store', sale.label ?? 'bhava', sale.amountPaise ?? 0, `s${i}`));
      for (const [stage, rowOrigin, rowLabel, hash, amount, key] of rows) {
        await sql(
          `INSERT INTO funnel_events (tenant_id, channel, media_id, content_kind, stage, origin, source_label, subject_hash, amount_paise, dedupe_key, occurred_at)
           VALUES ($1, 'instagram', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, mediaId, contentKind, stage, rowOrigin, rowLabel, hash, amount, key, occurred],
        );
      }
      const sum = new Map();
      for (const [stage, rowOrigin, rowLabel, , amount] of rows) {
        const k = `${rowOrigin}|${rowLabel}`;
        const row = sum.get(k) ?? { day: isoDay(+occurred), channel: 'instagram', media_id: mediaId, content_kind: contentKind, link_type: linkType, link_mode: linkMode, origin: rowOrigin, source_label: rowLabel, comments: 0, dms_queued: 0, dms_sent: 0, dms_failed: 0, dms_paced: 0, seen: 0, taps: 0, visits: 0, orders: 0, revenue_paise: 0, earnings_paise: 0 };
        if (stage === 'comments') row.comments += 1;
        if (stage === 'dms') { row.dms_sent += 1; }
        if (stage === 'seen') row.seen += 1;
        if (stage === 'taps_or_visits') row.taps += 1;
        if (stage === 'sales') { row.orders += 1; row.revenue_paise += amount; }
        sum.set(k, row);
      }
      await inside(() => world.rollups.write('funnel_daily', [...sum.values()]));
    },

    /** A signed-in manager. */
    async addManager() {
      const who = { phone: nextPhone(), password: 'manager-pass-1' };
      await shop.repos.users.create({ name: 'Mira Manager', ...who, role: 'manager' });
      return { ...who, token: await signIn(world, shop, who) };
    },
    addStaff: (permissions = []) => p0AddStaff(world, shop, { permissions }),
    /** A signed-in shopper of this business, for the buyer routes. */
    async addCustomer() {
      const who = { phone: nextPhone(), password: 'customer-pass-1' };
      await shop.repos.users.create({ name: 'Asha K', ...who, role: 'customer' });
      return { ...who, token: await signIn(world, shop, who) };
    },
    /** Ids of what this business has stored as figures, for "another business can't see this". */
    tagRows: () => sql('SELECT * FROM tag_outbox WHERE tenant_id = $1 ORDER BY id', [id]),
    sessions: () => sql('SELECT * FROM traffic_sessions WHERE tenant_id = $1', [id]),
    trafficEvents: () => sql('SELECT * FROM traffic_events WHERE tenant_id = $1 ORDER BY id', [id]),
    previews: () => sql('SELECT * FROM traffic_previews WHERE tenant_id = $1', [id]),
    audit: (pattern) => sql('SELECT * FROM audit_log WHERE tenant_id = $1 AND action ~* $2 ORDER BY id', [id, pattern]),
    deliveries: (where = 'true', params = []) => sql(`SELECT * FROM report_deliveries WHERE tenant_id = $1 AND (${where}) ORDER BY id`, [id, ...params]),
    runs: (kind) => sql('SELECT * FROM report_runs WHERE tenant_id = $1 AND kind = $2 ORDER BY id', [id, kind]),
    health: () => shop.get('/account-health', undefined, 'Account Health'),
    guard: () => shop.get('/reach-guard', undefined, 'Reach Guard'),
    /** Reach Guard and Account Health look again, as many times as a schedule might. */
    evaluate: async () => {
      await shop.poll({ jobs: ['account_daily'] });
      await sql(`UPDATE reach_guard_state SET evaluated_at = NULL WHERE tenant_id = $1`, [id]);
      await shop.settle({ ms: 4000, roundMs: 300 });
    },
  });
  return shop;
}

/** The figures of one account metric, oldest day first. */
export function metricOf(account, name) {
  const found = account.metrics.find((m) => m.metric === name);
  assert.ok(found, `No metric "${name}" in the account insights: ${account.metrics.map((m) => m.metric).join(', ')}`);
  return { ...found, days: [...found.days].sort((a, b) => a.day.localeCompare(b.day)) };
}

/** Everything a shopper's browser does: opens pages, and reports them to the beacon if the page carries the script. */
export function shopper(world, shop, { ua = UA.phone, ip, cookies = true, vid, extraCookies = '' } = {}) {
  const jar = vid ? { [VISITOR_COOKIE]: vid } : {};
  const cookieHeader = () => [...Object.entries(jar).map(([k, v]) => `${k}=${v}`), extraCookies].filter(Boolean).join('; ');
  const headers = () => ({ 'user-agent': ua, ...(ip ? { 'x-forwarded-for': ip } : {}), ...(cookies && cookieHeader() ? { cookie: cookieHeader() } : {}) });
  const absorb = (res) => {
    if (!cookies) return;
    for (const line of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      jar[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
  };
  const self = {
    jar,
    ua,
    get visitorId() { return jar[VISITOR_COOKIE]; },
    /** One event, as the page's script would send it. */
    async beacon(event = {}) {
      const res = await hit(world, TRAFFIC_PATHS.event, { host: shop.host, method: 'POST', headers: headers(), body: { name: 'page_view', path: '/', ...event } });
      absorb(res);
      return res;
    },
    /** The same, and it must have been taken. */
    async send(event = {}) {
      return need(await self.beacon(event), [200, 201, 202, 204], `The beacon for ${event.name ?? 'page_view'}`);
    },
    /** Loads a buyer page. If it carries the script, a real browser would run it and report the page. */
    async open(path, { beacon = {}, runScript = true, ...options } = {}) {
      const res = await hit(world, path, { host: shop.host, headers: headers(), ...options });
      absorb(res);
      const tracked = res.text.includes(TRAFFIC_PATHS.script);
      if (tracked && runScript) await self.send({ name: 'page_view', path, ...beacon });
      return { res, tracked };
    },
  };
  return self;
}

/** An automation on a reel of this business, live, and the reel's id. An Amazon reel gets its tracking id first, as the builder requires. */
export async function liveReel(shop, { linkMode = 'two_tap', linkType = 'seller_site', linkUrl, amazonTag, ...rest } = {}) {
  const mediaId = rest.mediaId ?? await shop.reel();
  const urls = { amazon: 'https://www.amazon.in/dp/B0SPEC1234', whatsapp: 'https://wa.me/919876500000', affiliate: 'https://affiliate.example/p/1', bhava_page: `https://${shop.host}/p/lamp`, seller_site: shop.siteUrl('/p/1') };
  const tag = amazonTag ?? `shop${unique()}-21`;
  if (linkType === 'amazon') await shop.call('/measurement-ids', 201, { method: 'POST', body: { mediaId, kind: 'amazon_tag', value: tag } }, 'Saving the tracking id');
  if (linkType === 'whatsapp') await shop.repos.settings.update({ support_whatsapp: '919876500000' });
  const auto = await shop.automate({ ...rest, mediaId, linkMode, linkType, linkUrl: linkUrl ?? urls[linkType] });
  return { ...auto, amazonTag: tag };
}

/** Real people comment and take the DMs, through Meta's webhooks. Returns who commented. */
export async function comments(world, shop, mediaId, n) {
  const people = [];
  for (let i = 0; i < n; i++) {
    const from = world.fan();
    await shop.comment(mediaId, { from, text: 'price' });
    people.push(from);
  }
  return people;
}

/** Runs the worker until `n` DMs have gone out. Private replies are paced at about 10 a minute after a small burst (PRD 4.3), so a simulated minute passes each round. */
export async function waitForDms(shop, n, maxMinutes = 30) {
  for (let minute = 0; ; minute++) {
    await shop.settle({ ms: 3000, roundMs: 300 });
    const sent = await shop.dms();
    if (sent.length >= n || minute >= maxMinutes) return sent;
    await shop.world.travel(MINUTE);
  }
}

/** The postback a two-tap DM's button sends, for this person. */
export async function tapPayload(shop, person) {
  const [dm] = await shop.dms({ recipientId: person.id });
  return dm?.message?.attachment?.payload?.buttons?.[0]?.payload;
}

export async function waitForFile(world, shop, created, { tries = 40, token } = {}) {
  let current = created;
  for (let i = 0; i < tries && !['ready', 'failed', 'expired'].includes(current.status); i++) {
    await shop.settle({ ms: 2500, roundMs: 300 });
    current = need(await api(world, shop, token ?? shop.token, `/downloads/${created.id}`), 200, 'The download').json();
  }
  return current;
}

/** Fetches a report file the way a signed-in seller's browser would. */
export function fileAt(world, shop, fileUrl, { token = shop.token, cookie, headers = {} } = {}) {
  const url = new URL(fileUrl, world.base);
  return hit(world, `${url.pathname}${url.search}`, { host: shop.host, ...(token ? { token } : {}), ...(cookie ? { cookie } : {}), headers });
}

export const reportingKeyHeaders = (key) => ({ authorization: `Bearer ${key}`, 'x-api-key': key });

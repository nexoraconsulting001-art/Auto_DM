// Shared by the Phase 1 spec tests. They are written from the PRD and the contract only, and look at the product from
// the outside: HTTP, the database tables in the contract, and the Meta simulator's record of what it was sent.
//
// The clock. The app reads both Date.now() and the database's now(), and neither can be frozen from outside on every
// database, so "time passes" is done the other way round: travel(ms) makes everything already stored ms older. A "just
// outside" case sits a second past its edge, because the seconds a test takes only push it further out. A "just inside"
// case keeps INSIDE_MS in hand so the time the worker takes can't carry it over the edge.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before } from 'node:test';
import { config as baseConfig } from '../../../src/config.js';
import { platformRouteList, routeList } from '../../../src/contracts/api/index.js';
import { createInstagram } from '../../../src/instagram.js';
import { createPlatform } from '../../../src/platform/index.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { createRepos } from '../../../src/repos/index.js';
import { createApp } from '../../../src/server.js';
import { withTenant } from '../../../src/tenancy.js';
import { registerJobs } from '../../../src/worker.js';
import { DEFAULT_SCOPES, createMeta, hubSignature, signedRequest } from '../../../tools/sim/meta/index.mjs';
import { TEST_DATA_KEY, openTestDb } from '../../helpers.js';
import { NEUTRAL, addBusiness, api, hit, need, pause, signIn } from '../../p0/spec-p0/support.js';

export { COMPLIANCE_LIMITS, REASON_CODES } from '../../../src/contracts/compliance.js';
export { CONSOLE_HOST, NEUTRAL, addBusiness, addStaff, api, asAppRole, captureLogs, consoleUser, findAppRole, hit, need, nextPhone, onConsole, pause, signIn, signInCookie, waitFor } from '../../p0/spec-p0/support.js';
export { hubSignature, signedRequest };

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** How much of a window a "just inside" case keeps in hand. */
export const INSIDE_MS = 30 * SECOND;
/** How far past its edge a "just outside" case sits. */
export const OUTSIDE_MS = SECOND;
/** PRD 4.12: every worker applies every switch within 5 s. */
export const SWITCH_LAG_MS = 5_200;

export const APP_SECRET = 'spec-app-secret';
export const FB_APP_SECRET = 'spec-fb-app-secret';
export const VERIFY_TOKEN = 'spec-verify-token';
export const IG_APP_ID = 'sim-app';
export const FB_APP_ID = 'sim-fb-app';

export const SCOPES = Object.freeze({
  basic: 'instagram_business_basic',
  messages: 'instagram_business_manage_messages',
  comments: 'instagram_business_manage_comments',
  insights: 'instagram_business_manage_insights',
});

const ALL_FIELDS = ['comments', 'messages', 'messaging_postbacks', 'mentions'];
/** Every table whose stored times make up "now" for the engine. Sessions and logins stay out, so sign-ins survive travel. */
const CLOCK_TABLES = ['inbound_events', 'inbound_unrouted', 'outbound_jobs', 'inbox_threads', 'inbox_messages', 'needs_human_items', 'cap_claims', 'opt_outs', 'breakers', 'account_rate_state', 'send_budgets', 'ig_accounts', 'fb_pages', 'automations', 'automation_triggers', 'message_templates', 'template_variants', 'tester_codes', 'testers', 'token_alerts', 'link_taps', 'link_checks', 'measurement_ids', 'jobs', 'compliance_settings', 'alerts', 'data_deletion_requests', 'fb_post_links', 'platform_switches', 'tenant_words', 'events', 'compliance_events', 'audit_log'];
const INSERT_ONLY = new Set(['compliance_events', 'audit_log']);

let serial = 0;
export const unique = () => `${++serial}${crypto.randomBytes(2).toString('hex')}`;
const numericId = (base) => String(base + BigInt(++serial) * 1000n + BigInt(crypto.randomInt(999)));

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// ---- what a seller's website answers ----

/**
 * The contract has no way to give the link checker a fake internet, and net-guard refuses the real one. So a fetch() of a
 * registered address is answered here. A link checker that doesn't use global fetch needs a seam of its own.
 */
const sites = new Map();
let realFetch = null;

export function fakeSite(url, { status = 200, location, delayMs = 0 } = {}) {
  sites.set(url, { status, location, delayMs });
}

function installFakeInternet() {
  if (realFetch) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const site = sites.get(url);
    if (!site) return realFetch(input, init);
    if (site.delayMs) await pause(site.delayMs);
    const redirected = site.status >= 300 && site.status < 400;
    if (redirected && (init.redirect ?? 'follow') === 'follow' && site.location) return globalThis.fetch(site.location, init);
    return new Response(redirected || (init.method ?? 'GET') === 'HEAD' ? null : '<!doctype html><title>Shop</title>', { status: site.status, headers: site.location ? { location: site.location } : {} });
  };
}

// ---- a world: the app, its worker, its database and the Meta simulator ----

/** A proxy in front of the simulator, so a test can act at the moment a Graph call is in flight. */
async function startGraphProxy(targetPort) {
  const hooks = [];
  const server = http.createServer(async (rq, rs) => {
    const chunks = [];
    for await (const chunk of rq) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const hook = hooks.find((h) => h.pattern.test(rq.url));
    if (hook) {
      hooks.splice(hooks.indexOf(hook), 1);
      await hook.run();
    }
    const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: rq.method, path: rq.url, headers: { ...rq.headers, host: `127.0.0.1:${targetPort}` } }, (res) => {
      rs.writeHead(res.statusCode, res.headers);
      res.pipe(rs);
    });
    upstream.on('error', () => rs.destroy());
    upstream.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, hooks, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

/** A db handle that throws on any statement matching `pattern` while state.on is true, in or out of a transaction. */
export function failingDb(db, pattern, state) {
  const guard = (sql) => { if (state.on && pattern.test(sql)) throw new Error('disk full'); };
  const wrap = (h) => ({
    ...h,
    query: (sql, params) => { guard(sql); return h.query(sql, params); },
    exec: (sql) => { guard(sql); return h.exec(sql); },
    tx: (fn, ...rest) => h.tx((t) => fn(wrap(t)), ...rest),
  });
  return { ...wrap(db), platform: wrap(db.platform) };
}

export async function openWorld({ overrides = {}, worker = true, proxy = false, wrapDb, defaultTenant = '' } = {}) {
  installFakeInternet();
  const meta = createMeta({ app: { id: IG_APP_ID, secret: APP_SECRET, verifyToken: VERIFY_TOKEN }, facebookApp: { id: FB_APP_ID, secret: FB_APP_SECRET } });
  await meta.start();
  const graph = proxy ? await startGraphProxy(meta.port) : null;
  const rawDb = await openTestDb();
  const db = wrapDb ? wrapDb(rawDb) : rawDb;
  const secrets = createSecrets({ dataKey: TEST_DATA_KEY });
  const platform = createRepos(rawDb, { secrets });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config = {
    ...baseConfig,
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
    sessionSecret: 'spec-session-secret',
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    igAppId: IG_APP_ID,
    fbAppId: FB_APP_ID,
    fbAppSecret: FB_APP_SECRET,
    graphBaseUrl: graph?.url ?? meta.url,
    igApiBaseUrl: '',
    igDialogBaseUrl: '',
    fbGraphBaseUrl: '',
    fbDialogBaseUrl: '',
    metaCallbackBaseUrl: base,
    metaTimeoutMs: 1500,
    metaLogin: 'instagram',
    facebookPages: true,
    dataKey: TEST_DATA_KEY,
    dryRun: false,
    oneDmPerUser: false,
    backupStorageDriver: '',
    ...overrides,
  };
  const ig = createInstagram(config);
  const webDrivers = createPlatform(config, { db });
  const app = createApp({ db, ig, config, platform: webDrivers });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  await meta.post('/app', { webhookUrl: `${base}/webhook`, deauthorizeUrl: `${base}/meta/deauthorize`, deletionUrl: `${base}/meta/deletion` });

  const gate = { open: worker, waiters: [] };
  const workers = [];
  function addWorker() {
    const drivers = createPlatform(config, { db });
    const queue = {
      ...drivers.queue,
      work: (name, handler, options) => drivers.queue.work(name, async (job) => {
        while (!gate.open) await new Promise((resolve) => gate.waiters.push(resolve));
        return handler(job);
      }, options),
    };
    workers.push({ drivers, schedule: registerJobs({ db, platform: { ...drivers, queue }, config, ig }) });
  }
  addWorker();

  /** Runs every periodic job now, whatever its interval, by clearing the marks that say it already ran this interval. */
  async function tick() {
    if (!gate.open) return;
    await rawDb.platform.query(`DELETE FROM jobs WHERE dedupe_key LIKE 'every:%' AND status NOT IN ('queued', 'running')`);
    for (const w of workers) await w.schedule();
  }

  async function pendingCount(tenantId) {
    const own = tenantId ? 'AND tenant_id = $1' : '';
    const [{ n }] = await rawDb.platform.query(
      `SELECT (SELECT count(*) FROM inbound_events WHERE status IN ('stored', 'processing') ${own})
            + (SELECT count(*) FROM outbound_jobs WHERE (status = 'sending' OR (status = 'queued' AND run_at <= now())) ${own})
            + (SELECT count(*) FROM jobs WHERE (status = 'running' OR (status = 'queued' AND run_at <= now())) ${tenantId ? 'AND (tenant_id = $1 OR tenant_id IS NULL)' : ''}) AS n`,
      tenantId ? [tenantId] : [],
    );
    return Number(n);
  }

  async function signature(tenantId) {
    const own = tenantId ? 'WHERE tenant_id = $1' : '';
    const params = tenantId ? [tenantId] : [];
    const [row] = await rawDb.platform.query(
      `SELECT (SELECT count(*) FROM compliance_events ${own}) AS events,
              (SELECT coalesce(string_agg(s, ','), '') FROM (SELECT status || count(*) AS s FROM outbound_jobs ${own} GROUP BY status ORDER BY status) x) AS jobs,
              (SELECT coalesce(string_agg(s, ','), '') FROM (SELECT status || count(*) AS s FROM inbound_events ${own} GROUP BY status ORDER BY status) y) AS inbound`,
      params,
    );
    const { sent } = await meta.get('/sent');
    return `${row.events}|${row.jobs}|${row.inbound}|${sent.length}`;
  }

  /** Runs the worker until nothing more happens: every queue idle, and nothing has changed over the last rounds. */
  async function settle({ tenantId, ms = 8000, roundMs = 1200 } = {}) {
    if (!gate.open) return;
    const end = Date.now() + ms;
    let last = null;
    let same = 0;
    while (Date.now() < end) {
      await tick();
      const idleBy = Math.min(end, Date.now() + roundMs);
      while (Date.now() < idleBy && await pendingCount(tenantId)) await pause(15);
      await pause(10);
      const now = await signature(tenantId);
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 2) return;
    }
  }

  /** PRD 4.12 lets a worker keep using a switch's old value for 5 s. Wait that out after changing one. */
  const switchLag = () => pause(SWITCH_LAG_MS);

  /** Makes everything already stored `ms` older. `sim` also moves the simulator's clock, for what Meta itself enforces. */
  async function travel(ms, { sim = false } = {}) {
    const interval = `${Math.round(ms)} milliseconds`;
    await rawDb.platform.tx(async (t) => {
      const columns = await t.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND data_type = 'timestamp with time zone' AND table_name = ANY($1)`,
        [CLOCK_TABLES],
      );
      const byTable = new Map();
      for (const { table_name: table, column_name: column } of columns) byTable.set(table, [...(byTable.get(table) ?? []), column]);
      for (const [table, list] of byTable) {
        const fix = list.map((c) => `"${c}" = "${c}" - interval '${interval}'`).join(', ');
        if (INSERT_ONLY.has(table)) await t.exec(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
        await t.exec(`UPDATE "${table}" SET ${fix}`);
        if (INSERT_ONLY.has(table)) await t.exec(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      }
    });
    if (sim) await meta.post('/clock', { advanceMs: ms });
  }

  function webhook(payload, { signature: sig = 'good', secret = APP_SECRET, headers = {} } = {}) {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    let value;
    if (sig === 'good') value = hubSignature(raw, secret);
    else if (sig === 'bad') value = hubSignature(raw, `${secret}-wrong`);
    else if (sig !== 'none') value = sig;
    return hit(world, '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(value === undefined ? {} : { 'x-hub-signature-256': value }), ...headers }, body: raw });
  }

  const callback = (path, signed) => hit(world, path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: signed === undefined ? '' : new URLSearchParams({ signed_request: signed }).toString() });

  let closed = false;
  const world = {
    meta, db, rawDb, platform, config, ig, base, port, secrets, server, gate, graph,
    tick, settle, travel, switchLag, webhook, callback, addWorker,
    stopWorker() { gate.open = false; },
    startWorker() { gate.open = true; gate.waiters.splice(0).forEach((resolve) => resolve()); },
    /** Runs fn when the next Graph call whose path matches is in flight, before it reaches Meta. */
    duringGraphCall(pattern, run) {
      assert.ok(graph, 'This world was opened without the Graph proxy');
      graph.hooks.push({ pattern, run });
    },
    fan: (label = 'fan') => {
      const n = unique();
      return { id: numericId(9_100_000_000_000_000n), username: `${label}_${n}_handle` };
    },
    async close() {
      if (closed) return;
      closed = true;
      world.startWorker();
      await Promise.all(workers.map((w) => w.drivers.queue.close()));
      await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
      await webDrivers.queue.close();
      await graph?.close();
      await meta.close();
      await rawDb.close();
    },
  };
  return world;
}

/** One world per test file, opened before its first test. Each test makes its own businesses in it. */
export function useWorld(options) {
  let current;
  before(async () => { current = await openWorld(options); });
  after(async () => { await current?.close(); });
  return new Proxy({}, { get: (_, key) => current?.[key] });
}

/** Ids of every route, seller or platform, whose id or path matches. */
export const routesInclude = (pattern) => [...routeList, ...platformRouteList].filter((r) => pattern.test(`${r.id} ${r.path}`)).map((r) => r.id);

// ---- what a message looks like ----

export const buttonsOf = (sent) => sent.message?.attachment?.payload?.buttons ?? [];
export const textOf = (sent) => sent.message?.text ?? sent.message?.attachment?.payload?.text ?? '';
export const isButtonTemplate = (sent) => sent.message?.attachment?.payload?.template_type === 'button';
export const quickRepliesOf = (sent) => sent.message?.quick_replies ?? [];
/** The one address a shopper would open from this message. */
export const linkOf = (sent) => buttonsOf(sent).find((b) => b.type === 'web_url')?.url ?? /https?:\/\/[^\s]+/.exec(textOf(sent))?.[0] ?? null;
export const tokenOfCall = (call) => call.headers?.authorization?.replace(/^Bearer\s+/i, '') ?? call.query?.access_token ?? call.body?.access_token;

// ---- a business in that world ----

/** Sets up a business with Instagram connected and every release gate passed, unless told otherwise. */
export async function addShop(world, { plan = 't3', slug, igUserId = numericId(17_841_400_000_000_000n), name, scopes = [...DEFAULT_SCOPES], appRole = true, gates = true, subscribe = true, igConnected = true } = {}) {
  const n = unique();
  const business = await addBusiness(world, { slug: slug ?? `shop-${n}`, name: name ?? `Shop ${n}`, plan });
  const tenantId = business.tenant.id;
  const siteHost = `${business.slug}-site.example`;
  const site = `https://${siteHost}`;
  await world.rawDb.platform.query(`UPDATE tenants SET status = 'active', website = $2 WHERE id = $1`, [tenantId, site]);
  const settingsRow = async (fields) => {
    await world.rawDb.platform.query('INSERT INTO compliance_settings (tenant_id, subject_salt) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING', [tenantId, crypto.randomBytes(24).toString('hex')]);
    const names = Object.keys(fields);
    if (names.length) await world.rawDb.platform.query(`UPDATE compliance_settings SET ${names.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE tenant_id = $1`, [tenantId, ...names.map((f) => fields[f])]);
  };
  await settingsRow(gates ? { access_level: 'advanced', app_role_ok: true, privacy_url_ok_at: new Date(), deletion_callback_ok_at: new Date(), gate_passed_at: new Date() } : {});

  let igToken = null;
  if (igConnected) {
    ({ token: igToken } = await world.meta.post('/accounts', { igUserId, username: `${business.slug}_ig`, subscribedFields: subscribe ? ALL_FIELDS : [], appRole, scopes }));
    await world.platform.tenants.linkIgAccount(tenantId, igUserId, `${business.slug}_ig`);
    await business.repos.igAccounts.setToken(igUserId, igToken);
    await world.rawDb.platform.query(
      `UPDATE ig_accounts SET status = 'active', granted_scopes = $3, subscribed_fields = $4, subscribed_at = now(), token_version = 1, token_issued_at = now() - interval '2 days',
         token_expires_at = now() + interval '50 days', next_refresh_at = now() + interval '30 days', connected_at = now() WHERE tenant_id = $1 AND ig_user_id = $2`,
      [tenantId, igUserId, scopes, subscribe ? ALL_FIELDS : []],
    );
  }
  const token = await signIn(world, business);
  const sql = (text, params = []) => world.rawDb.platform.query(text, params);

  const shop = {
    ...business,
    world, tenantId, igUserId, igToken, token, site, siteHost, sql, settingsRow,
    siteUrl: (path = `/p/${unique()}`) => `${site}${path}`,
    api: (path, options = {}) => api(world, business, token, path, options),
    async call(path, status, options = {}, what = `${options.method ?? 'GET'} ${path}`) {
      return need(await api(world, business, token, path, options), status, what).json();
    },
    settle: (options = {}) => world.settle({ tenantId, ...options }),
    hash: (personId, channel = 'instagram') => withTenant(business.tenant, () => world.platform.compliance.subjectHash(channel, String(personId))),

    // Instagram's side
    async reel(fields = {}) {
      const id = fields.id ?? numericId(18_000_000_000_000_000n);
      await world.meta.post('/media', { igUserId, productType: 'REELS', caption: 'A reel', ...fields, id });
      return id;
    },
    post: (fields = {}) => shop.reel({ productType: 'FEED', mediaType: 'IMAGE', caption: 'A post', ...fields }),
    story: (fields = {}) => shop.reel({ productType: 'STORY', mediaType: 'IMAGE', caption: 'A story', ...fields }),

    async comment(mediaId, { from = world.fan(), text = 'price', ...rest } = {}) {
      const out = await world.meta.post('/comments', { igUserId, mediaId, from, text, ...rest });
      if (rest.deliver !== false && !rest.hold && !rest.signature) assert.equal(out.delivery?.status, 200, `The webhook was refused: ${JSON.stringify(out.delivery)}`);
      return { ...out.comment, from, text, mediaId };
    },
    /** The comment exists at Meta and its webhook comes straight here, whatever the account's subscriptions are. */
    async commentDirect(mediaId, { from = world.fan(), text = 'price', ...rest } = {}) {
      const { comment } = await world.meta.post('/comments', { igUserId, mediaId, from, text, ...rest, deliver: false });
      need(await world.webhook(commentPayload(shop, { id: comment.id, mediaId, text, from })), 200, 'The comment webhook');
      return { ...comment, from, text, mediaId };
    },
    dm: (from, text, rest = {}) => world.meta.post('/messages', { igUserId, from, text, ...rest }),
    tap: (from, payload, rest = {}) => world.meta.post('/postbacks', { igUserId, from, payload, ...rest }),
    storyReply: (from, text, storyId, rest = {}) => world.meta.post('/story-replies', { igUserId, from, text, storyId, ...rest }),
    mention: (from, rest = {}) => world.meta.post('/mentions', { igUserId, from, ...rest }),
    ownerReply: (to, text, rest = {}) => world.meta.post('/owner-replies', { igUserId, to, text, ...rest }),
    fault: (spec) => world.meta.fault(spec),
    /** A refusal from Meta on this account's message sends: nothing was delivered. */
    refuseSends: ({ code, status = 400, subcode, times = 1, message = `(#${code}) refused`, after: skip = 0 }) => world.meta.fault({ kind: 'rate_limit', status, times, after: skip, match: { method: 'POST', path: `*/${igUserId}/messages` }, body: { error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'spec' } } }),

    // What happened
    async sent(filters = {}) { return (await world.meta.get('/sent', { igUserId, ...filters })).sent; },
    async dms(filters = {}) { return (await shop.sent(filters)).filter((m) => m.kind !== 'public_reply'); },
    async publicReplies(filters = {}) { return (await shop.sent(filters)).filter((m) => m.kind === 'public_reply'); },
    sendCalls: () => world.meta.calls({ method: 'POST', path: `*/${igUserId}/messages` }),
    events: (where = 'true', params = []) => sql(`SELECT * FROM compliance_events WHERE tenant_id = $1 AND (${where}) ORDER BY id`, [tenantId, ...params]),
    jobs: (where = 'true', params = []) => sql(`SELECT * FROM outbound_jobs WHERE tenant_id = $1 AND (${where}) ORDER BY id`, [tenantId, ...params]),
    inbound: (where = 'true', params = []) => sql(`SELECT * FROM inbound_events WHERE tenant_id = $1 AND (${where}) ORDER BY id`, [tenantId, ...params]),
    optOuts: () => sql('SELECT * FROM opt_outs WHERE tenant_id = $1', [tenantId]),
    alerts: (audience = 'owner') => sql('SELECT * FROM alerts WHERE tenant_id = $1 AND audience = $2 ORDER BY id', [tenantId, audience]),
    async account() { return (await sql('SELECT * FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id = $2', [tenantId, igUserId]))[0]; },
    async thread(personId, channel = 'instagram') { return (await sql('SELECT * FROM inbox_threads WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3', [tenantId, channel, await shop.hash(personId, channel)]))[0]; },
    async needsHuman(status = 'open') { return (await shop.call(`/inbox/needs-human?status=${status}&limit=100`, 200, {}, 'The Needs a human list')).items; },
    async reasons(commentId) { return (commentId ? await shop.events('comment_id = $2', [commentId]) : await shop.events()).map((e) => e.reason).filter(Boolean); },

    // The builder
    automationBody(o = {}) {
      const { mediaId, targetType = 'reel', channel = 'instagram', triggers, variants, body, buttonTitle, fallbackText, ...rest } = o;
      return {
        name: `Automation ${unique()}`,
        triggerType: 'comment',
        matchMode: 'keywords',
        keywords: ['price'],
        linkMode: 'one_tap',
        linkType: 'seller_site',
        linkUrl: shop.siteUrl(),
        linkButtonTitle: 'Open the link',
        triggers: triggers ?? (mediaId ? [{ channel, targetType, mediaId }] : []),
        variants: variants ?? [{ label: 'A', body: body ?? 'Hi {first_name}, here is the link you asked for.', buttonTitle: buttonTitle ?? 'Open the link', fallbackText: fallbackText ?? 'Here is the link you asked for: {url}' }],
        ...rest,
      };
    },
    /** POSTs a builder form and returns the raw answer, for tests about what the builder refuses. */
    tryAutomation: (o = {}) => api(world, business, token, '/automations', { method: 'POST', body: shop.automationBody(o) }),
    /** Saves an automation through the API, then puts it in `state`. Going live has its own tests, so here the state is set directly. */
    async automate({ state = 'live', ...o } = {}) {
      let { mediaId } = o;
      if (mediaId === undefined && !o.triggers && (o.triggerType ?? 'comment') === 'comment') mediaId = await shop.reel();
      const saved = need(await shop.tryAutomation({ ...o, mediaId }), 201, 'Saving an automation').json();
      await shop.setState(saved.id, state);
      return { ...saved, state, mediaId };
    },
    setState: (id, state) => sql(`UPDATE automations SET state = $3, link_status = 'ok', link_checked_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, id, state]),
  };
  return shop;
}

/** The body Meta sends for one new comment on this business's account. */
export function commentPayload(shop, { id = unique(), mediaId, text = 'price', from, productType = 'REELS', parentId, verb, field = 'comments' }) {
  return { object: 'instagram', entry: [{ id: shop.igUserId, time: Math.floor(Date.now() / 1000), changes: [{ field, value: { id, text, from, media: { id: mediaId, media_product_type: productType }, ...(parentId ? { parent_id: parentId } : {}), ...(verb ? { verb } : {}) } }] }] };
}

// ---- checks that repeat ----

export async function assertNoDm(shop, what = 'No DM should have gone out') {
  assert.deepEqual((await shop.dms()).map((m) => m.message), [], what);
  assert.deepEqual((await shop.sendCalls()).map((c) => c.status), [], `${what}: Instagram was still called`);
}

export async function assertReason(shop, reason, commentId) {
  const reasons = await shop.reasons(commentId);
  assert.ok(reasons.includes(reason), `Expected reason ${reason}${commentId ? ` for comment ${commentId}` : ''}, got: ${[...new Set(reasons)].join(', ') || '(none)'}`);
}

/** A refused save: HTTP 400, naming the rule that broke. */
export function assertRefused(res, reason, what = 'The save') {
  assert.equal(res.status, 400, `${what} should be refused, got ${res.status}: ${res.text.slice(0, 300)}`);
  const body = res.json();
  assert.equal(body.code, 'validation_failed');
  if (reason) assert.equal(body.reason, reason, `${what}: ${JSON.stringify(body)}`);
  return body;
}

export const secondsBetween = (a, b) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 1000;

/** Fails with the place it appears, if `value` mentions the platform in any way a shopper could see. */
export function assertNoPlatformText(value, where = 'The message') {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const at = text.search(/bhava\b|powered by|made with/i);
  assert.equal(at, -1, `${where} names the platform: ...${text.slice(Math.max(0, at - 60), at + 60)}...`);
}

/** Saves a set of public replies on the brand kit. */
export const REPLIES = ['Sent you a DM!', 'Check your DMs', 'Just messaged you', 'Look in your inbox', 'DM is on its way', 'Have a look at your DMs', 'Message sent', 'We have replied in DM', 'Details are in your DMs', 'You have got mail'];
export async function savePublicReplies(shop, n = 5) {
  return shop.call('/brand-kit', 200, { method: 'PATCH', body: { publicReplyVariants: REPLIES.slice(0, n) } }, 'Saving public replies');
}

/** Connects a Facebook Page by the real consent flow. */
export async function connectPage(world, shop, { pageId = numericId(10_200_000_000_000n), linkIg = false } = {}) {
  const { token } = await world.meta.post('/pages', { pageId, name: `${shop.slug} page`, ...(linkIg ? { igUserId: shop.igUserId } : {}), subscribedFields: ['feed', 'messages', 'messaging_postbacks'] });
  await world.meta.post('/facebook/login-next', { pageIds: [pageId] });
  const { authorizeUrl } = await shop.call('/facebook/connect', 200, { method: 'POST', body: {} }, 'Starting the Facebook connection');
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(consent.status, 302, 'Facebook consent');
  const back = new URL(consent.headers.get('location'));
  const done = await hit(world, `${back.pathname}${back.search}`, { host: shop.host });
  assert.ok(done.status < 400, `The Facebook callback answered ${done.status}: ${done.text.slice(0, 200)}`);
  // Consent hands the app a Page token of its own, so that is the one a test has to expire.
  const [row] = await shop.sql('SELECT access_token_enc FROM fb_pages WHERE tenant_id = $1 AND page_id = $2', [shop.tenantId, pageId]);
  assert.ok(row?.access_token_enc, 'The connected Page has a stored token');
  return { pageId, pageToken: world.secrets.decrypt(row.access_token_enc), seededToken: token };
}

/** Connects (or reconnects) Instagram by the real consent flow. */
export async function connectInstagramFlow(world, shop, nextLogin = {}) {
  await world.meta.post('/oauth/next', { igUserId: shop.igUserId, ...nextLogin });
  const { authorizeUrl } = await shop.call('/instagram/connect', 200, { method: 'POST', body: {} }, 'Starting the Instagram connection');
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(consent.status, 302, 'Instagram consent');
  const back = new URL(consent.headers.get('location'));
  const done = await hit(world, `${back.pathname}${back.search}`, { host: shop.host });
  assert.ok(done.status < 400, `The Instagram callback answered ${done.status}: ${done.text.slice(0, 200)}`);
  return done;
}

/** An automation that answers story mentions. Which trigger row a mention takes isn't in the contract, so each form it allows is tried. */
export async function mentionAutomation(shop) {
  const forms = [[{ channel: 'instagram', targetType: 'any_story' }], [{ channel: 'instagram', targetType: 'dm' }], []];
  let last;
  for (const triggers of forms) {
    last = await shop.tryAutomation({ triggerType: 'story_mention', keywords: [], matchMode: 'any', anyModeAcknowledged: true, triggers });
    if (last.status === 201) {
      await shop.setState(last.json().id, 'live');
      return last.json();
    }
  }
  return need(last, 201, 'Saving a story mention automation').json();
}

/** Swaps the stored token and bumps its version, the way a successful refresh does. */
export async function swapToken(shop, newToken) {
  const before_ = (await shop.account()).token_version;
  await shop.repos.igAccounts.setToken(shop.igUserId, newToken);
  if ((await shop.account()).token_version === before_) await shop.sql('UPDATE ig_accounts SET token_version = token_version + 1 WHERE tenant_id = $1 AND ig_user_id = $2', [shop.tenantId, shop.igUserId]);
}

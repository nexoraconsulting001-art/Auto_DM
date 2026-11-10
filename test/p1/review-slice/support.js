import assert from 'node:assert/strict';
import { createMetaAdapters } from '../../../src/adapters/meta/index.js';
import { createIgConnect } from '../../../src/modules/ig-connect/index.js';
import { MODULES } from '../../../src/modules/index.js';
import { bindTenant } from '../../../src/repos/index.js';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { startApp } from '../../helpers.js';

export const APP_ID = 'bhava-ig-app';
export const APP_SECRET = 'secret'; // the app secret startApp configures
export const CALLBACK_BASE = 'https://connect.bhava.test';
export const REDIRECT = `${CALLBACK_BASE}/oauth/instagram/callback`;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const IG_A = '17841400000000011';
export const IG_B = '17841400000000022';

/** Polls until `check` is truthy, and returns what it returned. */
export async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; ;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/**
 * The app and the Meta simulator together. Meta redirects to one registered address, which in tests is a name that reaches this
 * same server, so a callback is fetched with that name as the forwarded host. Health checks fetch the same way.
 */
export async function startSlice(t, { overrides = {}, moduleOptions = {}, simOptions = {}, simApp = {} } = {}) {
  const sim = await createMeta({ app: { id: APP_ID, secret: APP_SECRET, redirectUris: [REDIRECT], ...simApp }, ...simOptions }).start();
  t.after(() => sim.close());

  const holder = { base: '' };
  const fetchImpl = (url, init = {}) => {
    const target = new URL(url);
    return fetch(`${holder.base}${target.pathname}${target.search}`, { ...init, headers: { ...init.headers, 'x-forwarded-host': target.host } });
  };
  const module = createIgConnect({ fetchImpl, ...moduleOptions });
  const modules = MODULES.map((m) => (m.name === 'ig-connect' ? module : m));
  const configured = { graphBaseUrl: sim.url, igAppId: APP_ID, metaCallbackBaseUrl: CALLBACK_BASE, ...overrides };
  const app = await startApp({ modules, overrides: configured });
  holder.base = app.base;
  t.after(async () => {
    app.close();
    await app.db.close();
  });

  // What a worker would run, against the same database, with what a worker is given.
  const handlers = new Map();
  module.jobs({
    db: app.db,
    repos: app.platform,
    meta: createMetaAdapters({ appSecret: APP_SECRET, ...configured }),
    config: { appSecret: APP_SECRET, publicBaseUrl: 'https://shop.test', ...configured },
    platform: {
      queue: { work: (name, handler) => handlers.set(name, handler), every: async () => {} },
      cache: { get: async () => null, set: async () => {}, del: async () => {} },
    },
  });
  const sweep = () => handlers.get('ig-connect.sweep')({});
  const maintain = () => handlers.get('ig-connect.maintain')({});

  await sim.post('/app', { deauthorizeUrl: `${app.base}/meta/deauthorize`, deletionUrl: `${app.base}/meta/deletion` });
  return { app, sim, sweep, maintain, q: (sql, params) => app.db.platform.query(sql, params) };
}

let businesses = 0;

async function signIn(app, { phone, password }, host) {
  const res = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': host }, body: JSON.stringify({ phone, password }) });
  assert.equal(res.status, 201);
  return (await res.json()).token;
}

const apiWith = (app, token) => async (method, path, body) => {
  const res = await fetch(`${app.base}/api/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** A new business with an owner signed in through the API. */
export async function addBusiness(app, name = `shop${++businesses}`) {
  businesses += 1;
  const tenant = await app.platform.tenants.create({ slug: name, name: `${name} store` });
  const repos = bindTenant(app.platform, tenant);
  const phone = `90${String(10_000_000 + businesses * 37)}`;
  const password = 'owner-pass';
  await repos.users.ensureOwner({ phone, password });
  const host = `${name}.bhava.test`;
  const token = await signIn(app, { phone, password }, host);
  return { name, tenant, repos, host, phone, password, token, api: apiWith(app, token), anonymous: apiWith(app, null), signIn: async (who) => apiWith(app, await signIn(app, who, host)) };
}

/** Plays the seller at Meta's consent screen, then the browser arriving back at the one registered address. */
export async function consent({ app, sim }, business, { igUserId, scopes, deny, returnTo = '/admin/settings' } = {}) {
  await sim.post('/oauth/next', { ...(igUserId ? { igUserId } : {}), ...(scopes ? { scopes } : {}), ...(deny ? { deny: true } : {}) });
  const started = await business.api('POST', '/instagram/connect', { returnTo });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const dialog = await fetch(started.body.authorizeUrl, { redirect: 'manual' });
  assert.equal(dialog.status, 302, await dialog.text());
  const back = new URL(dialog.headers.get('location'));
  const callback = () => fetch(`${app.base}${back.pathname}${back.search}`, { redirect: 'manual', headers: { 'x-forwarded-host': back.host } });
  const done = await callback();
  const landing = done.headers.get('location') ? new URL(done.headers.get('location'), 'http://relative.invalid') : null;
  return { authorizeUrl: new URL(started.body.authorizeUrl), back, done, landing, outcome: landing?.searchParams.get('instagram') ?? null, callback };
}

export const seedIg = (sim, igUserId, fields = {}) => sim.post('/accounts', { igUserId, username: `user${igUserId.slice(-4)}`, ...fields });

/** A business with one Instagram account connected through the real flow. */
export async function connected(slice, igUserId = IG_A, name) {
  const business = await addBusiness(slice.app, name);
  const seeded = await seedIg(slice.sim, igUserId);
  const flow = await consent(slice, business, { igUserId });
  assert.equal(flow.outcome, 'connected');
  return { business, igUserId, seeded, flow };
}

export async function accountRow(slice, igUserId) {
  const [row] = await slice.q('SELECT * FROM ig_accounts WHERE ig_user_id = $1', [igUserId]);
  return row ?? null;
}

let keys = 0;

export async function addJob({ q }, tenantId, igUserId, { status = 'queued', reason = '', expiresIn = "interval '1 day'", kind = 'dm' } = {}) {
  const [job] = await q(
    `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, idempotency_key, status, reason, recipient_id, expires_at, payload)
     VALUES ($1, 'instagram', $2, $3, $4, $5, $6, 'igsid-1', now() + ${expiresIn}, '{"message":{"text":"hello"}}') RETURNING id`,
    [tenantId, igUserId, kind, `job-${++keys}`, status, reason],
  );
  return job.id;
}

export const jobStatus = async ({ q }, id) => (await q('SELECT status, reason FROM outbound_jobs WHERE id = $1', [id]))[0] ?? null;

export const decisions = ({ q }, tenantId) => q('SELECT kind, decision, reason, details FROM compliance_events WHERE tenant_id = $1 ORDER BY id', [tenantId]);

export const alertsFor = ({ q }, tenantId) => q('SELECT kind, audience, severity, message, target FROM alerts WHERE tenant_id = $1 ORDER BY id', [tenantId]);

export const auditFor = ({ q }, tenantId) => q('SELECT actor, action, target, details FROM audit_log WHERE tenant_id = $1 ORDER BY id', [tenantId]);

export async function subscribedOnMeta(sim, igUserId, token) {
  const res = await fetch(`${sim.url}/v23.0/${igUserId}/subscribed_apps`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  return body.data?.[0]?.subscribed_fields ?? [];
}

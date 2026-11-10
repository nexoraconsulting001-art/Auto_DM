// Shared by every spec test in this folder: real HTTP requests with a real Host header, businesses to test
// against, and the checks that repeat. Nothing here looks inside the code being tested.
import '../../../tools/net-guard.mjs'; // nothing leaves this machine, however this file is run
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { setLogSink } from '../../../src/platform/log.js';
import { bindTenant } from '../../../src/repos/index.js';
import { startApp } from '../../helpers.js';

/** Stands in for the neutral buyer domain. The real one is not chosen yet, and must not contain the platform name. */
export const NEUTRAL = 'shops.example';
export const CONSOLE_HOST = `admin.${NEUTRAL}`;
export const CUSTOMER = { name: 'Asha K', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' };

let serial = 0;
export const nextPhone = () => `91${String(++serial).padStart(8, '0')}`;
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) return value;
    await pause(25);
  }
}

/**
 * One HTTP request with a real Host header, which fetch cannot send. Redirects are not followed.
 * A string or Buffer body is sent as it is; any other object goes as JSON.
 */
export function hit(app, path, { host, method = 'GET', headers = {}, body, token, cookie } = {}) {
  return new Promise((resolve, reject) => {
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
    const req = http.request({ host: '127.0.0.1', port: app.port, path, method, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, raw, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.setTimeout(45_000, () => req.destroy(new Error(`no answer to ${method} ${path} in 45 s`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Fails with what was being attempted and what came back, so a missing feature reads as one. */
export function need(res, expected, what) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert.ok(allowed.includes(res.status), `${what}: expected HTTP ${allowed.join(' or ')}, got ${res.status}: ${res.text.slice(0, 300)}`);
  return res;
}

const PLATFORM_NAME = /bhava/i;

/** Fails, quoting the place, if the platform name appears anywhere in `value`. */
export function noPlatformName(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const at = text.search(PLATFORM_NAME);
  assert.equal(at, -1, `${label} shows the platform name: ...${text.slice(Math.max(0, at - 80), at + 80)}...`);
}

export const titleOf = (html) => /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';

const sameOriginAssets = (html) =>
  [...html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)=["']([^"']+)["']/gi)].map((m) => m[1]).filter((u) => u.startsWith('/') && !u.startsWith('//'));

/** The page and every stylesheet, script and icon it pulls from the same site, joined: all of what a viewer's browser receives. */
export async function pageSource(app, host, path, options = {}) {
  const res = await hit(app, path, { host, ...options });
  let source = res.text;
  for (const asset of sameOriginAssets(res.text)) {
    const file = await hit(app, asset, { host });
    if (file.status === 200) source += `\n${file.text}`;
  }
  return { res, source };
}

/** A buyer page: answers 200, and neither it, its headers, its assets nor its favicon show the platform name. */
export async function assertBuyerPageClean(app, business, path, options = {}) {
  const res = await hit(app, path, { host: business.host, ...options });
  need(res, 200, `Buyer page ${path}`);
  noPlatformName(`${path} page source`, res.text);
  noPlatformName(`${path} title`, titleOf(res.text));
  noPlatformName(`${path} response headers`, res.headers);
  for (const asset of sameOriginAssets(res.text)) {
    const file = await hit(app, asset, { host: business.host });
    noPlatformName(`${path} asset ${asset} address`, asset);
    if (file.status === 200) {
      noPlatformName(`${path} asset ${asset}`, file.text);
      noPlatformName(`${path} asset ${asset} headers`, file.headers);
    }
  }
  const favicon = /<link\b[^>]*\brel=["'](?:shortcut )?icon["'][^>]*>/i.exec(res.text)?.[0];
  if (favicon) noPlatformName(`${path} favicon`, favicon);
  else {
    const fallback = await hit(app, '/favicon.ico', { host: business.host });
    if (fallback.status === 200) noPlatformName(`${path} /favicon.ico`, fallback.text);
  }
  return res;
}

/** An app with no default business and no platform name in its addresses, closed when the test ends. */
export async function startWorld(t, options = {}) {
  const app = await startApp({ ...options, overrides: { platformDomain: NEUTRAL, publicBaseUrl: '', defaultTenant: '', ...options.overrides } });
  t.after(() => app.close());
  return app;
}

/** A business with its own owner. `host` is the address its pages and API answer on. */
export async function addBusiness(app, { slug, name, plan = 't3', domain } = {}) {
  const tenant = await app.platform.tenants.create({ slug, name, plan });
  const repos = bindTenant(app.platform, tenant);
  const owner = { phone: nextPhone(), password: 'owner-pass-1' };
  await repos.users.ensureOwner(owner);
  await repos.settings.update({ store_name: name });
  if (domain) await app.platform.tenants.addDomain(tenant.id, domain);
  return { tenant, repos, owner, name, slug, host: domain ?? `${slug}.${NEUTRAL}` };
}

/** Signs in through the API on the business's own address and returns the bearer token. */
export async function signIn(app, business, who = business.owner) {
  const res = need(await hit(app, '/api/v1/auth/login', { host: business.host, method: 'POST', body: { phone: who.phone, password: who.password } }), 201, 'Sign in');
  return res.json().token;
}

/** Signs in with the cookie form on the business's own address. */
export async function signInCookie(app, business, who = business.owner) {
  const res = await hit(app, '/login', {
    host: business.host,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ phone: who.phone, password: who.password }).toString(),
  });
  assert.equal(res.status, 303, `Cookie sign-in: got ${res.status}`);
  return res.headers['set-cookie'][0].split(';')[0];
}

export const api = (app, business, token, path, options = {}) => hit(app, `/api/v1${path}`, { host: business.host, token, ...options });

export async function addProduct(business, name, extra = {}) {
  return business.repos.products.create({ name, price: '100', active: 'on', ...extra });
}

export async function addReel(business, igMediaId, { n = 2, headline = 'Brunch edit' } = {}) {
  const products = [];
  for (let i = 0; i < n; i++) products.push(await addProduct(business, `${business.name} product ${i + 1}`));
  const reel = await business.repos.reels.save(igMediaId, { headline, keywords: 'LINK', productIds: products.map((p) => p.id), active: 'on' });
  return { reel, products };
}

export async function addOrder(business, product, customer = CUSTOMER) {
  return business.repos.orders.create({ items: [{ productId: product.id, qty: 1 }], customer }, await business.repos.settings.getAll());
}

/** Connects an Instagram account, so comments on its reels reach this business. */
export async function connectInstagram(app, business, igUserId) {
  await app.platform.tenants.linkIgAccount(business.tenant.id, igUserId, business.slug);
  await business.repos.igAccounts.setToken(igUserId, `token-${igUserId}`);
}

/** A correctly signed Instagram comment webhook. */
export function sendComment(app, igUserId, mediaId, { commentId = crypto.randomUUID(), text = 'LINK', username = 'shopper_handle' } = {}) {
  const body = JSON.stringify({ entry: [{ id: igUserId, changes: [{ field: 'comments', value: { id: commentId, text, media: { id: mediaId }, from: { id: 'ig-shopper-1', username } } }] }] });
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
  return hit(app, '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body });
}

/** Every web address in what was sent to Instagram. */
export const linksIn = (calls) => [...JSON.stringify(calls).matchAll(/https?:\/\/[^"\s\\]+/g)].map((m) => m[0]);

const defaultSink = (line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);

/** Collects log lines until the test ends. */
export function captureLogs(t) {
  const lines = [];
  setLogSink((line) => lines.push(line));
  t.after(() => setLogSink(defaultSink));
  return {
    text: () => lines.join('\n'),
    forRequest: (requestId) => lines.filter((l) => l.includes(requestId)),
  };
}

export const requestId = () => `spec-${crypto.randomUUID()}`;

/** The refusal of request `id` was logged, in a line naming what happened and no personal data. */
export function assertAttemptLogged(logs, id, kind) {
  const entries = logs.forRequest(id);
  assert.ok(entries.length > 0, 'The attempt left no log line for its request id');
  assert.ok(entries.some((l) => kind.test(l)), `No log line for this request matches ${kind}: ${entries.join(' | ').slice(0, 400)}`);
}

export function multipart(field, filename, mime, data) {
  const boundary = `----spec${crypto.randomUUID().replace(/-/g, '')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.isBuffer(data) ? data : Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** A real 1x1 PNG, so a file-type check on the bytes passes. */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export async function uploadFile(app, business, token, { filename = 'photo.png', mime = 'image/png', data = TINY_PNG } = {}) {
  const form = multipart('file', filename, mime, data);
  return hit(app, '/api/v1/media', { host: business.host, method: 'POST', token, headers: form.headers, body: form.body });
}

/** Sets the plan the way a billing change finally lands on the tenant row. */
export const setPlan = (app, business, plan) => app.db.query('UPDATE tenants SET plan = $2 WHERE id = $1', [business.tenant.id, plan]);

// ---- Staff ----

/** Records staff permissions wherever the build keeps them. The contract says they exist, not where they live. */
async function grantPermissions(app, business, userId, permissions) {
  if (typeof business.repos.users.setPermissions === 'function') return business.repos.users.setPermissions(userId, permissions);
  const [column] = await app.db.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'permissions'`);
  assert.ok(column, 'Staff permissions are not stored anywhere yet: no users.setPermissions() and no users.permissions column');
  const value = column.data_type === 'ARRAY' ? permissions : JSON.stringify(permissions);
  return app.db.query('UPDATE users SET permissions = $2 WHERE id = $1 AND tenant_id = $3', [userId, value, business.tenant.id]);
}

/** A staff member holding exactly `permissions`, confirmed through what the API reports about them. */
export async function addStaff(app, business, { permissions = [], phone = nextPhone() } = {}) {
  const staff = { phone, password: 'staff-pass-1' };
  const user = await business.repos.users.create({ name: 'Ravi Staff', ...staff, role: 'staff' });
  await grantPermissions(app, business, user.id, permissions);
  const token = await signIn(app, business, staff);
  const me = need(await api(app, business, token, '/auth/me'), 200, 'Staff profile').json();
  assert.equal(me.user.role, 'staff');
  assert.deepEqual([...me.user.permissions].sort(), [...permissions].sort(), 'The API reports the permissions this staff member was given');
  return { ...staff, user, token };
}

// ---- Platform Console ----

let adminSerial = 0;

/** A platform user signed in on the console host. */
export async function consoleUser(app, role = 'super_admin') {
  const email = `operator${++adminSerial}@team.example`;
  const password = 'console-pass-1';
  await app.platform.platformUsers.create({ email, password, role, name: 'Operator' });
  const res = need(await hit(app, '/login', { host: CONSOLE_HOST, method: 'POST', body: { email, password } }), 200, 'Console sign-in');
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  const me = need(await hit(app, '/me', { host: CONSOLE_HOST, cookie }), 200, 'Console session').json();
  return { email, password, cookie, csrf: me.csrf, role };
}

export function onConsole(app, operator, path, { headers = {}, ...options } = {}) {
  return hit(app, path, { host: CONSOLE_HOST, cookie: operator.cookie, headers: { 'x-csrf-token': operator.csrf ?? '', ...headers }, ...options });
}

// ---- Row-level security ----

/** The role the app runs as: can read orders, is no superuser and cannot bypass row-level security. Null until one exists. */
export async function findAppRole(db) {
  const rows = await db.query(
    `SELECT DISTINCT g.grantee AS name
     FROM information_schema.role_table_grants g
     JOIN pg_roles r ON r.rolname = g.grantee
     WHERE g.table_schema = 'public' AND g.table_name = 'orders' AND g.privilege_type = 'SELECT'
       AND NOT r.rolsuper AND NOT r.rolbypassrls AND r.rolname NOT LIKE 'pg\\_%'`,
  );
  return rows[0]?.name ?? null;
}

/** Runs fn({ query }) as the app role in one transaction, with app.tenant_id set unless tenantId is null. */
export function asAppRole(db, role, tenantId, fn) {
  return db.tx(async (t) => {
    await t.exec(`SET LOCAL ROLE "${role}"`);
    if (tenantId !== null) await t.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(tenantId)]);
    return fn(t);
  });
}

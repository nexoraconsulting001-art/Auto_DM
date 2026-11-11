// What the engagement track's tests share (PRD 9.19 reviews, 9.20 wishlist, 9.21 loyalty and referrals): a store business,
// signed-in shoppers with their CSRF token, orders taken through checkout and moved by the state machine, and calls to the
// console API as the owner, a manager or another business.
import assert from 'node:assert/strict';
import http from 'node:http';
import { withTenant } from '../../../src/tenancy.js';
import { csrfFor } from '../../../src/modules/shoppers/keys.js';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { OWNER } from '../../helpers.js';
import { ADDRESS, hit, markPaid, orderByNumber, otherStore, ownerToken, payments, place, placeBody, product, q, sessionCookie, setPlan, storeApp } from '../checkout/support.js';

export { ADDRESS, hit, markPaid, orderByNumber, otherStore, ownerToken, payments, place, placeBody, product, q, setPlan, storeApp };

/** A shopper signed in at one business: their row, a session cookie and that session's CSRF token. */
export async function signedIn(app, { phone = '+919876543210', name = 'Asha Rao', tenant = app.tenant } = {}) {
  const id = await withTenant(tenant, async () => {
    const [row] = await app.db.query(
      `INSERT INTO shoppers (tenant_id, phone, phone_verified_at, name) VALUES ($1, $2, now(), $3)
       ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [tenant.id, phone, name],
    );
    return row.id;
  });
  const cookie = await sessionCookie(app, id, tenant);
  const csrf = csrfFor(app.config, cookie.slice(cookie.indexOf('=') + 1));
  return { id, phone, cookie, csrf, tenant, host: tenant === app.tenant ? undefined : `${tenant.slug}.bhava.test` };
}

/** Options for hit() as this shopper: their cookie, their CSRF token, and their business's address. */
export const as = (who) => ({ cookie: who.cookie, host: who.host, headers: { 'x-shopper-csrf': who.csrf } });

/** Moves an order through fulfilment by hand, as the seller's console does. */
export async function advance(app, orderId, steps, tenant = app.tenant) {
  for (const to of steps) await withTenant(tenant, () => app.db.tx((t) => changeOrder(t, orderId, { fulfilment: to, actor: 'user:1' })));
  await app.ctx.orderEvents.settle();
}

/** Places a prepaid order of one product as this shopper (or a guest), and gives the order row. */
export async function ordered(app, who, productId, over = {}, { tenant = app.tenant } = {}) {
  const res = await place(app, placeBody(productId, over), who ? as(who) : { host: tenant === app.tenant ? undefined : `${tenant.slug}.bhava.test` });
  assert.equal(res.status, 201, `placing an order: ${res.text}`);
  return orderByNumber(app, res.json.orderNumber, tenant);
}

/** A paid prepaid order taken through packed, shipped and delivered. */
export async function delivered(app, who, productId, over = {}, { tenant = app.tenant } = {}) {
  const order = await ordered(app, who, productId, over, { tenant });
  await markPaid(app, order.id, { tenant });
  await advance(app, order.id, ['packed', 'shipped', 'delivered'], tenant);
  return orderByNumber(app, order.order_number, tenant);
}

/** A second business on its own address, with an owner who signs in with the same phone and password as the first's. */
export async function otherShop(app, options = {}) {
  const other = await otherStore(app, options);
  await withTenant(other.tenant, () => app.platform.users.ensureOwner(OWNER));
  await payments(app, { tenant: other.tenant });
  return other;
}

/** Turns a feature on or off for one business only. */
export const setFeature = (app, feature, enabled = true, tenant = app.tenant) => app.db.platform.query(
  `INSERT INTO tenant_features (tenant_id, feature, enabled) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled`,
  [tenant.id, feature, enabled],
);

/** The console API as the owner (or with another token), on a business's address. */
export async function consoleApi(app, { host, token } = {}) {
  const bearer = token ?? (await ownerToken(app, host));
  const call = (method, path, body) => hit(app, `/api/v1${path}`, { method, host, token: bearer, ...(body === undefined ? {} : { body }) });
  return Object.assign(call, { token: bearer });
}

/** A manager (or staff with `permissions`) of the default business, signed in to the console. */
export async function member(app, { role = 'manager', permissions = [], phone = '9111100001' } = {}) {
  const password = 'member-pass-1';
  await withTenant(app.tenant, async () => {
    const user = await app.platform.users.create({ name: 'Mina', phone, password, role });
    if (permissions.length) await app.platform.users.setPermissions(user.id, permissions);
  });
  const res = await hit(app, '/api/v1/auth/login', { method: 'POST', body: { phone, password } });
  assert.ok(res.json?.token, `member sign-in: ${res.status} ${res.text}`);
  return consoleApi(app, { token: res.json.token });
}

/** Rows of one business, read as the owner of the database (no fence). */
export const rows = (app, sql, params = []) => app.db.platform.query(sql, params);
export const one = async (app, sql, params = []) => (await rows(app, sql, params))[0];
export const ledgerOf = (app, shopperId, tenant = app.tenant) => rows(app, 'SELECT * FROM loyalty_ledger WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id', [tenant.id, shopperId]);
export const accountOf = (app, shopperId, tenant = app.tenant) => one(app, 'SELECT balance, pending FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [tenant.id, shopperId]);

/** Loyalty on for the default business: the add-on, then the owner's settings. */
export async function loyaltyOn(app, patch = {}, { tenant = app.tenant, host } = {}) {
  await setFeature(app, 'loyalty', true, tenant);
  const api = await consoleApi(app, { host });
  const res = await api('PATCH', '/loyalty/settings', { enabled: true, earnPoints: 1, earnPerPaise: 10000, pointValuePaise: 100, maxRedeemPoints: 50, ...patch });
  assert.equal(res.status, 200, res.text);
  return api;
}

/** Waits for something that happens after a response (a referral recorded once the order is placed). */
export async function eventually(check, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Text of an HTML page, tags and scripts left out. */
export const textOf = (page) => String(page).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export const noPlatformName = (text) => !/bhava/i.test(String(text));
export { OWNER, withTenant };

/** A multipart/form-data body: text fields, then files as { field, name, type, data }. */
export function multipart(fields, files = []) {
  const boundary = `----engagement${Date.now().toString(16)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    chunks.push(Buffer.from(f.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** A request with a binary body (hit() sends text). */
export function sendBytes(app, path, { method = 'POST', headers = {}, body, cookie, host } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { ...headers, 'content-length': body.length, ...(cookie ? { cookie } : {}), ...(host ? { host } : {}) };
    const req = http.request({ host: '127.0.0.1', port: app.port, path, method, headers: sent }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

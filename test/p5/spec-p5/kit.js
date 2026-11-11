// Shared by the Phase 5 spec tests. Written from the PRD (5.11, 5.13, 10.1 to 10.6, "iOS ready from day one") and the
// Phase 5 contract only: src/contracts/accounts.js, src/contracts/notifications.js, src/contracts/api/{auth,team,app,
// notifications}.js, AUTH_PATHS in provider.js, the tables of migrations 500 to 521, ctx.notify's interface and the
// simulators in tools/sim. Nothing here looks inside a module.
//
// The world is the Phase 4 spec world (the app, its worker, the database, Meta, the store's providers) with what sellers
// hear from Bhava simulated behind it: Bhava's own WhatsApp number and email sender, owner push on both wires (FCM and
// APNs, tools/sim/push), Google sign-in for sellers (a second Google simulator, apart from the shoppers' one) and Sign in
// with Apple (tools/sim/apple). Sellers sign in on the sign-in host, which belongs to no business.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before } from 'node:test';
import { createApple } from '../../../tools/sim/apple/index.mjs';
import { createGoogle } from '../../../tools/sim/google/index.mjs';
import { createPush } from '../../../tools/sim/push/index.mjs';
import { createApp } from '../../../src/server.js';
import { createPlatform } from '../../../src/platform/index.js';
import * as accounts from '../../../src/contracts/accounts.js';
import * as notifyRules from '../../../src/contracts/notifications.js';
import { AUTH_PATHS, OWNER_APP_CALLBACK, routeList, routes } from '../../../src/contracts/api/index.js';
import { addOrder, addProduct } from '../../p0/spec-p0/support.js';
import { addP3Shop } from '../../p3/spec-p3/kit.js';
import { address, buyer, hit, need, openP4World, pause, unique } from '../../p4/spec-p4/kit.js';

export * from '../../p4/spec-p4/kit.js';
export { accounts, notifyRules, AUTH_PATHS, OWNER_APP_CALLBACK, routeList, routes, addOrder, addProduct, addP3Shop };
export const { CODE_RULES, AUTH_LIMITS, FRESH_MINUTES, HANDOFF_SECONDS, DELETION_GRACE_DAYS } = accounts;
export const { NOTIFY_RULES, NOTIFY_EVENTS, PUSH_DATA_KEYS, BRAND_LOGO, WORKSPACE_BADGE, pushProblem, sellerEmailProblem } = notifyRules;

/** Where sellers sign in: no business answers here. A *.localhost name, so Google's simulator takes it as a redirect address. */
export const APP_HOST = 'app.bhava.localhost';
/** Bhava's own verified WhatsApp number (its phone number id at WhatsApp) and email sender, for sellers only. */
export const PLATFORM_PHONE_ID = '100200300400';
export const PLATFORM_EMAIL = 'hello@mail.bhava.example';
export const SELLER_GOOGLE_CLIENT = 'sim-seller-google-client';
export const SHOPPER_GOOGLE_CLIENT = 'sim-google-client';
export const APPLE_AUDIENCE = 'sim.apple.owner-app';
/** The p1 world's SESSION_SECRET: the key of every code hash. */
export const SESSION_SECRET = 'spec-session-secret';
/** App Review's number and its fixed code. Only the code's hash is ever configured. */
export const REVIEW = Object.freeze({ phone: '+919999988877', code: '246813' });
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** Tables whose stored times make up "now" for accounts and notifications. */
export const P5_CLOCK_TABLES = Object.freeze([
  'seller_login_codes', 'sessions', 'refresh_tokens', 'token_families', 'auth_devices', 'auth_handoffs', 'team_invites', 'rate_limit_hits',
  'review_login_uses', 'account_deletion_requests', 'notification_events', 'notification_deliveries', 'notifications', 'push_devices', 'alerts', 'report_deliveries',
]);
export const NOTIFY_TABLES = Object.freeze(['notification_events', 'notification_deliveries', 'notifications']);
export const CODE_TABLES = Object.freeze(['seller_login_codes', 'rate_limit_hits']);

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const withData = (res) => Object.assign(res, { data: json(res.text) });
export const randomIp = () => `100.${64 + crypto.randomInt(0, 63)}.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
export const digitsOf = (phone) => String(phone ?? '').replace(/\D/g, '');
/** A fresh Indian mobile number in E.164. Starts 7, so it never meets the p0 helpers' 91-numbers. */
export const newSellerPhone = () => `+917${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;
/** The ten digits an account's phone holds for an Indian number. */
export const local10 = (e164) => digitsOf(e164).slice(-10);
export const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
/** A device as the owner app describes itself at sign-in. */
export const newDevice = (name = 'Pixel 8', platform = 'android', appVersion = '1.0.0') => ({ id: crypto.randomBytes(16).toString('hex'), name, platform, app: 'owner', appVersion });
export const iosPushToken = () => crypto.randomBytes(32).toString('hex');
export const androidPushToken = () => `fcm-${crypto.randomBytes(24).toString('base64url')}:${crypto.randomBytes(16).toString('base64url')}`;

/** The 6-digit code in a WhatsApp message the simulator received, wherever the template put it. */
export function codeIn(message) {
  const texts = [];
  const walk = (value) => {
    if (typeof value === 'string') texts.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(message?.body?.template?.components ?? message?.body?.text ?? message?.body);
  return texts.map((t) => /(?<!\d)\d{6}(?!\d)/.exec(t)?.[0]).find(Boolean) ?? null;
}

// ---- the world ----------------------------------------------------------------------------------------------------------

export async function openP5World({ overrides = {}, worker = true } = {}) {
  const push = createPush();
  const apple = createApple({ audience: APPLE_AUDIENCE });
  const sellerGoogle = createGoogle({ sellerClientId: SELLER_GOOGLE_CLIENT });
  const sims = [push, apple, sellerGoogle];
  for (const sim of sims) await sim.start();
  const fcm = push.fcmCredentials();
  const apns = push.apnsCredentials();
  let world;
  try {
    world = await openP4World({
      worker,
      overrides: {
        platformAppHost: APP_HOST,
        platformWhatsappPhoneId: PLATFORM_PHONE_ID,
        platformWhatsappToken: 'sim-whatsapp-token',
        platformEmailFrom: PLATFORM_EMAIL,
        platformEmailFromName: 'Bhava',
        sellerGoogleClientId: SELLER_GOOGLE_CLIENT,
        sellerGoogleClientSecret: 'sim-seller-google-secret',
        googleKeysBaseUrl: sellerGoogle.url,
        idTokenKeyRefetchMs: 0,
        appleSigninAudiences: [APPLE_AUDIENCE],
        appleKeysBaseUrl: apple.url,
        reviewLoginPhone: REVIEW.phone,
        reviewLoginCodeHash: accounts.codeHash(SESSION_SECRET, { purpose: 'signin', subject: REVIEW.phone, code: REVIEW.code }),
        pushDriver: 'fcm,apns',
        fcmProjectId: fcm.projectId,
        fcmServiceAccount: fcm.serviceAccount,
        fcmBaseUrl: push.url,
        apnsKeyId: apns.keyId,
        apnsTeamId: apns.teamId,
        apnsKey: apns.key,
        apnsTopic: apns.topic,
        apnsBaseUrl: push.apnsUrl,
        notifyPollMs: 40,
        ...overrides,
      },
    });
  } catch (err) {
    await Promise.all(sims.map((s) => s.close()));
    throw err;
  }
  const closeP4 = world.close;
  const extra = [];
  let service = null;

  Object.assign(world, {
    push, apple, sellerGoogle,
    /** A request on the sign-in host. */
    app: (path, { method = 'GET', body, headers = {}, token, cookie, ip = randomIp(), host = APP_HOST } = {}) => hit(world, path, {
      host, method, token, cookie, body, headers: { 'x-forwarded-host': host, 'x-forwarded-for': ip, ...headers },
    }).then(withData),
    /** Every WhatsApp message Bhava's own number sent to this phone, oldest first. */
    async sellerMessages(phone) {
      const { sent } = await world.wa.get('/sent');
      return sent.filter((m) => m.phoneId === PLATFORM_PHONE_ID && digitsOf(m.to).endsWith(local10(phone)));
    },
    /** Every WhatsApp message to this phone, from any number. */
    async allMessagesTo(phone) {
      const { sent } = await world.wa.get('/sent');
      return sent.filter((m) => digitsOf(m.to).endsWith(local10(phone)));
    },
    /** The newest code Bhava's number sent to `phone`, once more than `after` messages reached it. */
    async sellerCode(phone, { after: seen = 0, ms = 5000 } = {}) {
      const end = Date.now() + ms;
      for (;;) {
        const list = await world.sellerMessages(phone);
        if (list.length > seen) {
          const code = codeIn(list.at(-1));
          if (code) return code;
        }
        if (Date.now() > end) return null;
        await world.tick();
        await pause(80);
      }
    },
    /** Every push the simulator received (refused ones included), optionally only to one device token. */
    async pushes(token) {
      const all = await push.received();
      return token ? all.filter((p) => p.token === token) : all;
    },
    /** Seller emails from Bhava's sender to one address. */
    async platformEmailsTo(address) {
      const { sent } = await world.mail.get('/sent');
      return sent.filter((m) => m.to.includes(address));
    },
    /**
     * Makes what these tables hold `ms` older: codes, sessions, tokens, deliveries due later. The simulators' clocks are
     * not moved, so tokens they sign stay current for the real clock the server reads.
     */
    async shift(ms, tables = P5_CLOCK_TABLES) {
      const interval = `${Math.round(ms)} milliseconds`;
      await world.rawDb.platform.tx(async (t) => {
        const columns = await t.query(
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'timestamp with time zone' AND table_name = ANY($1)`,
          [[...tables]],
        );
        const byTable = new Map();
        for (const { table_name: table, column_name: column } of columns) byTable.set(table, [...(byTable.get(table) ?? []), column]);
        for (const [table, list] of byTable) {
          await t.exec(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
          await t.exec(`UPDATE "${table}" SET ${list.map((c) => `"${c}" = "${c}" - interval '${interval}'`).join(', ')}`);
          await t.exec(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
        }
      });
    },
    /** Runs the worker and asks again until `check` gives something, or `ms` passes. */
    async waitFor(check, ms = 10_000, every = 100) {
      const end = Date.now() + ms;
      let value;
      for (;;) {
        await world.tick();
        value = await check();
        if (value || Date.now() > end) return value;
        await pause(every);
      }
    },
    /**
     * ctx.notify (the contract's one service for everything a seller is told), from a second app instance on the same
     * database, for the few cases no route or table reaches: emit() with a key of the test's choosing.
     */
    notify() {
      if (!service) {
        const platform = createPlatform(world.config, { db: world.db });
        const app = createApp({ db: world.db, ig: world.ig, config: world.config, platform });
        service = { ctx: app.locals.ctx, platform };
      }
      assert.ok(service.ctx?.notify?.emit, 'The app has no ctx.notify.emit (the Phase 5 notifications contract)');
      return service.ctx.notify;
    },
    /** The review login's row, the way the Platform Console would set it. */
    async reviewLogin({ enabled = true, phone = REVIEW.phone, code = REVIEW.code } = {}) {
      const codeHash = accounts.codeHash(SESSION_SECRET, { purpose: 'signin', subject: phone, code });
      await world.sql(
        `INSERT INTO review_logins (phone, code_hash, enabled) VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, enabled = EXCLUDED.enabled, updated_at = now()`,
        [phone, codeHash, enabled],
      );
      return (await world.sql('SELECT * FROM review_logins WHERE phone = $1', [phone]))[0];
    },
    async close() {
      for (const server of extra) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
      if (service) {
        try { await service.ctx.notify?.close?.(); } catch { /* best effort */ }
        try { await service.ctx.orderEvents?.close?.(); } catch { /* best effort */ }
        try { await service.platform.queue?.close?.(); } catch { /* best effort */ }
      }
      await closeP4();
      await Promise.all(sims.map((s) => s.close()));
    },
  });
  return world;
}

/** One world per test file, opened before its first test. Each test makes its own businesses and people in it. */
export function useP5World(options) {
  let current;
  before(async () => { current = await openP5World(options); });
  after(async () => { await current?.close(); });
  return new Proxy({}, { get: (_, key) => current?.[key] });
}

// ---- signing in ---------------------------------------------------------------------------------------------------------

const appHeadersOf = (app) => (app ? { 'x-app': app.name ?? 'owner', 'x-app-version': app.version, 'x-app-platform': app.platform ?? 'android' } : {});

export const startCode = (world, phone, { ip, headers = {}, host } = {}) => world.app('/api/v1/auth/start', { method: 'POST', body: { phone }, ip, headers, host });
export const verifyCode = (world, body, { ip, headers = {}, host } = {}) => world.app('/api/v1/auth/verify', { method: 'POST', body: { transport: 'bearer', ...body }, ip, headers, host });

/** The session a sign-in answered, with what a client then does with it. */
export function sessionOf(world, res, { transport = 'bearer', device, ip = randomIp(), app, phone } = {}) {
  const body = res.data ?? json(res.text) ?? {};
  const cookies = [res.headers['set-cookie'] ?? []].flat().map((line) => line.split(';')[0]).filter((pair) => pair && !pair.endsWith('='));
  const s = {
    phone, device, ip, transport, body,
    user: body.user, business: body.business, businesses: body.businesses ?? [],
    accessToken: body.accessToken, refreshToken: body.refreshToken, csrf: body.csrf,
    cookie: cookies.join('; '),
    appHeaders: appHeadersOf(app),
  };
  s.headers = (more = {}) => ({
    ...s.appHeaders,
    ...(s.transport === 'cookie' ? { cookie: s.cookie, 'x-csrf-token': s.csrf ?? '' } : { authorization: `Bearer ${s.accessToken}` }),
    ...more,
  });
  /** A call to /api/v1 on the sign-in host, as this client. `tenantId` sends X-Tenant-Id. */
  s.send = (method, path, data, { headers = {}, tenantId, host } = {}) =>
    world.app(`/api/v1${path}`, { method, body: data, ip: s.ip, host, headers: s.headers({ ...(tenantId ? { 'x-tenant-id': String(tenantId) } : {}), ...headers }) });
  /** Presents the refresh token; on success the client keeps the new pair, as the app does. */
  s.refresh = async (token = s.refreshToken, { ip = s.ip } = {}) => {
    const r = await world.app('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: token }, ip, headers: s.appHeaders });
    if (r.status === 201 && r.data?.accessToken) {
      s.accessToken = r.data.accessToken;
      s.refreshToken = r.data.refreshToken;
    }
    return r;
  };
  s.me = () => s.send('GET', '/auth/me');
  return s;
}

/**
 * Signs `phone` in with a WhatsApp code, the way the owner app (bearer) or the web console (cookie) does. A second
 * sign-in inside the resend window would get no new code, so the window is moved past first.
 */
export async function codeSignIn(world, phone, { transport = 'bearer', device = transport === 'bearer' ? newDevice() : undefined, tenantId, ip = randomIp(), app, host } = {}) {
  const headers = appHeadersOf(app);
  const seen = (await world.sellerMessages(phone)).length;
  need(await startCode(world, phone, { ip, headers, host }), 202, 'Asking for a sign-in code');
  let code = await world.sellerCode(phone, { after: seen, ms: 4000 });
  if (!code) {
    await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
    need(await startCode(world, phone, { ip, headers, host }), 202, 'Asking for a sign-in code again');
    code = await world.sellerCode(phone, { after: seen, ms: 4000 });
  }
  assert.ok(code, `No sign-in code reached ${phone.slice(0, 4)}… from Bhava's WhatsApp number`);
  const res = await verifyCode(world, { phone, code, transport, ...(device ? { device } : {}), ...(tenantId ? { tenantId } : {}) }, { ip, headers, host });
  need(res, 201, 'Entering the sign-in code');
  return Object.assign(sessionOf(world, res, { transport, device, ip, app, phone }), { code });
}

export const appSignIn = (world, phone, options = {}) => codeSignIn(world, phone, { ...options, transport: 'bearer' });
export const webSignIn = (world, phone, options = {}) => codeSignIn(world, phone, { ...options, transport: 'cookie' });

/** A re-auth by WhatsApp code inside a session, so routes marked fresh answer. */
export async function freshen(world, s) {
  const seen = (await world.sellerMessages(s.phone)).length;
  const started = await s.send('POST', '/auth/reauth/start');
  need(started, 202, 'Starting a re-auth');
  let code = await world.sellerCode(s.phone, { after: seen, ms: 4000 });
  if (!code) {
    await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
    need(await s.send('POST', '/auth/reauth/start'), 202, 'Starting a re-auth again');
    code = await world.sellerCode(s.phone, { after: seen, ms: 4000 });
  }
  assert.ok(code, 'No re-auth code arrived on WhatsApp');
  return need(await s.send('POST', '/auth/reauth/verify', { code }), 200, 'Entering the re-auth code');
}

/** Makes every session's last sign-in or re-auth older than FRESH_MINUTES, so routes marked fresh refuse. */
export const staleAll = (world) => world.shift((FRESH_MINUTES + 1) * MINUTE, ['sessions']);

// ---- businesses and the people in them -------------------------------------------------------------------------------

/** The owner's number in E.164: the account's phone, which a WhatsApp code to it proves. */
export const ownerPhone = (shop) => `+91${local10(shop.owner.phone)}`;

/** A business with Instagram connected and its owner (Phase 3 spec helpers), without the store's setup. */
export const addSeller = (world, options = {}) => addP3Shop(world, options);

/**
 * Someone on the team: a seller account in `shop` with this phone, role and permissions, which they prove is theirs by
 * signing in with a code to that phone. The account row is written with the business's repos; the team routes and
 * invitations have their own tests.
 */
export async function addMember(shop, { role = 'staff', permissions = [], phone = newSellerPhone(), name = 'Ravi Member' } = {}) {
  const user = await shop.repos.users.create({ name, phone: local10(phone), password: `member-${unique()}-pass`, role });
  if (role === 'staff') await shop.repos.users.setPermissions(user.id, permissions);
  return { phone, userId: user.id };
}

/** Signs the owner of `shop` in to the app, in that business. */
export const ownerApp = (world, shop, options = {}) => appSignIn(world, ownerPhone(shop), { tenantId: shop.tenantId, ...options });

/** Gives an account an email address, as a seller who added one has. */
export const setEmail = (shop, userId, email) => shop.sql('UPDATE users SET email = $3 WHERE tenant_id = $1 AND id = $2', [shop.tenantId, userId, email]);
export async function ownerId(shop) {
  const [row] = await shop.sql(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY id LIMIT 1`, [shop.tenantId]);
  return row.id;
}

/** A Phase 0 order in this business, with a product of its own. */
export async function manualOrder(shop, customer = { name: 'Asha K', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' }) {
  const product = await addProduct(shop, `Item ${unique()}`);
  return addOrder(shop, product, customer);
}

/**
 * A cash on delivery order from a shopper who signed in with a WhatsApp code first, so the phone is already verified.
 * (The Phase 4 kit's guest path re-sends the same checkout after the COD code; on this branch that answer stays
 * "verify_phone", so these specs do not lean on it.)
 */
export async function codOrder(world, shop, lines, { email } = {}) {
  const b = buyer(world, shop);
  const phone = await b.signIn();
  const body = b.checkoutBody({ lines, paymentMode: 'cod', address: address({ phone }), ...(email ? { email } : {}) });
  const res = await b.place(body);
  assert.ok(res.status < 300 && res.data?.next === 'done', `Placing a cash on delivery order: ${res.status} ${res.text.slice(0, 200)}`);
  return { ...res.data, body, buyer: b, phone };
}

/** Registers this device's push token for the signed-in person. */
export async function registerPush(s, { platform = s.device?.platform ?? 'android', token = platform === 'ios' ? iosPushToken() : androidPushToken() } = {}) {
  need(await s.send('POST', '/push/devices', { deviceId: s.device.id, platform, token, appVersion: s.device.appVersion ?? '1.0.0' }), 204, 'Registering the push token');
  return token;
}

/** A notification's deliveries for this business, newest first, with their event's kind. */
export const deliveries = (shop, where = 'true', params = []) => shop.sql(
  `SELECT d.*, e.kind, e.event_key, e.created_at AS event_at, e.data AS event_data, e.link AS event_link FROM notification_deliveries d
   JOIN notification_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id WHERE d.tenant_id = $1 AND (${where}) ORDER BY d.id DESC`,
  [shop.tenantId, ...params],
);
export const events = (shop, where = 'true', params = []) => shop.sql(`SELECT * FROM notification_events WHERE tenant_id = $1 AND (${where}) ORDER BY id`, [shop.tenantId, ...params]);

/** Every word a person could read in a push the simulator received. */
export const pushText = (p) => JSON.stringify({ title: p.title, body: p.body, data: p.data, raw: p.raw });

/** Refused, and never a fault. */
export function refusedWith(res, statuses, what) {
  assert.ok([statuses].flat().includes(res.status), `${what}: expected HTTP ${[statuses].flat().join(' or ')}, got ${res.status}: ${String(res.text).slice(0, 300)}`);
  return res;
}

/** Runs `n` copies of `make(i)` at the same moment. */
export const atOnce = (n, make) => Promise.all(Array.from({ length: n }, (_, i) => make(i)));

/** A WhatsApp message's words, for searching. */
export const messageText = (m) => JSON.stringify(m?.body ?? {});

export { withData };

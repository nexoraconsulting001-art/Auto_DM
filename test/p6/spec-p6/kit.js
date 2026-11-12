// Shared by the Phase 6 spec tests. Written from the PRD (10.1, 10.7 to 10.14, "iOS ready from day one") and the Phase 6 contract
// only: src/contracts/apps.js, src/contracts/store-routes.js (APP_ROUTES), src/contracts/api/{apps,platform}.js, the tables of
// migrations 600 to 608, the simulators in tools/sim and tools/build-brand. Nothing here looks inside a module.
//
// The world is the Phase 5 spec world (the app, its worker, the database, push, WhatsApp, Razorpay...) plus the three
// simulators of the build and store side: EAS, App Store Connect and Google Play.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before } from 'node:test';
import { createAppStore } from '../../../tools/sim/appstore/index.mjs';
import { createEas } from '../../../tools/sim/eas/index.mjs';
import { createPlay } from '../../../tools/sim/play/index.mjs';
import * as apps from '../../../src/contracts/apps.js';
import { APP_ROUTES } from '../../../src/contracts/store-routes.js';
import { androidPushToken, hit, iosPushToken, newPhone, openP5World, setFeature, withData } from '../../p5/spec-p5/kit.js';

export * from '../../p5/spec-p5/kit.js';
export { apps, APP_ROUTES };
export const { APP_LIMITS, APP_LINK_PATHS, SHOPPER_PUSH_RULES, PRESUBMIT_CHECKS, STORE_LIMITS, ASSET_SPECS, PLAYBOOKS, namesPlatform } = apps;

export const EXPO_TOKEN = 'expo-spec-token';
/** A Play App Signing fingerprint shaped like the real ones: 32 pairs of capital hex digits. Made up. */
export const SIGNING_SHA256 = Array.from({ length: 32 }, (_, i) => ((i * 7 + 16) % 256).toString(16).toUpperCase().padStart(2, '0')).join(':');
export const OTHER_SHA256 = Array.from({ length: 32 }, (_, i) => ((i * 11 + 3) % 256).toString(16).toUpperCase().padStart(2, '0')).join(':');
export const SECOND_MS = 1000;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const together = (n, make) => Promise.all(Array.from({ length: n }, (_, i) => make(i)));

// ---- the world ------------------------------------------------------------------------------------------------------------

export async function openP6World({ overrides = {}, worker = true } = {}) {
  const eas = createEas({ token: EXPO_TOKEN });
  const appstore = createAppStore();
  const play = createPlay();
  const sims = [eas, appstore, play];
  for (const sim of sims) await sim.start();
  const playAccount = await play.post('/service-account');
  let world;
  try {
    world = await openP5World({
      worker,
      overrides: {
        expoToken: EXPO_TOKEN,
        easBaseUrl: eas.url,
        appStoreBaseUrl: appstore.url,
        playBaseUrl: play.url,
        playServiceAccount: JSON.stringify(playAccount),
        appBuildDriver: 'eas',
        appBuildPollMs: 40,
        storeReviewPollMs: 60,
        shopperPushPollMs: 40,
        shopperPushWeeklyCap: SHOPPER_PUSH_RULES.weeklyCap,
        otaMinLaunches: 50,
        ...overrides,
      },
    });
  } catch (err) {
    await Promise.all(sims.map((s) => s.close()));
    throw err;
  }
  const closeP5 = world.close;
  Object.assign(world, {
    eas, appstore, play, playAccount,
    /** The clock of every store-side simulator moves together. */
    async advance(ms) {
      for (const sim of sims) await sim.post('/clock', { advanceMs: ms });
    },
    async close() {
      await closeP5();
      await Promise.all(sims.map((s) => s.close()));
    },
  });
  return world;
}

/** One world per test file, opened before its first test. */
export function useP6World(options) {
  let current;
  before(async () => { current = await openP6World(options); });
  after(async () => { await current?.close(); });
  return new Proxy({}, { get: (_, key) => current?.[key] });
}

// ---- a business with a shopper app ----------------------------------------------------------------------------------------

/**
 * A tier 3 store (addP4Shop) given its shopper app: the plan features, and a valid app_configs row on its own host. `config` holds
 * app_configs columns by their SQL names to change. Returns the shop, with `appRow()` and `appSet(columns)`.
 */
export async function addAppShop(world, { platforms = ['android'], config = {}, ...options } = {}) {
  const { addP4Shop } = await import('../../p5/spec-p5/kit.js');
  const shop = await addP4Shop(world, { plan: platforms.includes('ios') ? 't5' : 't4', ...options });
  for (const platform of platforms) await setFeature(shop, platform === 'ios' ? 'app.ios' : 'app.android', true);
  const n = shop.tenantId;
  const row = {
    app_name: shop.name.slice(0, 30), short_name: 'Kesar', android_package: `com.example.s${n}`, ios_bundle_id: `com.example.s${n}`, url_scheme: `shop${n}`,
    shop_domain: shop.host, support_email: `help${n}@seller.example`, privacy_url: `https://${shop.host}/policies/privacy`, apple_team_id: 'ABCDE12345',
    play_account_id: '1234567890', play_signing_sha256: [SIGNING_SHA256], ...config,
  };
  const columns = Object.keys(row);
  await shop.sql(
    `INSERT INTO app_configs (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (tenant_id) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
    [n, ...columns.map((c) => row[c])],
  );
  Object.assign(shop, {
    appRow: async () => (await shop.sql('SELECT * FROM app_configs WHERE tenant_id = $1', [n]))[0],
    async appSet(patch) {
      const names = Object.keys(patch);
      await shop.sql(`UPDATE app_configs SET ${names.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE tenant_id = $1`, [n, ...names.map((c) => patch[c])]);
    },
    app: (options2 = {}) => shopperApp(world, shop, options2),
    submissions: () => shop.sql('SELECT * FROM app_submissions WHERE tenant_id = $1 ORDER BY platform', [n]),
    appBuilds: () => shop.sql('SELECT * FROM app_builds WHERE tenant_id = $1 ORDER BY id', [n]),
    rejections: () => shop.sql('SELECT * FROM app_rejections WHERE tenant_id = $1 ORDER BY id', [n]),
    reviewTasks: () => shop.sql('SELECT * FROM app_review_tasks WHERE tenant_id = $1 ORDER BY id', [n]),
    presubmitRuns: () => shop.sql('SELECT * FROM presubmit_runs WHERE tenant_id = $1 ORDER BY id', [n]),
    pushDevices: () => shop.sql('SELECT * FROM shopper_push_devices WHERE tenant_id = $1 ORDER BY id', [n]),
    pushLog: () => shop.sql('SELECT * FROM shopper_push_log WHERE tenant_id = $1 ORDER BY id', [n]),
    pushConsents: () => shop.sql('SELECT * FROM shopper_push_consents WHERE tenant_id = $1 ORDER BY id', [n]),
    campaigns: () => shop.sql('SELECT * FROM push_campaigns WHERE tenant_id = $1 ORDER BY id', [n]),
    appSessions: () => shop.sql('SELECT * FROM shopper_app_sessions WHERE tenant_id = $1 ORDER BY created_at', [n]),
  });
  return shop;
}

/** Gives the shop's brand its own push credentials (the shop's console, as the owner would). */
export async function pushCredentialsOn(world, shop, { android = true, ios = false } = {}) {
  const body = {};
  if (android) body.fcm = { serviceAccount: world.push.fcmCredentials().serviceAccount };
  if (ios) {
    const apns = world.push.apnsCredentials();
    body.apns = { keyId: apns.keyId, teamId: apns.teamId, key: apns.key, env: 'sandbox' };
    await shop.appSet({ ios_bundle_id: apns.topic, apple_team_id: apns.teamId });
  }
  const res = await shop.send('PUT', '/push-credentials', body);
  assert.ok(res.status < 300, `Saving the brand's push credentials answered ${res.status}: ${res.text.slice(0, 300)}`);
  return res;
}

// ---- the shopper app, as a client -----------------------------------------------------------------------------------------

/**
 * Stands in for the shopper app of a business: every request carries X-App: shopper, X-App-Tenant, X-App-Version and
 * X-App-Platform on the business's own host. `tenantId`, `host` and `version` can be set to lie. After start() it also sends
 * Authorization: Shopper <access token>.
 */
export function shopperApp(world, shop, { platform = 'android', version = '1.0.0', tenantId = shop.tenantId, host = shop.host, ip = `203.0.113.${crypto.randomInt(1, 250)}`, device } = {}) {
  const dev = device ?? { id: crypto.randomBytes(16).toString('hex'), name: 'Pixel 8' };
  const tokens = { accessToken: '', refreshToken: '' };
  const headers = { 'x-app': 'shopper', 'x-app-tenant': String(tenantId), 'x-app-version': version, 'x-app-platform': platform, 'x-forwarded-for': ip, 'user-agent': 'ShopperApp/1.0' };
  const self = {
    shop, device: dev, tokens, headers, ip, platform,
    /** Any request, with the app's headers; `extra` headers win. */
    call(method, path, body, extra = {}) {
      const h = { accept: 'application/json', ...headers, ...(tokens.accessToken ? { authorization: `Shopper ${tokens.accessToken}` } : {}), ...extra };
      return hit(world, path, { host, method, headers: h, ...(body === undefined ? {} : { body }) }).then(withData);
    },
    get: (path, extra) => self.call('GET', path, undefined, extra),
    post: (path, body, extra) => self.call('POST', path, body ?? {}, extra),
    put: (path, body, extra) => self.call('PUT', path, body, extra),
    async absorb(res) {
      if (res.status < 300 && res.data?.accessToken) Object.assign(tokens, { accessToken: res.data.accessToken, refreshToken: res.data.refreshToken ?? tokens.refreshToken });
      return res;
    },
    async start(grant = 'guest', extra = {}) {
      const body = typeof grant === 'string' ? { grant, device: dev, ...extra } : { device: dev, ...grant };
      return self.absorb(await self.call('POST', '/api/store/app/session', body));
    },
    async refresh() {
      return self.absorb(await self.call('POST', '/api/store/app/session/refresh', { refreshToken: tokens.refreshToken }));
    },
    /** A guest session, then a WhatsApp code to `phone`, then a signed-in session. */
    async signIn(phone = newPhone()) {
      if (!tokens.accessToken) assert.equal((await self.start('guest')).status, 201, 'A guest session did not open');
      const sent = await self.post('/api/store/otp/send', { phone, purpose: 'sign_in' });
      assert.ok(sent.status < 300, `Asking for a code answered ${sent.status}: ${sent.text.slice(0, 200)}`);
      const code = await world.codeFor(phone);
      const res = await self.start({ grant: 'otp', phone, code });
      assert.ok(res.status < 300, `Signing in with the code answered ${res.status}: ${res.text.slice(0, 200)}`);
      self.phone = phone;
      return phone;
    },
    putCart: (lines) => self.put('/api/store/cart', { lines }),
    getCart: () => self.get('/api/store/cart'),
    checkoutBody({ lines, paymentMode = 'prepaid', address: addr, addressId, ...rest } = {}) {
      return {
        lines, paymentMode,
        ...(addressId ? { addressId } : { address: addr ?? { name: 'Asha Rao', phone: self.phone ?? newPhone(), line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' } }),
        idempotencyKey: `spec-${crypto.randomUUID()}`, acceptTerms: true,
        consent: { noticeVersion: shop.noticeVersion ?? 1, orderUpdates: { whatsapp: true, email: true }, marketing: { whatsapp: false, email: false } },
        ...rest,
      };
    },
    place: (body) => self.post('/api/store/checkout', body),
    /** Places an order that must be taken and answers the PlacedOrder. */
    async order(fields) {
      const body = self.checkoutBody(fields);
      const res = await self.place(body);
      assert.ok(res.status < 300, `Placing an order answered ${res.status}: ${res.text.slice(0, 300)}`);
      return { ...res.data, body };
    },
    /** The shopper pays at the gateway with the test card; the page then brings the signed result back. */
    async pay(placed, options = {}) {
      assert.ok(placed.gateway?.gatewayOrderId, `The order has no gateway order to pay: ${JSON.stringify(placed).slice(0, 300)}`);
      const paid = await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, webhook: false, ...options });
      const res = await self.post('/api/store/payments/return', { orderToken: placed.token, gatewayOrderId: placed.gateway.gatewayOrderId, gatewayPaymentId: paid.payment.id, signature: paid.signature });
      return { ...paid, res };
    },
    async buy(fields) {
      const placed = await self.order(fields);
      const paid = await self.pay(placed);
      const row = await shop.orderWhen(placed.orderNumber, (o) => o.payment_status === 'paid' || o.payment_status === 'advance_paid');
      return Object.assign(row, { placed, paid });
    },
    // push
    registerDevice: (body = {}) => self.put('/api/store/app/push/device', { token: platform === 'ios' ? iosPushToken() : androidPushToken(), permission: 'granted', ...body }),
    prefs: () => self.get('/api/store/app/push/prefs'),
    setPrefs: (body, source = 'settings') => self.put('/api/store/app/push/prefs', { source, ...body }),
  };
  return self;
}

export const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });

/** Every string, key and value in a JSON document, joined: what a screen or a payload could show. */
export const textOfJson = (value) => JSON.stringify(value ?? null);

/** Fails when the platform's name is anywhere in this answer, its headers included. */
export function assertNoPlatformName(res, what) {
  const all = `${res.text}\n${JSON.stringify(res.headers)}`;
  assert.ok(!namesPlatform(all), `${what} names the platform: ${all.match(/.{0,50}bhava.{0,50}/i)?.[0]}`);
}

/** The status of a refusal that must not have changed anything. */
export function refusedStatus(res, what, statuses = [400, 401, 403, 404, 409, 422, 426]) {
  assert.ok(statuses.includes(res.status), `${what}: expected a refusal (${statuses.join(', ')}), got ${res.status}: ${res.text.slice(0, 200)}`);
}

export function accepted(res, what) {
  assert.ok(res.status >= 200 && res.status < 300, `${what}: expected success, got ${res.status}: ${res.text.slice(0, 300)}`);
  return res;
}

/** A pool of shop products with stock, so tests can buy things. */
export async function stockedProducts(shop, n = 2, fields = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await shop.item({ pricePaise: 29900 + i * 10000, stock: 20, ...fields }));
  return out;
}

/** The PNG bytes of a plain image, for assets. Built by the shared kit's png(). */
export { png } from '../../p5/spec-p5/kit.js';

/** Waits for a database check to give something. */
export async function eventuallyRow(world, check, ms = 12_000) {
  return world.waitFor(check, ms, 80);
}

// ---- builds, submissions and presubmit runs, written straight into the tables ---------------------------------------------

let buildSerial = 100;
/** The checks of a passing presubmit run for `platform`, optionally with some failing: { account_deletion: 'not found' }. */
export function presubmitChecks(platform, failing = {}) {
  return apps.presubmitChecksFor(platform).map((c) => ({ code: c.code, guideline: c.guideline, passed: !(c.code in failing), detail: failing[c.code] ?? '' }));
}

/**
 * A built build, a presubmit run and a draft submission for the business, as the pipeline leaves them. `failing` names presubmit
 * checks that failed; `presubmit: false` writes no run. Returns { buildId, submission }.
 */
export async function seedSubmission(shop, platform = 'ios', { failing = {}, presubmit = true, state = 'draft', appVersion = '1.0.0' } = {}) {
  const n = shop.tenantId;
  const serial = ++buildSerial;
  await shop.sql(`INSERT INTO app_runtimes (runtime_version, fingerprint, app_version) VALUES ($1, 'fp-spec-00000001', $2) ON CONFLICT DO NOTHING`, [appVersion, appVersion]);
  const [batch] = await shop.sql(
    `INSERT INTO app_build_batches (reason, tenant_id, app_version, runtime_version, requested_by, request_key) VALUES ('brand', $1, $2, $2, 'system', $3) RETURNING id`,
    [n, appVersion, `seed-${n}-${serial}-${crypto.randomUUID().slice(0, 8)}`],
  );
  const [build] = await shop.sql(
    `INSERT INTO app_builds (tenant_id, batch_id, reason, platform, app_version, build_number, runtime_version, driver, profile, status, request_key, requested_by)
     VALUES ($1, $2, 'brand', $3, $4, $5, $4, 'eas', 'production', 'built', $6, 'system') RETURNING id`,
    [n, batch.id, platform, appVersion, serial, `seedb-${n}-${serial}-${crypto.randomUUID().slice(0, 8)}`],
  );
  if (presubmit) {
    const checks = presubmitChecks(platform, failing);
    await shop.sql(`INSERT INTO presubmit_runs (tenant_id, build_id, platform, passed, checks, tool_version) VALUES ($1, $2, $3, $4, $5, 'spec')`, [n, build.id, platform, checks.every((c) => c.passed), JSON.stringify(checks)]);
  }
  const [submission] = await shop.sql(
    `INSERT INTO app_submissions (tenant_id, platform, state, build_id, app_version, build_number) VALUES ($1, $2, 'draft', $3, $4, $5)
     ON CONFLICT (tenant_id, platform) DO UPDATE SET build_id = EXCLUDED.build_id, app_version = EXCLUDED.app_version, build_number = EXCLUDED.build_number RETURNING *`,
    [n, platform, build.id, appVersion, serial],
  );
  if (state !== 'draft') {
    const path = { in_review: ['in_review'], rejected: ['in_review', 'rejected'], approved: ['in_review', 'approved'], live: ['in_review', 'approved', 'live'] }[state];
    for (const to of path) await shop.sql(`UPDATE app_submissions SET state = $3 WHERE tenant_id = $1 AND id = $2`, [n, submission.id, to]);
  }
  return { buildId: build.id, submission: (await shop.sql('SELECT * FROM app_submissions WHERE tenant_id = $1 AND id = $2', [n, submission.id]))[0] };
}

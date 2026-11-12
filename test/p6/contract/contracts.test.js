// What the Phase 6 tracks build against (the branded shopper app, PRD 10.7 to 10.14): the requirement list, the nine module
// folders and their order, every new route with exactly one module, the route rules, the pure rules in src/contracts/apps.js,
// the order channel, and the one push sender.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '@bhava/api-client';
import * as apps from '../../../src/contracts/apps.js';
import { Coupon, CouponCreate, FRESH_ROUTES, PlatformParams, platformRoutes, routeList, routes } from '../../../src/contracts/api/index.js';
import { RESERVED_PATHS } from '../../../src/contracts/buyer-pages.js';
import { ORDER_EVENTS } from '../../../src/contracts/orders.js';
import { APP_ROUTES, APP_SORTS, STORE_ROUTES } from '../../../src/contracts/store-routes.js';
import { MODULES } from '../../../src/modules/index.js';
import { shopperSession } from '../../../src/modules/shoppers/session.js';
import { SORTS } from '../../../src/modules/storefront/catalog.js';
import { currentChannel, withChannel } from '../../../src/platform/channel.js';
import { newToken, tokenHash } from '../../../src/contracts/accounts.js';
import { APP_HOST, OWNER, startApp } from '../../helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
const PLATFORM_HOST = 'admin.bhava.test';

const P6_MODULES = ['app-links', 'app-api', 'shopper-push', 'ota', 'app-config', 'app-builds', 'store-access', 'store-listings', 'app-submissions'];
/** Which module answers each Phase 6 /api/v1 route. */
const SELLER = {
  'app-config': ['appPublishing.get', 'appPublishing.save', 'appPublishing.validate'],
  'app-builds': ['appPublishing.builds', 'appPublishing.requestBuild'],
  'app-submissions': ['appPublishing.submissions'],
  'store-listings': ['appListing.get', 'appListing.save', 'appListing.assets'],
  'store-access': ['storeAccess.get', 'storeAccess.save', 'storeAccess.check'],
  'shopper-push': ['pushCampaigns.list', 'pushCampaigns.summary', 'pushCampaigns.send', 'pushCredentials.get', 'pushCredentials.save'],
};
/** Which module answers each Phase 6 Platform Console route. */
const PLATFORM = {
  'app-builds': ['platform.appBatches', 'platform.appBatch', 'platform.createAppBatch', 'platform.buildBusinessApp'],
  'app-config': ['platform.setAppMinimum', 'platform.setAppReviewAccess'],
  'app-submissions': ['platform.appSubmissions', 'platform.setSubmissionState', 'platform.appRejections', 'platform.appPlaybooks', 'platform.appReviewTasks', 'platform.resolveAppReviewTask'],
  ota: ['platform.otaReleases', 'platform.publishOta', 'platform.advanceOta', 'platform.rollBackOta', 'platform.otaHealth'],
};
const SELLER_IDS = Object.values(SELLER).flat();
const PLATFORM_IDS = Object.values(PLATFORM).flat();
const SELLER_GROUPS = ['appPublishing', 'appListing', 'storeAccess', 'pushCampaigns', 'pushCredentials'];
const FORBIDDEN_FIELDS = ['price', 'amount', 'total', 'discount', 'channel', 'tenantId', 'shopperId'];
const moduleNamed = (name) => MODULES.find((m) => m.name === name);

test('requirements/p6.json lists the 43 Phase 6 scenarios once, in order, with short titles that name no platform', () => {
  const requirements = readJson('requirements/p6.json');
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `P-${String(from + i).padStart(2, '0')}`);
  const expected = ['P-01', ...range(27, 66), 'P-70', 'I-03'];
  assert.equal(expected.length, 43);
  assert.deepEqual(requirements.map((r) => r.id), expected);
  for (const r of requirements) {
    assert.deepEqual(Object.keys(r), ['id', 'title']);
    assert.ok(r.title.length > 0 && r.title.length <= 100, r.id);
    assert.equal(apps.namesPlatform(r.title), false, r.id);
  }
  for (const earlier of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'later']) {
    const theirs = readJson(`requirements/${earlier}.json`).map((r) => r.id);
    assert.deepEqual(expected.filter((id) => theirs.includes(id)), [], `no id is also in ${earlier}.json`);
  }
});

test('the nine Phase 6 folders exist and sit where the contract puts them in MODULES', () => {
  const names = MODULES.map((m) => m.name);
  for (const name of P6_MODULES) {
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules', name, 'index.js')), name);
    assert.ok(names.includes(name), name);
    assert.ok(moduleNamed(name).owns, `${name} says what it owns`);
  }
  assert.ok(names.indexOf('app-links') > names.indexOf('reports') && names.indexOf('app-links') < names.indexOf('catalog'), 'app-links after reports, before catalog');
  assert.equal(names.indexOf('app-links'), names.indexOf('reports') + 1);
  assert.equal(names.indexOf('app-api'), names.indexOf('shoppers') - 1, 'app-api directly before shoppers');
  assert.deepEqual(names.slice(names.indexOf('shopify-sync') + 1, names.indexOf('storefront')), ['shopper-push', 'ota', 'app-config', 'app-builds', 'store-access', 'store-listings', 'app-submissions']);
  assert.equal(names.indexOf('storefront'), names.indexOf('admin-console') - 1, 'storefront is still directly before the console');
});

test('every Phase 6 route has exactly one module: seller, buyer and console', () => {
  const answers = new Map();
  for (const module of MODULES) {
    // A Phase 6 folder's api() must not read ctx; earlier ones get the stub their own contract tests use.
    const ctx = P6_MODULES.includes(module.name) ? {} : { repos: {}, config: {}, ig: {}, auth: {}, db: {}, platform: {}, providers: {}, notify: {} };
    for (const id of Object.keys(module.api?.(ctx) ?? {})) {
      assert.equal(answers.has(id), false, `${id} is answered by both ${answers.get(id)} and ${module.name}`);
      answers.set(id, module.name);
    }
  }
  const phase6 = routeList.filter((r) => SELLER_GROUPS.includes(r.id.split('.')[0])).map((r) => r.id);
  assert.deepEqual([...phase6].sort(), [...SELLER_IDS].sort(), 'the seller routes are the 17 of the contract');
  for (const [owner, ids] of Object.entries(SELLER)) {
    for (const id of ids) assert.equal(answers.get(id), owner, id);
    assert.deepEqual([...moduleNamed(owner).owns.api].sort(), [...ids].sort(), `${owner}.owns.api`);
  }
  for (const route of routeList) assert.ok(answers.has(route.id), `${route.id} has no module`);

  // Buyer routes: each APP_ROUTES id in its owner's owns.store, once, and every owner one of the nine.
  const stores = new Map();
  for (const name of P6_MODULES) {
    for (const id of moduleNamed(name).owns.store) {
      assert.equal(stores.has(id), false, `${id} is owned twice`);
      stores.set(id, name);
    }
  }
  assert.deepEqual([...stores.keys()].sort(), Object.keys(APP_ROUTES).sort());
  for (const [id, route] of Object.entries(APP_ROUTES)) {
    assert.ok(P6_MODULES.includes(route.owner), `${id} is owned by a Phase 6 module`);
    assert.equal(stores.get(id), route.owner, id);
  }

  // Console routes.
  const consoleIds = new Map();
  for (const name of P6_MODULES) {
    for (const id of moduleNamed(name).owns.platform) {
      assert.equal(consoleIds.has(id), false, `${id} is owned twice`);
      consoleIds.set(id, name);
      assert.ok(platformRoutes[id], `${id} is a Platform Console route`);
    }
  }
  assert.deepEqual([...consoleIds.keys()].sort(), [...PLATFORM_IDS].sort());
  for (const [owner, ids] of Object.entries(PLATFORM)) for (const id of ids) assert.equal(consoleIds.get(id), owner, id);
  for (const name of P6_MODULES) {
    const module = moduleNamed(name);
    if (module.owns.platform.length) assert.equal(typeof module.platformRoutes, 'function', `${name} mounts its console routes`);
    if (module.owns.store.length) assert.equal(typeof module.routes, 'function', `${name} mounts its buyer routes`);
  }
});

test('a running app answers 501 for a route of each Phase 6 module, and 404 for both well-known files', async () => {
  const app = await startApp();
  try {
    const { token } = await (await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) })).json();
    for (const [pathname, owner] of [['/app-publishing', 'app-config'], ['/app-publishing/builds', 'app-builds'], ['/app-publishing/submissions', 'app-submissions'], ['/app-listing/android', 'store-listings'], ['/store-access', 'store-access'], ['/push-campaigns', 'shopper-push']]) {
      const res = await fetch(`${app.base}/api/v1${pathname}`, { headers: { authorization: `Bearer ${token}` } });
      assert.deepEqual([res.status, (await res.json()).code], [501, 'not_implemented'], `${owner}: ${pathname}`);
    }
    assert.equal((await fetch(`${app.base}/api/v1/app-listing/web`, { headers: { authorization: `Bearer ${token}` } })).status, 404, ':id is a platform');

    for (const [method, pathname] of [['GET', '/api/store/app/bootstrap'], ['POST', '/api/store/app/session'], ['GET', '/api/store/app/push/prefs'], ['POST', '/api/store/app/health']]) {
      const res = await fetch(`${app.base}${pathname}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(res.status, 501, pathname);
      assert.equal(res.headers.get('cache-control'), 'no-store', pathname);
      const body = await res.json();
      assert.equal(body.code, 'not_implemented', pathname);
      assert.equal(apps.namesPlatform(JSON.stringify(body)), false);
    }
    const google = await fetch(`${app.base}/auth/app/google`, { redirect: 'manual' });
    assert.equal(google.status, 501);
    for (const pathname of ['/.well-known/assetlinks.json', '/.well-known/apple-app-site-association']) {
      const res = await fetch(`${app.base}${pathname}`, { redirect: 'manual' });
      assert.equal(res.status, 404, pathname);
      assert.equal(apps.namesPlatform(await res.text()), false, pathname);
    }

    await app.platform.platformUsers.create({ email: 'ops@team.example', password: 'platform-pass', role: 'super_admin' });
    const onConsole = (pathname, init = {}) => fetch(`${app.base}${pathname}`, { redirect: 'manual', ...init, headers: { 'x-forwarded-host': PLATFORM_HOST, 'content-type': 'application/json', ...init.headers } });
    const signedIn = await onConsole('/login', { method: 'POST', body: JSON.stringify({ email: 'ops@team.example', password: 'platform-pass' }) });
    const { csrf } = await signedIn.json();
    const cookie = signedIn.headers.get('set-cookie').split(';')[0];
    assert.equal((await onConsole('/ota-releases')).status, 401, 'behind requirePlatformRole');
    for (const [method, pathname, owner] of [['GET', '/app-build-batches', 'app-builds'], ['PUT', `/tenants/${app.tenant.id}/app-minimum`, 'app-config'], ['GET', '/app-submissions', 'app-submissions'], ['GET', '/ota-releases', 'ota']]) {
      const res = await onConsole(pathname, { method, headers: { cookie, 'x-csrf-token': csrf }, ...(method === 'PUT' ? { body: '{}' } : {}) });
      assert.deepEqual([res.status, (await res.json()).code], [501, 'not_implemented'], `${owner}: ${method} ${pathname}`);
    }
  } finally {
    app.close();
  }
});

test('a shopper app\'s refresh token at the seller refresh is unknown: 401, still unspent, its family untouched (D3)', async () => {
  const app = await startApp();
  try {
    const sql = (text, params) => app.db.platform.query(text, params);
    const [family] = await sql(`INSERT INTO token_families (subject_kind, tenant_id, device_id) VALUES ('shopper', $1, 'device-0123456789abcdef') RETURNING id`, [app.tenant.id]);
    const refreshToken = `sr_${newToken(32)}`;
    await sql(`INSERT INTO refresh_tokens (family_id, token_hash, tenant_id, expires_at) VALUES ($1, $2, $3, now() + interval '90 days')`, [family.id, tokenHash(refreshToken), app.tenant.id]);
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${app.base}/api/v1/auth/refresh`, { method: 'POST', headers: { 'x-forwarded-host': APP_HOST, 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
      assert.deepEqual([res.status, (await res.json()).code], [401, 'unauthorized'], `try ${i + 1}`);
    }
    const [row] = await sql('SELECT r.used_at, f.revoked_at FROM refresh_tokens r JOIN token_families f ON f.id = r.family_id WHERE r.token_hash = $1', [tokenHash(refreshToken)]);
    assert.deepEqual(row, { used_at: null, revoked_at: null }, 'a second try is not a reuse either');
  } finally {
    app.close();
  }
});

/** A valid input for each APP_ROUTES and seller route that takes one. */
const DEVICE = { id: 'device-0123456789abcdef' };
const APP_SAMPLES = {
  appSessionStart: { grant: 'guest', device: DEVICE },
  appSessionRefresh: { refreshToken: 'sr_token' },
  appApple: { identityToken: 'header.claims.signature', nonce: 'raw-nonce', device: DEVICE },
  appAccountDelete: { confirm: true },
  appCatalog: { q: 'kurta', sort: 'newest' },
  appCategory: {},
  appReels: { category: 'summer' },
  appOrders: { limit: '10' },
  pushDevice: { token: null, permission: 'not_asked' },
  pushPrefsSave: { offers: false, source: 'settings' },
  pushFollowOrder: { orderToken: 'order-token' },
  appHealth: { updateId: null, runtimeVersion: '1.0.0', event: 'launch' },
};
const SELLER_SAMPLES = {
  'appPublishing.save': { appName: 'Kesar' },
  'appPublishing.builds': {},
  'appPublishing.requestBuild': { platforms: ['android'], requestKey: 'build-request-1' },
  'appListing.save': { title: 'Kesar Home' },
  'storeAccess.save': { legalName: 'Kesar Home Private Limited' },
  'pushCampaigns.list': {},
  'pushCampaigns.send': { title: 'Festive offer', body: 'Ten percent off this week.', requestKey: 'offer-request-1' },
  'pushCredentials.save': {},
};

test('the route rules: under /api/store/app, one address each, reserved first segments, strict inputs with no amount or channel', () => {
  const seen = new Set(Object.values(STORE_ROUTES).map((r) => `${r.method} ${r.path}`));
  for (const [id, route] of Object.entries(APP_ROUTES)) {
    assert.ok(['json', 'page', 'wellknown'].includes(route.kind), id);
    assert.ok(['none', 'app', 'shopper', 'web'].includes(route.auth), id);
    if (route.kind === 'json') assert.ok(route.path.startsWith('/api/store/app/'), `${id} is under /api/store/app/`);
    const key = `${route.method} ${route.path}`;
    assert.equal(seen.has(key), false, `${key} is listed twice`);
    seen.add(key);
    const first = route.path.split('/')[1];
    assert.ok(RESERVED_PATHS.includes(first.toLowerCase()), `"${first}" is reserved (${id})`);
    for (const part of ['body', 'query']) {
      const schema = route[part];
      if (!schema) continue;
      const sample = APP_SAMPLES[id];
      assert.ok(sample, `${id} has a sample ${part}`);
      assert.equal(schema.safeParse(sample).success, true, `${id} takes its sample`);
      for (const field of FORBIDDEN_FIELDS) assert.equal(schema.safeParse({ ...sample, [field]: 1 }).success, false, `${id} refuses ${field}`);
    }
  }
  assert.equal(APP_ROUTES.appSessionStart.body.safeParse({ grant: 'password', device: DEVICE, password: 'x' }).success, false, 'there is no password grant');
  assert.equal(APP_ROUTES.pushPrefsSave.body.safeParse({ source: 'settings' }).success, false, 'at least one toggle');
  assert.equal(APP_ROUTES.pushPrefsSave.body.safeParse({ offers: true, source: 'checkout' }).success, false);
  assert.deepEqual(APP_SORTS, Object.keys(SORTS), 'the app sorts are the catalog\'s');

  for (const id of SELLER_IDS) {
    const route = routes[id];
    for (const part of ['body', 'query']) {
      if (!route[part]) continue;
      const sample = SELLER_SAMPLES[id];
      assert.ok(sample, `${id} has a sample ${part}`);
      assert.equal(route[part].safeParse(sample).success, true, `${id} takes its sample`);
      if (part === 'body') for (const field of [...FORBIDDEN_FIELDS, 'password', 'appleId']) assert.equal(route[part].safeParse({ ...sample, [field]: 'x' }).success, false, `${id} refuses ${field}`);
    }
    assert.ok((route.path.match(/:/g) ?? []).length <= 1 && (!route.path.includes(':') || route.path.includes(':id')), id);
  }
  assert.ok(FRESH_ROUTES.includes('storeAccess.save') && FRESH_ROUTES.includes('pushCredentials.save'), 'writing store keys or push credentials needs a fresh session');
  assert.deepEqual(SELLER_IDS.filter((id) => routes[id].fresh), ['storeAccess.save', 'pushCredentials.save']);
  assert.deepEqual([PlatformParams.safeParse({ id: 'ios' }).success, PlatformParams.safeParse({ id: 'web' }).success, PlatformParams.safeParse({ id: '12' }).success], [true, false, false]);
  for (const id of ['appPublishing.requestBuild', 'storeAccess.save', 'storeAccess.check', 'pushCredentials.get', 'pushCredentials.save']) assert.deepEqual([...routes[id].access.roles], ['owner'], `${id} is the owner's`);

  const client = createApiClient({ fetch: async () => new Response('{}') });
  for (const id of SELLER_IDS) {
    const [group, name] = id.split('.');
    assert.equal(typeof client[group]?.[name], 'function', `the client has ${id}`);
  }
  // App-only coupons (P-63): the seller can mark one; the coupons track maps the column.
  assert.equal(CouponCreate.parse({ code: 'APPONLY', kind: 'flat', amountPaise: 5000 }).appOnly, false);
  assert.equal(CouponCreate.parse({ code: 'APPONLY', kind: 'flat', amountPaise: 5000, appOnly: true }).appOnly, true);
  assert.ok('appOnly' in Coupon.shape);
  // The console's moves name what each needs.
  const move = platformRoutes['platform.setSubmissionState'].body;
  assert.equal(move.safeParse({ to: 'rejected', reason: 'Store review' }).success, false, 'a rejection names its guideline');
  assert.equal(move.safeParse({ to: 'rejected', reason: 'Store review', rejection: { guideline: '4.2.6', message: 'Template app' } }).success, true);
  assert.equal(move.safeParse({ to: 'live', reason: 'Approved' }).success, false, 'live needs the store link');
  assert.equal(platformRoutes['platform.publishOta'].body.safeParse({ runtimeVersion: '1.2', bundleFingerprint: 'fp-12345678', bundleId: 'group-1', bundleHash: 'a'.repeat(64), requestKey: 'publish-0001' }).success, true);
});

/** Every key of every object in a zod schema, through wrappers, arrays, unions and records. */
function fieldNames(schema, out = new Set(), seen = new Set()) {
  if (!schema?._zod || seen.has(schema)) return out;
  seen.add(schema);
  const def = schema._zod.def;
  if (def.type === 'object') for (const [key, child] of Object.entries(def.shape)) { out.add(key); fieldNames(child, out, seen); }
  for (const child of [def.innerType, def.element, def.valueType, def.keyType, def.in, def.out, def.left, def.right, ...(def.options ?? [])]) fieldNames(child, out, seen);
  return out;
}
const PASSWORD_LIKE = /pass(word|code|wd)|^pass$|pwd|secret_plain/i;

test('no Phase 6 schema has a field named like a password', () => {
  const schemas = [
    ...Object.values(APP_ROUTES).flatMap((r) => [r.body, r.query, r.response]),
    ...SELLER_IDS.flatMap((id) => [routes[id].body, routes[id].query, routes[id].response, routes[id].params]),
    ...PLATFORM_IDS.flatMap((id) => [platformRoutes[id].body, platformRoutes[id].query, platformRoutes[id].response]),
    apps.BrandFile,
  ].filter(Boolean);
  const names = new Set();
  for (const schema of schemas) fieldNames(schema, names);
  assert.ok(names.has('privateKey') && names.has('passed'), 'the walk reaches nested fields');
  assert.deepEqual([...names].filter((name) => PASSWORD_LIKE.test(name)), []);
  assert.equal(fieldNames(apps.BrandFile).has('keystore'), false, 'the brand file carries no signing material');
});

test('the order channel is the session\'s: web unless the app gate sets app, and the shopper middleware leaves an app request alone', async () => {
  assert.equal(currentChannel(), 'web');
  assert.equal(await withChannel('app', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return currentChannel();
  }), 'app');
  assert.equal(currentChannel(), 'web');
  assert.throws(() => withChannel('instagram', () => null), /Unknown order channel/);

  const service = { sessions: { shopperFor: async () => { throw new Error('the cookie must not be read'); } } };
  const middleware = shopperSession({ config: {} }, service);
  const shopper = { id: 7, name: 'Asha', method: 'whatsapp_otp' };
  const req = { appSession: { id: 1, guest: false, shopperId: 7 }, shopper, method: 'POST', path: '/api/store/cart', headers: { cookie: '_sid=seller-or-web' }, get: () => '' };
  let nexted = false;
  await middleware(req, { locals: {} }, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(req.shopper, shopper, 'req.shopper is the gate\'s, and no CSRF token is asked for');
});

test('the pure rules: store limits, asset specs, the pre-submit gate, playbooks and the moves', () => {
  // P-56
  const long = apps.listingProblems('android', { title: 'Kesar Home', shortDescription: 'x'.repeat(81), fullDescription: 'Handmade brass and textiles.' });
  assert.deepEqual(long.map((p) => [p.field, p.code, p.limit]), [['shortDescription', 'too_long', 80]]);
  assert.match(long[0].message, /81 characters\. Google Play allows 80\./);
  assert.equal(apps.listingProblems('ios', { title: 'Kesar Home', shortDescription: 'x'.repeat(31), fullDescription: 'y' })[0].limit, 30, 'the App Store subtitle is 30');
  assert.deepEqual(apps.listingProblems('android', { title: '', fullDescription: 'y' }).map((p) => p.field), ['title', 'shortDescription']);
  assert.equal(apps.listingProblems('ios', { title: 'Bhava Shop', fullDescription: 'y' })[0].code, 'names_platform');
  assert.deepEqual(apps.listingLimits('ios'), { title: 30, shortDescription: 30, fullDescription: 4000, keywords: 100, whatsNew: 4000 });
  assert.equal(apps.storeOf('android'), 'play');
  // P-34, P-55
  const alpha = apps.checkAsset('icon_ios', { width: 1024, height: 1024, mime: 'image/png', hasAlpha: true });
  assert.deepEqual(alpha.map((p) => p.code), ['has_alpha']);
  assert.match(alpha[0].message, /App Store icon can’t be transparent/);
  assert.deepEqual(apps.checkAsset('feature_graphic', { width: 1000, height: 500, mime: 'image/png' }).map((p) => p.code), ['wrong_size']);
  assert.deepEqual(apps.checkAsset('feature_graphic', { width: 1024, height: 500, mime: 'image/jpeg' }), []);
  assert.deepEqual(apps.checkAsset('screenshot_iphone_6_9', { width: 1320, height: 2868, mime: 'image/png' }), []);
  assert.deepEqual(apps.checkAsset('screenshot_phone', { width: 1080, height: 2400, mime: 'image/png' }).map((p) => p.code), ['wrong_ratio']);
  assert.deepEqual(apps.checkAsset('icon_play', { width: 512, height: 512, mime: 'image/png', bytes: 2_000_000 }).map((p) => p.code), ['too_large']);
  assert.deepEqual(apps.checkAsset('source_icon', { width: 900, height: 900, mime: 'image/png' }).map((p) => p.code), ['too_small']);
  assert.equal(apps.assetSpecKey('ios', 'icon'), 'icon_ios');
  assert.equal(apps.assetSpecKey('android', 'screenshot', 'phone'), 'screenshot_phone');
  // P-59
  const android = apps.presubmitChecksFor('android');
  const checks = android.map((c) => ({ code: c.code, guideline: c.guideline, passed: true, detail: '' }));
  assert.equal(apps.presubmitPassed('android', checks), true);
  assert.equal(apps.presubmitPassed('android', checks.filter((c) => c.code !== 'account_deletion')), false, 'a missing check fails');
  assert.equal(apps.presubmitPassed('android', checks.map((c) => (c.code === 'account_deletion' ? { ...c, passed: false } : c))), false);
  assert.equal(apps.PRESUBMIT_CHECKS.find((c) => c.code === 'account_deletion').guideline, '5.1.1(v)');
  assert.equal(android.some((c) => c.code === 'privacy_manifest'), false);
  assert.ok(apps.presubmitChecksFor('ios').some((c) => c.code === 'privacy_manifest'), 'P-57');
  assert.equal(apps.ANDROID_TARGET_SDK_MIN, 36);
  // P-58
  assert.deepEqual(['4.2.6', '5.1.1(v)', '4.3(a)', '4.2.3', 'play:target_api', '9.9.9', ''].map((g) => apps.playbookFor(g).code), ['4.2.6', '5.1.1', '4.3', '4.2', 'play_target_api', 'unknown', 'unknown']);
  for (const playbook of Object.values(apps.PLAYBOOKS)) assert.equal(playbook.doc, `docs/playbooks/${playbook.code}.md`);
  assert.equal(apps.guidelineKey('4.3(a)'), '4.3');
  // The moves.
  assert.equal(apps.canMove('app_submission', 'draft', 'in_review'), true);
  assert.equal(apps.canMove('app_submission', 'draft', 'approved'), false, 'no skipping review');
  assert.equal(apps.findAppMove('app_submission', 'rejected', 'in_review').guard, 'presubmit_no_task');
  assert.equal(apps.canMove('ota_release', 'blocked', 'live'), false, 'a blocked release never moves');
  assert.equal(apps.canMove('app_build', 'built', 'submitted'), true);
  assert.deepEqual([apps.nextRollout(10), apps.nextRollout(50), apps.nextRollout(100)], [50, 100, null]);
  for (const machine of apps.APP_MACHINES) assert.equal(new Set(apps.APP_TRANSITIONS[machine].map((m) => `${m.from}>${m.to}`)).size, apps.APP_TRANSITIONS[machine].length, machine);
  assert.deepEqual(apps.APP_ENTITLEMENTS, { android: 'app.android', ios: 'app.ios', includes: ['loyalty'] });
});

test('shopper push: the week and quiet hours in India, nothing personal or platform-named, and every wording passes', () => {
  assert.equal(apps.weekStart(new Date('2026-11-15T18:29:00Z')), '2026-11-09', 'Sunday 23:59 IST is still last week');
  assert.equal(apps.weekStart(new Date('2026-11-15T18:30:00Z')), '2026-11-16', 'Monday 00:00 IST starts a new one');
  assert.equal(apps.inQuietHours(new Date('2026-11-16T15:30:00Z')), true, '21:00 IST');
  assert.equal(apps.inQuietHours(new Date('2026-11-16T03:29:00Z')), true, '08:59 IST');
  assert.equal(apps.inQuietHours(new Date('2026-11-16T03:30:00Z')), false, '09:00 IST');

  const values = { orderNumber: 'MM-100234', category: 'Street wear', slug: 'summer-edit' };
  for (const [kind, wording] of Object.entries(apps.SHOPPER_PUSH_KINDS)) {
    const push = { title: apps.fillPush(wording.title, values), body: apps.fillPush(wording.body, values), data: { link: apps.fillPush(wording.link, values), kind: kind === 'new_reel' ? 'new_reel' : 'order_update' } };
    assert.equal(apps.shopperPushProblem(push), null, kind);
    if (kind !== 'new_reel') assert.ok(ORDER_EVENTS.includes(kind), `${kind} is an order event`);
  }
  const offer = (body, data = { link: '/c/sale', kind: 'offer' }) => apps.shopperPushProblem({ title: 'Festive offer', body, data });
  assert.equal(offer('Ten percent off kurtas this week.'), null);
  assert.equal(offer('Call us on 98765 43210'), 'phone');
  assert.equal(offer('Call us on +91 9876543210'), 'phone');
  assert.equal(offer('Ships to 12 Lake Road today'), 'address');
  assert.equal(offer('Free delivery to 411001'), 'address');
  assert.equal(offer('Pay to asha@okhdfc'), 'payment');
  assert.equal(offer('Card 4111 1111 1111 1111 saved'), 'payment');
  assert.equal(offer('Write to help@shop.example'), 'email');
  assert.equal(offer('A Bhava special'), 'names_platform');
  assert.equal(offer('Shop now', { link: '/admin/orders', kind: 'offer' }), 'link');
  assert.equal(offer('Shop now', { link: 'https://elsewhere.example/', kind: 'offer' }), 'link');
  assert.equal(offer('Shop now', { link: '/c/sale', kind: 'offer', tenantId: 3 }), 'data_keys', 'no business id in a shopper push');
  assert.equal(apps.shopperPushProblem({ title: '', body: 'x', data: { link: '/' } }), 'empty_title');
  assert.equal(apps.shopperPushProblem({ title: 'x'.repeat(66), body: 'x', data: { link: '/' } }), 'title_too_long');
  assert.deepEqual(['/', '/r/summer-edit', '/account/orders/MM-1', '/cart'].map(apps.isAppLinkPath), [true, true, true, true]);
  assert.deepEqual(['/cart/restore/abc', '/api/store/cart', '/r/', '/r/../admin', '/r/x?utm=1', '//evil'].map(apps.isAppLinkPath), [false, false, false, false, false, false]);
  assert.equal(apps.SHOPPER_PUSH_RULES.weeklyCap, 2);
});

test('the brand file: every missing detail is named by its field, and nothing in it is a key', () => {
  const kit = { colors: { primary: '#3B2FC9' } };
  const config = {
    appName: 'Kesar Home', shortName: 'Kesar', shopDomain: 'shop.kesarhome.example', supportEmail: 'help@kesarhome.example', privacyUrl: 'https://shop.kesarhome.example/policies/privacy',
    iconMediaId: '6f1c2a5e-0000-4000-8000-000000000001', urlScheme: 'kesarhome', androidPackage: 'com.kesarhome.shop', iosBundleId: 'com.kesarhome.shop', appleTeamId: 'ABCDE12345',
    playSigningSha256: [Array.from({ length: 32 }, () => 'AB').join(':')],
  };
  assert.deepEqual(apps.brandFileProblems(config, kit, { hosts: ['shop.kesarhome.example'] }), []);
  const noPrivacy = apps.brandFileProblems({ ...config, privacyUrl: '' }, kit, { platforms: ['android'] });
  assert.deepEqual(noPrivacy.map((p) => [p.field, p.code]), [['privacyUrl', 'required']], 'P-33');
  assert.deepEqual(apps.brandFileProblems({ ...config, shopDomain: 'kesar.bhava.example' }, kit, { hosts: ['kesar.bhava.example'] }).map((p) => p.code), ['names_platform'], 'P-31: no platform host');
  assert.deepEqual(apps.brandFileProblems({ ...config, shopDomain: 'elsewhere.example' }, kit, { hosts: ['shop.kesarhome.example'] }).map((p) => p.code), ['not_own_host']);
  assert.deepEqual(apps.brandFileProblems({ ...config, appleTeamId: '' }, kit, { platforms: ['ios'] }).map((p) => [p.field, p.platform]), [['appleTeamId', 'ios']], 'I-03');
  assert.deepEqual(apps.brandFileProblems({ ...config, playSigningSha256: [] }, kit, { platforms: ['android'] }).map((p) => p.field), ['playSigningSha256']);
  const fields = Object.keys(apps.BrandFile.shape);
  assert.deepEqual(fields.filter((f) => /key|token|secret|password|keystore|fingerprint/i.test(f)), []);
  assert.equal(apps.DATA_COLLECTED.some((d) => /payment|card|crash/.test(d.type)), false);
});

/** Source files under a folder, comments removed. */
function sources(dir, keep = () => true) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|jsx)$/.test(entry.name)) {
        const rel = path.relative(repoRoot, full).replaceAll('\\', '/');
        if (keep(rel)) out.push([rel, fs.readFileSync(full, 'utf8')]);
      }
    }
  };
  walk(dir);
  return out;
}
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('one push sender, STORE_LIMITS never imported twice without an alias, and nothing a shopper reaches names the platform', () => {
  const senders = sources(path.join(repoRoot, 'src'))
    .filter(([, text]) => /forCredentials\(/.test(withoutComments(text)))
    .map(([rel]) => rel)
    .filter((rel) => !rel.startsWith('src/modules/notifications/') && !rel.startsWith('src/adapters/push/'));
  assert.deepEqual(senders.filter((rel) => rel !== 'src/modules/shopper-push/sender.js'), [], 'a shopper push goes through shopper-push/sender.js only');

  const twice = [];
  for (const [rel, text] of [...sources(path.join(repoRoot, 'src')), ...sources(path.join(repoRoot, 'test')), ...sources(path.join(repoRoot, 'tools'))]) {
    const plain = new Set();
    for (const [, names, from] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      if (!/contracts\/(apps|orders)\.js$/.test(from)) continue;
      if (names.split(',').map((n) => n.trim()).includes('STORE_LIMITS')) plain.add(from.match(/(apps|orders)\.js$/)[1]);
    }
    if (plain.size === 2) twice.push(rel);
  }
  assert.deepEqual(twice, [], 'import { STORE_LIMITS as LISTING_LIMITS } when a file needs both');

  const contract = fs.readFileSync(path.join(repoRoot, 'src/contracts/apps.js'), 'utf8').split('\n').filter((line) => !line.startsWith('const PLATFORM_WORD = '));
  assert.equal(apps.namesPlatform(withoutComments(contract.join('\n'))), false, 'src/contracts/apps.js');
  assert.equal(apps.namesPlatform(JSON.stringify(APP_ROUTES)), false, 'APP_ROUTES');
  for (const name of P6_MODULES) {
    for (const [rel, text] of sources(path.join(repoRoot, 'src/modules', name))) assert.equal(apps.namesPlatform(withoutComments(text)), false, rel);
  }
  for (const wording of Object.values(apps.SHOPPER_PUSH_KINDS)) assert.equal(apps.namesPlatform(Object.values(wording).join(' ')), false);
});

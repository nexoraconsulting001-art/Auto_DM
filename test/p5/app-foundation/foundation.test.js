// The owner app's foundation (PRD 10.2 to 10.6, 5.11, 5.13; "iOS ready from day one"): the parts that run with the
// server's tests. The app's screens are tested with jest beside the code (npm run test:apps); these load only modules
// that need no React Native, which the server's install does not have, and read the rest as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { QueryClient, dehydrate, onlineManager } from '@tanstack/react-query';
import { NOTIFY_EVENTS } from '../../../src/contracts/notifications.js';
import { routes } from '../../../src/contracts/api/index.js';
import { OfflineError, createOfflineCache, createQueryClient, holdsSecret, scrub } from '../../../packages/app-core/src/cache.js';
import { canOpen } from '../../../packages/app-core/src/access.js';
import { createLinkRouter, pushTarget } from '../../../packages/app-core/src/routing.js';
import { createReauth } from '../../../packages/app-core/src/reauth.js';
import { SESSION_STATUS, createSession } from '../../../packages/app-core/src/session.js';
import { checkCatalogue, shared } from '../../../packages/app-core/src/strings/index.js';
import { formatWhen } from '../../../packages/app-core/src/time.js';
import { contrast, fromBrandKit, hitSlopFor, sellerTheme } from '../../../packages/theme/src/index.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '../../..');
const { readAppFeatures } = require('../../../tools/parity-read.cjs');

const BASE = 'http://localhost:9/api/v1';
const APP = { name: 'owner', version: '1.4.0', platform: 'android' };
const USER = { id: 7, name: 'Asha', phone: '+919800000001', role: 'owner', permissions: [] };
const SHOP_A = { id: 1, slug: 'a', name: 'Shop A', plan: 'growth', logoUrl: '', accountType: 'seller' };
const SHOP_B = { id: 2, slug: 'b', name: 'Shop B', plan: 'free', logoUrl: '', accountType: 'creator' };
const MEMBERSHIPS = [{ id: 1, slug: 'a', name: 'Shop A', role: 'owner', logoUrl: '', current: true }, { id: 2, slug: 'b', name: 'Shop B', role: 'staff', logoUrl: '', current: false }];
const signedIn = { user: USER, business: SHOP_A, businesses: MEMBERSHIPS, accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1' };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** SecureStore as the session uses it, in memory: what `held` holds is all the phone would keep. */
function memoryStore() {
  const held = new Map();
  const get = async (k) => held.get(k) ?? null;
  const put = async (k, v) => (v === null || v === undefined || v === '' ? held.delete(k) : held.set(k, String(v)));
  return {
    held,
    getRefreshToken: () => get('refresh'), setRefreshToken: (v) => put('refresh', v),
    getDeviceSecret: () => get('device_secret'), setDeviceSecret: (v) => put('device_secret', v),
    isLockEnabled: async () => (await get('lock')) === '1', setLockEnabled: (on) => put('lock', on ? '1' : null),
    getTenantId: async () => Number(await get('tenant')) || null, setTenantId: (v) => put('tenant', v),
    getSnapshot: async () => JSON.parse((await get('snapshot')) ?? 'null'), setSnapshot: (v) => put('snapshot', v ? JSON.stringify(v) : null),
    getDeviceId: async () => 'device-0000000000000001',
    clearSession: async () => ['refresh', 'device_secret', 'lock', 'lock_offered', 'tenant', 'snapshot'].forEach((k) => held.delete(k)),
  };
}

/** The API's session rules: access tokens that expire, refresh tokens used once, a family that can be revoked. */
function fakeServer() {
  const server = { calls: [], family: 'alive', refresh: 'r1', access: new Set(['a1']), count: 1 };
  server.fetch = async (url, init = {}) => {
    const p = String(url).replace(BASE, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const token = init.headers?.authorization?.replace('Bearer ', '') ?? null;
    const tenant = Number(init.headers?.['x-tenant-id'] ?? 1);
    server.calls.push({ path: p, token, tenant });
    if (p === '/auth/refresh') {
      if (server.family !== 'alive' || body.refreshToken !== server.refresh) {
        server.family = 'revoked';
        server.access.clear();
        return json(401, { error: 'Sign in again', code: 'unauthorized' });
      }
      server.count++;
      server.refresh = `r${server.count}`;
      server.access = new Set([`a${server.count}`]);
      return json(201, { accessToken: `a${server.count}`, accessExpiresInSeconds: 900, refreshToken: server.refresh });
    }
    if (!token || !server.access.has(token)) return json(401, { error: 'Sign in again', code: 'unauthorized' });
    if (p === '/auth/me') return json(200, { user: USER, business: tenant === 2 ? SHOP_B : SHOP_A, freshUntil: null });
    if (p === '/auth/businesses') return json(200, { businesses: MEMBERSHIPS });
    if (p === '/auth/reauth/verify') return body.code === '654321' ? json(200, { freshUntil: '2099-01-01T00:00:00.000Z' }) : json(401, { error: 'Wrong code', code: 'unauthorized' });
    if (p.startsWith('/orders')) return json(200, { items: [`order of ${tenant}`], nextCursor: null });
    return json(404, { error: 'Not found', code: 'not_found' });
  };
  return server;
}

function setup() {
  const server = fakeServer();
  const store = memoryStore();
  const session = createSession({ baseUrl: BASE, app: APP, store, fetch: server.fetch });
  return { server, store, session };
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function sourceFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(rel);
    return /\.jsx?$/.test(entry.name) ? [rel] : [];
  });
}
const OWNED = ['packages/theme/src', 'packages/ui/src', 'packages/app-core/src', 'apps/owner/src/shell', 'apps/owner/src/features/account', 'apps/owner/src/features/devices', 'apps/owner/src/features/notifications'];
const appSource = () => OWNED.flatMap(sourceFiles).filter((f) => !/\.test\.jsx?$/.test(f) && !f.endsWith('/testing.js')).concat('apps/owner/App.js');
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---- Sessions (10.2) ----

test('P-04 an expired access token gets one silent refresh and one retry, and calls failing together share it', async () => {
  const { server, session, store } = setup();
  await session.adopt(signedIn);
  server.access.clear();
  const [a, b] = await Promise.all([session.api.orders.list(), session.api.orders.list()]);
  assert.deepEqual([a.items, b.items], [['order of 1'], ['order of 1']]);
  assert.equal(server.calls.filter((c) => c.path === '/auth/refresh').length, 1);
  assert.equal(await store.getRefreshToken(), 'r2');
  assert.equal(server.family, 'alive', 'the rotated token was never presented twice');
});

test('P-08 a revoked family signs the phone out on its next check and SecureStore keeps nothing of the session', async () => {
  const { server, session, store } = setup();
  const told = [];
  session.on('signedOut', (why) => told.push(why));
  await session.adopt(signedIn);
  await store.setDeviceSecret('dev-secret');
  await store.setLockEnabled(true);
  server.family = 'revoked';
  server.access.clear();
  await session.check();
  assert.equal(session.getState().status, SESSION_STATUS.signedOut);
  assert.deepEqual(told, ['expired']);
  assert.deepEqual([...store.held.keys()], []);
});

test('F-110 with the lock on, the refresh token is not read until the unlock; then the session opens with no new code', async () => {
  const { server, store, session } = setup();
  await session.adopt(signedIn);
  await store.setLockEnabled(true);
  const relaunched = createSession({ baseUrl: BASE, app: APP, store, fetch: server.fetch });
  server.calls.length = 0;
  assert.equal((await relaunched.start()).status, 'locked');
  await assert.rejects(relaunched.api.auth.me(), { status: 401 });
  assert.equal(server.calls.some((c) => c.path === '/auth/refresh'), false);
  assert.equal((await relaunched.resume()).status, 'signedIn');
  assert.equal(server.calls.some((c) => /\/auth\/(start|verify)$/.test(c.path)), false);
});

test('P-10 a switch tells listeners before the new business is set, so cached lists are dropped first', async () => {
  const { session } = setup();
  await session.adopt(signedIn);
  const seen = [];
  session.on('switch', (id) => seen.push(['switch', id, session.getState().tenantId]));
  await session.switchBusiness(2);
  assert.deepEqual(seen, [['switch', 2, 1]]);
  assert.deepEqual((await session.api.orders.list()).items, ['order of 2']);
  await assert.rejects(session.switchBusiness(9), /not one of yours/);
});

test('no phone number or token is kept in the session state or on the device', async () => {
  const { session, store } = setup();
  await session.adopt(signedIn);
  await session.refreshUser();
  const everything = JSON.stringify([session.getState(), [...store.held.entries()].filter(([k]) => k !== 'refresh')]);
  for (const secret of [USER.phone, '"a1"', 'accessToken']) assert.equal(everything.includes(secret), false, secret);
});

test('P-17 a wrong re-auth code is a wrong code, not a lost session; the right one makes the session fresh', async () => {
  const { session, store } = setup();
  await session.adopt(signedIn);
  const reauth = createReauth({ session, store, lock: { available: async () => false, unlock: async () => ({ ok: false, reason: 'unavailable' }) } });
  await assert.rejects(reauth.withCode('111111'), { status: 401 });
  assert.equal(session.getState().status, 'signedIn');
  assert.deepEqual(await reauth.withCode('654321'), { ok: true, reason: null });
  assert.equal(session.isFresh(), true);
});

// ---- Taps and links (10.3, 10.5) ----

test('P-13 a push for another business switches first and opens only in that business’s navigation', async () => {
  const { session } = setup();
  await session.adopt(signedIn);
  const router = createLinkRouter({ session });
  const opened = [];
  router.attach((p) => opened.push(['A', p]), 1);
  const tap = { actionIdentifier: 'default', notification: { date: 1, request: { identifier: 'n-1', content: { data: { tenantId: 2, link: '/orders/12', kind: 'order.new' } } } } };
  assert.equal(await router.openPush(tap), 'pending');
  assert.equal(session.getState().tenantId, 2);
  router.attach((p) => opened.push(['B', p]), 2);
  assert.deepEqual(opened, [['B', '/orders/12']]);
  assert.equal(await router.openPush(tap), 'repeat');
  assert.equal(pushTarget({ notification: { request: { content: { data: { tenantId: 2, link: 'https://evil.example' } } } } }), null);
});

test('every account notice the server sends links to a screen this app has', () => {
  const screens = readAppScreens();
  for (const kind of ['device.signed_in', 'account.deletion_requested']) {
    const link = NOTIFY_EVENTS[kind].link;
    assert.ok(screens.includes(link.slice(1)), `${kind} links to ${link}, which some screen must open`);
  }
  assert.ok(screens.includes('notifications'));
});

function readAppScreens() {
  return ['account', 'devices', 'notifications'].flatMap((name) => [...read(`apps/owner/src/features/${name}/index.js`).matchAll(/path: '([^']*)'/g)].map((m) => m[1]));
}

// ---- The offline cache (10.4) ----

test('P-19 a change made offline fails at once and is never kept to be sent later', async () => {
  onlineManager.setOnline(false);
  try {
    const client = createQueryClient();
    let sent = 0;
    await assert.rejects(client.getMutationCache().build(client, { mutationFn: async () => sent++ }).execute({}), OfflineError);
    const cache = createOfflineCache({ storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }, getTenantId: () => 1 });
    assert.deepEqual(dehydrate(client, cache.persistOptions.dehydrateOptions).mutations, []);
    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent, 0);
    client.clear();
  } finally {
    onlineManager.setOnline(true);
  }
});

test('P-10 the saved rows are kept per business, and a switch’s empty cache never overwrites the old one', async () => {
  const items = new Map();
  const storage = { getItem: async (k) => items.get(k) ?? null, setItem: async (k, v) => void items.set(k, v), removeItem: async (k) => void items.delete(k) };
  let tenantId = 1;
  const cache = createOfflineCache({ storage, getTenantId: () => tenantId, throttleMs: 1, buster: 'b' });
  const source = new QueryClient();
  source.setQueryData(['orders'], { items: ['A-1'] });
  cache.persister.persistClient({ timestamp: Date.now(), buster: 'b', clientState: dehydrate(source) });
  await cache.flush();
  cache.persister.persistClient({ timestamp: Date.now(), buster: 'b', clientState: { queries: [], mutations: [] } });
  await cache.flush();
  tenantId = 2;
  const forB = new QueryClient();
  assert.equal(await cache.restoreInto(forB), 0);
  tenantId = 1;
  const forA = new QueryClient();
  assert.equal(await cache.restoreInto(forA), 1);
  assert.deepEqual(forA.getQueryData(['orders']), { items: ['A-1'] });
  await cache.clearAll();
  assert.equal(items.size, 0);
  for (const c of [source, forA, forB]) c.clear();
});

test('no token, one-time code or phone number reaches the query cache', () => {
  const answer = { accessToken: 'a', refreshToken: 'r', deviceSecret: 's', items: [{ phone: '+919876543210', coupon: { code: 'DIWALI20' }, otp: '123456' }], verify: { code: '654321' } };
  assert.equal(holdsSecret(answer), true);
  const clean = scrub(answer);
  assert.equal(holdsSecret(clean), false);
  assert.deepEqual(clean, { items: [{ phone: '+91 ••••• •3210', coupon: { code: 'DIWALI20' } }], verify: {} });
  const client = createQueryClient();
  client.setQueryData(['x'], answer);
  assert.equal(JSON.stringify(client.getQueryData(['x'])).includes('9876543210'), false);
  client.clear();
});

// ---- Access (10.3) ----

test('P-12 and P-69 a screen opens by role, permission, plan and account type, from the server’s own rules', () => {
  const staff = { role: 'staff', permissions: ['orders'] };
  const payments = { access: routes['paymentSettings.get']?.access ?? { roles: ['owner', 'manager'] } };
  assert.equal(canOpen(payments, { user: staff }), false);
  const creatorOnly = { access: { signedIn: true }, nav: { label: 'x', order: 1, accountTypes: ['creator'] } };
  assert.equal(canOpen(creatorOnly, { user: staff, accountType: 'creator' }), true);
  assert.equal(canOpen(creatorOnly, { user: staff, accountType: 'seller' }), false);
});

// ---- Parity (10.4) ----

test('Devices, notifications and Your account cover their routes, and the allowance file no longer lists them', () => {
  const found = readAppFeatures(ROOT);
  assert.deepEqual(found.problems, []);
  const byName = Object.fromEntries(found.features.map((f) => [f.name, f.routeIds]));
  assert.deepEqual(byName.devices, ['auth.devices', 'auth.revokeDevice']);
  assert.deepEqual(byName.notifications, ['notifications.list', 'notifications.markRead', 'notifications.prefs', 'notifications.savePrefs']);
  assert.deepEqual(byName.account, ['auth.enableDeviceUnlock', 'auth.linkIdentity', 'auth.reauthStart', 'auth.reauthVerify', 'auth.deleteAccount']);
  const pending = JSON.parse(read('tools/parity-pending.json'));
  for (const id of [...byName.devices, ...byName.notifications, ...byName.account]) {
    assert.ok(routes[id], `${id} is a route`);
    assert.equal(pending.routes.includes(id), false, `${id} is mapped, so it is gone from the allowance`);
  }
});

// ---- Brand, words and design (10.6, iOS from day one) ----

test('P-67 the shared words and components name no business and no platform; the owner app names itself', () => {
  assert.deepEqual(checkCatalogue(shared), []);
  for (const lines of Object.values(shared)) assert.doesNotMatch(Object.values(lines).join(' '), /bhava|भाव/i);
  for (const file of sourceFiles('packages/ui/src').filter((f) => !f.endsWith('.test.js'))) {
    assert.doesNotMatch(withoutComments(read(file)).replace(/from '@bhava\/[\w-]+'/g, ''), /bhava/i, file);
  }
  assert.match(read('apps/owner/src/shell/TopBar.js'), /accessibilityLabel=\{APP_NAME\}/, 'the top bar carries the platform’s own mark');
  assert.match(read('apps/owner/src/shell/BusinessBadge.js'), /WorkspaceBadge/, 'a business logo is drawn only inside the workspace badge');
  const logoUses = appSource().filter((f) => /logoUrl/.test(withoutComments(read(f))));
  assert.deepEqual(logoUses.sort(), ['apps/owner/src/shell/BusinessBadge.js'], 'only the workspace badge reads a business’s logo');
});

test('I-01 every component is cross-platform: no Android-only or iOS-only module, no web view, no colour written out', () => {
  for (const file of appSource()) {
    const text = withoutComments(read(file));
    assert.doesNotMatch(text, /ToastAndroid|PermissionsAndroid|DrawerLayoutAndroid|ActionSheetIOS|DatePickerIOS|ProgressBarAndroid/, file);
    assert.doesNotMatch(text, /react-native-webview|<WebView|WebView\b/, `${file}: Google and Instagram open in the system browser, never a web view`);
    if (file.startsWith('packages/ui/')) assert.equal(text.replace(/from '@bhava\/[\w-]+'/g, '').match(/#[0-9a-fA-F]{3,8}\b/g), null, file);
  }
  assert.match(read('apps/owner/src/shell/sign-in.js'), /openAuthSessionAsync/);
  for (const dir of ['apps/owner', 'packages/ui', 'packages/app-core', 'packages/theme']) {
    const pkg = JSON.parse(read(`${dir}/package.json`));
    assert.equal(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }).some((n) => /webview/i.test(n)), false, dir);
  }
});

test('nothing in the app logs, so no token, code or phone number can reach a log', () => {
  for (const file of appSource()) assert.doesNotMatch(withoutComments(read(file)), /\bconsole\.(log|info|warn|error|debug)\b/, file);
  for (const file of appSource()) assert.doesNotMatch(withoutComments(read(file)), /async-storage|AsyncStorage|localStorage/, file);
});

test('every control is a full tap target and the charts and states use the theme', () => {
  assert.ok(sellerTheme.tap.min >= 44);
  assert.deepEqual(hitSlopFor(32), { top: 6, bottom: 6, left: 6, right: 6 });
  const brand = fromBrandKit({ colors: { primary: '#0a7a55', ground: '#fffaf0' } });
  assert.deepEqual(Object.keys(brand).sort(), Object.keys(sellerTheme).sort());
  assert.equal(brand.chart.line, '#0a7a55');
  assert.ok(contrast(sellerTheme.color.ink, sellerTheme.color.ground) > 4.5);
  for (const file of ['packages/ui/src/controls.js', 'packages/ui/src/basics.js']) assert.match(read(file), /tap\.(min|large)/, file);
});

test('times read as people say them', () => {
  const t = (key, values = {}) => shared.en[key].replace(/\{(\w+)\}/g, (_m, k) => values[k]);
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(formatWhen(t, '2026-11-12T11:59:40Z', { now }), 'Just now');
  assert.equal(formatWhen(t, '2026-11-12T11:55:00Z', { now }), '5 min ago');
  assert.equal(formatWhen(t, '2026-11-12T09:00:00Z', { now }), '3 h ago');
  assert.equal(formatWhen(t, 'not a date', { now }), '');
});

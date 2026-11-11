import * as SecureStore from 'expo-secure-store';
import { SESSION_STATUS, createSession } from './session.js';
import { createSecureStore } from './storage.js';

const BASE = 'http://localhost:9/api/v1';
const APP = { name: 'owner', version: '1.4.0', platform: 'android' };
const USER = { id: 7, name: 'Asha', phone: '+919800000001', role: 'owner', permissions: [] };
const SHOP_A = { id: 1, slug: 'a', name: 'Shop A', plan: 'growth', logoUrl: '', accountType: 'seller' };
const SHOP_B = { id: 2, slug: 'b', name: 'Shop B', plan: 'free', logoUrl: '', accountType: 'creator' };
const MEMBERSHIPS = [
  { id: 1, slug: 'a', name: 'Shop A', role: 'owner', logoUrl: '', current: true },
  { id: 2, slug: 'b', name: 'Shop B', role: 'staff', logoUrl: '', current: false },
];

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/**
 * A stand-in for the API's session rules: access tokens that expire, refresh tokens that rotate and are single use,
 * and reuse of a rotated one ending the family.
 */
function fakeServer() {
  const server = { calls: [], family: 'alive', refresh: 'r1', access: new Set(['a1']), count: 1, down: false, refreshDelay: null, orders: { 1: ['A-1'], 2: ['B-1'] } };
  server.fetch = async (url, init = {}) => {
    const path = String(url).replace(BASE, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const token = init.headers?.authorization?.replace('Bearer ', '') ?? null;
    server.calls.push({ method: init.method, path, token, tenant: init.headers?.['x-tenant-id'] ?? null, app: init.headers?.['x-app'], body });
    if (server.down) throw new TypeError('Network request failed');
    if (path === '/auth/refresh') {
      if (server.refreshDelay) await server.refreshDelay;
      if (server.family !== 'alive') return json(401, { error: 'Sign in again', code: 'unauthorized' });
      if (body.refreshToken !== server.refresh) {
        server.family = 'revoked'; // a rotated token came back: the whole family ends
        server.access.clear();
        return json(401, { error: 'Sign in again', code: 'unauthorized' });
      }
      server.count++;
      server.refresh = `r${server.count}`;
      server.access = new Set([`a${server.count}`]);
      return json(201, { accessToken: `a${server.count}`, accessExpiresInSeconds: 900, refreshToken: server.refresh });
    }
    if (!token || !server.access.has(token)) return json(401, { error: 'Sign in again', code: 'unauthorized' });
    const tenant = Number(init.headers?.['x-tenant-id'] ?? 1);
    if (path === '/auth/me') return json(200, { user: USER, business: tenant === 2 ? SHOP_B : SHOP_A, freshUntil: null });
    if (path === '/auth/businesses') return json(200, { businesses: MEMBERSHIPS });
    if (path === '/auth/logout') return json(204, null);
    if (path.startsWith('/orders')) return json(200, { items: server.orders[tenant], nextCursor: null });
    if (/payment/.test(path)) return json(403, { error: 'Confirm it’s you', code: 'reauth_required' });
    return json(404, { error: 'Not found', code: 'not_found' });
  };
  return server;
}

const signedIn = { user: USER, business: SHOP_A, businesses: MEMBERSHIPS, accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1' };

function setup({ clock = { now: 1_000_000 } } = {}) {
  SecureStore.__reset();
  const server = fakeServer();
  const store = createSecureStore({ prefix: 'bhava.owner' });
  const session = createSession({ baseUrl: BASE, app: APP, store, fetch: server.fetch, now: () => clock.now, deviceName: 'Pixel 8' });
  return { server, store, session, clock };
}

test('an expired access token gets one silent refresh and the call is repeated once', async () => {
  const { server, session, store } = setup();
  await session.adopt(signedIn);
  server.access.clear(); // the server has stopped accepting a1
  const page = await session.api.orders.list();
  expect(page.items).toEqual(['A-1']);
  expect(server.calls.map((c) => `${c.path} ${c.token ?? '-'}`)).toEqual(['/orders a1', '/auth/refresh -', '/orders a2']);
  expect(await store.getRefreshToken()).toBe('r2');
});

test('calls that fail together share one refresh, so a refresh token is never presented twice', async () => {
  const { server, session } = setup();
  await session.adopt(signedIn);
  server.access.clear();
  let release;
  server.refreshDelay = new Promise((resolve) => { release = resolve; });
  const all = Promise.all([session.api.orders.list(), session.api.orders.list(), session.api.orders.list()]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  const pages = await all;
  expect(pages.every((p) => p.items[0] === 'A-1')).toBe(true);
  expect(server.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  expect(server.family).toBe('alive');
});

test('a token about to expire is renewed before the call goes out', async () => {
  const { server, session, clock } = setup();
  await session.adopt(signedIn);
  clock.now += 895_000;
  await session.api.orders.list();
  expect(server.calls.map((c) => c.path)).toEqual(['/auth/refresh', '/orders']);
  expect(server.calls[1].token).toBe('a2');
});

test('a refresh the server refuses signs the person out and wipes the stored session', async () => {
  const { server, session, store } = setup();
  await session.adopt(signedIn);
  await store.setLockEnabled(true);
  const reasons = [];
  session.on('signedOut', (reason) => reasons.push(reason));
  server.family = 'revoked'; // the device was revoked, or the account removed
  server.access.clear();
  await expect(session.api.orders.list()).rejects.toMatchObject({ status: 401 });
  expect(session.getState().status).toBe(SESSION_STATUS.signedOut);
  expect(reasons).toEqual(['expired']);
  expect(await store.getRefreshToken()).toBeNull();
  expect(await store.isLockEnabled()).toBe(false);
  expect(server.calls.filter((c) => c.path === '/orders')).toHaveLength(1); // not retried without a token
});

test('with no connection nothing is forgotten, and a restart opens on what was known', async () => {
  const first = setup();
  await first.session.adopt(signedIn);
  const server = fakeServer();
  server.down = true;
  const session = createSession({ baseUrl: BASE, app: APP, store: first.store, fetch: server.fetch });
  const state = await session.start();
  expect(state).toMatchObject({ status: SESSION_STATUS.signedIn, offline: true, tenantId: 1 });
  expect(state.business.name).toBe('Shop A');
  expect(await first.store.getRefreshToken()).toBe('r1');
  await expect(session.api.orders.list()).rejects.toMatchObject({ status: 0, code: 'network' });
  expect(session.getState().status).toBe(SESSION_STATUS.signedIn);
});

test('a restart refreshes first, stores the new refresh token, then asks who and where', async () => {
  const first = setup();
  await first.session.adopt(signedIn);
  const session = createSession({ baseUrl: BASE, app: APP, store: first.store, fetch: first.server.fetch });
  first.server.calls.length = 0;
  const state = await session.start();
  expect(state).toMatchObject({ status: SESSION_STATUS.signedIn, tenantId: 1, offline: false });
  expect(first.server.calls[0].path).toBe('/auth/refresh');
  expect(await first.store.getRefreshToken()).toBe('r2');
  expect(state.businesses.map((b) => b.id)).toEqual([1, 2]);
});

test('with the lock on, a restart waits for the unlock before the refresh token is used', async () => {
  const first = setup();
  await first.session.adopt(signedIn);
  await first.store.setLockEnabled(true);
  const session = createSession({ baseUrl: BASE, app: APP, store: first.store, fetch: first.server.fetch });
  first.server.calls.length = 0;
  expect((await session.start()).status).toBe(SESSION_STATUS.locked);
  expect(first.server.calls).toHaveLength(0);
  expect((await session.resume()).status).toBe(SESSION_STATUS.signedIn);
});

test('with nothing stored the app starts signed out and calls nothing', async () => {
  const { server, session } = setup();
  expect((await session.start()).status).toBe(SESSION_STATUS.signedOut);
  expect(server.calls).toHaveLength(0);
});

test('switching business tells listeners first, then every call names the new business', async () => {
  const { server, session, store } = setup();
  await session.adopt(signedIn);
  const heard = [];
  session.on('switch', (id) => heard.push([id, session.getState().tenantId]));
  await session.switchBusiness(2);
  expect(heard).toEqual([[2, 1]]); // told while the old business was still current, so its rows can be dropped
  expect(session.getState()).toMatchObject({ tenantId: 2, business: { name: 'Shop B' } });
  expect((await session.api.orders.list()).items).toEqual(['B-1']);
  expect(server.calls.at(-1).tenant).toBe('2');
  expect(await store.getTenantId()).toBe(2);
});

test('a business that is not one of the person’s cannot be switched to', async () => {
  const { server, session } = setup();
  await session.adopt(signedIn);
  server.calls.length = 0;
  await expect(session.switchBusiness(3)).rejects.toThrow(/not one of yours/);
  expect(server.calls).toHaveLength(0);
  expect(session.getState().tenantId).toBe(1);
});

test('update required and re-auth required are reported to the app', async () => {
  const { server, session } = setup();
  await session.adopt(signedIn);
  const asked = [];
  session.on('reauth', (error) => asked.push(error.code));
  await expect(session.api.paymentSettings.get()).rejects.toMatchObject({ code: 'reauth_required' });
  expect(asked).toEqual(['reauth_required']);

  const real = server.fetch;
  server.fetch = async () => json(426, { error: 'Update required', code: 'update_required', storeUrl: 'https://play.google.com/store/apps/details?id=x' });
  const old = createSession({ baseUrl: BASE, app: APP, store: createSecureStore({ prefix: 'bhava.owner' }), fetch: (...args) => server.fetch(...args) });
  await old.adopt(signedIn);
  await expect(old.api.orders.list()).rejects.toMatchObject({ status: 426 });
  expect(old.getState().updateRequired).toEqual({ storeUrl: 'https://play.google.com/store/apps/details?id=x' });
  server.fetch = real;
});

test('every call carries the app, its version and its platform', async () => {
  const { server, session } = setup();
  await session.adopt(signedIn);
  await session.api.orders.list();
  expect(server.calls.at(-1)).toMatchObject({ app: 'owner', tenant: '1' });
  expect(await session.device()).toMatchObject({ name: 'Pixel 8', platform: 'android', app: 'owner', appVersion: '1.4.0' });
});

test('signing out tells the server, then forgets everything but the device id', async () => {
  const { server, session, store } = setup();
  await session.adopt(signedIn);
  const deviceId = await store.getDeviceId();
  await session.signOut();
  expect(server.calls.at(-1).path).toBe('/auth/logout');
  expect(session.getState()).toMatchObject({ status: SESSION_STATUS.signedOut, user: null, business: null, tenantId: null });
  expect(Object.keys(SecureStore.__dump())).toEqual(['bhava.owner.device_id']);
  expect(await store.getDeviceId()).toBe(deviceId);
});

test('tokens are written to SecureStore, tied to this device, and nowhere else', async () => {
  const { session, store } = setup();
  await session.adopt(signedIn);
  expect(SecureStore.__dump()['bhava.owner.refresh']).toBe('r1');
  expect(SecureStore.__options.get('bhava.owner.refresh')).toEqual({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  const held = JSON.stringify(SecureStore.__dump());
  expect(held).not.toContain('a1'); // the access token is never stored
  expect(JSON.parse(SecureStore.__dump()['bhava.owner.snapshot']).user).toEqual({ id: 7, name: 'Asha', role: 'owner', permissions: [] }); // no phone number
  expect(await store.getDeviceId()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
});

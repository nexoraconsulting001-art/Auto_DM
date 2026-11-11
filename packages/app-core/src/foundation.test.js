import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { QueryClient, dehydrate, onlineManager, useMutation } from '@tanstack/react-query';
import { canOpen, SIGNED_IN, staffWith } from './access.js';
import { OfflineError, createOfflineCache, createQueryClient, holdsSecret, maskPhoneNumber, scrub, useOnline, watchConnection } from './cache.js';
import { watchLinks } from './links.js';
import { createLock } from './lock.js';
import { LockOffer, ReauthProvider, useReauth } from './prompts.js';
import { configurePush, watchPushTaps, watchPushToken } from './push.js';
import { createReauth, enrollDeviceUnlock } from './reauth.js';
import { createLinkRouter, tapId } from './routing.js';
import { LockScreen, errorKey } from './screens.js';
import { SESSION_STATUS, createSession } from './session.js';
import { SESSION_KEYS, createSecureStore } from './storage.js';
import { StringsProvider, createStrings, shared } from './strings/index.js';

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
const flushAll = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** The API's session rules in small: access tokens that expire, refresh tokens used once, families that can be revoked. */
function fakeServer() {
  const server = { calls: [], family: 'alive', refresh: 'r1', access: new Set(['a1']), count: 1, down: false, members: new Set([1, 2]), user: USER, rejectAccessAfterRefresh: false };
  server.fetch = async (url, init = {}) => {
    const path = String(url).replace(BASE, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const token = init.headers?.authorization?.replace('Bearer ', '') ?? null;
    const tenant = init.headers?.['x-tenant-id'] ? Number(init.headers['x-tenant-id']) : null;
    server.calls.push({ method: init.method, path, token, tenant, body });
    if (server.down) throw new TypeError('Network request failed');
    if (path === '/auth/refresh') {
      if (server.family !== 'alive' || body.refreshToken !== server.refresh) {
        server.family = 'revoked';
        server.access.clear();
        return json(401, { error: 'Sign in again', code: 'unauthorized' });
      }
      server.count++;
      server.refresh = `r${server.count}`;
      server.access = server.rejectAccessAfterRefresh ? new Set() : new Set([`a${server.count}`]);
      return json(201, { accessToken: `a${server.count}`, accessExpiresInSeconds: 900, refreshToken: server.refresh });
    }
    if (!token || !server.access.has(token)) return json(401, { error: 'Sign in again', code: 'unauthorized' });
    if (tenant && !server.members.has(tenant)) return json(403, { error: 'Not yours', code: 'forbidden' });
    const business = (tenant ?? 1) === 2 ? SHOP_B : SHOP_A;
    if (path === '/auth/me') return json(200, { user: server.user, business, freshUntil: null });
    if (path === '/auth/businesses') return json(200, { businesses: MEMBERSHIPS.filter((m) => server.members.has(m.id)) });
    if (path === '/auth/logout') return json(204, null);
    if (path === '/auth/reauth/verify') return body.deviceSecret === 'dev-secret' || body.code === '654321' ? json(200, { freshUntil: '2099-01-01T00:00:00.000Z' }) : json(401, { error: 'No', code: 'unauthorized' });
    if (path === '/auth/reauth/start') return json(202, { sent: true, channel: 'whatsapp', expiresInSeconds: 300, resendInSeconds: 30 });
    if (path === '/auth/device-unlock') return json(201, { deviceSecret: 'dev-secret' });
    return json(404, { error: 'Not found', code: 'not_found' });
  };
  return server;
}

const signedIn = { user: USER, business: SHOP_A, businesses: MEMBERSHIPS, accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1' };

function setup({ now = () => 1_000_000 } = {}) {
  SecureStore.__reset();
  const server = fakeServer();
  const store = createSecureStore({ prefix: 'bhava.owner' });
  const session = createSession({ baseUrl: BASE, app: APP, store, fetch: server.fetch, now, deviceName: 'Pixel 8' });
  return { server, store, session };
}

const sessionKeysHeld = () => Object.keys(SecureStore.__dump()).filter((key) => SESSION_KEYS.some((name) => key === `bhava.owner.${name}`));

describe('the session', () => {
  test('P-04 an expired access token gets one silent refresh and one retry, and a second refusal ends the session', async () => {
    const { server, session, store } = setup();
    await session.adopt(signedIn);
    server.access.clear(); // a1 has expired on the server
    expect(await session.api.auth.businesses()).toMatchObject({ businesses: expect.any(Array) });
    expect(server.calls.map((c) => c.path)).toEqual(['/auth/businesses', '/auth/refresh', '/auth/businesses']);
    expect(await store.getRefreshToken()).toBe('r2');

    server.access.clear();
    server.rejectAccessAfterRefresh = true; // the new token is refused too: the session is gone
    await expect(session.api.auth.businesses()).rejects.toMatchObject({ status: 401 });
    expect(server.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(2); // still one refresh for this call
    expect(session.getState().status).toBe(SESSION_STATUS.signedOut);
    expect(sessionKeysHeld()).toEqual([]);
  });

  test('P-08 a revoked device is signed out by the next check, and SecureStore keeps nothing of the session', async () => {
    const { server, session, store } = setup();
    const told = [];
    session.on('signedOut', (why) => told.push(why));
    await session.adopt(signedIn);
    await store.setDeviceSecret('dev-secret');
    await store.setLockEnabled(true);
    expect(sessionKeysHeld().length).toBeGreaterThan(0);

    server.family = 'revoked'; // Settings > Devices on another phone
    server.access.clear();
    await session.check();
    expect(session.getState()).toMatchObject({ status: 'signedOut', user: null, business: null, businesses: [], tenantId: null, signedOutReason: 'expired' });
    expect(told).toEqual(['expired']);
    expect(sessionKeysHeld()).toEqual([]);
    expect(await store.getDeviceId()).toMatch(/^[A-Za-z0-9_-]{16,64}$/); // the phone's own id is no secret and stays
  });

  test('F-110 while locked the refresh token is never read; after the unlock the stored session opens with no new code', async () => {
    const { server, session, store } = setup();
    await session.adopt(signedIn);
    await store.setLockEnabled(true);
    const relaunched = createSession({ baseUrl: BASE, app: APP, store, fetch: server.fetch });
    server.calls.length = 0;
    expect((await relaunched.start()).status).toBe('locked');
    expect(relaunched.getState().business).toMatchObject({ id: 1 }); // the workspace badge can show on the lock screen

    // Anything that tries to call while locked goes out with no token, and the token stays where it is.
    await expect(relaunched.api.auth.me()).rejects.toMatchObject({ status: 401 });
    expect(server.calls.some((c) => c.path === '/auth/refresh')).toBe(false);
    expect(server.calls.every((c) => c.token === null)).toBe(true);
    expect(relaunched.getState().status).toBe('locked');

    expect((await relaunched.resume()).status).toBe('signedIn'); // what the lock screen runs after a pass
    expect(server.calls.map((c) => c.path)).toEqual(['/auth/me', '/auth/refresh', '/auth/me', '/auth/businesses']);
    expect(server.calls.some((c) => /\/auth\/(start|verify)/.test(c.path))).toBe(false);
  });

  test('the check picks up a changed role, and no connection only marks the app offline', async () => {
    const { server, session } = setup();
    await session.adopt(signedIn);
    server.user = { ...USER, role: 'manager' };
    await session.check();
    expect(session.getState().user.role).toBe('manager');
    server.down = true;
    await session.check();
    expect(session.getState()).toMatchObject({ status: 'signedIn', offline: true });
    server.down = false;
    await session.check();
    expect(session.getState().offline).toBe(false);
  });

  test('removed from the business in use, the check drops it first and opens the one the sign-in belongs to', async () => {
    const { server, session } = setup();
    const switches = [];
    session.on('switch', (id) => switches.push(id));
    await session.adopt(signedIn);
    await session.switchBusiness(2);
    server.members.delete(2);
    await session.check();
    expect(switches).toEqual([2, null]);
    expect(session.getState()).toMatchObject({ status: 'signedIn', tenantId: 1, business: { id: 1 } });
    expect(session.getState().businesses.map((b) => b.id)).toEqual([1]);
  });

  test('no phone number or token is held in the session state or written to SecureStore', async () => {
    const { session } = setup();
    await session.adopt(signedIn);
    await session.refreshUser();
    expect(JSON.stringify(session.getState())).not.toContain(USER.phone);
    const held = JSON.stringify(SecureStore.__dump());
    expect(held).not.toContain(USER.phone);
    expect(held).not.toContain('"a1"');
    expect(held).not.toMatch(/accessToken/);
  });

  test('a sign-out the server cannot hear leaves the person signed in, never shown as signed out while the session works', async () => {
    const { server, session } = setup();
    await session.adopt(signedIn);
    server.down = true;
    await expect(session.signOut({ requireServer: true })).rejects.toMatchObject({ status: 0 });
    expect(session.getState().status).toBe('signedIn');
    expect(sessionKeysHeld().length).toBeGreaterThan(0);
    server.down = false;
    server.access.clear(); // ended on the server already (a revoke): forgotten here, no error
    server.family = 'revoked';
    await session.signOut({ requireServer: true });
    expect(session.getState().status).toBe('signedOut');
    expect(sessionKeysHeld()).toEqual([]);
  });

  test('signing out says why, for the sign-in screen', async () => {
    const { session } = setup();
    await session.adopt(signedIn);
    await session.signOut({ reason: 'account_deleted' });
    expect(session.getState().signedOutReason).toBe('account_deleted');
    await session.adopt(signedIn);
    await session.signOut();
    expect(session.getState().signedOutReason).toBe('signed_out');
  });
});

describe('what a tap or a link opens', () => {
  function fakeSession({ status = 'signedIn', tenantId = 1, businesses = [{ id: 1 }, { id: 2 }] } = {}) {
    let state = { status, tenantId, businesses, user: status === 'signedIn' ? { id: 7 } : null };
    const listeners = new Set();
    const steps = [];
    const set = (patch) => {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l(state);
    };
    return {
      steps,
      set,
      getState: () => state,
      subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
      switchBusiness: jest.fn(async (id) => {
        steps.push(`switch ${id}`);
        set({ tenantId: id, user: null });
        await Promise.resolve();
        set({ user: { id: 7 } });
      }),
    };
  }
  const tap = (data, identifier = 'n-1') => ({ actionIdentifier: 'default', notification: { date: 1, request: { identifier, content: { data } } } });

  test('P-13 a push for another business switches first, and the record opens only in that business’s screens', async () => {
    const session = fakeSession();
    const router = createLinkRouter({ session });
    const inA = jest.fn();
    router.attach(inA, 1);
    const result = router.openPush(tap({ tenantId: 2, link: '/orders/12', kind: 'order.new' }));
    await flushAll();
    expect(session.steps).toEqual(['switch 2']);
    expect(await result).toBe('pending'); // business A's screens are on their way out
    expect(inA).not.toHaveBeenCalled();
    const inB = jest.fn((path) => session.steps.push(`open ${path}`));
    router.attach(inB, 2); // business B's navigation is ready
    expect(session.steps).toEqual(['switch 2', 'open /orders/12']);
    expect(inA).not.toHaveBeenCalled();
  });

  test('a push in the business already open opens at once, and the same tap handed back again opens nothing', async () => {
    const session = fakeSession();
    const router = createLinkRouter({ session });
    const navigate = jest.fn();
    router.attach(navigate, 1);
    expect(await router.openPush(tap({ tenantId: 1, link: '/orders/3' }, 'n-7'))).toBe('opened');
    expect(await router.openPush(tap({ tenantId: 1, link: '/orders/3' }, 'n-7'))).toBe('repeat');
    expect(navigate.mock.calls).toEqual([['/orders/3']]);
    expect(session.switchBusiness).not.toHaveBeenCalled();
    expect(tapId({})).toBeNull();
  });

  test('a business the person is not in, a bad link and another app’s scheme open nothing and switch nothing', async () => {
    const session = fakeSession();
    const router = createLinkRouter({ session });
    const navigate = jest.fn();
    router.attach(navigate, 1);
    expect(await router.openPush(tap({ tenantId: 9, link: '/orders/1' }, 'a'))).toBe('not_member');
    expect(await router.openPush(tap({ tenantId: 1, link: 'https://evil.example/' }, 'b'))).toBe('ignored');
    expect(await router.openUrl('otherapp://orders/1')).toBe('ignored');
    expect(await router.openUrl('bhavabusiness://auth/callback?code=abc')).toBe('ignored');
    expect(navigate).not.toHaveBeenCalled();
    expect(session.switchBusiness).not.toHaveBeenCalled();
    expect(await router.openUrl('bhavabusiness://settings/devices?tenantId=2')).toBe('pending');
    expect(session.switchBusiness).toHaveBeenCalledWith(2);
  });

  test('a tap while locked waits for the unlock, and one before sign-out is dropped', async () => {
    const session = fakeSession({ status: 'locked' });
    const router = createLinkRouter({ session });
    const navigate = jest.fn();
    router.attach(navigate, 2);
    expect(await router.openPush(tap({ tenantId: 2, link: '/orders/5' }))).toBe('waiting');
    expect(navigate).not.toHaveBeenCalled();
    session.set({ status: 'signedIn', user: { id: 7 } }); // unlocked, in business 1
    await flushAll();
    expect(session.switchBusiness).toHaveBeenCalledWith(2);
    expect(navigate).toHaveBeenCalledWith('/orders/5');

    const other = fakeSession({ status: 'locked' });
    const later = createLinkRouter({ session: other });
    const nav2 = jest.fn();
    later.attach(nav2, 1);
    await later.openPush(tap({ tenantId: 1, link: '/orders/6' }, 'x'));
    other.set({ status: 'signedOut', user: null });
    other.set({ status: 'signedIn', user: { id: 8 } });
    await flushAll();
    expect(nav2).not.toHaveBeenCalled();
    expect(later.pending()).toBeNull();
  });

  test('two quick taps for two businesses are handled in order, and the last one wins', async () => {
    const session = fakeSession({ businesses: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const router = createLinkRouter({ session });
    const first = router.openPush(tap({ tenantId: 2, link: '/orders/1' }, 'one'));
    const second = router.openPush(tap({ tenantId: 3, link: '/orders/2' }, 'two'));
    await Promise.all([first, second]);
    expect(session.steps).toEqual(['switch 2', 'switch 3']);
    const navigate = jest.fn();
    router.attach(navigate, 3);
    expect(navigate.mock.calls).toEqual([['/orders/2']]);
  });

  test('the link the app was opened with is handled once, however often the watch is set up again', async () => {
    const router = { openUrl: jest.fn() };
    const linking = { getInitialURL: async () => 'bhavabusiness://orders/1', addEventListener: jest.fn(() => ({ remove: jest.fn() })) };
    watchLinks({ linking, router })();
    watchLinks({ linking, router })();
    await flushAll();
    expect(router.openUrl.mock.calls).toEqual([['bhavabusiness://orders/1']]);
    linking.addEventListener.mock.calls[1][1]({ url: 'bhavabusiness://orders/2' });
    expect(router.openUrl).toHaveBeenLastCalledWith('bhavabusiness://orders/2');
  });

  test('push taps go to the router; a new token from FCM or APNs is registered; a push shows while the app is open', async () => {
    let listener;
    const notifications = {
      addNotificationResponseReceivedListener: (fn) => ((listener = fn), { remove: jest.fn() }),
      getLastNotificationResponseAsync: async () => tap({ tenantId: 1, link: '/orders/1' }, 'launch'),
      addPushTokenListener: jest.fn((fn) => ((notifications.tokenListener = fn), { remove: jest.fn() })),
      setNotificationHandler: jest.fn(),
      setNotificationChannelAsync: jest.fn(async () => null),
      AndroidImportance: { HIGH: 4 },
      AndroidNotificationVisibility: { PRIVATE: 0 },
    };
    const router = { openPush: jest.fn(async () => 'opened') };
    watchPushTaps({ router, notifications });
    await flushAll();
    listener(tap({ tenantId: 1, link: '/orders/2' }, 'live'));
    expect(router.openPush.mock.calls.map(([r]) => r.notification.request.identifier)).toEqual(['launch', 'live']);

    const register = jest.fn(async () => null);
    SecureStore.__reset();
    const store = createSecureStore({ prefix: 'bhava.owner' });
    watchPushToken({ api: { push: { register } }, store, app: APP, notifications });
    notifications.tokenListener({ type: 'android', data: 'fcm-token-rotated-0001' });
    await flushAll();
    expect(register).toHaveBeenCalledWith({ deviceId: await store.getDeviceId(), platform: 'android', token: 'fcm-token-rotated-0001', appVersion: '1.4.0' }); // secret-scan:allow (a made-up token)

    expect(await configurePush({ notifications, channelName: 'Alerts' })).toBe(true);
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith('default', expect.objectContaining({ name: 'Alerts', importance: 4 }));
    const shown = await notifications.setNotificationHandler.mock.calls[0][0].handleNotification();
    expect(shown).toMatchObject({ shouldShowBanner: true, shouldShowList: true });
  });
});

describe('the offline cache and the query client', () => {
  const memory = () => {
    const items = new Map();
    return { items, getItem: async (k) => items.get(k) ?? null, setItem: async (k, v) => void items.set(k, v), removeItem: async (k) => void items.delete(k) };
  };
  afterEach(() => onlineManager.setOnline(true));

  test('a token, a one-time code or a phone number never reaches the query cache, and nothing else is changed', () => {
    const answer = {
      items: [{ id: 1, phone: '+919876543210', coupon: { code: 'DIWALI20' }, total: 129900 }],
      accessToken: 'a1', refresh_token: 'r1', deviceSecret: 's', nested: { code: '123456', whatsapp: '9876543210', label: '+91 ••••• •3210' },
    };
    const clean = scrub(answer);
    expect(clean).toEqual({ items: [{ id: 1, phone: '+91 ••••• •3210', coupon: { code: 'DIWALI20' }, total: 129900 }], nested: { whatsapp: '••••• •3210', label: '+91 ••••• •3210' } });
    expect(holdsSecret(answer)).toBe(true);
    expect(holdsSecret(clean)).toBe(false);
    expect(maskPhoneNumber('+447700900123')).toBe('+44 ••••• •0123');

    const client = createQueryClient();
    client.setQueryData(['me'], { user: { name: 'Asha', phone: '+919800000001' }, accessToken: 'a1' });
    const held = JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data));
    expect(held).not.toContain('+919800000001');
    expect(held).not.toContain('a1');
    expect(client.getQueryData(['me']).user.name).toBe('Asha');
    client.clear();
  });

  test('P-19 a change made offline fails at once with no connection, is never paused, and is never saved for later', async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient();
    const send = jest.fn(async () => 'sent');
    await expect(client.getMutationCache().build(client, { mutationFn: send }).execute({ confirm: 1 })).rejects.toBeInstanceOf(OfflineError);
    expect(send).not.toHaveBeenCalled();
    expect(client.getMutationCache().getAll().some((m) => m.state.isPaused)).toBe(false);
    const cache = createOfflineCache({ storage: memory(), getTenantId: () => 1 });
    expect(dehydrate(client, cache.persistOptions.dehydrateOptions).mutations).toEqual([]);
    onlineManager.setOnline(true);
    await flushAll();
    expect(send).not.toHaveBeenCalled(); // the connection came back and nothing went out
    client.clear();
  });

  test('a screen knows whether it is online, and its buttons can follow', async () => {
    let listener;
    const network = { getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }), addNetworkStateListener: (fn) => ((listener = fn), { remove() {} }) };
    function Confirm() {
      const online = useOnline();
      return <>{online ? null : <LockScreen appName="x" onUnlock={() => {}} onSignInInstead={() => {}} />}</>;
    }
    const strings = createStrings(shared);
    await render(<StringsProvider strings={strings}><Confirm /></StringsProvider>);
    watchConnection(network);
    await act(async () => flushAll());
    expect(screen.queryByTestId('lock-screen')).toBeNull();
    await act(async () => listener({ isConnected: false }));
    expect(screen.getByTestId('lock-screen')).toBeTruthy();
    await act(async () => listener({ isConnected: true, isInternetReachable: true }));
    expect(screen.queryByTestId('lock-screen')).toBeNull();
  });

  test('P-10 clearing the cache on a switch never overwrites the old business’s saved rows', async () => {
    const storage = memory();
    let tenantId = 1;
    const cache = createOfflineCache({ storage, getTenantId: () => tenantId, throttleMs: 1 });
    cache.persister.persistClient({ timestamp: 1, buster: '', clientState: { queries: [{ queryKey: ['orders'] }], mutations: [] } });
    await cache.flush();
    cache.persister.persistClient({ timestamp: 2, buster: '', clientState: { queries: [], mutations: [] } }); // queryClient.clear() on the switch
    await cache.flush();
    expect(JSON.parse(storage.items.get('bhava.cache.1')).clientState.queries).toHaveLength(1);
  });

  test('the saved rows of the business in use come back before its screens draw, and nobody else’s', async () => {
    const storage = memory();
    let tenantId = 1;
    let clock = 10_000;
    const cache = createOfflineCache({ storage, getTenantId: () => tenantId, buster: '1.4.0', now: () => clock });
    const source = new QueryClient();
    source.setQueryData(['orders'], { items: ['A-1'] });
    await storage.setItem('bhava.cache.1', JSON.stringify({ timestamp: clock, buster: '1.4.0', clientState: dehydrate(source) }));
    source.setQueryData(['orders'], { items: ['B-1'] });
    await storage.setItem('bhava.cache.2', JSON.stringify({ timestamp: clock, buster: '1.3.0', clientState: dehydrate(source) })); // an older build's

    const into = new QueryClient();
    expect(await cache.restoreInto(into)).toBe(1);
    expect(into.getQueryData(['orders'])).toEqual({ items: ['A-1'] });
    into.clear();
    source.clear();

    tenantId = 2;
    const fresh = new QueryClient();
    expect(await cache.restoreInto(fresh)).toBe(0);
    expect(fresh.getQueryData(['orders'])).toBeUndefined();
    fresh.clear();

    tenantId = 1;
    clock += 8 * 24 * 3600 * 1000; // older than a week
    expect(await cache.restoreInto(new QueryClient())).toBe(0);
  });
});

describe('the lock and the fresh check', () => {
  const localAuth = (over = {}) => ({
    hasHardwareAsync: async () => true, isEnrolledAsync: async () => true, supportedAuthenticationTypesAsync: async () => [2],
    authenticateAsync: jest.fn(async () => ({ success: true })), ...over,
  });

  test('P-68 the lock is offered once after a sign-in, names face or fingerprint, and turning it off forgets the device secret', async () => {
    SecureStore.__reset();
    const store = createSecureStore({ prefix: 'bhava.owner' });
    const lock = createLock({ store, localAuth: localAuth() });
    expect(await lock.kind()).toBe('face');
    expect(await createLock({ store, localAuth: localAuth({ supportedAuthenticationTypesAsync: async () => [1] }) }).kind()).toBe('fingerprint');
    expect(await lock.shouldOffer()).toBe(true);
    await lock.markOffered();
    expect(await lock.shouldOffer()).toBe(false);
    await store.clearSession(); // a new sign-in asks again
    expect(await lock.shouldOffer()).toBe(true);
    await store.setDeviceSecret('dev-secret');
    await lock.enable('Unlock');
    expect(await lock.shouldOffer()).toBe(false);
    await lock.disable();
    expect([await store.isLockEnabled(), await store.getDeviceSecret()]).toEqual([false, null]);
    expect(await createLock({ store, localAuth: localAuth({ isEnrolledAsync: async () => false }) }).shouldOffer()).toBe(false);
  });

  test('P-17 a fresh check uses the device’s unlock secret after a fingerprint or face pass, or a WhatsApp code', async () => {
    const { session, store } = setup();
    await session.adopt(signedIn);
    const lock = createLock({ store, localAuth: localAuth() });
    const reauth = createReauth({ session, store, lock });
    expect(await reauth.canUseDevice()).toBe(false); // no secret, no lock
    expect(await enrollDeviceUnlock({ api: session.api, store })).toBe(true);
    await lock.enable('Unlock');
    expect(await reauth.canUseDevice()).toBe(true);
    expect(await reauth.withDevice('Unlock')).toEqual({ ok: true, reason: null });
    expect(session.isFresh()).toBe(true);

    session.setFresh(null);
    expect(await reauth.start()).toMatchObject({ sent: true });
    await expect(reauth.withCode('111111')).rejects.toMatchObject({ status: 401 });
    expect(await reauth.withCode('654321')).toEqual({ ok: true, reason: null });
    expect(session.isFresh()).toBe(true);
  });

  test('a device secret the server no longer takes is forgotten, and a failed pass sends nothing', async () => {
    const { session, store, server } = setup();
    await session.adopt(signedIn);
    await store.setDeviceSecret('old-secret');
    await store.setLockEnabled(true);
    const reauth = createReauth({ session, store, lock: createLock({ store, localAuth: localAuth() }) });
    expect(await reauth.withDevice('Unlock')).toEqual({ ok: false, reason: 'refused' });
    expect(await store.getDeviceSecret()).toBeNull();

    await store.setDeviceSecret('dev-secret');
    const calls = server.calls.length;
    const failing = createReauth({ session, store, lock: createLock({ store, localAuth: localAuth({ authenticateAsync: async () => ({ success: false, error: 'user_cancel' }) }) }) });
    expect(await failing.withDevice('Unlock')).toEqual({ ok: false, reason: 'cancelled' });
    expect(server.calls.length).toBe(calls);
    expect(await enrollDeviceUnlock({ api: { auth: { enableDeviceUnlock: async () => { throw Object.assign(new Error('x'), { code: 'reauth_required' }); } } }, store })).toBe(false);
  });
});

describe('the prompts', () => {
  const strings = createStrings(shared);
  const wrap = (node) => <StringsProvider strings={strings}>{node}</StringsProvider>;
  const localAuth = (over = {}) => ({ hasHardwareAsync: async () => true, isEnrolledAsync: async () => true, supportedAuthenticationTypesAsync: async () => [1], authenticateAsync: jest.fn(async () => ({ success: true })), ...over });

  test('F-110 after a sign-in the app offers fingerprint unlock once; yes turns it on and keeps the unlock secret', async () => {
    const { session, store } = setup();
    await session.adopt(signedIn);
    const lock = createLock({ store, localAuth: localAuth() });
    const onAnswered = jest.fn();
    await render(wrap(<LockOffer lock={lock} api={session.api} store={store} appName="The app" onAnswered={onAnswered} />));
    expect(await screen.findByText('Open The app with your fingerprint?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('lock-offer-yes'));
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith('on'));
    expect([await store.isLockEnabled(), await store.getDeviceSecret(), await lock.shouldOffer()]).toEqual([true, 'dev-secret', false]);
  });

  test('“Not now” is final until the next sign-in', async () => {
    const { session, store } = setup();
    const lock = createLock({ store, localAuth: localAuth() });
    await render(wrap(<LockOffer lock={lock} api={session.api} store={store} appName="The app" />));
    await fireEvent.press(await screen.findByTestId('lock-offer-no'));
    expect([await store.isLockEnabled(), await lock.shouldOffer()]).toEqual([false, false]);
    await waitFor(() => expect(screen.queryByTestId('lock-offer-yes')).toBeNull());
  });

  test('a phone with nothing enrolled is never asked', async () => {
    const { session, store } = setup();
    await render(wrap(<LockOffer lock={createLock({ store, localAuth: localAuth({ isEnrolledAsync: async () => false }) })} api={session.api} store={store} appName="The app" />));
    await act(async () => flushAll());
    expect(screen.queryByTestId('lock-offer-yes')).toBeNull();
  });

  function Change({ work, onResult }) {
    const { runFresh } = useReauth();
    // The press does not wait for the answer: the sheet is answered by further presses.
    const start = () => {
      runFresh(work).then(onResult, (e) => onResult(e.code));
    };
    return <LockScreen appName="x" onUnlock={start} onSignInInstead={() => {}} />;
  }

  test('P-17 a change that needs a fresh check asks for a code first, then runs once', async () => {
    const { session, store, server } = setup();
    await session.adopt(signedIn);
    const lock = createLock({ store, localAuth: localAuth() });
    const work = jest.fn(async () => 'saved');
    const onResult = jest.fn();
    await render(wrap(<ReauthProvider session={session} store={store} lock={lock} appName="The app"><Change work={work} onResult={onResult} /></ReauthProvider>));
    await fireEvent.press(screen.getByTestId('lock-unlock'));
    expect(await screen.findByText('Confirm it’s you')).toBeTruthy();
    expect(screen.queryByTestId('reauth-device')).toBeNull(); // no unlock secret on this phone
    await fireEvent.press(screen.getByTestId('reauth-send'));
    await fireEvent.changeText(await screen.findByTestId('reauth-code'), '111111');
    await fireEvent.press(screen.getByTestId('reauth-verify'));
    expect(await screen.findByTestId('reauth-problem')).toBeTruthy();
    expect(work).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('reauth-code'), '654321');
    await fireEvent.press(screen.getByTestId('reauth-verify'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('saved'));
    expect(work).toHaveBeenCalledTimes(1);
    expect(server.calls.filter((c) => c.path === '/auth/reauth/verify').map((c) => c.body)).toEqual([{ code: '111111' }, { code: '654321' }]);
  });

  test('with the lock on, the fresh check is a fingerprint; closing the sheet cancels the change', async () => {
    const { session, store } = setup();
    await session.adopt(signedIn);
    await store.setDeviceSecret('dev-secret');
    await store.setLockEnabled(true);
    const lock = createLock({ store, localAuth: localAuth() });
    const work = jest.fn(async () => 'saved');
    const onResult = jest.fn();
    await render(wrap(<ReauthProvider session={session} store={store} lock={lock} appName="The app"><Change work={work} onResult={onResult} /></ReauthProvider>));
    await fireEvent.press(screen.getByTestId('lock-unlock'));
    await fireEvent.press(await screen.findByTestId('reauth-device'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('saved'));

    session.setFresh(null);
    await fireEvent.press(screen.getByTestId('lock-unlock'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith('cancelled'));
    expect(work).toHaveBeenCalledTimes(1);
  });

  test('the lock screen names the unlock it uses, and a failure is shown in words, never the server’s message', async () => {
    await render(wrap(<LockScreen appName="The app" kind="face" onUnlock={() => {}} onSignInInstead={() => {}} failed />));
    expect(screen.getByRole('button', { name: 'Unlock with face unlock' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in another way' })).toBeTruthy();
    expect([errorKey({ status: 0 }), errorKey({ status: 403 }), errorKey({ status: 404 }), errorKey({ status: 500 }), errorKey(new OfflineError())]).toEqual(['error.network', 'error.forbidden', 'error.notFound', 'error.body', 'error.network']);
  });
});

describe('access by account type', () => {
  test('P-69 a feature can be for sellers or creators only; one that says nothing is for both', () => {
    const owner = { role: 'owner', permissions: [] };
    const storeOnly = { access: staffWith('orders'), nav: { label: 'x', order: 1, accountTypes: ['seller'] } };
    const creatorOnly = { access: SIGNED_IN, nav: { label: 'y', order: 2, accountTypes: ['creator'] } };
    const both = { access: SIGNED_IN, nav: { label: 'z', order: 3 } };
    expect([storeOnly, creatorOnly, both].map((f) => canOpen(f, { user: owner, accountType: 'creator' }))).toEqual([false, true, true]);
    expect([storeOnly, creatorOnly, both].map((f) => canOpen(f, { user: owner, accountType: 'seller' }))).toEqual([true, false, true]);
    expect(canOpen(storeOnly, { user: owner })).toBe(true); // not known yet
  });
});

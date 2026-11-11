/**
 * What the shell's and the features' tests share: a stand-in for the seller API with the session rules, the services
 * built on it, and the signed-in app drawn the way App.js draws it, with every native piece passed in. Only tests
 * import this file, so it never reaches the app's bundle.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StringsProvider, createLock } from '@bhava/app-core';
import { sellerTheme } from '@bhava/theme';
import { ThemeProvider } from '@bhava/ui';
import { ServicesProvider, createServices } from '../services.js';
import { Navigation } from './Navigation.js';

export const ORIGIN = 'http://localhost:9';
export const constants = { expoConfig: { version: '1.4.0', extra: { apiBaseUrl: ORIGIN } } };
export const OWNER = { id: 7, name: 'Asha', phone: '+919800000001', role: 'owner', permissions: [] };
export const STAFF = { id: 8, name: 'Ravi', phone: '+919800000002', role: 'staff', permissions: ['orders'] };
export const SHOP_A = { id: 1, slug: 'alpha', name: 'Alpha Traders', plan: 'growth', logoUrl: 'https://cdn.example.com/alpha.png', accountType: 'seller' };
export const SHOP_B = { id: 2, slug: 'beta', name: 'Beta Crafts', plan: 'free', logoUrl: '', accountType: 'creator' };
export const MEMBERSHIPS = [
  { id: 1, slug: 'alpha', name: 'Alpha Traders', role: 'owner', logoUrl: SHOP_A.logoUrl, current: true },
  { id: 2, slug: 'beta', name: 'Beta Crafts', role: 'staff', logoUrl: '', current: false },
];

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
export const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await act(async () => {});
};

/**
 * The seller API in small. `routes` answers anything else: { 'GET /orders': (call) => json-able | [status, body] }.
 * `server.revoke()` ends the refresh family as Settings > Devices on another phone would.
 */
export function fakeApi({ user = OWNER, businesses = MEMBERSHIPS, routes = {} } = {}) {
  const server = { calls: [], family: 'alive', refresh: 'r1', access: new Set(['a1']), count: 1, user, businesses, routes, down: false };
  server.revoke = () => {
    server.family = 'revoked';
    server.access.clear();
  };
  server.fetch = async (url, init = {}) => {
    const full = String(url).replace(`${ORIGIN}/api/v1`, '');
    const [path, search = ''] = full.split('?');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const token = init.headers?.authorization?.replace('Bearer ', '') ?? null;
    const tenant = Number(init.headers?.['x-tenant-id'] ?? 1);
    const call = { method: init.method ?? 'GET', path, search, body, token, tenant };
    server.calls.push(call);
    if (server.down) throw new TypeError('Network request failed');
    if (path === '/app/requirements') return json(200, { minVersion: '', storeUrl: '', signIn: { whatsapp: true, google: true, apple: true } });
    if (path === '/auth/refresh') {
      if (server.family !== 'alive' || body.refreshToken !== server.refresh) {
        server.revoke();
        return json(401, { error: 'Sign in again', code: 'unauthorized' });
      }
      server.count++;
      server.refresh = `r${server.count}`;
      server.access = new Set([`a${server.count}`]);
      return json(201, { accessToken: `a${server.count}`, accessExpiresInSeconds: 900, refreshToken: server.refresh });
    }
    if (path === '/auth/start') return json(202, { sent: true, channel: 'whatsapp', expiresInSeconds: 300, resendInSeconds: 30, alternatives: ['google', 'apple'] });
    if (['/auth/verify', '/auth/exchange', '/auth/apple'].includes(path)) {
      if (path === '/auth/verify' && body.code !== '123456') return json(401, { error: 'That code didn’t work', code: 'unauthorized' });
      return json(201, { user: server.user, business: SHOP_A, businesses: server.businesses, accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1', freshUntil: new Date(Date.now() + 300_000).toISOString(), created: false, deviceUnlock: false });
    }
    if (!token || !server.access.has(token)) return json(401, { error: 'Sign in again', code: 'unauthorized' });
    if (!server.businesses.some((b) => b.id === tenant)) return json(403, { error: 'Not yours', code: 'forbidden' });
    const business = tenant === 2 ? SHOP_B : SHOP_A;
    const key = `${call.method} ${path}`;
    const answer = Object.entries(server.routes).find(([pattern]) => new RegExp(`^${pattern.replace(/:[a-z]+/g, '[^/]+')}$`).test(key))?.[1];
    if (answer) {
      const result = await answer(call);
      if (Array.isArray(result)) return json(result[0], result[1]);
      return result === null ? json(204, null) : json(200, result);
    }
    if (path === '/auth/me') return json(200, { user: server.user, business, freshUntil: null });
    if (path === '/auth/businesses') return json(200, { businesses: server.businesses });
    if (path === '/auth/logout') return json(204, null);
    if (path === '/push/devices' || path.startsWith('/push/devices/')) return json(204, null);
    if (path === '/notifications') return json(200, { items: [], nextCursor: null, unread: 0 });
    return json(404, { error: 'Not found', code: 'not_found' });
  };
  return server;
}

export const signedInAs = (user = OWNER, business = SHOP_A, businesses = MEMBERSHIPS, extra = {}) => ({ user, business, businesses, accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1', ...extra });

/** A key-value store in memory, shaped like expo-sqlite/kv-store: the offline cache's file. */
export function memoryStorage() {
  const items = new Map();
  return { items, getItem: async (k) => items.get(k) ?? null, setItem: async (k, v) => void items.set(k, v), removeItem: async (k) => void items.delete(k) };
}

/** A phone's fingerprint reader: `enrolled` false is a phone with nothing set up. */
export function fakeLocalAuth({ enrolled = true, kind = 1, result = { success: true } } = {}) {
  return {
    hasHardwareAsync: async () => true,
    isEnrolledAsync: async () => enrolled,
    supportedAuthenticationTypesAsync: async () => [kind],
    authenticateAsync: jest.fn(async () => result),
  };
}

/** expo-notifications as the shell uses it, with a way to tap a push. */
export function fakeNotifications() {
  const listeners = new Set();
  const notifications = {
    getPermissionsAsync: async () => ({ granted: false, canAskAgain: false }),
    addNotificationResponseReceivedListener: (fn) => {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    },
    getLastNotificationResponseAsync: async () => null,
    addPushTokenListener: () => ({ remove() {} }),
    setNotificationHandler: () => {},
    setNotificationChannelAsync: async () => null,
    tap: (data, identifier = `n-${Math.random()}`) => {
      for (const fn of [...listeners]) fn({ actionIdentifier: 'default', notification: { date: Date.now(), request: { identifier, content: { data } } } });
    },
  };
  return notifications;
}

/** expo-network with a switch: `network.set(false)` is airplane mode. */
export function fakeNetwork(online = true) {
  const listeners = new Set();
  let state = { isConnected: online, isInternetReachable: online };
  return {
    getNetworkStateAsync: async () => state,
    addNetworkStateListener: (fn) => {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    },
    set(next) {
      state = { isConnected: next, isInternetReachable: next };
      for (const fn of [...listeners]) fn(state);
    },
  };
}

export const noLinks = { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) };
export const quietAppState = { currentState: 'background', addEventListener: () => ({ remove() {} }) };

/** The services App.js builds, on the fake API, with the offline cache in memory and the given fingerprint reader. */
export function makeServices(api, { platform = 'android', localAuth = fakeLocalAuth({ enrolled: false }), storage = memoryStorage() } = {}) {
  const made = createServices({ fetch: api.fetch, constants, platform, deviceName: 'Pixel 8', storage });
  made.lock = createLock({ store: made.store, localAuth });
  made.storage = storage;
  return made;
}

/** Providers as App.js sets them up, around anything. */
export function Providers({ services, children }) {
  return (
    <SafeAreaProvider>
      <ThemeProvider theme={sellerTheme}>
        <StringsProvider strings={services.strings}>
          <ServicesProvider value={services}>
            {services.cache ? (
              <PersistQueryClientProvider client={services.queryClient} persistOptions={services.cache.persistOptions}>{children}</PersistQueryClientProvider>
            ) : (
              <QueryClientProvider client={services.queryClient}>{children}</QueryClientProvider>
            )}
          </ServicesProvider>
        </StringsProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/** The signed-in app: the navigation from `list`, with every native piece a fake. Sign in first with session.adopt. */
export async function renderShell(services, { list, notifications = fakeNotifications(), network = fakeNetwork(true), linking = noLinks, appState = quietAppState } = {}) {
  const view = await render(
    <Providers services={services}>
      <Navigation {...(list ? { list } : {})} notifications={notifications} network={network} linking={linking} appState={appState} />
    </Providers>,
  );
  await settle();
  return { view, notifications, network };
}

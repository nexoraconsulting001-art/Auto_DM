import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { MANAGERS, OWNER_ONLY, SIGNED_IN, canOpen, staffWith } from './access.js';
import { createOfflineCache, createQueryClient, watchConnection } from './cache.js';
import { readAppConfig } from './config.js';
import { OWNER_APP_CALLBACK, matchPath, parseLink } from './links.js';
import { createLock } from './lock.js';
import { openPush, pushTarget, registerForPush } from './push.js';
import { LockScreen, OfflineBanner, OfflineScreen, UpdateRequiredScreen, isStoreUrl } from './screens.js';
import { createSecureStore } from './storage.js';
import { StringsProvider, checkCatalogue, createStrings, pickLocale, shared } from './strings/index.js';

beforeEach(() => SecureStore.__reset());

describe('the lock', () => {
  const auth = (over = {}) => ({ hasHardwareAsync: async () => true, isEnrolledAsync: async () => true, authenticateAsync: jest.fn(async () => ({ success: true })), ...over });

  test('turning it on needs a pass first, and it only ever answers yes or no', async () => {
    const store = createSecureStore({ prefix: 'bhava.owner' });
    const localAuth = auth();
    const lock = createLock({ store, localAuth });
    expect(await lock.enabled()).toBe(false);
    expect(await lock.enable('Unlock')).toEqual({ ok: true, reason: null });
    expect(await lock.enabled()).toBe(true);
    expect(localAuth.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ promptMessage: 'Unlock', disableDeviceFallback: false })); // the passcode is the fallback
    expect(await lock.unlock('Unlock')).toEqual({ ok: true, reason: null });
  });

  test('a cancel, a failure and a phone with nothing enrolled each say so and unlock nothing', async () => {
    const store = createSecureStore({ prefix: 'bhava.owner' });
    expect(await createLock({ store, localAuth: auth({ authenticateAsync: async () => ({ success: false, error: 'user_cancel' }) }) }).unlock('x')).toEqual({ ok: false, reason: 'cancelled' });
    expect(await createLock({ store, localAuth: auth({ authenticateAsync: async () => ({ success: false, error: 'lockout' }) }) }).enable('x')).toEqual({ ok: false, reason: 'failed' });
    expect(await createLock({ store, localAuth: auth({ authenticateAsync: async () => { throw new Error('boom'); } }) }).unlock('x')).toEqual({ ok: false, reason: 'failed' });
    expect(await createLock({ store, localAuth: auth({ isEnrolledAsync: async () => false }) }).unlock('x')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await store.isLockEnabled()).toBe(false);
  });
});

describe('deep links', () => {
  test('a record link gives its path, and a browser sign-in gives its code', () => {
    expect(parseLink('bhavabusiness://orders/12')).toEqual({ kind: 'screen', path: '/orders/12', tenantId: null });
    expect(parseLink('bhavabusiness:///orders/12?tenantId=4')).toEqual({ kind: 'screen', path: '/orders/12', tenantId: 4 });
    expect(parseLink('bhavabusiness://')).toEqual({ kind: 'screen', path: '/', tenantId: null });
    expect(parseLink(`${OWNER_APP_CALLBACK}?code=abc-DEF_1`)).toEqual({ kind: 'auth', code: 'abc-DEF_1', error: '' });
    expect(parseLink(`${OWNER_APP_CALLBACK}?error=denied`)).toEqual({ kind: 'auth', code: '', error: 'denied' });
    expect(parseLink(`${OWNER_APP_CALLBACK}?error=<script>`)).toEqual({ kind: 'auth', code: '', error: 'failed' });
  });

  test('another app’s scheme, a web address and a malformed path open nothing', () => {
    for (const url of ['https://example.com/orders/1', 'otherapp://orders/1', 'bhavabusiness://orders//1', 'bhavabusiness://../etc', 'bhavabusiness://orders/1%20x', '', null, undefined]) expect(parseLink(url)).toBeNull();
    expect(parseLink('shop://orders/1', { schemes: ['shop'] })).toMatchObject({ path: '/orders/1' });
  });

  test('a path opens the screen whose pattern fits, literal parts first', () => {
    const screens = [{ name: 'orders.detail', path: 'orders/:id' }, { name: 'orders.files', path: 'orders/files' }, { name: 'home', path: '' }, { name: 'none' }];
    expect(matchPath('/orders/12', screens)).toEqual({ name: 'orders.detail', params: { id: '12' } });
    expect(matchPath('/orders/files', screens)).toEqual({ name: 'orders.files', params: {} });
    expect(matchPath('/', screens)).toEqual({ name: 'home', params: {} });
    expect(matchPath('/nowhere/1/2', screens)).toBeNull();
    expect(matchPath('orders/12', screens)).toBeNull();
  });
});

describe('push', () => {
  const store = () => createSecureStore({ prefix: 'bhava.owner' });
  const app = { name: 'owner', version: '1.4.0', platform: 'ios' };
  const granted = { getPermissionsAsync: async () => ({ granted: true }), requestPermissionsAsync: jest.fn(), getDevicePushTokenAsync: async () => ({ type: 'ios', data: 'apns-token-1' }) };

  test('the device’s own token is registered with the API, with the device id it signed in with', async () => {
    const register = jest.fn(async () => ({}));
    const held = store();
    expect(await registerForPush({ api: { push: { register } }, store: held, app, notifications: granted })).toEqual({ registered: true, reason: null });
    expect(register).toHaveBeenCalledWith({ deviceId: await held.getDeviceId(), platform: 'ios', token: 'apns-token-1', appVersion: '1.4.0' });
  });

  test('a refusal, a build with no push and an API failure each say why and never throw', async () => {
    const register = jest.fn(async () => { throw new Error('offline'); });
    const api = { push: { register } };
    const denied = { getPermissionsAsync: async () => ({ granted: false, canAskAgain: true }), requestPermissionsAsync: async () => ({ granted: false }) };
    expect(await registerForPush({ api, store: store(), app, notifications: denied })).toEqual({ registered: false, reason: 'denied' });
    const noPush = { ...granted, getDevicePushTokenAsync: async () => { throw new Error('no google-services'); } };
    expect(await registerForPush({ api, store: store(), app, notifications: noPush })).toEqual({ registered: false, reason: 'unavailable' });
    expect(register).not.toHaveBeenCalled();
    expect(await registerForPush({ api, store: store(), app, notifications: granted })).toEqual({ registered: false, reason: 'failed' });
  });

  const tap = (data) => ({ notification: { request: { content: { data } } } });

  test('a tap for another business switches to it, then opens the record', async () => {
    const steps = [];
    const state = { tenantId: 1, businesses: [{ id: 1 }, { id: 2 }] };
    const session = { getState: () => state, switchBusiness: async (id) => { steps.push(`switch ${id}`); state.tenantId = id; } };
    expect(await openPush(tap({ tenantId: '2', link: '/orders/12', kind: 'order.new' }), { session, open: (p) => steps.push(`open ${p}`) })).toBe(true);
    expect(steps).toEqual(['switch 2', 'open /orders/12']);
    steps.length = 0;
    expect(await openPush(tap({ tenantId: 2, link: '/orders/13' }), { session, open: (p) => steps.push(`open ${p}`) })).toBe(true);
    expect(steps).toEqual(['open /orders/13']); // already there: no switch
  });

  test('a tap for a business the person has left, or with no usable link, opens nothing', async () => {
    const open = jest.fn();
    const session = { getState: () => ({ tenantId: 1, businesses: [{ id: 1 }] }), switchBusiness: jest.fn() };
    expect(await openPush(tap({ tenantId: 9, link: '/orders/1' }), { session, open })).toBe(false);
    expect(pushTarget(tap({ tenantId: 1, link: 'https://evil.example/x' }))).toBeNull();
    expect(pushTarget(tap({ link: '/orders/1' }))).toBeNull();
    expect(pushTarget(null)).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(session.switchBusiness).not.toHaveBeenCalled();
  });
});

describe('the offline cache', () => {
  const memory = () => {
    const items = new Map();
    return { items, getItem: async (k) => items.get(k) ?? null, setItem: async (k, v) => void items.set(k, v), removeItem: async (k) => void items.delete(k) };
  };

  test('each business has its own saved rows, and switching never shows the other’s', async () => {
    const storage = memory();
    let tenantId = 1;
    const cache = createOfflineCache({ storage, getTenantId: () => tenantId, throttleMs: 1 });
    cache.persister.persistClient({ clientState: { queries: ['orders of 1'] } });
    await cache.flush();
    tenantId = 2;
    expect(await cache.persister.restoreClient()).toBeUndefined();
    cache.persister.persistClient({ clientState: { queries: ['orders of 2'] } });
    await cache.flush();
    tenantId = 1;
    expect(await cache.persister.restoreClient()).toEqual({ clientState: { queries: ['orders of 1'] } });
  });

  test('signing out removes every business’s rows, and nothing is saved with no business', async () => {
    const storage = memory();
    let tenantId = 1;
    const cache = createOfflineCache({ storage, getTenantId: () => tenantId, throttleMs: 1 });
    cache.persister.persistClient({ a: 1 });
    await cache.flush();
    tenantId = 2;
    cache.persister.persistClient({ b: 2 });
    await cache.flush();
    await cache.clearAll();
    expect(storage.items.size).toBe(0);
    tenantId = null;
    cache.persister.persistClient({ c: 3 });
    await cache.flush();
    expect(storage.items.size).toBe(0);
  });

  test('only finished queries are kept, and one can opt out', () => {
    const { shouldDehydrateQuery } = createOfflineCache({ storage: memory(), getTenantId: () => 1 }).persistOptions.dehydrateOptions;
    expect(shouldDehydrateQuery({ state: { status: 'success' } })).toBe(true);
    expect(shouldDehydrateQuery({ state: { status: 'pending' } })).toBe(false);
    expect(shouldDehydrateQuery({ state: { status: 'success' }, meta: { offline: false } })).toBe(false);
  });

  test('reads come from the cache first and a change is never queued for later', () => {
    const options = createQueryClient().getDefaultOptions();
    expect(options.queries.networkMode).toBe('offlineFirst');
    expect(options.mutations).toEqual({ networkMode: 'online', retry: false });
    expect(options.queries.retry(0, { status: 403 })).toBe(false);
    expect(options.queries.retry(0, { status: 0 })).toBe(true);
  });

  test('the connection is watched and reported', async () => {
    let listener;
    const seen = [];
    const stop = watchConnection({ getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }), addNetworkStateListener: (fn) => { listener = fn; return { remove: () => seen.push('stopped') }; } }, (online) => seen.push(online));
    await Promise.resolve();
    await Promise.resolve();
    listener({ isConnected: false });
    listener({ isConnected: true, isInternetReachable: true });
    stop();
    expect(seen).toEqual([true, false, true, 'stopped']);
  });
});

describe('strings', () => {
  test('Hindi has every English line, with the same words to fill in', () => {
    expect(checkCatalogue(shared)).toEqual([]);
    expect(checkCatalogue({ en: { a: 'Hi {name}', b: 'x' }, hi: { a: 'नमस्ते', c: 'y' } })).toEqual([
      'hi "a" fills different {words} than English', 'hi has no line for "b"', 'hi has "c", which English lacks',
    ]);
  });

  test('a line is filled in, falls back to English, and a missing key shows as itself', () => {
    const strings = createStrings({ en: { hello: 'Hello {name}', only: 'English only' }, hi: { hello: 'नमस्ते {name}' } }, { locale: 'hi-IN' });
    expect(strings.t('hello', { name: 'Asha' })).toBe('नमस्ते Asha');
    expect(strings.t('only')).toBe('English only');
    expect(strings.t('missing.key')).toBe('missing.key');
    strings.setLocale('fr');
    expect(strings.getLocale()).toBe('en');
    expect(pickLocale('hi_IN')).toBe('hi');
  });

  test('the shared lines name no platform and no business', () => {
    for (const lines of Object.values(shared)) expect(Object.values(lines).join(' ')).not.toMatch(/bhava|भाव/i);
  });
});

describe('the shared screens', () => {
  const strings = createStrings(shared);
  const wrap = (node) => <StringsProvider strings={strings}>{node}</StringsProvider>;

  test('update required names the app and opens only a store link', async () => {
    const openUrl = jest.fn();
    await render(wrap(<UpdateRequiredScreen appName="Shop app" storeUrl="https://play.google.com/store/apps/details?id=x" openUrl={openUrl} />));
    expect(screen.getByText('Update required')).toBeTruthy();
    expect(screen.getByText(/Shop app is too old/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('update-action'));
    expect(openUrl).toHaveBeenCalledWith('https://play.google.com/store/apps/details?id=x');
    expect(isStoreUrl('https://apps.apple.com/app/id1')).toBe(true);
    for (const bad of ['http://play.google.com/x', 'https://evil.example/play.google.com/', 'javascript:alert(1)', '', null]) expect(isStoreUrl(bad)).toBe(false);
  });

  test('with no usable store link there is no button', async () => {
    await render(wrap(<UpdateRequiredScreen appName="Shop app" storeUrl="https://evil.example" />));
    expect(screen.queryByTestId('update-action')).toBeNull();
  });

  test('the offline banner shows only while offline, and the offline screen retries', async () => {
    const onRetry = jest.fn();
    const view = await render(wrap(<><OfflineBanner offline={false} /><OfflineScreen onRetry={onRetry} /></>));
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    await fireEvent.press(screen.getByTestId('offline-retry'));
    expect(onRetry).toHaveBeenCalled();
    await view.rerender(wrap(<OfflineBanner offline />));
    expect(screen.getByTestId('offline-banner')).toBeTruthy();
  });

  test('the lock screen offers the unlock and another way in', async () => {
    const onUnlock = jest.fn();
    const onSignInInstead = jest.fn();
    await render(wrap(<LockScreen appName="Shop app" onUnlock={onUnlock} onSignInInstead={onSignInInstead} failed />));
    await fireEvent.press(screen.getByTestId('lock-unlock'));
    await fireEvent.press(screen.getByTestId('lock-sign-in'));
    expect(onUnlock).toHaveBeenCalled();
    expect(onSignInInstead).toHaveBeenCalled();
    expect(screen.getByText(/didn’t work/)).toBeTruthy();
  });
});

describe('access and config', () => {
  const owner = { role: 'owner', permissions: [] };
  const staff = { role: 'staff', permissions: ['orders'] };

  test('a screen opens by role, permission and plan, as the console’s menu does', () => {
    expect(canOpen({ access: staffWith('orders') }, { user: staff })).toBe(true);
    expect(canOpen({ access: staffWith('catalog') }, { user: staff })).toBe(false);
    expect(canOpen({ access: OWNER_ONLY }, { user: staff })).toBe(false);
    expect(canOpen({ access: MANAGERS }, { user: owner })).toBe(true);
    expect(canOpen({ access: SIGNED_IN }, { user: null })).toBe(false);
    expect(canOpen({ access: MANAGERS, feature: 'automations' }, { user: owner, entitlements: { automations: false } })).toBe(false);
    expect(canOpen({ access: MANAGERS, feature: 'automations' }, { user: owner, entitlements: { automations: true } })).toBe(true);
    expect(canOpen({ access: MANAGERS, feature: 'automations' }, { user: owner, entitlements: null })).toBe(true); // not known yet: the server decides
    expect(canOpen(undefined, { user: owner })).toBe(false);
  });

  test('the API address comes from the build, and a build without one says so', () => {
    const config = readAppConfig({ name: 'owner', constants: { expoConfig: { version: '1.4.0', extra: { apiBaseUrl: 'https://app.example.com/' } } }, platform: 'ios' });
    expect(config).toMatchObject({ apiOrigin: 'https://app.example.com', apiBaseUrl: 'https://app.example.com/api/v1', app: { name: 'owner', version: '1.4.0', platform: 'ios' } });
    for (const apiBaseUrl of [undefined, '', 'app.example.com', 'ftp://x', 'https://app.example.com/api/v1']) {
      expect(() => readAppConfig({ name: 'owner', constants: { expoConfig: { extra: { apiBaseUrl } } }, platform: 'android' })).toThrow(/API_BASE_URL/);
    }
  });
});

describe('where secrets may live', () => {
  const SRC = __dirname;
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));

  test('only storage.js touches SecureStore, and nothing imports AsyncStorage or writes a token to a file', () => {
    for (const file of files(SRC)) {
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
      expect([file, /async-storage|AsyncStorage/.test(source)]).toEqual([file, false]);
      expect([file, /expo-file-system|localStorage/.test(source)]).toEqual([file, false]);
      if (path.basename(file) !== 'storage.js') expect([file, /expo-secure-store/.test(source)]).toEqual([file, false]);
    }
  });
});

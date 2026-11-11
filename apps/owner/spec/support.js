/**
 * What the owner app's spec tests share: a fake of the seller API at /api/v1 that answers the way the contract says
 * (src/contracts/api), and the app rendered whole, signed in or not. Nothing here names a business: the businesses are
 * made-up workspaces. Screens are found by what a person reads, or by the shell's own test ids.
 */
import React from 'react';
import { act, configure, render } from '@testing-library/react-native';
import App from '../src/App.js';
import { createServices } from '../src/services.js';

// The whole app, with fifty feature screens behind its tabs, takes longer than a second to draw on a slow machine.
configure({ asyncUtilTimeout: 8000 });
jest.setTimeout(60_000);

export const ORIGIN = 'http://localhost:9';
export const APP_VERSION = '1.4.0';
export const constants = { expoConfig: { version: APP_VERSION, extra: { apiBaseUrl: ORIGIN } } };

export const WORKSPACE_LOGO = 'https://cdn.example/workspace-logo.png';
export const SHOP_A = Object.freeze({ id: 11, slug: 'alpha', name: 'Alpha Works', plan: 't3', logoUrl: WORKSPACE_LOGO, accountType: 'seller' });
export const SHOP_B = Object.freeze({ id: 22, slug: 'beta', name: 'Beta Studio', plan: 't3', logoUrl: '', accountType: 'seller' });
export const OWNER = Object.freeze({ id: 7, name: 'Asha', phone: '+91 ••••• •0001', role: 'owner', permissions: [] });

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
  text: async () => (body === null ? '' : JSON.stringify(body)),
});
export const networkDown = () => Promise.reject(Object.assign(new TypeError('Network request failed'), { code: 'network' }));

/** Orders as orders.list answers them, for one business. */
export const ordersOf = (shop, names) => names.map((customerName, i) => ({
  id: shop.id * 100 + i + 1, orderNumber: `${shop.slug.toUpperCase()}-${1001 + i}`, status: 'paid', customerName, phone: '98•••••10', email: '', address: '', city: 'Pune', state: 'MH', pincode: '411001',
  subtotalPaise: 49900, shippingPaise: 0, totalPaise: 49900, reelId: null, source: 'store', notes: '', createdAt: '2026-11-11T10:00:00.000Z', updatedAt: '2026-11-11T10:00:00.000Z',
  flow: 'checkout', fulfilmentStatus: 'new', paymentStatus: 'cod_due', paymentMode: 'cod', holdReason: null, nextFulfilment: ['packed', 'cancelled'], canCancel: true, itemCount: 1,
}));

/**
 * The seller API, faked. `user` and `businesses` say who is signed in and where. Access tokens are issued and checked:
 * `expire()` makes the current one answer 401, as a fifteen-minute token does. `refresh` is 'ok', 'refused' or 'down'.
 */
export function fakeApi({ user = OWNER, businesses = [SHOP_A, SHOP_B], roles = {}, orders = {}, minVersion = '', storeUrl = '', refresh = 'ok', alternatives = ['google'], extra = {} } = {}) {
  const calls = [];
  let serial = 1;
  const state = { access: new Set(['a1']), refresh, refreshTokens: new Set(['r1']), down: false, expired: false };
  const memberships = () => businesses.map((b, i) => ({ id: b.id, slug: b.slug, name: b.name, role: roles[b.id] ?? user.role, logoUrl: b.logoUrl, current: i === 0 }));
  const businessOf = (headers) => businesses.find((b) => String(b.id) === String(headers?.['x-tenant-id'])) ?? businesses[0];
  const session = () => ({ user, business: businesses[0], businesses: memberships(), accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1', created: false, deviceUnlock: false, freshUntil: null });

  async function fetch(url, init = {}) {
    const target = String(url);
    const path = target.replace(`${ORIGIN}/api/v1`, '').replace(ORIGIN, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = init.headers ?? {};
    const call = { method: init.method ?? 'GET', path, body, tenant: headers['x-tenant-id'] ?? null, authorization: headers.authorization ?? null, at: calls.length };
    calls.push(call);
    if (state.down) return networkDown();
    if (extra[`${call.method} ${path.split('?')[0]}`]) return json(...(await extra[`${call.method} ${path.split('?')[0]}`](call, state)));
    if (path.startsWith('/app/requirements')) return json(200, { minVersion, storeUrl, signIn: { whatsapp: true, google: true, apple: true } });
    if (minVersion && headers['x-app-version'] && isOlder(headers['x-app-version'], minVersion)) return json(426, { error: 'Update required', code: 'update_required', storeUrl });
    if (path === '/auth/start') return json(202, { sent: true, channel: 'whatsapp', expiresInSeconds: 300, resendInSeconds: 30, alternatives });
    if (path === '/auth/verify') return body?.code === '123456' ? json(201, session()) : json(401, { error: 'That code didn’t work', code: 'unauthorized' });
    if (path === '/auth/exchange' || path === '/auth/apple') return json(201, session());
    if (path === '/auth/refresh') {
      if (state.refresh === 'down') return networkDown();
      if (state.refresh === 'refused' || !state.refreshTokens.has(body?.refreshToken)) return json(401, { error: 'Please sign in again.', code: 'unauthorized' });
      state.refreshTokens.delete(body.refreshToken);
      serial += 1;
      state.access = new Set([`a${serial}`]);
      state.refreshTokens.add(`r${serial}`);
      return json(201, { accessToken: `a${serial}`, accessExpiresInSeconds: 900, refreshToken: `r${serial}` });
    }
    const token = String(headers.authorization ?? '').replace(/^Bearer /, '');
    if (!state.access.has(token) || state.expired) return json(401, { error: 'Please log in again.', code: 'unauthorized' });
    const business = businessOf(headers);
    if (path === '/auth/me') return json(200, { user: { ...user, role: roles[business.id] ?? user.role }, business, freshUntil: null });
    if (path === '/auth/businesses') return json(200, { businesses: memberships().map((m) => ({ ...m, current: m.id === business.id })) });
    if (path.startsWith('/orders')) {
      const list = orders[business.id] ?? [];
      const id = /^\/orders\/(\d+)/.exec(path)?.[1];
      if (id) {
        const order = list.find((o) => String(o.id) === id);
        return order ? json(200, { ...order, items: [] }) : json(404, { error: 'Not found', code: 'not_found' });
      }
      return json(200, { items: list, nextCursor: null });
    }
    if (path === '/push/devices' || path.startsWith('/push/devices/')) return json(204, null);
    if (path.startsWith('/notifications')) return json(200, { items: [], nextCursor: null, unread: 0 });
    return json(404, { error: 'Not found', code: 'not_found' });
  }

  return {
    calls,
    state,
    fetch,
    session,
    expire() { state.expired = false; state.access = new Set(); },
    paths: (method) => calls.filter((c) => !method || c.method === method).map((c) => c.path),
  };
}

function isOlder(have, need) {
  const a = String(have).split('.').map(Number);
  const b = String(need).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

/** Push that is off on this device, and a tap that can be handed in. */
export function fakeNotifications({ tapped = null } = {}) {
  const listeners = new Set();
  return {
    getPermissionsAsync: async () => ({ granted: false, canAskAgain: false }),
    requestPermissionsAsync: async () => ({ granted: false }),
    getDevicePushTokenAsync: async () => ({ data: '' }),
    addNotificationResponseReceivedListener: (fn) => { listeners.add(fn); return { remove: () => listeners.delete(fn) }; },
    getLastNotificationResponseAsync: async () => tapped,
    tap: (response) => { for (const fn of listeners) fn(response); },
  };
}

/** A push as the device hands it to the app when tapped. */
export const pushResponse = (data) => ({ notification: { request: { content: { title: 'New order', body: 'Tap to see it.', data } } } });

/** An in-memory stand-in for the app's key-value file (expo-sqlite/kv-store), so the offline cache survives a restart. */
export function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: async (k) => items.get(k) ?? null,
    setItem: async (k, v) => { items.set(k, v); },
    removeItem: async (k) => { items.delete(k); },
  };
}

export const servicesFor = (api, { platform = 'android', storage } = {}) => createServices({ fetch: (...args) => api.fetch(...args), constants, platform, deviceName: 'Pixel 8', ...(storage ? { storage } : {}) });

/** The whole app, rendered. With `signedIn`, the session adopts the fake API's sign-in answer first. */
export async function openApp(api, { platform = 'android', signedIn = false, notifications = fakeNotifications(), storage, services } = {}) {
  const made = services ?? servicesFor(api, { platform, storage });
  const view = await render(<App services={made} notifications={notifications} />);
  if (signedIn) {
    await act(async () => {
      await made.session.adopt(api.session());
    });
  }
  return { made, view, notifications };
}

/** Everything on screen as text, for searching. */
export const screenText = (screen) => JSON.stringify(screen.toJSON());

/** Waits a moment for effects and promises to settle. */
export const settle = (ms = 50) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

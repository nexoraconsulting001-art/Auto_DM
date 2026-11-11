/**
 * PRD 10.2 and 10.3, on the app's own session: an expired access token is answered with one silent refresh and one
 * retry; a refresh the server refuses (a reused token, a revoked device) signs the person out and empties the device;
 * the refresh token lives in SecureStore only and the access token nowhere; an unreachable server changes nothing.
 * P-04, P-05, P-08.
 */
import { act, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { SHOP_A, fakeApi, openApp, servicesFor, settle } from './support.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});

beforeEach(() => SecureStore.__reset());

const ordersCalls = (api) => api.calls.filter((c) => c.path.startsWith('/orders'));
const refreshCalls = (api) => api.calls.filter((c) => c.path === '/auth/refresh');

test('P-04: an expired access token gets 401, then one silent refresh and one retry that works', async () => {
  const api = fakeApi({ orders: { [SHOP_A.id]: [] } });
  const made = servicesFor(api);
  await made.session.adopt(api.session());
  api.expire();
  const answer = await made.api.orders.list();
  expect(answer.items).toEqual([]);
  const tries = ordersCalls(api);
  expect(tries).toHaveLength(2);
  expect(tries[0].authorization).toBe('Bearer a1');
  expect(tries[1].authorization).not.toBe('Bearer a1');
  expect(refreshCalls(api)).toHaveLength(1);
  expect(refreshCalls(api)[0].body).toEqual({ refreshToken: 'r1' });
  // The new refresh token was kept, and the old one is gone.
  expect(await made.store.getRefreshToken()).toBe('r2');
  expect(made.session.getState().status).toBe('signedIn');
});

test('P-04: calls that fail together share one refresh, so a refresh token is never presented twice', async () => {
  const api = fakeApi({ orders: { [SHOP_A.id]: [] } });
  const made = servicesFor(api);
  await made.session.adopt(api.session());
  api.expire();
  await Promise.all([made.api.orders.list(), made.api.orders.list(), made.api.auth.me(), made.api.auth.businesses()]);
  expect(refreshCalls(api)).toHaveLength(1);
  expect(new Set(refreshCalls(api).map((c) => c.body.refreshToken)).size).toBe(1);
});

test('P-04: a retry that is refused again is not retried a second time', async () => {
  let n = 0;
  const api = fakeApi({ extra: { 'GET /orders': () => { n += 1; return [401, { error: 'Please log in again.', code: 'unauthorized' }]; } } });
  const made = servicesFor(api);
  await made.session.adopt(api.session());
  await expect(made.api.orders.list()).rejects.toMatchObject({ status: 401 });
  expect(n).toBe(2);
  expect(refreshCalls(api).length).toBeLessThanOrEqual(1);
});

test('P-05: a refresh the server refuses signs the person out and leaves nothing on the device', async () => {
  const api = fakeApi();
  const { made } = await openApp(api, { signedIn: true });
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
  api.state.refresh = 'refused';
  api.expire();
  await act(async () => {
    await made.api.orders.list().catch(() => {});
  });
  await waitFor(() => expect(made.session.getState().status).toBe('signedOut'));
  expect(await screen.findByTestId('sign-in')).toBeTruthy();
  expect(await made.store.getRefreshToken()).toBeNull();
  expect(Object.values(SecureStore.__dump()).join(' ')).not.toMatch(/\br1\b|\ba1\b/);
});

test('P-08: a device revoked elsewhere is signed out when the app comes back to the front, with no call of its own', async () => {
  // Listens beside the app, without replacing jest's own stand-in for AppState (other tests unmount through it).
  const listeners = [];
  const original = AppState.addEventListener;
  AppState.addEventListener = (type, fn) => {
    if (type === 'change') listeners.push(fn);
    return original.call(AppState, type, fn) ?? { remove() {} };
  };
  try {
    const api = fakeApi();
    const { made } = await openApp(api, { signedIn: true });
    expect(await screen.findByTestId('tab-home')).toBeTruthy();
    api.state.refresh = 'refused';
    api.expire();
    expect(listeners.length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      for (const fn of listeners) fn('background');
      for (const fn of listeners) fn('active');
    });
    await settle(100);
    await waitFor(() => expect(made.session.getState().status).toBe('signedOut'), { timeout: 3000 });
    expect(await screen.findByTestId('sign-in')).toBeTruthy();
  } finally {
    AppState.addEventListener = original;
  }
});

test('P-08: an unreachable server signs nobody out: the app stays as it was, offline', async () => {
  const api = fakeApi();
  const made = servicesFor(api);
  await made.session.adopt(api.session());
  api.state.refresh = 'down';
  api.expire();
  await made.api.orders.list().catch(() => {});
  expect(made.session.getState().status).toBe('signedIn');
  expect(await made.store.getRefreshToken()).toBe('r1');
});

test('P-05: the refresh token is in SecureStore only, for this device only, and the access token is never stored', async () => {
  const api = fakeApi();
  const made = servicesFor(api);
  await made.session.adopt(api.session());
  const held = SecureStore.__dump();
  expect(Object.values(held)).toContain('r1');
  expect(Object.values(held).join(' ')).not.toContain('a1');
  for (const [name, options] of SecureStore.__options) {
    if (held[name] === 'r1') expect(options.keychainAccessible).toBe(SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY);
  }
});

test('P-05: reopening with the stored refresh token needs no code', async () => {
  const api = fakeApi();
  const made = servicesFor(api);
  await made.store.setRefreshToken('r1');
  await openApp(api, { services: made });
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
  expect(api.paths().some((p) => p === '/auth/start' || p === '/auth/verify')).toBe(false);
  expect(await made.store.getRefreshToken()).toBe('r2');
});

test('P-05: reopening with a refresh token the server refuses opens the sign-in screen and forgets it', async () => {
  const refused = fakeApi({ refresh: 'refused' });
  const again = servicesFor(refused);
  await again.store.setRefreshToken('r-old');
  await openApp(refused, { services: again });
  expect(await screen.findByTestId('sign-in')).toBeTruthy();
  expect(await again.store.getRefreshToken()).toBeNull();
});

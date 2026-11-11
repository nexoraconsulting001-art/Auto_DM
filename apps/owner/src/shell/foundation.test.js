import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { useQuery } from '@tanstack/react-query';
import { onlineManager } from '@tanstack/react-query';
import { SESSION_KEYS } from '@bhava/app-core';
import { SIGNED_IN, staffWith } from '@bhava/app-core/access';
import { features } from '../features/index.js';
import { APP_NAME } from '../strings.js';
import { startHeartbeat } from './heartbeat.js';
import { buildNavigation, registryProblems } from './menu.js';
import { looksLikePhone } from './sign-in.js';
import { SignInScreen } from './SignInScreen.js';
import { useServices, useSession } from './hooks.js';
import {
  MEMBERSHIPS, OWNER, Providers, SHOP_A, SHOP_B, STAFF, fakeApi, fakeLocalAuth, fakeNetwork, makeServices, renderShell, settle, signedInAs,
} from './testing.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const held = () => Object.keys(SecureStore.__dump()).filter((key) => SESSION_KEYS.some((name) => key === `bhava.owner.${name}`));

/** A list screen for tests: what it draws is logged with the business the session was in when it drew. */
const drawn = [];
function OrdersList() {
  const { api } = useServices();
  const { tenantId } = useSession();
  const orders = useQuery({ queryKey: ['orders'], queryFn: () => api.orders.list() });
  const rows = orders.data?.items ?? [];
  drawn.push({ tenantId, rows: rows.map((r) => r.number) });
  return <>{rows.map((row) => <Text key={row.number} testID={`order-${row.number}`}>{row.number}</Text>)}</>;
}
function OrderDetail({ route }) {
  const { tenantId } = useSession();
  return <Text testID="order-detail">{`order ${route.params.id} in business ${tenantId}`}</Text>;
}
const testOrders = {
  name: 'orders', access: staffWith('orders'), feature: null, routeIds: [], strings: {},
  screens: [{ name: 'index', path: 'orders', title: 'orders.title', component: OrdersList }, { name: 'detail', path: 'orders/:id', title: 'orders.title', component: OrderDetail }],
  nav: { label: 'orders.title', order: 10, primary: true },
};
const notificationsFeature = features.find((f) => f.name === 'notifications');
const devicesFeature = features.find((f) => f.name === 'devices');

describe('sign-in', () => {
  async function openSignIn(api, { platform = 'android', reason } = {}) {
    const made = makeServices(api, { platform });
    if (reason) {
      await made.session.adopt(signedInAs());
      await made.session.signOut({ reason });
    }
    await render(<Providers services={made}><SignInScreen platform={platform} /></Providers>);
    await settle();
    return made;
  }

  test('F-118 a code that may not come offers Google (and Apple on iOS) instead, never a text message, and waits before a resend', async () => {
    let clock = 1_000_000;
    const api = fakeApi();
    const made = makeServices(api, { platform: 'ios' });
    await render(<Providers services={made}><SignInScreen platform="ios" now={() => clock} /></Providers>);
    await fireEvent.press(await screen.findByTestId('sign-in-whatsapp'));
    await fireEvent.changeText(screen.getByTestId('sign-in-phone'), '98765 43210');
    await fireEvent.press(screen.getByTestId('sign-in-send'));
    expect(await screen.findByTestId('sign-in-use-google')).toBeTruthy();
    expect(screen.getByTestId('sign-in-use-apple')).toBeTruthy();
    expect(screen.getByText('No WhatsApp on this number? Use Google instead.')).toBeTruthy();
    expect(screen.getByText('We sent a 6-digit code on WhatsApp to ••••• •3210.')).toBeTruthy(); // the number shown back, masked
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/SMS|text message|password|9876543210/i);
    const resend = screen.getByTestId('sign-in-resend');
    expect(resend.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Send again in 30 s')).toBeTruthy();
    clock += 31_000;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
    expect(screen.getByTestId('sign-in-resend').props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByTestId('sign-in-resend'));
    await settle();
    expect(api.calls.filter((c) => c.path === '/auth/start')).toHaveLength(2);
  });

  test('a number that cannot be a mobile is caught before anything is sent', async () => {
    const api = fakeApi();
    await openSignIn(api);
    await fireEvent.press(screen.getByTestId('sign-in-whatsapp'));
    await fireEvent.changeText(screen.getByTestId('sign-in-phone'), '12345');
    await fireEvent.press(screen.getByTestId('sign-in-send'));
    expect(await screen.findByText('Enter a mobile number with WhatsApp, such as 98765 43210.')).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/auth/start')).toBe(false);
    expect([looksLikePhone('+91 98765 43210'), looksLikePhone('9876543210'), looksLikePhone('12345'), looksLikePhone('call me')]).toEqual([true, true, false, false]);
  });

  test('after Delete my account the sign-in screen says that signing in again cancels it', async () => {
    await openSignIn(fakeApi(), { reason: 'account_deleted' });
    expect(screen.getByTestId('sign-in-problem')).toBeTruthy();
    expect(screen.getByText('Your account is set to be deleted. Signing in again before then cancels it.')).toBeTruthy();
  });
});

describe('the signed-in shell', () => {
  beforeEach(() => {
    drawn.length = 0;
  });

  test('P-67 the app is the platform’s throughout; the business’s logo appears only as the workspace badge', async () => {
    const api = fakeApi({ routes: { 'GET /notifications': () => ({ items: [{ id: 1, kind: 'order.new', title: 'New order', body: 'Order MM-1 is waiting', link: '/orders/1', createdAt: new Date().toISOString(), readAt: null }], nextCursor: null, unread: 1 }) } });
    const made = makeServices(api);
    await made.session.adopt(signedInAs());
    await renderShell(made, { list: [testOrders, notificationsFeature] });
    expect(screen.getByTestId('app-mark').props.accessibilityLabel).toBe(APP_NAME);
    expect(screen.getByRole('button', { name: 'Switch business. Now in Alpha Traders' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Notifications, 1 new' })).toBeTruthy();
    const logosEverywhere = () => screen.queryAllByTestId('business-logo', { includeHiddenElements: true });
    const insideBadges = () => screen.queryAllByTestId('workspace-badge', { includeHiddenElements: true }).flatMap((badge) => within(badge).queryAllByTestId('business-logo', { includeHiddenElements: true }));
    expect(logosEverywhere().length).toBeGreaterThan(0);
    expect(logosEverywhere()).toEqual(insideBadges());

    await fireEvent.press(screen.getByTestId('open-notifications')); // an alert for this business
    expect(await screen.findByText('New order')).toBeTruthy();
    expect(logosEverywhere()).toEqual(insideBadges());
    expect(within(screen.getByTestId('notification-1')).queryAllByTestId('business-logo', { includeHiddenElements: true })).toEqual([]);
  });

  test('P-09 the switcher lists exactly the person’s businesses, with what they are in each', async () => {
    const made = makeServices(fakeApi());
    await made.session.adopt(signedInAs());
    await renderShell(made, { list: [testOrders] });
    await fireEvent.press(screen.getByTestId('open-switcher'));
    expect(await screen.findByTestId('switcher-business-1')).toBeTruthy();
    expect(screen.queryAllByTestId(/^switcher-business-/).map((row) => row.props.testID)).toEqual(['switcher-business-1', 'switcher-business-2']);
    expect(screen.getByRole('button', { name: 'Beta Crafts, Staff' })).toBeTruthy();
  });

  test('P-10 switching business never shows a row of the old one, even when its answer arrives after the switch', async () => {
    let releaseA;
    let callsForA = 0;
    const api = fakeApi({
      routes: {
        'GET /orders': async (call) => {
          if (call.tenant === 2) return { items: [{ number: 'B-1' }], nextCursor: null };
          callsForA++;
          if (callsForA === 1) return { items: [{ number: 'A-1' }], nextCursor: null };
          await new Promise((resolve) => { releaseA = resolve; }); // a slow refresh of A's list, still in the air at the switch
          return { items: [{ number: 'A-2' }], nextCursor: null };
        },
      },
    });
    const made = makeServices(api);
    await made.session.adopt(signedInAs());
    await renderShell(made, { list: [testOrders] });
    expect(await screen.findByTestId('order-A-1')).toBeTruthy();
    await act(async () => {
      made.queryClient.invalidateQueries({ queryKey: ['orders'] }); // not awaited: it stays in the air
    });
    await settle(2);
    await fireEvent.press(screen.getByTestId('open-switcher'));
    await fireEvent.press(await screen.findByTestId('switcher-business-2'));
    expect(await screen.findByTestId('order-B-1')).toBeTruthy();
    await act(async () => releaseA?.());
    await settle();
    expect(screen.queryByTestId('order-A-1')).toBeNull();
    expect(screen.queryByTestId('order-A-2')).toBeNull();
    expect(made.queryClient.getQueryData(['orders'])).toEqual({ items: [{ number: 'B-1' }], nextCursor: null });
    expect(drawn.filter((d) => d.tenantId === 2 && d.rows.some((r) => r.startsWith('A-')))).toEqual([]);
    expect(api.calls.filter((c) => c.path === '/orders' && c.tenant === 2)).toHaveLength(1);
  });

  test('P-13 a push for another business switches to it first, then opens the record there', async () => {
    const api = fakeApi({ routes: { 'GET /orders': (call) => ({ items: [{ number: call.tenant === 2 ? 'B-1' : 'A-1' }], nextCursor: null }) } });
    const made = makeServices(api);
    await made.session.adopt(signedInAs());
    const { notifications } = await renderShell(made, { list: [testOrders] });
    await act(async () => notifications.tap({ tenantId: 2, link: '/orders/12', kind: 'order.new' }, 'push-1'));
    expect(await screen.findByText('order 12 in business 2')).toBeTruthy();
    expect(made.session.getState().tenantId).toBe(2);
    // The same push handed back by the system opens nothing more, and a push for a business not theirs does nothing.
    await act(async () => notifications.tap({ tenantId: 2, link: '/orders/12' }, 'push-1'));
    await act(async () => notifications.tap({ tenantId: 9, link: '/orders/1' }, 'push-2'));
    await settle();
    expect(made.session.getState().tenantId).toBe(2);
    expect(api.calls.some((c) => c.tenant === 9)).toBe(false);
  });

  test('P-12 staff see no screen they may not use, and a direct link to one opens nothing', async () => {
    const payments = { name: 'payments', access: { roles: ['owner', 'manager'] }, feature: null, routeIds: [], strings: {}, nav: { label: 'payments.title', order: 50 }, screens: [{ name: 'index', path: 'settings/payments', title: 'payments.title', component: () => <Text testID="payments">payments</Text> }] };
    const made = makeServices(fakeApi({ user: STAFF }));
    await made.session.adopt(signedInAs(STAFF, SHOP_A, MEMBERSHIPS.slice(0, 1)));
    const linking = { getInitialURL: async () => 'bhavabusiness://settings/payments', addEventListener: () => ({ remove() {} }) };
    await renderShell(made, { list: [testOrders, payments], linking });
    expect(screen.queryByTestId('tab-more')).toBeNull();
    expect(screen.queryByTestId('payments')).toBeNull();
  });

  test('P-69 a creator’s account gets the creator’s screens in the same app; a seller’s does not', async () => {
    const creatorPage = { name: 'creator', access: SIGNED_IN, feature: null, routeIds: [], strings: {}, nav: { label: 'creator.title', order: 5, primary: true, accountTypes: ['creator'] }, screens: [{ name: 'index', path: 'creator', title: 'creator.title', component: () => null }] };
    const storeOrders = { ...testOrders, nav: { ...testOrders.nav, accountTypes: ['seller'] } };
    const list = [creatorPage, storeOrders];
    expect(registryProblems(list)).toEqual([]);
    expect(registryProblems([{ ...creatorPage, nav: { ...creatorPage.nav, accountTypes: ['influencer'] } }])).toEqual([expect.stringMatching(/accountTypes/)]);
    const asCreator = buildNavigation(list, { user: OWNER, accountType: 'creator' });
    const asSeller = buildNavigation(list, { user: OWNER, accountType: 'seller' });
    expect(asCreator.tabs.map((f) => f.name)).toEqual(['creator']);
    expect(asSeller.tabs.map((f) => f.name)).toEqual(['orders']);

    const made = makeServices(fakeApi());
    await made.session.adopt(signedInAs(OWNER, SHOP_B, MEMBERSHIPS));
    await renderShell(made, { list });
    expect(screen.getByTestId('tab-creator')).toBeTruthy();
    expect(screen.queryByTestId('tab-orders')).toBeNull();
    expect(screen.getByText('Owner · Creator', { includeHiddenElements: true })).toBeTruthy(); // read out as part of the switch button
  });

  test('P-19 offline, lists show what was saved with the Offline banner, and changes and switching wait', async () => {
    const api = fakeApi({ routes: { 'GET /orders': () => ({ items: [{ number: 'A-1' }], nextCursor: null }), 'GET /auth/devices': () => ({ devices: [{ id: 3, name: 'Pixel 8', platform: 'android', app: 'owner', appVersion: '1.4.0', lastSeenAt: new Date().toISOString(), current: false, deviceUnlock: false }] }) } });
    const made = makeServices(api);
    await made.session.adopt(signedInAs());
    const network = fakeNetwork(true);
    await renderShell(made, { list: [testOrders, devicesFeature], network });
    expect(await screen.findByTestId('order-A-1')).toBeTruthy();
    await act(async () => network.set(false));
    expect(screen.getByTestId('order-A-1')).toBeTruthy(); // the rows in hand stay
    await fireEvent.press(screen.getByTestId('open-switcher'));
    expect(await screen.findByTestId('switcher-business-2')).toBeTruthy();
    expect(screen.getByTestId('offline-banner')).toBeTruthy();
    expect(screen.getByTestId('switcher-business-2').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('switcher-business-1')); // the one in use: just closes
    await fireEvent.press(await screen.findByTestId('tab-more'));
    expect(await screen.findByTestId('offline-banner')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('more-devices'));
    expect(await screen.findByTestId('device-3')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('device-3-revoke').props.accessibilityState.disabled).toBe(true));
  });

  test('P-08 a device revoked elsewhere is signed out by the heartbeat, and SecureStore, the query cache and the saved rows are wiped', async () => {
    const api = fakeApi({ routes: { 'GET /orders': () => ({ items: [{ number: 'A-1' }], nextCursor: null }) } });
    const made = makeServices(api);
    await made.session.adopt(signedInAs());
    await made.store.setLockEnabled(true);
    await renderShell(made, { list: [testOrders] });
    expect(await screen.findByTestId('order-A-1')).toBeTruthy();
    await made.cache.flush();
    expect(made.storage.items.size).toBeGreaterThan(0);

    api.revoke();
    await act(async () => made.session.check()); // what the heartbeat runs every 30 s
    await settle();
    expect(made.session.getState().status).toBe('signedOut');
    expect(held()).toEqual([]);
    expect(made.queryClient.getQueryCache().getAll()).toEqual([]);
    await waitFor(() => expect(made.storage.items.size).toBe(0));
  });

  test('F-110 after the first sign-in on a phone with a fingerprint, the app offers to unlock with it', async () => {
    const made = makeServices(fakeApi(), { localAuth: fakeLocalAuth({ enrolled: true, kind: 1 }) });
    await made.session.adopt(signedInAs(OWNER, SHOP_A, MEMBERSHIPS, { freshUntil: new Date(Date.now() + 300_000).toISOString() }));
    await renderShell(made, { list: [testOrders] });
    expect(await screen.findByText('Open Bhava for Business with your fingerprint?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('lock-offer-yes'));
    await waitFor(async () => expect(await made.store.isLockEnabled()).toBe(true));
    expect(await made.lock.shouldOffer()).toBe(false);
  });

  test('no token, code or phone number reaches the query cache or the console during a session', async () => {
    const api = fakeApi({ routes: { 'GET /orders': () => ({ items: [{ number: 'A-1', phone: '+919811112222' }], nextCursor: null }) } });
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((name) => jest.spyOn(console, name).mockImplementation(() => {}));
    const made = makeServices(api);
    await made.session.adopt(signedInAs());
    await renderShell(made, { list: [testOrders] });
    expect(await screen.findByTestId('order-A-1')).toBeTruthy();
    api.revoke();
    api.family = 'alive';
    api.access = new Set();
    api.refresh = 'r1';
    await act(async () => made.session.check()); // a refresh along the way
    const cached = JSON.stringify(made.queryClient.getQueryCache().getAll().map((q) => q.state.data));
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    for (const secret of ['"a1"', '"r1"', '"a2"', '"r2"', '+919800000001', '+919811112222', '9811112222']) {
      expect([secret, cached.includes(secret)]).toEqual([secret, false]);
      expect([secret, logged.includes(secret)]).toEqual([secret, false]);
    }
    spies.forEach((spy) => spy.mockRestore());
  });
});

describe('the heartbeat', () => {
  test('P-08 it asks every 30 s while the app is open, stops in the background, and asks at once on return', async () => {
    jest.useFakeTimers();
    try {
      let onChange;
      const check = jest.fn(async () => {});
      const appState = { currentState: 'active', addEventListener: (event, fn) => ((onChange = fn), { remove: jest.fn() }) };
      const stop = startHeartbeat({ check, appState });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(check).toHaveBeenCalledTimes(2);
      onChange('background');
      await jest.advanceTimersByTimeAsync(120_000);
      expect(check).toHaveBeenCalledTimes(2);
      onChange('active');
      expect(check).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(check).toHaveBeenCalledTimes(4);
      stop();
      await jest.advanceTimersByTimeAsync(90_000);
      expect(check).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });
});

import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { SIGNED_IN } from '@bhava/app-core/access';
import { fakeApi, fakeNetwork, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';
import notifications from './index.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
const ITEMS = [
  { id: 2, kind: 'order.cod_to_confirm', title: 'Cash on delivery order to confirm', body: 'Order MM-1002 is waiting for you', link: '/orders/1002', createdAt: minutesAgo(5), readAt: null },
  { id: 1, kind: 'report.weekly', title: 'Your weekly report', body: 'Last week in numbers', link: '/reports/9', createdAt: minutesAgo(90), readAt: minutesAgo(60) },
];

const PREFS = {
  quietHours: { enabled: false, from: '22:00', to: '07:00', timezone: 'Asia/Kolkata' },
  events: { 'order.new': { push: true, email: true, whatsapp: false, inapp: true }, 'device.signed_in': { push: true, email: true, whatsapp: false, inapp: true } },
  kinds: [
    { kind: 'order.new', label: 'New orders', critical: false, mandatory: false, channels: ['push', 'email', 'whatsapp'] },
    { kind: 'device.signed_in', label: 'New sign-ins', critical: true, mandatory: true, channels: ['push', 'email'] },
  ],
  available: { push: true, email: true, whatsapp: false, inapp: true },
};

/** A record screen the links can open, so a tap is seen to land. */
const orderDetail = {
  name: 'orders', access: SIGNED_IN, feature: null, routeIds: [], strings: {}, nav: null,
  screens: [{ name: 'detail', path: 'orders/:id', title: 'notifications.title', component: ({ route }) => <Text testID="order-detail">{`order ${route.params.id}`}</Text> }],
};

function api() {
  const server = fakeApi({
    routes: {
      'GET /notifications': (call) => (call.search.includes('unread=1') ? { items: [], nextCursor: null, unread: server.items.filter((i) => !i.readAt).length } : { items: server.items, nextCursor: null, unread: server.items.filter((i) => !i.readAt).length }),
      'POST /notifications/read': (call) => {
        server.items = server.items.map((i) => (call.body.all || call.body.ids.includes(i.id) ? { ...i, readAt: i.readAt ?? new Date().toISOString() } : i));
        return null;
      },
      'GET /notifications/prefs': () => server.prefs,
      'PUT /notifications/prefs': (call) => {
        const { events = {}, quietHours } = call.body;
        server.prefs = {
          ...server.prefs,
          quietHours: { ...server.prefs.quietHours, ...quietHours },
          events: Object.fromEntries(Object.entries(server.prefs.events).map(([kind, channels]) => [kind, { ...channels, ...events[kind] }])),
        };
        return server.prefs;
      },
    },
  });
  server.items = ITEMS.map((i) => ({ ...i }));
  server.prefs = PREFS;
  return server;
}

async function open(server, path, { network } = {}) {
  const made = makeServices(server);
  await made.session.adopt(signedInAs());
  const linking = { getInitialURL: async () => `bhavabusiness:/${path}`, addEventListener: () => ({ remove() {} }) };
  await renderShell(made, { list: [notifications, orderDetail], linking, ...(network ? { network } : {}) });
  return made;
}

test('the bell’s list shows unread first in bold words, and a tap marks it read and opens its record', async () => {
  const server = api();
  await open(server, '/notifications');
  expect(await screen.findByTestId('notification-2')).toBeTruthy();
  expect(screen.getByTestId('notifications-unread')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Unread: Cash on delivery order to confirm, Order MM-1002 is waiting for you' })).toBeTruthy();
  expect(screen.getByText('Order MM-1002 is waiting for you · 5 min ago')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('notification-2'));
  expect(await screen.findByText('order 1002')).toBeTruthy();
  expect(server.calls.filter((c) => c.path === '/notifications/read').map((c) => c.body)).toEqual([{ ids: [2] }]);
});

test('“Mark all as read” clears the unread count, here and on the bell', async () => {
  const server = api();
  await open(server, '/notifications');
  await fireEvent.press(await screen.findByTestId('notifications-mark-all'));
  await waitFor(() => expect(screen.queryByTestId('notifications-unread')).toBeNull());
  expect(server.calls.filter((c) => c.path === '/notifications/read').map((c) => c.body)).toEqual([{ all: true }]);
  expect(screen.getByTestId('notifications-mark-all').props.accessibilityState.disabled).toBe(true);
});

test('settings draw what the server says: a switch per kind and channel, security notices locked, missing senders off', async () => {
  const server = api();
  await open(server, '/notifications/settings');
  expect(await screen.findByTestId('prefs-order.new-push')).toBeTruthy();
  expect(screen.getByTestId('prefs-order.new-whatsapp').props.accessibilityState).toEqual({ checked: false, disabled: true }); // no WhatsApp sender yet
  expect(screen.getByText('Not set up yet.')).toBeTruthy();
  expect(screen.getByTestId('prefs-device.signed_in-push').props.accessibilityState).toEqual({ checked: true, disabled: true });
  expect(screen.getByText('A security notice: it can’t be turned off.')).toBeTruthy();
  expect(screen.queryByTestId('prefs-device.signed_in-whatsapp')).toBeNull(); // not a channel this kind may use

  await fireEvent.press(screen.getByTestId('prefs-order.new-push'));
  await waitFor(() => expect(screen.getByTestId('prefs-order.new-push').props.accessibilityState.checked).toBe(false));
  expect(server.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ events: { 'order.new': { push: false } } }]);
});

test('quiet hours are turned on and set in the phone’s time zone; a time that is not a time is caught', async () => {
  const server = api();
  await open(server, '/notifications/settings');
  await fireEvent.press(await screen.findByTestId('prefs-quiet'));
  expect(await screen.findByTestId('prefs-quiet-from')).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('prefs-quiet-from'), '25:00');
  expect(screen.getByText('Use a time such as 22:00.')).toBeTruthy();
  expect(screen.getByTestId('prefs-quiet-save').props.accessibilityState.disabled).toBe(true);
  await fireEvent.changeText(screen.getByTestId('prefs-quiet-from'), '21:30');
  await fireEvent.press(screen.getByTestId('prefs-quiet-save'));
  await settle();
  const puts = server.calls.filter((c) => c.method === 'PUT').map((c) => c.body.quietHours);
  expect(puts[0]).toMatchObject({ enabled: true, from: '22:00', to: '07:00' });
  expect(puts[1]).toMatchObject({ enabled: true, from: '21:30', to: '07:00' });
  expect(typeof puts[1].timezone).toBe('string');
});

test('offline, every switch waits for a connection and says why', async () => {
  const network = fakeNetwork(true);
  await open(api(), '/notifications/settings', { network });
  expect(await screen.findByTestId('prefs-order.new-push')).toBeTruthy();
  await act(async () => network.set(false));
  await settle();
  expect(screen.getByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('prefs-order.new-push').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('prefs-quiet').props.accessibilityState.disabled).toBe(true);
});

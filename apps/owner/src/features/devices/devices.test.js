import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { fakeApi, fakeNetwork, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';
import devices from './index.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const now = new Date().toISOString();
const LIST = [
  { id: 1, name: 'Pixel 8', platform: 'android', app: 'owner', appVersion: '1.4.0', lastSeenAt: now, current: true, deviceUnlock: true },
  { id: 3, name: '', platform: 'web', app: 'owner', appVersion: '', lastSeenAt: now, current: false, deviceUnlock: false },
];

function api(over = {}) {
  const server = fakeApi({
    routes: {
      'GET /auth/devices': () => ({ devices: server.devices }),
      'DELETE /auth/devices/:id': (call) => {
        server.devices = server.devices.filter((d) => `/auth/devices/${d.id}` !== call.path);
        return null;
      },
      ...over,
    },
  });
  server.devices = [...LIST];
  return server;
}

async function open(server, { network } = {}) {
  const made = makeServices(server);
  await made.session.adopt(signedInAs());
  const linking = { getInitialURL: async () => 'bhavabusiness://settings/devices', addEventListener: () => ({ remove() {} }) };
  await renderShell(made, { list: [devices], linking, ...(network ? { network } : {}) });
  return made;
}

test('P-08 Settings > Devices lists this person’s devices, marks this phone, and signs another out everywhere', async () => {
  const server = api();
  await open(server);
  expect(await screen.findByTestId('device-1')).toBeTruthy();
  expect(screen.getByTestId('device-1-current')).toBeTruthy();
  expect(screen.getByText('Web browser · Last used Just now')).toBeTruthy(); // a browser with no name is called what it is
  await fireEvent.press(screen.getByTestId('device-3-revoke'));
  expect(await screen.findByText('Sign out Web browser?')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('devices-confirm-confirm'));
  await waitFor(() => expect(screen.queryByTestId('device-3')).toBeNull());
  expect(server.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/auth/devices/3']);
  expect(screen.getByTestId('device-1')).toBeTruthy();
});

test('signing out this phone from the list signs out here at once and wipes what the phone held', async () => {
  const server = api();
  const made = await open(server);
  await fireEvent.press(await screen.findByTestId('device-1-revoke'));
  expect(await screen.findByText(/This is the phone you’re using/)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('devices-confirm-confirm'));
  await waitFor(() => expect(made.session.getState().status).toBe('signedOut'));
  expect(Object.keys(SecureStore.__dump()).filter((k) => !k.endsWith('.device_id'))).toEqual([]);
  const paths = server.calls.map((c) => c.path);
  const unregister = paths.findIndex((p) => p.startsWith('/push/devices/'));
  expect(paths.indexOf('/auth/devices/1')).toBeLessThan(unregister); // revoked, then this phone stops hearing pushes
  expect(unregister).toBeLessThan(paths.indexOf('/auth/logout'));
});

test('offline, the saved list shows with the Offline banner and nothing can be signed out', async () => {
  const network = fakeNetwork(true);
  await open(api(), { network });
  expect(await screen.findByTestId('device-3')).toBeTruthy();
  await act(async () => network.set(false));
  await settle();
  expect(screen.getByTestId('offline-banner')).toBeTruthy();
  expect(screen.getByTestId('device-3-revoke').props.accessibilityState.disabled).toBe(true);
});

test('a refused list says so in words and offers a retry, never the server’s message', async () => {
  const server = api({ 'GET /auth/devices': () => [403, { error: 'Internal detail about account 77', code: 'forbidden' }] });
  await open(server);
  expect(await screen.findByText('You don’t have access to this. Ask the owner of this business.')).toBeTruthy();
  expect(screen.queryByText(/account 77/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

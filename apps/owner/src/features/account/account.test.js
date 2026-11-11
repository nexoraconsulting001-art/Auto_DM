import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { SESSION_KEYS } from '@bhava/app-core';
import { Providers, fakeApi, fakeLocalAuth, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';
import { SignInScreen } from '../../shell/SignInScreen.js';
import devices from '../devices/index.js';
import account from './index.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});
// The system browser and the key source, as the screen would get them on a phone.
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(async () => ({ type: 'success', url: 'bhavabusiness://auth/callback?code=link-code-1' })) }));
jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: async (n) => Uint8Array.from({ length: n }, (_, i) => (i * 11 + 5) % 256),
  digestStringAsync: async () => 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=',
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
}));

beforeEach(() => {
  SecureStore.__reset();
  onlineManager.setOnline(true);
});

const held = () => Object.keys(SecureStore.__dump()).filter((key) => SESSION_KEYS.some((name) => key === `bhava.owner.${name}`));
const fresh = () => new Date(Date.now() + 300_000).toISOString();

function api() {
  const server = fakeApi({
    routes: {
      'POST /auth/reauth/start': () => [202, { sent: true, channel: 'whatsapp', expiresInSeconds: 300, resendInSeconds: 30 }],
      'POST /auth/reauth/verify': (call) => (call.body.code === '654321' || call.body.deviceSecret === 'dev-secret' ? { freshUntil: fresh() } : [401, { error: 'Wrong code', code: 'unauthorized' }]),
      'POST /auth/device-unlock': () => [201, { deviceSecret: 'dev-secret' }],
      'POST /auth/delete-account': () => [202, { status: 'requested', requestedAt: '2026-11-12T10:00:00.000Z', dueAt: '2026-12-12T10:00:00.000Z' }],
      'POST /auth/identities': (call) => {
        if (call.body.kind === 'phone' && !call.body.code) return { identities: [{ kind: 'google', label: 'a•••@example.com', verifiedAt: '2026-11-01T00:00:00.000Z' }], pending: true };
        const label = call.body.kind === 'phone' ? '+91 ••••• •3210' : 'n•••@example.com';
        return { identities: [{ kind: call.body.kind, label, verifiedAt: '2026-11-12T00:00:00.000Z' }], pending: false };
      },
    },
  });
  return server;
}

async function open(server, path, { freshUntil = null, localAuth } = {}) {
  const made = makeServices(server, localAuth ? { localAuth } : {});
  await made.session.adopt(signedInAs(undefined, undefined, undefined, { freshUntil }));
  const linking = { getInitialURL: async () => `bhavabusiness:/${path}`, addEventListener: () => ({ remove() {} }) };
  await renderShell(made, { list: [account, devices], linking });
  return made;
}

test('P-26 Delete my account: typed DELETE, a fresh check, the request, then its timeline and a sign-out that wipes the phone', async () => {
  const server = api();
  const made = await open(server, '/settings/account/delete');
  const submit = await screen.findByTestId('deletion-submit');
  expect(submit.props.accessibilityState.disabled).toBe(true);
  await fireEvent.changeText(screen.getByTestId('deletion-confirm'), 'delete');
  expect(screen.getByTestId('deletion-submit').props.accessibilityState.disabled).toBe(true);
  await fireEvent.changeText(screen.getByTestId('deletion-confirm'), 'DELETE');
  await fireEvent.press(screen.getByTestId('deletion-submit'));

  // Not fresh: the re-auth sheet asks for a WhatsApp code first.
  await fireEvent.press(await screen.findByTestId('reauth-send'));
  await fireEvent.changeText(await screen.findByTestId('reauth-code'), '654321');
  await fireEvent.press(screen.getByTestId('reauth-verify'));

  expect(await screen.findByTestId('deletion-timeline')).toBeTruthy();
  expect(screen.getByText('Requested on 12 November 2026')).toBeTruthy();
  expect(screen.getByText('Deleted on 12 December 2026')).toBeTruthy();
  expect(screen.getByText('Sign in again before then if you change your mind.')).toBeTruthy();
  expect(server.calls.filter((c) => c.path === '/auth/delete-account').map((c) => c.body)).toEqual([{ confirm: 'DELETE' }]);
  const order = server.calls.map((c) => c.path);
  expect(order.indexOf('/auth/reauth/verify')).toBeLessThan(order.indexOf('/auth/delete-account'));

  await fireEvent.press(screen.getByTestId('deletion-done'));
  await waitFor(() => expect(made.session.getState()).toMatchObject({ status: 'signedOut', signedOutReason: 'account_deleted' }));
  expect(held()).toEqual([]);
  expect(made.queryClient.getQueryCache().getAll()).toEqual([]);

  await render(<Providers services={made}><SignInScreen /></Providers>);
  expect(screen.getByText('Your account is set to be deleted. Signing in again before then cancels it.')).toBeTruthy();
});

test('closing the fresh check deletes nothing', async () => {
  const server = api();
  await open(server, '/settings/account/delete');
  await fireEvent.changeText(await screen.findByTestId('deletion-confirm'), 'DELETE');
  await fireEvent.press(screen.getByTestId('deletion-submit'));
  await fireEvent.press(await screen.findByRole('button', { name: 'Cancel' }));
  await settle();
  expect(server.calls.some((c) => c.path === '/auth/delete-account')).toBe(false);
  expect(screen.queryByTestId('deletion-failed')).toBeNull();
});

test('F-110 fingerprint unlock is turned on in Your account and keeps the unlock secret; off forgets it', async () => {
  const localAuth = fakeLocalAuth({ enrolled: true, kind: 1 });
  const made = await open(api(), '/settings/account', { freshUntil: fresh(), localAuth });
  await made.lock.markOffered(); // the sign-in offer was answered already
  const toggle = await screen.findByTestId('account-lock');
  await waitFor(() => expect(screen.getByTestId('account-lock').props.accessibilityState.disabled).toBe(false));
  expect(toggle.props.accessibilityLabel).toBe('Unlock with your fingerprint');
  await fireEvent.press(screen.getByTestId('account-lock'));
  await waitFor(async () => expect(await made.store.getDeviceSecret()).toBe('dev-secret'));
  expect(await made.store.isLockEnabled()).toBe(true);
  expect(localAuth.authenticateAsync).toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('account-lock'));
  await waitFor(async () => expect(await made.store.isLockEnabled()).toBe(false));
  expect(await made.store.getDeviceSecret()).toBeNull();
});

test('a WhatsApp number and Google are added as ways in, each after a fresh check, and shown masked', async () => {
  const server = api();
  await open(server, '/settings/account', { freshUntil: fresh() });
  await fireEvent.press(await screen.findByTestId('account-add-phone'));
  await fireEvent.changeText(await screen.findByTestId('account-phone-number'), '98765 43210');
  await fireEvent.press(screen.getByTestId('account-phone-send'));
  await fireEvent.changeText(await screen.findByTestId('account-phone-code'), '112233');
  await fireEvent.press(screen.getByTestId('account-phone-add'));
  expect(await screen.findByText('+91 ••••• •3210')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('account-link-google'));
  expect(await screen.findByText('n•••@example.com')).toBeTruthy();
  const bodies = server.calls.filter((c) => c.path === '/auth/identities').map((c) => c.body);
  expect(bodies.map((b) => b.kind)).toEqual(['phone', 'phone', 'google']);
  expect(bodies[1]).toMatchObject({ phone: '98765 43210', code: '112233' });
  expect(bodies[2]).toMatchObject({ code: 'link-code-1', verifier: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/) });
  const { openAuthSessionAsync } = require('expo-web-browser');
  expect(openAuthSessionAsync.mock.calls[0][0]).toMatch(/\/auth\/google\/start\?target=app&purpose=link&challenge=/); // the system browser, never a web view
});

test('signing out with no connection says so and leaves the person signed in', async () => {
  const server = api();
  const made = await open(server, '/settings/account');
  await screen.findByTestId('account-sign-out');
  server.down = true;
  await fireEvent.press(screen.getByTestId('account-sign-out'));
  expect(await screen.findByTestId('account-sign-out-failed')).toBeTruthy();
  expect(made.session.getState().status).toBe('signedIn');
  expect(held().length).toBeGreaterThan(0);
});

test('the language can be changed to Hindi and is kept for the next launch; signing out tells the server and wipes the phone', async () => {
  const server = api();
  const made = await open(server, '/settings/account');
  await fireEvent.press(await screen.findByTestId('account-language-hi'));
  expect(await screen.findByText('आपका अकाउंट')).toBeTruthy();
  expect(await made.store.getLocale()).toBe('hi');

  await fireEvent.press(screen.getByTestId('account-sign-out'));
  await waitFor(() => expect(made.session.getState().status).toBe('signedOut'));
  const paths = server.calls.map((c) => c.path);
  expect(paths.findIndex((p) => p.startsWith('/push/devices/'))).toBeLessThan(paths.indexOf('/auth/logout'));
  expect(held()).toEqual([]);
  expect(await made.store.getLocale()).toBe('hi'); // not about anyone: kept
});

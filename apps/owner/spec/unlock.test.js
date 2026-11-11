/**
 * PRD 10.3 and 5.11, on the rendered app: fingerprint or face unlock is offered after the first sign-in; with it on,
 * reopening the app asks for the face or fingerprint and opens with no new code; it only releases the refresh token
 * the device already holds, so a session the server ended stays ended; and the other way in is a full sign-in.
 * F-110, P-68.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { fakeApi, openApp, screenText, servicesFor, settle } from './support.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  supportedAuthenticationTypesAsync: jest.fn(async () => [2]),
  getEnrolledLevelAsync: jest.fn(async () => 2),
  authenticateAsync: jest.fn(async () => ({ success: true })),
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

beforeEach(() => {
  SecureStore.__reset();
  LocalAuthentication.authenticateAsync.mockImplementation(async () => ({ success: true }));
  LocalAuthentication.hasHardwareAsync.mockImplementation(async () => true);
  LocalAuthentication.isEnrolledAsync.mockImplementation(async () => true);
});

const UNLOCK_OFFER = /fingerprint|face (unlock|id)|biometric|unlock with/i;

/** Signs in on the sign-in screen with a WhatsApp code, as a person would. */
async function signInByCode(api) {
  await fireEvent.press(await screen.findByTestId('sign-in-whatsapp'));
  await fireEvent.changeText(screen.getByTestId('sign-in-phone'), '9800000001');
  await fireEvent.press(screen.getByTestId('sign-in-send'));
  await fireEvent.changeText(await screen.findByTestId('sign-in-code'), '123456');
  await fireEvent.press(screen.getByTestId('sign-in-verify'));
  await waitFor(() => expect(api.calls.some((c) => c.path === '/auth/verify')).toBe(true));
}

test('F-110: after the first sign-in the app offers fingerprint or face unlock', async () => {
  const api = fakeApi();
  await openApp(api);
  await signInByCode(api);
  await settle(200);
  expect(screenText(screen)).toMatch(UNLOCK_OFFER);
});

test('F-110: a device with no fingerprint or face enrolled is not offered it, and nothing breaks', async () => {
  LocalAuthentication.isEnrolledAsync.mockImplementation(async () => false);
  const api = fakeApi();
  const { made } = await openApp(api);
  await signInByCode(api);
  await waitFor(() => expect(made.session.getState().status).toBe('signedIn'));
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
  expect(await made.lock.available()).toBe(false);
});

test('P-68: with face unlock on, closing and reopening the app asks for the face and opens with no new code', async () => {
  const api = fakeApi();
  const first = servicesFor(api);
  await first.session.adopt(api.session());
  expect((await first.lock.enable('Unlock Bhava for Business')).ok).toBe(true);
  expect(await first.store.isLockEnabled()).toBe(true);

  // Reopened: a new process, the same device.
  const reopened = servicesFor(api);
  const mark = api.calls.length;
  await openApp(api, { services: reopened });
  await waitFor(() => expect(reopened.session.getState().status).toBe('signedIn'), { timeout: 3000 });
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalled();
  const after = api.calls.slice(mark).map((c) => c.path);
  expect(after).not.toContain('/auth/start');
  expect(after).not.toContain('/auth/verify');
  expect(after).toContain('/auth/refresh');
});

test('P-68: the refresh token stays put until the face is checked, and a cancelled check opens nothing', async () => {
  LocalAuthentication.authenticateAsync.mockImplementation(async () => ({ success: false, error: 'user_cancel' }));
  const api = fakeApi();
  const made = servicesFor(api);
  await made.store.setRefreshToken('r1');
  await made.store.setLockEnabled(true);
  await openApp(api, { services: made });
  expect(await screen.findByTestId('lock-screen')).toBeTruthy();
  await settle(100);
  expect(api.calls.some((c) => c.path === '/auth/refresh')).toBe(false);
  expect(made.session.getState().status).toBe('locked');
  expect(screen.queryByTestId('tab-home')).toBeNull();
});

test('P-68: unlocking never replaces the server: a session the server ended stays ended after a good face check', async () => {
  const api = fakeApi({ refresh: 'refused' });
  const made = servicesFor(api);
  await made.store.setRefreshToken('r-revoked');
  await made.store.setLockEnabled(true);
  await openApp(api, { services: made });
  await waitFor(() => expect(made.session.getState().status).toBe('signedOut'), { timeout: 3000 });
  expect(await screen.findByTestId('sign-in')).toBeTruthy();
  expect(await made.store.getRefreshToken()).toBeNull();
});

test('P-68: "Sign in another way" drops the stored session first, so the lock is never simply skipped', async () => {
  LocalAuthentication.authenticateAsync.mockImplementation(async () => ({ success: false, error: 'authentication_failed' }));
  const api = fakeApi();
  const made = servicesFor(api);
  await made.store.setRefreshToken('r1');
  await made.store.setLockEnabled(true);
  await openApp(api, { services: made });
  await fireEvent.press(await screen.findByTestId('lock-sign-in'));
  expect(await screen.findByTestId('sign-in')).toBeTruthy();
  expect(await made.store.getRefreshToken()).toBeNull();
  expect(api.calls.some((c) => c.path === '/auth/refresh')).toBe(false);
  await act(async () => {});
});

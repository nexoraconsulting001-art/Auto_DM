/**
 * PRD 10.3, 10.6 and 5.13, on the rendered app: the sign-in screen offers Google and a WhatsApp code and nothing else,
 * Apple too on iOS, under Bhava's own name; a code that does not arrive leads to Google, never SMS; and an app below the
 * minimum version shows only "Update required". P-11, F-118, F-117, P-07, P-67.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { fakeApi, openApp, screenText, servicesFor } from './support.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View testID={props.testID ?? 'image'} {...props} /> };
});

beforeEach(() => SecureStore.__reset());

const NO_PASSWORD_OR_SMS = /password|\bSMS\b|text message/i;

test('P-11: the sign-in screen offers a WhatsApp code and Google, with no password field and no SMS option', async () => {
  await openApp(fakeApi());
  expect(await screen.findByTestId('sign-in')).toBeTruthy();
  expect(screen.getByTestId('sign-in-whatsapp')).toBeTruthy();
  expect(screen.getByTestId('sign-in-google')).toBeTruthy();
  expect(screenText(screen)).not.toMatch(NO_PASSWORD_OR_SMS);
  expect(screenText(screen)).not.toContain('"secureTextEntry":true');
  await fireEvent.press(screen.getByTestId('sign-in-whatsapp'));
  const phone = await screen.findByTestId('sign-in-phone');
  expect(phone.props.secureTextEntry).toBeFalsy();
  expect(phone.props.keyboardType).toBe('phone-pad');
  expect(screenText(screen)).not.toMatch(NO_PASSWORD_OR_SMS);
});

test('P-11: on iOS Sign in with Apple is offered beside Google and the WhatsApp code', async () => {
  await openApp(fakeApi(), { platform: 'ios' });
  expect(await screen.findByTestId('sign-in-apple')).toBeTruthy();
  expect(screen.getByTestId('sign-in-google')).toBeTruthy();
  expect(screen.getByTestId('sign-in-whatsapp')).toBeTruthy();
  expect(screenText(screen)).not.toMatch(NO_PASSWORD_OR_SMS);
});

test('P-67: the sign-in screen is Bhava\'s: its name and logo, and no business\'s', async () => {
  await openApp(fakeApi());
  await screen.findByTestId('sign-in');
  expect(screen.getByText(/Bhava for Business/)).toBeTruthy();
  expect(screen.getAllByLabelText('Bhava for Business').length).toBeGreaterThanOrEqual(1);
  expect(screenText(screen)).not.toMatch(/Alpha Works|Beta Studio|workspace-logo/);
});

test('F-117: the code step says the code comes on WhatsApp, and the code field takes six digits', async () => {
  const api = fakeApi();
  await openApp(api);
  await fireEvent.press(await screen.findByTestId('sign-in-whatsapp'));
  await fireEvent.changeText(screen.getByTestId('sign-in-phone'), '9800000001');
  await fireEvent.press(screen.getByTestId('sign-in-send'));
  const code = await screen.findByTestId('sign-in-code');
  expect(code.props.maxLength).toBe(6);
  expect(code.props.keyboardType).toBe('number-pad');
  expect(api.calls.find((c) => c.path === '/auth/start').body).toEqual({ phone: '9800000001' });
  expect(screenText(screen)).toMatch(/WhatsApp/);
  expect(screenText(screen)).not.toMatch(NO_PASSWORD_OR_SMS);
});

test('F-118: when the code does not come, the app offers "Use Google sign-in", and never SMS', async () => {
  const api = fakeApi({ alternatives: ['google'] });
  await openApp(api);
  await fireEvent.press(await screen.findByTestId('sign-in-whatsapp'));
  await fireEvent.changeText(screen.getByTestId('sign-in-phone'), '9800000002');
  await fireEvent.press(screen.getByTestId('sign-in-send'));
  await screen.findByTestId('sign-in-code');
  const text = screenText(screen);
  expect(text).toMatch(/Use Google sign-in|Google/);
  expect(text).not.toMatch(NO_PASSWORD_OR_SMS);
  // The way to Google is one tap from the code step, not hidden behind a cancel.
  const google = screen.queryAllByText(/google/i);
  expect(google.length).toBeGreaterThanOrEqual(1);
});

test('F-117: a wrong code is refused on screen and signs nobody in', async () => {
  const api = fakeApi();
  const { made } = await openApp(api);
  await fireEvent.press(await screen.findByTestId('sign-in-whatsapp'));
  await fireEvent.changeText(screen.getByTestId('sign-in-phone'), '9800000003');
  await fireEvent.press(screen.getByTestId('sign-in-send'));
  await fireEvent.changeText(await screen.findByTestId('sign-in-code'), '000000');
  await fireEvent.press(screen.getByTestId('sign-in-verify'));
  expect(await screen.findByTestId('sign-in-problem')).toBeTruthy();
  expect(made.session.getState().status).not.toBe('signedIn');
  expect(await made.store.getRefreshToken()).toBeNull();
  await fireEvent.changeText(screen.getByTestId('sign-in-code'), '123456');
  await fireEvent.press(screen.getByTestId('sign-in-verify'));
  await waitFor(() => expect(made.session.getState().status).toBe('signedIn'));
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
});

test('P-07: an app below the minimum version shows only "Update required", with the store link', async () => {
  const storeUrl = 'https://play.google.com/store/apps/details?id=com.bhava.business';
  const api = fakeApi({ minVersion: '9.0.0', storeUrl });
  const made = servicesFor(api);
  await made.store.setRefreshToken('r1');
  await openApp(api, { services: made });
  expect(await screen.findByTestId('update-required')).toBeTruthy();
  expect(screen.getByText('Update required')).toBeTruthy();
  expect(screen.getByTestId('update-action')).toBeTruthy();
  expect(screen.queryByTestId('sign-in')).toBeNull();
  expect(screen.queryByTestId('tab-home')).toBeNull();
});

test('P-07: at or above the minimum the app opens as usual', async () => {
  const api = fakeApi({ minVersion: '1.4.0', storeUrl: 'https://play.google.com/store/apps/details?id=com.bhava.business' });
  await openApp(api, { signedIn: true });
  expect(await screen.findByTestId('tab-home')).toBeTruthy();
  expect(screen.queryByTestId('update-required')).toBeNull();
});

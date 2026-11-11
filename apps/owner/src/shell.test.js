import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { sellerTheme } from '@bhava/theme';
import { StringsProvider } from '@bhava/app-core';
import { ThemeProvider } from '@bhava/ui';
import App from './App.js';
import { ServicesProvider, createServices } from './services.js';
import { SignInScreen } from './shell/SignInScreen.js';
import { createSignIn, pkceChallenge, randomToken, signInOptions, signInProblem } from './shell/sign-in.js';

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props) => <View {...props} /> };
});

const ORIGIN = 'http://localhost:9';
const constants = { expoConfig: { version: '1.4.0', extra: { apiBaseUrl: ORIGIN } } };
const OWNER = { id: 7, name: 'Asha', phone: '+919800000001', role: 'owner', permissions: [] };
const STAFF = { id: 8, name: 'Ravi', phone: '+919800000002', role: 'staff', permissions: ['orders'] };
const SHOP_A = { id: 1, slug: 'a', name: 'Alpha Traders', plan: 'growth', logoUrl: '', accountType: 'seller' };
const SHOP_B = { id: 2, slug: 'b', name: 'Beta Crafts', plan: 'free', logoUrl: '', accountType: 'creator' };
const MEMBERSHIPS = [
  { id: 1, slug: 'a', name: 'Alpha Traders', role: 'owner', logoUrl: '', current: true },
  { id: 2, slug: 'b', name: 'Beta Crafts', role: 'owner', logoUrl: '', current: false },
];
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const noPush = { getPermissionsAsync: async () => ({ granted: false, canAskAgain: false }), addNotificationResponseReceivedListener: () => ({ remove() {} }), getLastNotificationResponseAsync: async () => null };

function server({ user = OWNER } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = String(url).replace(`${ORIGIN}/api/v1`, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body, tenant: init.headers?.['x-tenant-id'] ?? null });
    const tenant = Number(init.headers?.['x-tenant-id'] ?? 1);
    if (path.startsWith('/app/requirements')) return json(200, { minVersion: '', storeUrl: '', signIn: { whatsapp: true, google: true, apple: true } });
    if (path === '/auth/start') return json(202, { sent: true, channel: 'whatsapp', expiresInSeconds: 300, resendInSeconds: 30, alternatives: ['google'] });
    if (path === '/auth/verify' || path === '/auth/exchange' || path === '/auth/apple') {
      if (path === '/auth/verify' && body.code !== '123456') return json(401, { error: 'That code didn’t work', code: 'unauthorized' });
      return json(201, { user, business: SHOP_A, businesses: MEMBERSHIPS, accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1', created: false, deviceUnlock: false });
    }
    if (path === '/auth/refresh') return json(201, { accessToken: 'a2', accessExpiresInSeconds: 900, refreshToken: 'r2' });
    if (path === '/auth/me') return json(200, { user, business: tenant === 2 ? SHOP_B : SHOP_A, freshUntil: null });
    if (path === '/auth/businesses') return json(200, { businesses: MEMBERSHIPS });
    return json(404, { error: 'Not found', code: 'not_found' });
  };
  return { calls, fetch };
}

const services = (api, platform = 'android') => createServices({ fetch: api.fetch, constants, platform, deviceName: 'Pixel 8' });

async function renderSignIn(api, { platform = 'android', native } = {}) {
  const made = services(api, platform);
  await render(
    <ThemeProvider theme={sellerTheme}>
      <StringsProvider strings={made.strings}>
        <ServicesProvider value={made}>
          <SignInScreen platform={platform} {...(native ? { native } : {})} />
        </ServicesProvider>
      </StringsProvider>
    </ThemeProvider>,
  );
  return { made };
}

beforeEach(() => SecureStore.__reset());

test('P-11 sign-in offers a WhatsApp code and Google, with no password field and no SMS option', async () => {
  const api = server();
  await renderSignIn(api);
  expect(screen.getByTestId('sign-in-whatsapp')).toBeTruthy();
  expect(screen.getByTestId('sign-in-google')).toBeTruthy();
  expect(screen.queryByTestId('sign-in-apple')).toBeNull(); // Android
  expect(screen.getByText('Sign in to Bhava for Business')).toBeTruthy();

  const everything = () => JSON.stringify(screen.toJSON());
  expect(everything()).not.toMatch(/password|SMS|text message/i);
  await fireEvent.press(screen.getByTestId('sign-in-whatsapp'));
  expect(screen.getByTestId('sign-in-phone').props.secureTextEntry).toBeFalsy();
  expect(everything()).not.toMatch(/password|SMS|text message/i);
  expect(everything()).not.toContain('"secureTextEntry":true');
});

test('on iOS, Apple is offered beside Google and WhatsApp', async () => {
  await renderSignIn(server(), { platform: 'ios' });
  expect(screen.getByTestId('sign-in-apple')).toBeTruthy();
  expect(signInOptions({ signIn: { whatsapp: true, google: false, apple: true } }, 'android')).toEqual({ whatsapp: true, google: false, apple: false });
  expect(signInOptions(null, 'ios')).toEqual({ whatsapp: true, google: true, apple: true });
});

test('a WhatsApp code signs in: the number, the code, then the session opens with this device named', async () => {
  const api = server();
  const { made } = await renderSignIn(api);
  await fireEvent.press(await screen.findByTestId('sign-in-whatsapp'));
  await fireEvent.changeText(screen.getByTestId('sign-in-phone'), '9800000001');
  await fireEvent.press(screen.getByTestId('sign-in-send'));
  await fireEvent.changeText(await screen.findByTestId('sign-in-code'), '000000');
  await fireEvent.press(screen.getByTestId('sign-in-verify'));
  expect(await screen.findByTestId('sign-in-problem')).toBeTruthy();
  expect(made.session.getState().status).not.toBe('signedIn');

  await fireEvent.changeText(screen.getByTestId('sign-in-code'), '123456');
  await fireEvent.press(screen.getByTestId('sign-in-verify'));
  await waitFor(() => expect(made.session.getState().status).toBe('signedIn'));
  const verify = api.calls.filter((c) => c.path === '/auth/verify').at(-1);
  expect(verify.body).toMatchObject({ phone: '9800000001', code: '123456', transport: 'bearer', device: { name: 'Pixel 8', platform: 'android', app: 'owner', appVersion: '1.4.0' } });
  expect(verify.body.device.id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(await made.store.getRefreshToken()).toBe('r1');
});

describe('Google and Apple', () => {
  const crypto = {
    getRandomBytesAsync: async (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256),
    digestStringAsync: jest.fn(async (algorithm, text, options) => (options?.encoding === 'base64' ? 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=' : `hex-of-${text.length}`)),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { BASE64: 'base64' },
  };

  test('Google opens the system browser with a PKCE challenge and exchanges the code that comes back', async () => {
    const api = server();
    const made = services(api);
    const browser = { openAuthSessionAsync: jest.fn(async () => ({ type: 'success', url: 'bhavabusiness://auth/callback?code=handoff-1' })) };
    await createSignIn({ session: made.session, config: made.config, crypto, browser }).google();
    const [start, returnTo] = browser.openAuthSessionAsync.mock.calls[0];
    expect(start).toMatch(new RegExp(`^${ORIGIN}/auth/google/start\\?target=app&challenge=[A-Za-z0-9_-]{43}$`));
    expect(returnTo).toBe('bhavabusiness://auth/callback');
    const exchange = api.calls.find((c) => c.path === '/auth/exchange');
    expect(exchange.body.code).toBe('handoff-1');
    expect(exchange.body.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(start).not.toContain(exchange.body.verifier); // the verifier never leaves the app until the exchange
    expect(made.session.getState().status).toBe('signedIn');
  });

  test('a closed browser, a refusal and a link from elsewhere sign nobody in', async () => {
    const api = server();
    const made = services(api);
    const flow = (result) => createSignIn({ session: made.session, config: made.config, crypto, browser: { openAuthSessionAsync: async () => result } }).google();
    await expect(flow({ type: 'cancel' })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(flow({ type: 'success', url: 'bhavabusiness://auth/callback?error=denied' })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(flow({ type: 'success', url: 'otherapp://auth/callback?code=x' })).rejects.toMatchObject({ code: 'failed' });
    expect(api.calls.some((c) => c.path === '/auth/exchange')).toBe(false);
    expect(signInProblem({ code: 'cancelled' })).toBe('signIn.cancelled');
    expect(signInProblem({ status: 0, code: 'network' })).toBe('signIn.network');
    expect(signInProblem(new Error('x'))).toBe('signIn.failed');
  });

  test('Apple is given the hash of a nonce and the server the raw one', async () => {
    const api = server();
    const made = services(api, 'ios');
    const apple = { AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 }, signInAsync: jest.fn(async () => ({ identityToken: 'apple.identity.token', fullName: { givenName: 'Asha', familyName: 'K' } })) };
    await createSignIn({ session: made.session, config: made.config, crypto, apple }).apple();
    const sent = api.calls.find((c) => c.path === '/auth/apple').body;
    expect(apple.signInAsync.mock.calls[0][0].nonce).toBe(`hex-of-${sent.nonce.length}`);
    expect(sent).toMatchObject({ identityToken: 'apple.identity.token', name: 'Asha K', device: { platform: 'ios' } });
    expect(sent.nonce).not.toBe(apple.signInAsync.mock.calls[0][0].nonce);
  });

  test('a verifier is 64 URL-safe characters and its challenge is unpadded base64url', async () => {
    expect(await randomToken(crypto, 64)).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(await pkceChallenge(crypto, 'v')).toBe('q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA');
  });
});

describe('the whole app', () => {
  async function open(api, platform = 'android') {
    const made = services(api, platform);
    await render(<App services={made} notifications={noPush} />);
    return made;
  }

  test('with nothing stored it opens on sign-in, under the platform’s own name', async () => {
    await open(server());
    expect(await screen.findByTestId('sign-in')).toBeTruthy();
    expect(screen.getByText('Sign in to Bhava for Business')).toBeTruthy();
  });

  test('a build with no API address says so and offers no way to sign in', async () => {
    const made = createServices({ constants: { expoConfig: { extra: {} } }, platform: 'android' });
    await render(<App services={made} notifications={noPush} />);
    expect(await screen.findByTestId('sign-in-not-configured')).toBeTruthy();
    expect(screen.queryByTestId('sign-in-whatsapp')).toBeNull();
  });

  test('signed in, an owner gets the four tabs and More, built from the registry', async () => {
    const api = server();
    const made = await open(api);
    await act(async () => {
      await made.session.adopt({ user: OWNER, business: SHOP_A, businesses: MEMBERSHIPS, accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1' });
    });
    for (const tab of ['home', 'orders', 'products', 'reels', 'more']) expect(await screen.findByTestId(`tab-${tab}`)).toBeTruthy();
    expect(screen.getByTestId('screen-home')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('tab-more'));
    expect(await screen.findByTestId('more-payments')).toBeTruthy();
    expect(screen.getByTestId('more-team')).toBeTruthy();
    expect(screen.queryByTestId('more-billing')).toBeNull();
  });

  test('staff with only the orders permission see no screen they may not use', async () => {
    const api = server({ user: STAFF });
    const made = await open(api);
    await act(async () => {
      await made.session.adopt({ user: STAFF, business: SHOP_A, businesses: MEMBERSHIPS.slice(0, 1), accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1' });
    });
    expect(await screen.findByTestId('tab-orders')).toBeTruthy();
    expect(screen.queryByTestId('tab-products')).toBeNull();
    await fireEvent.press(screen.getByTestId('tab-more'));
    expect(await screen.findByTestId('more-returns')).toBeTruthy();
    for (const hidden of ['payments', 'team', 'settings', 'automations']) expect(screen.queryByTestId(`more-${hidden}`)).toBeNull();
  });

  test('the switcher lists exactly the person’s businesses, and choosing one works in it', async () => {
    const api = server();
    const made = await open(api);
    await act(async () => {
      await made.session.adopt({ user: OWNER, business: SHOP_A, businesses: MEMBERSHIPS, accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1' });
    });
    await fireEvent.press(await screen.findByTestId('open-switcher'));
    expect(await screen.findByTestId('switcher-business-1')).toBeTruthy();
    expect(screen.getByTestId('switcher-business-2')).toBeTruthy();
    expect(screen.queryAllByTestId(/^switcher-business-/)).toHaveLength(2);
    made.queryClient.setQueryData(['orders'], { items: ['an order of Alpha Traders'] });
    await fireEvent.press(screen.getByTestId('switcher-business-2'));
    await waitFor(() => expect(made.session.getState().tenantId).toBe(2));
    expect(made.queryClient.getQueryData(['orders'])).toBeUndefined(); // nothing of the old business is kept
    expect(api.calls.filter((c) => c.path === '/auth/me').at(-1).tenant).toBe('2');
    expect(await screen.findByTestId('tab-home')).toBeTruthy();
  });

  test('when the API says the app is too old, only “Update required” shows', async () => {
    const api = server();
    api.fetch = async () => json(426, { error: 'Update required', code: 'update_required', storeUrl: 'https://play.google.com/store/apps/details?id=com.bhava.business' });
    const made = createServices({ fetch: (...args) => api.fetch(...args), constants, platform: 'android' });
    await made.store.setRefreshToken('r1');
    await render(<App services={made} notifications={noPush} />);
    expect(await screen.findByTestId('update-required')).toBeTruthy();
    expect(screen.getByText(/Bhava for Business is too old/)).toBeTruthy();
    expect(screen.queryByTestId('sign-in')).toBeNull();
  });
});

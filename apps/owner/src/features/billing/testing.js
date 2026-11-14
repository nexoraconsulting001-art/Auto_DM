/**
 * What the Phase 7 screens' tests share: the signed-in app opened on one path over the shell's stand-in API, as an owner, a
 * manager or a creator, on Android or iOS. Only tests import this file, so it never reaches the app's bundle.
 */
import { act, fireEvent, screen } from '@testing-library/react-native';
import { fakeApi, fakeNetwork, makeServices, renderShell, settle, signedInAs, OWNER, SHOP_A, SHOP_B, MEMBERSHIPS } from '../../shell/testing.js';

export { OWNER, SHOP_A, SHOP_B, fakeNetwork, settle };
export const MANAGER = Object.freeze({ id: 9, name: 'Meera', phone: '+919800000003', role: 'manager', permissions: [] });
export const CREATOR_FREE = Object.freeze({ ...SHOP_B, plan: 'free', accountType: 'creator' });
export const SELLER_T1 = Object.freeze({ ...SHOP_A, plan: 't1', accountType: 'seller' });
export const AT = '2026-11-12T10:00:00.000Z';

export const fresh = () => new Date(Date.now() + 300_000).toISOString();

/** The re-auth routes, as the server answers them: code 654321 works. */
export const reauthRoutes = () => ({
  'POST /auth/reauth/start': () => [202, { sent: true, channel: 'whatsapp', expiresInSeconds: 300, resendInSeconds: 30 }],
  'POST /auth/reauth/verify': (call) => (call.body.code === '654321' ? { freshUntil: fresh() } : [401, { error: 'Wrong code', code: 'unauthorized' }]),
});

const opened = [];

/** After each test: every app opened is emptied, so no query's clean-up timer holds the test process open. */
export async function forgetApps() {
  for (const made of opened.splice(0)) {
    await made.cache?.flush?.().catch?.(() => {});
    made.queryClient.clear();
  }
}

/** Opens the app signed in as `user` in `business`, on `path`, with `list` the features it registers. */
export async function openAt(path, { list, routes = {}, user = OWNER, business = SELLER_T1, platform = 'android', network = fakeNetwork(true), freshUntil = null } = {}) {
  const server = fakeApi({ user, routes: { ...reauthRoutes(), ...routes } });
  const made = makeServices(server, { platform });
  opened.push(made);
  await made.session.adopt(signedInAs(user, business, MEMBERSHIPS, { freshUntil }));
  const linking = { getInitialURL: async () => (path ? `bhavabusiness:/${path}` : null), addEventListener: () => ({ remove() {} }) };
  const shown = await renderShell(made, { list, linking, network });
  await settle();
  return { server, made, network, ...shown };
}

/** The calls the app made that change something. */
export const writes = (server) => server.calls.filter((call) => call.method !== 'GET');

/** Everything on screen as text, for searching. */
export const screenText = () => JSON.stringify(screen.toJSON());

/** Presses the first thing whose text matches, then lets the screen settle. */
export async function press(pattern, { last = false } = {}) {
  const found = await screen.findAllByText(pattern);
  await fireEvent.press(last ? found[found.length - 1] : found[0]);
  await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
}

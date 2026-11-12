/**
 * What the store and account screens' tests share: the signed-in app opened on one path, over the shell's stand-in
 * API, with the routes a test answers. Only tests import this file, so it never reaches the app's bundle.
 */
import { fakeApi, fakeNetwork, makeServices, renderShell, settle, signedInAs, OWNER, SHOP_A, MEMBERSHIPS } from '../../../shell/testing.js';

export const MANAGER = Object.freeze({ id: 9, name: 'Meera', phone: '+919800000003', role: 'manager', permissions: [] });
export const ORDERS_STAFF = Object.freeze({ id: 8, name: 'Ravi', phone: '+919800000002', role: 'staff', permissions: ['orders'] });
export const CATALOG_STAFF = Object.freeze({ id: 10, name: 'Kiran', phone: '+919800000004', role: 'staff', permissions: ['catalog'] });

export const fresh = () => new Date(Date.now() + 300_000).toISOString();
export const AT = '2026-11-12T10:00:00.000Z';

/** The re-auth routes, as the server answers them: code 654321 works, anything else is refused. */
export const reauthRoutes = () => ({
  'POST /auth/reauth/start': () => [202, { sent: true, channel: 'whatsapp', expiresInSeconds: 300, resendInSeconds: 30 }],
  'POST /auth/reauth/verify': (call) => (call.body.code === '654321' ? { freshUntil: fresh() } : [401, { error: 'Wrong code', code: 'unauthorized' }]),
});

/**
 * Opens the app signed in as `user` on `path`, with `list` the features it registers. `freshUntil` says whether the
 * session starts fresh. Answers { server, made, network }.
 */
const opened = [];

/**
 * After each test: every app opened is emptied, so no query's clean-up timer (kept for days, as the offline cache wants)
 * holds the test process open. Call it from afterEach.
 */
export async function forgetApps() {
  for (const made of opened.splice(0)) {
    await made.cache?.flush?.().catch?.(() => {});
    made.queryClient.clear();
  }
}

export async function openApp({ list, path, routes = {}, user = OWNER, freshUntil = null, network = fakeNetwork(true), storage } = {}) {
  const server = fakeApi({ user, routes: { ...reauthRoutes(), ...routes } });
  const made = makeServices(server, storage ? { storage } : {});
  opened.push(made);
  await made.session.adopt(signedInAs(user, SHOP_A, MEMBERSHIPS, { freshUntil }));
  const linking = { getInitialURL: async () => (path ? `bhavabusiness:/${path}` : null), addEventListener: () => ({ remove() {} }) };
  const shown = await renderShell(made, { list, linking, network });
  await settle();
  return { server, made, network, ...shown };
}

/** The calls the app made that change something. */
export const writes = (server) => server.calls.filter((call) => call.method !== 'GET');

/** Everything the phone holds: the query cache in memory and what was written to its storage file. */
export function everythingHeld(made) {
  const inMemory = JSON.stringify(made.queryClient.getQueryCache().getAll().map((q) => q.state.data ?? null));
  const mutations = JSON.stringify(made.queryClient.getMutationCache().getAll().map((m) => m.state));
  const onDisk = JSON.stringify([...(made.storage?.items?.values?.() ?? [])]);
  return `${inMemory}\n${mutations}\n${onDisk}`;
}

/** What was written to the phone's storage file only. */
export const heldOnDisk = (made) => JSON.stringify([...(made.storage?.items?.values?.() ?? [])]);

export { settle };

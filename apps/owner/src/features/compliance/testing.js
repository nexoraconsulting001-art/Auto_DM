/**
 * What the automation-side features' tests share (home, automations, inbox, connect, compliance, links, alerts,
 * activity, reels, domains): the app opened at a path, signed in as someone, on the stand-in API. Only tests import
 * this file, so it never reaches the app's bundle.
 */
import * as SecureStore from 'expo-secure-store';
import { onlineManager } from '@tanstack/react-query';
import { OWNER, SHOP_A, fakeApi, fakeNetwork, makeServices, renderShell, settle, signedInAs } from '../../shell/testing.js';

export { settle };
export const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
export const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
export const page = (items, nextCursor = null) => ({ items, nextCursor });
export const staff = (permissions, id = 8) => ({ id, name: 'Ravi Kumar', phone: '+919800000002', role: 'staff', permissions });
export const MANAGER = Object.freeze({ id: 9, name: 'Mina Shah', phone: '+919800000003', role: 'manager', permissions: [] });
export const FREE_SHOP = Object.freeze({ ...SHOP_A, plan: 'free' });

export function reset() {
  SecureStore.__reset();
  onlineManager.setOnline(true);
}

/** Every call that changes something: not a read, and not one of the checks that only read (a preview, a link check). */
export const writes = (server) => server.calls.filter((call) => call.method !== 'GET' && !/\/preview$|^\/links\/check$/.test(call.path));
export const callsTo = (server, method, path) => server.calls.filter((call) => call.method === method && (path instanceof RegExp ? path.test(call.path) : call.path === path));

/**
 * The app at `path`, signed in as `user` in `business`, with `list` as its features (just the ones a test needs, so
 * no other screen asks the API anything). `routes` answers the API as in fakeApi.
 */
export async function openAt(path, { user = OWNER, business = SHOP_A, routes = {}, list, network = fakeNetwork(true), storage, platform } = {}) {
  const server = fakeApi({ user, routes });
  const made = makeServices(server, { ...(storage ? { storage } : {}), ...(platform ? { platform } : {}) });
  await made.session.adopt(signedInAs(user, business));
  const linking = { getInitialURL: async () => `bhavabusiness:/${path}`, addEventListener: () => ({ remove() {} }) };
  const shown = await renderShell(made, { list, linking, network });
  await settle();
  return { server, made, network, ...shown };
}

/** Everything on screen as one string, to search for words that must not be there. */
export const screenText = (screen) => JSON.stringify(screen.toJSON());

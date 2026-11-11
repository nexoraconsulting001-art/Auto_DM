/**
 * Everything the app is made of, built once at launch and handed to screens through `useServices()`:
 *
 *   const { session, api, queryClient, lock, config, strings } = useServices();
 *
 * `api` is the seller API client, signed in and scoped to the business in use. Screens read with react-query and
 * `api`, and never hold a token or the fetch function themselves.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import { createLock, createOfflineCache, createQueryClient, createSecureStore, createSession, createStrings, readAppConfig } from '@bhava/app-core';
import { catalogue } from './strings.js';

export const STORAGE_PREFIX = 'bhava.owner';

/**
 * `overrides` is for tests: `fetch`, `constants`, `platform`, `storage` (the offline cache's key-value store),
 * `locale`, `deviceName`. A build with no API address gets `configError` and no session, and says so on screen.
 */
export function createServices({ fetch, constants, platform, storage, locale = 'en', deviceName = '' } = {}) {
  const strings = createStrings(catalogue, { locale });
  let config = null;
  let configError = null;
  try {
    config = readAppConfig({ name: 'owner', constants, platform });
  } catch (error) {
    configError = error;
  }
  if (!config) return { strings, config, configError, session: null, api: null, store: null, lock: null, queryClient: createQueryClient(), cache: null };

  const store = createSecureStore({ prefix: STORAGE_PREFIX });
  const session = createSession({ baseUrl: config.apiBaseUrl, app: config.app, store, fetch, deviceName });
  const queryClient = createQueryClient();
  const cache = storage ? createOfflineCache({ storage, getTenantId: () => session.getState().tenantId, buster: config.app.version }) : null;
  // Nothing of the old business stays on screen or in memory once another is chosen (P-10); signing out empties the device.
  session.on('switch', () => queryClient.clear());
  session.on('signedOut', () => {
    queryClient.clear();
    cache?.clearAll().catch(() => {});
  });
  return { strings, config, configError, session, api: session.api, store, lock: createLock({ store }), queryClient, cache };
}

const ServicesContext = createContext(null);
export const ServicesProvider = ServicesContext.Provider;

export function useServices() {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices needs the ServicesProvider that App.js sets up');
  return services;
}

/** The session's state, re-rendering when it changes: { status, user, business, businesses, tenantId, offline, ... }. */
export function useSession() {
  const { session } = useServices();
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}

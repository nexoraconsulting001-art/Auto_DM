/**
 * The offline list cache (PRD 10.4): lists a seller opened are kept on the device, so they show with no connection.
 * Writes are never queued: a change needs the server, and a screen disables its buttons while offline.
 *
 * What is kept is react-query's cache, written to the app's own SQLite file (expo-sqlite's key-value store), under
 * one key per business. Switching business reads the other key and never shows the old one's rows (P-10); signing
 * out deletes them all. No token is ever in it: tokens live in SecureStore only.
 */
import { QueryClient, onlineManager } from '@tanstack/react-query';

export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KEY = 'bhava.cache';
const INDEX = `${KEY}.index`;

/** `storage` is anything with getItem, setItem and removeItem that answer promises: expo-sqlite/kv-store in the app. */
export function createOfflineCache({ storage, getTenantId, buster = '', throttleMs = 1000 }) {
  const keyFor = (tenantId) => `${KEY}.${tenantId}`;
  let timer = null;
  let pending = null;

  async function remember(tenantId) {
    const known = JSON.parse((await storage.getItem(INDEX)) ?? '[]');
    if (!known.includes(tenantId)) await storage.setItem(INDEX, JSON.stringify([...known, tenantId]));
  }

  async function write() {
    timer = null;
    const job = pending;
    pending = null;
    if (!job) return;
    try {
      await remember(job.tenantId);
      await storage.setItem(keyFor(job.tenantId), JSON.stringify(job.client));
    } catch {
      // A full disk or a value that cannot be written costs the offline copy, never the screen.
    }
  }

  /** A react-query persister: PersistQueryClientProvider's `persistOptions.persister`. */
  const persister = {
    persistClient(client) {
      const tenantId = getTenantId();
      if (!tenantId) return;
      pending = { tenantId, client };
      timer ??= setTimeout(write, throttleMs);
    },
    async restoreClient() {
      const tenantId = getTenantId();
      if (!tenantId) return undefined;
      try {
        const text = await storage.getItem(keyFor(tenantId));
        return text ? JSON.parse(text) : undefined;
      } catch {
        return undefined;
      }
    },
    async removeClient() {
      const tenantId = getTenantId();
      pending = null;
      if (tenantId) await storage.removeItem(keyFor(tenantId));
    },
  };

  return {
    persister,
    persistOptions: {
      persister,
      maxAge: CACHE_MAX_AGE_MS,
      buster,
      // Only finished lists and records are kept. A query may opt out with meta: { offline: false } (anything secret).
      dehydrateOptions: { shouldDehydrateQuery: (query) => query.state.status === 'success' && query.meta?.offline !== false },
    },
    /** Writes anything still waiting, for a test or before the app goes to the background. */
    async flush() {
      if (timer) clearTimeout(timer);
      await write();
    },
    /** At sign-out: every business's rows leave the device. */
    async clearAll() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      const known = JSON.parse((await storage.getItem(INDEX)) ?? '[]');
      await Promise.all(known.map((tenantId) => storage.removeItem(keyFor(tenantId))));
      await storage.removeItem(INDEX);
    },
  };
}

/**
 * The query client every app uses: reads answer from the cache first and refetch when online; a change is tried
 * only with a connection and never replayed later.
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: CACHE_MAX_AGE_MS, staleTime: 30_000, networkMode: 'offlineFirst', retry: (count, error) => count < 2 && !(error?.status >= 400 && error?.status < 500) },
      mutations: { networkMode: 'online', retry: false },
    },
  });
}

/** Tells react-query whether there is a connection. `network` is expo-network. Returns the way to stop. */
export function watchConnection(network, onChange = () => {}) {
  const apply = (state) => {
    const online = state?.isConnected !== false && state?.isInternetReachable !== false;
    onlineManager.setOnline(online);
    onChange(online);
  };
  Promise.resolve(network.getNetworkStateAsync()).then(apply).catch(() => {});
  const subscription = network.addNetworkStateListener(apply);
  return () => subscription.remove();
}

/**
 * The offline list cache (PRD 10.4): lists a seller opened are kept on the device, so they show with no connection.
 * Writes are never queued: a change needs the server, and a screen disables its buttons while offline (P-19).
 *
 * What is kept is react-query's cache, written to the app's own SQLite file (expo-sqlite's key-value store), under
 * one key per business. Switching business reads the other key and never shows the old one's rows (P-10); signing
 * out deletes them all. No token, code or phone number is ever in it, in memory or on disk: tokens live in SecureStore
 * only, and anything shaped like one is taken out of an answer before react-query keeps it (`scrub`).
 */
import { useSyncExternalStore } from 'react';
import { MutationCache, QueryClient, hydrate, onlineManager } from '@tanstack/react-query';

export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KEY = 'bhava.cache';
const INDEX = `${KEY}.index`;

// ---- What never goes into the cache ----

/** Keys whose value is a secret wherever they appear in an answer. */
const SECRET_KEYS = /^(access_?token|refresh_?token|id_?token|identity_?token|device_?secret|token|secret|password|otp|api_?key_?secret|key_?secret|verifier)$/i;
/** Keys that hold a person's number. */
const PHONE_KEYS = /^(phone|mobile|whatsapp|phone_?number|whatsapp_?number|msisdn)$/i;
const ONE_TIME_CODE = /^\d{4,8}$/;

/** A number for a person to recognise and nobody else to use: +91 ••••• •3210. Already masked or too short stays as it is. */
export function maskPhoneNumber(value) {
  const text = String(value ?? '');
  const digits = text.replace(/\D/g, '');
  if (text.includes('•') || digits.length < 8) return text;
  const country = text.trim().startsWith('+') && digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : '';
  return `${country}••••• •${digits.slice(-4)}`;
}

/**
 * The same answer with every secret taken out and every phone number masked, at any depth. A key named `code`
 * holding a bare one-time code (four to eight digits) goes too; a coupon's code or an error code stays.
 */
export function scrub(data, depth = 0) {
  if (depth > 12 || data === null || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((item) => scrub(item, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEYS.test(key)) continue;
    if (key === 'code' && typeof value === 'string' && ONE_TIME_CODE.test(value)) continue;
    out[key] = PHONE_KEYS.test(key) && typeof value === 'string' ? maskPhoneNumber(value) : scrub(value, depth + 1);
  }
  return out;
}

/** True when an answer still holds something `scrub` would take out: such a query is never written to the device. */
export function holdsSecret(data, depth = 0) {
  if (depth > 12 || data === null || typeof data !== 'object') return false;
  if (Array.isArray(data)) return data.some((item) => holdsSecret(item, depth + 1));
  return Object.entries(data).some(([key, value]) =>
    SECRET_KEYS.test(key) ||
    (key === 'code' && typeof value === 'string' && ONE_TIME_CODE.test(value)) ||
    (PHONE_KEYS.test(key) && typeof value === 'string' && maskPhoneNumber(value) !== value) ||
    holdsSecret(value, depth + 1));
}

// ---- The cache on the device ----

/** `storage` is anything with getItem, setItem and removeItem that answer promises: expo-sqlite/kv-store in the app. */
export function createOfflineCache({ storage, getTenantId, buster = '', throttleMs = 1000, now = () => Date.now() }) {
  const keyFor = (tenantId) => `${KEY}.${tenantId}`;
  let timer = null;
  let pending = null;

  async function known() {
    try {
      const list = JSON.parse((await storage.getItem(INDEX)) ?? '[]');
      return Array.isArray(list) ? list.filter((id) => Number.isInteger(id) && id > 0) : [];
    } catch {
      return [];
    }
  }

  async function remember(tenantId) {
    const list = await known();
    if (!list.includes(tenantId)) await storage.setItem(INDEX, JSON.stringify([...list, tenantId]));
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

  async function read(tenantId) {
    try {
      const text = await storage.getItem(keyFor(tenantId));
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A react-query persister: PersistQueryClientProvider's `persistOptions.persister`. */
  const persister = {
    persistClient(client) {
      const tenantId = getTenantId();
      if (!tenantId) return;
      // An empty cache is one that was just cleared (a switch of business, a sign-out): it never replaces a saved copy.
      if (!client?.clientState?.queries?.length) return;
      pending = { tenantId, client };
      timer ??= setTimeout(write, throttleMs);
    },
    async restoreClient() {
      const tenantId = getTenantId();
      return tenantId ? read(tenantId) : undefined;
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
      dehydrateOptions: {
        // Only finished lists and records are kept, and never one holding a secret. A query may opt out with
        // meta: { offline: false }. A change is never kept: writes are not queued for later.
        shouldDehydrateQuery: (query) => query.state.status === 'success' && query.meta?.offline !== false && !holdsSecret(query.state.data),
        shouldDehydrateMutation: () => false,
      },
    },
    /**
     * Puts the saved rows of the business in use into `queryClient`, before its screens draw: at launch, and after a
     * switch. Nothing older than CACHE_MAX_AGE_MS or saved by another version of the app is used. Answers how many
     * queries came back.
     */
    async restoreInto(queryClient) {
      const tenantId = getTenantId();
      if (!tenantId) return 0;
      const saved = await read(tenantId);
      if (!saved?.clientState || saved.buster !== buster || !(now() - Number(saved.timestamp) < CACHE_MAX_AGE_MS)) return 0;
      if (getTenantId() !== tenantId) return 0; // switched again while reading
      try {
        hydrate(queryClient, { queries: saved.clientState.queries ?? [], mutations: [] });
      } catch {
        return 0;
      }
      return saved.clientState.queries?.length ?? 0;
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
      await Promise.all((await known()).map((tenantId) => storage.removeItem(keyFor(tenantId))));
      await storage.removeItem(INDEX);
    },
  };
}

// ---- The query client ----

/** What a change made with no connection fails with, at once: it is never kept to be sent later (react-query's paused mutations). */
export class OfflineError extends Error {
  constructor() {
    super('No connection');
    this.name = 'OfflineError';
    this.status = 0;
    this.code = 'offline';
  }
}

/** Keeps react-query's own sharing of unchanged parts, after the answer has been scrubbed. */
function scrubbedSharing(previous, next) {
  const clean = scrub(next);
  return previous === undefined ? clean : shareUnchanged(previous, clean);
}

function shareUnchanged(a, b) {
  if (a === b) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = b.map((item, i) => shareUnchanged(a[i], item));
    return out.length === a.length && out.every((item, i) => item === a[i]) ? a : out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = Object.keys(b);
    const out = {};
    for (const key of keys) out[key] = shareUnchanged(a[key], b[key]);
    return keys.length === Object.keys(a).length && keys.every((key) => out[key] === a[key]) ? a : out;
  }
  return b;
}

/**
 * The query client every app uses: reads answer from the cache first and refetch when online; a change is tried
 * only with a connection, fails at once without one, and is never replayed later.
 */
export function createQueryClient({ isOnline = () => onlineManager.isOnline() } = {}) {
  return new QueryClient({
    mutationCache: new MutationCache({
      onMutate: () => {
        if (!isOnline()) throw new OfflineError();
      },
    }),
    defaultOptions: {
      queries: {
        gcTime: CACHE_MAX_AGE_MS,
        staleTime: 30_000,
        networkMode: 'offlineFirst',
        retry: (count, error) => count < 2 && !(error?.status >= 400 && error?.status < 500),
        structuralSharing: scrubbedSharing,
      },
      // In 'online' mode react-query would pause a change made offline and send it later; the guard above fails it
      // first, and the persister never saves one, so nothing is ever sent on a connection that comes back.
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
  // A build or a test with no network module simply never reports offline.
  let subscription = null;
  try {
    Promise.resolve(network?.getNetworkStateAsync?.()).then(apply).catch(() => {});
    subscription = network?.addNetworkStateListener?.(apply) ?? null;
  } catch {
    subscription = null;
  }
  return () => subscription?.remove?.();
}

/** True while there is a connection, re-rendering when it changes: a screen disables its changes when it is false. */
export function useOnline() {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
}

/**
 * The last downloaded catalogue stays on the device (PRD 10.4, P-70): what the shopper opened is written to the app's own
 * key-value file, one key per business, and put back before the first screen when the app opens with no connection.
 * Tokens and phone numbers never go in (app-core's `scrub`). The connection state feeds react-query, so a screen
 * knows to say "offline" instead of failing.
 */
import { useEffect, useMemo, useState } from 'react';
import { dehydrate } from '@tanstack/react-query';
import { CACHE_MAX_AGE_MS, createOfflineCache, watchConnection } from '@bhava/app-core/cache';

/** What only a real device has. A build or a test without them simply has no offline copy. */
function deviceStorage() {
  try {
    return require('expo-sqlite/kv-store').default;
  } catch {
    return null;
  }
}

function deviceNetwork() {
  try {
    return require('expo-network');
  } catch {
    return null;
  }
}

/** Defaults the browsing screens need, set only where the app did not choose a value itself. */
export function ensureDefaults(queryClient) {
  const have = queryClient.getDefaultOptions().queries ?? {};
  const wanted = {
    gcTime: CACHE_MAX_AGE_MS,
    staleTime: 30_000,
    networkMode: 'offlineFirst',
    retry: (count, error) => count < 2 && !(error?.status >= 400 && error?.status < 500),
  };
  const missing = Object.fromEntries(Object.entries(wanted).filter(([key]) => have[key] === undefined));
  if (Object.keys(missing).length) queryClient.setDefaultOptions({ ...queryClient.getDefaultOptions(), queries: { ...have, ...missing } });
}

/**
 * Restores the saved catalogue before the screens draw, keeps saving as answers arrive, and follows the connection.
 * `services.offlineStorage` and `services.network` replace the device's, for tests. Returns { ready }.
 */
export function useOfflineCache(services) {
  const storage = useMemo(() => services.offlineStorage ?? deviceStorage(), [services]);
  const [ready, setReady] = useState(!storage);

  useEffect(() => {
    const queryClient = services.queryClient;
    ensureDefaults(queryClient);
    const stopNetwork = watchConnection(services.network ?? deviceNetwork());
    if (!storage) return () => stopNetwork();
    const buster = services.config.app.version;
    const cache = createOfflineCache({ storage, getTenantId: () => services.config.brand.tenantId, buster });
    let live = true;
    cache.restoreInto(queryClient).catch(() => 0).then(() => live && setReady(true));
    const stopSaving = queryClient.getQueryCache().subscribe((event) => {
      if (event?.type !== 'updated' || event.action?.type !== 'success') return;
      cache.persister.persistClient({ timestamp: Date.now(), buster, clientState: dehydrate(queryClient, cache.persistOptions.dehydrateOptions) });
    });
    return () => {
      live = false;
      stopSaving();
      stopNetwork();
      cache.flush().catch(() => {});
    };
  }, [services, storage]);

  return { ready };
}

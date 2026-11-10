import { createAnalytics } from './analytics.js';
import { createCache } from './cache.js';
import { createConsent } from './consent.js';
import { createGeo } from './geo.js';
import { createImages } from './images.js';
import { createMetrics } from './metrics.js';
import { createQueue } from './queue.js';
import { createSafeFetch, memoryHostGate, pgHostGate } from './safe-fetch.js';
import { createSecrets } from './secrets.js';
import { createStorage } from './storage.js';

/**
 * Builds every switchable module from config. This is the only place that picks drivers; the rest of
 * the code uses the interfaces. QA runs the simple drivers; production changes env settings only:
 *
 *   module     QA (default)           production
 *   storage    local  (STORAGE_DIR)   s3     (S3_*)
 *   queue      pg                     redis  (REDIS_URL)
 *   analytics  pg                     clickhouse (CLICKHOUSE_URL)
 *   cache      memory                 redis  (REDIS_URL)
 *
 * fetcher is safeFetch (PRD 8.2) with the host limit kept in Postgres; images is sharp. config.safeFetchTransport
 * ({ lookup, dial }, from tools/sim/sites) points the fetcher at the site simulator in tests and is refused in production.
 */
export function createPlatform(config, { db }) {
  const transport = config.safeFetchTransport ?? {};
  const gapMs = config.fetchHostGapMs ?? 1000;
  return {
    storage: createStorage(config),
    queue: createQueue(config, { db }),
    analytics: createAnalytics(config, { db }),
    cache: createCache(config),
    metrics: createMetrics(),
    secrets: createSecrets(config),
    consent: createConsent(),
    geo: createGeo(config),
    fetcher: createSafeFetch({ ...(transport.lookup ? { lookup: transport.lookup } : {}), dial: transport.dial ?? null, hostGate: db ? pgHostGate(db, { gapMs }) : memoryHostGate({ gapMs }) }),
    images: createImages(),
  };
}

/** Which driver each module uses, for the startup log and health checks. */
export const describePlatform = (p) =>
  Object.fromEntries(Object.entries(p).filter(([, m]) => m?.driver).map(([name, m]) => [name, m.driver]));

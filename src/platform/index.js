import { createAnalytics } from './analytics.js';
import { createCache } from './cache.js';
import { createMetrics } from './metrics.js';
import { createQueue } from './queue.js';
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
 */
export function createPlatform(config, { db }) {
  return {
    storage: createStorage(config),
    queue: createQueue(config, { db }),
    analytics: createAnalytics(config, { db }),
    cache: createCache(config),
    metrics: createMetrics(),
    secrets: createSecrets(config),
  };
}

/** Which driver each module uses, for the startup log and health checks. */
export const describePlatform = (p) =>
  Object.fromEntries(Object.entries(p).filter(([, m]) => m?.driver).map(([name, m]) => [name, m.driver]));

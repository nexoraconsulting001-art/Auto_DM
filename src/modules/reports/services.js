import { createApiKeys } from './api-keys.js';
import { createDownloads } from './downloads.js';
import { createPeriodic } from './periodic.js';
import { createPreferences } from './preferences.js';
import { createRuns } from './runs.js';
import { createScheduled } from './scheduled.js';
import { createSources } from './sources.js';

const built = new WeakMap();

/** One set of report services per app or worker context, made when first used: the module's api() is also called with an empty context. */
export function reportServices(ctx) {
  if (built.has(ctx)) return built.get(ctx);
  const sources = createSources(ctx);
  const preferences = createPreferences(ctx);
  const services = {
    sources,
    preferences,
    downloads: createDownloads(ctx, { sources }),
    periodic: createPeriodic(ctx, { preferences }),
    scheduled: createScheduled(ctx, { sources }),
    apiKeys: createApiKeys(ctx),
    runs: createRuns(ctx),
  };
  built.set(ctx, services);
  return services;
}

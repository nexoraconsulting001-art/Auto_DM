import { createCohorts } from './cohorts.js';
import { createContentFunnels, createFunnelSync } from './content-funnel.js';
import { createFunnelResults } from './custom-funnels.js';
import { createDestinations } from './destinations.js';
import { createExplore } from './explore.js';
import { createIngest } from './ingest.js';
import { createTrafficReads } from './reads.js';
import { createRollups } from './rollup.js';
import { createTags } from './tags.js';

const built = new WeakMap();

/** One set of services per app or worker context. */
export function servicesFor(ctx) {
  if (built.has(ctx)) return built.get(ctx);
  const tags = createTags(ctx);
  const rollupService = createRollups(ctx);
  const explore = createExplore(ctx, rollupService);
  const sync = createFunnelSync(ctx, tags, rollupService);
  const services = {
    tags,
    rollupService,
    explore,
    sync,
    ingest: createIngest(ctx, tags),
    reads: createTrafficReads(ctx, explore, rollupService),
    contentFunnels: createContentFunnels(ctx, sync),
    funnelResults: createFunnelResults(ctx, rollupService),
    cohorts: createCohorts(ctx, rollupService),
    destinations: createDestinations(ctx),
  };
  built.set(ctx, services);
  return services;
}

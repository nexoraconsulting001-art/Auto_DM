import { PROD_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { opsMetrics } from '../ops-metrics/index.js';

/**
 * One business's operating numbers for the Platform Console (Phase 9, G-14), and the metrics instruments the platform emits.
 *
 * The contract registers this module under the name `business-ops` and gives it the route platform.businessOps. The work is
 * in src/modules/ops-metrics (track: prod-observability); this file only hands the module over, so the list of modules
 * (src/modules/index.js) does not change. What is recorded and where it is read is described there.
 */
export const businessOps = {
  ...opsMetrics,
  name: 'business-ops',
  owns: { migrations: [], tables: [], api: [], store: [], platform: PROD_PLATFORM_OWNERS['business-ops'], jobs: [] },
};

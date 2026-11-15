import { PROD_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { platformNotBuilt } from '../not-built.js';

/**
 * One business's operating numbers for the Platform Console (Phase 9, G-14). Track: monitoring.
 *
 * Errors, calls to Meta and how much of its limits they used, and the depth and age of the business's queue, over a
 * window. They are analytics events (BUSINESS_OPS_EVENTS in src/contracts/metrics.js), written as the business inside
 * withTenant() where the thing happens:
 *
 *   ops.error        from reportError's reporter, when a business is current
 *   ops.meta_call    from onMetaCall (src/modules/meta-calls.js), which already hears every call with ids and numbers only
 *   ops.meta_usage   the usage percentages Meta sends back on a call
 *   ops.queue_depth  sampled by a job, per business, from the outbound queue
 *
 * and read back for one business at a time through the analytics module, so one business's numbers can never appear
 * under another: the fence and the analytics driver's own filter both hold it. None of this is a label at /metrics.
 *
 *   platform.businessOps   GET /tenants/:id/ops?hours=24   -> BusinessOps (numbers only)
 *
 * Nothing here is built yet: the route answers 501.
 */
const PLATFORM = PROD_PLATFORM_OWNERS['business-ops'];

export const businessOps = {
  name: 'business-ops',
  owns: { migrations: [], tables: [], api: [], store: [], platform: PLATFORM, jobs: [] },
  platformRoutes(router) {
    platformNotBuilt(router, ...PLATFORM);
  },
};

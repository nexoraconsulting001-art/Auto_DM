import { OPS_ROUTE_OWNERS } from '../../contracts/api/ops.js';
import { OPS_PLATFORM_OWNERS } from '../../contracts/api/platform-ops.js';
import { notBuilt, platformNotBuilt } from '../not-built.js';

const API = OPS_ROUTE_OWNERS.onboarding;
const PLATFORM = OPS_PLATFORM_OWNERS.onboarding;

/**
 * Done-for-you onboarding (PRD 5.6, F-26 to F-31, F-77 to F-80, F-108): the owner's single-use link, the checklist
 * filtered by tier, and the operator's workspace with its timings. A step is done when its live checks say so; the steps
 * and checks are data in src/contracts/onboarding.js, and this module supplies one function per check name. The Route
 * linked account's KYC and the pickup location go through ctx.providers (razorpay.route, shiprocket.managed).
 */
export const onboarding = {
  name: 'onboarding',
  owns: {
    migrations: ['730_platform_ops.sql'],
    tables: ['onboarding_invites', 'onboarding_steps', 'onboarding_timings'],
    api: API,
    store: [],
    platform: PLATFORM,
    jobs: ['onboarding.checks'],
  },
  api: () => notBuilt(...API),
  platformRoutes: (router) => platformNotBuilt(router, ...PLATFORM),
};

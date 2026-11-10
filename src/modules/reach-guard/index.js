import { notBuilt } from '../not-built.js';

/**
 * PRD 7.6 and 7.7: Reach Guard and Account Health. Slow mode is compliance's: this module calls compliance.slowMode and never sends anything itself.
 * Platform route platform.accountHealthList is answered in platformRoutes(router, ctx) when built.
 */
export const reachGuard = {
  name: 'reach-guard',
  api: () => notBuilt('reachGuard.status', 'reachGuard.setThresholds', 'reachGuard.trips', 'accountHealth.get', 'accountHealth.history'),
};

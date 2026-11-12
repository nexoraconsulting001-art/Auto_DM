import { OPS_PLATFORM_OWNERS } from '../../contracts/api/platform-ops.js';
import { platformNotBuilt } from '../not-built.js';

const PLATFORM = OPS_PLATFORM_OWNERS['tenant-health'];

/**
 * The tenant health console (PRD 5.9, F-39 to F-41): every business's checks in one place, worst first. The checks are
 * data in src/contracts/health.js (the Phase 2 Account Health deductions, domain and TLS, and own provider keys); this
 * module supplies one function per check, runs each inside withinTimeout (10 s, recorded as unreachable) at most every
 * 10 minutes per business, and keeps the last answer in tenant_health_checks. It sets no thresholds of its own.
 */
export const tenantHealth = {
  name: 'tenant-health',
  owns: {
    migrations: [],
    tables: ['tenant_health_checks'],
    api: [],
    store: [],
    platform: PLATFORM,
    jobs: ['tenant-health.checks'],
  },
  platformRoutes: (router) => platformNotBuilt(router, ...PLATFORM),
};

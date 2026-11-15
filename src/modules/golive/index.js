import { PROD_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { platformNotBuilt } from '../not-built.js';

/**
 * The go-live checklist (Phase 10; G-15 to G-17). Track: golive.
 *
 * Everything it reports comes from GOLIVE_ITEMS in src/contracts/golive.js: one item per outside approval, account and
 * setting. This module supplies how each kind is checked and nothing else decides readiness:
 *
 *   setting       present in the config (through SECRET_SETTINGS and the environment) and not a test value (isTestValue)
 *   probe         one function per name in GOLIVE_PROBES, each a read-only question through an existing adapter
 *                 (ctx.meta, ctx.providers, ctx.google, the push adapter, DNS and TLS lookups, the backup's age, /metrics);
 *                 each has a timeout and answers `unknown` when the service cannot be asked
 *   attestation   an entry in the sign-off file (config.goliveAttestations, GoliveAttestations), not older than the item allows
 *   per_business  a count from onboarding; never blocking
 *
 *   createGolive(ctx).status()          -> GoliveStatus. Never holds a setting's value: `detail` is a GOLIVE_DETAILS phrase or a setting's name.
 *   createGolive(ctx).signupVerdict()   -> SignupGuardVerdict: ok only when no blocking item is open
 *
 * - platform.goliveStatus (GET /golive on the platform host) answers status() for the Platform Console's screen
 *   (console/src/platform/features/golive).
 * - `npm run golive` (scripts/golive.js) prints the same list and exits non-zero while a blocking item is open (goliveExitCode).
 * - setup() registers signupVerdict with ctx.signupGuard, which the sign-up module asks before it opens to the public.
 *   The sign-up module is never edited for this: the guard, the force flag and the audit row are already there.
 * - A simulator address, a test-mode key or a Meta app in Development mode is never `ready` (G-16), and neither is a
 *   configuration that runs without DEPLOY_ENV=production.
 *
 * Nothing here is built yet: the route answers 501 and the verdict says so, which keeps public sign-up closed wherever
 * GOLIVE_ENFORCE is on.
 */
const PLATFORM = PROD_PLATFORM_OWNERS.golive;

const notBuilt = () => {
  throw Object.assign(new Error('The go-live checklist is not built yet'), { code: 'not_implemented' });
};

export function createGolive(_ctx) {
  return {
    status: async () => notBuilt(),
    signupVerdict: async () => ({ ok: false, missing: ['golive.not_built'] }),
  };
}

export const golive = {
  name: 'golive',
  owns: { migrations: ['910_signup_cap.sql'], tables: [], api: [], store: [], platform: PLATFORM, jobs: [] },
  setup(ctx) {
    const checklist = createGolive(ctx);
    ctx.signupGuard?.use(() => checklist.signupVerdict());
  },
  platformRoutes(router) {
    platformNotBuilt(router, ...PLATFORM);
  },
};

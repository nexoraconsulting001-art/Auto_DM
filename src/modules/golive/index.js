import { requirePlatformRole } from '../../auth.js';
import { GoliveStatus } from '../../contracts/golive.js';
import { platformRoutes as PLATFORM_ROUTES, PROD_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { reportError } from '../../platform/log.js';
import { createGolive } from './checklist.js';

export { createGolive, readAttestations, settingProblem, settingReader, DETAIL, GOLIVE_EXTRA_DETAILS } from './checklist.js';
export { NEXT_STEPS, OWNER_LABELS, PHASE_LABELS, STATE_LABELS, nextStepFor } from './next-steps.js';

/**
 * The go-live checklist (Phase 10; G-15 to G-17). Track: golive.
 *
 * Everything it reports comes from GOLIVE_ITEMS in src/contracts/golive.js: one item per outside approval, account and
 * setting. checklist.js supplies how each kind is checked and nothing else decides readiness:
 *
 *   setting       present in the running config (secrets from their source included) and not a test value
 *   probe         probes.js: one read-only question per name through the existing adapters, each with a timeout; asked
 *                 only when a live check is asked for (the command without --offline, the console's "Check live",
 *                 and the sign-up switch before it opens to the public). Not asked, failed or timed out is "not checked"
 *   attestation   a valid entry in deploy/golive/attestations.json (GOLIVE_ATTESTATIONS names another file)
 *   per_business  a count from onboarding; never blocking
 *
 * - platform.goliveStatus (GET /golive on the platform host, super admin and support) answers status(); `?live=1` runs
 *   the probes. The Platform Console's screen is console/src/platform/features/golive.
 * - `npm run golive` (scripts/golive.js, tools/golive) prints the same list and exits non-zero while a blocking item is open.
 * - setup() registers signupVerdict with ctx.signupGuard, which the sign-up module asks before it opens to the public;
 *   with GOLIVE_ENFORCE on, public is refused while a blocking item is open (a Meta app on Standard Access included,
 *   since meta.instagram_access blocks), unless a super admin forces it with a second reason, audited as forced.
 * - The daily cap on new businesses holds under parallel sign-ups in the database (migration 911).
 */
const PLATFORM = PROD_PLATFORM_OWNERS.golive;
const ROUTE = PLATFORM_ROUTES['platform.goliveStatus'];

export const golive = {
  name: 'golive',
  owns: { migrations: ['910_signup_cap.sql'], tables: [], api: [], store: [], platform: PLATFORM, jobs: [] },
  setup(ctx) {
    const checklist = createGolive(ctx);
    ctx.golive = checklist;
    ctx.signupGuard?.use(() => checklist.signupVerdict());
  },
  platformRoutes(router, ctx) {
    const checklist = ctx.golive ?? createGolive(ctx);
    // Mounted by hand rather than through mountPlatform so the screen can ask for the live checks (?live=1): the route
    // table has no query for it. The answer is still parsed through GoliveStatus, so nothing else leaves.
    router.get(ROUTE.path, requirePlatformRole(...ROUTE.platformRoles), async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const status = await checklist.status({ live: req.query?.live === '1' });
        res.json(GoliveStatus.parse(status));
      } catch (err) {
        reportError(err, { msg: 'platform.route_failed', route: 'platform.goliveStatus' });
        res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'internal' });
      }
    });
  },
};

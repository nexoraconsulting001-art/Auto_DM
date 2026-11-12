import { BILLING_ROUTE_OWNERS } from '../../contracts/api/billing.js';
import { BILLING_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { notBuilt, platformNotBuilt } from '../not-built.js';

/**
 * Self-serve sign-up and the free plan (PRD 5.20). Track signup. Contract only so far: every route answers 501.
 *
 * Owns signup_settings, signup_invites, signup_runs and signup_steps (700): platform tables, reached through db.platform,
 * because a run starts before there is a business. What the track builds here:
 *
 * - The four PUBLIC routes on PLATFORM_APP_HOST, answered with no business. The person has signed in there with Google or a
 *   WhatsApp code (the accounts module: no password, no card); each handler finds that session itself and answers 401
 *   without one.
 * - signup.status: the mode (closed, invite or public: a row, set in the Platform Console, 'invite' until Advanced Access),
 *   whether this person may start, and the run's steps so far. signup.start: checks the mode and the invite (hash only, uses
 *   counted in the database), makes the business on the Free plan with the chosen account type, the owner's account and
 *   membership, and its referral row when a code came with it. One Free business per Instagram account
 *   (signup_settings.free_per_instagram) is checked when Instagram is connected.
 * - signup.firstAutomation: a reel, a keyword and a link, through the automations module's own rules, so the link passes 4.11
 *   and the template 4.10 before it goes live, and Free gets the two-tap flow only. signup.finish closes the run.
 * - Every step's time in signup_steps, once per run (F-121): SIGNUP_STEPS, SIGNUP_TARGET_MS.
 * - Everything a person sees here is Bhava-branded: sign-up is a seller surface.
 */
const API = BILLING_ROUTE_OWNERS.signup;
const PLATFORM = BILLING_PLATFORM_OWNERS.signup;

export const signup = {
  name: 'signup',
  owns: { migrations: [], tables: ['signup_settings', 'signup_invites', 'signup_runs', 'signup_steps'], api: API, store: [], platform: PLATFORM, jobs: [] },
  api: () => notBuilt(...API),
  platformRoutes(router) {
    platformNotBuilt(router, ...PLATFORM);
  },
};

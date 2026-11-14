import { BILLING_ROUTE_OWNERS } from '../../contracts/api/billing.js';
import { BILLING_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { signupApi } from './api.js';
import { signupConsoleRoutes } from './console.js';

export { SIGNUP_LIMITS, businessHost, inviteHash, newInviteCode, slugCandidates } from './rules.js';

/**
 * Self-serve sign-up and the free plan (PRD 5.20). Track signup-plans.
 *
 * Owns signup_settings, signup_invites, signup_runs and signup_steps (700): platform tables, reached through db.platform,
 * because a run starts before there is a business; and instagram_tenants with the Free-claim trigger (741).
 *
 * - The four PUBLIC routes on PLATFORM_APP_HOST (api.js), answered with no business. The person has signed in there with
 *   Google or a WhatsApp code (the accounts module: no password, no card); each handler finds that person from the
 *   session and answers 401 without one.
 * - signup.status: the mode, whether this person may start, and the run's steps so far; it opens a run (rate limited per
 *   address) and keeps a referral code that came with the page. signup.start: the mode on the server (closed refuses;
 *   invite takes one use of a code in the same transaction that makes the business, so a single-use code works once);
 *   rate limited per person and per address; makes the business on Free with an address that is not reserved, its
 *   owner and membership, and its referral row (the referrals module). The empty Free business a first sign-in made
 *   (F-109) becomes this business rather than leaving the person with two.
 * - One Free plan per Instagram account (signup_settings.free_per_instagram) is held by the database when the account is
 *   connected (migration 741), under a lock on that account, so two sign-ups at once cannot both take it.
 * - signup.firstAutomation: a reel, a keyword and a link, through the automations module's own handlers, so the template
 *   passes 4.10 and the link 4.11 before it goes live, Free gets the two-tap flow only, and the plan's limit applies.
 *   signup.finish closes the run.
 * - Every step's time in signup_steps, once per run (F-121), logged with ids and milliseconds only.
 * - The Platform Console's mode and invites (console.js).
 * - Everything a person sees here is Bhava-branded: sign-up is a seller surface.
 */
const API = BILLING_ROUTE_OWNERS.signup;
const PLATFORM = BILLING_PLATFORM_OWNERS.signup;

export const signup = {
  name: 'signup',
  owns: { migrations: ['741_signup_referrals.sql'], tables: ['signup_settings', 'signup_invites', 'signup_runs', 'signup_steps', 'instagram_tenants'], api: API, store: [], platform: PLATFORM, jobs: [] },
  api: (ctx) => signupApi(ctx),
  platformRoutes(router, ctx) {
    signupConsoleRoutes(router, ctx);
  },
};

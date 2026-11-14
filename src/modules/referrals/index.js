import { BILLING_ROUTE_OWNERS } from '../../contracts/api/billing.js';
import { REFERRAL_STATES, referralLink } from '../../contracts/billing.js';
import { platformSiteUrlOf } from '../../config.js';
import { tenantId } from '../../tenancy.js';
import { referralCodesRepo } from './repo.js';
import { referralLinkHook } from './service.js';

export { notePaymentMethod, normalizeReferralCode, platformLinkIn, recordReferral, referralLinkHook } from './service.js';

/**
 * Referrals between sellers (PRD 5.20). Track signup-plans. Not the shoppers' referral rewards of 9.21, which are the
 * loyalty module's.
 *
 * Owns seller_referral_codes and seller_referrals (701), and seller_payment_marks with the triggers of migration 741.
 *
 * - Each account's code, made on first read (repos.referralCodes.code(), repo.js), and its link to the sign-up page
 *   (referralLink in the billing contract): answered by referrals.get for the console and the owner app, and behind the
 *   Free plan's badge on the creator page (the creator module).
 * - The referral row when a referred account signs up: recordReferral(t, ...) (service.js), called by the signup module
 *   inside its transaction, through db.platform. tenant_id is the referrer, referred_tenant_id unique: referred once.
 * - Self-referrals blocked: the same person or phone at sign-up (service.js), the same Instagram account when either
 *   business connects it, and the same payment method when billing records one (notePaymentMethod): both in the database.
 * - The credit, once, when the referred account starts a paid plan: the plan_changes trigger of migration 741 credits only
 *   a pending row, with billing_settings.referral_reward_paise, so a repeated paid event finds nothing to do.
 * - A referral link is never put inside a DM (4.10): beforeAutomationLaunch refuses an automation whose link or messages
 *   carry one, or any link to the platform's own pages.
 * - referrals.get answers counts and states only: nothing of a referred business is shown to the referrer.
 */
const API = BILLING_ROUTE_OWNERS.referrals;

export const referrals = {
  name: 'referrals',
  owns: { migrations: ['741_signup_referrals.sql'], tables: ['seller_referral_codes', 'seller_referrals', 'seller_payment_marks'], api: API, store: [], platform: [], jobs: [] },
  repos: (db) => ({ referralCodes: referralCodesRepo(db) }),
  api: (ctx) => ({
    async 'referrals.get'() {
      const { repos, db, config } = ctx;
      const code = await repos.referralCodes.code();
      const [settings] = await db.query('SELECT referral_reward_paise FROM billing_settings LIMIT 1');
      const rows = await db.query(
        `SELECT state, count(*)::int AS n, COALESCE(sum(reward_paise) FILTER (WHERE state = 'credited'), 0)::bigint AS credited
         FROM seller_referrals WHERE tenant_id = $1 GROUP BY state`,
        [tenantId()],
      );
      const counts = Object.fromEntries(REFERRAL_STATES.map((state) => [state, 0]));
      let creditedPaise = 0;
      for (const row of rows) {
        counts[row.state] = row.n;
        creditedPaise += Number(row.credited);
      }
      return { code, link: referralLink(platformSiteUrlOf(config), code), rewardPaise: Number(settings?.referral_reward_paise ?? 0), counts, creditedPaise };
    },
  }),
  beforeAutomationLaunch: referralLinkHook,
};

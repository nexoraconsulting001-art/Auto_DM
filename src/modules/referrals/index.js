import { BILLING_ROUTE_OWNERS } from '../../contracts/api/billing.js';
import { notBuilt } from '../not-built.js';
import { referralCodesRepo } from './repo.js';

/**
 * Referrals between sellers (PRD 5.20). Track referrals. Contract only so far. Not the shoppers' referral rewards of 9.21,
 * which are the loyalty module's.
 *
 * Owns seller_referral_codes and seller_referrals (701). What the track builds here:
 *
 * - Each account's code, made on first read (built: repos.referralCodes.code(), repo.js), and its link to the sign-up page
 *   (referralLink in the billing contract), shown in the console and behind the Free plan's badge on the creator page. A
 *   referral link is never put inside a DM (4.10).
 * - The referral row when a referred account signs up: written through db.platform, tenant_id the referrer, unique on the
 *   referred business, so an account is referred once.
 * - The credit, once, when the referred account starts a paid plan (credited_at; billing_settings.referral_reward_paise).
 * - Self-referrals blocked: the same Instagram account, phone or payment method (REFERRAL_BLOCKS).
 * - referrals.get answers counts and states only: nothing of the referred business is shown to the referrer.
 */
const API = BILLING_ROUTE_OWNERS.referrals;

export const referrals = {
  name: 'referrals',
  owns: { migrations: [], tables: ['seller_referral_codes', 'seller_referrals'], api: API, store: [], platform: [], jobs: [] },
  repos: (db) => ({ referralCodes: referralCodesRepo(db) }),
  api: () => notBuilt(...API),
};

import { notBuilt } from '../not-built.js';

/**
 * PRD 9.21. Not built yet: this folder is the loyalty track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): loyalty_settings, loyalty_accounts, loyalty_ledger, referral_codes, referrals.
 * Buyer routes (src/contracts/store-routes.js): GET /account/points, GET /refer/:code.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): order.paid earns pending points;
 * order.return_window_closed posts them; refund.processed reverses; order.cancelled restores what was spent.
 * loyalty_ledger.entry_key makes each happen once.
 * Gated by the `loyalty` feature: without it every route answers 403 (S-91). Checkout calls redeem(t, ...) inside the
 * order’s transaction; loyalty_accounts.balance >= 0 is a database check.
 */
export const loyalty = {
  name: 'loyalty',
  api: () => notBuilt(
    'loyaltySettings.get',
    'loyaltySettings.update',
    'loyalty.members',
    'loyalty.ledger',
    'loyalty.adjust',
    'loyalty.referrals',
  ),
};

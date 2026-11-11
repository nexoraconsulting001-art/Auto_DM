import { notBuilt } from '../not-built.js';
import { legacyAccountRoutes } from './legacy.js';

/**
 * PRD 9.3, 9.4, 9.17 (the account) and 9.22. This folder is the shoppers track's. Until it is built, the Phase 0 login,
 * signup and "My account" pages answer (legacy.js, moved from src/routes/account.js).
 *
 * Tables (already migrated): shoppers, shopper_sessions, shopper_otps, shopper_addresses (400), and for shared sign-in the
 * platform's own shared_profiles, shared_addresses, shared_profile_links, shared_cod_signals, shared_consent_notices and
 * shared_consent_log (415), which business code cannot read: reach them through db.platform, from one service here, and
 * hand a business only what its own checkout needs.
 * Buyer routes (src/contracts/store-routes.js): /login, the OTP and Google calls, /logout, /account and its pages, the
 * address calls, and the shared-profile consent screen, the one buyer page that may name the platform (S-101).
 *
 * A code is sent through ctx.shopperMessages as purpose 'authentication' (never the adapter), stored as a hash, and limited
 * by STORE_LIMITS.otp with platform.rateLimit. The shopper's cookie is SHOPPER_COOKIE, apart from the seller's session.
 * POST /login also signs sellers in today: keep that working when the pages here are replaced.
 */
export const shoppers = {
  name: 'shoppers',
  api: () => notBuilt(
    'shoppers.list',
    'shoppers.get',
    'shopperDownloads.list',
    'shopperDownloads.create',
    'shopperDownloads.get',
  ),
  routes(app, ctx) {
    app.use('/', legacyAccountRoutes(ctx));
  },
};

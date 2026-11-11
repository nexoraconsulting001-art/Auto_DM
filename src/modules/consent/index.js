import { notBuilt } from '../not-built.js';

/**
 * PRD 9.18. Not built yet: this folder is the consent track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): consent_notices, consent_records, policy_pages, privacy_settings, data_requests.
 * Buyer routes (src/contracts/store-routes.js): GET /policies/:kind, GET /api/store/consent, POST /api/store/consent,
 * GET /unsubscribe/:token, POST /api/store/data-requests.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): none.
 * Registers the provider behind platform.consent in setup(ctx): ctx.platform.consent.use({ allows, record, revoke,
 * status, notice }). Erasure masks orders and invoices (erased_at, buyer_masked_at) and removes the rest, return
 * proofs included.
 */
export const consent = {
  name: 'consent',
  api: () => notBuilt(
    'privacy.get',
    'privacy.update',
    'policies.all',
    'policies.save',
    'consentNotice.get',
    'consentNotice.publish',
    'dataRequests.list',
    'dataRequests.create',
    'dataRequests.get',
  ),
};

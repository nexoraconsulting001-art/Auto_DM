import { tenantId } from '../tenancy.js';

/**
 * Whether a shopper has said yes to "Analytics and ads" (PRD 7.14). Tags, pixels and server events ask this and nothing else. Shopper consent
 * is built in Phase 4 (PRD 9.18); until then there is nothing a shopper could have answered, so every answer is no and no tag loads.
 * Phase 4 replaces this file's export and keeps the call.
 *
 *   analyticsAndAds({ visitorId?, shopperId? }) -> { granted, answered, reason }
 *
 * Bhava's own 7.10 counts never depend on this. Business data, so it refuses to run without a current business.
 */
export const CONSENT_NOT_ASKED = Object.freeze({ granted: false, answered: false, reason: 'consent.not_built' });

export function createConsent() {
  return {
    built: false,
    async analyticsAndAds() {
      tenantId();
      return CONSENT_NOT_ASKED;
    },
  };
}

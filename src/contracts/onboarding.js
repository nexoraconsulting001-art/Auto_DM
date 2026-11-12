/**
 * Done-for-you onboarding (PRD 5.6): the invite, the checklist and where each step's state comes from, as data. No imports.
 *
 * A step is never ticked by hand. Its state is what its live check found the last time it ran (onboarding_steps.status,
 * checked_at, detail), and the check is named here so the onboarding module, the Platform Console and the seller's screens
 * agree on what "done" means. The module supplies one function per check name; a check it has no function for fails the
 * contract test.
 */

/** The owner's link works once and for this long; only its hash is stored; sending again revokes the one before. */
export const INVITE_DAYS = 7;
export const INVITE_EXPIRED_MESSAGE = 'Ask your onboarding contact for a new link.';

/** pending: not checked or not started. waiting: the owner has done their part and somebody else (Razorpay, DNS) has not answered yet. */
export const STEP_STATUSES = Object.freeze(['pending', 'waiting', 'done', 'failed']);

/**
 * What a live check looks at. Each takes the current business and answers { status, code?, reason?, fix? }:
 * `code` is a stable reason such as gate.scope_missing, `reason` is the provider's own words when it gave any, and `fix` is
 * the action the screen offers (reconnect, kyc, pickup, keys, dns, terms).
 */
export const STEP_CHECKS = Object.freeze({
  /** The Instagram token is live and its granted scopes, read from the token itself, include what a step needs. */
  token_scopes: Object.freeze({ timeoutMs: 10_000, reads: 'meta', needs: Object.freeze(['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments']) }),
  /** Meta lists Bhava's app under the account's subscribed_apps. */
  subscribed_apps: Object.freeze({ timeoutMs: 10_000, reads: 'meta' }),
  /** The Route linked account's KYC status at Razorpay (KYC_STATES below). */
  route_kyc: Object.freeze({ timeoutMs: 10_000, reads: 'razorpay' }),
  /** The business's pickup location exists on Bhava's master Shiprocket account. */
  pickup_location: Object.freeze({ timeoutMs: 10_000, reads: 'shiprocket' }),
  /** A test call with the seller's own keys succeeds. Run before the keys are saved: keys that fail are never stored. */
  provider_test_call: Object.freeze({ timeoutMs: 10_000, reads: 'provider' }),
  /** The domain's DNS points at Bhava and its certificate is issued. */
  dns: Object.freeze({ timeoutMs: 10_000, reads: 'dns' }),
  /** The owner accepted the current terms (who and when is on record). */
  terms_accepted: Object.freeze({ timeoutMs: 2_000, reads: 'database' }),
});

/** A step missing the insights scope is still done, with this warning: the business can go live in slow mode (F-30). */
export const OPTIONAL_SCOPES = Object.freeze(['instagram_business_manage_insights']);

const PLAN_ORDER = Object.freeze(['free', 't1', 't2', 't3', 't4', 't5']);
const from = (plan) => PLAN_ORDER.slice(PLAN_ORDER.indexOf(plan));

/**
 * The checklist, in order. `checks` all have to pass for the step to be done. `requiredOn` lists the plans on which the
 * step blocks finishing; `optionalOn` the plans that are shown it without being held up by it; a plan in neither does not
 * see the step. `owner` is true for a step only the owner can do, which is what the invite walks them through.
 */
export const ONBOARDING_STEPS = Object.freeze([
  Object.freeze({ step: 'instagram', label: 'Connect Instagram', checks: Object.freeze(['token_scopes', 'subscribed_apps']), owner: true, requiredOn: PLAN_ORDER, optionalOn: Object.freeze([]) }),
  Object.freeze({ step: 'terms', label: 'Accept the terms', checks: Object.freeze(['terms_accepted']), owner: true, requiredOn: PLAN_ORDER, optionalOn: Object.freeze([]) }),
  Object.freeze({ step: 'domain', label: 'Connect your domain', checks: Object.freeze(['dns']), owner: true, requiredOn: Object.freeze(from('t2')), optionalOn: Object.freeze(['free', 't1']) }),
  Object.freeze({ step: 'payments', label: 'Set up payments', checks: Object.freeze(['route_kyc']), owner: true, requiredOn: Object.freeze(from('t3')), optionalOn: Object.freeze([]) }),
  Object.freeze({ step: 'shipping', label: 'Add your pickup address', checks: Object.freeze(['pickup_location']), owner: true, requiredOn: Object.freeze(from('t3')), optionalOn: Object.freeze([]) }),
  Object.freeze({ step: 'own_keys', label: 'Bring your own payment or courier account', checks: Object.freeze(['provider_test_call']), owner: true, requiredOn: Object.freeze([]), optionalOn: Object.freeze(from('t3')) }),
]);
export const STEP_NAMES = Object.freeze(ONBOARDING_STEPS.map((s) => s.step));

/** The steps a business on `plan` sees, each with `required`. A plan the list does not know gets the free plan's steps. */
export function stepsFor(plan) {
  const known = PLAN_ORDER.includes(plan) ? plan : 'free';
  return ONBOARDING_STEPS
    .filter((s) => s.requiredOn.includes(known) || s.optionalOn.includes(known))
    .map((s) => ({ step: s.step, label: s.label, checks: s.checks, required: s.requiredOn.includes(known) }));
}

/** Done when every required step is done. Optional steps never hold a business back. */
export const onboardingDone = (plan, statuses) => stepsFor(plan).every((s) => !s.required || statuses?.[s.step] === 'done');

/**
 * A Route linked account's KYC at Razorpay, as the adapter reports it (PRD 5.6; the names are to confirm against the live API).
 * Checkout opens only on `activated`. `needs_clarification` and `rejected` carry Razorpay's own reason and a fix button.
 */
export const KYC_STATES = Object.freeze(['created', 'under_review', 'needs_clarification', 'activated', 'rejected', 'suspended']);
export const KYC_STEP_STATUS = Object.freeze({ created: 'pending', under_review: 'waiting', needs_clarification: 'failed', activated: 'done', rejected: 'failed', suspended: 'failed' });
export const checkoutOpenFor = (kycState) => kycState === 'activated';

/** Whose keys an owner may bring (9.6, 9.10). Saved encrypted, shown masked, and only after the test call passes. */
export const OWN_KEY_PROVIDERS = Object.freeze(['razorpay', 'cashfree', 'shiprocket']);

/** The operator's active time from the console form to the invite being sent (F-31). Waits are not counted. */
export const OPERATOR_TARGET_MS = 10 * 60_000;
/** A gap longer than this between two things an operator did is a wait, not work, and is left out of the step's time. */
export const ACTIVE_GAP_MS = 2 * 60_000;
export const OPERATOR_STEPS = Object.freeze(['form', 'brand_read', 'import', 'review', 'invite']);

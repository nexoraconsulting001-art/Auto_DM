/**
 * What a failed call means to the person, with no React, so node's test runner reads it too. A 403 is one of two
 * different things: the person's role or permissions (ask the owner), or this business's plan (src/contracts/api/errors.js:
 * `plan.feature_off`, `plan.limit_reached`, and the older refusals that say so only in `reason`). Every screen that
 * turns a refusal into words goes through `errorKey`, so a plan refusal is never answered with "Ask the owner".
 */

/** The `reason` a plan refusal carries beside its code (src/contracts/api/plan.js planRefusalReason). */
export const PLAN_REASONS = Object.freeze(['plan', 'plan.not_included']);

/** 'limit' when the plan's limit is used up, 'feature' when the plan lacks the feature, null for any other answer. */
export function planRefusal(error) {
  if (error?.status !== 403) return null;
  if (error.code === 'plan.limit_reached') return 'limit';
  if (error.code === 'plan.feature_off' || PLAN_REASONS.includes(error.reason)) return 'feature';
  return null;
}

/**
 * What a failed call means to the person, as a string key: no connection, not on the plan, no access, gone, or
 * anything else. The error's own message is never shown: it may carry what the server said about someone else's record.
 */
export function errorKey(error) {
  if (error?.status === 0 || error?.code === 'network' || error?.code === 'offline') return 'error.network';
  if (error?.status === 403) {
    const plan = planRefusal(error);
    if (plan === 'limit') return 'error.planLimit';
    if (plan === 'feature') return 'error.planFeature';
    return 'error.forbidden';
  }
  if (error?.status === 404) return 'error.notFound';
  return 'error.body';
}

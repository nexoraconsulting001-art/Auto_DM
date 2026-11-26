/**
 * The one error format of /api/v1. Every failure, from any layer, is JSON of this shape:
 *
 *   { "error": "A sentence to show a person", "code": "not_found", "fields": { "name": "Name is required" }, "requestId": "..." }
 *
 * `fields` appears only on validation failures and `requestId` whenever the request has one. `reason` appears when
 * a compliance rule refused the request, and is its reason code (src/contracts/compliance.js). `storeUrl` appears with
 * `update_required`: where to get the newer app.
 *
 * Two codes are the plan's (PRD 5.7), both 403, and both come from the router before the handler runs:
 *   `plan.feature_off`     this business's plan does not have the route's feature. `feature` names it and `plan` is the
 *                          lowest plan that includes it (absent when only an add-on or an override can turn it on).
 *   `plan.limit_reached`   the plan has the feature and its limit is used up. `feature`, `limit` and `used` say where it
 *                          stands, and `plan` is the lowest plan with more.
 * A feature or a limit the plan does not include is always one of these two (403), never a 404 (user decision 2026-11-26,
 * F-32/F-34/F-35): the message is PLAN_REFUSAL_MESSAGE (a limit names its number too) and `upgradeUrl` is
 * PLAN_UPGRADE_PATH, the console's own plans page, where the upgrade prompt (upsell) also links.
 * Five are for Bhava's own team inside a business (PRD 5.10, 5.17), all from the router before the handler runs:
 *   `impersonation.blocked`, `impersonation.read_only`   see IMPERSONATION_BLOCKED and operatorRefusal in access.js
 *   `service.out_of_scope`, `service.ended`              the route is not the operator's service's, or the service lapsed
 *   `service.cannot_undo` (409)                          a change with no before or after, or one already undone
 * A session of theirs that has ended is simply `unauthorized`, as any ended session is.
 *
 * Both also carry `reason` (`plan`, or `plan.not_included` on the Phase 3 routes), as the handlers' own refusals did.
 *
 * Two codes ask the client to do something and then repeat the request: `reauth_required` (403: prove it is you again with
 * auth.reauthStart and auth.reauthVerify) and `update_required` (426: the app is older than the minimum; open `storeUrl`).
 * Programs branch on `code`; people read `error`.
 */
export const ERROR_STATUS = Object.freeze({
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  reauth_required: 403,
  'plan.feature_off': 403,
  'plan.limit_reached': 403,
  'impersonation.blocked': 403,
  'impersonation.read_only': 403,
  'service.out_of_scope': 403,
  'service.ended': 403,
  'service.cannot_undo': 409,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  upgrade_required: 426,
  update_required: 426,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
});
export const ERROR_CODES = Object.freeze(Object.keys(ERROR_STATUS));

const DEFAULT_MESSAGE = {
  validation_failed: 'Please check the details and try again.',
  unauthorized: 'Please log in again.',
  forbidden: 'You don’t have access to this.',
  reauth_required: 'Confirm it’s you to continue.',
  'plan.feature_off': 'Not included in your current plan - upgrade',
  'plan.limit_reached': 'Not included in your current plan - upgrade',
  'impersonation.blocked': 'Support can’t do this for an owner.',
  'impersonation.read_only': 'This session is read-only.',
  'service.out_of_scope': 'This isn’t part of the service you are working on.',
  'service.ended': 'This service isn’t active for the business any more.',
  'service.cannot_undo': 'This change can’t be undone from here.',
  not_found: 'We couldn’t find that.',
  conflict: 'That can’t be done right now.',
  payload_too_large: 'That is too large to upload.',
  unsupported_media_type: 'That file type isn’t supported.',
  upgrade_required: 'Please update the app to continue.',
  update_required: 'Update required. Get the latest version to continue.',
  rate_limited: 'Too many tries. Wait a little and try again.',
  internal: 'Something went wrong on our side. Please try again.',
  not_implemented: 'This isn’t available yet.',
};

/** The words of every plan refusal (user decision 2026-11-26), and where it sends the owner: the console's plans page. */
export const PLAN_REFUSAL_MESSAGE = 'Not included in your current plan - upgrade';
export const PLAN_UPGRADE_PATH = '/admin/billing';
/** The message of a plan.feature_off answer: the decided words, naming the lowest plan that has it when there is one. */
export const planOffMessage = (planName) => (planName ? `${PLAN_REFUSAL_MESSAGE} to the ${planName} plan` : PLAN_REFUSAL_MESSAGE);
/** The message of a plan.limit_reached answer: the decided words, with the number the plan includes and the plan with more. */
export const planLimitMessage = (limit, planName) => `${planOffMessage(planName)}${Number.isInteger(limit) ? ` (your plan includes ${limit})` : ''}`;
const PLAN_CODES = Object.freeze(['plan.feature_off', 'plan.limit_reached']);
/**
 * The one refusal of a feature the plan does not include, for a handler that checks it itself (PLAN_IN_HANDLER): 403
 * plan.feature_off with the decided words and the upgrade path. `reason` is what the screens already look for ('plan', or
 * 'plan.not_included' on the Phase 3 routes); `plan` is the lowest plan that has it, when known.
 */
export const planOff = (feature, { reason = 'plan', plan, upgradeUrl } = {}) => new ApiError('plan.feature_off', PLAN_REFUSAL_MESSAGE, { reason, feature, plan, upgradeUrl });

/** Throw from a route handler to answer with this error. `fields` maps field names to messages. */
export class ApiError extends Error {
  constructor(code, message = DEFAULT_MESSAGE[code], { fields, reason, storeUrl, feature, plan, limit, used, upgradeUrl } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.fields = fields;
    this.reason = reason;
    this.storeUrl = storeUrl;
    this.feature = feature;
    this.plan = plan;
    this.limit = limit;
    this.used = used;
    // Every plan refusal carries the way to upgrade; `null` leaves it out (an answer a buyer reads, on the store).
    this.upgradeUrl = upgradeUrl === null ? undefined : upgradeUrl ?? (PLAN_CODES.includes(code) ? PLAN_UPGRADE_PATH : undefined);
  }
}

/** True for any URL under /api/v1. */
export const isApiV1Url = (url) => /^\/api\/v1(?:[/?]|$)/.test(url);

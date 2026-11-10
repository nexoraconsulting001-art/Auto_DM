/**
 * The one error format of /api/v1. Every failure, from any layer, is JSON of this shape:
 *
 *   { "error": "A sentence to show a person", "code": "not_found", "fields": { "name": "Name is required" }, "requestId": "..." }
 *
 * `fields` appears only on validation failures and `requestId` whenever the request has one.
 * Programs branch on `code`; people read `error`.
 */
export const ERROR_STATUS = Object.freeze({
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  upgrade_required: 426,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
});
export const ERROR_CODES = Object.freeze(Object.keys(ERROR_STATUS));

const DEFAULT_MESSAGE = {
  validation_failed: 'Please check the details and try again.',
  unauthorized: 'Please log in again.',
  forbidden: 'You don’t have access to this.',
  not_found: 'We couldn’t find that.',
  conflict: 'That can’t be done right now.',
  payload_too_large: 'That is too large to upload.',
  unsupported_media_type: 'That file type isn’t supported.',
  upgrade_required: 'Please update the app to continue.',
  rate_limited: 'Too many tries. Wait a little and try again.',
  internal: 'Something went wrong on our side. Please try again.',
  not_implemented: 'This isn’t available yet.',
};

/** Throw from a route handler to answer with this error. `fields` maps field names to messages. */
export class ApiError extends Error {
  constructor(code, message = DEFAULT_MESSAGE[code], { fields } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.fields = fields;
  }
}

/** True for any URL under /api/v1. */
export const isApiV1Url = (url) => /^\/api\/v1(?:[/?]|$)/.test(url);

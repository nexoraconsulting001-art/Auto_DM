/**
 * What can go wrong talking to Meta, in the terms the compliance engine decides on. Error codes marked "to confirm" in
 * PRD 4.3 and 4.4 live only here, so a live check that corrects one changes one line.
 */

/** The address asked for is not one of Meta's: refused before anything is sent (api.host_blocked). */
export class MetaHostBlockedError extends Error {
  constructor(name) {
    super(`${name} is not an allowed Meta address`);
    this.name = 'MetaHostBlockedError';
    this.reason = 'api.host_blocked';
  }
}

const THROTTLE_CODES = new Set([4, 17, 32, 613]);
const PERMISSION_CODES = new Set([3, 10, 200, 230]);

/** What an HTTP status and Graph error code mean. The two message checks are the wording of insights errors PRD 7.3 and 4.3 row 20 rely on (to confirm). */
export function classifyGraphError({ status, code, subcode, message = '' }) {
  if (status >= 500) return 'server_error';
  if (code === 10 && /not enough viewers/i.test(message)) return 'not_enough_viewers';
  if (code === 100 && /no longer available/i.test(message)) return 'insights_expired';
  if (code === 190) return 'token_invalid';
  if (code === 80002) return 'buc_throttled';
  if (THROTTLE_CODES.has(code) || status === 429) return 'throttled';
  if (code === 10900) return 'already_replied';
  if (code === 10901) return 'reply_window_closed';
  if (code === 10903) return 'cannot_reply';
  if (code === 10 && subcode === 2534022) return 'window_closed';
  if (code === 551) return 'recipient_unavailable';
  if (code === 100 && subcode === 33) return 'not_found';
  if (code === 100) return 'validation';
  if (PERMISSION_CODES.has(code)) return 'permission';
  return 'rejected';
}

/**
 * A call to Meta that did not succeed.
 *   kind       a classifyGraphError() value, or timeout, network, malformed, oauth
 *   delivery   'none' when Meta's answer proves nothing was delivered; 'unknown' when it may have been: never resend those
 *   status, code, subcode, usage   recorded for the job (PRD 4.3)
 * Holds no token, query string or message text, so it is safe to log.
 */
export class MetaApiError extends Error {
  constructor({ method, pathname, status = 0, code, subcode, detail, kind, delivery, usage = null, fbtraceId }) {
    super(`Instagram API ${method} /${pathname} failed (${status}): ${detail || 'no details'}`);
    this.name = 'MetaApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.kind = kind;
    this.delivery = delivery;
    this.usage = usage;
    this.fbtraceId = fbtraceId;
  }

  /** True only when Meta refused the content itself, the one case a plain-text fallback is allowed (PRD 4.4). */
  get canFallback() {
    return this.kind === 'validation';
  }
}

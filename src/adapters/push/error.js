import { ProviderError } from '../http.js';

/** What a push provider's refusal is thrown as. See index.js for the kinds. */
const RETRYABLE = ['throttled', 'unavailable', 'timeout'];

export class PushError extends ProviderError {
  constructor({ provider, kind, status = 0, code = '', retryAfter = null }) {
    // A push that may have gone out is harmless to repeat: the collapse key makes the second replace the first.
    super({ provider, kind, status, code, delivery: ['unregistered', 'invalid_token', 'throttled'].includes(kind) ? 'none' : 'unknown' });
    this.name = 'PushError';
    this.retryable = RETRYABLE.includes(kind);
    this.retryAfter = retryAfter;
  }
}

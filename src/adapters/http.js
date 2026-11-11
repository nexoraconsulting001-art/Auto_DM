import crypto from 'node:crypto';
import { isSimulatorUrl, refuseSimulatorUrl } from '../../tools/sim/guard.mjs';

/**
 * What every Phase 4 adapter shares: a checked base URL, a timeout on every call, no redirects, and one error type that
 * holds no secret, token, body or query string, so it is always safe to log.
 *
 *   providerUrl({ value, real, name, env })   the base URL to use. Empty means the provider's own. A simulator (loopback) is
 *                                             allowed outside production and refused when NODE_ENV=production; any other
 *                                             host that isn't the provider's throws ProviderHostBlockedError.
 *   createHttp({ provider, baseUrl, timeoutMs }) -> request(method, path, { headers, query, json, form, retries })
 *       -> { status, body, headers }  for 2xx. Anything else throws ProviderError.
 *
 * ProviderError: { provider, kind, status, code, retryable, delivery }
 *   kind       timeout | network | auth | rejected | throttled | server | malformed
 *   retryable  true for timeout, network, throttled and server
 *   delivery   'none' when the answer proves the provider did nothing (a 4xx); 'unknown' when it may have (a timeout after
 *              sending, a dropped connection, a 5xx). A call that moves money or sends a message with delivery 'unknown'
 *              is never blindly repeated: repeat it only with the provider's idempotency key, or look the result up first.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

export class ProviderHostBlockedError extends Error {
  constructor(name) {
    super(`${name} is not an allowed address for this provider`);
    this.name = 'ProviderHostBlockedError';
    this.reason = 'api.host_blocked';
  }
}

export class ProviderError extends Error {
  constructor({ provider, kind, status = 0, code = '', delivery = 'unknown' }) {
    super(`${provider} call failed (${kind}${status ? `, ${status}` : ''}${code ? `, ${code}` : ''})`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = status;
    this.code = String(code).slice(0, 80);
    this.retryable = ['timeout', 'network', 'throttled', 'server'].includes(kind);
    this.delivery = delivery;
  }
}

export function providerUrl({ value, real, name, env = process.env }) {
  const raw = String(value || real).trim().replace(/\/+$/, '');
  refuseSimulatorUrl(raw, { env, name });
  if (isSimulatorUrl(raw)) return raw;
  let origin = '';
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) origin = url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    // Not a URL at all, so not the provider's.
  }
  const allowed = [].concat(real).map((r) => r.replace(/\/+$/, ''));
  if (!allowed.includes(origin)) throw new ProviderHostBlockedError(name);
  return origin;
}

const kindOf = (status) => (status === 401 || status === 403 ? 'auth' : status === 429 ? 'throttled' : status >= 500 ? 'server' : 'rejected');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createHttp({ provider, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, codeOf = () => '' }) {
  /**
   * `retries` is how many more times a retryable failure is tried, with backoff (0.2 s, 0.4 s, ...). Only pass it for calls
   * that are safe to repeat: reads, or writes carrying the provider's idempotency key.
   */
  return async function request(method, path, { headers = {}, query, json, form, retries = 0 } = {}) {
    const url = new URL(baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const init = {
      method,
      redirect: 'error',
      headers: { accept: 'application/json', ...headers },
      ...(json !== undefined ? { body: JSON.stringify(json) } : form !== undefined ? { body: new URLSearchParams(form) } : {}),
    };
    if (json !== undefined) init.headers['content-type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      let failure;
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        let body = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            if (res.ok) throw new ProviderError({ provider, kind: 'malformed', status: res.status, delivery: 'unknown' });
          }
        }
        if (res.ok) return { status: res.status, body, headers: res.headers };
        failure = new ProviderError({ provider, kind: kindOf(res.status), status: res.status, code: codeOf(body) ?? '', delivery: res.status >= 500 ? 'unknown' : 'none' });
      } catch (err) {
        failure = err instanceof ProviderError ? err : new ProviderError({ provider, kind: err?.name === 'TimeoutError' ? 'timeout' : 'network', delivery: 'unknown' });
      }
      if (!failure.retryable || attempt >= retries) throw failure;
      await sleep(200 * 2 ** attempt);
    }
  };
}

/** Compares two strings as bytes in constant time. A missing or wrong-length value is simply a mismatch. */
export function sameBytes(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** HMAC-SHA256 of the exact bytes received, as hex or base64. */
export const hmac = (secret, rawBody, encoding = 'hex') => crypto.createHmac('sha256', secret).update(rawBody).digest(encoding);

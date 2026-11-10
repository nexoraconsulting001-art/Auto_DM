import { isSimulatorUrl, refuseSimulatorUrl } from '../../../tools/sim/guard.mjs';

const GA4_HOST = 'https://www.google-analytics.com';
const DEFAULT_TIMEOUT_MS = 10_000;

export class Ga4HostBlockedError extends Error {
  constructor() {
    super('GA4_BASE_URL is not an allowed Google address');
    this.name = 'Ga4HostBlockedError';
    this.reason = 'api.host_blocked';
  }
}

/** A failed call to GA4. Holds no secret, measurement id or query string, so it is safe to log. kind is timeout, network or rejected. */
export class Ga4Error extends Error {
  constructor({ kind, status = 0 }) {
    super(`GA4 Measurement Protocol failed (${kind}, ${status})`);
    this.name = 'Ga4Error';
    this.kind = kind;
    this.status = status;
  }
}

function ga4Url(config, env) {
  const raw = String(config.ga4BaseUrl || GA4_HOST).trim().replace(/\/+$/, '');
  refuseSimulatorUrl(raw, { env, name: 'GA4_BASE_URL' });
  if (isSimulatorUrl(raw) || raw === GA4_HOST) return raw;
  throw new Ga4HostBlockedError();
}

/**
 * The seller's own GA4 property, by Measurement Protocol (PRD 7.14). `stream` is { measurementId, apiSecret }, from tag_settings. A 10 s timeout, no redirects,
 * only Google's host or a simulator outside production. GA4 answers 2xx even for an event it drops, so a success means only that the call arrived.
 *
 *   send(stream, { clientId, userId?, events }) -> { status }
 *
 * Ask platform.consent first: a shopper who hasn't said yes gets no server event.
 */
export function createGa4(config = {}, { env = process.env } = {}) {
  const base = ga4Url(config, env);
  const timeoutMs = config.ga4TimeoutMs || DEFAULT_TIMEOUT_MS;

  return {
    async send({ measurementId, apiSecret }, { clientId, userId, events }) {
      if (!Array.isArray(events) || !events.length) throw new Error('GA4 needs at least one event');
      const url = new URL('/mp/collect', base);
      url.searchParams.set('measurement_id', measurementId);
      url.searchParams.set('api_secret', apiSecret);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, ...(userId ? { user_id: userId } : {}), events }),
        });
      } catch (err) {
        throw new Ga4Error({ kind: err?.name === 'TimeoutError' ? 'timeout' : 'network' });
      }
      await res.text().catch(() => '');
      if (!res.ok) throw new Ga4Error({ kind: 'rejected', status: res.status });
      return { status: res.status };
    },
  };
}

/** Everything that talks to Google for analytics, built from config. Throws at start-up on a bad address. Modules get this as ctx.google: { ga4 }. */
export function createGoogleAdapters(config = {}, options = {}) {
  return { ga4: createGa4(config, options) };
}

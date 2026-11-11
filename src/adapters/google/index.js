import { isSimulatorUrl, refuseSimulatorUrl } from '../../../tools/sim/guard.mjs';
import { createKeySet, verifyIdToken } from '../oidc.js';

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

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = Object.freeze(['https://accounts.google.com', 'accounts.google.com']);

/** A failed Google sign-in. Holds no token, code, email or name, so it is safe to log. kind is not_configured, timeout, network, unavailable or rejected. */
export class GoogleSignInError extends Error {
  constructor(kind) {
    super(`Google sign-in failed (${kind})`);
    this.name = 'GoogleSignInError';
    this.kind = kind;
    this.retryable = kind === 'timeout' || kind === 'network' || kind === 'unavailable';
  }
}

/**
 * Google sign-in for sellers (PRD 5.11, 10.3): the authorization-code flow, with the ID token checked here against
 * Google's published keys. It has its own OAuth client (SELLER_GOOGLE_CLIENT_ID), apart from the shoppers' one in
 * src/modules/shoppers/google.js, so a token minted for a shopper's sign-in is for another audience and is refused.
 *
 *   authorizeUrl({ redirectUri, state, nonce })   Google's sign-in page, the only page in the flow that is not ours
 *   exchange({ code, redirectUri }) -> idToken    swaps the code once, with the client secret
 *   verify(idToken, { nonce }) -> { sub, email, emailVerified, name }
 *                                                 signature, issuer, audience, expiry and nonce. Throws IdTokenError
 *   signIn({ code, redirectUri, nonce })          exchange, then verify
 *
 * Every call has a 10 s timeout and follows no redirect. GOOGLE_KEYS_BASE_URL points the sign-in page, the code
 * exchange and the keys at tools/sim/google, which is refused when NODE_ENV=production; any other host is refused at
 * start. Nothing here logs a token, a code, an email address or a name.
 */
export function createGoogleSellerSignIn(config = {}, { env = process.env, fetch: send = (...args) => globalThis.fetch(...args) } = {}) {
  const clientId = String(config.sellerGoogleClientId ?? '');
  const clientSecret = String(config.sellerGoogleClientSecret ?? '');
  const base = String(config.googleKeysBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (base) {
    refuseSimulatorUrl(base, { env, name: 'GOOGLE_KEYS_BASE_URL' });
    if (!isSimulatorUrl(base)) throw new Error('GOOGLE_KEYS_BASE_URL may only point at the Google simulator');
  }
  const timeoutMs = config.providerTimeoutMs || DEFAULT_TIMEOUT_MS;
  const authUrl = base ? `${base}/o/oauth2/v2/auth` : GOOGLE_AUTH_URL;
  const tokenUrl = base ? `${base}/token` : GOOGLE_TOKEN_URL;
  const issuers = base ? [base] : GOOGLE_ISSUERS;
  const keys = createKeySet({ url: base ? `${base}/oauth2/v3/certs` : GOOGLE_KEYS_URL, timeoutMs, minRefetchMs: config.idTokenKeyRefetchMs ?? 60_000, fetch: send });

  return {
    /** False until SELLER_GOOGLE_CLIENT_ID and SELLER_GOOGLE_CLIENT_SECRET are set: the sign-in screen then leaves Google out. */
    get configured() {
      return Boolean(clientId && clientSecret);
    },

    authorizeUrl({ redirectUri, state, nonce }) {
      const url = new URL(authUrl);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('prompt', 'select_account');
      return url.href;
    },

    async exchange({ code, redirectUri }) {
      if (!this.configured) throw new GoogleSignInError('not_configured');
      let res;
      try {
        res = await send(tokenUrl, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: String(code), redirect_uri: redirectUri, grant_type: 'authorization_code' }),
        });
      } catch (err) {
        throw new GoogleSignInError(err?.name === 'TimeoutError' ? 'timeout' : 'network');
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || typeof body?.id_token !== 'string') throw new GoogleSignInError(res.status >= 500 ? 'unavailable' : 'rejected');
      return body.id_token;
    },

    async verify(idToken, { nonce } = {}) {
      if (!this.configured) throw new GoogleSignInError('not_configured');
      const claims = await verifyIdToken(idToken, { keys, issuers, audiences: [clientId], nonce });
      const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
      return {
        sub: claims.sub,
        email: emailVerified && typeof claims.email === 'string' ? claims.email.slice(0, 254) : '',
        emailVerified,
        name: typeof claims.name === 'string' ? claims.name.slice(0, 80) : '',
      };
    },

    async signIn({ code, redirectUri, nonce }) {
      if (typeof nonce !== 'string' || !nonce) throw new GoogleSignInError('rejected');
      return this.verify(await this.exchange({ code, redirectUri }), { nonce });
    },
  };
}

/** Everything that talks to Google, built from config. Throws at start-up on a bad address. Modules get this as ctx.google: { ga4, signIn }. */
export function createGoogleAdapters(config = {}, options = {}) {
  return { ga4: createGa4(config, options), signIn: createGoogleSellerSignIn(config, options) };
}

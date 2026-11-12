import crypto from 'node:crypto';
import { isSimulatorUrl, refuseSimulatorUrl } from '../../../tools/sim/guard.mjs';
import { IdTokenError, createKeySet, verifyIdToken } from '../oidc.js';

/**
 * Sign in with Apple for sellers (PRD 10.6, Apple 4.8). The app gets an identity token from Apple on the device and
 * sends it here; this side checks it and says who signed in. There is no code exchange and no client secret: the
 * token is proof by itself once its signature (Apple's published keys), issuer, audience, expiry and nonce hold.
 *
 *   apple.signIn.verify(identityToken, { nonce, audiences? }) -> { sub, email, emailVerified, privateEmail }
 *
 * `nonce` is the raw value the app made for this sign-in. The app gives Apple its SHA-256 in hex, Apple signs that
 * into the token, and the raw value comes here: a token replayed from another sign-in has another nonce.
 * APPLE_SIGNIN_AUDIENCES lists who a token may be for (the owner app's bundle id, the Services ID for the web); with
 * none set every token is refused. APPLE_KEYS_BASE_URL points the keys at tools/sim/apple, which is refused when
 * NODE_ENV=production, and any other host is refused at start. A failure is an IdTokenError (src/adapters/oidc.js).
 * Apple rotates its keys without notice: a token signed by a key not seen yet fetches them again, at most once a minute
 * (config.idTokenKeyRefetchMs, which only tests change).
 *
 * Nothing here logs a token, an email address or a subject.
 */
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';

export const appleNonce = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

export function createAppleSignIn(config = {}, { env = process.env, fetch } = {}) {
  const audiences = Object.freeze([...(config.appleSigninAudiences ?? [])].map(String).filter(Boolean));
  const base = String(config.appleKeysBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (base) {
    refuseSimulatorUrl(base, { env, name: 'APPLE_KEYS_BASE_URL' });
    if (!isSimulatorUrl(base)) throw new Error('APPLE_KEYS_BASE_URL may only point at the Apple simulator');
  }
  const keys = createKeySet({ url: base ? `${base}/auth/keys` : APPLE_KEYS_URL, timeoutMs: config.providerTimeoutMs || 10_000, minRefetchMs: config.idTokenKeyRefetchMs ?? 60_000, ...(fetch ? { fetch } : {}) });
  const issuers = [base || APPLE_ISSUER];

  return {
    /** False until APPLE_SIGNIN_AUDIENCES is set: the sign-in screen then leaves Apple out. */
    get configured() {
      return audiences.length > 0;
    },
    /** `audiences`, when given and not empty, replaces the configured ones for this call: a shopper app's token is for its brand's bundle id (Phase 6). */
    async verify(identityToken, { nonce, audiences: callAudiences } = {}) {
      const allowed = Array.isArray(callAudiences) && callAudiences.map(String).filter(Boolean).length ? callAudiences.map(String).filter(Boolean) : audiences;
      if (!allowed.length) throw new IdTokenError('wrong_audience');
      if (typeof nonce !== 'string' || !nonce) throw new IdTokenError('wrong_nonce');
      const claims = await verifyIdToken(identityToken, { keys, issuers, audiences: allowed, nonce: appleNonce(nonce) });
      const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
      return {
        sub: claims.sub,
        email: emailVerified && typeof claims.email === 'string' ? claims.email.slice(0, 254) : '',
        emailVerified,
        /** A relay address Apple made up for this app: mail to it reaches the person, but it matches no invitation. */
        privateEmail: claims.is_private_email === true || claims.is_private_email === 'true',
      };
    },
  };
}

/** Everything that talks to Apple, built from config. Throws at start-up on a bad address. Modules get this as ctx.apple: { signIn }. */
export function createAppleAdapters(config = {}, options = {}) {
  return { signIn: createAppleSignIn(config, options) };
}

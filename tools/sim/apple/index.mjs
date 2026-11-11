/**
 * Sign in with Apple, as far as a server sees it: Apple's published signing keys, and identity tokens the way a
 * device would receive them. Point APPLE_KEYS_BASE_URL at this server. The issuer of its tokens is its own address.
 *
 * API (what src/adapters/apple calls):
 *   GET /auth/keys                                  the JWKS document
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults, calls, the clock):
 *   POST /identity-token { sub?, email?, emailVerified?, privateEmail?, nonce?, aud?, fault? } -> { identityToken, sub }
 *        nonce is the raw value the app made: the token carries its SHA-256 in hex, as Apple's does.
 *        fault is one of TOKEN_FAULTS in ../oidc.mjs: expired, wrong_audience, wrong_issuer, wrong_nonce,
 *        wrong_signature, unknown_key, alg_none, hs256, junk.
 *   POST /keys/rotate { keepOld? } -> { kid }       Apple rotates its keys without notice
 *
 * The keys endpoint itself fails with the shared faults: { kind: 'timeout', match: { path: '/auth/keys' } }, or
 * server_error, or malformed (junk).
 *
 * Not in SERVICES (tools/sim/index.mjs): a test that signs in with Apple starts it itself, like tools/sim/email.
 */
import crypto from 'node:crypto';
import { SimError, createSim } from '../base.mjs';
import { TOKEN_FAULTS, createSigner } from '../oidc.mjs';

const TEN_MINUTES_S = 600;

export function createApple({ audience = 'sim.apple.owner-app' } = {}) {
  const signer = createSigner();

  const sim = createSim({
    name: 'apple',
    errorBody: ({ kind }) => ({ error: kind }),
    reset: () => signer.reset(),
    routes: (on) => {
      on('GET', '/auth/keys', () => signer.jwks());
    },
    controls: (on) => {
      on('POST', '/identity-token', ({ body = {} }) => {
        if (body.fault !== undefined && !TOKEN_FAULTS.includes(body.fault)) throw new SimError(400, { error: `fault must be one of ${TOKEN_FAULTS.join(', ')}.` });
        const now = Math.floor(sim.clock.now() / 1000);
        const sub = body.sub ?? `001${crypto.randomBytes(8).toString('hex')}.sim`;
        const rawNonce = body.fault === 'wrong_nonce' ? `${body.nonce ?? ''}-another` : body.nonce;
        const claims = {
          iss: body.fault === 'wrong_issuer' ? 'https://appleid.apple.example' : sim.url,
          aud: body.fault === 'wrong_audience' ? 'another.apple.app' : body.aud ?? audience,
          iat: body.fault === 'expired' ? now - 2 * TEN_MINUTES_S : now,
          exp: body.fault === 'expired' ? now - TEN_MINUTES_S : now + TEN_MINUTES_S,
          sub,
          ...(rawNonce !== undefined ? { nonce: crypto.createHash('sha256').update(String(rawNonce)).digest('hex'), nonce_supported: true } : {}),
          ...(body.email ? { email: body.email, email_verified: body.emailVerified === false ? 'false' : 'true', is_private_email: body.privateEmail ? 'true' : 'false' } : {}),
        };
        return { identityToken: signer.sign(claims, { fault: body.fault }), sub };
      });
      on('POST', '/keys/rotate', ({ body = {} }) => ({ kid: signer.rotate({ keepOld: Boolean(body.keepOld) }) }));
    },
  });
  return sim;
}

/**
 * What the Google and Apple simulators share: RSA signing keys published as a JWKS document, and ID tokens signed
 * with them (RS256), right or deliberately wrong. Used only by simulators.
 *
 *   const signer = createSigner();
 *   signer.jwks()                      -> { keys: [...] }, what the keys endpoint answers
 *   signer.sign(claims, { fault })     -> a JWT. fault:
 *       wrong_signature   signed by a key that was never published, under the current key's id
 *       unknown_key       signed correctly by a key that is not published, under its own id
 *       alg_none          no signature at all, alg "none"
 *       hs256             signed HS256 with the public key as the secret (the classic confusion attack)
 *       junk              not a token
 *   signer.rotate({ keepOld })         a new current key; the old one stays published only with keepOld
 *   signer.reset()
 *
 * expired, wrong_audience, wrong_issuer and wrong_nonce are claims, so the simulators set those themselves.
 */
import crypto from 'node:crypto';

export const TOKEN_FAULTS = Object.freeze(['expired', 'wrong_audience', 'wrong_issuer', 'wrong_nonce', 'wrong_signature', 'unknown_key', 'alg_none', 'hs256', 'junk']);

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid: `sim-${crypto.randomBytes(6).toString('hex')}`, publicKey, privateKey };
}

export function createSigner() {
  // Made on first use: most tests that start a simulator never sign a token, and an RSA key takes a moment.
  let keys = null;
  let unpublished = null;
  const published = () => (keys ??= [newKey()]);
  const current = () => published()[published().length - 1];
  const strangerKey = () => (unpublished ??= newKey());
  const rs256 = (key, kid, claims) => {
    const data = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(claims)}`;
    return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key.privateKey).toString('base64url')}`;
  };

  return {
    get kid() {
      return current().kid;
    },
    jwks() {
      return { keys: published().map((key) => ({ ...key.publicKey.export({ format: 'jwk' }), kid: key.kid, use: 'sig', alg: 'RS256' })) };
    },
    sign(claims, { fault } = {}) {
      if (fault === 'junk') return 'not.a.token';
      if (fault === 'wrong_signature') return rs256(strangerKey(), current().kid, claims);
      if (fault === 'unknown_key') return rs256(strangerKey(), strangerKey().kid, claims);
      if (fault === 'alg_none') return `${b64({ alg: 'none', typ: 'JWT', kid: current().kid })}.${b64(claims)}.`;
      if (fault === 'hs256') {
        const data = `${b64({ alg: 'HS256', typ: 'JWT', kid: current().kid })}.${b64(claims)}`;
        const secret = current().publicKey.export({ type: 'spki', format: 'pem' });
        return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
      }
      return rs256(current(), current().kid, claims);
    },
    rotate({ keepOld = false } = {}) {
      const next = newKey();
      keys = keepOld ? [...published(), next] : [next];
      return next.kid;
    },
    reset() {
      keys = null;
    },
  };
}

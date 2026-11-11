import crypto from 'node:crypto';

/**
 * Checking an OpenID Connect ID token against its issuer's published keys: what Google sign-in and Sign in with Apple
 * share (PRD 5.11, 10.6). Nothing here trusts a token for anything until its signature, issuer, audience, expiry and
 * nonce have all been checked, in that order, and nothing here logs a token, a claim or a key.
 *
 *   const keys = createKeySet({ url });                       // one per issuer, kept for the life of the process
 *   const claims = await verifyIdToken(token, { keys, issuers, audiences, nonce });
 *
 * A failure is an IdTokenError with a `kind`: malformed, unsupported_alg, unknown_key, bad_signature, wrong_issuer,
 * wrong_audience, expired, not_yet_valid, wrong_nonce, no_subject, or keys_unavailable (the keys could not be fetched:
 * the only kind worth trying again). Tell the person none of this: every kind but the last is "that sign-in didn't work".
 */
export class IdTokenError extends Error {
  constructor(kind) {
    super(`ID token refused (${kind})`);
    this.name = 'IdTokenError';
    this.kind = kind;
    this.retryable = kind === 'keys_unavailable';
  }
}

const MAX_TOKEN_BYTES = 8192;
const MAX_KEYS_BYTES = 64 * 1024;
const CLOCK_SKEW_S = 60;

/**
 * The issuer's signing keys (a JWKS document), fetched with a timeout and no redirects and kept for `cacheMs`.
 * A key id that is not in the cached set means the issuer rotated its keys: the set is fetched again, but at most
 * once per `minRefetchMs`, so a stream of tokens with made-up key ids cannot turn this server into a load on the issuer.
 */
export function createKeySet({ url, timeoutMs = 10_000, cacheMs = 60 * 60_000, minRefetchMs = 60_000, fetch: send = (...args) => globalThis.fetch(...args), now = Date.now }) {
  let keys = new Map();
  let fetchedAt = -Infinity;
  let loading = null;

  async function load() {
    let res;
    try {
      res = await send(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch {
      throw new IdTokenError('keys_unavailable');
    }
    if (!res.ok) throw new IdTokenError('keys_unavailable');
    let body;
    try {
      const raw = await res.text();
      if (raw.length > MAX_KEYS_BYTES) throw new Error('too large');
      body = JSON.parse(raw);
    } catch {
      throw new IdTokenError('keys_unavailable');
    }
    if (!Array.isArray(body?.keys)) throw new IdTokenError('keys_unavailable');
    const next = new Map();
    for (const jwk of body.keys) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== 'RS256')) continue;
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch {
        // A key that cannot be read is no key.
      }
    }
    if (!next.size) throw new IdTokenError('keys_unavailable');
    keys = next;
    fetchedAt = now();
  }
  const refresh = () => (loading ??= load().finally(() => { loading = null; }));

  return {
    /** The public key with this id, or null when the issuer has none. Throws keys_unavailable when the keys cannot be fetched and none are cached. */
    async key(kid) {
      const age = now() - fetchedAt;
      if (age > cacheMs) {
        // Stale keys still verify while the issuer is unreachable: a key it published an hour ago was its key.
        await refresh().catch((err) => { if (!keys.size) throw err; });
      }
      if (keys.has(kid)) return keys.get(kid);
      if (now() - fetchedAt < minRefetchMs) return null;
      await refresh();
      return keys.get(kid) ?? null;
    },
  };
}

function decode(part) {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/**
 * The token's claims, once everything about it has been checked. RS256 only: a token that names any other algorithm
 * ("none", or HS256 with the public key as the secret) is refused before a key is looked at.
 *
 *   issuers    the `iss` values accepted
 *   audiences  who the token may be for; it must name at least one of them. An empty list accepts nothing
 *   nonce      when given, the token's `nonce` must equal it
 */
export async function verifyIdToken(token, { keys, issuers, audiences, nonce, now = Date.now }) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_BYTES) throw new IdTokenError('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new IdTokenError('malformed');
  const header = decode(parts[0]);
  const claims = decode(parts[1]);
  if (!header || !claims) throw new IdTokenError('malformed');
  if (header.alg !== 'RS256') throw new IdTokenError('unsupported_alg');
  if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 200) throw new IdTokenError('malformed');

  const key = await keys.key(header.kid);
  if (!key) throw new IdTokenError('unknown_key');
  let signed = false;
  try {
    signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  } catch {
    signed = false;
  }
  if (!signed) throw new IdTokenError('bad_signature');

  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) throw new IdTokenError('wrong_issuer');
  const named = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences?.length || !named.some((aud) => typeof aud === 'string' && audiences.includes(aud))) throw new IdTokenError('wrong_audience');
  const seconds = Math.floor(now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= seconds) throw new IdTokenError('expired');
  if (Number.isFinite(claims.iat) && claims.iat > seconds + CLOCK_SKEW_S) throw new IdTokenError('not_yet_valid');
  if (Number.isFinite(claims.nbf) && claims.nbf > seconds + CLOCK_SKEW_S) throw new IdTokenError('not_yet_valid');
  if (nonce !== undefined && (typeof claims.nonce !== 'string' || !same(claims.nonce, nonce))) throw new IdTokenError('wrong_nonce');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new IdTokenError('no_subject');
  return claims;
}

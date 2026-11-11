import { isSimulatorUrl, refuseSimulatorUrl } from '../../../tools/sim/guard.mjs';

/**
 * Google sign-in for shoppers (PRD 9.3): the authorization-code flow, server side. Google's own sign-in page is the only
 * page in it; this side builds the address, swaps the code for tokens once, and reads who signed in from the ID token.
 *
 * The ID token comes straight from Google's token endpoint over TLS, in answer to our own request with our client secret,
 * so its signature need not be checked again here (OpenID Connect Core 3.1.3.7); its audience, issuer, expiry and nonce
 * are. Every call has a 10 s timeout and follows no redirect. GOOGLE_OAUTH_BASE_URL points everything at tools/sim/google,
 * which is refused when NODE_ENV=production, and any other host is refused at start.
 *
 * Nothing here logs a token, a code, an email address or a name.
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = Object.freeze(['https://accounts.google.com', 'accounts.google.com']);
const TIMEOUT_MS = 10_000;

export class GoogleSignInError extends Error {
  constructor(kind) {
    super(`Google sign-in failed (${kind})`);
    this.name = 'GoogleSignInError';
    this.kind = kind;
  }
}

function decodeClaims(idToken) {
  const [, payload] = String(idToken ?? '').split('.');
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

export function createGoogleSignIn(config = {}, { env = process.env } = {}) {
  const clientId = String(config.googleClientId ?? '');
  const clientSecret = String(config.googleClientSecret ?? '');
  const base = String(config.googleOauthBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (base) {
    refuseSimulatorUrl(base, { env, name: 'GOOGLE_OAUTH_BASE_URL' });
    if (!isSimulatorUrl(base)) throw new Error('GOOGLE_OAUTH_BASE_URL may only point at the Google simulator');
  }
  const authUrl = base ? `${base}/o/oauth2/v2/auth` : AUTH_URL;
  const tokenUrl = base ? `${base}/token` : TOKEN_URL;
  const issuers = base ? [base] : GOOGLE_ISSUERS;

  return {
    /** False until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set: the sign-in page then offers WhatsApp only. */
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

    /** Swaps the code for who signed in: { sub, email, emailVerified, name }. Throws GoogleSignInError with a kind, never a token. */
    async signIn({ code, redirectUri, nonce }) {
      if (!this.configured) throw new GoogleSignInError('not_configured');
      let res;
      try {
        res = await fetch(tokenUrl, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: String(code), redirect_uri: redirectUri, grant_type: 'authorization_code' }),
        });
      } catch (err) {
        throw new GoogleSignInError(err?.name === 'TimeoutError' ? 'timeout' : 'network');
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.id_token) throw new GoogleSignInError(res.status >= 500 ? 'unavailable' : 'rejected');
      const claims = decodeClaims(body.id_token);
      const now = Math.floor(Date.now() / 1000);
      if (!claims || claims.aud !== clientId || !issuers.includes(claims.iss)) throw new GoogleSignInError('bad_token');
      if (!(Number(claims.exp) > now) || claims.nonce !== nonce) throw new GoogleSignInError('bad_token');
      if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new GoogleSignInError('bad_token');
      const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
      return {
        sub: claims.sub,
        email: emailVerified && typeof claims.email === 'string' ? claims.email.slice(0, 254) : '',
        emailVerified,
        name: typeof claims.name === 'string' ? claims.name.slice(0, 80) : '',
      };
    },
  };
}

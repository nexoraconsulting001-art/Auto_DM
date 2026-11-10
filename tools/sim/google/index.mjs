/**
 * Google sign-in, base routes only: discovery, the consent redirect, the code exchange, userinfo and tokeninfo.
 * id_tokens are HS256 with a per-run secret and are checked by /tokeninfo; moving to RS256 and JWKS is for the phase
 * that verifies them locally. POST /__sim/next-user { sub, email, name, deny? } decides who signs in next.
 */
import crypto from 'node:crypto';
import { SimError, createSim, reply } from '../base.mjs';
import { isLoopbackUrl } from '../guard.mjs';

const SIGNING_KEY = crypto.randomBytes(32);
const HOUR_S = 3600;
const googleError = (status, error, description) => new SimError(status, { error, error_description: description });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const mac = (data) => crypto.createHmac('sha256', SIGNING_KEY).update(data).digest('base64url');

function signIdToken(claims) {
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${data}.${mac(data)}`;
}

function readIdToken(token) {
  const [header, payload, signature] = String(token ?? '').split('.');
  if (!header || !payload || !signature) return null;
  const expected = Buffer.from(mac(`${header}.${payload}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

export function createGoogle({ clientId = 'sim-google-client', clientSecret = 'sim-google-secret' } = {}) {
  const defaultUser = { sub: 'sim-google-user', email: 'owner@bhava.test', email_verified: true, name: 'Simulated Owner' };
  let nextUser;
  let codes;
  let accessTokens;
  const clear = () => {
    nextUser = null;
    codes = new Map();
    accessTokens = new Map();
  };
  clear();

  const sim = createSim({
    name: 'google',
    errorBody: ({ kind }) => ({ error: kind, error_description: `Simulated ${kind}.` }),
    reset: clear,
    routes: (on) => {
      on('GET', '/.well-known/openid-configuration', () => ({
        issuer: sim.url,
        authorization_endpoint: `${sim.url}/o/oauth2/v2/auth`,
        token_endpoint: `${sim.url}/token`,
        userinfo_endpoint: `${sim.url}/oauth2/v3/userinfo`,
      }));
      on('GET', '/o/oauth2/v2/auth', (req) => {
        const { client_id: id, redirect_uri: redirectUri, response_type: responseType, state, nonce } = req.query;
        if (id !== clientId || responseType !== 'code' || !isLoopbackUrl(redirectUri)) return reply(400, 'Error 400: invalid_request', { 'content-type': 'text/plain' });
        const user = nextUser ?? defaultUser;
        nextUser = null;
        const target = new URL(redirectUri);
        if (state !== undefined) target.searchParams.set('state', state);
        if (user.deny) {
          target.searchParams.set('error', 'access_denied');
          return reply(302, '', { location: target.href });
        }
        const code = `4/sim${crypto.randomBytes(16).toString('hex')}`;
        codes.set(code, { user, redirectUri, nonce });
        target.searchParams.set('code', code);
        return reply(302, '', { location: target.href });
      });
      on('POST', '/token', (req) => {
        const { client_id: id, client_secret: secret, code, redirect_uri: redirectUri, grant_type: grantType } = req.body ?? {};
        if (id !== clientId || secret !== clientSecret) throw googleError(401, 'invalid_client', 'The OAuth client was not found.');
        if (grantType !== 'authorization_code') throw googleError(400, 'unsupported_grant_type', 'Only authorization_code is simulated.');
        const grant = codes.get(code);
        if (!grant || grant.redirectUri !== redirectUri) throw googleError(400, 'invalid_grant', 'Malformed auth code.');
        codes.delete(code);
        const now = Math.floor(sim.clock.now() / 1000);
        const accessToken = `ya29.sim${crypto.randomBytes(16).toString('hex')}`;
        accessTokens.set(accessToken, grant.user);
        const idToken = signIdToken({ iss: sim.url, aud: clientId, iat: now, exp: now + HOUR_S, ...(grant.nonce ? { nonce: grant.nonce } : {}), ...grant.user });
        return { access_token: accessToken, id_token: idToken, expires_in: HOUR_S, token_type: 'Bearer', scope: 'openid email profile' };
      });
      on('GET', '/oauth2/v3/userinfo', (req) => {
        const user = accessTokens.get(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
        if (!user) throw googleError(401, 'invalid_token', 'Invalid Credentials');
        return user;
      });
      on('GET', '/tokeninfo', (req) => {
        const claims = readIdToken(req.query.id_token);
        if (!claims || claims.exp * 1000 <= sim.clock.now()) throw googleError(400, 'invalid_token', 'Invalid Value');
        return claims;
      });
    },
    controls: (on) => {
      on('POST', '/next-user', ({ body }) => {
        nextUser = { ...defaultUser, ...body };
        return { ok: true };
      });
    },
  });
  return sim;
}

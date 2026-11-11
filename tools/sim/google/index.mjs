/**
 * Google sign-in: discovery, the consent redirect, the code exchange, userinfo and tokeninfo.
 * POST /__sim/next-user { sub, email, name, deny? } decides who signs in next.
 *
 * Two OAuth clients. The shoppers' one (clientId) gets HS256 id_tokens with a per-run secret, checked by /tokeninfo, as
 * before. The sellers' one (sellerClientId, PRD 5.11) gets RS256 id_tokens signed with keys published at
 * GET /oauth2/v3/certs, which src/adapters/google checks locally. Point GOOGLE_KEYS_BASE_URL at this server.
 *   POST /__sim/id-token { sub?, email?, emailVerified?, name?, nonce?, aud?, fault? } -> { idToken }   a seller token, minted directly
 *   POST /__sim/next-token-fault { fault }      the next seller code exchange answers with a token that has this fault
 *   POST /__sim/keys/rotate { keepOld? } -> { kid }
 * fault is one of TOKEN_FAULTS in ../oidc.mjs: expired, wrong_audience, wrong_issuer, wrong_nonce, wrong_signature,
 * unknown_key, alg_none, hs256, junk. The keys and token endpoints also fail with the shared faults (timeout,
 * server_error, malformed), matched by path: /oauth2/v3/certs and /token.
 *
 * GA4 Measurement Protocol and the browser tag (PRD 7.14), so a seller's tag never reaches Google in a test. Point GA4_BASE_URL at this server. Like GA4, it answers
 * 2xx even for an event it drops; /debug/mp/collect says why.
 *   POST /__sim/ga4/streams        { measurementId, apiSecret? }: returns the secret
 *   POST /__sim/ga4/streams/revoke { measurementId }
 *   GET  /__sim/ga4/events?measurementId=   { accepted, dropped, purchases }: purchases counts each transaction_id once
 */
import crypto from 'node:crypto';
import { SimError, createSim, reply } from '../base.mjs';
import { isLoopbackUrl } from '../guard.mjs';
import { TOKEN_FAULTS, createSigner } from '../oidc.mjs';

const SIGNING_KEY = crypto.randomBytes(32);
const HOUR_S = 3600;
const MAX_EVENTS = 25;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const TAG_SCRIPT = '/* simulated tag */ window.gtag = window.gtag || function () {};';
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

export function createGoogle({ clientId = 'sim-google-client', clientSecret = 'sim-google-secret', sellerClientId = 'sim-seller-google-client', sellerClientSecret = 'sim-seller-google-secret' } = {}) {
  const signer = createSigner();
  let nextTokenFault = null;
  const secretOf = (id) => (id === clientId ? clientSecret : id === sellerClientId ? sellerClientSecret : null);
  const checkFault = (fault) => {
    if (fault !== undefined && fault !== null && !TOKEN_FAULTS.includes(fault)) throw new SimError(400, { error: `fault must be one of ${TOKEN_FAULTS.join(', ')}.` });
    return fault ?? undefined;
  };
  /** A seller's id_token: RS256, with the claims a fault asks for. */
  function sellerIdToken(user, { nonce, aud, fault } = {}) {
    const now = Math.floor(sim.clock.now() / 1000);
    return signer.sign({
      iss: fault === 'wrong_issuer' ? 'https://accounts.google.example' : sim.url,
      aud: fault === 'wrong_audience' ? clientId : aud ?? sellerClientId,
      iat: fault === 'expired' ? now - 2 * HOUR_S : now,
      exp: fault === 'expired' ? now - HOUR_S : now + HOUR_S,
      ...(nonce !== undefined ? { nonce: fault === 'wrong_nonce' ? `${nonce}-another` : nonce } : {}),
      ...user,
    }, { fault });
  }
  const defaultUser = { sub: 'sim-google-user', email: 'owner@bhava.test', email_verified: true, name: 'Simulated Owner' };
  let nextUser;
  let codes;
  let accessTokens;
  let streams;
  let hits;
  const clear = () => {
    nextUser = null;
    nextTokenFault = null;
    signer.reset();
    codes = new Map();
    accessTokens = new Map();
    streams = new Map();
    hits = [];
  };
  clear();

  /** Why GA4 would drop this payload, or null. */
  function problem(query, body) {
    const stream = streams.get(String(query.measurement_id ?? ''));
    if (!stream) return { field: 'measurement_id', message: 'Unknown measurement id' };
    if (stream.revoked || query.api_secret !== stream.apiSecret) return { field: 'api_secret', message: 'The API secret is not valid' };
    if (typeof body?.client_id !== 'string' || !body.client_id) return { field: 'client_id', message: 'client_id is required' };
    if (!Array.isArray(body.events) || !body.events.length || body.events.length > MAX_EVENTS) return { field: 'events', message: `events must hold 1 to ${MAX_EVENTS}` };
    for (const event of body.events) if (typeof event?.name !== 'string' || !EVENT_NAME.test(event.name)) return { field: 'events.name', message: 'Bad event name' };
    return null;
  }

  function collect(req, source) {
    const issue = problem(req.query, req.body);
    const base = { at: sim.clock.now(), source, measurementId: String(req.query.measurement_id ?? ''), clientId: req.body?.client_id ?? '' };
    if (issue) hits.push({ ...base, dropped: issue });
    else for (const event of req.body.events) hits.push({ ...base, name: event.name, params: event.params ?? {} });
    return issue;
  }

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
        if (secretOf(id) === null || responseType !== 'code' || !isLoopbackUrl(redirectUri)) return reply(400, 'Error 400: invalid_request', { 'content-type': 'text/plain' });
        const user = nextUser ?? defaultUser;
        nextUser = null;
        const target = new URL(redirectUri);
        if (state !== undefined) target.searchParams.set('state', state);
        if (user.deny) {
          target.searchParams.set('error', 'access_denied');
          return reply(302, '', { location: target.href });
        }
        const code = `4/sim${crypto.randomBytes(16).toString('hex')}`;
        codes.set(code, { user, redirectUri, nonce, clientId: id });
        target.searchParams.set('code', code);
        return reply(302, '', { location: target.href });
      });
      on('POST', '/token', (req) => {
        const { client_id: id, client_secret: secret, code, redirect_uri: redirectUri, grant_type: grantType } = req.body ?? {};
        if (secretOf(id) === null || secret !== secretOf(id)) throw googleError(401, 'invalid_client', 'The OAuth client was not found.');
        if (grantType !== 'authorization_code') throw googleError(400, 'unsupported_grant_type', 'Only authorization_code is simulated.');
        const grant = codes.get(code);
        if (!grant || grant.redirectUri !== redirectUri || grant.clientId !== id) throw googleError(400, 'invalid_grant', 'Malformed auth code.');
        codes.delete(code);
        const now = Math.floor(sim.clock.now() / 1000);
        const accessToken = `ya29.sim${crypto.randomBytes(16).toString('hex')}`;
        accessTokens.set(accessToken, grant.user);
        let idToken;
        if (id === sellerClientId) {
          idToken = sellerIdToken(grant.user, { nonce: grant.nonce, fault: nextTokenFault ?? undefined });
          nextTokenFault = null;
        } else {
          idToken = signIdToken({ iss: sim.url, aud: clientId, iat: now, exp: now + HOUR_S, ...(grant.nonce ? { nonce: grant.nonce } : {}), ...grant.user });
        }
        return { access_token: accessToken, id_token: idToken, expires_in: HOUR_S, token_type: 'Bearer', scope: 'openid email profile' };
      });
      on('GET', '/oauth2/v3/certs', () => signer.jwks());
      on('GET', '/oauth2/v3/userinfo', (req) => {
        const user = accessTokens.get(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
        if (!user) throw googleError(401, 'invalid_token', 'Invalid Credentials');
        return user;
      });
      on('POST', '/mp/collect', (req) => {
        collect(req, 'server');
        return reply(204, '');
      });
      on('POST', '/debug/mp/collect', (req) => {
        const issue = problem(req.query, req.body);
        return { validationMessages: issue ? [{ fieldPath: issue.field, description: issue.message, validationCode: 'VALUE_INVALID' }] : [] };
      });
      on('GET', '/gtag/js', () => reply(200, TAG_SCRIPT, { 'content-type': 'application/javascript' }));
      on('POST', '/g/collect', (req) => {
        hits.push({ at: sim.clock.now(), source: 'browser', measurementId: String(req.query.tid ?? ''), clientId: String(req.query.cid ?? ''), name: String(req.query.en ?? ''), params: {} });
        return reply(204, '');
      });
      on('GET', '/tokeninfo', (req) => {
        const claims = readIdToken(req.query.id_token);
        if (!claims || claims.exp * 1000 <= sim.clock.now()) throw googleError(400, 'invalid_token', 'Invalid Value');
        return claims;
      });
    },
    controls: (on) => {
      on('POST', '/ga4/streams', ({ body }) => {
        if (typeof body.measurementId !== 'string' || !body.measurementId) throw new SimError(400, { error: 'measurementId is required.' });
        const apiSecret = body.apiSecret ?? `sim${crypto.randomBytes(12).toString('hex')}`;
        streams.set(body.measurementId, { apiSecret, revoked: false });
        return { measurementId: body.measurementId, apiSecret };
      });
      on('POST', '/ga4/streams/revoke', ({ body }) => {
        const stream = streams.get(body.measurementId);
        if (!stream) throw new SimError(404, { error: 'No such stream.' });
        stream.revoked = true;
        return { ok: true };
      });
      on('GET', '/ga4/events', ({ query }) => {
        const seen = hits.filter((h) => !query.measurementId || h.measurementId === query.measurementId);
        const accepted = seen.filter((h) => !h.dropped);
        const ids = new Set(accepted.filter((h) => h.name === 'purchase').map((h, i) => h.params.transaction_id ?? `none-${i}`));
        return { accepted, dropped: seen.filter((h) => h.dropped), purchases: ids.size };
      });
      on('POST', '/id-token', ({ body = {} }) => {
        const fault = checkFault(body.fault);
        const user = { sub: body.sub ?? defaultUser.sub, email: body.email ?? defaultUser.email, email_verified: body.emailVerified ?? true, name: body.name ?? defaultUser.name };
        return { idToken: sellerIdToken(user, { nonce: body.nonce, aud: body.aud, fault }) };
      });
      on('POST', '/next-token-fault', ({ body = {} }) => {
        nextTokenFault = checkFault(body.fault) ?? null;
        return { ok: true };
      });
      on('POST', '/keys/rotate', ({ body = {} }) => ({ kid: signer.rotate({ keepOld: Boolean(body.keepOld) }) }));
      on('POST', '/next-user', ({ body }) => {
        nextUser = { ...defaultUser, ...body };
        return { ok: true };
      });
    },
  });
  return sim;
}

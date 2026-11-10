/** Business Login for Instagram: the consent redirect, the code exchange, and the long-lived token calls. */
import crypto from 'node:crypto';
import { reply, SimError } from '../base.mjs';
import { isLoopbackUrl } from '../guard.mjs';
import { ERRORS, SCOPES, graphError, toSeconds } from './constants.mjs';
import { facebookExchange } from './facebook.mjs';
import { input, issueToken, liveToken, requestToken } from './state.mjs';

const KNOWN_SCOPES = new Set(Object.values(SCOPES));

/** api.instagram.com answers in its own error shape, not Graph's. */
const oauthError = (message) => new SimError(400, { error_type: 'OAuthException', code: 400, error_message: message });

function redirectAllowed(app, uri) {
  if (!uri) return false;
  return app.redirectUris.length ? app.redirectUris.includes(uri) : isLoopbackUrl(uri);
}

const parseScopes = (scope) => String(scope ?? '').split(/[\s,]+/).filter(Boolean);

const tokenResponse = (ctx, token) => ({ access_token: token.value, token_type: 'bearer', expires_in: toSeconds(token.expiresAt - ctx.clock.now()) });

export function oauthRoutes(on, ctx) {
  on('GET', '/oauth/authorize', (req) => {
    const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType, scope, state } = req.query;
    const { app } = ctx.s;
    if (clientId !== app.id) return reply(400, 'Invalid platform app', { 'content-type': 'text/plain' });
    if (!redirectAllowed(app, redirectUri)) return reply(400, 'The redirect_uri is not registered for this app.', { 'content-type': 'text/plain' });
    if (responseType !== 'code') return reply(400, 'response_type must be code.', { 'content-type': 'text/plain' });
    const requested = parseScopes(scope);
    if (!requested.length || requested.some((name) => !KNOWN_SCOPES.has(name))) return reply(400, 'Invalid scope.', { 'content-type': 'text/plain' });

    const login = ctx.s.nextLogin ?? { igUserId: ctx.s.lastSeeded };
    ctx.s.nextLogin = null;
    const target = new URL(redirectUri);
    if (state !== undefined) target.searchParams.set('state', state);
    if (login.deny) {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_reason', 'user_denied');
      target.searchParams.set('error_description', 'The user denied your request.');
      return reply(302, '', { location: target.href });
    }
    const account = ctx.s.accounts.get(login.igUserId);
    if (!account) return reply(400, 'No Instagram account is seeded for this login. POST /__sim/accounts first.', { 'content-type': 'text/plain' });

    const code = `AQsim${crypto.randomBytes(16).toString('hex')}`;
    const scopes = login.scopes ?? requested;
    ctx.s.codes.set(code, { igUserId: account.igUserId, scopes, redirectUri, expiresAt: ctx.clock.now() + ctx.s.limits.codeMs, used: false });
    target.searchParams.set('code', code);
    target.hash = '_'; // Instagram really does append #_ to the redirect.
    return reply(302, '', { location: target.href });
  });

  on('POST', '/oauth/access_token', (req) => {
    const facebook = facebookExchange(ctx, req);
    if (facebook) return facebook;
    const { client_id: clientId, client_secret: clientSecret, grant_type: grantType, redirect_uri: redirectUri, code } = input(req);
    const { app } = ctx.s;
    if (clientId !== app.id) throw oauthError('Invalid platform app');
    if (clientSecret !== app.secret) throw oauthError('Error validating client secret.');
    if (grantType !== 'authorization_code') throw oauthError('Unsupported grant_type');
    // A pasted redirect URL carries Instagram's #_; the code itself never does, so a client that keeps it fails here.
    const grant = ctx.s.codes.get(code);
    if (!grant || grant.used || ctx.clock.now() >= grant.expiresAt) throw oauthError('Matching code was not found or was already used');
    if (grant.redirectUri !== redirectUri) throw oauthError('Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request');
    grant.used = true;

    const account = ctx.s.accounts.get(grant.igUserId);
    const token = issueToken(ctx, account, { kind: 'short', scopes: grant.scopes });
    const result = { access_token: token.value, user_id: account.appScopedId, permissions: grant.scopes.join(',') };
    return app.oauthShape === 'flat' ? result : { data: [result] };
  });

  on('GET', '/access_token', (req) => {
    const params = input(req);
    if (params.grant_type !== 'ig_exchange_token') throw graphError(ERRORS.BAD_GRANT);
    if (params.client_secret !== ctx.s.app.secret) throw graphError(ERRORS.CLIENT_SECRET);
    const short = liveToken(ctx, requestToken(req));
    if (short.kind !== 'short') throw graphError(ERRORS.TOKEN_INVALID);
    const account = ctx.s.accounts.get(short.igUserId);
    return tokenResponse(ctx, issueToken(ctx, account, { kind: 'long', scopes: short.scopes }));
  });

  on('GET', '/refresh_access_token', (req) => {
    if (input(req).grant_type !== 'ig_refresh_token') throw graphError(ERRORS.BAD_GRANT);
    const current = liveToken(ctx, requestToken(req));
    if (current.kind !== 'long') throw graphError(ERRORS.TOKEN_INVALID);
    if (ctx.clock.now() - current.issuedAt < ctx.s.limits.refreshMinAgeMs) throw graphError(ERRORS.TOKEN_TOO_YOUNG);
    if (!current.scopes.includes(SCOPES.basic)) throw graphError(ERRORS.PERMISSION, `(#200) This action requires the ${SCOPES.basic} permission.`);
    if (ctx.s.app.rotateOnRefresh) current.revoked = true;
    const account = ctx.s.accounts.get(current.igUserId);
    return tokenResponse(ctx, issueToken(ctx, account, { kind: 'long', scopes: current.scopes }));
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCOPES, ERRORS, SCOPES } from '../../../tools/sim/meta/index.mjs';
import { ACCOUNT, DAY, HOUR, errorCode, errorSubcode, graphGet, request, startMeta } from './support.js';

const REDIRECT = 'http://127.0.0.1:3000/ig/callback';
const SCOPE = DEFAULT_SCOPES.join(',');
const APP = { id: 'app-1', secret: 'app-secret', redirectUris: [REDIRECT] };

const authorize = (meta, query = {}) => {
  const url = new URL(`${meta.url}/oauth/authorize`);
  for (const [key, value] of Object.entries({ client_id: APP.id, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE, state: 'st-1', ...query })) url.searchParams.set(key, value);
  return request(url);
};

async function getCode(meta, query) {
  const res = await authorize(meta, query);
  assert.equal(res.status, 302, res.text);
  return new URL(res.headers.get('location')).searchParams.get('code');
}

const exchange = (meta, code, fields = {}) =>
  request(`${meta.url}/oauth/access_token`, { method: 'POST', body: new URLSearchParams({ client_id: APP.id, client_secret: APP.secret, grant_type: 'authorization_code', redirect_uri: REDIRECT, code, ...fields }) });

async function shortToken(meta, query) {
  const res = await exchange(meta, await getCode(meta, query));
  assert.equal(res.status, 200, res.text);
  return res.body.data[0];
}

const toLong = (meta, token, query = {}) => {
  const url = new URL(`${meta.url}/access_token`);
  for (const [key, value] of Object.entries({ grant_type: 'ig_exchange_token', client_secret: APP.secret, access_token: token, ...query })) url.searchParams.set(key, value);
  return request(url);
};

const refresh = (meta, token, query = {}) => {
  const url = new URL(`${meta.url}/refresh_access_token`);
  for (const [key, value] of Object.entries({ grant_type: 'ig_refresh_token', access_token: token, ...query })) url.searchParams.set(key, value);
  return request(url);
};

const advance = (meta, advanceMs) => meta.post('/clock', { advanceMs });

test('consent redirects back with a code, the state and Instagram\'s #_', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const res = await authorize(meta);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get('state'), 'st-1');
  assert.ok(location.searchParams.get('code'));
  assert.equal(location.hash, '#_');
});

test('declining consent redirects with access_denied and no code', async (t) => {
  const meta = await startMeta(t, { app: APP });
  await meta.post('/oauth/next', { deny: true });
  const location = new URL((await authorize(meta)).headers.get('location'));
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('error_reason'), 'user_denied');
  assert.equal(location.searchParams.get('state'), 'st-1');
  assert.equal(location.searchParams.get('code'), null);
  // One-shot: the next login goes through.
  assert.ok(await getCode(meta));
});

test('the consent screen refuses a bad client, redirect, response type or scope', async (t) => {
  const meta = await startMeta(t, { app: APP });
  assert.equal((await authorize(meta, { client_id: 'other' })).status, 400);
  assert.equal((await authorize(meta, { redirect_uri: 'http://127.0.0.1:3000/elsewhere' })).status, 400);
  assert.equal((await authorize(meta, { response_type: 'token' })).status, 400);
  assert.equal((await authorize(meta, { scope: 'instagram_business_basic,not_a_scope' })).status, 400);
  assert.equal((await authorize(meta, { scope: '' })).status, 400);
});

test('with no registered redirects, only loopback ones are accepted', async (t) => {
  const meta = await startMeta(t, { app: { ...APP, redirectUris: [] } });
  assert.equal((await authorize(meta, { redirect_uri: 'http://shop.localhost:3000/cb' })).status, 302);
  assert.equal((await authorize(meta, { redirect_uri: 'https://shop.example/cb' })).status, 400);
});

test('a login with no account seeded fails loudly', async (t) => {
  const meta = await startMeta(t, { app: APP }, { account: null });
  const res = await authorize(meta);
  assert.equal(res.status, 400);
  assert.match(res.text, /__sim\/accounts/);
});

test('the code exchange returns a short token, the app-scoped id and the scopes granted', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const res = await exchange(meta, await getCode(meta));
  assert.equal(res.status, 200);
  const [grant] = res.body.data;
  assert.notEqual(grant.access_token, ACCOUNT.token);
  assert.equal(grant.permissions, SCOPE);
  const me = await graphGet(meta, 'me', { token: grant.access_token, query: { fields: 'user_id' } });
  assert.equal(me.status, 200);
  assert.equal(grant.user_id, me.body.id, 'the exchange reports the app-scoped id');
  assert.equal(me.body.user_id, ACCOUNT.igUserId);
  assert.notEqual(grant.user_id, ACCOUNT.igUserId, 'and it is not the id webhooks carry');
});

test('oauthShape flat returns the fields without the data wrapper', async (t) => {
  const meta = await startMeta(t, { app: { ...APP, oauthShape: 'flat' } });
  const res = await exchange(meta, await getCode(meta));
  assert.ok(res.body.access_token);
  assert.equal(res.body.data, undefined);
});

test('the exchange accepts multipart bodies, as Instagram\'s docs show', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const form = new FormData();
  for (const [key, value] of Object.entries({ client_id: APP.id, client_secret: APP.secret, grant_type: 'authorization_code', redirect_uri: REDIRECT, code: await getCode(meta) })) form.set(key, value);
  assert.equal((await request(`${meta.url}/oauth/access_token`, { method: 'POST', body: form })).status, 200);
});

test('a code works once, and answers in Instagram\'s OAuth error shape afterwards', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const code = await getCode(meta);
  assert.equal((await exchange(meta, code)).status, 200);
  const again = await exchange(meta, code);
  assert.equal(again.status, 400);
  assert.equal(again.body.error_type, 'OAuthException');
  assert.equal(again.body.code, 400);
  assert.match(again.body.error_message, /already used/);
});

test('racing exchanges of one code produce one token', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const code = await getCode(meta);
  const results = await Promise.all(Array.from({ length: 8 }, () => exchange(meta, code)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});

test('a code expires after an hour', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const fresh = await getCode(meta);
  const old = await getCode(meta);
  await advance(meta, HOUR - 1);
  assert.equal((await exchange(meta, fresh)).status, 200);
  await advance(meta, 1);
  assert.equal((await exchange(meta, old)).status, 400);
});

test('the exchange refuses a wrong secret, client, grant or redirect, and a keeps-the-#_ code', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const code = await getCode(meta);
  for (const fields of [{ client_secret: 'wrong' }, { client_id: 'other' }, { grant_type: 'password' }, { redirect_uri: 'http://127.0.0.1:3000/other' }, { code: `${code}#_` }, { code: 'nope' }]) {
    const res = await exchange(meta, code, fields);
    assert.equal(res.status, 400, JSON.stringify(fields));
    assert.equal(res.body.error_type, 'OAuthException');
  }
  assert.equal((await exchange(meta, code)).status, 200, 'none of those used the code up');
});

test('a partial grant carries only the scopes the person allowed', async (t) => {
  const meta = await startMeta(t, { app: APP });
  await meta.post('/oauth/next', { scopes: [SCOPES.basic] });
  const grant = await shortToken(meta);
  assert.equal(grant.permissions, SCOPES.basic);
  const res = await graphGet(meta, `${ACCOUNT.igUserId}/subscribed_apps`, { token: grant.access_token });
  assert.equal(res.status, 200);
});

test('a short token lasts an hour', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const { access_token: token } = await shortToken(meta);
  await advance(meta, HOUR - 1);
  assert.equal((await graphGet(meta, 'me', { token })).status, 200);
  await advance(meta, 1);
  const res = await graphGet(meta, 'me', { token });
  assert.equal(errorCode(res), ERRORS.TOKEN_EXPIRED.code);
  assert.equal(errorSubcode(res), ERRORS.TOKEN_EXPIRED.subcode);
});

test('a short token exchanges for a 60-day token that works', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const { access_token: short } = await shortToken(meta);
  const res = await toLong(meta, short);
  assert.equal(res.status, 200);
  assert.equal(res.body.token_type, 'bearer');
  assert.equal(res.body.expires_in, 60 * 86_400);
  assert.notEqual(res.body.access_token, short);
  assert.equal((await graphGet(meta, 'me', { token: res.body.access_token })).status, 200);
  await advance(meta, 60 * DAY - 1);
  assert.equal((await graphGet(meta, 'me', { token: res.body.access_token })).status, 200);
  await advance(meta, 1);
  assert.equal(errorSubcode(await graphGet(meta, 'me', { token: res.body.access_token })), ERRORS.TOKEN_EXPIRED.subcode);
});

test('the long-token exchange keeps the granted scopes', async (t) => {
  const meta = await startMeta(t, { app: APP });
  await meta.post('/oauth/next', { scopes: [SCOPES.basic] });
  const { access_token: short } = await shortToken(meta);
  const { body } = await toLong(meta, short);
  const res = await graphGet(meta, 'reel-1/comments', { token: body.access_token });
  assert.equal(errorCode(res), ERRORS.PERMISSION.code);
});

test('the long-token exchange refuses a wrong secret, grant, expired token or a long token', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const { access_token: short } = await shortToken(meta);
  assert.equal(errorCode(await toLong(meta, short, { client_secret: 'wrong' })), ERRORS.CLIENT_SECRET.code);
  assert.equal(errorCode(await toLong(meta, short, { grant_type: 'other' })), ERRORS.BAD_GRANT.code);
  assert.equal(errorCode(await toLong(meta, ACCOUNT.token)), ERRORS.TOKEN_INVALID.code);
  assert.equal(errorCode(await toLong(meta, 'unknown')), ERRORS.TOKEN_INVALID.code);
  await advance(meta, HOUR);
  assert.equal(errorSubcode(await toLong(meta, short)), ERRORS.TOKEN_EXPIRED.subcode);
});

test('a token can be refreshed from exactly 24 hours old, not before', async (t) => {
  const meta = await startMeta(t, { app: APP });
  await advance(meta, DAY - 1);
  const early = await refresh(meta, ACCOUNT.token);
  assert.equal(early.status, 400);
  assert.equal(errorCode(early), ERRORS.TOKEN_TOO_YOUNG.code);
  await advance(meta, 1);
  const res = await refresh(meta, ACCOUNT.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.expires_in, 60 * 86_400);
  assert.notEqual(res.body.access_token, ACCOUNT.token, 'a caller must store what refresh returns');
  assert.equal((await graphGet(meta, 'me', { token: res.body.access_token })).status, 200);
});

test('after a refresh the old token still works, unless rotateOnRefresh is on', async (t) => {
  const meta = await startMeta(t, { app: APP });
  await advance(meta, DAY);
  await refresh(meta, ACCOUNT.token);
  assert.equal((await graphGet(meta, 'me')).status, 200);

  await meta.post('/app', { rotateOnRefresh: true });
  await advance(meta, DAY);
  await refresh(meta, ACCOUNT.token);
  const res = await graphGet(meta, 'me');
  assert.equal(errorCode(res), 190, 'an in-flight send with the old token gets 190 (PRD C-04)');
});

test('a refreshed token starts a new 24-hour minimum and a new 60 days', async (t) => {
  const meta = await startMeta(t, { app: APP });
  await advance(meta, 30 * DAY);
  const { body } = await refresh(meta, ACCOUNT.token);
  assert.equal(errorCode(await refresh(meta, body.access_token)), ERRORS.TOKEN_TOO_YOUNG.code);
  await advance(meta, 59 * DAY);
  assert.equal((await graphGet(meta, 'me', { token: body.access_token })).status, 200, 'past the old token\'s expiry');
  assert.equal(errorSubcode(await graphGet(meta, 'me')), ERRORS.TOKEN_EXPIRED.subcode);
});

test('an expired, revoked, short or unknown token cannot be refreshed', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const { access_token: short } = await shortToken(meta);
  assert.equal(errorCode(await refresh(meta, short)), ERRORS.TOKEN_INVALID.code);
  assert.equal(errorCode(await refresh(meta, 'unknown')), ERRORS.TOKEN_INVALID.code);
  assert.equal(errorCode(await refresh(meta, ACCOUNT.token, { grant_type: 'other' })), ERRORS.BAD_GRANT.code);

  await advance(meta, 60 * DAY);
  assert.equal(errorSubcode(await refresh(meta, ACCOUNT.token)), ERRORS.TOKEN_EXPIRED.subcode);

  await meta.post('/accounts', { igUserId: '555', token: 'revoked-token' });
  await meta.post('/tokens/revoke', { token: 'revoked-token' });
  await advance(meta, DAY);
  assert.equal(errorSubcode(await refresh(meta, 'revoked-token')), ERRORS.TOKEN_REVOKED.subcode);
});

test('refresh needs instagram_business_basic', async (t) => {
  const meta = await startMeta(t, { app: APP });
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'no-basic', scopes: [SCOPES.messages] });
  await advance(meta, DAY);
  assert.equal(errorCode(await refresh(meta, 'no-basic')), ERRORS.PERMISSION.code);
});

test('a missing, unknown, expired or revoked token each get their own error', async (t) => {
  const meta = await startMeta(t, { app: APP });
  assert.equal(errorCode(await request(`${meta.url}/v23.0/me`)), ERRORS.TOKEN_MISSING.code);
  assert.equal(errorCode(await graphGet(meta, 'me', { token: 'unknown' })), ERRORS.TOKEN_INVALID.code);
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'to-expire' });
  await meta.post('/tokens/expire', { token: 'to-expire' });
  const expired = await graphGet(meta, 'me', { token: 'to-expire' });
  assert.deepEqual([expired.status, errorCode(expired), errorSubcode(expired), expired.body.error.type], [400, 190, 463, 'OAuthException']);
  assert.ok(expired.body.error.fbtrace_id);
  await meta.post('/tokens/revoke', { igUserId: ACCOUNT.igUserId });
  assert.equal(errorSubcode(await graphGet(meta, 'me')), ERRORS.TOKEN_REVOKED.subcode);
});

test('a token works from the Authorization header or the access_token parameter', async (t) => {
  const meta = await startMeta(t, { app: APP });
  assert.equal((await request(`${meta.url}/v23.0/me?access_token=${ACCOUNT.token}`)).status, 200);
  assert.equal((await request(`${meta.url}/v23.0/me`, { headers: { authorization: `Bearer ${ACCOUNT.token}` } })).status, 200);
  assert.equal((await request(`${meta.url}/me`, { headers: { authorization: `Bearer ${ACCOUNT.token}` } })).status, 200, 'unversioned paths work too');
});

test('tokens can be seeded with a chosen age for edge tests', async (t) => {
  const meta = await startMeta(t, { app: APP });
  const now = (await meta.get('/clock')).now;
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'old', issuedAt: now - DAY });
  assert.equal((await refresh(meta, 'old')).status, 200);
  await assert.rejects(() => meta.post('/tokens/expire', { token: 'none' }), /No such token/);
  await assert.rejects(() => meta.post('/tokens/revoke', { token: 'none' }), /No such token/);
  await assert.rejects(() => meta.post('/tokens', { igUserId: 'nobody' }), /No account/);
});

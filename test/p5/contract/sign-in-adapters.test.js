// Google sign-in for sellers and Sign in with Apple, against their simulators: a token is believed only when its
// signature, issuer, audience, expiry and nonce all hold, and nothing is fetched from anywhere but the simulator.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppleAdapters, createAppleSignIn } from '../../../src/adapters/apple/index.js';
import { GoogleSignInError, createGoogleAdapters, createGoogleSellerSignIn } from '../../../src/adapters/google/index.js';
import { IdTokenError } from '../../../src/adapters/oidc.js';
import { createApple } from '../../../tools/sim/apple/index.mjs';
import { createGoogle } from '../../../tools/sim/google/index.mjs';
import { TOKEN_FAULTS } from '../../../tools/sim/oidc.mjs';

const CLIENT = 'sim-seller-google-client';
const SECRET = 'sim-seller-google-secret';
const AUDIENCE = 'sim.apple.owner-app';
const REDIRECT = 'http://127.0.0.1:1/auth/google/callback';

let google;
let apple;
const googleConfig = (extra = {}) => ({ sellerGoogleClientId: CLIENT, sellerGoogleClientSecret: SECRET, googleKeysBaseUrl: google.url, idTokenKeyRefetchMs: 0, ...extra });
const appleConfig = (extra = {}) => ({ appleSigninAudiences: [AUDIENCE], appleKeysBaseUrl: apple.url, idTokenKeyRefetchMs: 0, ...extra });
const refusedAs = (kind) => (err) => err instanceof IdTokenError && err.kind === kind;
const googleToken = async (body = {}) => (await google.post('/id-token', body)).idToken;
const appleToken = async (body = {}) => (await apple.post('/identity-token', body)).identityToken;

/** What each fault must be refused as. Every one of them is refused: none signs anybody in. */
const REFUSALS = {
  expired: 'expired',
  wrong_audience: 'wrong_audience',
  wrong_issuer: 'wrong_issuer',
  wrong_nonce: 'wrong_nonce',
  wrong_signature: 'bad_signature',
  unknown_key: 'unknown_key',
  alg_none: 'malformed',
  hs256: 'unsupported_alg',
  junk: 'malformed',
};

before(async () => {
  google = createGoogle();
  apple = createApple();
  await Promise.all([google.start(), apple.start()]);
});
after(() => Promise.all([google?.close(), apple?.close()]));

test('Google: the code flow ends in a checked ID token for the seller client', async () => {
  const signIn = createGoogleSellerSignIn(googleConfig());
  assert.equal(signIn.configured, true);
  await google.post('/next-user', { sub: 'g-owner-1', email: 'asha@example.com', name: 'Asha Rao' });
  const url = new URL(signIn.authorizeUrl({ redirectUri: REDIRECT, state: 'state-1', nonce: 'nonce-1' }));
  assert.equal(url.origin, google.url);
  assert.deepEqual([url.searchParams.get('client_id'), url.searchParams.get('scope'), url.searchParams.get('response_type')], [CLIENT, 'openid email profile', 'code']);
  const consent = await fetch(url, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  assert.equal(back.searchParams.get('state'), 'state-1');
  const who = await signIn.signIn({ code: back.searchParams.get('code'), redirectUri: REDIRECT, nonce: 'nonce-1' });
  assert.deepEqual(who, { sub: 'g-owner-1', email: 'asha@example.com', emailVerified: true, name: 'Asha Rao' });

  // A code works once, and only with the nonce this sign-in started with.
  await assert.rejects(() => signIn.signIn({ code: back.searchParams.get('code'), redirectUri: REDIRECT, nonce: 'nonce-1' }), (err) => err instanceof GoogleSignInError && err.kind === 'rejected');
  const again = new URL((await fetch(signIn.authorizeUrl({ redirectUri: REDIRECT, state: 's', nonce: 'nonce-2' }), { redirect: 'manual' })).headers.get('location'));
  await assert.rejects(() => signIn.signIn({ code: again.searchParams.get('code'), redirectUri: REDIRECT, nonce: 'nonce-other' }), refusedAs('wrong_nonce'));

  // A fault in the token the exchange returns is caught here, not trusted because it came over the exchange.
  for (const fault of ['wrong_signature', 'wrong_audience', 'expired']) {
    const next = new URL((await fetch(signIn.authorizeUrl({ redirectUri: REDIRECT, state: 's', nonce: 'n' }), { redirect: 'manual' })).headers.get('location'));
    await google.post('/next-token-fault', { fault });
    await assert.rejects(() => signIn.signIn({ code: next.searchParams.get('code'), redirectUri: REDIRECT, nonce: 'n' }), refusedAs(REFUSALS[fault]), fault);
  }
});

test('Google: every faulty token is refused, and an unverified email is not passed on', async () => {
  const signIn = createGoogleSellerSignIn(googleConfig());
  assert.equal((await signIn.verify(await googleToken({ sub: 'g-2', nonce: 'n' }), { nonce: 'n' })).sub, 'g-2');
  assert.deepEqual(Object.keys(REFUSALS).sort(), [...TOKEN_FAULTS].sort(), 'every fault the simulator can make is covered');
  for (const fault of TOKEN_FAULTS) {
    await assert.rejects(async () => signIn.verify(await googleToken({ nonce: 'n', fault }), { nonce: 'n' }), refusedAs(REFUSALS[fault]), fault);
  }
  // A token minted for the shoppers' client is for another audience.
  await assert.rejects(async () => signIn.verify(await googleToken({ aud: 'sim-google-client' })), refusedAs('wrong_audience'));
  await assert.rejects(async () => signIn.verify(await googleToken({ aud: [CLIENT, 'someone-else'].join(',') })), refusedAs('wrong_audience'));
  // A token changed after signing.
  const token = await googleToken({ sub: 'g-3' });
  const [header, , signature] = token.split('.');
  const forged = `${header}.${Buffer.from(JSON.stringify({ iss: google.url, aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 600, sub: 'someone-else' })).toString('base64url')}.${signature}`;
  await assert.rejects(() => signIn.verify(forged), refusedAs('bad_signature'));
  for (const junk of ['', undefined, 'a.b', 'a.b.c.d', `${'x'.repeat(9000)}.y.z`, 42]) await assert.rejects(() => signIn.verify(junk), refusedAs('malformed'), String(junk).slice(0, 12));
  const unverified = await signIn.verify(await googleToken({ sub: 'g-4', email: 'typed@example.com', emailVerified: false }));
  assert.deepEqual([unverified.email, unverified.emailVerified], ['', false]);
});

test('Google: keys rotate, time out and come back as junk without ever passing a bad token', async () => {
  const signIn = createGoogleSellerSignIn(googleConfig({ providerTimeoutMs: 300 }));
  const before = await googleToken({ sub: 'g-5' });
  assert.equal((await signIn.verify(before)).sub, 'g-5');
  // Rotation: a token signed with the new key is accepted once the keys are fetched again; the old key's tokens are not.
  await google.post('/keys/rotate', {});
  assert.equal((await signIn.verify(await googleToken({ sub: 'g-6' }))).sub, 'g-6');
  await assert.rejects(() => signIn.verify(before), refusedAs('unknown_key'));
  await google.post('/keys/rotate', { keepOld: true });
  const during = await googleToken({ sub: 'g-7' });
  assert.equal((await signIn.verify(during)).sub, 'g-7');

  // With no keys cached and Google not answering, nothing is accepted and the failure says "try again".
  for (const fault of [{ kind: 'timeout', delayMs: 800 }, { kind: 'server_error' }, { kind: 'malformed', mode: 'garbage' }, { kind: 'malformed', mode: 'wrong_shape' }]) {
    const fresh = createGoogleSellerSignIn(googleConfig({ providerTimeoutMs: 300 }));
    await google.fault({ ...fault, match: { path: '/oauth2/v3/certs' } });
    await assert.rejects(() => fresh.verify(during), (err) => err instanceof IdTokenError && err.kind === 'keys_unavailable' && err.retryable === true, JSON.stringify(fault));
    assert.equal((await fresh.verify(during)).sub, 'g-7', 'and it works again when Google does');
  }
  // The code exchange timing out is a failure to try again, never a sign-in.
  await google.fault({ kind: 'timeout', delayMs: 800, match: { path: '/token' } });
  await assert.rejects(() => signIn.exchange({ code: 'any', redirectUri: REDIRECT }), (err) => err instanceof GoogleSignInError && err.kind === 'timeout' && err.retryable);
  await google.fault({ kind: 'malformed', mode: 'garbage', match: { path: '/token' } });
  await assert.rejects(() => signIn.exchange({ code: 'any', redirectUri: REDIRECT }), (err) => err instanceof GoogleSignInError);
});

test('Google: unset is off, a simulator is refused in production, and no other host is ever used', async () => {
  const off = createGoogleSellerSignIn({});
  assert.equal(off.configured, false);
  await assert.rejects(() => off.verify('a.b.c'), (err) => err instanceof GoogleSignInError && err.kind === 'not_configured');
  await assert.rejects(() => off.exchange({ code: 'c', redirectUri: REDIRECT }), (err) => err.kind === 'not_configured');
  assert.throws(() => createGoogleSellerSignIn(googleConfig(), { env: { NODE_ENV: 'production' } }), { code: 'ESIMREFUSED' });
  assert.throws(() => createGoogleSellerSignIn(googleConfig({ googleKeysBaseUrl: 'https://keys.evil.example' }), { env: {} }), /only point at the Google simulator/);
  assert.doesNotThrow(() => createGoogleSellerSignIn({ sellerGoogleClientId: 'x', sellerGoogleClientSecret: 'y' }, { env: { NODE_ENV: 'production' } }));
  assert.equal(new URL(createGoogleSellerSignIn({ sellerGoogleClientId: 'x', sellerGoogleClientSecret: 'y' }).authorizeUrl({ redirectUri: 'https://app.example/cb', state: 's', nonce: 'n' })).origin, 'https://accounts.google.com');
  const adapters = createGoogleAdapters(googleConfig());
  assert.deepEqual(Object.keys(adapters).sort(), ['ga4', 'signIn']);
});

test('Apple: a good identity token says who signed in, and every faulty one is refused', async () => {
  const signIn = createAppleSignIn(appleConfig());
  assert.equal(signIn.configured, true);
  const who = await signIn.verify(await appleToken({ sub: 'apple-1', email: 'relay@privaterelay.example', privateEmail: true, nonce: 'raw-nonce' }), { nonce: 'raw-nonce' });
  assert.deepEqual(who, { sub: 'apple-1', email: 'relay@privaterelay.example', emailVerified: true, privateEmail: true });
  assert.deepEqual(await signIn.verify(await appleToken({ sub: 'apple-2', nonce: 'n' }), { nonce: 'n' }), { sub: 'apple-2', email: '', emailVerified: false, privateEmail: false });

  for (const fault of TOKEN_FAULTS) {
    await assert.rejects(async () => signIn.verify(await appleToken({ nonce: 'n', fault }), { nonce: 'n' }), refusedAs(REFUSALS[fault]), fault);
  }
  // The nonce is required, and it is the raw value: the token carries its hash.
  const token = await appleToken({ sub: 'apple-3', nonce: 'raw' });
  await assert.rejects(() => signIn.verify(token), refusedAs('wrong_nonce'));
  await assert.rejects(() => signIn.verify(token, { nonce: 'another' }), refusedAs('wrong_nonce'));
  await assert.rejects(async () => signIn.verify(await appleToken({ sub: 'apple-3' }), { nonce: 'raw' }), refusedAs('wrong_nonce'), 'a token with no nonce');
  // Another app's token, even one Apple really signed.
  await assert.rejects(async () => signIn.verify(await appleToken({ aud: 'another.app', nonce: 'n' }), { nonce: 'n' }), refusedAs('wrong_audience'));
  const two = createAppleSignIn(appleConfig({ appleSigninAudiences: ['web.services.id', AUDIENCE] }));
  assert.equal((await two.verify(await appleToken({ sub: 'apple-4', aud: 'web.services.id', nonce: 'n' }), { nonce: 'n' })).sub, 'apple-4');
  // A Google token is not an Apple token.
  await assert.rejects(async () => signIn.verify(await googleToken({ aud: AUDIENCE, nonce: 'n' }), { nonce: 'n' }), (err) => err instanceof IdTokenError);
});

test('Apple: keys rotate and fail safely; unset is off; a simulator is refused in production', async () => {
  const signIn = createAppleSignIn(appleConfig({ providerTimeoutMs: 300 }));
  const old = await appleToken({ sub: 'apple-5', nonce: 'n' });
  assert.equal((await signIn.verify(old, { nonce: 'n' })).sub, 'apple-5');
  await apple.post('/keys/rotate', {});
  assert.equal((await signIn.verify(await appleToken({ sub: 'apple-6', nonce: 'n' }), { nonce: 'n' })).sub, 'apple-6');
  await assert.rejects(() => signIn.verify(old, { nonce: 'n' }), refusedAs('unknown_key'));

  const current = await appleToken({ sub: 'apple-7', nonce: 'n' });
  for (const fault of [{ kind: 'timeout', delayMs: 800 }, { kind: 'server_error' }, { kind: 'malformed', mode: 'garbage' }]) {
    const fresh = createAppleSignIn(appleConfig({ providerTimeoutMs: 300 }));
    await apple.fault({ ...fault, match: { path: '/auth/keys' } });
    await assert.rejects(() => fresh.verify(current, { nonce: 'n' }), refusedAs('keys_unavailable'), JSON.stringify(fault));
    assert.equal((await fresh.verify(current, { nonce: 'n' })).sub, 'apple-7');
  }

  const off = createAppleSignIn({ appleKeysBaseUrl: apple.url });
  assert.equal(off.configured, false);
  await assert.rejects(() => off.verify(current, { nonce: 'n' }), refusedAs('wrong_audience'), 'with no audience set, nothing is accepted');
  assert.throws(() => createAppleSignIn(appleConfig(), { env: { NODE_ENV: 'production' } }), { code: 'ESIMREFUSED' });
  assert.throws(() => createAppleSignIn(appleConfig({ appleKeysBaseUrl: 'https://keys.evil.example' }), { env: {} }), /only point at the Apple simulator/);
  assert.doesNotThrow(() => createAppleSignIn({ appleSigninAudiences: [AUDIENCE] }, { env: { NODE_ENV: 'production' } }));
  assert.deepEqual(Object.keys(createAppleAdapters(appleConfig())), ['signIn']);
});

test('the shoppers\' Google sign-in still gets its own tokens from the same simulator', async () => {
  const res = await fetch(`${google.url}/o/oauth2/v2/auth?client_id=sim-google-client&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&nonce=n`, { redirect: 'manual' });
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  // A code is tied to the client it was issued to: the seller client cannot redeem a shopper's.
  const wrongClient = await fetch(`${google.url}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: CLIENT, client_secret: SECRET, code, redirect_uri: REDIRECT, grant_type: 'authorization_code' }) });
  assert.equal(wrongClient.status, 400);
  const tokens = await (await fetch(`${google.url}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'sim-google-client', client_secret: 'sim-google-secret', code, redirect_uri: REDIRECT, grant_type: 'authorization_code' }) })).json();
  assert.equal(JSON.parse(Buffer.from(tokens.id_token.split('.')[0], 'base64url')).alg, 'HS256');
  assert.equal((await fetch(`${google.url}/tokeninfo?id_token=${tokens.id_token}`)).status, 200);
  await assert.rejects(() => createGoogleSellerSignIn(googleConfig()).verify(tokens.id_token), refusedAs('unsupported_alg'), 'and a shopper token never signs a seller in');
});

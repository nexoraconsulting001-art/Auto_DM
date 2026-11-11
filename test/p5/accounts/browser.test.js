// Google in the system browser with PKCE, Sign in with Apple, and linking a second way in to the same person
// (PRD 5.11, 10.3, 10.6), against the Google and Apple simulators.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { newToken, pkceChallenge, tokenHash } from '../../../src/contracts/accounts.js';
import { createApple } from '../../../tools/sim/apple/index.mjs';
import { createGoogle } from '../../../tools/sim/google/index.mjs';
import { OWNER, accountsApp, call, codeSignIn, freshIp, random10, sellerCodeFor, testDevice } from './support.js';

let app;
let google;
let apple;
// The sign-in host is 127.0.0.1 here, so the callback address is one the Google simulator accepts.
const HOST = null;

before(async () => {
  google = createGoogle();
  apple = createApple({ audience: 'sim.apple.owner-app' });
  await google.start();
  await apple.start();
  app = await accountsApp({
    overrides: {
      platformAppHost: '127.0.0.1',
      sellerGoogleClientId: 'sim-seller-google-client',
      sellerGoogleClientSecret: 'sim-seller-google-secret',
      googleKeysBaseUrl: google.url,
      appleSigninAudiences: ['sim.apple.owner-app'],
      appleKeysBaseUrl: apple.url,
    },
  });
});
after(async () => {
  await app?.close();
  await google?.close();
  await apple?.close();
});

const cookieOf = (res, name) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
const reset = () => app.db.platform.query('DELETE FROM rate_limit_hits');

/** Runs the browser part: start, Google's page, the callback. Returns the callback's answer and its Location. */
async function browserSignIn({ target = 'app', purpose = 'signin', verifier = newToken(48), user, next } = {}) {
  if (user) await google.post('/next-user', user);
  const query = new URLSearchParams({ target, purpose, ...(target === 'app' || purpose === 'link' ? { challenge: pkceChallenge(verifier) } : {}), ...(next ? { next } : {}) });
  const startRes = await fetch(`${app.base}/auth/google/start?${query}`, { redirect: 'manual' });
  assert.equal(startRes.status, 303);
  const binding = cookieOf(startRes, 'bhava_gstate');
  assert.ok(binding, 'the state is tied to this browser');
  const consent = await fetch(startRes.headers.get('location'), { redirect: 'manual' });
  assert.equal(consent.status, 302);
  const callbackUrl = consent.headers.get('location');
  const callback = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: binding } });
  return { callback, location: callback.headers.get('location') ?? '', callbackUrl, binding, verifier };
}

const exchange = (code, verifier, extra = {}) => call(app, '/api/v1/auth/exchange', { method: 'POST', host: HOST, ip: freshIp(), body: { code, verifier, ...extra } });

test('F-109: a new creator taps Continue with Google in the app, is signed in with no password, and gets a creator account', async () => {
  const { location, verifier } = await browserSignIn({ user: { sub: 'g-new-creator', email: 'new.creator@example.com', name: 'Nisha Rao' } });
  const back = new URL(location);
  assert.equal(`${back.protocol}//${back.host}${back.pathname}`, 'bhavabusiness://auth/callback');
  const code = back.searchParams.get('code');
  assert.ok(code);
  const session = await exchange(code, verifier, { device: testDevice('Nisha phone') });
  assert.equal(session.status, 201);
  assert.equal(session.json.created, true);
  assert.equal(session.json.business.accountType, 'creator');
  assert.equal(session.json.business.plan, 'free');
  assert.equal(session.json.user.role, 'owner');
  assert.equal(session.json.user.phone, '', 'no number was proved');
  assert.ok(session.json.accessToken && session.json.refreshToken);
  // The same Google account signs in to the same account next time.
  const again = await browserSignIn({ user: { sub: 'g-new-creator', email: 'new.creator@example.com', name: 'Nisha Rao' } });
  const second = await exchange(new URL(again.location).searchParams.get('code'), again.verifier);
  assert.deepEqual([second.json.created, second.json.business.id], [false, session.json.business.id]);
});

test('a hand-off code is single use, bound to its PKCE verifier, and dead after 60 s', async () => {
  // A wrong verifier spends the code: whoever caught it on its way to the app gets nothing, and neither does a retry.
  const caught = await browserSignIn({ user: { sub: 'g-handoff-1', email: 'h1@example.com', name: 'H One' } });
  const code = new URL(caught.location).searchParams.get('code');
  assert.equal((await exchange(code, newToken(48))).status, 401);
  assert.equal((await exchange(code, caught.verifier)).status, 401);

  const used = await browserSignIn({ user: { sub: 'g-handoff-1', email: 'h1@example.com', name: 'H One' } });
  const usedCode = new URL(used.location).searchParams.get('code');
  assert.equal((await exchange(usedCode, used.verifier)).status, 201);
  assert.equal((await exchange(usedCode, used.verifier)).status, 401, 'single use');

  const late = await browserSignIn({ user: { sub: 'g-handoff-1', email: 'h1@example.com', name: 'H One' } });
  const lateCode = new URL(late.location).searchParams.get('code');
  await app.db.platform.query(`UPDATE auth_handoffs SET expires_at = now() - interval '1 second' WHERE code_hash = $1`, [tokenHash(lateCode)]);
  assert.equal((await exchange(lateCode, late.verifier)).status, 401, 'dead after 60 seconds');
  const [row] = await app.db.platform.query(`SELECT expires_at - created_at <= interval '60 seconds' AS short FROM auth_handoffs ORDER BY id DESC LIMIT 1`);
  assert.equal(row.short, true);
  const stored = JSON.stringify(await app.db.platform.query('SELECT * FROM auth_handoffs'));
  assert.equal(stored.includes(code) || stored.includes(usedCode), false, 'only hashes are kept');
});

test('the browser state is signed, tied to the browser and spent by its first callback', async () => {
  const first = await browserSignIn({ user: { sub: 'g-state', email: 's@example.com', name: 'State' } });
  assert.match(first.location, /^bhavabusiness:\/\/auth\/callback\?code=/);
  // The same callback again: the state is spent.
  const replay = await fetch(first.callbackUrl, { redirect: 'manual', headers: { cookie: first.binding } });
  assert.match(replay.headers.get('location'), /error=expired/);
  // Another browser (no binding cookie) gets nothing from a state it did not start.
  await google.post('/next-user', { sub: 'g-state', email: 's@example.com', name: 'State' });
  const verifier = newToken(48);
  const startRes = await fetch(`${app.base}/auth/google/start?target=app&challenge=${pkceChallenge(verifier)}`, { redirect: 'manual' });
  const consent = await fetch(startRes.headers.get('location'), { redirect: 'manual' });
  const stolen = await fetch(consent.headers.get('location'), { redirect: 'manual', headers: { cookie: 'bhava_gstate=someone-else' } });
  assert.match(stolen.headers.get('location'), /error=expired/);
  // Cancelling on Google's page goes back with "denied".
  const denied = await browserSignIn({ user: { sub: 'g-deny', deny: true } });
  assert.match(denied.location, /^bhavabusiness:\/\/auth\/callback\?error=denied$/);
  // The app must send a challenge.
  assert.equal((await fetch(`${app.base}/auth/google/start?target=app`, { redirect: 'manual' })).status, 400);
  // The routes exist on the sign-in host only.
  assert.notEqual((await fetch(`${app.base}/auth/google/start?target=web`, { redirect: 'manual', headers: { 'x-forwarded-host': 'shop.bhava.test' } })).status, 303);
});

test('target web opens the console\'s cookie session on the sign-in host and goes to the console', async () => {
  const { callback, location } = await browserSignIn({ target: 'web', user: { sub: 'g-web', email: 'web@example.com', name: 'Web Person' }, next: '/admin/orders' });
  assert.equal(callback.status, 303);
  assert.equal(location, '/admin/orders');
  const sid = cookieOf(callback, 'sid');
  assert.ok(sid);
  const me = await call(app, '/api/v1/auth/me', { host: HOST, headers: { cookie: sid } });
  assert.equal(me.status, 200);
  assert.ok(me.json.csrf);
  assert.equal(me.json.business.accountType, 'creator');
});

test('Sign in with Apple: a checked identity token signs in, its nonce opens one sign-in, and a bad token is refused', async () => {
  const nonce = newToken(24);
  const { identityToken } = await apple.post('/identity-token', { sub: 'apple-person-1', email: 'a1@privaterelay.appleid.com', privateEmail: true, nonce });
  const session = await call(app, '/api/v1/auth/apple', { method: 'POST', host: HOST, ip: freshIp(), body: { identityToken, nonce, name: 'Apple Person', device: { ...testDevice('iPhone 17'), platform: 'ios' } } });
  assert.equal(session.status, 201);
  assert.equal(session.json.created, true);
  assert.equal(session.json.user.name, 'Apple Person');
  const replay = await call(app, '/api/v1/auth/apple', { method: 'POST', host: HOST, ip: freshIp(), body: { identityToken, nonce } });
  assert.equal(replay.status, 401, 'a token and nonce are good for one sign-in');
  for (const fault of ['expired', 'wrong_audience', 'wrong_nonce', 'wrong_signature', 'alg_none']) {
    const raw = newToken(24);
    const bad = await apple.post('/identity-token', { sub: 'apple-person-1', nonce: raw, fault });
    const res = await call(app, '/api/v1/auth/apple', { method: 'POST', host: HOST, ip: freshIp(), body: { identityToken: bad.identityToken, nonce: raw } });
    assert.deepEqual([res.status, res.json.code], [401, 'unauthorized'], fault);
  }
  const ios = await call(app, '/api/v1/app/requirements?platform=ios', { host: HOST });
  assert.equal(ios.json.signIn.apple, true, 'offered on iOS');
});

test('linking a phone to a Google account: either then signs in to the same account', async () => {
  await reset();
  const { location, verifier } = await browserSignIn({ user: { sub: 'g-linker', email: 'linker@example.com', name: 'Lina' } });
  const session = await exchange(new URL(location).searchParams.get('code'), verifier, { device: testDevice('Lina phone') });
  const headers = { authorization: `Bearer ${session.json.accessToken}` };
  const phone = random10();
  const asked = await call(app, '/api/v1/auth/identities', { method: 'POST', host: HOST, headers, body: { kind: 'phone', phone } });
  assert.equal(asked.status, 200);
  assert.equal(asked.json.pending, true);
  const code = await sellerCodeFor(app.whatsapp, phone);
  assert.equal((await call(app, '/api/v1/auth/identities', { method: 'POST', host: HOST, headers, body: { kind: 'phone', phone, code: '000000' === code ? '111111' : '000000' } })).status, 400);
  const linked = await call(app, '/api/v1/auth/identities', { method: 'POST', host: HOST, headers, body: { kind: 'phone', phone, code } });
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.json.identities.map((i) => i.kind).sort(), ['google', 'phone']);
  assert.equal(JSON.stringify(linked.json).includes(phone), false, 'labels are masked');

  await reset();
  const byPhone = await codeSignIn(app, { phone, host: HOST });
  assert.deepEqual([byPhone.user.id, byPhone.business.id], [session.json.user.id, session.json.business.id], 'the same account');
});

test('an identity that belongs to someone else is refused with conflict, after it was proved, and nothing is merged', async () => {
  await reset();
  const owner = await codeSignIn(app, { phone: OWNER.phone, host: HOST, device: testDevice() });
  // Link OWNER's number from another person's session: the code goes out, the link is refused.
  const { location, verifier } = await browserSignIn({ user: { sub: 'g-thief', email: 'thief@example.com', name: 'Thief' } });
  const thief = await exchange(new URL(location).searchParams.get('code'), verifier);
  const headers = { authorization: `Bearer ${thief.json.accessToken}` };
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  const asked = await call(app, '/api/v1/auth/identities', { method: 'POST', host: HOST, headers, body: { kind: 'phone', phone: OWNER.phone } });
  assert.deepEqual([asked.status, asked.json.pending], [200, true], 'nothing says whether the number has an account');
  const code = await sellerCodeFor(app.whatsapp, OWNER.phone);
  const res = await call(app, '/api/v1/auth/identities', { method: 'POST', host: HOST, headers, body: { kind: 'phone', phone: OWNER.phone, code } });
  assert.deepEqual([res.status, res.json.code], [409, 'conflict']);
  assert.equal((await call(app, '/api/v1/auth/businesses', { host: HOST, headers })).json.businesses.some((b) => b.id === app.tenant.id), false, 'no business moved');

  // Linking the owner's Google account the browser way, from the owner's session.
  const ownerHeaders = owner.auth;
  const linkFlow = await browserSignIn({ purpose: 'link', user: { sub: 'g-owner-link', email: 'owner@example.com', name: 'Owner' } });
  const linkCode = new URL(linkFlow.location).searchParams.get('code');
  const google1 = await call(app, '/api/v1/auth/identities', { method: 'POST', host: HOST, headers: ownerHeaders, body: { kind: 'google', code: linkCode, verifier: linkFlow.verifier } });
  assert.equal(google1.status, 200, google1.text);
  assert.ok(google1.json.identities.some((i) => i.kind === 'google'));
  // The thief's Google account cannot be linked to the owner: it belongs to a person with an account.
  const thiefLink = await browserSignIn({ purpose: 'link', user: { sub: 'g-thief', email: 'thief@example.com', name: 'Thief' } });
  const conflict = await call(app, '/api/v1/auth/identities', { method: 'POST', host: HOST, headers: ownerHeaders, body: { kind: 'google', code: new URL(thiefLink.location).searchParams.get('code'), verifier: thiefLink.verifier } });
  assert.deepEqual([conflict.status, conflict.json.code], [409, 'conflict']);
  // Now the owner's Google account opens the owner's business.
  const viaGoogle = await browserSignIn({ user: { sub: 'g-owner-link', email: 'owner@example.com', name: 'Owner' } });
  const opened = await exchange(new URL(viaGoogle.location).searchParams.get('code'), viaGoogle.verifier);
  assert.equal(opened.json.business.id, app.tenant.id);
  // Linking needs a fresh re-auth.
  await app.db.platform.query('UPDATE sessions SET fresh_until = NULL WHERE id = $1', [tokenHash(owner.accessToken)]);
  assert.equal((await call(app, '/api/v1/auth/identities', { method: 'POST', host: HOST, headers: ownerHeaders, body: { kind: 'phone', phone: random10() } })).json.code, 'reauth_required');
});

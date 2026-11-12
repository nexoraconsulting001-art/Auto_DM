// Signing in to the shopper app another way (PRD 10.7, 10.13): Google in the system browser, handed back to the app with a
// single-use PKCE code, and Sign in with Apple on iOS for the brand's own bundle id.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { pkceChallenge } from '../../../src/contracts/accounts.js';
import { AppSession } from '../../../src/contracts/store-routes.js';
import { createApple } from '../../../tools/sim/apple/index.mjs';
import { browser } from '../../p4/shoppers/support.js';
import { appWorld, assertBrandOnly, guestApp, json } from './support.js';

const verifierPair = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
};

/** The system browser's round trip through Google. Returns the address the browser was sent back to. */
async function googleRoundTrip(w, b, challenge) {
  const start = await b.request(`/auth/app/google?challenge=${challenge}`);
  assert.equal(start.status, 302);
  const toGoogle = new URL(start.headers.get('location'));
  assert.equal(toGoogle.origin, w.google.url);
  assert.equal(toGoogle.searchParams.get('redirect_uri'), `${w.app.base}/auth/app/google/callback`);
  const back = await fetch(toGoogle, { redirect: 'manual' });
  const callback = new URL(back.headers.get('location'));
  const done = await b.request(`${callback.pathname}${callback.search}`);
  assert.equal(done.status, 303);
  return { location: done.headers.get('location'), callback };
}

test('Google in the system browser hands a single-use code back to the app, good only with the app’s own verifier', async () => {
  const w = await appWorld();
  try {
    const scheme = `shop${w.app.tenant.id}`;
    await w.google.post('/next-user', { sub: 'g-app-1', email: 'asha@example.com', email_verified: true, name: 'Asha Kulkarni' });
    const { verifier, challenge } = verifierPair();
    const b = browser(w.app);
    const { location, callback } = await googleRoundTrip(w, b, challenge);
    assert.match(location, new RegExp(`^${scheme}://auth\\?code=[A-Za-z0-9_-]{40,}$`));
    assertBrandOnly(location, 'the way back');
    const code = new URL(location).searchParams.get('code');
    const [stored] = await w.app.db.platform.query('SELECT code_hash, challenge, used_at FROM shopper_app_handoffs');
    assert.notEqual(stored.code_hash, code, 'only the hash is kept');
    assert.equal(stored.challenge, challenge);

    const a = await guestApp(w);
    const wrong = await a.start({ grant: 'handoff', code, codeVerifier: verifierPair().verifier });
    assert.equal(wrong.status, 401, 'another verifier');
    const late = await a.start({ grant: 'handoff', code, codeVerifier: verifier });
    assert.equal(late.status, 401, 'a code is spent by its first try');

    // A fresh round trip, traded at once with the right verifier.
    const second = verifierPair();
    await w.google.post('/next-user', { sub: 'g-app-1', email: 'asha@example.com', email_verified: true, name: 'Asha Kulkarni' });
    const again = await googleRoundTrip(w, b, second.challenge);
    const fresh = new URL(again.location).searchParams.get('code');
    const signed = await a.start({ grant: 'handoff', code: fresh, codeVerifier: second.verifier });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    AppSession.parse(signed.body);
    assert.equal(signed.body.shopper.hasGoogle, true);
    assert.equal(signed.body.shopper.name, 'Asha Kulkarni');
    const [session] = await w.app.db.platform.query(`SELECT method FROM shopper_app_sessions WHERE revoked_at IS NULL AND shopper_id IS NOT NULL`);
    assert.equal(session.method, 'google');
    assert.equal((await a.start({ grant: 'handoff', code: fresh, codeVerifier: second.verifier })).status, 401, 'never twice');

    // A browser that did not start the sign-in gets nothing from the callback; nor does a start without a challenge.
    const stranger = browser(w.app);
    const refused = await stranger.request(`${callback.pathname}${callback.search}`);
    assert.equal(refused.status, 303);
    assert.equal(refused.headers.get('location'), `${scheme}://auth?error=expired`);
    assert.equal((await b.request('/auth/app/google')).status, 404);
    assert.equal((await b.request('/auth/app/google?challenge=short')).status, 404);
  } finally {
    await w.close();
  }
});

test('Google in the system browser is not there for a business without an app', async () => {
  const w = await appWorld();
  try {
    const plain = await w.addStore('kesar', 'Kesar Co', { app: false });
    const b = browser(w.app, { host: plain.host });
    const res = await b.request(`/auth/app/google?challenge=${verifierPair().challenge}`);
    assert.equal(res.status, 404);
    assertBrandOnly(await res.text());
  } finally {
    await w.close();
  }
});

test('Sign in with Apple on iOS takes a token for this brand’s bundle id only', async () => {
  const apple = createApple({ audience: 'sim.apple.owner-app' });
  await apple.start();
  const w = await appWorld({ overrides: { appleKeysBaseUrl: apple.url } });
  try {
    const bundleId = `com.example.t${w.app.tenant.id}`;
    const ios = await guestApp(w, { platform: 'ios' });
    const nonce = crypto.randomBytes(16).toString('hex');
    const { identityToken } = await apple.post('/identity-token', { sub: 'apple-shopper-1', email: 'x1@privaterelay.appleid.com', emailVerified: true, privateEmail: true, nonce, aud: bundleId });
    const signed = await json(await ios.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken, nonce, name: 'Meera', device: ios.device } }));
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    AppSession.parse(signed.body);
    assert.equal(signed.body.shopper.hasApple, true);
    assert.equal(signed.body.shopper.name, 'Meera');
    assertBrandOnly(signed.body);
    const [row] = await w.app.db.platform.query('SELECT apple_sub, tenant_id FROM shoppers WHERE apple_sub IS NOT NULL');
    assert.deepEqual(row, { apple_sub: 'apple-shopper-1', tenant_id: w.app.tenant.id });

    // The same person again is the same shopper.
    const nonce2 = crypto.randomBytes(16).toString('hex');
    const again = await apple.post('/identity-token', { sub: 'apple-shopper-1', nonce: nonce2, aud: bundleId });
    const second = await json(await ios.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken: again.identityToken, nonce: nonce2, device: ios.device } }));
    assert.equal(second.status, 201);
    assert.equal(second.body.shopper.id, signed.body.shopper.id);

    // A token for another app (the owner app, another brand), a replayed nonce, or a forged one: refused.
    const forOwnerApp = await apple.post('/identity-token', { sub: 'apple-shopper-1', nonce, aud: 'sim.apple.owner-app' });
    assert.equal((await ios.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken: forOwnerApp.identityToken, nonce, device: ios.device } })).status, 401);
    const forOtherBrand = await apple.post('/identity-token', { sub: 'apple-shopper-1', nonce, aud: 'com.example.other' });
    assert.equal((await ios.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken: forOtherBrand.identityToken, nonce, device: ios.device } })).status, 401);
    assert.equal((await ios.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken: again.identityToken, nonce: 'another-nonce', device: ios.device } })).status, 401);
    const forged = await apple.post('/identity-token', { sub: 'apple-shopper-1', nonce, aud: bundleId, fault: 'wrong_signature' });
    assert.equal((await ios.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken: forged.identityToken, nonce, device: ios.device } })).status, 401);

    // Android has no Apple sign-in, and the bootstrap says so.
    const android = await guestApp(w);
    assert.equal((await android.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken, nonce, device: android.device } })).status, 404);
    assert.equal((await json(await android.fetch('/api/store/app/bootstrap'))).body.signIn.apple, false);
    assert.equal((await json(await ios.fetch('/api/store/app/bootstrap'))).body.signIn.apple, true);
  } finally {
    await w.close();
    await apple.close();
  }
});

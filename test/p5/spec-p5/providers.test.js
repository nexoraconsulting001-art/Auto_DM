// PRD 5.11, 10.3 and 10.6: Google and Apple sign-in for sellers. A new creator taps "Continue with Google" and is signed
// in with no password, a Creator account on the Free plan made on first use; the app's browser sign-in comes back as a
// single-use hand-off code that is useless without its PKCE verifier; a token that is expired, for another audience,
// unsigned or signed with a key that is no longer published signs nobody in. F-109, P-69 (the server's half).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  AUTH_PATHS, HANDOFF_SECONDS, OWNER_APP_CALLBACK, SECOND, accounts, addSeller, captureLogs, newDevice, noCrash, ownerApp, randomIp,
  refusedWith, sessionOf, unique, useP5World,
} from './kit.js';

const world = useP5World();
const cookiesOf = (res) => [res.headers['set-cookie'] ?? []].flat().map((line) => line.split(';')[0]).filter((pair) => pair && !pair.endsWith('='));
const peopleCount = async () => (await world.sql('SELECT count(*)::int AS n FROM people'))[0].n;
const googleUser = (extra = {}) => ({ sub: `g-${unique()}`, email: `creator${unique()}@mail.example`, email_verified: true, name: 'Kavya Creator', ...extra });

/**
 * A browser sign-in with Google, as the system browser runs it: the start, Google's consent, and the callback. `fault`
 * makes the token Google's exchange answers with faulty. Answers the callback's response and the cookies it set.
 */
async function googleBrowser({ target = 'web', user = googleUser(), challenge, fault, next, keepState = true, ip = randomIp() } = {}) {
  await world.sellerGoogle.post('/next-user', user);
  if (fault) await world.sellerGoogle.post('/next-token-fault', { fault });
  const query = new URLSearchParams({ target, ...(challenge ? { challenge } : {}), ...(next ? { next } : {}) });
  const start = await world.app(`${AUTH_PATHS.googleStart}?${query}`, { ip });
  assert.ok([302, 303].includes(start.status), `The Google sign-in did not start with a redirect: ${start.status} ${start.text.slice(0, 200)}`);
  const to = new URL(start.headers.location);
  assert.equal(to.origin, world.sellerGoogle.url, `The browser was sent to ${to.origin}, not Google`);
  assert.equal(to.searchParams.get('client_id'), world.config.sellerGoogleClientId, 'The seller sign-in used another OAuth client');
  assert.ok(to.searchParams.get('state'), 'No state');
  const consent = await fetch(to, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  assert.equal(back.pathname, AUTH_PATHS.googleCallback);
  const stateCookie = cookiesOf(start).join('; ');
  const callback = await world.app(`${back.pathname}${back.search}`, { ip, headers: keepState && stateCookie ? { cookie: stateCookie } : {} });
  return { start, to, back, callback, user, stateCookie };
}

const pkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: accounts.pkceChallenge(verifier) };
};
/** The single-use code the callback hands the app on OWNER_APP_CALLBACK. */
function handoffCode(callback) {
  assert.ok([302, 303].includes(callback.status), `The callback did not redirect: ${callback.status} ${callback.text.slice(0, 200)}`);
  const location = String(callback.headers.location ?? '');
  assert.ok(location.startsWith(OWNER_APP_CALLBACK), `The callback went to ${location}, not the app`);
  const url = new URL(location.replace(/^bhavabusiness:\/\//, 'https://app.invalid/'));
  return { code: url.searchParams.get('code'), error: url.searchParams.get('error') };
}
const exchange = (code, verifier, extra = {}) => world.app('/api/v1/auth/exchange', { method: 'POST', body: { code, verifier, transport: 'bearer', device: newDevice(), ...extra } });

test('F-109: a new creator taps "Continue with Google" in the app and is signed in with no password, as a Free plan Creator', async (t) => {
  const logs = captureLogs(t);
  const { verifier, challenge } = pkce();
  const before = await peopleCount();
  const { callback, user } = await googleBrowser({ target: 'app', challenge });
  const { code, error } = handoffCode(callback);
  assert.equal(error, null, `The callback answered error=${error}`);
  assert.ok(code, 'No hand-off code');
  assert.ok(!String(callback.headers.location).includes(verifier), 'The verifier left the app');
  const res = await exchange(code, verifier);
  assert.equal(res.status, 201, `The exchange: ${res.status} ${res.text.slice(0, 300)}`);
  assert.equal(res.data.created, true, 'The first sign-in did not say it made the account');
  assert.equal(res.data.business.accountType, 'creator');
  assert.equal(res.data.business.plan, 'free');
  assert.equal(res.data.user.role, 'owner');
  assert.ok(res.data.accessToken && res.data.refreshToken);
  assert.equal(await peopleCount(), before + 1);
  const [identity] = await world.sql(`SELECT * FROM person_identities WHERE kind = 'google' AND subject = $1`, [user.sub]);
  assert.ok(identity?.verified_at, 'The Google identity was not kept as verified');
  const [tenant] = await world.sql('SELECT account_type, plan FROM tenants WHERE id = $1', [res.data.business.id]);
  assert.deepEqual([tenant.account_type, tenant.plan], ['creator', 'free']);
  assert.doesNotMatch(res.text, /password/i);
  assert.ok(!logs.text().includes(user.email), 'The Google email is in the logs');
  assert.ok(!logs.text().includes(code), 'The hand-off code is in the logs');

  // The same Google account again is the same person and the same business, not a second account.
  const second = pkce();
  const again = await exchange(handoffCode((await googleBrowser({ target: 'app', challenge: second.challenge, user })).callback).code, second.verifier);
  assert.equal(again.status, 201);
  assert.equal(again.data.created, false, 'A second sign-in made another account');
  assert.equal(again.data.business.id, res.data.business.id);
  assert.equal(await peopleCount(), before + 1);
});

test('F-109: "Continue with Google" on the web sets the console\'s session and goes to /admin', async () => {
  const { callback } = await googleBrowser({ target: 'web' });
  assert.ok([302, 303].includes(callback.status), `The web callback answered ${callback.status}`);
  const location = String(callback.headers.location);
  assert.ok(location === '/admin' || location.startsWith('/admin') || new URL(location, 'https://x.invalid').pathname.startsWith('/admin'), `The web sign-in went to ${location}`);
  const cookie = cookiesOf(callback).join('; ');
  assert.ok(cookie, 'No session cookie');
  const me = await world.app('/api/v1/auth/me', { headers: { cookie } });
  assert.equal(me.status, 200, `The console's session: ${me.status}`);
  assert.equal(me.data.business.accountType, 'creator');
  assert.ok(me.data.csrf, 'A cookie session has no CSRF token');
  // `next` stays on this site: anything else is refused before Google is asked.
  for (const next of ['//evil.example/x', 'https://evil.example/x', '/\\evil.example', 'javascript:alert(1)']) {
    const res = noCrash(await world.app(`${AUTH_PATHS.googleStart}?target=web&next=${encodeURIComponent(next)}`), `next=${next}`);
    assert.ok(res.status >= 400 && res.status < 500, `next=${next} answered ${res.status} ${String(res.headers.location ?? '').slice(0, 120)}`);
  }
});

test('F-109: a hand-off code works once, only with its verifier, and only for sixty seconds', async () => {
  // Replayed.
  const one = pkce();
  const first = handoffCode((await googleBrowser({ target: 'app', challenge: one.challenge })).callback).code;
  assert.equal((await exchange(first, one.verifier)).status, 201);
  refusedWith(await exchange(first, one.verifier), [400, 401], 'The same hand-off code a second time');

  // The wrong verifier, then the right one: the code is spent by the wrong try or still refuses the wrong one.
  const two = pkce();
  const code = handoffCode((await googleBrowser({ target: 'app', challenge: two.challenge })).callback).code;
  for (const verifier of [pkce().verifier, `${two.verifier.slice(0, -1)}x`, '', 'short', two.challenge]) {
    refusedWith(await exchange(code, verifier), [400, 401], `The hand-off code with verifier ${verifier.slice(0, 10)}`);
  }
  // Too late.
  const three = pkce();
  const late = handoffCode((await googleBrowser({ target: 'app', challenge: three.challenge })).callback).code;
  await world.shift((HANDOFF_SECONDS + 1) * SECOND, ['auth_handoffs']);
  refusedWith(await exchange(late, three.verifier), [400, 401], 'A hand-off code after sixty seconds');
  // Made up.
  for (const made of ['', 'x', crypto.randomBytes(32).toString('base64url'), '../../admin']) refusedWith(await exchange(made, three.verifier), [400, 401], `A made-up hand-off code ${made.slice(0, 8)}`);
  // Nothing in auth_handoffs is the code itself.
  assert.ok(!JSON.stringify(await world.sql('SELECT * FROM auth_handoffs')).includes(late), 'auth_handoffs holds the code');
});

test('F-109: the app\'s Google sign-in needs a PKCE challenge, and the state works once, in the browser that started it', async () => {
  const start = noCrash(await world.app(`${AUTH_PATHS.googleStart}?target=app`), 'Starting with no challenge');
  assert.ok(start.status >= 400 && start.status < 500, `A sign-in from the app with no challenge answered ${start.status}`);
  // The callback in a browser that did not start it.
  const { challenge } = pkce();
  const stranger = await googleBrowser({ target: 'app', challenge, keepState: false });
  assert.ok(stranger.callback.status < 500);
  const location = String(stranger.callback.headers.location ?? '');
  assert.ok(!/[?&]code=/.test(location) || /error=/.test(location), 'The callback handed out a code without its state cookie');
  // The state replayed.
  const mine = pkce();
  const ok = await googleBrowser({ target: 'app', challenge: mine.challenge });
  const replay = await world.app(`${ok.back.pathname}${ok.back.search}`, { headers: { cookie: ok.stateCookie } });
  assert.ok(!/[?&]code=/.test(String(replay.headers.location ?? '')) || /error=/.test(String(replay.headers.location ?? '')), 'A replayed callback handed out a second code');
  // A refusal at Google comes back as an error and never says whether an account exists.
  await world.sellerGoogle.post('/next-user', { ...googleUser(), deny: true });
  const denied = await world.app(`${AUTH_PATHS.googleStart}?target=app&challenge=${pkce().challenge}`);
  const consent = await fetch(new URL(denied.headers.location), { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  const answer = await world.app(`${back.pathname}${back.search}`, { headers: { cookie: cookiesOf(denied).join('; ') } });
  assert.match(String(answer.headers.location ?? ''), /error=(denied|failed)/, `Google's refusal came back as ${answer.headers.location}`);
});

test('F-109: a Google token that is expired, for another audience, unsigned or signed with an unknown key signs nobody in', async () => {
  for (const fault of ['expired', 'wrong_audience', 'wrong_issuer', 'wrong_nonce', 'wrong_signature', 'unknown_key', 'alg_none', 'hs256', 'junk']) {
    const before = await peopleCount();
    const { challenge } = pkce();
    const { callback } = await googleBrowser({ target: 'app', challenge, fault });
    const location = String(callback.headers.location ?? '');
    assert.ok(callback.status < 500, `${fault}: the callback failed with ${callback.status}`);
    assert.ok(!/[?&]code=/.test(location), `${fault}: a faulty token got a hand-off code`);
    assert.match(location, /error=/, `${fault}: no error came back to the app`);
    assert.equal(await peopleCount(), before, `${fault}: a person was made from a faulty token`);
  }
});

test('F-109: Google rotating its keys is followed; Google\'s keys not answering is a failure to try again, never a sign-in', async () => {
  await world.sellerGoogle.post('/keys/rotate', {});
  const fresh = pkce();
  const ok = handoffCode((await googleBrowser({ target: 'app', challenge: fresh.challenge })).callback);
  assert.ok(ok.code, `After Google rotated its keys the sign-in failed: ${ok.error}`);
  for (const fault of [{ kind: 'timeout', delayMs: 3000 }, { kind: 'server_error' }, { kind: 'malformed', mode: 'garbage' }]) {
    await world.sellerGoogle.post('/keys/rotate', {});
    await world.sellerGoogle.fault({ ...fault, times: 3, match: { path: '/oauth2/v3/certs' } });
    const { challenge } = pkce();
    const before = await peopleCount();
    const { callback } = await googleBrowser({ target: 'app', challenge });
    const location = String(callback.headers.location ?? '');
    assert.ok(callback.status < 500, `${fault.kind}: the callback failed with ${callback.status}`);
    assert.ok(!/[?&]code=/.test(location), `${fault.kind}: signed in without Google's keys`);
    assert.equal(await peopleCount(), before);
    await world.sellerGoogle.delete('/faults');
  }
});

test('F-109: Sign in with Apple makes a Free plan Creator on first use, and the nonce must match', async () => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const sub = `001${unique()}.apple`;
  const { identityToken } = await world.apple.post('/identity-token', { sub, nonce, email: `kavya${unique()}@privaterelay.example`, privateEmail: true });
  const res = await world.app('/api/v1/auth/apple', { method: 'POST', body: { identityToken, nonce, name: 'Kavya K', transport: 'bearer', device: newDevice('iPhone 16', 'ios') } });
  assert.equal(res.status, 201, `Sign in with Apple: ${res.status} ${res.text.slice(0, 300)}`);
  assert.equal(res.data.created, true);
  assert.equal(res.data.business.accountType, 'creator');
  assert.equal(res.data.business.plan, 'free');
  const again = await world.apple.post('/identity-token', { sub, nonce: 'n2' });
  const second = await world.app('/api/v1/auth/apple', { method: 'POST', body: { identityToken: again.identityToken, nonce: 'n2', transport: 'bearer', device: newDevice('iPhone 16', 'ios') } });
  assert.equal(second.status, 201);
  assert.equal(second.data.business.id, res.data.business.id, 'The same Apple account made a second business');
  assert.equal(second.data.created, false);
  // The nonce the app gave Apple the hash of, and no other.
  const other = await world.apple.post('/identity-token', { sub, nonce: 'n3' });
  refusedWith(await world.app('/api/v1/auth/apple', { method: 'POST', body: { identityToken: other.identityToken, nonce: 'n4', transport: 'bearer' } }), [400, 401], 'An Apple token with another nonce');
  refusedWith(await world.app('/api/v1/auth/apple', { method: 'POST', body: { identityToken: other.identityToken, nonce: '', transport: 'bearer' } }), [400, 401], 'An Apple token with no nonce');
  const hashed = crypto.createHash('sha256').update('n3').digest('hex');
  refusedWith(await world.app('/api/v1/auth/apple', { method: 'POST', body: { identityToken: other.identityToken, nonce: hashed, transport: 'bearer' } }), [400, 401], 'An Apple token with the hashed nonce sent as the raw one');
});

test('F-109: an Apple token that is expired, for another audience, unsigned or signed with a rotated key signs nobody in', async () => {
  for (const fault of ['expired', 'wrong_audience', 'wrong_issuer', 'wrong_nonce', 'wrong_signature', 'unknown_key', 'alg_none', 'hs256', 'junk']) {
    const before = await peopleCount();
    const { identityToken } = await world.apple.post('/identity-token', { nonce: 'n', fault });
    const res = noCrash(await world.app('/api/v1/auth/apple', { method: 'POST', body: { identityToken, nonce: 'n', transport: 'bearer' } }), `Apple ${fault}`);
    assert.ok([400, 401].includes(res.status), `Apple ${fault} answered ${res.status}`);
    assert.equal(res.data?.accessToken, undefined);
    assert.equal(await peopleCount(), before, `Apple ${fault} made a person`);
  }
  // Apple rotates its keys without notice: a token signed before is refused after; a new one works.
  const old = await world.apple.post('/identity-token', { nonce: 'n' });
  await world.apple.post('/keys/rotate', {});
  refusedWith(await world.app('/api/v1/auth/apple', { method: 'POST', body: { identityToken: old.identityToken, nonce: 'n', transport: 'bearer' } }), [400, 401], 'An Apple token signed with a key no longer published');
  const current = await world.apple.post('/identity-token', { nonce: 'n' });
  assert.equal((await world.app('/api/v1/auth/apple', { method: 'POST', body: { identityToken: current.identityToken, nonce: 'n', transport: 'bearer', device: newDevice('iPhone', 'ios') } })).status, 201);
  // Apple's keys not answering: not a sign-in, and not a fault.
  await world.apple.post('/keys/rotate', {});
  await world.apple.fault({ kind: 'timeout', delayMs: 3000, times: 3, match: { path: '/auth/keys' } });
  const waiting = await world.apple.post('/identity-token', { nonce: 'n' });
  const res = noCrash(await world.app('/api/v1/auth/apple', { method: 'POST', body: { identityToken: waiting.identityToken, nonce: 'n', transport: 'bearer' } }), 'Apple with its keys down');
  assert.notEqual(res.status, 201);
  await world.apple.delete('/faults');
});

test('P-69: a Free plan creator\'s session says creator, and the same sign-in routes and app serve them', async () => {
  const { verifier, challenge } = pkce();
  const res = await exchange(handoffCode((await googleBrowser({ target: 'app', challenge })).callback).code, verifier);
  assert.equal(res.status, 201);
  const s = sessionOf(world, res, { phone: null });
  const me = await s.me();
  assert.equal(me.status, 200);
  assert.deepEqual([me.data.business.accountType, me.data.business.plan, me.data.user.role], ['creator', 'free', 'owner']);
  const businesses = await s.send('GET', '/auth/businesses');
  assert.equal(businesses.data.businesses.length, 1);
  // The same app routes answer a creator: their own notifications, devices and requirements.
  for (const path of ['/notifications', '/auth/devices', '/notifications/prefs']) assert.equal((await s.send('GET', path)).status, 200, `A creator was refused ${path}`);
  // A seller signed in with a code is a seller in the same app.
  const seller = await ownerApp(world, await addSeller(world));
  assert.equal(seller.business.accountType, 'seller');
});

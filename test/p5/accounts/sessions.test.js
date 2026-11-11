// The owner app's sessions (PRD 10.2, 10.3): access tokens and rotating refresh tokens, reuse and races, devices,
// device unlock, fresh re-auth for sensitive routes, and the minimum app version.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenHash } from '../../../src/contracts/accounts.js';
import { OWNER, accountsApp, call, codeSignIn, freshIp, random10, sellerCodeFor, testDevice } from './support.js';

let app;
before(async () => {
  app = await accountsApp();
});
after(() => app?.close());

const refresh = (refreshToken, ip = freshIp()) => call(app, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken }, ip });
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const fresh = async () => {
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  await app.db.platform.query('DELETE FROM rate_limit_hits');
};

test('P-04: an expired access token gets 401; the refresh token gives a new pair, and the old refresh token is spent', async () => {
  await fresh();
  const session = await codeSignIn(app, { device: testDevice() });
  assert.equal((await call(app, '/api/v1/orders', { headers: session.auth })).status, 200);
  await app.db.platform.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [tokenHash(session.accessToken)]);
  const expired = await call(app, '/api/v1/orders', { headers: session.auth });
  assert.deepEqual([expired.status, expired.json.code], [401, 'unauthorized']);

  const renewed = await refresh(session.refreshToken);
  assert.equal(renewed.status, 201);
  assert.deepEqual(Object.keys(renewed.json).sort(), ['accessExpiresInSeconds', 'accessToken', 'refreshToken']);
  assert.notEqual(renewed.json.refreshToken, session.refreshToken, 'it rotates on every use');
  assert.equal((await call(app, '/api/v1/orders', { headers: bearer(renewed.json.accessToken) })).status, 200, 'the retry works');
  const me = await call(app, '/api/v1/auth/me', { headers: bearer(renewed.json.accessToken) });
  assert.equal(me.json.freshUntil, null, 'a plain refresh is not a re-auth');
  // Only hashes are stored.
  const stored = JSON.stringify(await app.db.platform.query('SELECT * FROM refresh_tokens'));
  assert.equal(stored.includes(session.refreshToken) || stored.includes(renewed.json.refreshToken), false);
});

test('P-05: reusing a rotated refresh token is a 401 and revokes every session in its family', async () => {
  await fresh();
  const session = await codeSignIn(app, { device: testDevice() });
  const first = await refresh(session.refreshToken);
  const second = await refresh(first.json.refreshToken);
  assert.equal(second.status, 201);
  const live = bearer(second.json.accessToken);
  assert.equal((await call(app, '/api/v1/orders', { headers: live })).status, 200);

  const replay = await refresh(session.refreshToken);
  assert.deepEqual([replay.status, replay.json.code], [401, 'unauthorized']);
  assert.equal((await call(app, '/api/v1/orders', { headers: live })).status, 401, 'the newest access token is dead too');
  assert.equal((await refresh(second.json.refreshToken)).status, 401, 'and so is the newest refresh token');
  const [family] = await app.db.platform.query('SELECT f.revoke_reason FROM token_families f JOIN refresh_tokens r ON r.family_id = f.id WHERE r.token_hash = $1', [tokenHash(session.refreshToken)]);
  assert.equal(family.revoke_reason, 'token_reuse');

  // Another sign-in's family is untouched.
  await fresh();
  const other = await codeSignIn(app, { device: testDevice() });
  assert.equal((await call(app, '/api/v1/orders', { headers: other.auth })).status, 200);
  assert.equal((await refresh('made-up-token')).status, 401);
});

test('P-05: two refreshes racing with one token leave nobody with a working session in that family', async () => {
  await fresh();
  const session = await codeSignIn(app, { device: testDevice() });
  const answers = await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken), refresh(session.refreshToken)]);
  const winners = answers.filter((a) => a.status === 201);
  assert.ok(winners.length <= 1, 'one token is spent once');
  assert.ok(answers.some((a) => a.status === 401), 'the others are refused');
  for (const winner of winners) {
    assert.equal((await call(app, '/api/v1/orders', { headers: bearer(winner.json.accessToken) })).status, 401, 'the winner\'s session ends with the family');
    assert.equal((await refresh(winner.json.refreshToken)).status, 401);
  }
  assert.equal((await call(app, '/api/v1/orders', { headers: session.auth })).status, 401, 'the first access token too');
});

test('a refresh in a family that support revoked is refused', async () => {
  await fresh();
  const session = await codeSignIn(app, { device: testDevice() });
  await app.db.platform.query(`UPDATE token_families SET revoked_at = now(), revoke_reason = 'support' WHERE id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`, [tokenHash(session.refreshToken)]);
  assert.equal((await refresh(session.refreshToken)).status, 401);
});

test('P-08: revoking "Pixel 8" in Settings > Devices signs that device out at once, and only that device', async () => {
  await fresh();
  const pixel = testDevice('Pixel 8');
  const phone = await codeSignIn(app, { device: pixel });
  await fresh();
  const tablet = await codeSignIn(app, { device: testDevice('Galaxy Tab') });
  await fresh();
  const web = await codeSignIn(app, { transport: 'cookie', device: { ...pixel } });

  const listed = await call(app, '/api/v1/auth/devices', { headers: tablet.auth });
  assert.equal(listed.status, 200);
  const names = listed.json.devices.map((d) => d.name);
  assert.ok(names.includes('Pixel 8') && names.includes('Galaxy Tab'));
  assert.equal(listed.json.devices.find((d) => d.name === 'Galaxy Tab').current, true);
  assert.equal(listed.json.devices.find((d) => d.name === 'Pixel 8').current, false);
  const target = listed.json.devices.find((d) => d.name === 'Pixel 8' && !d.current);
  const [own] = await app.db.platform.query('SELECT id FROM auth_devices WHERE device_id = $1', [pixel.id]);
  assert.equal(target.id, Number(own.id), 'the newest Pixel 8 is listed first');

  const revoked = await call(app, `/api/v1/auth/devices/${target.id}`, { method: 'DELETE', headers: tablet.auth });
  assert.equal(revoked.status, 204, 'revoking needs no re-auth');
  assert.equal((await call(app, '/api/v1/orders', { headers: phone.auth })).status, 401, 'Pixel 8 is signed out on its next call');
  assert.equal((await refresh(phone.refreshToken)).status, 401, 'and cannot refresh');
  assert.equal((await call(app, '/api/v1/auth/me', { headers: { cookie: web.cookie } })).status, 401, 'a console session on that device ends too');
  assert.equal((await call(app, '/api/v1/orders', { headers: tablet.auth })).status, 200, 'the tablet is untouched');
  assert.equal((await call(app, '/api/v1/auth/devices', { headers: tablet.auth })).json.devices.some((d) => d.id === target.id), false, 'it leaves the list');

  // Another person's device cannot be revoked by id: it is not found.
  await fresh();
  const stranger = await codeSignIn(app, { phone: random10(), device: testDevice('Stranger phone') });
  const theirs = (await call(app, '/api/v1/auth/devices', { headers: stranger.auth })).json.devices[0];
  assert.equal((await call(app, `/api/v1/auth/devices/${theirs.id}`, { method: 'DELETE', headers: tablet.auth })).status, 404);
  assert.equal((await call(app, '/api/v1/orders', { headers: stranger.auth })).status, 200);
});

/** Signs in on a new device and turns device unlock on there. */
async function withUnlock(name) {
  await fresh();
  const device = testDevice(name);
  const session = await codeSignIn(app, { device });
  const enabled = await call(app, '/api/v1/auth/device-unlock', { method: 'POST', headers: session.auth });
  assert.equal(enabled.status, 201);
  return { device, session, secret: enabled.json.deviceSecret };
}

test('F-110: after the first sign-in the owner app offers fingerprint or face unlock, and the server keeps only a hash of its secret', async () => {
  await fresh();
  const device = testDevice('Pixel 9');
  const first = await codeSignIn(app, { device });
  assert.equal(first.deviceUnlock, false, 'not set up yet, so the app offers it');
  const enabled = await call(app, '/api/v1/auth/device-unlock', { method: 'POST', headers: first.auth });
  assert.equal(enabled.status, 201);
  const secret = enabled.json.deviceSecret;
  assert.ok(secret.length >= 40);
  const [row] = await app.db.platform.query('SELECT reauth_secret_hash FROM auth_devices WHERE device_id = $1', [device.id]);
  assert.equal(row.reauth_secret_hash, tokenHash(secret), 'only the hash is stored');
  assert.equal(JSON.stringify(row).includes(secret), false);
  const devices = await call(app, '/api/v1/auth/devices', { headers: first.auth });
  assert.equal(devices.json.devices.find((d) => d.current).deviceUnlock, true);
  // Signing in on that device again says the unlock is there.
  await fresh();
  assert.equal((await codeSignIn(app, { device })).deviceUnlock, true);
  // A browser session has no device to hold a secret.
  await fresh();
  const web = await codeSignIn(app, { transport: 'cookie' });
  assert.equal((await call(app, '/api/v1/auth/device-unlock', { method: 'POST', headers: web.auth })).status, 409);
});

test('P-68: with face unlock on, reopening the app needs no new code: the refresh token opens it and the secret re-auths, and nothing else', async () => {
  const { session, secret } = await withUnlock('Pixel 9 Pro');
  const before = await app.db.platform.query('SELECT count(*)::int AS n FROM seller_login_codes');
  // Reopening: the unlock releases the stored refresh token, and the refresh needs no code.
  const reopened = await refresh(session.refreshToken);
  assert.equal(reopened.status, 201);
  const headers = bearer(reopened.json.accessToken);
  assert.equal((await call(app, '/api/v1/orders', { headers })).status, 200);
  // A sensitive action: the device secret re-auths this session, still with no code.
  assert.equal((await call(app, '/api/v1/auth/device-unlock', { method: 'POST', headers })).json.code, 'reauth_required');
  const wrong = await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers, body: { deviceSecret: 'not-the-secret' } });
  assert.deepEqual([wrong.status, wrong.json.code], [400, 'validation_failed'], 'a wrong secret is not a signed-out session');
  const ok = await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers, body: { deviceSecret: secret } });
  assert.equal(ok.status, 200);
  assert.ok(Date.parse(ok.json.freshUntil) > Date.now() + 4 * 60_000);
  assert.notEqual((await call(app, '/api/v1/auth/me', { headers })).json.freshUntil, null);
  assert.deepEqual(await app.db.platform.query('SELECT count(*)::int AS n FROM seller_login_codes'), before, 'no code was sent');

  // The secret works only from its own device's session, and never signs anyone in.
  await fresh();
  const elsewhere = await codeSignIn(app, { device: testDevice('Other phone') });
  await app.db.platform.query('UPDATE sessions SET fresh_until = NULL WHERE id = $1', [tokenHash(elsewhere.accessToken)]);
  assert.equal((await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers: elsewhere.auth, body: { deviceSecret: secret } })).status, 400);
  assert.equal((await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone: OWNER.phone, code: secret }, ip: freshIp() })).status, 401);
});

test('device secret tries are limited', async () => {
  await fresh();
  const session = await codeSignIn(app, { device: testDevice('Limited phone') });
  let last;
  for (let i = 0; i < 7; i++) last = await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers: session.auth, body: { deviceSecret: `guess-${i}` } });
  assert.deepEqual([last.status, last.json.code], [429, 'rate_limited']);
});

test('P-17: replacing a payment key needs a re-auth in the last 5 minutes; a WhatsApp code to the person re-auths', async () => {
  await fresh();
  const session = await codeSignIn(app, { device: testDevice() });
  const change = (headers) => call(app, '/api/v1/settings/payment', { method: 'PATCH', headers, body: { upiId: 'shop@upi' } });
  assert.notEqual((await change(session.auth)).json?.code, 'reauth_required', 'a sign-in counts as a re-auth');

  const renewed = await refresh(session.refreshToken);
  const headers = bearer(renewed.json.accessToken);
  const refused = await change(headers);
  assert.deepEqual([refused.status, refused.json.code], [403, 'reauth_required']);

  await fresh();
  const started = await call(app, '/api/v1/auth/reauth/start', { method: 'POST', headers });
  assert.deepEqual([started.status, started.json.sent, started.json.channel], [202, true, 'whatsapp']);
  const code = await sellerCodeFor(app.whatsapp, OWNER.phone);
  // A sign-in code is not a re-auth code, and the other way round.
  assert.equal((await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone: OWNER.phone, code }, ip: freshIp() })).status, 401);
  const done = await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers, body: { code } });
  assert.equal(done.status, 200);
  assert.equal((await change(headers)).status, 200);
  assert.equal((await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers, body: { code } })).status, 400, 'a re-auth code works once');

  // After five minutes it is stale again.
  await app.db.platform.query(`UPDATE sessions SET fresh_until = now() - interval '1 second' WHERE id = $1`, [tokenHash(renewed.json.accessToken)]);
  assert.equal((await change(headers)).json.code, 'reauth_required');
});

test('a re-auth code is bound to the person who asked: another person\'s session cannot use it', async () => {
  await fresh();
  const owner = await codeSignIn(app, { device: testDevice() });
  const renewed = await refresh(owner.refreshToken);
  await call(app, '/api/v1/auth/reauth/start', { method: 'POST', headers: bearer(renewed.json.accessToken) });
  const code = await sellerCodeFor(app.whatsapp, OWNER.phone);
  await fresh();
  const other = await codeSignIn(app, { phone: random10(), device: testDevice() });
  assert.equal((await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers: other.auth, body: { code } })).status, 400);
});

test('signing out of the app ends its family and stops pushes to that device', async () => {
  await fresh();
  const device = testDevice('Leaving phone');
  const session = await codeSignIn(app, { device });
  const [person] = await app.db.platform.query('SELECT person_id FROM auth_devices WHERE device_id = $1', [device.id]);
  await app.db.platform.query(`INSERT INTO push_devices (person_id, device_id, platform, token_enc, token_hash) VALUES ($1, $2, 'android', 'enc', $3)`, [person.person_id, device.id, `hash-${device.id}`]);
  assert.equal((await call(app, '/api/v1/auth/logout', { method: 'POST', headers: session.auth })).status, 204);
  assert.equal((await call(app, '/api/v1/orders', { headers: session.auth })).status, 401);
  assert.equal((await refresh(session.refreshToken)).status, 401);
  const [push] = await app.db.platform.query('SELECT deleted_at, delete_reason, token_enc FROM push_devices WHERE device_id = $1', [device.id]);
  assert.ok(push.deleted_at);
  assert.deepEqual([push.delete_reason, push.token_enc], ['signed_out', null]);
});

test('P-07: an app below the minimum gets 426 with the store link, while it can still read where to update', async () => {
  await fresh();
  const storeUrl = 'https://play.google.com/store/apps/details?id=example.business';
  await app.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '1.2.0', storeUrl });
  const old = { 'x-app': 'owner', 'x-app-version': '1.0.0', 'x-app-platform': 'android' };
  const requirements = await call(app, '/api/v1/app/requirements?platform=android', { headers: old });
  assert.equal(requirements.status, 200);
  assert.deepEqual([requirements.json.minVersion, requirements.json.storeUrl], ['1.2.0', storeUrl]);
  const signIn = await call(app, '/api/v1/auth/start', { method: 'POST', headers: old, body: { phone: OWNER.phone }, ip: freshIp() });
  assert.deepEqual([signIn.status, signIn.json.code, signIn.json.storeUrl], [426, 'update_required', storeUrl]);
  assert.match(signIn.json.error, /Update required/);
  const session = await codeSignIn(app, { headers: { 'x-app': 'owner', 'x-app-version': '1.2.0', 'x-app-platform': 'android' } });
  const orders = await call(app, '/api/v1/orders', { headers: { ...session.auth, ...old } });
  assert.deepEqual([orders.status, orders.json.storeUrl], [426, storeUrl]);
  await app.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '1.0.0', storeUrl });
  const none = await call(app, '/api/v1/app/requirements?platform=ios');
  assert.deepEqual([none.json.minVersion, none.json.storeUrl], ['', '']);
});

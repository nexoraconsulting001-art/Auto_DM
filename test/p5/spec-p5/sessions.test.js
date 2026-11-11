// PRD 10.2 and 5.11: the owner app's session. A 15-minute access token and a refresh token that rotates on every use,
// a reused refresh token ends its whole family, a revoked device is out within 60 s, and an app below the minimum
// version is told to update. P-04, P-05, P-07, P-08.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, SECOND, addSeller, appSignIn, atOnce, captureLogs, newDevice, noCrash, ownerApp, ownerPhone, randomIp, refusedWith, registerPush, staleAll, useP5World } from './kit.js';

const world = useP5World();
const ACCESS_MS = 15 * MINUTE;
const STORE_URL = 'https://play.google.com/store/apps/details?id=com.bhava.business';
const familyOf = async (s) => (await world.sql('SELECT * FROM token_families WHERE device_id = $1 ORDER BY id DESC LIMIT 1', [s.device.id]))[0];

test('P-04: an access token lasts fifteen minutes; then /api/v1/orders answers 401 and a refresh gets a working one', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  assert.equal(s.body.accessExpiresInSeconds, ACCESS_MS / 1000, 'The access token is not a fifteen-minute token');
  assert.equal((await s.send('GET', '/orders')).status, 200);

  // Just inside the fifteen minutes it still works; just past, it does not.
  await world.shift(ACCESS_MS - 30 * SECOND, ['sessions']);
  assert.equal((await s.send('GET', '/orders')).status, 200, 'An access token at fourteen and a half minutes');
  await world.shift(31 * SECOND, ['sessions']);
  const expired = await s.send('GET', '/orders');
  assert.deepEqual([expired.status, expired.data?.code], [401, 'unauthorized'], 'An expired access token');
  assert.equal(expired.data?.items, undefined, 'Orders came back with an expired token');

  // The silent refresh: a new pair, and the call made again works once.
  const old = { access: s.accessToken, refresh: s.refreshToken };
  const refreshed = await s.refresh();
  assert.equal(refreshed.status, 201, `The refresh: ${refreshed.status} ${refreshed.text.slice(0, 200)}`);
  assert.notEqual(s.accessToken, old.access);
  assert.notEqual(s.refreshToken, old.refresh, 'The refresh token did not rotate');
  assert.equal(refreshed.data.accessExpiresInSeconds, ACCESS_MS / 1000);
  assert.equal((await s.send('GET', '/orders')).status, 200, 'The call retried with the new token');
  // The old access token stays dead.
  assert.equal((await world.app('/api/v1/orders', { token: old.access })).status, 401);
});

test('P-04: a refresh is never a fresh sign-in, and an expired refresh token is refused', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  assert.equal((await s.refresh()).status, 201);
  const me = await s.me();
  assert.equal(me.status, 200);
  assert.equal(me.data.freshUntil, null, 'A plain refresh counted as a re-auth');
  await world.shift(61 * 24 * 60 * MINUTE, ['refresh_tokens', 'token_families', 'sessions']);
  const late = await s.refresh();
  refusedWith(late, 401, 'A refresh token past sixty days');
});

test('P-04: tokens that are not tokens are a 401, never a fault', async (t) => {
  const logs = captureLogs(t);
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  for (const token of ['', 'x', 'a'.repeat(200), `${s.refreshToken}x`, s.accessToken, '../../etc/passwd', '\u0000', "' OR 1=1 --"]) {
    const res = noCrash(await s.refresh(token), `A refresh with ${JSON.stringify(token).slice(0, 30)}`);
    assert.equal(res.status, 401, `A refresh with ${JSON.stringify(token).slice(0, 30)} answered ${res.status}`);
  }
  // A refresh token is not an access token.
  assert.equal((await world.app('/api/v1/orders', { token: s.refreshToken })).status, 401, 'A refresh token opened the API as an access token');
  for (const header of ['Bearer', 'Bearer ', `Basic ${s.accessToken}`, `Bearer ${s.accessToken} extra`, `bearer${s.accessToken}`]) {
    assert.equal(noCrash(await world.app('/api/v1/orders', { headers: { authorization: header } }), header).status, 401, `Authorization: ${header.slice(0, 20)}`);
  }
  assert.ok(!logs.text().includes(s.refreshToken), 'A refresh token is in the logs');
  assert.ok(!logs.text().includes(s.accessToken), 'An access token is in the logs');
});

test('P-05: reusing a rotated refresh token is a 401 and revokes every session in that family', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  const other = await ownerApp(world, shop, { device: newDevice('iPhone 16', 'ios') });
  const rotated = s.refreshToken;
  assert.equal((await s.refresh()).status, 201);
  const current = { access: s.accessToken, refresh: s.refreshToken };
  assert.equal((await s.send('GET', '/orders')).status, 200);

  const reuse = await s.refresh(rotated);
  refusedWith(reuse, 401, 'The rotated refresh token presented again');
  assert.equal(reuse.data?.accessToken, undefined);
  // The whole family is gone: the newest access token and the newest refresh token too.
  assert.equal((await world.app('/api/v1/orders', { token: current.access })).status, 401, 'The family\'s access token still works');
  refusedWith(await s.refresh(current.refresh), 401, 'The family\'s newest refresh token');
  const family = await familyOf(s);
  assert.ok(family?.revoked_at, 'The family was not revoked');
  assert.equal(family.revoke_reason, 'token_reuse');
  // Another device of the same person keeps working.
  assert.equal((await other.send('GET', '/orders')).status, 200, 'Another device\'s session was ended too');
  assert.equal((await other.refresh()).status, 201);
});

test('P-05: a stolen refresh token used first from elsewhere ends the thief\'s session when the real device refreshes', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  const stolen = s.refreshToken;
  const thief = await world.app('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: stolen }, ip: randomIp() });
  if (thief.status !== 201) return refusedWith(thief, 401, 'The stolen token');
  // The real device presents the same token: a reuse.
  refusedWith(await s.refresh(stolen), 401, 'The real device presenting a token the thief already used');
  assert.equal((await world.app('/api/v1/orders', { token: thief.data.accessToken })).status, 401, 'The thief\'s access token survived the reuse');
  refusedWith(await world.app('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: thief.data.refreshToken } }), 401, 'The thief\'s refresh token');
});

test('P-05: two refreshes with one token at once make at most one new pair, and the loser is a 401', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  const token = s.refreshToken;
  const answers = await atOnce(4, () => world.app('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: token }, ip: s.ip }));
  const won = answers.filter((r) => r.status === 201);
  assert.ok(won.length <= 1, `${won.length} refreshes succeeded with one token`);
  for (const r of answers.filter((x) => x.status !== 201)) refusedWith(r, [401, 409, 429], 'A losing refresh');
});

test('P-05: after signing out, the refresh token and the access token are dead', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  const refresh = s.refreshToken;
  assert.equal((await s.send('POST', '/auth/logout')).status, 204);
  assert.equal((await s.send('GET', '/orders')).status, 401);
  refusedWith(await s.refresh(refresh), 401, 'A refresh after signing out');
  const [family] = await world.sql('SELECT revoked_at, revoke_reason FROM token_families WHERE device_id = $1 ORDER BY id DESC LIMIT 1', [s.device.id]);
  assert.equal(family?.revoke_reason, 'signed_out');
});

test('P-05: the refresh token lives in the database only as a hash', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  const rows = await world.sql('SELECT * FROM refresh_tokens ORDER BY id DESC LIMIT 20');
  assert.ok(rows.length >= 1);
  assert.ok(!JSON.stringify(rows).includes(s.refreshToken), 'A refresh token is stored as it was given out');
  const sessions = await world.sql('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 20');
  assert.ok(!JSON.stringify(sessions).includes(s.refreshToken));
});

test('P-08: the owner revokes "Pixel 8" in Settings > Devices and that device is signed out within 60 s', async () => {
  const shop = await addSeller(world);
  const pixel = await ownerApp(world, shop, { device: newDevice('Pixel 8') });
  const iphone = await ownerApp(world, shop, { device: newDevice('iPhone 16', 'ios') });
  await registerPush(pixel);
  const listed = await iphone.send('GET', '/auth/devices');
  assert.equal(listed.status, 200, `Settings > Devices: ${listed.status} ${listed.text.slice(0, 200)}`);
  const names = listed.data.devices.map((d) => d.name);
  assert.ok(names.includes('Pixel 8') && names.includes('iPhone 16'), `Devices listed: ${names}`);
  assert.equal(listed.data.devices.filter((d) => d.current).map((d) => d.name).join(), 'iPhone 16', 'The device the request came from is not marked current');
  assert.doesNotMatch(listed.text, new RegExp(pixel.device.id), 'Settings > Devices shows the raw device id');

  // Revoking is never held up by a re-auth.
  await staleAll(world);
  const target = listed.data.devices.find((d) => d.name === 'Pixel 8');
  const revoked = await iphone.send('DELETE', `/auth/devices/${target.id}`);
  assert.equal(revoked.status, 204, `Revoking Pixel 8: ${revoked.status} ${revoked.text.slice(0, 200)}`);
  const started = Date.now();
  let out = null;
  while (!out && Date.now() - started < 60 * SECOND) {
    const res = await pixel.send('GET', '/orders');
    if (res.status === 401) out = res;
    else await world.waitFor(() => false, 500);
  }
  assert.ok(out, 'Pixel 8 still works a minute after it was revoked');
  refusedWith(await pixel.refresh(), 401, 'Pixel 8\'s refresh token after it was revoked');
  assert.equal((await iphone.send('GET', '/orders')).status, 200, 'The device that revoked it was signed out too');
  const after = await iphone.send('GET', '/auth/devices');
  assert.ok(!after.data.devices.some((d) => d.name === 'Pixel 8'), 'Pixel 8 is still listed');
  const [push] = await world.sql('SELECT deleted_at, delete_reason FROM push_devices WHERE device_id = $1', [pixel.device.id]);
  if (push) assert.ok(push.deleted_at, 'A revoked device keeps its push token');
});

test('P-08: one person cannot revoke another person\'s device, even in the same business', async () => {
  const shop = await addSeller(world);
  const owner = await ownerApp(world, shop);
  const other = await addSeller(world);
  const stranger = await ownerApp(world, other, { device: newDevice('Stranger phone') });
  const mine = (await owner.send('GET', '/auth/devices')).data.devices.find((d) => d.current);
  const answer = await stranger.send('DELETE', `/auth/devices/${mine.id}`);
  refusedWith(answer, [403, 404], 'Revoking another person\'s device');
  assert.equal((await owner.send('GET', '/orders')).status, 200, 'Another person revoked this device');
  for (const id of ['0', '-1', '99999999', 'abc', '1e3']) noCrash(await stranger.send('DELETE', `/auth/devices/${id}`), `DELETE /auth/devices/${id}`);
  assert.equal((await owner.send('GET', '/orders')).status, 200);
});

test('P-07: an app below the minimum version gets 426 with a store link; at or above it works; a version that cannot be read is too old', async () => {
  await world.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '1.2.0', storeUrl: STORE_URL });
  try {
    const shop = await addSeller(world);
    const s = await ownerApp(world, shop);
    const as = (version, platform = 'android') => s.send('GET', '/orders', undefined, { headers: { 'x-app': 'owner', 'x-app-version': version, 'x-app-platform': platform } });
    const old = await as('1.0.0');
    assert.deepEqual([old.status, old.data?.code, old.data?.storeUrl], [426, 'update_required', STORE_URL]);
    assert.match(old.data.error, /update/i, 'The refusal does not say "Update required"');
    assert.equal(old.data.items, undefined);
    for (const version of ['1.2.0', '1.2.1', '1.10.0', '2.0.0', '10.0.0']) assert.equal((await as(version)).status, 200, `version ${version}`);
    for (const version of ['1.1.99', '0.9.9', '1.2', '1', 'garbage', '1.2.0-beta', ' 1.2.0', '99999999.0.0', '1.2.0.0', '']) {
      assert.equal(noCrash(await as(version), `version ${JSON.stringify(version)}`).status, 426, `version ${JSON.stringify(version)} was let through`);
    }
    assert.equal((await as('1.0.0', 'ios')).status, 200, 'No minimum is set for iOS');
    assert.equal((await s.send('GET', '/orders')).status, 200, 'A request that names no app (the web console) is never refused');

    // Before sign-in too, and the one call an old app may still make says where to go.
    const headers = { 'x-app': 'owner', 'x-app-version': '1.0.0', 'x-app-platform': 'android' };
    refusedWith(await world.app('/api/v1/auth/start', { method: 'POST', body: { phone: ownerPhone(shop) }, headers }), 426, 'Asking for a code from an old app');
    const requirements = await world.app('/api/v1/app/requirements?platform=android', { headers });
    assert.equal(requirements.status, 200, 'app.requirements refused an old app');
    assert.deepEqual([requirements.data.minVersion, requirements.data.storeUrl], ['1.2.0', STORE_URL]);
  } finally {
    await world.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '0.0.1', storeUrl: STORE_URL });
  }
});

test('P-07: at the minimum the app signs in, and a refresh from an old build is refused too', async () => {
  await world.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '1.2.0', storeUrl: STORE_URL });
  try {
    const shop = await addSeller(world);
    const s = await appSignIn(world, ownerPhone(shop), { app: { name: 'owner', version: '1.2.0', platform: 'android' }, device: newDevice('Pixel 8', 'android', '1.2.0') });
    assert.equal((await s.send('GET', '/orders')).status, 200);
    s.appHeaders['x-app-version'] = '1.1.0';
    refusedWith(await s.refresh(), 426, 'A refresh from a build below the minimum');
  } finally {
    await world.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '0.0.1', storeUrl: STORE_URL });
  }
});

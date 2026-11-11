// PRD 10.3, 10.4 and 5.11: sensitive actions need a fresh fingerprint, face or WhatsApp check; fingerprint or face unlock
// is offered after the first sign-in and only releases what the device already holds; replacing a payment key in the
// app needs a fresh re-auth and the key is never readable back. P-17, F-110, P-68 (the server's half).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_LIMITS, FRESH_MINUTES, MINUTE, SECOND, addMember, addSeller, appSignIn, captureLogs, freshen, newDevice, noCrash, ownerApp, ownerPhone, refusedWith, staleAll,
  useP5World, wrongCode,
} from './kit.js';

const world = useP5World();
const KEY_ID = 'rzp_test_SpecKey123456'; // secret-scan:allow (a made-up key id in the shape the contract checks)
const KEY_SECRET = 'fake-razorpay-secret-0000-do-not-show';

async function deviceSecretFor(s) {
  const res = await s.send('POST', '/auth/device-unlock');
  assert.equal(res.status, 201, `Turning on fingerprint or face unlock: ${res.status} ${res.text.slice(0, 200)}`);
  assert.ok(res.data.deviceSecret && res.data.deviceSecret.length >= 32, 'The device secret is short');
  return res.data.deviceSecret;
}

test('P-17: replacing the Razorpay key in the app needs a fresh re-auth, and the key is never readable back', async (t) => {
  const logs = captureLogs(t);
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  await staleAll(world);
  const stale = await s.send('PATCH', '/settings/payment', { razorpayKeyId: KEY_ID, razorpayKeySecret: KEY_SECRET });
  assert.deepEqual([stale.status, stale.data?.code], [403, 'reauth_required'], 'A key replaced without a fresh re-auth');

  const fresh = await freshen(world, s);
  const until = Date.parse(fresh.data.freshUntil);
  assert.ok(until > Date.now() + (FRESH_MINUTES - 1) * MINUTE && until <= Date.now() + (FRESH_MINUTES + 1) * MINUTE, `freshUntil is ${fresh.data.freshUntil}`);
  const saved = await s.send('PATCH', '/settings/payment', { razorpayKeyId: KEY_ID, razorpayKeySecret: KEY_SECRET });
  assert.equal(saved.status, 200, `Saving the key after a re-auth: ${saved.status} ${saved.text.slice(0, 200)}`);
  for (const [what, res] of [['the save', saved], ['settings', await s.send('GET', '/settings')], ['payment settings', await s.send('GET', '/payment-settings')], ['the payment account', await s.send('GET', '/payment-account')], ['the audit log', await s.send('GET', '/audit-log?limit=100')]]) {
    assert.ok(!res.text.includes(KEY_SECRET), `The key secret comes back in ${what}`);
    assert.ok(!res.text.includes(KEY_ID), `The whole key id comes back in ${what}`);
  }
  assert.ok(!logs.text().includes(KEY_SECRET), 'The key secret is in the logs');
  const rows = await shop.sql('SELECT details FROM audit_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT 10', [shop.tenantId]);
  assert.ok(!JSON.stringify(rows).includes(KEY_SECRET) && !JSON.stringify(rows).includes(KEY_ID), 'The audit row holds the key unmasked');
});

test('P-17: the fresh window is five minutes; at four and a half it holds, a second past five it does not', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  await world.shift(FRESH_MINUTES * MINUTE - 30 * SECOND, ['sessions']);
  assert.notEqual((await s.send('PATCH', '/settings/payment', { upiId: 'shop@upi' })).data?.code, 'reauth_required', 'Fresh at four and a half minutes');
  await world.shift(31 * SECOND, ['sessions']);
  assert.equal((await s.send('PATCH', '/settings/payment', { upiId: 'shop@upi' })).data?.code, 'reauth_required', 'Still fresh a second past five minutes');
});

test('P-17: a re-auth is for one session: another device of the same person stays stale', async () => {
  const shop = await addSeller(world);
  const a = await ownerApp(world, shop);
  const b = await ownerApp(world, shop, { device: newDevice('iPhone 16', 'ios') });
  await staleAll(world);
  await freshen(world, a);
  assert.notEqual((await a.send('PATCH', '/settings/payment', { upiId: 'a@upi' })).data?.code, 'reauth_required');
  assert.equal((await b.send('PATCH', '/settings/payment', { upiId: 'b@upi' })).data?.code, 'reauth_required', 'One device\'s re-auth made another fresh');
});

test('P-17: a re-auth code works only for the person it was sent to, and wrong ones run out', async () => {
  const shop = await addSeller(world);
  const owner = await ownerApp(world, shop);
  const manager = await addMember(shop, { role: 'manager' });
  const m = await appSignIn(world, manager.phone, { tenantId: shop.tenantId });
  await staleAll(world);
  const seen = (await world.sellerMessages(owner.phone)).length;
  assert.equal((await owner.send('POST', '/auth/reauth/start')).status, 202);
  const code = await world.sellerCode(owner.phone, { after: seen });
  assert.ok(code, 'No re-auth code arrived');
  refusedWith(await m.send('POST', '/auth/reauth/verify', { code }), [400, 401, 403], 'The owner\'s re-auth code in the manager\'s session');
  for (let i = 0; i < 5; i++) refusedWith(await owner.send('POST', '/auth/reauth/verify', { code: wrongCode(code) }), [400, 401, 403, 429], 'A wrong re-auth code');
  refusedWith(await owner.send('POST', '/auth/reauth/verify', { code }), [400, 401, 403, 429], 'The right code after five wrong ones');
  for (const body of [{}, { code, deviceSecret: 'x'.repeat(43) }, { code: ['1'] }, { deviceSecret: '' }]) {
    const res = noCrash(await owner.send('POST', '/auth/reauth/verify', body), `reauth.verify with ${JSON.stringify(body).slice(0, 40)}`);
    assert.ok(res.status >= 400 && res.status < 500, `reauth.verify with ${JSON.stringify(body).slice(0, 40)} answered ${res.status}`);
  }
  assert.equal((await owner.send('PATCH', '/settings/payment', { upiId: 'x@upi' })).data?.code, 'reauth_required');
});

test('F-110: after the first sign-in the app is offered fingerprint or face unlock, and turning it on needs that sign-in to be fresh', async (t) => {
  const logs = captureLogs(t);
  const shop = await addSeller(world);
  const device = newDevice('Pixel 8');
  const first = await ownerApp(world, shop, { device });
  assert.equal(first.body.deviceUnlock, false, 'A device that holds no secret yet is told it has one');
  const secret = await deviceSecretFor(first);
  const [row] = await world.sql('SELECT reauth_secret_hash FROM auth_devices WHERE device_id = $1', [device.id]);
  assert.ok(row?.reauth_secret_hash, 'No hash of the device secret was kept');
  assert.ok(!JSON.stringify(row).includes(secret), 'The device secret is stored as it was given out');
  assert.ok(!logs.text().includes(secret), 'The device secret is in the logs');
  const devices = await first.send('GET', '/auth/devices');
  assert.equal(devices.data.devices.find((d) => d.current)?.deviceUnlock, true);

  // The same device signing in again knows it has one.
  const again = await ownerApp(world, shop, { device });
  assert.equal(again.body.deviceUnlock, true, 'A device with a secret is not told so');

  // Turning it on needs a fresh session.
  const other = await ownerApp(world, shop, { device: newDevice('iPhone 16', 'ios') });
  await staleAll(world);
  const stale = await other.send('POST', '/auth/device-unlock');
  assert.deepEqual([stale.status, stale.data?.code], [403, 'reauth_required'], 'Device unlock turned on without a fresh sign-in');
  assert.equal(stale.data?.deviceSecret, undefined);
});

test('F-110: reopening the app needs no new code: the stored refresh token opens it', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  await deviceSecretFor(s);
  const before = (await world.sellerMessages(s.phone)).length;
  // Closed for longer than an access token lives, then reopened.
  await world.shift(20 * MINUTE, ['sessions']);
  assert.equal((await s.send('GET', '/orders')).status, 401);
  assert.equal((await s.refresh()).status, 201, 'The stored refresh token did not reopen the app');
  assert.equal((await s.send('GET', '/orders')).status, 200);
  await world.waitFor(() => false, 600);
  assert.equal((await world.sellerMessages(s.phone)).length, before, 'Reopening the app sent a new code');
});

test('P-68: face unlock re-authenticates with the device secret and no code', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  const secret = await deviceSecretFor(s);
  await world.shift(20 * MINUTE, ['sessions']);
  assert.equal((await s.refresh()).status, 201);
  const before = (await world.sellerMessages(s.phone)).length;
  assert.equal((await s.send('PATCH', '/settings/payment', { upiId: 'x@upi' })).data?.code, 'reauth_required', 'A reopened app is fresh without a check');
  const fresh = await s.send('POST', '/auth/reauth/verify', { deviceSecret: secret });
  assert.equal(fresh.status, 200, `Re-auth with the device secret: ${fresh.status} ${fresh.text.slice(0, 200)}`);
  assert.notEqual((await s.send('PATCH', '/settings/payment', { upiId: 'x@upi' })).data?.code, 'reauth_required');
  assert.equal((await world.sellerMessages(s.phone)).length, before, 'Face unlock asked for a code');
});

test('P-68: a device secret works only on its own device, is limited, and dies with the device', async () => {
  const shop = await addSeller(world);
  const pixel = await ownerApp(world, shop, { device: newDevice('Pixel 8') });
  const secret = await deviceSecretFor(pixel);
  const iphone = await ownerApp(world, shop, { device: newDevice('iPhone 16', 'ios') });
  await staleAll(world);
  refusedWith(await iphone.send('POST', '/auth/reauth/verify', { deviceSecret: secret }), [400, 401, 403], 'Pixel 8\'s secret on the iPhone');
  // Another person's session cannot use it either.
  const stranger = await ownerApp(world, await addSeller(world));
  refusedWith(await stranger.send('POST', '/auth/reauth/verify', { deviceSecret: secret }), [400, 401, 403], 'One person\'s device secret in another\'s session');

  let limited = null;
  for (let i = 0; i < AUTH_LIMITS.deviceSecretTries.limit + 2 && !limited; i++) {
    const res = noCrash(await pixel.send('POST', '/auth/reauth/verify', { deviceSecret: `${secret.slice(0, -2)}${i}x` }), 'A wrong device secret');
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'Wrong device secrets were never limited');

  // Once the device is revoked, its secret opens nothing.
  const id = (await iphone.send('GET', '/auth/devices')).data.devices.find((d) => d.name === 'Pixel 8').id;
  assert.equal((await iphone.send('DELETE', `/auth/devices/${id}`)).status, 204);
  refusedWith(await pixel.send('POST', '/auth/reauth/verify', { deviceSecret: secret }), 401, 'A revoked device\'s secret');
  assert.equal((await world.sql('SELECT revoked_at FROM auth_devices WHERE device_id = $1', [pixel.device.id]))[0]?.revoked_at !== null, true);
});

test('P-68: signing in again on a device does not leave the old secret working beside a new one', async () => {
  const shop = await addSeller(world);
  const device = newDevice('Pixel 8');
  const s = await ownerApp(world, shop, { device });
  const old = await deviceSecretFor(s);
  const replaced = await deviceSecretFor(s);
  assert.notEqual(old, replaced);
  await staleAll(world);
  refusedWith(await s.send('POST', '/auth/reauth/verify', { deviceSecret: old }), [400, 401, 403, 429], 'The secret a newer one replaced');
  assert.equal((await s.send('POST', '/auth/reauth/verify', { deviceSecret: replaced })).status, 200);
});

// auth-5 (PRD 5.x roles: managers have no payment or integration keys; 9.x shipping: "the owner may connect their own
// Shiprocket account"): a manager may keep the pickup address, but cannot set or replace the business's own courier
// login or switch the shipping mode. The owner still can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWN_LOGIN, PICKUP, openWorld, raw } from '../../p4/shipping/support.js';

async function manager(world) {
  const { shop } = world;
  const phone = '9000000077';
  const password = 'manager-pass-1';
  await shop.inTenant(() => world.repos.users.create({ name: 'A manager', phone, password, role: 'manager' }));
  const res = await raw(world.port, '/api/v1/auth/login', { method: 'POST', host: '127.0.0.1', body: { phone, password } });
  assert.ok(res.json?.token, `manager sign-in failed with ${res.status}`);
  return res.json.token;
}

test('auth-5: a manager cannot connect, replace or switch to an own Shiprocket login, but can save the pickup address', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const as = await manager(world);

  const toOwn = await shop.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: OWN_LOGIN.email, ownPassword: OWN_LOGIN.password }, { as });
  assert.equal(toOwn.status, 403, toOwn.text);
  const row = await shop.settingsRow();
  assert.equal(row.mode, 'managed');
  assert.equal(row.own_password_enc, '', 'nothing of the manager\'s login is saved');
  assert.equal(row.own_email, '');

  // The owner connects their own account; the manager then cannot replace its login or move the business off it.
  const good = await shop.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: OWN_LOGIN.email, ownPassword: OWN_LOGIN.password });
  assert.equal(good.status, 200, good.text);
  const saved = (await shop.settingsRow()).own_password_enc;
  const replace = await shop.api('PATCH', '/shipping-settings', { ownEmail: 'manager@courier.example', ownPassword: 'their-own-pass' }, { as });
  assert.equal(replace.status, 403, replace.text);
  const newPassword = await shop.api('PATCH', '/shipping-settings', { ownPassword: 'their-own-pass' }, { as });
  assert.equal(newPassword.status, 403, newPassword.text);
  const back = await shop.api('PATCH', '/shipping-settings', { mode: 'managed' }, { as });
  assert.equal(back.status, 403, back.text);
  const after = await shop.settingsRow();
  assert.deepEqual([after.mode, after.own_email, after.own_password_enc], ['own', OWN_LOGIN.email, saved], 'the owner\'s login is untouched');

  // The pickup address is still the manager's to keep, sent the way the screens send it (the mode as it is).
  const address = await shop.api('PATCH', '/shipping-settings', { ...PICKUP, mode: 'own', ownEmail: OWN_LOGIN.email, pickupLine2: 'Gate 2' }, { as });
  assert.equal(address.status, 200, address.text);
  assert.equal((await shop.settingsRow()).pickup_line2, 'Gate 2');
});

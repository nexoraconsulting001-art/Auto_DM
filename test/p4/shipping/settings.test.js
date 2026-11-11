// Shipping settings (PRD 9.10): Bhava's master account with one pickup location per seller, or the seller's own API user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWN_LOGIN, PICKUP, openWorld } from './support.js';

const pickups = async (world) => (await world.ship.get('/state')).pickups;

test('F-80, S-77: a pickup address saved in managed mode becomes this seller’s own pickup location on the master account', async (t) => {
  const world = await openWorld(t, { pickup: false });
  const { shop } = world;
  const blank = await shop.api('GET', '/shipping-settings');
  assert.equal(blank.status, 200);
  assert.deepEqual({ mode: blank.json.mode, registered: blank.json.pickupRegistered, passwordSet: blank.json.ownPasswordSet }, { mode: 'managed', registered: false, passwordSet: false });

  const saved = await shop.pickupReady();
  assert.equal(saved.pickupRegistered, true);
  assert.equal(saved.pickupPhone, '9811100001', 'the phone is stored as the courier wants it');
  const [registered] = await pickups(world);
  assert.equal(registered.key.split(':')[0], 'sim@bhava.test', 'registered on the master account');
  assert.equal(registered.name, 'Lamp House Dispatch');
  assert.equal(registered.address, '4 Mill Lane');
  assert.equal(registered.pin_code, '411002');
  assert.equal(registered.state, 'Maharashtra');
  const { key: _login, ...shipper } = registered;
  assert.doesNotMatch(JSON.stringify(shipper), /bhava/i, 'the label’s shipper never names the platform');
  const row = await shop.settingsRow();
  assert.equal(row.pickup_location, registered.code);

  // A second business gets a pickup location of its own.
  const other = await world.business({ name: 'Brass Bazaar' });
  const both = await pickups(world);
  assert.equal(both.length, 2);
  assert.notEqual(both[0].code, both[1].code);
  assert.equal((await other.settingsRow()).pickup_location, both[1].code);

  // Saving the same address again registers nothing new; a new address gets a fresh pickup location.
  await shop.api('PATCH', '/shipping-settings', { chargeBilling: 'monthly' });
  assert.equal((await pickups(world)).length, 2);
  const moved = await shop.api('PATCH', '/shipping-settings', { pickupLine1: '9 Copper Street' });
  assert.equal(moved.json.pickupRegistered, true);
  assert.equal((await pickups(world)).length, 3);
  assert.notEqual((await shop.settingsRow()).pickup_location, registered.code);

  // The audit row names what changed, never the address or the phone.
  const audit = await shop.sql(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'shipping.settings_updated' ORDER BY id`, [shop.tenant.id]);
  assert.ok(audit.length >= 3);
  assert.doesNotMatch(JSON.stringify(audit), /Mill Lane|Copper|9811100001/);
});

test('an address the courier can’t use is refused with a reason, a half-typed one is kept unregistered, a bad phone is refused', async (t) => {
  const world = await openWorld(t, { pickup: false });
  const { shop } = world;
  const phone = await shop.api('PATCH', '/shipping-settings', { ...PICKUP, pickupPhone: '12345' });
  assert.equal(phone.status, 400);
  assert.ok(phone.json.fields.pickupPhone);
  const partial = await shop.api('PATCH', '/shipping-settings', { mode: 'managed', pickupName: 'Lamp House', pickupLine1: '4 Mill Lane' });
  assert.equal(partial.status, 200);
  assert.equal(partial.json.pickupRegistered, false);
  assert.equal((await world.ship.get('/state')).pickups.length, 0, 'nothing is sent to the courier until the address is complete');
  await world.ship.fault({ kind: 'rate_limit', status: 422, match: { method: 'POST', path: '/v1/external/settings/company/addpickup' } });
  const refused = await shop.api('PATCH', '/shipping-settings', PICKUP);
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /pickup address/);
  assert.equal((await shop.settingsRow()).pickup_city, '', 'nothing of a refused address is saved');
  // A courier that doesn't answer: saved unregistered, and registered when the courier is back.
  await world.ship.fault({ kind: 'server_error', status: 503, match: { method: 'POST', path: '/v1/external/settings/company/addpickup' } });
  const later = await shop.api('PATCH', '/shipping-settings', PICKUP);
  assert.equal(later.status, 200);
  assert.equal(later.json.pickupRegistered, false);
  const row = await shop.run((s) => s.settings.ensurePickup());
  assert.equal(row.pickup_registered, true);
  assert.equal((await shop.api('GET', '/shipping-settings')).json.pickupRegistered, true);
});

test('bring your own: a login Shiprocket refuses saves nothing; a good one registers the pickup on the seller’s own account', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const missing = await shop.api('PATCH', '/shipping-settings', { mode: 'own' });
  assert.equal(missing.status, 400, 'own mode needs a login');
  const wrong = await shop.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: OWN_LOGIN.email, ownPassword: 'not-the-password' });
  assert.equal(wrong.status, 400);
  assert.ok(wrong.json.fields.ownPassword);
  const still = await shop.settingsRow();
  assert.equal(still.mode, 'managed');
  assert.equal(still.own_password_enc, '', 'a refused login is not saved');

  const good = await shop.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: OWN_LOGIN.email, ownPassword: OWN_LOGIN.password });
  assert.equal(good.status, 200, good.text);
  assert.equal(good.json.mode, 'own');
  assert.equal(good.json.ownPasswordSet, true);
  assert.equal(good.json.pickupRegistered, true);
  assert.ok(!good.text.includes(OWN_LOGIN.password), 'the password never comes back');
  const row = await shop.settingsRow();
  assert.ok(row.own_password_enc.startsWith('v1.') && !row.own_password_enc.includes(OWN_LOGIN.password), 'the password is stored encrypted');
  const own = (await world.ship.get('/state')).pickups.filter((p) => p.key.startsWith(`${OWN_LOGIN.email}:`));
  assert.equal(own.length, 1, 'the pickup is registered on the seller’s own account');
  assert.equal(row.pickup_location, own[0].code);

  // Back to managed: a fresh pickup location on the master account; the own login is kept for parcels already sent with it.
  const back = await shop.api('PATCH', '/shipping-settings', { mode: 'managed' });
  assert.equal(back.json.mode, 'managed');
  assert.equal(back.json.pickupRegistered, true);
  assert.equal(back.json.ownPasswordSet, true);
  const master = (await world.ship.get('/state')).pickups.filter((p) => p.key.startsWith('sim@bhava.test:'));
  assert.equal((await shop.settingsRow()).pickup_location, master.at(-1).code);
});

test('shipping settings are for managers, and saving them is a tier 3 feature', async (t) => {
  const world = await openWorld(t, { plan: 't2', pickup: false });
  const { shop } = world;
  const res = await shop.api('PATCH', '/shipping-settings', PICKUP);
  assert.equal(res.status, 403);
  assert.equal(res.json.reason, 'plan');
  assert.equal((await shop.api('GET', '/shipping-settings', undefined, { as: null })).status, 401);
});

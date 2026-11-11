// The seller routes of notifications (PRD 5.13, 10.5): the in-app list, the preferences and the owner app's push token,
// each for the signed-in seller's own account in the current business only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenHash } from '../../../src/contracts/accounts.js';
import * as n from '../../../src/contracts/notifications.js';
import { OWNER } from '../../helpers.js';
import { addBusiness, addPerson, addUser, androidToken, api, connect, iosToken, registerPush, signInDevice, startWorld } from './support.js';

let w;
let owner;
let device;

before(async () => {
  w = await startWorld();
  owner = await connect(w, { devices: ['android'] });
  [device] = owner.devices;
});
after(() => w?.close());

const as = (headers) => ({
  get: (path) => api(w, path, { headers }),
  post: (path, body) => api(w, path, { method: 'POST', headers, body }),
  put: (path, body) => api(w, path, { method: 'PUT', headers, body }),
  del: (path) => api(w, path, { method: 'DELETE', headers }),
});

test('the in-app list: newest first, an unread count for the badge, pages, and marking some or all as read', async () => {
  const worker = w.worker();
  const managerId = await addUser(w, { role: 'manager' });
  const manager = await connect(w, { userId: managerId, devices: ['ios'] });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await w.notify.emit({ event: 'token.expiring', tenantId: w.tenant.id, key: `inapp:${i}`, data: { account: 'Instagram', days: 7 - i } }));
  await w.notify.emit({ event: 'token.invalid', tenantId: w.tenant.id, key: 'inapp:manager', audience: { userId: managerId } });
  await worker.drain();

  const me = as(device.headers);
  const list = await me.get('/notifications');
  assert.equal(list.status, 200);
  assert.equal(list.body.unread, 3);
  assert.deepEqual(list.body.items.map((i) => i.title), ['Reconnect Instagram soon', 'Reconnect Instagram soon', 'Reconnect Instagram soon']);
  assert.deepEqual(list.body.items.map((i) => i.body.match(/\d+ days/)[0]), ['5 days', '6 days', '7 days'], 'newest first');
  assert.deepEqual(Object.keys(list.body.items[0]).sort(), ['body', 'createdAt', 'id', 'kind', 'link', 'readAt', 'title']);
  assert.equal(list.body.items[0].link, '/settings/instagram');
  const pageOne = await me.get('/notifications?limit=2');
  assert.equal(pageOne.body.items.length, 2);
  const pageTwo = await me.get(`/notifications?limit=2&cursor=${pageOne.body.nextCursor}`);
  assert.deepEqual([pageTwo.body.items.length, pageTwo.body.nextCursor], [1, null]);

  // Marking someone else's id does nothing to it.
  const theirs = await as(manager.devices[0].headers).get('/notifications');
  assert.equal(theirs.body.items.length, 1);
  assert.equal((await me.post('/notifications/read', { ids: [list.body.items[2].id, theirs.body.items[0].id] })).status, 204);
  assert.equal((await me.get('/notifications')).body.unread, 2);
  assert.equal((await me.get('/notifications?unread=1')).body.items.length, 2);
  assert.equal((await as(manager.devices[0].headers).get('/notifications')).body.unread, 1, 'theirs is still unread');
  assert.equal((await me.post('/notifications/read', { all: true })).status, 204);
  assert.equal((await me.get('/notifications')).body.unread, 0);
  assert.equal((await as(manager.devices[0].headers).get('/notifications')).body.unread, 1);
  assert.equal((await me.post('/notifications/read', { ids: [] })).status, 400);
  assert.ok(ids.every(Boolean));
});

test('another business sees none of it, and a shopper\'s session is refused every route', async () => {
  const worker = w.worker();
  const other = await addBusiness(w, 'routes-other');
  const theirs = await connect(w, { userId: other.owner, tenant: other.tenant, devices: ['android'] });
  await w.notify.emit({ event: 'token.invalid', tenantId: other.tenant.id, key: 'other:1' });
  await worker.drain();
  const mine = await as(device.headers).get('/notifications');
  const theirList = await as(theirs.devices[0].headers).get('/notifications');
  assert.equal(theirList.body.items.length, 1);
  assert.equal(mine.body.items.some((i) => i.id === theirList.body.items[0].id), false, 'never across businesses');
  assert.equal((await api(w, '/notifications', { headers: { ...device.headers, 'x-tenant-id': String(other.tenant.id) } })).status, 403, 'not a member there');

  const shopperId = await addUser(w, { role: 'customer', name: 'Shopper' });
  const person = await addPerson(w, { userId: shopperId });
  const shopper = as((await signInDevice(w, { personId: person.personId, userId: shopperId })).headers);
  for (const res of [
    await shopper.get('/notifications'), await shopper.post('/notifications/read', { all: true }), await shopper.get('/notifications/prefs'),
    await shopper.put('/notifications/prefs', { events: { 'order.new': { email: false } } }),
    await shopper.post('/push/devices', { deviceId: 'device-0123456789abcdef', platform: 'android', token: androidToken() }),
    await shopper.del('/push/devices/device-0123456789abcdef'),
  ]) assert.equal(res.status, 403);
});

test('preferences: every kind with its switchable channels, quiet hours, what is set up, and refusals on the field', async () => {
  const me = as(device.headers);
  const view = await me.get('/notifications/prefs');
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.quietHours, n.DEFAULT_QUIET_HOURS);
  assert.deepEqual(Object.keys(view.body.events).sort(), [...n.NOTIFY_KINDS].sort());
  const kinds = Object.fromEntries(view.body.kinds.map((k) => [k.kind, k]));
  assert.deepEqual(kinds['order.new'], { kind: 'order.new', label: 'New orders', critical: false, mandatory: false, channels: ['push', 'email', 'whatsapp'] });
  assert.deepEqual(kinds['device.signed_in'].channels, [], 'a security notice cannot be switched');
  assert.deepEqual(kinds.needs_human.channels, ['push', 'email'], 'no template, no WhatsApp');
  assert.equal(kinds['order.cod_to_confirm'].critical, true);
  assert.deepEqual(view.body.available, { push: true, email: true, whatsapp: true, inapp: true });

  const saved = await me.put('/notifications/prefs', { quietHours: { enabled: true, from: '21:30' }, events: { 'order.new': { email: false, whatsapp: true } } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.quietHours, { enabled: true, from: '21:30', to: '07:00', timezone: 'Asia/Kolkata' });
  assert.deepEqual(saved.body.events['order.new'], { push: true, email: false, whatsapp: true, inapp: true });
  assert.deepEqual((await me.get('/notifications/prefs')).body.events['order.new'], saved.body.events['order.new']);

  for (const [body, field] of [
    [{ events: { 'staff.changed': { email: false } } }, 'events.staff.changed.email'],
    [{ events: { 'order.new': { inapp: false } } }, 'events.order.new.inapp'],
    [{ events: { needs_human: { whatsapp: true } } }, 'events.needs_human.whatsapp'],
    [{ quietHours: { timezone: 'Mars/Olympus' } }, 'quietHours.timezone'],
  ]) {
    const res = await me.put('/notifications/prefs', body);
    assert.equal(res.status, 400, field);
    assert.equal(res.body.code, 'validation_failed');
    assert.ok(res.body.fields?.[field], `${field}: ${JSON.stringify(res.body)}`);
  }
  assert.equal((await me.put('/notifications/prefs', {})).status, 400);
  assert.equal((await me.put('/notifications/prefs', { userId: 99, events: { 'order.new': { email: true } } })).status, 200, 'a user id in the body is not read');
  await me.put('/notifications/prefs', { quietHours: { enabled: false }, events: { 'order.new': { email: true, whatsapp: false } } });
});

test('push.register: only from the app on the device that signed in; stored encrypted; a token or a device seen before is replaced', async () => {
  const me = as(device.headers);
  const [stored] = await w.sql('SELECT token_enc, token_hash, platform, app_version, deleted_at FROM push_devices WHERE person_id = $1 AND device_id = $2', [owner.personId, device.id]);
  assert.ok(stored.token_enc.startsWith('v1.') && !stored.token_enc.includes(device.token), 'encrypted');
  assert.deepEqual([stored.token_hash, stored.platform, stored.app_version, stored.deleted_at], [tokenHash(device.token), 'android', '1.0.0', null]);

  // Not the app's own sign-in: the Phase 0 token, or another device's id.
  const login = await api(w, '/auth/login', { method: 'POST', body: { phone: OWNER.phone, password: OWNER.password } });
  assert.equal(login.status, 201);
  const bearer = as({ authorization: `Bearer ${login.body.token}` });
  assert.equal((await bearer.post('/push/devices', { deviceId: device.id, platform: 'android', token: androidToken() })).status, 403);
  assert.equal((await me.post('/push/devices', { deviceId: 'device-fedcba9876543210', platform: 'android', token: androidToken() })).status, 403);
  assert.equal((await me.post('/push/devices', { deviceId: device.id, platform: 'web', token: androidToken() })).status, 400);
  assert.equal((await me.post('/push/devices', { deviceId: device.id, platform: 'android', token: 'short' })).status, 400);

  // A new token for this device replaces the old one.
  const fresh = androidToken();
  await registerPush(w, device, fresh);
  device.token = fresh;
  const rows = await w.sql('SELECT token_hash FROM push_devices WHERE person_id = $1', [owner.personId]);
  assert.deepEqual(rows.map((r) => r.token_hash), [tokenHash(fresh)]);

  // A phone handed to someone else: its token moves to them, and stops reaching the first person.
  const managerId = await addUser(w, { role: 'manager' });
  const next = await addPerson(w, { userId: managerId });
  const theirDevice = await signInDevice(w, { personId: next.personId, userId: managerId });
  await registerPush(w, theirDevice, fresh);
  assert.deepEqual(await w.sql('SELECT 1 FROM push_devices WHERE person_id = $1', [owner.personId]), []);
  assert.equal((await w.sql('SELECT count(*)::int AS n FROM push_devices WHERE token_hash = $1', [tokenHash(fresh)]))[0].n, 1);

  // Signing out of the app: that device gets nothing more. Someone else's device id is left alone.
  const mine = await signInDevice(w, { personId: owner.personId, userId: w.owner, platform: 'ios' });
  await registerPush(w, mine, iosToken());
  assert.equal((await as(mine.headers).del(`/push/devices/${theirDevice.id}`)).status, 204);
  assert.equal((await w.sql('SELECT deleted_at FROM push_devices WHERE person_id = $1', [next.personId]))[0].deleted_at, null);
  assert.equal((await as(mine.headers).del(`/push/devices/${mine.id}`)).status, 204);
  const [gone] = await w.sql('SELECT deleted_at, delete_reason, token_enc FROM push_devices WHERE person_id = $1 AND device_id = $2', [owner.personId, mine.id]);
  assert.deepEqual([Boolean(gone.deleted_at), gone.delete_reason, gone.token_enc], [true, 'signed_out', null]);
  const emitted = await w.notify.emit({ event: 'token.invalid', tenantId: w.tenant.id, key: 'routes:signed-out', audience: { userId: w.owner } });
  await w.worker().drain();
  assert.equal((await w.sql(`SELECT reason FROM notification_deliveries WHERE event_id = $1 AND channel = 'push'`, [emitted]))[0].reason, 'no_address');

  // An account with no person behind it cannot register.
  const loose = await addUser(w, { role: 'manager' });
  const [family] = await w.sql(`INSERT INTO token_families (subject_kind, person_id, device_id) VALUES ('user', $1, 'device-loose0123456789') RETURNING id`, [next.personId]);
  const access = await w.inTenant(() => w.app.platform.sessions.createAccess(loose, { familyId: family.id, deviceId: 'device-loose0123456789', minutes: 15 }));
  assert.equal((await as({ authorization: `Bearer ${access}` }).post('/push/devices', { deviceId: 'device-loose0123456789', platform: 'android', token: androidToken() })).status, 403);

  // The accounts track's hook: forgetting a person's devices (account deletion) ends them all.
  await registerPush(w, await signInDevice(w, { personId: owner.personId, userId: w.owner }), androidToken());
  assert.equal(await w.notify.devices.forget({ personId: owner.personId, reason: 'account_deleted' }), 1);
  assert.deepEqual((await w.sql('SELECT DISTINCT delete_reason FROM push_devices WHERE person_id = $1 AND deleted_at IS NOT NULL', [owner.personId])).map((r) => r.delete_reason).sort(), ['account_deleted', 'signed_out']);
});

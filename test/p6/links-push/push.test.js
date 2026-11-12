import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { namesPlatform, shopperPushProblem } from '../../../src/contracts/apps.js';
import { CAP_MESSAGE, NO_CREDENTIALS_MESSAGE } from '../../../src/modules/shopper-push/index.js';
import { androidToken, installApp, makeShopper, newBusiness, orderEvent, placeOrder, reelInCategory, sessionFor, startWorld } from './support.js';

// Shopper push (PRD 10.11): devices, the three toggles and their consent records, order updates, new reels, offers with the
// weekly cap, the brand's own keys. One app and one push simulator for the file; each test works in its own business, or on
// its own devices of the main one, so no test sees another's audience.

const NOON = '2026-11-11T06:30:00Z'; // Wednesday 12:00 IST
const NIGHT = '2026-11-11T16:30:00Z'; // Wednesday 22:00 IST: quiet hours
const NEXT_MORNING = '2026-11-12T03:35:00Z'; // Thursday 09:05 IST, the same week

let w;
before(async () => {
  w = await startWorld();
});
after(async () => {
  await w?.close();
});

const requestKey = () => `rk-${crypto.randomBytes(8).toString('hex')}`;
const accepted = async (token) => (await w.received(token)).filter((r) => r.outcome === 'accepted');
const device = async (tenant, deviceId) => (await w.sql('SELECT * FROM shopper_push_devices WHERE tenant_id = $1 AND device_id = $2', [tenant.id, deviceId]))[0];
const consents = (tenant, deviceId) => w.sql(
  `SELECT c.toggle, c.granted, c.source FROM shopper_push_consents c JOIN shopper_push_devices d ON d.tenant_id = c.tenant_id AND d.id = c.device_row_id
   WHERE d.tenant_id = $1 AND d.device_id = $2 ORDER BY c.id`,
  [tenant.id, deviceId],
);
const offer = (b, extra = {}) => b.run(() => w.service.sendCampaign({ title: 'Diwali sale', body: 'Twenty percent off every lamp this week.', linkPath: '/shop', requestKey: requestKey(), ...extra }, null));
const runCampaign = (b, id) => b.run(() => w.service.work({ campaignId: id }));
const prefsOf = (body) => body && { permission: body.permission, orderUpdates: body.orderUpdates, offers: body.offers, newReels: body.newReels };

test('P-45 P-46 registering never opts in; the first order turns on order updates only; every change has its consent row', async () => {
  w.clock.set(NOON);
  const b = await newBusiness(w, 'pfortyfive');
  const session = sessionFor();
  const call = (method, path, body) => w.appCall(session, method, path, body, { host: b.host });

  // Browsing only: the permission was never asked and there is no token. Nothing is on.
  let res = await call('PUT', '/api/store/app/push/device', { token: null, permission: 'not_asked' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { permission: 'not_asked', orderUpdates: false, offers: false, newReels: false, configured: true });

  // After the first order the system prompt is granted and a token arrives: still nothing is on.
  const token = androidToken();
  res = await call('PUT', '/api/store/app/push/device', { token, permission: 'granted' });
  assert.deepEqual(prefsOf(res.body), { permission: 'granted', orderUpdates: false, offers: false, newReels: false });
  const row = await device(b.tenant, session.deviceId);
  assert.ok(row.token_enc.startsWith('v1.') && !row.token_enc.includes(token) && !row.token_hash.includes(token), 'the token is held encrypted');

  // The explainer may turn on order updates only.
  res = await call('PUT', '/api/store/app/push/prefs', { orderUpdates: true, offers: true, source: 'first_order_prompt' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fields.offers);
  res = await call('PUT', '/api/store/app/push/prefs', { orderUpdates: true, newReels: true, source: 'first_order_prompt' });
  assert.equal(res.status, 400);
  res = await call('PUT', '/api/store/app/push/prefs', { orderUpdates: true, source: 'first_order_prompt' });
  assert.deepEqual(prefsOf(res.body), { permission: 'granted', orderUpdates: true, offers: false, newReels: false });

  // Offers and new reels: an explicit true from settings, each with its own record and the time it was turned on.
  res = await call('PUT', '/api/store/app/push/prefs', { offers: true, newReels: true, source: 'settings' });
  assert.deepEqual(prefsOf(res.body), { permission: 'granted', orderUpdates: true, offers: true, newReels: true });
  const on = await device(b.tenant, session.deviceId);
  assert.ok(on.offers_on_at instanceof Date && on.new_reels_on_at instanceof Date);
  await call('PUT', '/api/store/app/push/prefs', { offers: true, source: 'settings' });
  assert.deepEqual(await consents(b.tenant, session.deviceId), [
    { toggle: 'order_updates', granted: true, source: 'first_order_prompt' },
    { toggle: 'offers', granted: true, source: 'settings' },
    { toggle: 'new_reels', granted: true, source: 'settings' },
  ], 'saving the same again records nothing new');

  // A field the app may not send is refused, not ignored.
  res = await call('PUT', '/api/store/app/push/prefs', { offers: false, source: 'settings', deviceId: 'abcdefabcdefabcdef' });
  assert.equal(res.status, 400);
  assert.equal((await consents(b.tenant, session.deviceId)).length, 3);

  // The permission is revoked in the phone's settings: the token goes and every toggle is off, on the record.
  res = await call('PUT', '/api/store/app/push/device', { token: null, permission: 'denied' });
  assert.deepEqual(prefsOf(res.body), { permission: 'denied', orderUpdates: false, offers: false, newReels: false });
  const denied = await device(b.tenant, session.deviceId);
  assert.equal(denied.token_enc, null);
  assert.equal(denied.token_hash, '');
  const revoked = (await consents(b.tenant, session.deviceId)).slice(3).map((c) => [c.toggle, c.granted, c.source]).sort();
  assert.deepEqual(revoked, [['new_reels', false, 'system_permission'], ['offers', false, 'system_permission'], ['order_updates', false, 'system_permission']]);
  // A token sent with the permission denied is not kept.
  await call('PUT', '/api/store/app/push/device', { token: androidToken(), permission: 'denied' });
  assert.equal((await device(b.tenant, session.deviceId)).token_enc, null);

  // Without an app session (a browser, or no gate) the calls are refused.
  res = await w.appCall(null, 'GET', '/api/store/app/push/prefs', undefined, { host: b.host });
  assert.equal(res.status, 401);
});

test('P-47 a device never opted in to Offers receives none, whatever the seller sends, and the seller cannot name a device', async () => {
  w.clock.set(NOON);
  const b = await newBusiness(w, 'pfortyseven');
  const opted = await installApp(w, { toggles: { offers: true }, host: b.host });
  const ordersOnly = await installApp(w, { toggles: { orderUpdates: true, newReels: true }, host: b.host });
  const nothing = await installApp(w, { host: b.host });

  const campaign = await offer(b);
  assert.equal(campaign.status, 'queued');
  assert.equal(campaign.audienceCount, 1);
  // The queue's job and the schedule's both run it at once: each device still gets it once.
  await Promise.all([runCampaign(b, campaign.id), runCampaign(b, campaign.id)]);
  assert.equal(await runCampaign(b, campaign.id), null, 'a sent campaign is not run again');
  const [done] = (await b.run(() => w.service.campaigns({}))).items;
  assert.deepEqual([done.status, done.sentCount, done.failedCount], ['sent', 1, 0]);
  assert.equal((await w.received(opted.token)).length, 1);
  const [push] = await accepted(opted.token);
  assert.equal(push.title, 'Diwali sale');
  assert.deepEqual(push.data, { link: '/shop', kind: 'offer' });
  assert.equal((await w.received(ordersOnly.token)).length, 0);
  assert.equal((await w.received(nothing.token)).length, 0);

  // A campaign names no device, no shopper and no other audience.
  for (const extra of [{ deviceIds: [1] }, { deviceId: 'abcdefabcdefabcdef' }, { shopperId: 1 }, { audience: 'all' }, { tenantId: 1 }]) {
    await assert.rejects(offer(b, extra), (err) => err.code === 'validation_failed', JSON.stringify(extra));
  }
  assert.equal((await w.received(ordersOnly.token)).length + (await w.received(nothing.token)).length, 0);
});

test('P-48 turning Offers off stops offers at once, even one already queued, and order updates continue', async () => {
  const b = await newBusiness(w, 'pfortyeight');
  w.clock.set(NIGHT);
  const leaving = await installApp(w, { toggles: { offers: true, orderUpdates: true }, host: b.host });
  const staying = await installApp(w, { toggles: { offers: true }, host: b.host });

  // Written at 22:00, it waits for the morning.
  const campaign = await offer(b);
  assert.equal(campaign.status, 'queued');
  assert.equal(await runCampaign(b, campaign.id), null);
  assert.equal((await w.received(staying.token)).length, 0, 'nothing in quiet hours');

  // The shopper turns Offers off before the morning.
  const res = await w.appCall(leaving.session, 'PUT', '/api/store/app/push/prefs', { offers: false, source: 'settings' }, { host: b.host });
  assert.deepEqual([res.body.offers, res.body.orderUpdates], [false, true]);
  assert.deepEqual((await consents(b.tenant, leaving.session.deviceId)).at(-1), { toggle: 'offers', granted: false, source: 'settings' });

  // In the morning the schedule hands it to the queue, and the queue's job sends it.
  w.clock.set(NEXT_MORNING);
  await w.sql('UPDATE push_campaigns SET created_at = $2 WHERE tenant_id = $1', [b.tenant.id, new Date(NIGHT)]);
  assert.ok((await w.service.scan()).campaigns >= 1);
  await w.app.ctx.platform.queue.drain('shopper-push.send', (job) => w.service.work(job.payload));
  const [done] = (await b.run(() => w.service.campaigns({}))).items;
  assert.equal(done.status, 'sent');
  assert.equal(done.sentCount, 1);
  assert.equal((await w.received(leaving.token)).length, 0, 'a withdrawn consent holds for a push already queued');
  assert.equal((await accepted(staying.token)).length, 1);

  const second = await offer(b);
  assert.equal(second.audienceCount, 1);
  await runCampaign(b, second.id);
  assert.equal((await w.received(leaving.token)).length, 0, 'no more offers');

  // Order updates continue, at once, even in quiet hours.
  w.clock.set(NIGHT);
  const order = await placeOrder(w, { tenant: b.tenant });
  const follow = await w.appCall(leaving.session, 'POST', '/api/store/app/push/orders', { orderToken: order.public_token }, { host: b.host });
  assert.equal(follow.status, 204, follow.text);
  await b.run(async () => w.service.orderEvent(await orderEvent(w, order, 'order.shipped', { tenant: b.tenant })));
  const got = await accepted(leaving.token);
  assert.equal(got.length, 1);
  assert.equal(got[0].data.kind, 'order_update');
});

test('P-49 an offer over the weekly cap is refused with "Weekly offer limit reached", and two sent at once cannot both pass', async () => {
  w.clock.set(NOON);
  const phone = await installApp(w, { toggles: { offers: true } });
  const send = (title, key = requestKey()) => w.api('POST', '/push-campaigns', { title, body: 'New lamps are in.', linkPath: '/shop', requestKey: key });

  const firstKey = requestKey();
  const first = await send('First offer', firstKey);
  assert.equal(first.status, 202, first.text);
  assert.equal(first.body.status, 'queued');

  // Two at once against the one push left this week (the cap is 2).
  const [a, b] = await Promise.all([send('Second offer'), send('Third offer')]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409], `${a.text} ${b.text}`);
  const refused = a.status === 409 ? a : b;
  const passed = a.status === 202 ? a : b;
  assert.equal(refused.body.error, CAP_MESSAGE);
  assert.equal(CAP_MESSAGE, 'Weekly offer limit reached');
  for (const c of [first, passed]) await w.inTenant(() => w.service.work({ campaignId: c.body.id }));
  assert.equal((await accepted(phone.token)).length, 2);

  const fourth = await send('Fourth offer');
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error, 'Weekly offer limit reached');

  // The same request again is the first answer again, and sends nothing more.
  const again = await send('First offer', firstKey);
  assert.equal(again.status, 202);
  assert.equal(again.body.id, first.body.id);
  await w.inTenant(() => w.service.work({ campaignId: first.body.id }));
  assert.equal((await w.received(phone.token)).length, 2);

  // The refused ones stay in the seller's list as blocked by the cap.
  const list = await w.api('GET', '/push-campaigns');
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.items.filter((c) => c.blockReason === 'weekly_cap' && c.status === 'blocked').length, 2);
  const summary = await w.api('GET', '/push-campaigns/summary');
  assert.equal(summary.body.weeklyCap, 2);
  assert.equal(summary.body.reachableNow, 0, 'everyone opted in has had this week\'s offers');

  // The next week (from Monday, India time) the cap starts again.
  w.clock.set('2026-11-16T06:30:00Z');
  const nextWeek = await send('Next week');
  assert.equal(nextWeek.status, 202, nextWeek.text);
  await w.inTenant(() => w.service.work({ campaignId: nextWeek.body.id }));
  assert.equal((await accepted(phone.token)).length, 3);
});

test('one order event makes one push per device, even delivered twice at once, and its words hold nothing personal', async () => {
  w.clock.set(NOON);
  const shopperId = await makeShopper(w);
  const android = await installApp(w, { shopperId, toggles: { orderUpdates: true } });
  const iphone = await installApp(w, { shopperId, platform: 'ios', toggles: { orderUpdates: true } });
  const off = await installApp(w, { shopperId, toggles: { newReels: true } });
  const order = await placeOrder(w, { shopperId });
  // A guest install follows the order by its token; a stranger's install does not get it.
  const guest = await installApp(w, { toggles: { orderUpdates: true } });
  const stranger = await installApp(w, { toggles: { orderUpdates: true } });
  const follow = await w.appCall(guest.session, 'POST', '/api/store/app/push/orders', { orderToken: order.public_token });
  assert.equal(follow.status, 204, follow.text);
  const other = await makeShopper(w);
  const notYours = await installApp(w, { shopperId: other, toggles: { orderUpdates: true } });
  assert.equal((await w.appCall(notYours.session, 'POST', '/api/store/app/push/orders', { orderToken: order.public_token })).status, 404, 'another shopper\'s order');

  const event = await orderEvent(w, order, 'order.shipped');
  await w.inTenant(() => Promise.all([w.service.orderEvent(event), w.service.orderEvent(event)]));
  await w.inTenant(() => w.service.orderEvent(event));
  for (const inst of [android, iphone, guest]) assert.equal((await w.received(inst.token)).length, 1, inst.session.platform);
  for (const inst of [off, stranger, notYours]) assert.equal((await w.received(inst.token)).length, 0);

  const [push] = await w.received(iphone.token);
  assert.equal(push.wire, 'apns');
  assert.equal(push.title, 'On its way');
  assert.equal(push.body, `Order ${order.order_number} has shipped. Tap to track it.`);
  assert.deepEqual(push.data, { link: `/account/orders/${order.order_number}`, kind: 'order_update' });
  const sent = (await w.received()).filter((r) => [android.token, iphone.token, guest.token].includes(r.token));
  for (const r of sent) {
    const text = JSON.stringify({ title: r.title, body: r.body, data: r.data });
    for (const personal of ['Lake Road', '411001', '9876543210', 'Asha', 'Pune', 'Maharashtra', '500']) assert.ok(!text.includes(personal), personal);
    assert.equal(namesPlatform(text), false);
    assert.equal(shopperPushProblem({ title: r.title, body: r.body, data: r.data }), null);
  }

  // Through the order event bus: the listener takes the next event, and the one already pushed is not pushed again.
  await orderEvent(w, order, 'order.delivered');
  await w.app.ctx.orderEvents.drain();
  await w.app.ctx.orderEvents.drain();
  assert.deepEqual((await w.received(android.token)).map((r) => r.title), ['On its way', 'Delivered']);
  assert.equal((await w.received(guest.token)).length, 2);
  // An order event that is no shopper push sends nothing.
  await w.inTenant(async () => w.service.orderEvent(await orderEvent(w, order, 'order.packed')));
  assert.equal((await w.received(android.token)).length, 2);
});

test('a token the provider rejects is deleted, with its toggles, and is never tried again', async () => {
  w.clock.set(NOON);
  const shopperId = await makeShopper(w);
  const gone = await installApp(w, { shopperId, toggles: { orderUpdates: true } });
  const bad = await installApp(w, { shopperId, platform: 'ios', toggles: { orderUpdates: true } });
  const fine = await installApp(w, { shopperId, toggles: { orderUpdates: true } });
  await w.sim.post('/tokens', { token: gone.token, state: 'unregistered' });
  await w.sim.post('/tokens', { token: bad.token, state: 'invalid' });

  const order = await placeOrder(w, { shopperId });
  await w.inTenant(async () => w.service.orderEvent(await orderEvent(w, order, 'order.confirmed')));
  for (const [inst, reason] of [[gone, 'unregistered'], [bad, 'invalid_token']]) {
    const row = await device(w.tenant, inst.session.deviceId);
    assert.equal(row.token_enc, null, reason);
    assert.equal(row.token_hash, '');
    assert.equal(row.delete_reason, reason);
    assert.ok(row.deleted_at);
    assert.equal(row.order_updates_on_at, null);
    assert.deepEqual((await consents(w.tenant, inst.session.deviceId)).at(-1), { toggle: 'order_updates', granted: false, source: 'token_rejected' });
  }
  await w.inTenant(async () => w.service.orderEvent(await orderEvent(w, order, 'order.shipped')));
  assert.equal((await w.received(gone.token)).length, 1, 'tried once, never again');
  assert.equal((await w.received(bad.token)).length, 1);
  assert.equal((await accepted(fine.token)).length, 2);

  // A fresh token brings the install back, with nothing on until the shopper says so.
  const res = await w.appCall(gone.session, 'PUT', '/api/store/app/push/device', { token: androidToken(), permission: 'granted' });
  assert.deepEqual(prefsOf(res.body), { permission: 'granted', orderUpdates: false, offers: false, newReels: false });
  assert.equal((await device(w.tenant, gone.session.deviceId)).deleted_at, null);
});

test('a provider that hangs, answers junk or fails is never sent the same push twice; only a throttled one is tried again', async () => {
  w.clock.set(NOON);
  const shopperId = await makeShopper(w);
  const hang = await installApp(w, { shopperId, toggles: { orderUpdates: true } });
  const junk = await installApp(w, { shopperId, toggles: { orderUpdates: true } });
  const error = await installApp(w, { shopperId, platform: 'ios', toggles: { orderUpdates: true } });
  const slowIos = await installApp(w, { shopperId, platform: 'ios', toggles: { orderUpdates: true } });
  const throttle = await installApp(w, { shopperId, toggles: { orderUpdates: true } });
  await w.sim.post('/behaviour', { kind: 'hang', token: hang.token });
  await w.sim.post('/behaviour', { kind: 'junk', token: junk.token });
  await w.sim.post('/behaviour', { kind: 'error', token: error.token });
  await w.sim.post('/behaviour', { kind: 'hang', token: slowIos.token });
  await w.sim.post('/behaviour', { kind: 'throttle', token: throttle.token, retryAfter: 0 });

  const order = await placeOrder(w, { shopperId });
  const event = await orderEvent(w, order, 'order.shipped');
  await w.inTenant(() => w.service.orderEvent(event));
  await w.inTenant(() => w.service.orderEvent(event)); // delivered again after the failures
  for (const inst of [hang, junk, error, slowIos]) assert.equal((await w.received(inst.token)).length, 1, `${inst.session.platform} once`);
  assert.deepEqual((await w.received(throttle.token)).map((r) => r.outcome), ['throttle', 'accepted']);

  const rows = await w.sql(
    `SELECT d.device_id, l.status, l.reason, l.attempts FROM shopper_push_log l JOIN shopper_push_devices d ON d.tenant_id = l.tenant_id AND d.id = l.device_row_id
     WHERE l.tenant_id = $1 AND l.source_kind = 'order_event' AND l.source_id = $2`,
    [w.tenant.id, String(event.id)],
  );
  const by = Object.fromEntries(rows.map((r) => [r.device_id, r]));
  assert.deepEqual([by[hang.session.deviceId].status, by[hang.session.deviceId].reason], ['failed', 'timeout']);
  assert.deepEqual([by[slowIos.session.deviceId].status, by[slowIos.session.deviceId].reason], ['failed', 'timeout']);
  assert.equal(by[junk.session.deviceId].status, 'failed');
  assert.equal(by[error.session.deviceId].status, 'failed');
  assert.deepEqual([by[throttle.session.deviceId].status, Number(by[throttle.session.deviceId].attempts)], ['sent', 2]);
  // The provider said nothing about these tokens, so they stay; a passing fault is not the brand's keys being refused.
  for (const inst of [hang, junk, error]) assert.ok((await device(w.tenant, inst.session.deviceId)).token_enc);
  const keys = await w.inTenant(() => w.service.credentials.get());
  assert.deepEqual([keys.fcm.status, keys.apns.status], ['ok', 'ok']);
  // The next event reaches them as usual.
  await w.inTenant(async () => w.service.orderEvent(await orderEvent(w, order, 'order.delivered')));
  assert.equal((await accepted(hang.token)).length, 1);
});

test('a brand with no push keys sends nothing, and only the seller is told why', async () => {
  w.clock.set(NOON);
  const b = await newBusiness(w, 'nokeys', { credentials: false });
  const inst = await installApp(w, { toggles: { offers: true, orderUpdates: true }, host: b.host });
  await assert.rejects(offer(b), (err) => err.code === 'conflict' && err.message === NO_CREDENTIALS_MESSAGE);
  assert.deepEqual(await w.sql('SELECT status, block_reason FROM push_campaigns WHERE tenant_id = $1', [b.tenant.id]), [{ status: 'blocked', block_reason: 'no_credentials' }]);
  const summary = await b.run(() => w.service.summary());
  assert.deepEqual(summary.credentials, { android: false, ios: false });
  assert.equal(summary.optedIn.offers, 1);

  const order = await placeOrder(w, { tenant: b.tenant });
  await w.appCall(inst.session, 'POST', '/api/store/app/push/orders', { orderToken: order.public_token }, { host: b.host });
  await b.run(async () => w.service.orderEvent(await orderEvent(w, order, 'order.shipped', { tenant: b.tenant })));
  await b.run(async () => w.service.orderEvent(await orderEvent(w, order, 'order.delivered', { tenant: b.tenant })));
  assert.equal((await w.received(inst.token)).length, 0);
  const alerts = await w.sql(`SELECT audience, message FROM alerts WHERE tenant_id = $1 AND kind = 'app.push_keys'`, [b.tenant.id]);
  assert.equal(alerts.length, 1, 'the owner is told once');
  assert.equal(alerts[0].audience, 'owner');
  assert.match(alerts[0].message, /push keys/);

  // The shopper's app learns only that push is not set up: no reason, no words for the seller.
  const prefs = await w.appCall(inst.session, 'GET', '/api/store/app/push/prefs', undefined, { host: b.host });
  assert.equal(prefs.body.configured, false);
  assert.ok(!/key|publish/i.test(prefs.text));
});

test('a business cannot reach another business\'s devices, campaigns or orders', async () => {
  w.clock.set(NOON);
  const mine = await newBusiness(w, 'tulsi');
  const theirs = await newBusiness(w, 'gulmohar');
  const myPhone = await installApp(w, { toggles: { offers: true, orderUpdates: true }, host: mine.host });
  const theirPhone = await installApp(w, { toggles: { offers: true, orderUpdates: true }, host: theirs.host });

  // One install id in both businesses is two rows, one each: a choice made in one is not the other's.
  const shared = sessionFor();
  await w.appCall(shared, 'PUT', '/api/store/app/push/prefs', { offers: true, source: 'settings' }, { host: theirs.host });
  assert.equal((await w.appCall(shared, 'GET', '/api/store/app/push/prefs', undefined, { host: mine.host })).body.offers, false);

  const campaign = await offer(mine);
  assert.equal(campaign.audienceCount, 1);
  await runCampaign(mine, campaign.id);
  assert.equal((await accepted(myPhone.token)).length, 1);
  assert.equal((await w.received(theirPhone.token)).length, 0);

  // Running another business's campaign by its id, as this business, does nothing.
  const theirCampaign = await offer(theirs);
  assert.equal(await runCampaign(mine, theirCampaign.id), null);
  assert.equal((await w.received(theirPhone.token)).length, 0);
  assert.equal((await theirs.run(() => w.service.campaigns({}))).items.length, 1);
  assert.equal((await mine.run(() => w.service.campaigns({}))).items.some((c) => c.id === theirCampaign.id), false);

  // Their order cannot be followed from my app, and an event of theirs handed to my business finds nothing.
  const theirOrder = await placeOrder(w, { tenant: theirs.tenant });
  assert.equal((await w.appCall(myPhone.session, 'POST', '/api/store/app/push/orders', { orderToken: theirOrder.public_token }, { host: mine.host })).status, 404);
  const event = await orderEvent(w, theirOrder, 'order.shipped', { tenant: theirs.tenant });
  assert.deepEqual(await mine.run(() => w.service.orderEvent(event)), { claimed: 0 });
  assert.equal((await w.received(myPhone.token)).length, 1);

  // The database refuses a push log row of mine on their device.
  const [theirRow] = await w.sql('SELECT id FROM shopper_push_devices WHERE tenant_id = $1 ORDER BY id LIMIT 1', [theirs.tenant.id]);
  await assert.rejects(w.sql(
    `INSERT INTO shopper_push_log (tenant_id, device_row_id, cap_subject, kind, source_kind, source_id, week_start) VALUES ($1, $2, 'd:1', 'offer', 'campaign', '1', '2026-11-09')`,
    [mine.tenant.id, theirRow.id],
  ));
});

test('push words never hold an address, a phone number, payment details or the platform\'s name', async () => {
  w.clock.set(NOON);
  const cases = [
    [{ body: 'Call +91 98765 43210 to order' }, 'body'],
    [{ body: 'Visit 12 MG Road for the sale' }, 'body'],
    [{ body: 'Deliveries to 560001 are free this week' }, 'body'],
    [{ body: 'Pay to kesar@okaxis and save' }, 'body'],
    [{ body: 'Card ending 4242 gets ten percent off' }, 'body'],
    [{ body: 'Write to help@kesar.example for a code' }, 'body'],
    [{ body: 'Now on Bhava: our new lamps' }, 'body'],
    [{ title: 'Bhava week' }, 'title'],
    [{ linkPath: '/admin' }, 'linkPath'],
    [{ linkPath: '/api/store/cart' }, 'linkPath'],
    [{ title: 'x'.repeat(66) }, 'title'],
    [{ body: 'y'.repeat(179) }, 'body'],
  ];
  for (const [patch, field] of cases) {
    const res = await w.api('POST', '/push-campaigns', { title: 'Sale', body: 'New lamps are in.', linkPath: '/shop', requestKey: requestKey(), ...patch });
    assert.equal(res.status, 400, `${JSON.stringify(patch)}: ${res.text}`);
    assert.ok(res.body.fields?.[field], `${JSON.stringify(patch)} names ${field}: ${res.text}`);
  }
  const blocked = await w.sql(`SELECT count(*)::int AS n FROM push_campaigns WHERE tenant_id = $1 AND block_reason = 'wording'`, [w.tenant.id]);
  assert.ok(blocked[0].n >= 9, 'a refused offer is kept as blocked');
  assert.equal((await w.sql(`SELECT count(*)::int AS n FROM shopper_push_log l JOIN push_campaigns c ON c.tenant_id = l.tenant_id AND l.source_kind = 'campaign' AND l.source_id = c.id::text WHERE c.block_reason = 'wording'`))[0].n, 0, 'nothing claimed for it');
});

test('a reel added to a category pushes once to devices that turned on New reels, after quiet hours, inside the cap', async () => {
  w.clock.set(NIGHT);
  const fan = await installApp(w, { toggles: { newReels: true } });
  const notFan = await installApp(w, { toggles: { orderUpdates: true } });
  const { reel, category } = await reelInCategory(w);
  const events = await w.sql('SELECT id FROM shopper_push_events WHERE tenant_id = $1 AND category_id = $2', [w.tenant.id, category.id]);
  assert.equal(events.length, 1, 'the trigger wrote the outbox row');
  // The outbox is read once a reel has been in for a minute (several added together make one push).
  await w.sql('UPDATE shopper_push_events SET created_at = $2 WHERE tenant_id = $1', [w.tenant.id, new Date(new Date(NIGHT).getTime() - 120_000)]);

  assert.deepEqual(await w.inTenant(() => w.service.runReels()), { pushed: false }, 'it waits out quiet hours');
  assert.equal((await w.received(fan.token)).length, 0);

  w.clock.set(NEXT_MORNING);
  const result = await w.inTenant(() => w.service.runReels());
  assert.equal(result.pushed, true);
  const [push] = await accepted(fan.token);
  assert.equal(push.title, 'New in Diwali edit');
  assert.deepEqual(push.data, { link: `/r/${reel.slug}`, kind: 'new_reel' });
  assert.equal((await w.received(notFan.token)).length, 0);

  // Taken out and put back is still the one push.
  await w.sql('DELETE FROM category_reels WHERE tenant_id = $1 AND category_id = $2', [w.tenant.id, category.id]);
  await w.sql('INSERT INTO category_reels (tenant_id, category_id, page_id, position) VALUES ($1, $2, $3, 0)', [w.tenant.id, category.id, reel.id]);
  await w.inTenant(() => w.service.runReels());
  assert.equal((await w.received(fan.token)).length, 1);
  // It counts against the week's cap for that device.
  const [log] = await w.sql(`SELECT kind, week_start::text AS week FROM shopper_push_log WHERE tenant_id = $1 AND source_kind = 'category_reel'`, [w.tenant.id]);
  assert.deepEqual(log, { kind: 'new_reel', week: '2026-11-09' });
});

test('signing out turns the install\'s choices off; the next person on it starts with nothing on', async () => {
  w.clock.set(NOON);
  const first = await makeShopper(w);
  const second = await makeShopper(w);
  const inst = await installApp(w, { shopperId: first, toggles: { orderUpdates: true, newReels: true } });
  assert.equal(await w.inTenant(() => w.app.db.tx((t) => w.service.detachShopper(t, inst.session.deviceId))), true);
  const row = await device(w.tenant, inst.session.deviceId);
  assert.equal(row.shopper_id, null);
  assert.deepEqual([row.order_updates_on_at, row.offers_on_at, row.new_reels_on_at], [null, null, null]);
  assert.deepEqual((await consents(w.tenant, inst.session.deviceId)).slice(-2).map((c) => [c.toggle, c.granted, c.source]), [['order_updates', false, 'sign_out'], ['new_reels', false, 'sign_out']]);

  // The first shopper turns things on again; then another signs in on the same install without a sign-out first.
  const back = { ...inst.session, guest: false, shopperId: first };
  await w.appCall(back, 'PUT', '/api/store/app/push/prefs', { offers: true, source: 'settings' });
  const next = { ...inst.session, guest: false, shopperId: second };
  const res = await w.appCall(next, 'GET', '/api/store/app/push/prefs');
  assert.deepEqual(prefsOf(res.body), { permission: 'granted', orderUpdates: false, offers: false, newReels: false });
  await w.appCall(next, 'PUT', '/api/store/app/push/prefs', { orderUpdates: true, source: 'settings' });
  const now = await device(w.tenant, inst.session.deviceId);
  assert.equal(Number(now.shopper_id), second);
  assert.equal(now.offers_on_at, null, 'the first shopper\'s offers are not the second\'s');
});

test('the brand\'s own push keys are stored encrypted, shown masked, audited without a word of them, and checked on saving', async () => {
  const view = await w.inTenant(() => w.service.credentials.get());
  assert.deepEqual([view.fcm.set, view.fcm.status, view.apns.set, view.apns.status, view.apns.topic], [true, 'ok', true, 'ok', 'com.example.kesarapp']);
  const fcm = JSON.parse(w.sim.fcmCredentials().serviceAccount);
  assert.notEqual(view.fcm.clientEmailMasked, fcm.client_email);
  assert.match(view.fcm.clientEmailMasked, /•••@/);
  const [row] = await w.sql('SELECT fcm_service_account_enc, apns_key_enc FROM app_push_credentials WHERE tenant_id = $1', [w.tenant.id]);
  assert.ok(row.fcm_service_account_enc.startsWith('v1.') && !row.fcm_service_account_enc.includes('PRIVATE KEY'));
  assert.ok(row.apns_key_enc.startsWith('v1.') && !row.apns_key_enc.includes('PRIVATE KEY'));
  const audit = await w.sql(`SELECT details::text AS details FROM audit_log WHERE tenant_id = $1 AND action = 'push_credentials.save'`, [w.tenant.id]);
  assert.ok(audit.length >= 1);
  for (const a of audit) assert.ok(!/PRIVATE|BEGIN|@/.test(a.details), a.details);
  // Not a service account, not a .p8 key: refused, and what was saved stays.
  await assert.rejects(w.inTenant(() => w.service.credentials.save({ fcm: { serviceAccount: '{"type":"nope"}' } }, w.owner)), (err) => Boolean(err.fields?.['fcm.serviceAccount']));
  await assert.rejects(w.inTenant(() => w.service.credentials.save({ apns: { keyId: 'ABCDE12345', teamId: 'ABCDE12345', key: 'not a key', env: 'production' } }, w.owner)), (err) => Boolean(err.fields?.['apns.key']));
  assert.equal((await w.inTenant(() => w.service.credentials.get())).fcm.status, 'ok');
});

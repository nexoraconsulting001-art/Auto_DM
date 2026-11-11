// Phase 5 contract: the push adapter (PRD 10.5) against tools/sim/push, both wire formats, and Bhava's own WhatsApp and
// email senders for sellers (PRD 5.13) against the existing simulators. Nothing here reaches Google, Apple or Meta.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../../../src/adapters/http.js';
import { createEmail } from '../../../src/adapters/email/index.js';
import { PushError, createPush } from '../../../src/adapters/push/index.js';
import { createWhatsApp } from '../../../src/adapters/whatsapp/index.js';
import { PUSH_ERROR_KINDS } from '../../../src/contracts/notifications.js';
import { createEmail as createEmailSim } from '../../../tools/sim/email/index.mjs';
import { createPush as createPushSim } from '../../../tools/sim/push/index.mjs';
import { createWhatsApp as createWhatsAppSim } from '../../../tools/sim/whatsapp/index.mjs';

let sim;
let push;
const ANDROID = 'fcm-token-0123456789abcdef';
const IOS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const message = (platform, extra = {}) => ({
  platform, token: platform === 'ios' ? IOS : ANDROID, title: '5 new orders', body: 'Tap to see them.',
  data: { tenantId: 7, kind: 'order.new', link: '/orders', count: 5 }, collapseKey: 't7.order.new.1', ttl: 600, ...extra,
});
const configFor = (extra = {}) => {
  const fcm = sim.fcmCredentials();
  const apns = sim.apnsCredentials();
  return {
    pushDriver: 'fcm,apns', fcmProjectId: fcm.projectId, fcmServiceAccount: fcm.serviceAccount, fcmBaseUrl: sim.url,
    apnsKeyId: apns.keyId, apnsTeamId: apns.teamId, apnsKey: apns.key, apnsTopic: apns.topic, apnsBaseUrl: sim.apnsUrl, providerTimeoutMs: 700, ...extra,
  };
};
const refused = (kind, extra = () => true) => (err) => {
  assert.ok(err instanceof PushError && err instanceof ProviderError, `a ProviderError, not ${err}`);
  assert.equal(err.kind, kind);
  assert.ok(PUSH_ERROR_KINDS.includes(err.kind));
  assert.equal(JSON.stringify({ ...err, message: err.message }).includes(ANDROID) || JSON.stringify({ ...err, message: err.message }).includes(IOS), false, 'the error holds no token');
  return extra(err);
};

before(async () => {
  sim = createPushSim();
  await sim.start();
  push = createPush(configFor());
});
after(async () => {
  push?.close();
  await sim?.close();
});

test('with no driver nothing is sent and the answer says not_configured', async () => {
  const none = createPush({});
  assert.equal(none.driver, 'none');
  assert.deepEqual([none.configured('android'), none.configured('ios')], [false, false]);
  assert.deepEqual(await none.send(message('android')), { ok: false, reason: 'not_configured' });
  const fcmOnly = createPush({ ...configFor(), pushDriver: 'fcm' });
  assert.deepEqual(await fcmOnly.send(message('ios')), { ok: false, reason: 'not_configured' }, 'a platform with no driver is not configured, and the other still sends');
  assert.equal((await fcmOnly.send(message('android'))).ok, true);
  assert.throws(() => createPush({ pushDriver: 'sms' }), /Unknown PUSH_DRIVER/);
  assert.throws(() => createPush({ pushDriver: 'fcm' }), /FCM_PROJECT_ID/);
  assert.throws(() => createPush({ pushDriver: 'apns', apnsKeyId: 'k', apnsTeamId: 't', apnsTopic: 'x', apnsKey: 'nonsense' }), /APNS_KEY/);
  await assert.rejects(() => none.send({ ...message('android'), platform: 'web' }), /android or ios/);
  await sim.post('/reset');
});

test('FCM HTTP v1: the payload carries the title, the data as text, the collapse key and the ttl', async () => {
  await sim.post('/reset');
  const sent = await push.send(message('android'));
  assert.equal(sent.ok, true);
  assert.match(sent.id, /^projects\/sim-bhava-owner\/messages\//);
  const [got] = await sim.received();
  assert.deepEqual([got.wire, got.platform, got.token, got.title, got.body, got.collapseKey, got.ttl, got.outcome], ['fcm', 'android', ANDROID, '5 new orders', 'Tap to see them.', 't7.order.new.1', 600, 'accepted']);
  assert.deepEqual(got.data, { tenantId: '7', kind: 'order.new', link: '/orders', count: '5' });
  assert.equal(got.raw.message.android.notification.tag, 't7.order.new.1', 'a later push with the same key replaces this one');
  // One OAuth exchange serves every send until the token runs out.
  await push.send(message('android'));
  assert.equal((await sim.calls({ path: '/token' })).length, 1);
});

test('APNs over HTTP/2: a provider token, the topic, the collapse id, an expiry, and the data beside aps', async () => {
  await sim.post('/reset');
  const sent = await push.send(message('ios'));
  assert.equal(sent.ok, true);
  assert.match(sent.id, /^[0-9a-f-]{36}$/);
  const [got] = await sim.received();
  assert.deepEqual([got.wire, got.platform, got.token, got.title, got.body, got.collapseKey, got.topic, got.outcome], ['apns', 'ios', IOS, '5 new orders', 'Tap to see them.', 't7.order.new.1', 'app.sim.bhava.business', 'accepted']);
  assert.ok(got.ttl > 590 && got.ttl <= 600);
  assert.deepEqual(got.data, { tenantId: '7', kind: 'order.new', link: '/orders', count: '5' });
  assert.equal(got.headers['apns-push-type'], 'alert');
  assert.equal(got.raw.aps.alert.title, '5 new orders');
});

for (const [platform, wire] of [['android', 'fcm'], ['ios', 'apns']]) {
  test(`${wire}: every refusal is a ProviderError with one of the five kinds`, async () => {
    await sim.post('/reset');
    const token = message(platform).token;

    await sim.post('/tokens', { token, state: 'unregistered' });
    await assert.rejects(() => push.send(message(platform)), refused('unregistered', (err) => err.retryable === false && err.delivery === 'none'), 'P-23: the caller deletes this token');
    await sim.post('/tokens', { token, state: 'invalid' });
    await assert.rejects(() => push.send(message(platform)), refused('invalid_token', (err) => err.retryable === false));
    await sim.post('/tokens', { token, state: 'ok' });

    await sim.post('/behaviour', { kind: 'throttle', wire, retryAfter: 30 });
    await assert.rejects(() => push.send(message(platform)), refused('throttled', (err) => err.retryable === true && err.retryAfter === 30 && err.status === 429));
    await sim.post('/behaviour', { kind: 'error', wire });
    await assert.rejects(() => push.send(message(platform)), refused('unavailable', (err) => err.retryable === true && err.status === 500));
    await sim.post('/behaviour', { kind: 'junk', wire });
    await assert.rejects(() => push.send(message(platform)), refused('unavailable', (err) => err.code === 'malformed'));
    await sim.post('/behaviour', { kind: 'hang', wire });
    await assert.rejects(() => push.send(message(platform)), refused('timeout', (err) => err.retryable === true));
    await sim.post('/behaviour', { kind: 'slow', wire, delayMs: 200 });
    assert.equal((await push.send(message(platform))).ok, true, 'a slow answer inside the timeout is still an answer');
    await sim.post('/behaviour', { kind: 'slow', wire, delayMs: 1500 });
    await assert.rejects(() => push.send(message(platform)), refused('timeout'));
    // Behaviours for one wire leave the other alone, and all are used up.
    assert.deepEqual((await sim.get('/behaviour')).behaviours, []);
    assert.equal((await push.send(message(platform))).ok, true);

    const kept = await sim.received();
    assert.equal(kept.every((p) => p.wire === wire && p.token === token), true, 'every payload is kept, refused ones included');
    assert.deepEqual(kept.map((p) => p.outcome), ['unregistered', 'invalid', 'throttle', 'error', 'junk', 'hang', 'accepted', 'slow', 'accepted']);
  });
}

test('credentials: a wrong key, topic or project is refused as unavailable or invalid_token; forCredentials sends for another key', async () => {
  await sim.post('/reset');
  const brand = push.forCredentials({ apns: { ...sim.apnsCredentials(), topic: 'app.another.brand' } });
  assert.deepEqual(brand.drivers, ['apns']);
  await assert.rejects(() => brand.send(message('ios')), refused('invalid_token', (err) => err.code === 'DeviceTokenNotForTopic'));
  assert.deepEqual(await brand.send(message('android')), { ok: false, reason: 'not_configured' });
  brand.close();
  const wrongProject = push.forCredentials({ fcm: { ...sim.fcmCredentials(), projectId: 'another-project' } });
  await assert.rejects(() => wrongProject.send(message('android')), refused('invalid_token', (err) => err.code === 'SENDER_ID_MISMATCH'));

  const stale = createPush(configFor());
  await sim.post('/credentials/rotate');
  await assert.rejects(() => stale.send(message('ios')), refused('unavailable', (err) => err.code === 'InvalidProviderToken' && err.status === 403));
  await assert.rejects(() => stale.send(message('android')), refused('unavailable'));
  stale.close();
  push.close();
  push = createPush(configFor());
  assert.equal((await push.send(message('ios'))).ok, true);
  assert.equal((await push.send(message('android'))).ok, true);

  // A simulator address never starts in production, and no other host is taken for Google or Apple.
  assert.throws(() => createPush(configFor(), { env: { NODE_ENV: 'production' } }), /simulator/);
  assert.throws(() => createPush(configFor({ fcmBaseUrl: 'https://fcm.example.net' })), /not an allowed address/);
  assert.throws(() => createPush(configFor({ apnsBaseUrl: 'https://push.example.net' })), /not an allowed address/);
  const down = createPush(configFor({ apnsBaseUrl: 'http://127.0.0.1:9', pushDriver: 'apns' }));
  await assert.rejects(() => down.send(message('ios')), (err) => err instanceof PushError && ['unavailable', 'timeout'].includes(err.kind));
  down.close();
});

test('Bhava\'s own WhatsApp number: a seller template from the platform phone id, and not_configured without one', async () => {
  const whatsapp = createWhatsAppSim({ token: 'platform-token' });
  await whatsapp.start();
  try {
    const adapter = createWhatsApp({ whatsappBaseUrl: whatsapp.url, platformWhatsappPhoneId: '1000', platformWhatsappToken: 'platform-token', platformWhatsappTemplates: { bhava_order_new: 'order_new_v2' } });
    assert.equal(adapter.platform.configured, true);
    const { messageId } = await adapter.platform.send({ to: '919876500011', template: 'login_code', params: ['123456'], code: '123456' });
    assert.match(messageId, /^wamid\./);
    await adapter.platform.send({ to: '919876500011', template: 'bhava_order_new', params: ['MM-1001'] });
    const { sent } = await whatsapp.get('/sent');
    assert.deepEqual(sent.map((m) => [m.phoneId, m.to, m.body.template.name]), [['1000', '919876500011', 'login_code'], ['1000', '919876500011', 'order_new_v2']]);
    assert.deepEqual(sent[0].body.template.components.map((c) => c.type), ['body', 'button'], 'an authentication template fills its copy-code button too');
    await assert.rejects(() => adapter.platform.send({ to: '+91 98765 00011', template: 'login_code' }), /digits only/);

    const bare = createWhatsApp({ whatsappBaseUrl: whatsapp.url });
    assert.equal(bare.platform.configured, false);
    await assert.rejects(() => bare.platform.send({ to: '919876500011', template: 'login_code' }), (err) => err instanceof ProviderError && err.code === 'not_configured' && err.delivery === 'none');
  } finally {
    await whatsapp.close();
  }
});

test('Bhava\'s own email sender: from PLATFORM_EMAIL_FROM in Bhava\'s name, and not_configured without it', async () => {
  const mail = createEmailSim();
  await mail.start();
  try {
    const adapter = createEmail({ emailDriver: 'http', emailBaseUrl: mail.url, emailApiKey: 'sim-email-key', platformEmailFrom: 'alerts@mail.bhava.example' });
    assert.deepEqual([adapter.platform.configured, adapter.platform.from], [true, 'alerts@mail.bhava.example']);
    const first = await adapter.platform.send({ to: 'owner@shop.example', subject: 'New order', html: '<p>Bhava</p>', text: 'Bhava', idempotencyKey: 'delivery-1' });
    const again = await adapter.platform.send({ to: 'owner@shop.example', subject: 'New order', html: '<p>Bhava</p>', text: 'Bhava', idempotencyKey: 'delivery-1' });
    assert.equal(first.messageId, again.messageId, 'the delivery id is the idempotency key: a repeat is not a second email');
    const { sent } = await mail.get('/sent');
    assert.deepEqual(sent.map((m) => [m.from, m.to[0]]), [['Bhava <alerts@mail.bhava.example>', 'owner@shop.example']]);

    for (const config of [{ emailDriver: 'http', emailBaseUrl: mail.url, emailApiKey: 'sim-email-key' }, { emailDriver: 'none', platformEmailFrom: 'alerts@mail.bhava.example' }, {}]) {
      const bare = createEmail(config);
      assert.equal(bare.platform.configured, false);
      await assert.rejects(() => bare.platform.send({ to: 'owner@shop.example', subject: 's', text: 't' }), (err) => err instanceof ProviderError && err.code === 'not_configured');
    }
  } finally {
    await mail.close();
  }
});

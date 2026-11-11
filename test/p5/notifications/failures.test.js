// When the providers misbehave (PRD 5.13, 10.5): three tries with backoff and then failed, one channel or business never
// holding up another, a token the provider calls gone deleted at once, and nothing ever sent twice on a guess.
// Against tools/sim/push, whatsapp and email, with faults.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as n from '../../../src/contracts/notifications.js';
import {
  MINUTE, SECOND, accepted, addBusiness, api, connect, deliveriesOf, deliveryOf, emailsTo, received, startWorld, whatsappsTo,
} from './support.js';

let w;
let owner;
let other;
let otherOwner;

before(async () => {
  w = await startWorld();
  owner = await connect(w, { devices: ['android'] });
  other = await addBusiness(w, 'second');
  otherOwner = await connect(w, { userId: other.owner, tenant: other.tenant, devices: ['ios'] });
});
after(() => w?.close());

const reset = async () => {
  w.clock.advance(10 * MINUTE);
  await w.sims.push.post('/reset');
  await w.sims.email.post('/reset');
  await w.sims.whatsapp.post('/reset');
};
const emit = (input, tenant = w.tenant) => w.notify.emit({ tenantId: tenant.id, ...input });
const mailCalls = async () => (await w.sims.email.get('/calls', { path: '/messages' })).calls ?? (await w.sims.email.get('/calls')).calls;
const whatsappCalls = async () => ((await w.sims.whatsapp.get('/calls')).calls ?? []).filter((c) => /\/messages$/.test(c.path));

test('F-59: an email provider answering 500 gets three tries with backoff, then failed; push, WhatsApp and the other business still deliver', async () => {
  await reset();
  const worker = w.worker();
  await w.sims.email.post('/faults', { kind: 'server_error', status: 500, match: { path: '/messages' }, times: 'forever' });
  try {
    const mine = await emit({ event: 'token.invalid', key: 'f59:a', data: { account: 'Instagram' } });
    const theirs = await emit({ event: 'token.invalid', key: 'f59:b', data: { account: 'Instagram' } }, other.tenant);
    await worker.drain();
    for (const [eventId, person] of [[mine, owner], [theirs, otherOwner]]) {
      assert.equal((await deliveryOf(w, eventId, 'push')).status, 'sent', 'push is not held up by email');
      assert.equal((await deliveryOf(w, eventId, 'whatsapp')).status, 'sent', 'nor is WhatsApp');
      assert.equal((await deliveryOf(w, eventId, 'inapp')).status, 'sent');
      assert.equal((await accepted(w, person.devices[0].token)).length, 1);
    }
    const tries = async () => {
      const row = await deliveryOf(w, mine, 'email');
      return [row.status, row.attempt, row.reason];
    };
    assert.deepEqual(await tries(), ['queued', 1, 'server']);
    w.clock.advance(29 * SECOND);
    await worker.drain();
    assert.deepEqual(await tries(), ['queued', 1, 'server'], 'not before the backoff');
    w.clock.advance(1 * SECOND);
    await worker.drain();
    assert.deepEqual(await tries(), ['queued', 2, 'server'], 'the second try after 30 s');
    w.clock.advance(n.NOTIFY_RULES.backoffMs[1] - SECOND);
    await worker.drain();
    assert.deepEqual(await tries(), ['queued', 2, 'server']);
    w.clock.advance(SECOND);
    await worker.drain();
    assert.deepEqual(await tries(), ['failed', 3, 'server'], 'the third, then failed with the provider\'s kind');
    await w.sims.email.post('/reset');
    w.clock.advance(30 * MINUTE);
    await worker.drain();
    assert.deepEqual(await tries(), ['failed', 3, 'server'], 'never a fourth');
    assert.deepEqual(await emailsTo(w, owner.email), []);
    const log = await w.inTenant(() => w.notify.deliveries.list({ eventId: mine }));
    assert.deepEqual(log.items.find((d) => d.channel === 'email').reason, 'server', 'the log says why');
  } finally {
    await w.sims.email.post('/reset');
  }
});

test('push: a hang, junk and throttling never crash the worker, never hold up another business, and the phone shows one', async () => {
  await reset();
  const worker = w.worker();
  const token = owner.devices[0].token;
  await w.sims.push.post('/behaviour', { kind: 'hang', token });
  const mine = await emit({ event: 'dm.usage_100', key: 'push-faults:a' });
  const theirs = await emit({ event: 'dm.usage_100', key: 'push-faults:b' }, other.tenant);
  await worker.drain();
  assert.deepEqual([(await deliveryOf(w, mine, 'push')).status, (await deliveryOf(w, mine, 'push')).reason], ['queued', 'timeout']);
  assert.equal((await deliveryOf(w, theirs, 'push')).status, 'sent', 'the other business is not held up');
  assert.equal((await deliveryOf(w, mine, 'email')).status, 'sent', 'nor the other channels');

  await w.sims.push.post('/behaviour', { kind: 'throttle', token, retryAfter: 200 });
  w.clock.advance(30 * SECOND);
  await worker.drain();
  const throttled = await deliveryOf(w, mine, 'push');
  assert.deepEqual([throttled.status, throttled.attempt, throttled.reason], ['queued', 2, 'throttled']);
  assert.ok(new Date(throttled.next_attempt_at).getTime() >= w.clock.ms + 199 * SECOND, 'the provider\'s Retry-After is kept');
  w.clock.advance(200 * SECOND);
  await worker.drain();
  const sent = await deliveryOf(w, mine, 'push');
  assert.deepEqual([sent.status, sent.attempt], ['sent', 3]);
  const tries = await received(w, token);
  assert.deepEqual(tries.map((p) => p.outcome), ['hang', 'throttle', 'accepted']);
  assert.equal(new Set(tries.map((p) => p.collapseKey)).size, 1, 'every try carries one collapse key, so a lost answer that did arrive is replaced, not doubled');

  // Junk for good: three tries, then failed with the kind, and nothing thrown out of drain().
  await w.sims.push.post('/behaviour', { kind: 'junk', token, times: 'forever' });
  const junk = await emit({ event: 'dm.usage_100', key: 'push-faults:junk' });
  for (const wait of [0, 30 * SECOND, 120 * SECOND]) {
    w.clock.advance(wait);
    await worker.drain();
  }
  assert.deepEqual([(await deliveryOf(w, junk, 'push')).status, (await deliveryOf(w, junk, 'push')).reason], ['failed', 'unavailable']);
  await w.sims.push.post('/reset');
});

test('P-23: a token the provider calls unregistered is deleted at once and never tried again; the person\'s other device still gets it', async () => {
  await reset();
  const worker = w.worker();
  // A person with two devices in this business: one the provider no longer knows.
  const managerId = (await w.sql(`INSERT INTO users (tenant_id, name, phone, password_hash, role) VALUES ($1, 'Manager', '9123400001', 'x', 'manager') RETURNING id`, [w.tenant.id]))[0].id;
  const two = await connect(w, { userId: managerId, devices: ['android', 'ios'] });
  const [dead, alive] = two.devices;
  await w.sims.push.post('/tokens', { token: dead.token, state: 'unregistered' });
  const first = await emit({ event: 'token.invalid', key: 'p23:1', audience: { userId: managerId } });
  await worker.drain();
  assert.equal((await deliveryOf(w, first, 'push')).status, 'sent', 'the other device took it, so it is not a failed try');
  assert.equal((await accepted(w, alive.token)).length, 1);
  const [row] = await w.sql('SELECT deleted_at, delete_reason, token_enc FROM push_devices WHERE person_id = $1 AND device_id = $2', [two.personId, dead.id]);
  assert.deepEqual([Boolean(row.deleted_at), row.delete_reason, row.token_enc], [true, 'unregistered', null], 'deleted, the token wiped');

  await w.sims.push.post('/tokens', { token: dead.token, state: 'ok' });
  const again = await api(w, '/push/devices', { method: 'POST', headers: dead.headers, body: { deviceId: dead.id, platform: dead.platform, token: dead.token } });
  assert.equal(again.status, 204);
  assert.equal((await w.sql('SELECT deleted_at FROM push_devices WHERE person_id = $1 AND device_id = $2', [two.personId, dead.id]))[0].deleted_at !== null, true, 'registering the dead token again does not bring it back');
  await emit({ event: 'token.invalid', key: 'p23:2', audience: { userId: managerId } });
  await worker.drain();
  assert.equal((await received(w, dead.token)).length, 1, 'never tried again');
  assert.equal((await accepted(w, alive.token)).length, 2);

  // The only device, and the provider says it is not this app's token: failed with that kind, and deleted too.
  await w.sims.push.post('/tokens', { token: alive.token, state: 'invalid' });
  const third = await emit({ event: 'token.invalid', key: 'p23:3', audience: { userId: managerId } });
  await worker.drain();
  assert.deepEqual([(await deliveryOf(w, third, 'push')).status, (await deliveryOf(w, third, 'push')).reason, (await deliveryOf(w, third, 'push')).attempt], ['failed', 'invalid_token', 1], 'no retry can change it');
  assert.equal((await w.sql('SELECT delete_reason FROM push_devices WHERE person_id = $1 AND device_id = $2', [two.personId, alive.id]))[0].delete_reason, 'invalid_token');
});

test('WhatsApp: an answer that was lost is never sent again on a guess; throttling is tried again; a number with no WhatsApp says so', async () => {
  await reset();
  const worker = w.worker();
  const kind = { event: 'token.invalid', data: { account: 'Instagram' } };
  const whatsappOf = async (eventId) => {
    const row = await deliveryOf(w, eventId, 'whatsapp');
    return [row.status, row.reason, row.attempt];
  };

  // The provider took the message, then the answer failed: it may have gone, so it is failed and left alone.
  await w.sims.whatsapp.post('/faults', { kind: 'partial', then: 'server_error', match: { method: 'POST' } });
  const lost = await emit({ ...kind, key: 'wa:lost' });
  await worker.drain();
  w.clock.advance(10 * MINUTE);
  await worker.drain();
  assert.deepEqual(await whatsappOf(lost), ['failed', 'unknown_delivery', 1]);
  assert.equal((await whatsappsTo(w, owner.phone)).length, 1, 'sent once, never again');

  // A 200 whose body is not WhatsApp's answer proves nothing: the same.
  await w.sims.whatsapp.post('/faults', { kind: 'malformed', mode: 'wrong_shape', match: { method: 'POST' } });
  const callsBefore = (await whatsappCalls()).length;
  const junk = await emit({ ...kind, key: 'wa:junk' });
  await worker.drain();
  w.clock.advance(10 * MINUTE);
  await worker.drain();
  assert.deepEqual(await whatsappOf(junk), ['failed', 'unknown_delivery', 1]);
  assert.equal((await whatsappCalls()).length - callsBefore, 1, 'one call, no retry');

  // A hang: the same, and the worker carries on.
  await w.sims.whatsapp.post('/faults', { kind: 'timeout', match: { method: 'POST' } });
  const hung = await emit({ ...kind, key: 'wa:hung' });
  await worker.drain();
  assert.deepEqual(await whatsappOf(hung), ['failed', 'unknown_delivery', 1]);
  assert.equal((await deliveryOf(w, hung, 'push')).status, 'sent');

  // Throttled (a 429 proves nothing was sent): tried again after the backoff, and sent.
  await w.sims.whatsapp.post('/faults', { kind: 'rate_limit', status: 429, match: { method: 'POST' } });
  const busy = await emit({ ...kind, key: 'wa:busy' });
  await worker.drain();
  assert.deepEqual(await whatsappOf(busy), ['queued', 'throttled', 1]);
  w.clock.advance(30 * SECOND);
  await worker.drain();
  assert.deepEqual(await whatsappOf(busy), ['sent', '', 2]);

  // A number that cannot get WhatsApp.
  await w.sims.whatsapp.post('/faults', { kind: 'rate_limit', status: 400, body: { error: { message: 'Undeliverable', code: 131026 } }, match: { method: 'POST' } });
  const none = await emit({ ...kind, key: 'wa:none' });
  await worker.drain();
  assert.deepEqual(await whatsappOf(none), ['failed', 'no_whatsapp', 1]);

  // A worker that stopped after claiming a WhatsApp try and before writing what happened: the next one does not guess.
  await w.sims.whatsapp.post('/reset');
  const crashed = await emit({ ...kind, key: 'wa:crash' });
  await worker.dispatch({ send: false });
  const row = await deliveryOf(w, crashed, 'whatsapp');
  await w.sql(`UPDATE notification_deliveries SET attempt = 1, reason = 'sending', locked_until = $2 WHERE id = $1`, [row.id, new Date(w.clock.ms - SECOND)]);
  await worker.drain();
  assert.deepEqual(await whatsappOf(crashed), ['failed', 'unknown_delivery', 2], 'the second claim finds the first try unanswered and ends it');
  assert.deepEqual(await whatsappsTo(w, owner.phone), [], 'nothing sent on a guess');
});

test('email: a lost answer is tried again under the same idempotency key, so the seller gets one email', async () => {
  await reset();
  const worker = w.worker();
  await w.sims.email.post('/faults', { kind: 'partial', then: 'timeout', match: { path: '/messages' }, times: 3 });
  const eventId = await emit({ event: 'dm.usage_100', key: 'mail:lost' });
  await worker.drain();
  const first = await deliveryOf(w, eventId, 'email');
  assert.equal(first.status, 'queued', 'unconfirmed, so tried again later');
  w.clock.advance(30 * SECOND);
  await worker.drain();
  assert.equal((await deliveryOf(w, eventId, 'email')).status, 'sent');
  assert.equal((await emailsTo(w, owner.email)).length, 1, 'one email, however many times it was asked for');
  const calls = (await mailCalls()).filter((c) => c.method === 'POST');
  assert.ok(calls.length >= 2 && calls.every((c) => c.headers?.['idempotency-key'] === calls[0].headers?.['idempotency-key']), 'every try carries the delivery as its key');
});

test('two workers sending at once: every delivery is tried once', async () => {
  await reset();
  const [a, b, c] = [w.worker(), w.worker(), w.worker()];
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(await emit({ event: i % 2 ? 'token.invalid' : 'dm.usage_100', key: `race:${i}`, data: { account: 'Instagram' } }));
  await Promise.all([a.drain(), b.drain(), c.drain()]);
  const pushes = await accepted(w, owner.devices[0].token);
  assert.equal(pushes.length, 12, 'one push per event');
  assert.equal(new Set(pushes.map((p) => p.data.eventId)).size, 12);
  assert.equal((await emailsTo(w, owner.email)).length, 12);
  assert.equal((await whatsappsTo(w, owner.phone)).length, 6);
  for (const id of ids) for (const d of await deliveriesOf(w, id)) assert.ok(d.channel === 'inapp' ? d.attempt === 0 : d.attempt === 1, `${d.channel} of ${id}: ${d.attempt}`);
});

test('with a channel not configured the others still deliver, and the log says why', async () => {
  const bare = await startWorld({ push: false, email: false });
  try {
    const person = await connect(bare, { devices: [] });
    const worker = bare.worker();
    assert.deepEqual(bare.notify.channels(), { push: { android: false, ios: false }, email: false, whatsapp: true, inapp: true });
    const eventId = await bare.notify.emit({ event: 'token.invalid', tenantId: bare.tenant.id, key: 'bare:1', data: { account: 'Instagram' } });
    await worker.drain();
    const rows = await deliveriesOf(bare, eventId);
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.channel, [r.status, r.reason]])), {
      push: ['dropped', 'not_configured'], email: ['dropped', 'not_configured'], whatsapp: ['sent', ''], inapp: ['sent', ''],
    });
    assert.equal((await whatsappsTo(bare, person.phone)).length, 1);

    // Someone with nothing to send to on a channel that is set up: dropped, no_address.
    const noPhone = (await bare.sql(`INSERT INTO users (tenant_id, name, phone, password_hash, role) VALUES ($1, 'Manager', '9123400002', 'x', 'manager') RETURNING id`, [bare.tenant.id]))[0].id;
    await bare.sql(`INSERT INTO people (name) VALUES ('') RETURNING id`).then(([p]) => bare.sql('UPDATE users SET person_id = $2 WHERE id = $1', [noPhone, p.id]));
    const second = await bare.notify.emit({ event: 'token.invalid', tenantId: bare.tenant.id, key: 'bare:2', audience: { userId: noPhone } });
    await worker.drain();
    const log = await bare.inTenant(() => bare.notify.deliveries.list({ eventId: second }));
    assert.deepEqual(Object.fromEntries(log.items.map((d) => [d.channel, d.reason])), { push: 'not_configured', email: 'not_configured', whatsapp: 'no_address', inapp: '' });
  } finally {
    await bare.close();
  }
});

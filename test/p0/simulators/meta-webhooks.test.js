import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMeta, ERRORS, hubSignature, signedRequest } from '../../../tools/sim/meta/index.mjs';
import { verifySignature } from '../../../src/server.js';
import { ACCOUNT, HOUR, OTHER, SUBSCRIBED, T0, addComment, errorCode, errorSubcode, graphGet, graphPost, privateReply, sendDm, startMeta, startReceiver, until } from './support.js';

const SECRET = 'webhook-app-secret';
const SUBSCRIBED_ACCOUNT = { ...ACCOUNT, subscribedFields: SUBSCRIBED };

async function wired(t, respond, options = {}) {
  const receiver = await startReceiver(t, respond);
  const meta = await startMeta(t, { app: { secret: SECRET, webhookUrl: `${receiver.url}/webhook`, echoes: false, ...options.app }, limits: options.limits }, { account: SUBSCRIBED_ACCOUNT });
  return { meta, receiver };
}

const jsonOf = (delivery) => JSON.parse(delivery.raw.toString('utf8'));

test('a comment arrives as Meta sends it, with a signature that passes verifySignature', async (t) => {
  const { meta, receiver } = await wired(t);
  const result = await meta.post('/comments', { igUserId: ACCOUNT.igUserId, id: 'c1', mediaId: 'reel-1', from: { id: 'u1', username: 'asha' }, text: 'LINK', parentId: 'c0' });
  assert.equal(result.delivery.delivered, true);
  assert.equal(result.delivery.status, 200);

  assert.equal(receiver.received.length, 1);
  const [delivery] = receiver.received;
  assert.equal(delivery.method, 'POST');
  assert.equal(delivery.headers['content-type'], 'application/json');
  assert.equal(verifySignature(delivery.raw, delivery.headers['x-hub-signature-256'], SECRET), true);
  assert.equal(delivery.headers['x-hub-signature'], `sha1=${crypto.createHmac('sha1', SECRET).update(delivery.raw).digest('hex')}`);

  const body = jsonOf(delivery);
  assert.equal(body.object, 'instagram');
  assert.equal(body.entry.length, 1);
  assert.equal(body.entry[0].id, ACCOUNT.igUserId);
  assert.equal(body.entry[0].time, T0 / 1000, 'changes entries carry seconds');
  assert.deepEqual(body.entry[0].changes, [{ field: 'comments', value: { from: { id: 'u1', username: 'asha' }, media: { id: 'reel-1', media_product_type: 'REELS' }, id: 'c1', parent_id: 'c0', text: 'LINK' } }]);
});

test('hubSignature matches the app\'s check for arbitrary bytes, and a changed body fails', () => {
  const raw = Buffer.from('{"entry":[{"text":"नमस्ते 🎉"}]}');
  const header = hubSignature(raw, SECRET);
  assert.equal(verifySignature(raw, header, SECRET), true);
  assert.equal(verifySignature(Buffer.from(`${raw} `), header, SECRET), false);
  assert.equal(verifySignature(raw, header, 'other'), false);
});

test('a bad or missing signature can be sent on purpose, and the app\'s check refuses it', async (t) => {
  const { meta, receiver } = await wired(t);
  await addComment(meta, { signature: 'bad' });
  await addComment(meta, { signature: 'none' });
  const [bad, none] = receiver.received;
  assert.ok(bad.headers['x-hub-signature-256']);
  assert.equal(verifySignature(bad.raw, bad.headers['x-hub-signature-256'], SECRET), false);
  assert.equal(none.headers['x-hub-signature-256'], undefined);
  assert.equal(verifySignature(none.raw, none.headers['x-hub-signature-256'], SECRET), false);
});

test('nothing is delivered until the account has subscribed to that field', async (t) => {
  const receiver = await startReceiver(t);
  const meta = await startMeta(t, { app: { secret: SECRET, webhookUrl: `${receiver.url}/webhook`, echoes: false } });
  const before = await meta.post('/comments', { igUserId: ACCOUNT.igUserId, mediaId: 'r', from: 'u', text: 'x' });
  assert.deepEqual(before.delivery, { delivered: false, reason: 'not_subscribed' });
  assert.equal(receiver.received.length, 0);

  await graphPost(meta, `${ACCOUNT.igUserId}/subscribed_apps`, { subscribed_fields: 'comments' });
  assert.equal((await meta.post('/comments', { igUserId: ACCOUNT.igUserId, mediaId: 'r', from: 'u', text: 'x' })).delivery.delivered, true);
  assert.equal((await meta.post('/messages', { igUserId: ACCOUNT.igUserId, from: 'u', text: 'x' })).delivery.reason, 'not_subscribed', 'messages is a separate field');
  assert.equal(receiver.received.length, 1);
});

test('deliver:false records the comment but sends no webhook', async (t) => {
  const { meta, receiver } = await wired(t);
  const id = await addComment(meta, { deliver: false });
  assert.equal(receiver.received.length, 0);
  assert.equal((await privateReply(meta, id)).status, 200);
});

test('a webhook is recorded even with no URL configured', async (t) => {
  const meta = await startMeta(t, { app: { secret: SECRET, echoes: false } }, { account: SUBSCRIBED_ACCOUNT });
  const { delivery } = await meta.post('/comments', { igUserId: ACCOUNT.igUserId, mediaId: 'r', from: 'u', text: 'x' });
  assert.deepEqual([delivery.delivered, delivery.reason], [false, 'no_webhook_url']);
  const { deliveries } = await meta.get('/webhooks');
  assert.equal(deliveries[0].body.entry[0].changes[0].field, 'comments');
});

test('a DM arrives on the messaging path', async (t) => {
  const { meta, receiver } = await wired(t);
  await meta.post('/messages', { igUserId: ACCOUNT.igUserId, from: 'u1', text: 'hello' });
  const [{ id, time, messaging }] = jsonOf(receiver.received[0]).entry;
  assert.equal(id, ACCOUNT.igUserId);
  assert.equal(time, T0, 'messaging entries carry milliseconds');
  assert.deepEqual(messaging[0].sender, { id: 'u1' });
  assert.deepEqual(messaging[0].recipient, { id: ACCOUNT.igUserId });
  assert.equal(messaging[0].message.text, 'hello');
  assert.ok(messaging[0].message.mid);
  assert.ok(Number.isInteger(messaging[0].timestamp));
});

test('a postback, story reply and story mention carry their own shapes', async (t) => {
  const { meta, receiver } = await wired(t);
  await meta.post('/postbacks', { igUserId: ACCOUNT.igUserId, from: 'u1', payload: 'SEND_LINK', title: 'Send me the link' });
  await meta.post('/story-replies', { igUserId: ACCOUNT.igUserId, from: 'u1', text: 'love it', storyId: 's1', url: 'https://cdn.example/s.jpg' });
  await meta.post('/mentions', { igUserId: ACCOUNT.igUserId, from: 'u1', url: 'https://cdn.example/m.jpg' });
  const [postback, story, mention] = receiver.received.map((r) => jsonOf(r).entry[0].messaging[0]);
  assert.deepEqual([postback.postback.payload, postback.postback.title], ['SEND_LINK', 'Send me the link']);
  assert.deepEqual(story.message.reply_to, { story: { id: 's1', url: 'https://cdn.example/s.jpg' } });
  assert.deepEqual(mention.message.attachments, [{ type: 'story_mention', payload: { url: 'https://cdn.example/m.jpg' } }]);
});

test('a mention on a post arrives on the mentions field', async (t) => {
  const { meta, receiver } = await wired(t);
  await meta.post('/mentions', { igUserId: ACCOUNT.igUserId, mediaId: 'm1', commentId: 'c1' });
  assert.deepEqual(jsonOf(receiver.received[0]).entry[0].changes, [{ field: 'mentions', value: { media_id: 'm1', comment_id: 'c1' } }]);
});

test('the same event can arrive three times with identical bytes', async (t) => {
  const { meta, receiver } = await wired(t);
  const { delivery } = await meta.post('/comments', { igUserId: ACCOUNT.igUserId, id: 'c1', mediaId: 'r', from: 'u', text: 'x', duplicates: 3 });
  assert.equal(delivery.attempts, 3);
  assert.equal(receiver.received.length, 3);
  assert.equal(new Set(receiver.received.map((r) => r.raw.toString())).size, 1);
  assert.equal(new Set(receiver.received.map((r) => r.headers['x-hub-signature-256'])).size, 1);
});

test('held events go out in one batch, split at the limit', async (t) => {
  const { meta, receiver } = await wired(t);
  for (let i = 0; i < 5; i++) await addComment(meta, { hold: true });
  assert.equal(receiver.received.length, 0);
  assert.equal((await meta.get('/webhooks')).held.length, 5);
  const { deliveries } = await meta.post('/webhooks/flush', { batchSize: 2 });
  assert.equal(deliveries.length, 3);
  assert.deepEqual(receiver.received.map((r) => jsonOf(r).entry.length), [2, 2, 1]);
  assert.equal((await meta.get('/webhooks')).held.length, 0);
  assert.ok(verifySignature(receiver.received[0].raw, receiver.received[0].headers['x-hub-signature-256'], SECRET));
});

test('a batch never exceeds 1,000 entries', async (t) => {
  const { meta, receiver } = await wired(t, undefined, { limits: { webhookBatch: 3 } });
  for (let i = 0; i < 4; i++) await addComment(meta, { hold: true });
  await meta.post('/webhooks/flush', { batchSize: 100 });
  assert.deepEqual(receiver.received.map((r) => jsonOf(r).entry.length), [3, 1]);
  await assert.rejects(() => meta.post('/webhooks/flush', { batchSize: 0 }), /batchSize/);
});

test('an app that fails gets the delivery again, until 36 hours are up', async (t) => {
  let healthy = false;
  const { meta, receiver } = await wired(t, () => ({ status: healthy ? 200 : 500 }));
  const first = await meta.post('/comments', { igUserId: ACCOUNT.igUserId, id: 'c1', mediaId: 'r', from: 'u', text: 'x' });
  assert.deepEqual([first.delivery.delivered, first.delivery.status], [false, 500]);

  await meta.post('/clock', { advanceMs: 36 * HOUR - 1 });
  assert.deepEqual(await meta.post('/webhooks/retry'), { retried: 1, delivered: 0, gaveUp: 0 });

  healthy = true;
  assert.deepEqual(await meta.post('/webhooks/retry'), { retried: 1, delivered: 1, gaveUp: 0 });
  assert.deepEqual(await meta.post('/webhooks/retry'), { retried: 0, delivered: 0, gaveUp: 0 }, 'delivered ones are done');
  assert.equal(receiver.received.length, 3);
  assert.equal(new Set(receiver.received.map((r) => r.raw.toString())).size, 1, 'retries repeat the same bytes');
});

test('Meta gives up 36 hours after the first attempt', async (t) => {
  const { meta, receiver } = await wired(t, () => ({ status: 500 }));
  await addComment(meta);
  await meta.post('/clock', { advanceMs: 36 * HOUR });
  assert.deepEqual(await meta.post('/webhooks/retry'), { retried: 0, delivered: 0, gaveUp: 1 });
  assert.equal(receiver.received.length, 1);
});

test('an app that does not answer is a failed delivery', async (t) => {
  const { meta } = await wired(t, () => ({ hang: true }), { limits: { webhookTimeoutMs: 50 } });
  const { delivery } = await meta.post('/comments', { igUserId: ACCOUNT.igUserId, mediaId: 'r', from: 'u', text: 'x' });
  assert.equal(delivery.delivered, false);
  assert.equal(delivery.status, null);
  assert.match(delivery.reason, /did not answer/);
});

test('a webhook is never redirected', async (t) => {
  const { meta, receiver } = await wired(t, () => ({ status: 302, headers: { location: 'https://outside.example/' } }));
  const { delivery } = await meta.post('/comments', { igUserId: ACCOUNT.igUserId, mediaId: 'r', from: 'u', text: 'x' });
  assert.deepEqual([delivery.delivered, delivery.status], [false, 302]);
  assert.equal(receiver.received.length, 1);
});

test('any payload can be sent signed, including broken JSON', async (t) => {
  const { meta, receiver } = await wired(t);
  await meta.post('/webhooks/send', { body: { object: 'instagram', entry: [] } });
  await meta.post('/webhooks/send', { raw: '{"entry":[', signature: 'good' });
  assert.deepEqual(jsonOf(receiver.received[0]), { object: 'instagram', entry: [] });
  assert.equal(receiver.received[1].raw.toString(), '{"entry":[');
  assert.equal(verifySignature(receiver.received[1].raw, receiver.received[1].headers['x-hub-signature-256'], SECRET), true);
  await assert.rejects(() => meta.post('/webhooks/send', {}), /Give body/);
  await assert.rejects(() => meta.post('/webhooks/send', { raw: 1 }), /raw must be/);
  await assert.rejects(() => meta.post('/webhooks/send', { body: {}, signature: 'odd' }), /signature/);
  await assert.rejects(() => meta.post('/webhooks/send', { body: {}, duplicates: 0 }), /duplicates/);
});

test('with echoes on, what the app sends comes back marked is_echo', async (t) => {
  const { meta, receiver } = await wired(t, undefined, { app: { echoes: true } });
  await meta.post('/messages', { igUserId: ACCOUNT.igUserId, from: 'u1', text: 'hi', deliver: false });
  const res = await sendDm(meta, { id: 'u1' }, { text: 'reply' });
  assert.equal(res.status, 200);
  await until(() => receiver.received.length === 1);
  const [event] = jsonOf(receiver.received[0]).entry[0].messaging;
  assert.deepEqual(event.sender, { id: ACCOUNT.igUserId });
  assert.deepEqual(event.recipient, { id: 'u1' });
  assert.deepEqual([event.message.is_echo, event.message.text, event.message.mid], [true, 'reply', res.body.message_id]);
});

test('with echoes on, the business\'s own public reply fires a comments webhook', async (t) => {
  const { meta, receiver } = await wired(t, undefined, { app: { echoes: true } });
  const id = await addComment(meta, { deliver: false });
  await graphPost(meta, `${id}/replies`, { message: 'Check your DMs' });
  await until(() => receiver.received.length === 1);
  const [{ value }] = jsonOf(receiver.received[0]).entry[0].changes;
  assert.deepEqual([value.from.id, value.parent_id, value.text], [ACCOUNT.igUserId, id, 'Check your DMs']);
});

test('the deliveries log shows what was sent and how it went', async (t) => {
  const { meta } = await wired(t, () => ({ status: 503 }));
  await addComment(meta);
  const { deliveries } = await meta.get('/webhooks');
  assert.equal(deliveries.length, 1);
  assert.deepEqual([deliveries[0].status, deliveries[0].ok, deliveries[0].attempts, deliveries[0].signature], [503, false, 1, 'good']);
  assert.equal(deliveries[0].raw, undefined);
});

test('the subscription handshake echoes the challenge, or fails', async (t) => {
  const receiver = await startReceiver(t, (entry) => {
    const url = new URL(entry.url, 'http://x');
    if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === 'right') return { status: 200, body: url.searchParams.get('hub.challenge') };
    return { status: 403 };
  });
  const meta = await startMeta(t, { app: { secret: SECRET, webhookUrl: `${receiver.url}/webhook`, verifyToken: 'right' } });
  assert.deepEqual(await meta.post('/webhooks/verify'), { status: 200, verified: true });
  assert.deepEqual(await meta.post('/webhooks/verify', { verifyToken: 'wrong' }), { status: 403, verified: false });
});

test('a handshake against an app answering the wrong text is not verified', async (t) => {
  const receiver = await startReceiver(t, () => ({ status: 200, body: 'not-the-challenge' }));
  const meta = await startMeta(t, { app: { secret: SECRET, webhookUrl: `${receiver.url}/webhook` } });
  assert.equal((await meta.post('/webhooks/verify')).verified, false);
});

test('webhooks and callbacks cannot be pointed off this machine', async (t) => {
  assert.throws(() => createMeta({ app: { webhookUrl: 'https://outside.example/webhook' } }), /on this machine/);
  assert.throws(() => createMeta({ app: { deauthorizeUrl: 'https://outside.example/d' } }), /on this machine/);
  assert.throws(() => createMeta({ app: { deletionUrl: 'http://10.0.0.5/d' } }), /on this machine/);
  const meta = await startMeta(t);
  await assert.rejects(() => meta.post('/app', { webhookUrl: 'https://outside.example/webhook' }), /on this machine/);
  await assert.rejects(() => meta.post('/app', { deletionUrl: 'https://outside.example/del' }), /on this machine/);
});

test('handshake and callbacks report an app that is not there', async (t) => {
  const receiver = await startReceiver(t);
  const url = receiver.url;
  await receiver.close();
  const meta = await startMeta(t, { app: { secret: SECRET, webhookUrl: `${url}/webhook`, deauthorizeUrl: `${url}/d`, deletionUrl: `${url}/del` } });
  await assert.rejects(() => meta.post('/webhooks/verify'), /did not answer/);
  await assert.rejects(() => meta.post('/deauthorize', { igUserId: ACCOUNT.igUserId }), /did not answer/);
  await assert.rejects(() => meta.post('/deletion', { igUserId: ACCOUNT.igUserId }), /did not answer/);
});

test('unconfigured handshake and callbacks are refused', async (t) => {
  const meta = await startMeta(t);
  await assert.rejects(() => meta.post('/webhooks/verify'), /No webhook URL/);
  await assert.rejects(() => meta.post('/deauthorize', { igUserId: ACCOUNT.igUserId }), /No deauthorize URL/);
  await assert.rejects(() => meta.post('/deletion', { igUserId: ACCOUNT.igUserId }), /No deletion URL/);
  await assert.rejects(() => meta.post('/deletion', { igUserId: ACCOUNT.igUserId, signature: 'odd' }), /signature/);
});

/** Independent of the simulator's own signing code: this is what the real callback handler must do. */
function verifySignedRequest(signed, secret) {
  const [signature, payload] = signed.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return signature === expected ? JSON.parse(Buffer.from(payload, 'base64url').toString()) : null;
}

test('signedRequest builds Meta\'s format', () => {
  const signed = signedRequest({ user_id: '1', algorithm: 'HMAC-SHA256' }, SECRET);
  assert.deepEqual(verifySignedRequest(signed, SECRET), { user_id: '1', algorithm: 'HMAC-SHA256' });
  assert.equal(verifySignedRequest(signed, 'other'), null);
});

test('deauthorize posts a signed_request and ends the account\'s tokens and subscriptions', async (t) => {
  const receiver = await startReceiver(t);
  const meta = await startMeta(t, { app: { secret: SECRET, deauthorizeUrl: `${receiver.url}/deauth`, echoes: false } }, { account: SUBSCRIBED_ACCOUNT });
  const result = await meta.post('/deauthorize', { igUserId: ACCOUNT.igUserId });
  assert.equal(result.status, 200);

  const [callback] = receiver.received;
  assert.equal(callback.method, 'POST');
  assert.equal(callback.url, '/deauth');
  assert.equal(callback.headers['content-type'], 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(callback.raw.toString());
  const payload = verifySignedRequest(params.get('signed_request'), SECRET);
  assert.equal(payload.user_id, ACCOUNT.igUserId);
  assert.equal(payload.algorithm, 'HMAC-SHA256');
  assert.ok(Number.isInteger(payload.issued_at));

  const res = await graphGet(meta, 'me');
  assert.deepEqual([errorCode(res), errorSubcode(res)], [ERRORS.TOKEN_REVOKED.code, ERRORS.TOKEN_REVOKED.subcode]);
  const delivery = (await meta.post('/comments', { igUserId: ACCOUNT.igUserId, mediaId: 'r', from: 'u', text: 'x' })).delivery;
  assert.equal(delivery.reason, 'not_subscribed');
});

test('a forged deauthorize fails verification and leaves the account connected', async (t) => {
  const receiver = await startReceiver(t, () => ({ status: 400 }));
  const meta = await startMeta(t, { app: { secret: SECRET, deauthorizeUrl: `${receiver.url}/deauth` } });
  const result = await meta.post('/deauthorize', { igUserId: ACCOUNT.igUserId, signature: 'bad' });
  assert.equal(result.status, 400);
  assert.equal(verifySignedRequest(result.signedRequest, SECRET), null);
  assert.equal((await graphGet(meta, 'me')).status, 200);

  const unsigned = await meta.post('/deauthorize', { igUserId: ACCOUNT.igUserId, signature: 'none' });
  assert.equal(unsigned.status, 400);
  assert.equal(new URLSearchParams(receiver.received[1].raw.toString()).get('signed_request'), null);
});

test('a callback can name a different user id, for when the id form is confirmed', async (t) => {
  const receiver = await startReceiver(t);
  const meta = await startMeta(t, { app: { secret: SECRET, deauthorizeUrl: `${receiver.url}/d` } });
  const { signedRequest: signed } = await meta.post('/deauthorize', { igUserId: ACCOUNT.igUserId, userId: 'app-scoped-1' });
  assert.equal(verifySignedRequest(signed, SECRET).user_id, 'app-scoped-1');
});

test('deletion posts a signed_request and checks the reply has url and confirmation_code', async (t) => {
  let answer = { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://shop.example/deletion?id=abc', confirmation_code: 'abc' }) };
  const receiver = await startReceiver(t, () => answer);
  const meta = await startMeta(t, { app: { secret: SECRET, deletionUrl: `${receiver.url}/del` } });
  const ok = await meta.post('/deletion', { igUserId: ACCOUNT.igUserId });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.body, { url: 'https://shop.example/deletion?id=abc', confirmation_code: 'abc' });
  assert.equal(verifySignedRequest(new URLSearchParams(receiver.received[0].raw.toString()).get('signed_request'), SECRET).user_id, ACCOUNT.igUserId);
  assert.equal((await graphGet(meta, 'me')).status, 200, 'deletion is separate from deauthorize');

  answer = { status: 200, body: JSON.stringify({ url: 'https://shop.example/x' }) };
  assert.equal((await meta.post('/deletion', { igUserId: ACCOUNT.igUserId })).valid, false);
  answer = { status: 200, body: 'done' };
  const text = await meta.post('/deletion', { igUserId: ACCOUNT.igUserId });
  assert.deepEqual([text.valid, text.body], [false, 'done']);
  answer = { status: 400, body: JSON.stringify({ url: 'u', confirmation_code: 'c' }) };
  assert.equal((await meta.post('/deletion', { igUserId: ACCOUNT.igUserId })).valid, false);
});

test('webhooks are scoped to the account that owns the comment', async (t) => {
  const { meta, receiver } = await wired(t);
  await meta.post('/accounts', { ...OTHER, subscribedFields: ['comments'] });
  await addComment(meta, { account: OTHER, mediaId: 'their-reel' });
  assert.equal(jsonOf(receiver.received[0]).entry[0].id, OTHER.igUserId);
});

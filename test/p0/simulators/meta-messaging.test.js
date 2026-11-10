import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, LIMITS, SCOPES } from '../../../tools/sim/meta/index.mjs';
import { ACCOUNT, DAY, OTHER, addComment, buttonMessage, errorCode, errorSubcode, privateReply, sendDm, sent, startMeta } from './support.js';

const PERSON = 'shopper-1';
const inbound = (meta, extra = {}) => meta.post('/messages', { igUserId: ACCOUNT.igUserId, from: PERSON, text: 'hi', ...extra });
const send = (meta, message = { text: 'reply' }, options = {}) => sendDm(meta, { id: PERSON }, message, options);
const advance = (meta, advanceMs) => meta.post('/clock', { advanceMs });

const assertClosed = (res) => {
  assert.equal(res.status, 400);
  assert.equal(errorCode(res), ERRORS.WINDOW_CLOSED.code);
  assert.equal(errorSubcode(res), ERRORS.WINDOW_CLOSED.subcode);
};

test('no cold DMs: someone who never wrote cannot be messaged', async (t) => {
  const meta = await startMeta(t);
  assertClosed(await send(meta));
  assert.deepEqual(await sent(meta), []);
});

test('a reply inside the window goes out', async (t) => {
  const meta = await startMeta(t);
  await inbound(meta);
  const res = await send(meta);
  assert.equal(res.status, 200);
  assert.equal(res.body.recipient_id, PERSON);
  assert.ok(res.body.message_id);
  const [dm] = await sent(meta);
  assert.deepEqual([dm.kind, dm.recipientId, dm.igUserId], ['send_api', PERSON, ACCOUNT.igUserId]);
});

test('the 24-hour window: open a millisecond before, closed at exactly 24 hours', async (t) => {
  const meta = await startMeta(t);
  await inbound(meta);
  await advance(meta, DAY - 1);
  assert.equal((await send(meta)).status, 200);
  await advance(meta, 1);
  assertClosed(await send(meta));
});

test('a new message from the person restarts the window', async (t) => {
  const meta = await startMeta(t);
  await inbound(meta);
  await advance(meta, DAY - 1);
  await inbound(meta);
  await advance(meta, DAY - 1);
  assert.equal((await send(meta)).status, 200);
});

test('an inbound message seeded in the past is judged by that time', async (t) => {
  const meta = await startMeta(t);
  const now = (await meta.get('/clock')).now;
  await inbound(meta, { at: now - DAY });
  assertClosed(await send(meta));
  await inbound(meta, { at: now - DAY + 1 });
  assert.equal((await send(meta)).status, 200);
});

test('the window is per business: writing to one opens nothing with another', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/accounts', OTHER);
  await inbound(meta);
  assertClosed(await sendDm(meta, { id: PERSON }, { text: 'x' }, { account: OTHER }));
});

test('a postback tap opens the window', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/postbacks', { igUserId: ACCOUNT.igUserId, from: PERSON, payload: 'SEND_LINK', title: 'Send me the link' });
  assert.equal((await send(meta)).status, 200);
});

test('a story reply opens the window', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/story-replies', { igUserId: ACCOUNT.igUserId, from: PERSON, text: 'love this' });
  assert.equal((await send(meta)).status, 200);
});

test('a story mention does not open the window', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/mentions', { igUserId: ACCOUNT.igUserId, from: PERSON });
  assertClosed(await send(meta));
});

test('a private reply does not open the window: a follow-up needs a response', async (t) => {
  const meta = await startMeta(t);
  await privateReply(meta, await addComment(meta, { from: { id: PERSON } }));
  assertClosed(await send(meta));
  await inbound(meta);
  assert.equal((await send(meta)).status, 200);
});

test('HUMAN_AGENT reaches back 7 days; no other tag is accepted', async (t) => {
  const meta = await startMeta(t);
  await inbound(meta);
  await advance(meta, 7 * DAY - 1);
  assertClosed(await send(meta));
  assert.equal((await send(meta, { text: 'human' }, { tag: 'HUMAN_AGENT' })).status, 200);
  await advance(meta, 1);
  assertClosed(await send(meta, { text: 'human' }, { tag: 'HUMAN_AGENT' }));
  for (const tag of ['ACCOUNT_UPDATE', 'human_agent', '']) {
    assert.equal(errorCode(await send(meta, { text: 'x' }, { tag })), ERRORS.INVALID_PARAM.code, tag);
  }
});

test('100 Send API calls per second per account, then 613, and the next second is open', async (t) => {
  const meta = await startMeta(t);
  assert.equal(LIMITS.sendPerSecond, 100);
  await meta.post('/accounts', OTHER);
  await inbound(meta);
  await meta.post('/messages', { igUserId: OTHER.igUserId, from: PERSON, text: 'hi' });
  const results = await Promise.all(Array.from({ length: 101 }, () => send(meta)));
  assert.equal(results.filter((r) => r.status === 200).length, 100);
  assert.equal(results.filter((r) => errorCode(r) === ERRORS.RATE_LIMITED.code).length, 1);
  assert.equal((await sendDm(meta, { id: PERSON }, { text: 'x' }, { account: OTHER })).status, 200, 'another business has its own budget');
  await advance(meta, 999);
  assert.equal(errorCode(await send(meta)), ERRORS.RATE_LIMITED.code);
  await advance(meta, 1);
  assert.equal((await send(meta)).status, 200);
});

test('quick replies: 13 of 20 characters, and no more', async (t) => {
  const meta = await startMeta(t);
  await inbound(meta);
  const reply = (title = 'Yes') => ({ content_type: 'text', title, payload: 'P' });
  const withReplies = (quick_replies) => ({ text: 'Choose', quick_replies });
  assert.equal((await send(meta, withReplies(Array.from({ length: 13 }, () => reply())))).status, 200);
  assert.equal((await send(meta, withReplies([reply('t'.repeat(20))]))).status, 200);
  for (const bad of [Array.from({ length: 14 }, () => reply()), [reply('t'.repeat(21))], [], 'x', [{ content_type: 'location', title: 'x', payload: 'P' }], [{ content_type: 'text', title: 'x' }]]) {
    assert.equal(errorCode(await send(meta, withReplies(bad))), ERRORS.INVALID_PARAM.code, JSON.stringify(bad).slice(0, 80));
  }
});

test('the Send API applies the button and text limits too', async (t) => {
  const meta = await startMeta(t);
  await inbound(meta);
  assert.equal((await send(meta, buttonMessage())).status, 200);
  assert.equal(errorCode(await send(meta, buttonMessage({ text: 'x'.repeat(641) }))), ERRORS.INVALID_PARAM.code);
  assert.equal(errorCode(await send(meta, { text: 'x'.repeat(1001) })), ERRORS.INVALID_PARAM.code);
  assert.equal((await send(meta, { attachment: { type: 'image', payload: { url: 'https://cdn.example/a.jpg' } } })).status, 200);
  assert.equal(errorCode(await send(meta, { attachment: { type: 'image', payload: {} } })), ERRORS.INVALID_PARAM.code);
});

test('the Send API needs the messages permission', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'basic-only', scopes: [SCOPES.basic] });
  await inbound(meta);
  assert.equal(errorCode(await send(meta, { text: 'x' }, { token: 'basic-only' })), ERRORS.PERMISSION.code);
});

test('an unavailable recipient is refused', async (t) => {
  const meta = await startMeta(t);
  await inbound(meta);
  await meta.post('/people', { igUserId: ACCOUNT.igUserId, id: PERSON, unavailable: true });
  const res = await send(meta);
  assert.deepEqual([errorCode(res), errorSubcode(res)], [ERRORS.RECIPIENT_UNAVAILABLE.code, ERRORS.RECIPIENT_UNAVAILABLE.subcode]);
});

test('sent can be filtered', async (t) => {
  const meta = await startMeta(t);
  await inbound(meta);
  await send(meta);
  const id = await addComment(meta, { from: { id: 'other-person' } });
  await privateReply(meta, id);
  assert.equal((await sent(meta)).length, 2);
  assert.equal((await sent(meta, { recipientId: PERSON })).length, 1);
  assert.equal((await sent(meta, { commentId: id })).length, 1);
  assert.equal((await sent(meta, { kind: 'send_api' })).length, 1);
  assert.equal((await sent(meta, { igUserId: 'nobody' })).length, 0);
});

test('events for an unknown account are refused', async (t) => {
  const meta = await startMeta(t);
  await assert.rejects(() => meta.post('/messages', { igUserId: 'nobody', from: 'a', text: 'x' }), /No account/);
  await assert.rejects(() => meta.post('/messages', { igUserId: ACCOUNT.igUserId, from: 'a' }), /text is required/);
  await assert.rejects(() => meta.post('/messages', { igUserId: ACCOUNT.igUserId, text: 'x' }), /from is required/);
  await assert.rejects(() => meta.post('/postbacks', { igUserId: ACCOUNT.igUserId, from: 'a' }), /payload is required/);
  await assert.rejects(() => meta.post('/story-replies', { igUserId: ACCOUNT.igUserId, from: 'a' }), /text is required/);
  await assert.rejects(() => meta.post('/messages', { igUserId: ACCOUNT.igUserId, from: 'a', text: 'x', at: 'noon' }), /at must be a number/);
});

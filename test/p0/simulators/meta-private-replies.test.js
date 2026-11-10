import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, LIMITS, SCOPES } from '../../../tools/sim/meta/index.mjs';
import { createInstagram } from '../../../src/instagram.js';
import { ACCOUNT, DAY, HOUR, OTHER, addComment, bearer, buttonMessage, errorCode, graphPost, privateReply, request, sent, startMeta } from './support.js';

test('a private reply reaches the commenter and answers like Graph', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta, { from: { id: 'shopper-9', username: 'asha' } });
  const res = await privateReply(meta, id, { text: 'hello' });
  assert.equal(res.status, 200);
  assert.equal(res.body.recipient_id, 'shopper-9');
  assert.ok(res.body.message_id);
  const [dm] = await sent(meta);
  assert.deepEqual([dm.kind, dm.igUserId, dm.recipientId, dm.commentId, dm.id], ['private_reply', ACCOUNT.igUserId, 'shopper-9', id, res.body.message_id]);
  assert.deepEqual(dm.message, { text: 'hello' });
});

test('one private reply per comment: the second is refused and nothing is sent', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  assert.equal((await privateReply(meta, id)).status, 200);
  const again = await privateReply(meta, id);
  assert.equal(again.status, 400);
  assert.equal(errorCode(again), ERRORS.ALREADY_REPLIED.code);
  assert.equal((await sent(meta)).length, 1);
});

test('racing private replies to one comment: exactly one goes out', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  const results = await Promise.all(Array.from({ length: 20 }, () => privateReply(meta, id)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => errorCode(r) === ERRORS.ALREADY_REPLIED.code).length, 19);
  assert.equal((await sent(meta)).length, 1);
});

test('a button template is also the one reply, and text after it is refused', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  assert.equal((await privateReply(meta, id, buttonMessage())).status, 200);
  assert.equal(errorCode(await privateReply(meta, id, { text: 'fallback' })), ERRORS.ALREADY_REPLIED.code);
});

test('a rejected private reply does not use up the comment', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  assert.equal((await privateReply(meta, id, { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await privateReply(meta, id, { text: 'ok' })).status, 200);
});

test('another comment by the same person gets its own reply', async (t) => {
  const meta = await startMeta(t);
  assert.equal((await privateReply(meta, await addComment(meta))).status, 200);
  assert.equal((await privateReply(meta, await addComment(meta))).status, 200);
  assert.equal((await sent(meta)).length, 2);
});

test('the 7-day window: open a millisecond before, closed exactly at 7 days', async (t) => {
  const meta = await startMeta(t);
  const open = await addComment(meta);
  const closed = await addComment(meta);
  await meta.post('/clock', { advanceMs: 7 * DAY - 1 });
  assert.equal((await privateReply(meta, open)).status, 200);
  await meta.post('/clock', { advanceMs: 1 });
  const res = await privateReply(meta, closed);
  assert.equal(res.status, 400);
  assert.equal(errorCode(res), ERRORS.REPLY_WINDOW_CLOSED.code);
  assert.equal((await sent(meta)).length, 1);
});

test('a comment seeded with a past time is judged by that time', async (t) => {
  const meta = await startMeta(t);
  const now = (await meta.get('/clock')).now;
  const old = await addComment(meta, { at: now - 7 * DAY });
  const fresh = await addComment(meta, { at: now - 7 * DAY + 1 });
  assert.equal(errorCode(await privateReply(meta, old)), ERRORS.REPLY_WINDOW_CLOSED.code);
  assert.equal((await privateReply(meta, fresh)).status, 200);
});

test('a comment that does not exist or was deleted cannot be replied to', async (t) => {
  const meta = await startMeta(t);
  const res = await privateReply(meta, 'no-such-comment');
  assert.deepEqual([res.status, errorCode(res), res.body.error.error_subcode], [400, 100, 33]);
  const id = await addComment(meta);
  await meta.post('/comments/delete', { id });
  assert.equal(errorCode(await privateReply(meta, id)), ERRORS.OBJECT_NOT_FOUND.code);
});

test('one business cannot reply to another business\'s comment or send as it', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/accounts', OTHER);
  const theirs = await addComment(meta, { account: OTHER, mediaId: 'their-reel' });
  const res = await privateReply(meta, theirs);
  assert.equal(errorCode(res), ERRORS.OBJECT_NOT_FOUND.code);
  assert.equal(res.body.error.error_subcode, 33, 'indistinguishable from a comment that does not exist');

  const mine = await addComment(meta);
  const asOther = await graphPost(meta, `${OTHER.igUserId}/messages`, { recipient: { comment_id: mine }, message: { text: 'x' } });
  assert.equal(errorCode(asOther), ERRORS.OBJECT_NOT_FOUND.code, 'my token cannot address their account');
  assert.deepEqual(await sent(meta), []);
});

test('the sending account can be named by me, its IG id or its app-scoped id', async (t) => {
  const meta = await startMeta(t);
  const { body } = await graphPost(meta, 'me/messages', { recipient: { comment_id: await addComment(meta) }, message: { text: 'a' } });
  assert.ok(body.message_id);
  const me = await request(`${meta.url}/v23.0/me`, { headers: bearer(ACCOUNT.token) });
  const scoped = await graphPost(meta, `${me.body.id}/messages`, { recipient: { comment_id: await addComment(meta) }, message: { text: 'b' } });
  assert.equal(scoped.status, 200);
});

test('a business cannot private-reply to its own comment', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta, { from: { id: ACCOUNT.igUserId, username: ACCOUNT.username } });
  assert.equal(errorCode(await privateReply(meta, id)), ERRORS.CANNOT_REPLY.code);
});

test('private replies need the messages and comments permissions', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'no-comments', scopes: [SCOPES.basic, SCOPES.messages] });
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'no-messages', scopes: [SCOPES.basic, SCOPES.comments] });
  assert.equal(errorCode(await privateReply(meta, id, { text: 'x' }, { token: 'no-comments' })), ERRORS.PERMISSION.code);
  assert.equal(errorCode(await privateReply(meta, id, { text: 'x' }, { token: 'no-messages' })), ERRORS.PERMISSION.code);
  assert.deepEqual(await sent(meta), []);
});

test('a private reply cannot carry a message tag', async (t) => {
  const meta = await startMeta(t);
  const res = await privateReply(meta, await addComment(meta), { text: 'x' }, { tag: 'HUMAN_AGENT' });
  assert.equal(errorCode(res), ERRORS.INVALID_PARAM.code);
});

test('an unavailable recipient is refused and the comment stays unused', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta, { from: { id: 'gone' } });
  await meta.post('/people', { igUserId: ACCOUNT.igUserId, id: 'gone', unavailable: true });
  assert.equal(errorCode(await privateReply(meta, id)), ERRORS.RECIPIENT_UNAVAILABLE.code);
  await meta.post('/people', { igUserId: ACCOUNT.igUserId, id: 'gone', unavailable: false });
  assert.equal((await privateReply(meta, id)).status, 200);
});

test('button template limits are enforced at the exact edges', async (t) => {
  const meta = await startMeta(t);
  const url = 'https://shop.example/r/1';
  const button = (title = 'Shop', extra = {}) => ({ type: 'web_url', url, title, ...extra });
  const accepted = [
    buttonMessage({ text: 'x'.repeat(640) }),
    buttonMessage({ buttons: [button(), button(), button()] }),
    buttonMessage({ buttons: [button('y'.repeat(20))] }),
    buttonMessage({ buttons: [button('🎉'.repeat(20))] }),
    buttonMessage({ buttons: [{ type: 'postback', title: 'Send me the link', payload: 'p'.repeat(1000) }] }),
  ];
  for (const message of accepted) {
    const res = await privateReply(meta, await addComment(meta), message);
    assert.equal(res.status, 200, res.text);
  }
  const refused = [
    buttonMessage({ text: 'x'.repeat(641) }),
    buttonMessage({ text: '   ' }),
    buttonMessage({ text: 7 }),
    buttonMessage({ buttons: [] }),
    buttonMessage({ buttons: 'none' }),
    buttonMessage({ buttons: [button(), button(), button(), button()] }),
    buttonMessage({ buttons: [button('y'.repeat(21))] }),
    buttonMessage({ buttons: [button('')] }),
    buttonMessage({ buttons: [button('ok', { url: 'javascript:alert(1)' })] }),
    buttonMessage({ buttons: [button('ok', { url: 'not a url' })] }),
    buttonMessage({ buttons: [{ type: 'phone_number', title: 'Call', payload: '+91' }] }),
    buttonMessage({ buttons: [{ type: 'postback', title: 'Tap' }] }),
    buttonMessage({ buttons: [{ type: 'postback', title: 'Tap', payload: 'p'.repeat(1001) }] }),
    { attachment: { type: 'template', payload: { template_type: 'generic', elements: [] } } },
    { attachment: { type: 'hologram', payload: {} } },
    { attachment: 'x' },
  ];
  for (const message of refused) {
    const res = await privateReply(meta, await addComment(meta), message);
    assert.equal(errorCode(res), ERRORS.INVALID_PARAM.code, JSON.stringify(message).slice(0, 120));
  }
  assert.equal((await sent(meta)).length, accepted.length);
});

test('text is limited to 1000 UTF-8 bytes, not characters', async (t) => {
  const meta = await startMeta(t);
  assert.equal((await privateReply(meta, await addComment(meta), { text: 'x'.repeat(1000) })).status, 200);
  assert.equal(errorCode(await privateReply(meta, await addComment(meta), { text: 'x'.repeat(1001) })), ERRORS.INVALID_PARAM.code);
  assert.equal(errorCode(await privateReply(meta, await addComment(meta), { text: 'न'.repeat(334) })), ERRORS.INVALID_PARAM.code, '334 x 3 bytes = 1002');
  assert.equal((await privateReply(meta, await addComment(meta), { text: 'न'.repeat(333) })).status, 200);
});

test('a message must hold exactly one of text or attachment', async (t) => {
  const meta = await startMeta(t);
  for (const message of [{}, { text: 'a', attachment: { type: 'image', payload: { url: 'https://x.example/a.jpg' } } }, { text: '  ' }, { text: 1 }, 'hello', null, []]) {
    const res = await privateReply(meta, await addComment(meta), message);
    assert.equal(errorCode(res), ERRORS.INVALID_PARAM.code, JSON.stringify(message));
  }
});

test('Graph accepts recipient and message as JSON strings in a form or query', async (t) => {
  const meta = await startMeta(t);
  const form = await request(`${meta.url}/v23.0/${ACCOUNT.igUserId}/messages`, {
    method: 'POST',
    headers: bearer(ACCOUNT.token),
    body: new URLSearchParams({ recipient: JSON.stringify({ comment_id: await addComment(meta) }), message: JSON.stringify({ text: 'via form' }) }),
  });
  assert.equal(form.status, 200, form.text);

  const url = new URL(`${meta.url}/v23.0/${ACCOUNT.igUserId}/messages`);
  url.searchParams.set('recipient', JSON.stringify({ comment_id: await addComment(meta) }));
  url.searchParams.set('message', JSON.stringify({ text: 'via query' }));
  assert.equal((await request(url, { method: 'POST', headers: bearer(ACCOUNT.token) })).status, 200);
  assert.equal(errorCode(await graphPost(meta, 'me/messages', { recipient: 'not-json', message: { text: 'x' } })), ERRORS.INVALID_PARAM.code);
  assert.equal(errorCode(await graphPost(meta, 'me/messages', { message: { text: 'x' } })), ERRORS.INVALID_PARAM.code);
});

test('750 private replies per hour per account, then 613, and the hour rolls', async (t) => {
  const meta = await startMeta(t);
  assert.equal(LIMITS.privateRepliesPerHour, 750);
  await meta.post('/accounts', OTHER);
  const ids = [];
  for (let i = 0; i < 752; i++) ids.push((await meta.post('/comments', { igUserId: ACCOUNT.igUserId, mediaId: 'reel-1', from: { id: 'u' }, text: 'x' })).comment.id);
  for (let i = 0; i < 750; i++) assert.equal((await privateReply(meta, ids[i])).status, 200);

  const over = await privateReply(meta, ids[750]);
  assert.deepEqual([over.status, errorCode(over)], [400, ERRORS.RATE_LIMITED.code]);

  const theirs = await addComment(meta, { account: OTHER, mediaId: 'their-reel' });
  assert.equal((await privateReply(meta, theirs, { text: 'x' }, { account: OTHER })).status, 200, 'another business has its own budget');

  await meta.post('/clock', { advanceMs: HOUR - 1 });
  assert.equal(errorCode(await privateReply(meta, ids[750])), ERRORS.RATE_LIMITED.code);
  await meta.post('/clock', { advanceMs: 1 });
  assert.equal((await privateReply(meta, ids[751])).status, 200);
});

test('a limit can be shrunk for a test', async (t) => {
  const meta = await startMeta(t, { limits: { privateRepliesPerHour: 1 } });
  assert.equal((await privateReply(meta, await addComment(meta))).status, 200);
  assert.equal(errorCode(await privateReply(meta, await addComment(meta))), ERRORS.RATE_LIMITED.code);
  await meta.post('/limits', { privateRepliesPerHour: 2 });
  assert.equal((await privateReply(meta, await addComment(meta))).status, 200);
  await assert.rejects(() => meta.post('/limits', { nope: 1 }), /Unknown limit/);
  await assert.rejects(() => meta.post('/limits', { sendPerSecond: 'many' }), /must be a number/);
});

test('partial success: the DM went out, the caller saw a 500, and a retry is refused', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  await meta.fault({ kind: 'partial', match: { path: '*/messages' } });
  const first = await privateReply(meta, id);
  assert.equal(first.status, 500);
  assert.equal(first.body.error.is_transient, true);
  assert.equal((await sent(meta)).length, 1);
  assert.equal(errorCode(await privateReply(meta, id)), ERRORS.ALREADY_REPLIED.code);
  assert.equal((await sent(meta)).length, 1, 'no second DM');
  const [call] = await meta.calls();
  assert.equal(call.applied, true);
});

test('a timeout with the DM delivered is told apart only by what arrived', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  await meta.fault({ kind: 'partial', then: 'timeout', match: { body: { recipient: { comment_id: id } } } });
  const res = await request(`${meta.url}/v23.0/${ACCOUNT.igUserId}/messages`, { json: { recipient: { comment_id: id }, message: { text: 'x' } }, headers: bearer(ACCOUNT.token), signal: AbortSignal.timeout(150) });
  assert.equal(res.status, null);
  assert.equal((await sent(meta)).length, 1);
});

test('a plain timeout or 5xx leaves the comment repliable', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  await meta.fault({ kind: 'server_error', status: 503 });
  assert.equal((await privateReply(meta, id)).status, 503);
  assert.deepEqual(await sent(meta), []);
  assert.equal((await privateReply(meta, id)).status, 200);
});

test('the fault can target one comment', async (t) => {
  const meta = await startMeta(t);
  const bad = await addComment(meta);
  const good = await addComment(meta);
  await meta.fault({ kind: 'server_error', match: { body: { recipient: { comment_id: bad } } } });
  assert.equal((await privateReply(meta, good)).status, 200);
  assert.equal((await privateReply(meta, bad)).status, 500);
});

test('the real Instagram client works against the simulator', async (t) => {
  const meta = await startMeta(t);
  const ig = createInstagram({ graphBaseUrl: meta.url, graphVersion: 'v23.0' });
  await meta.post('/media', { igUserId: ACCOUNT.igUserId, id: '18000000000000001', caption: 'Brunch look', productType: 'REELS' });
  const account = { igUserId: ACCOUNT.igUserId, token: ACCOUNT.token };

  const text = await addComment(meta, { mediaId: '18000000000000001' });
  assert.ok((await ig.sendPrivateReply(account, text, 'Hello')).message_id);

  const button = await addComment(meta, { mediaId: '18000000000000001' });
  assert.ok((await ig.sendPrivateReplyButton(account, button, 'Here', 'https://shop.example/r/1', 'Shop now')).message_id);

  assert.ok((await ig.replyToComment(account, text, 'Sent you a DM')).id);
  assert.deepEqual(await ig.getAccount(account), { user_id: ACCOUNT.igUserId, username: ACCOUNT.username, id: `9${ACCOUNT.igUserId}` });
  const media = await ig.listMedia(account);
  assert.equal(media.data[0].caption, 'Brunch look');
  assert.equal(media.data[0].media_product_type, 'REELS');
  assert.equal((await ig.getMedia(account, '18000000000000001')).id, '18000000000000001');

  await assert.rejects(() => ig.sendPrivateReply(account, text, 'Again'), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, ERRORS.ALREADY_REPLIED.code);
    return true;
  });
  assert.deepEqual((await sent(meta)).map((m) => m.kind), ['private_reply', 'private_reply', 'public_reply']);
});

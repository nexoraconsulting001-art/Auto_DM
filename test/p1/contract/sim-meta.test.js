// What the Meta simulator gained for Phase 1: stories, ice breakers, profiles, edits, echoes, Standard Access and Facebook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { createMetaClient } from '../../../src/adapters/meta/index.js';

const DAY = 86_400_000;

async function receiver() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      seen.push({ raw, body: JSON.parse(raw.toString()), signature: req.headers['x-hub-signature-256'] });
      res.end('ok');
    });
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}/webhook`, close: () => server.close() };
}

async function withSim(options, run) {
  const hook = await receiver();
  const meta = createMeta({ app: { webhookUrl: hook.url, ...options?.app }, facebookApp: options?.facebookApp });
  await meta.start();
  try {
    await run(meta, hook);
  } finally {
    await meta.close();
    hook.close();
  }
}

const ALL_FIELDS = ['comments', 'messages', 'messaging_postbacks', 'mentions'];
const seed = async (meta, extra = {}) => (await meta.post('/accounts', { igUserId: '1784', username: 'shop', subscribedFields: ALL_FIELDS, ...extra })).token;
const client = (meta) => createMetaClient({ graphBaseUrl: meta.url });
const reader = (meta, token) => client(meta).forAccount({ igUserId: '1784', token });

test('stories have their own edge, are gone after 24 hours, and stay out of the media list', async () => {
  await withSim({}, async (meta) => {
    const token = await seed(meta);
    await meta.post('/media', { igUserId: '1784', id: 'REEL', productType: 'REELS' });
    await meta.post('/media', { igUserId: '1784', id: 'STORY', productType: 'STORY' });
    assert.deepEqual((await reader(meta, token).listMedia()).data.map((m) => m.id), ['REEL']);
    assert.deepEqual((await reader(meta, token).listStories()).data.map((m) => m.id), ['STORY']);
    await meta.post('/clock', { advanceMs: DAY + 1 });
    assert.deepEqual((await reader(meta, token).listStories()).data, []);
  });
});

test('ice breakers are stored, read back, cleared, and held to Meta\'s limits', async () => {
  await withSim({}, async (meta) => {
    const token = await seed(meta);
    const api = reader(meta, token);
    const breakers = (n) => [{ locale: 'default', call_to_actions: Array.from({ length: n }, (_, i) => ({ question: `Q${i}`, payload: `p${i}` })) }];
    await api.setIceBreakers(breakers(4));
    assert.equal((await api.iceBreakers()).data[0].ice_breakers[0].call_to_actions.length, 4);
    await assert.rejects(() => api.setIceBreakers(breakers(5)), (err) => err.kind === 'validation');
    await api.clearIceBreakers();
    assert.deepEqual((await api.iceBreakers()).data, []);
  });
});

test('a person\'s profile is readable when Meta has one, and a missing name stays missing', async () => {
  await withSim({}, async (meta) => {
    const token = await seed(meta);
    await meta.post('/people', { igUserId: '1784', id: '42', name: 'Asha', username: 'asha_k' });
    assert.deepEqual(await reader(meta, token).getPerson('42'), { name: 'Asha', username: 'asha_k', id: '42' });
    await meta.post('/people', { igUserId: '1784', id: '43', username: 'only_handle' });
    assert.equal((await reader(meta, token).getPerson('43')).name, undefined);
    await assert.rejects(() => reader(meta, token).getPerson('999'), (err) => err.kind === 'not_found');
  });
});

test('a comment can be edited or deleted, with or without a webhook', async () => {
  await withSim({}, async (meta, hook) => {
    await seed(meta);
    const { comment } = await meta.post('/comments', { igUserId: '1784', mediaId: 'M1', from: { id: '42', username: 'a' }, text: 'LINK', deliver: false });
    await meta.post('/comments/edit', { id: comment.id, text: 'nothing' });
    assert.equal(hook.seen.length, 0);
    await meta.post('/comments/edit', { id: comment.id, text: 'changed', notify: true });
    await meta.post('/comments/delete', { id: comment.id, notify: true });
    assert.deepEqual(hook.seen.map((d) => d.body.entry[0].changes[0].value.verb), ['edited', 'remove']);
    assert.equal(hook.seen[0].body.entry[0].changes[0].value.text, 'changed');
  });
});

test('the owner typing in the Instagram app comes back as an echo no send made', async () => {
  await withSim({}, async (meta, hook) => {
    await seed(meta);
    const { mid } = await meta.post('/owner-replies', { igUserId: '1784', to: '42', text: 'From my phone' });
    const event = hook.seen[0].body.entry[0].messaging[0];
    assert.equal(event.message.is_echo, true);
    assert.equal(event.message.mid, mid);
    assert.equal(event.sender.id, '1784');
    assert.deepEqual((await meta.get('/sent')).sent, []);
  });
});

test('under Standard Access only accounts with an app role work', async () => {
  await withSim({ app: { accessLevel: 'standard' } }, async (meta, hook) => {
    const stranger = await seed(meta);
    await assert.rejects(() => reader(meta, stranger).getAccount(), (err) => err.kind === 'permission');
    const { delivery } = await meta.post('/comments', { igUserId: '1784', mediaId: 'M1', from: { id: '42' }, text: 'x' });
    assert.equal(delivery.reason, 'standard_access');
    assert.equal(hook.seen.length, 0);

    const { token } = await meta.post('/accounts', { igUserId: '1785', username: 'tester', appRole: true });
    assert.equal((await client(meta).forAccount({ igUserId: '1785', token }).getAccount()).username, 'tester');
  });
});

async function page(meta, extra = {}) {
  const { token } = await meta.post('/pages', { pageId: '55', name: 'Shop', subscribedFields: ['feed', 'messages', 'messaging_postbacks'], ...extra });
  await meta.post('/facebook/posts', { pageId: '55', id: '55_1', message: 'Reel' });
  return { pageId: '55', token };
}

test('Facebook: a comment arrives from the Page feed, signed with the Facebook app\'s own secret', async () => {
  await withSim({ facebookApp: { secret: 'fb-secret' } }, async (meta, hook) => {
    await page(meta);
    await meta.post('/facebook/comments', { pageId: '55', postId: '55_1', id: 'c1', from: { id: '77', name: 'Ravi' }, text: 'price' });
    const [delivery] = hook.seen;
    assert.equal(delivery.body.object, 'page');
    assert.equal(delivery.body.entry[0].id, '55');
    const { field, value } = delivery.body.entry[0].changes[0];
    assert.equal(field, 'feed');
    assert.deepEqual([value.item, value.verb, value.comment_id, value.post_id, value.message], ['comment', 'add', 'c1', '55_1', 'price']);
    assert.equal(delivery.signature, `sha256=${crypto.createHmac('sha256', 'fb-secret').update(delivery.raw).digest('hex')}`);
  });
});

test('Facebook: one private reply per comment, from the Page, within 7 days', async () => {
  await withSim({}, async (meta) => {
    const account = await page(meta);
    const sender = client(meta).sender(account);
    await meta.post('/facebook/comments', { pageId: '55', postId: '55_1', id: 'c1', from: { id: '77' }, text: 'price', deliver: false });
    await meta.post('/facebook/comments', { pageId: '55', postId: '55_1', id: 'old', from: { id: '78' }, text: 'price', at: Date.now() - 8 * DAY, deliver: false });
    await sender.privateReply('c1', { text: 'Here you go' });
    await assert.rejects(() => sender.privateReply('c1', { text: 'Again' }), (err) => err.kind === 'already_replied');
    await assert.rejects(() => sender.privateReply('old', { text: 'Late' }), (err) => err.kind === 'reply_window_closed');
    const { sent } = await meta.get('/sent', { pageId: '55' });
    assert.deepEqual(sent.map((m) => [m.kind, m.recipientId, m.commentId]), [['private_reply', '77', 'c1']]);
  });
});

test('Facebook: Messenger needs the 24-hour window, and a reply marks itself a response', async () => {
  await withSim({}, async (meta) => {
    const account = await page(meta);
    const sender = client(meta).sender(account);
    await assert.rejects(() => sender.dm('77', { text: 'Cold' }), (err) => err.kind === 'window_closed');
    await meta.post('/facebook/messages', { pageId: '55', from: '77', text: 'STOP' });
    await sender.dm('77', { text: 'Done' });
    const [call] = await meta.calls({ method: 'POST', path: '/v23.0/55/messages' }).then((calls) => calls.filter((c) => c.status === 200));
    assert.equal(call.body.messaging_type, 'RESPONSE');
    await meta.post('/clock', { advanceMs: DAY + 1 });
    await assert.rejects(() => sender.dm('77', { text: 'Late' }), (err) => err.kind === 'window_closed');
  });
});

test('Facebook: a public reply, a subscription and the Page\'s posts', async () => {
  await withSim({}, async (meta) => {
    const account = await page(meta);
    const api = client(meta).forAccount(account);
    await meta.post('/facebook/comments', { pageId: '55', postId: '55_1', id: 'c1', from: { id: '77' }, text: 'nice', deliver: false });
    await client(meta).sender(account).publicReply('c1', 'Thanks');
    assert.deepEqual((await meta.get('/sent', { pageId: '55', kind: 'public_reply' })).sent.map((m) => m.message.text), ['Thanks']);
    await api.subscribe(['feed']);
    assert.deepEqual((await api.subscriptions()).data[0].subscribed_fields, ['feed']);
    await api.unsubscribe();
    assert.deepEqual((await api.subscriptions()).data, []);
    assert.deepEqual((await api.listPosts()).data.map((p) => p.id), ['55_1']);
  });
});

test('Facebook: a Page\'s expired token fails only that Page, and Instagram keeps working', async () => {
  await withSim({}, async (meta) => {
    const igToken = await seed(meta);
    const account = await page(meta, { token: 'page-token' });
    await meta.post('/tokens/expire', { token: 'page-token' });
    await assert.rejects(() => client(meta).forAccount(account).subscriptions(), (err) => err.kind === 'token_invalid');
    assert.equal((await reader(meta, igToken).getAccount()).username, 'shop');
  });
});

test('Facebook: a Page token reaches no other Page or Instagram account', async () => {
  await withSim({}, async (meta) => {
    await seed(meta);
    const account = await page(meta);
    const other = await meta.post('/pages', { pageId: '56' });
    await assert.rejects(() => client(meta).sender({ pageId: '56', token: account.token }).dm('77', { text: 'x' }), (err) => err.kind === 'not_found');
    await assert.rejects(() => client(meta).forAccount({ igUserId: '1784', token: other.token }).getAccount(), (err) => err.kind === 'not_found');
  });
});

test('a reset clears Facebook too', async () => {
  await withSim({}, async (meta) => {
    await page(meta);
    await meta.post('/reset');
    await meta.post('/pages', { pageId: '55' });
  });
});

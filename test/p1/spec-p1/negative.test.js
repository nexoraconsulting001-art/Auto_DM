// PRD 4.8: negative-intent skip. C-28 to C-30.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addShop, addStaff, assertNoDm, assertReason, savePublicReplies, unique, useWorld } from './support.js';

const world = useWorld();

test('C-28: "LINK? ordered last week, not received, fraud" is negative_intent, and shows in Needs a human', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate({ keywords: ['link'] });
  const from = world.fan();
  const text = 'LINK? ordered last week, not received, fraud';
  const comment = await shop.comment(reel.mediaId, { from, text });
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'negative_intent', comment.id);
  const items = await shop.needsHuman();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'negative_comment');
  assert.equal(items[0].reason, 'negative_intent');
  assert.equal(items[0].commentId, comment.id);
  assert.equal(items[0].mediaId, reel.mediaId);
  assert.equal(items[0].username, from.username);
  assert.equal(items[0].text, text);
});

test('C-28: a negative comment gets no public reply', async () => {
  const shop = await addShop(world);
  await savePublicReplies(shop);
  const reel = await shop.automate({ keywords: ['link'], publicReplyEnabled: true });
  await shop.comment(reel.mediaId, { text: 'LINK? this is a scam' });
  await shop.settle();
  await world.travel(120_000);
  await shop.settle();
  assert.equal((await shop.publicReplies()).length, 0);
});

test('C-28: the same negative comment delivered twice is one Needs a human item', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate({ keywords: ['link'] });
  await shop.comment(reel.mediaId, { text: 'link fraud', duplicates: 2 });
  await shop.settle();
  assert.equal((await shop.needsHuman()).length, 1);
});

test('C-28: another business can\'t see the item, by list or by resolving its id', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const reel = await a.automate({ keywords: ['link'] });
  await a.comment(reel.mediaId, { text: 'link fraud' });
  await a.settle();
  const [item] = await a.needsHuman();
  assert.deepEqual(await b.needsHuman(), []);
  assert.equal((await b.api(`/inbox/needs-human/${item.id}/resolve`, { method: 'POST' })).status, 404);
  assert.equal((await a.needsHuman())[0].status, 'open');
});

test('C-28: resolving moves it out of the open list', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate({ keywords: ['link'] });
  await shop.comment(reel.mediaId, { text: 'link fraud' });
  await shop.settle();
  const [item] = await shop.needsHuman();
  const done = await shop.call(`/inbox/needs-human/${item.id}/resolve`, 200, { method: 'POST' });
  assert.equal(done.status, 'resolved');
  assert.deepEqual(await shop.needsHuman(), []);
  assert.equal((await shop.needsHuman('resolved')).length, 1);
});

const NEGATIVE = [
  'price? what a scam',
  'PRICE? FRAUD!!',
  'price please, I want a refund',
  'price? parcel not received yet',
  'price? I will file a legal notice',
  'price? going to consumer court',
  'price batao, paisa wapas karo',
  'price chor ho tum',
  'price? dhokha hai ye',
  'price? धोखा है',
  'price बताओ, ठगी है',
  'price? घटिया सामान',
];

for (const text of NEGATIVE) {
  test(`C-28: "${text}" is negative_intent even with the keyword in it`, async () => {
    const shop = await addShop(world);
    const reel = await shop.automate();
    const comment = await shop.comment(reel.mediaId, { text });
    await shop.settle();
    await assertNoDm(shop);
    await assertReason(shop, 'negative_intent', comment.id);
  });
}

test('C-29: "price batao, ye fake hai kya" is negative_intent', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const comment = await shop.comment(reel.mediaId, { text: 'price batao, ye fake hai kya' });
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'negative_intent', comment.id);
});

for (const text of ['PRICE BATAO, YE FAKE HAI KYA', 'price batao ye FaKe hai kya', 'price batao, ye   fake   hai']) {
  test(`C-29: "${text}" is matched whatever its case or spacing`, async () => {
    const shop = await addShop(world);
    const reel = await shop.automate();
    const comment = await shop.comment(reel.mediaId, { text });
    await shop.settle();
    await assertNoDm(shop);
    await assertReason(shop, 'negative_intent', comment.id);
  });
}

for (const text of ['price please', 'price batao bhai', 'kitna price hai', 'loved this, price?', 'price of the fakeer kurta']) {
  test(`C-29: "${text}" is not negative and gets its DM`, async () => {
    const shop = await addShop(world);
    const reel = await shop.automate();
    const comment = await shop.comment(reel.mediaId, { text });
    await shop.settle();
    assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
  });
}

test('C-30: before the owner adds "kharab" it gets a DM; from then on matching comments are skipped', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const before = await shop.comment(reel.mediaId, { text: 'price? kharab hai kya' });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: before.id })).length, 1);
  const word = await shop.call('/compliance/words', 201, { method: 'POST', body: { list: 'negative', word: 'kharab' } });
  assert.equal(word.word, 'kharab');
  const after = await shop.comment(reel.mediaId, { text: 'price? kharab hai kya' });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: after.id })).length, 0);
  await assertReason(shop, 'negative_intent', after.id);
  assert.equal((await shop.needsHuman()).length, 1);
});

test('C-30: an added word is matched whatever its case, in that business only', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  await a.call('/compliance/words', 201, { method: 'POST', body: { list: 'negative', word: 'KHARAB' } });
  const reelA = await a.automate();
  const reelB = await b.automate();
  const inA = await a.comment(reelA.mediaId, { text: 'price kharab' });
  const inB = await b.comment(reelB.mediaId, { text: 'price kharab' });
  await a.settle();
  await b.settle();
  await assertReason(a, 'negative_intent', inA.id);
  assert.equal((await b.dms({ commentId: inB.id })).length, 1);
});

test('C-30: base words can be listed and never removed, and removing an added word works', async () => {
  const shop = await addShop(world);
  const lists = await shop.call('/compliance/words?list=negative', 200);
  assert.ok(lists.base.length > 0, 'Bhava maintains a base list');
  assert.ok(lists.base.every((w) => typeof w === 'string'), 'Base words have no id to delete');
  const added = await shop.call('/compliance/words', 201, { method: 'POST', body: { list: 'negative', word: `word${unique()}` } });
  assert.equal((await shop.api(`/compliance/words/${added.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual((await shop.call('/compliance/words?list=negative', 200)).added, []);
  assert.equal((await shop.call('/compliance/words?list=negative', 200)).base.length, lists.base.length);
});

test('C-30: removing another business\'s word is a 404, and it stays', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const word = await a.call('/compliance/words', 201, { method: 'POST', body: { list: 'negative', word: 'kharab' } });
  assert.equal((await b.api(`/compliance/words/${word.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await a.call('/compliance/words?list=negative', 200)).added.length, 1);
});

test('C-30: adding the same word twice, at the same moment, leaves one row and no 5xx', async () => {
  const shop = await addShop(world);
  const body = { list: 'negative', word: 'kharab' };
  const answers = await Promise.all([shop.api('/compliance/words', { method: 'POST', body }), shop.api('/compliance/words', { method: 'POST', body })]);
  assert.ok(answers.every((r) => r.status < 500), answers.map((r) => r.status).join());
  assert.equal((await shop.call('/compliance/words?list=negative', 200)).added.length, 1);
});

for (const word of ['', '   ', 'x'.repeat(61), 'bad\u0000word']) {
  test(`C-30: a word of ${JSON.stringify(word).slice(0, 20)} is refused`, async () => {
    const shop = await addShop(world);
    assert.equal((await shop.api('/compliance/words', { method: 'POST', body: { list: 'negative', word } })).status, 400);
  });
}

test('C-30: a regular-expression character in a word is a plain character, and can\'t widen the match', async () => {
  const shop = await addShop(world);
  await shop.call('/compliance/words', 201, { method: 'POST', body: { list: 'negative', word: '.*' } });
  const reel = await shop.automate();
  const comment = await shop.comment(reel.mediaId, { text: 'price please' });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
});

test('C-30: adding words needs a manager; staff are refused', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['automations'] });
  assert.equal((await shop.api('/compliance/words', { method: 'POST', token: staff.token, body: { list: 'negative', word: 'kharab' } })).status, 403);
});

const SHORT = ['🔥', '😍😍', 'a', '.', ' x '];
for (const text of SHORT) {
  test(`C-30: "${text}" never triggers an any-comment automation, too_short`, async () => {
    const shop = await addShop(world);
    const reel = await shop.automate({ matchMode: 'any', anyModeAcknowledged: true, keywords: [] });
    const comment = await shop.comment(reel.mediaId, { text });
    await shop.settle();
    await assertNoDm(shop);
    await assertReason(shop, 'too_short', comment.id);
  });
}

// PRD 6.1 to 6.3: comment triggers, keyword matching, story replies and mentions. A-01 to A-18.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, DAY, HOUR, INSIDE_MS, OUTSIDE_MS, addShop, assertNoDm, assertReason, commentPayload, linkOf, mentionAutomation, need, unique, useWorld } from './support.js';

const world = useWorld();

test('A-01: a comment "price" on a Live reel automation: one private reply, sent, with the automation id', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  const dms = await shop.dms();
  assert.equal(dms.length, 1);
  assert.equal(dms[0].kind, 'private_reply');
  assert.equal(dms[0].commentId, comment.id);
  const sent = (await shop.events(`comment_id = $2 AND decision = 'sent'`, [comment.id]));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].automation_id, auto.id);
  assert.equal(sent[0].media_id, auto.mediaId);
  assert.equal((await shop.jobs())[0].status, 'sent');
});

for (const [state, reason] of [['draft', 'automation.draft'], ['paused', 'paused.automation']]) {
  test(`A-01: on a ${state} automation there is no DM, ${reason}`, async () => {
    const shop = await addShop(world);
    const auto = await shop.automate({ state });
    const comment = await shop.comment(auto.mediaId);
    await shop.settle();
    await assertNoDm(shop);
    await assertReason(shop, reason, comment.id);
  });
}

test('A-01: an archived automation answers nothing, and frees its media for a new one', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  await shop.call(`/automations/${auto.id}/state`, 200, { method: 'POST', body: { state: 'archived' } });
  const next = await shop.automate({ mediaId: auto.mediaId });
  assert.notEqual(next.id, auto.id);
  await shop.comment(auto.mediaId);
  await shop.settle();
  const [dm] = await shop.dms();
  assert.equal(dm && (await shop.events(`decision = 'sent'`))[0].automation_id, next.id);
});

test('A-01: one media can\'t have two active automations', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const second = await shop.tryAutomation({ mediaId: auto.mediaId });
  assert.ok(second.status >= 400 && second.status < 500, `Got ${second.status}`);
});

test('A-01: an event for one business with another business\'s automation id in it does nothing', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const autoA = await a.automate();
  await b.comment(await b.reel());
  await b.settle();
  assert.equal((await a.events()).length, 0);
  assert.ok(autoA.id);
});

test('A-02: the business commenting on its own reel gets no DM, own_account', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const comment = await shop.comment(auto.mediaId, { from: { id: shop.igUserId, username: `${shop.slug}_ig` } });
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'own_account', comment.id);
});

test('A-02: the account\'s app-scoped id counts as its own too', async () => {
  const shop = await addShop(world);
  await shop.sql('UPDATE ig_accounts SET app_scoped_id = $3 WHERE tenant_id = $1 AND ig_user_id = $2', [shop.tenantId, shop.igUserId, `9${shop.igUserId}`]);
  const auto = await shop.automate();
  const from = { id: `9${shop.igUserId}`, username: `${shop.slug}_ig` };
  const id = `own-${unique()}`;
  need(await world.webhook(commentPayload(shop, { id, mediaId: auto.mediaId, from })), 200, 'The webhook');
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'own_account', id);
});

test('A-03: a comment on a mapped feed photo gets a DM, and the activity view says post', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.post();
  const auto = await shop.automate({ mediaId, targetType: 'post' });
  const comment = await shop.comment(mediaId);
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
  const { items } = await shop.call(`/compliance/activity?automationId=${auto.id}`, 200);
  const row = items.find((i) => i.commentId === comment.id);
  assert.ok(row);
  assert.ok(Object.values(row).includes('post'), JSON.stringify(row));
});

test('A-03: a reel\'s activity row says reel', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  const { items } = await shop.call(`/compliance/activity?automationId=${auto.id}`, 200);
  assert.ok(Object.values(items.find((i) => i.commentId === comment.id)).includes('reel'));
});

test('A-04: a comment on media with no automation gets no DM, unmapped', async () => {
  const shop = await addShop(world);
  const media = await shop.reel();
  const comment = await shop.comment(media);
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'unmapped', comment.id);
});

for (const [id, label, productType] of [['A-05', 'an ad', 'AD'], ['A-06', 'a Live broadcast', 'LIVE']]) {
  test(`${id}: a comment on ${label} gets no DM, unsupported_media, even when the media has an automation`, async () => {
    const shop = await addShop(world);
    const mediaId = await shop.reel({ productType });
    await shop.automate({ mediaId });
    const comment = await shop.comment(mediaId);
    await shop.settle();
    await assertNoDm(shop);
    await assertReason(shop, 'unsupported_media', comment.id);
  });
}

test('A-05: a lowercase media type is still an ad', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await shop.automate({ mediaId });
  const id = `ad-${unique()}`;
  need(await world.webhook(commentPayload(shop, { id, mediaId, from: world.fan(), productType: 'ad' })), 200, 'The webhook');
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'unsupported_media', id);
});

test('A-06: a comment arriving on the Live comments field is skipped too', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await shop.automate({ mediaId });
  const id = `live-${unique()}`;
  need(await world.webhook(commentPayload(shop, { id, mediaId, from: world.fan(), productType: 'REELS', field: 'live_comments' })), 200, 'The webhook');
  await shop.settle();
  await assertNoDm(shop);
});

const CASES = [
  ['A-07', 'price', 'PRICE?', true],
  ['A-07', 'price', 'Price please', true],
  ['A-07', 'price', 'what is the (price)', true],
  ['A-07', 'price', '#price', true],
  ['A-07', 'price', 'price.', true],
  ['A-07', 'PRICE', 'price', true],
  ['A-07', 'straße', 'STRASSE', true],
  ['A-08', 'price', 'priceless', false],
  ['A-08', 'price', 'overprice', false],
  ['A-08', 'price', 'price2', false],
  ['A-08', 'price', '2price', false],
  ['A-08', 'price', 'pricé', false],
  ['A-09', 'भाव', 'भावों में', false],
  ['A-09', 'भाव', 'प्रभाव', false],
  ['A-09', 'भाव', 'स्वभाव अच्छा', false],
  ['A-09', 'भाव', 'भाव?', true],
  ['A-09', 'भाव', 'क्या भाव है', true],
  ['A-09', 'दाम', 'दामों', false],
  ['A-10', 'kitne ka', 'Kitne   ka hai?', true],
  ['A-10', 'kitne ka', 'KITNE KA', true],
  ['A-10', 'kitne ka', 'kitne ka', true],
  ['A-10', 'kitne ka', 'kitne bhi ka', false],
  ['A-10', 'kitne ka', 'kitneka', false],
  ['A-10', 'kitne ka', 'ka kitne', false],
  ['A-11', 'दाम'.normalize('NFD'), 'दाम बताओ'.normalize('NFC'), true],
  ['A-11', 'दाम'.normalize('NFC'), 'दाम बताओ'.normalize('NFD'), true],
  ['A-11', 'café'.normalize('NFD'), 'café menu'.normalize('NFC'), true],
  ['A-12', '🔥', '🔥🔥 want', true],
  ['A-12', '🔥', 'want🔥', true],
  ['A-12', '🔥', '🔥', true],
  ['A-12', '🔥', 'want 😍', false],
];

for (const [id, keyword, text, match] of CASES) {
  test(`${id}: keyword ${JSON.stringify(keyword)}, comment ${JSON.stringify(text)}: ${match ? 'match' : 'no match'}`, async () => {
    const shop = await addShop(world);
    const auto = await shop.automate({ keywords: [keyword] });
    const comment = await shop.comment(auto.mediaId, { text });
    await shop.settle();
    if (match) {
      assert.equal((await shop.dms({ commentId: comment.id })).length, 1, 'A match gets a DM');
    } else {
      await assertNoDm(shop);
      await assertReason(shop, 'no_keyword', comment.id);
    }
  });
}

test('A-07: the keyword is plain text, not a pattern', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ keywords: ['c++', '(a|b)'] });
  const bad = await shop.comment(auto.mediaId, { text: 'cccc a' });
  await shop.settle();
  await assertReason(shop, 'no_keyword', bad.id);
  const good = await shop.comment(auto.mediaId, { text: 'I want c++' });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: good.id })).length, 1);
});

test('A-08: a hostile comment 2,000 characters long is handled in the ordinary time, with no match', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ keywords: ['kitne ka'] });
  const comment = await shop.comment(auto.mediaId, { text: `${'kitne '.repeat(300)}x` });
  const started = Date.now();
  await shop.settle();
  assert.ok(Date.now() - started < 6000);
  await assertReason(shop, 'no_keyword', comment.id);
});

test('A-10: up to 20 keywords save, and 21 don\'t', async () => {
  const shop = await addShop(world);
  const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`);
  need(await shop.tryAutomation({ mediaId: await shop.reel(), keywords: words(20) }), 201, '20 keywords');
  assert.equal((await shop.tryAutomation({ mediaId: await shop.reel(), keywords: words(21) })).status, 400);
  assert.equal(COMPLIANCE_LIMITS.keywordsMax, 20);
});

test('A-10: any of an automation\'s keywords will do', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ keywords: ['price', 'rate', 'daam'] });
  const comment = await shop.comment(auto.mediaId, { text: 'kya daam hai' });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
});

test('A-12: any-comment mode needs the Reach Guard acknowledgement', async () => {
  const shop = await addShop(world);
  const res = await shop.tryAutomation({ mediaId: await shop.reel(), matchMode: 'any', keywords: [], anyModeAcknowledged: false });
  assert.equal(res.status, 400);
  need(await shop.tryAutomation({ mediaId: await shop.reel(), matchMode: 'any', keywords: [], anyModeAcknowledged: true }), 201, 'With it');
});

const storyAuto = (shop, storyId, extra = {}) => shop.automate({ triggerType: 'story_reply', keywords: [], mediaId: storyId, targetType: 'story', matchMode: 'any', anyModeAcknowledged: true, ...extra });

test('A-13: someone replying "link" to a story with an automation gets one DM with that story\'s link', async () => {
  const shop = await addShop(world);
  const storyId = await shop.story();
  const linkUrl = shop.siteUrl('/story-item');
  await storyAuto(shop, storyId, { linkUrl });
  const person = world.fan();
  await shop.storyReply(person, 'link', storyId);
  await shop.settle();
  const dms = await shop.dms({ recipientId: person.id });
  assert.equal(dms.length, 1);
  assert.equal(dms[0].kind, 'send_api', 'A story reply goes through the Send API to the sender');
  assert.equal(new URL(linkOf(dms[0])).pathname, '/story-item');
});

test('A-13: with a keyword set, a story reply without it gets nothing', async () => {
  const shop = await addShop(world);
  const storyId = await shop.story();
  await shop.automate({ triggerType: 'story_reply', mediaId: storyId, targetType: 'story', keywords: ['link'] });
  await shop.storyReply(world.fan(), 'lovely!', storyId);
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'no_keyword');
});

test('A-13: the same story reply delivered twice at the same moment is one DM', async () => {
  const shop = await addShop(world);
  const storyId = await shop.story();
  await storyAuto(shop, storyId);
  const person = world.fan();
  await shop.storyReply(person, 'link', storyId, { duplicates: 2 });
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-13: one person replying to a story twice is 1 DM, cap.per_media', async () => {
  const shop = await addShop(world);
  const storyId = await shop.story();
  await storyAuto(shop, storyId);
  const person = world.fan();
  await shop.storyReply(person, 'link', storyId);
  await shop.settle();
  await shop.storyReply(person, 'link please', storyId);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
  await assertReason(shop, 'cap.per_media');
});

test('A-13: the tenant\'s "any story reply" automation catches a story with none of its own', async () => {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'story_reply', keywords: [], matchMode: 'any', anyModeAcknowledged: true, triggers: [{ channel: 'instagram', targetType: 'any_story' }] });
  const person = world.fan();
  await shop.storyReply(person, 'nice', await shop.story());
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-13: a story\'s own automation beats the "any story reply" one', async () => {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'story_reply', keywords: [], matchMode: 'any', anyModeAcknowledged: true, linkUrl: shop.siteUrl('/any'), triggers: [{ channel: 'instagram', targetType: 'any_story' }] });
  const storyId = await shop.story();
  await storyAuto(shop, storyId, { linkUrl: shop.siteUrl('/own') });
  const person = world.fan();
  await shop.storyReply(person, 'nice', storyId);
  await shop.settle();
  assert.equal(new URL(linkOf((await shop.dms({ recipientId: person.id }))[0])).pathname, '/own');
});

test('A-13: a story trigger on a Free plan isn\'t included', async () => {
  const shop = await addShop(world, { plan: 'free' });
  const res = await shop.tryAutomation({ triggerType: 'story_reply', keywords: ['link'], mediaId: await shop.story(), targetType: 'story', linkMode: 'two_tap' });
  assert.ok(res.status >= 400 && res.status < 500, `Got ${res.status}`);
});

test('A-14: a story reply with no story automation and no "any" rule gets no DM, unmapped', async () => {
  const shop = await addShop(world);
  await shop.storyReply(world.fan(), 'link', await shop.story());
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'unmapped');
});

test('A-15: an emoji-only reaction to a story whose automation excludes them gets no DM, no_keyword', async () => {
  const shop = await addShop(world);
  const storyId = await shop.story();
  await storyAuto(shop, storyId, { includeReactions: false });
  await shop.storyReply(world.fan(), '😍', storyId);
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'no_keyword');
});

test('A-15: an automation that includes reactions answers them', async () => {
  const shop = await addShop(world);
  const storyId = await shop.story();
  await storyAuto(shop, storyId, { includeReactions: true });
  const person = world.fan();
  await shop.storyReply(person, '😍', storyId);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

const mentionAuto = mentionAutomation;

test('A-16: a mention from someone with no recent DM gets no DM, mention.no_window', async () => {
  const shop = await addShop(world);
  await mentionAuto(shop);
  await shop.mention(world.fan());
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'mention.no_window');
});

test('A-16: a mention opens no window of its own: a second mention still gets nothing', async () => {
  const shop = await addShop(world);
  await mentionAuto(shop);
  const person = world.fan();
  await shop.mention(person);
  await shop.settle();
  await shop.mention(person);
  await shop.settle();
  await assertNoDm(shop);
});

async function mentioned() {
  const shop = await addShop(world);
  await mentionAuto(shop);
  const person = world.fan();
  await shop.dm(person, 'hello');
  await shop.settle();
  await world.travel(HOUR);
  await shop.mention(person);
  await shop.settle();
  return { shop, person };
}

test('A-17: a mention from someone who sent a DM an hour earlier gets one DM', async () => {
  const { shop, person } = await mentioned();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-17: the same mention delivered twice is one DM', async () => {
  const shop = await addShop(world);
  await mentionAuto(shop);
  const person = world.fan();
  await shop.dm(person, 'hello');
  await shop.settle();
  await shop.mention(person, { duplicates: 2 });
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-18: the same person mentioning again 2 days later gets no DM, cap.mention_7d', async () => {
  const { shop, person } = await mentioned();
  await world.travel(2 * DAY);
  await shop.dm(person, 'hi again');
  await shop.settle();
  await shop.mention(person);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
  await assertReason(shop, 'cap.mention_7d');
});

test('A-18: just inside 7 days it is still capped', async () => {
  const { shop, person } = await mentioned();
  await world.travel(7 * DAY - INSIDE_MS);
  await shop.dm(person, 'hi again');
  await shop.settle();
  await shop.mention(person);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-18: a second past 7 days a mention can get a DM again', async () => {
  const { shop, person } = await mentioned();
  await world.travel(7 * DAY + OUTSIDE_MS);
  await shop.dm(person, 'hi again');
  await shop.settle();
  await shop.mention(person);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 2);
});

test('A-18: two mentions at the same moment get one DM', async () => {
  const shop = await addShop(world);
  await mentionAuto(shop);
  const person = world.fan();
  await shop.dm(person, 'hello');
  await shop.settle();
  await Promise.all([shop.mention(person), shop.mention(person)]);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

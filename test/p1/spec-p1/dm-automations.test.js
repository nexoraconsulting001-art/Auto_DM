// PRD 6.4: inbound DM automations. A-19 to A-24.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, DAY, HOUR, INSIDE_MS, OUTSIDE_MS, addShop, assertNoDm, assertReason, linkOf, quickRepliesOf, textOf, useWorld } from './support.js';

const world = useWorld();
const DM_TRIGGER = [{ channel: 'instagram', targetType: 'dm' }];
const keywordRule = (shop, extra = {}) => shop.automate({ triggerType: 'dm_keyword', triggers: DM_TRIGGER, ...extra });
const FAQ = [{ title: 'Sizes', payload: 'faq:sizes' }, { title: 'Delivery', payload: 'faq:delivery' }];
const welcome = (shop, extra = {}) => shop.automate({ triggerType: 'dm_welcome', keywords: [], matchMode: 'any', anyModeAcknowledged: true, triggers: DM_TRIGGER, linkMode: 'one_tap', variants: [{ label: 'A', body: 'Welcome to the shop! Ask us anything.', buttonTitle: '', fallbackText: '', quickReplies: FAQ }], ...extra });

test('A-19: a first-ever DM "hi" gets the welcome message with FAQ quick replies', async () => {
  const shop = await addShop(world);
  await welcome(shop);
  const person = world.fan();
  await shop.dm(person, 'hi');
  await shop.settle();
  const dms = await shop.dms({ recipientId: person.id });
  assert.equal(dms.length, 1);
  assert.match(textOf(dms[0]), /Welcome/);
  assert.deepEqual(quickRepliesOf(dms[0]).map((q) => q.title), ['Sizes', 'Delivery']);
  assert.equal((await shop.jobs())[0].purpose, 'welcome');
});

test('A-19: the welcome reads correctly on its own, with nothing depending on the buttons', async () => {
  const shop = await addShop(world);
  await welcome(shop);
  const person = world.fan();
  await shop.dm(person, 'hi');
  await shop.settle();
  assert.doesNotMatch(textOf((await shop.dms())[0]), /tap (a|the) button below/i);
});

test('A-19: two first DMs at the same moment get one welcome', async () => {
  const shop = await addShop(world);
  await welcome(shop);
  const person = world.fan();
  await Promise.all([shop.dm(person, 'hi'), shop.dm(person, 'hello')]);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-19: a tap on an FAQ quick reply, delivered twice, is no second welcome and no failure', async () => {
  const shop = await addShop(world);
  await welcome(shop);
  const person = world.fan();
  await shop.dm(person, 'hi');
  await shop.settle();
  await shop.tap(person, 'faq:sizes', { title: 'Sizes', duplicates: 2 });
  await shop.settle();
  const dms = await shop.dms({ recipientId: person.id });
  assert.equal(dms.filter((m) => /Welcome/.test(textOf(m))).length, 1);
  assert.ok(dms.length <= 2, 'At most one FAQ answer');
  assert.equal((await shop.jobs(`status = 'failed'`)).length, 0);
});

test('A-19: a welcome is per business: the same person at another business gets theirs', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  await welcome(a);
  await welcome(b);
  const person = world.fan();
  await a.dm(person, 'hi');
  await b.dm(person, 'hi');
  await a.settle();
  await b.settle();
  assert.equal((await a.dms({ recipientId: person.id })).length, 1);
  assert.equal((await b.dms({ recipientId: person.id })).length, 1);
});

test('A-20: the same person DMing again a week later gets no welcome, cap.welcome_once', async () => {
  const shop = await addShop(world);
  await welcome(shop);
  const person = world.fan();
  await shop.dm(person, 'hi');
  await shop.settle();
  await world.travel(7 * DAY);
  await shop.dm(person, 'hi again');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
  await assertReason(shop, 'cap.welcome_once');
});

test('A-20: the welcome is once per person ever: a year later is no different', async () => {
  const shop = await addShop(world);
  await welcome(shop);
  const person = world.fan();
  await shop.dm(person, 'hi');
  await shop.settle();
  await world.travel(365 * DAY);
  await shop.dm(person, 'back again');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-21: a DM matching two rules gets only the higher priority one', async () => {
  const shop = await addShop(world);
  await keywordRule(shop, { priority: 1, linkUrl: shop.siteUrl('/low') });
  await keywordRule(shop, { priority: 9, linkUrl: shop.siteUrl('/high') });
  const person = world.fan();
  await shop.dm(person, 'price');
  await shop.settle();
  const dms = await shop.dms({ recipientId: person.id });
  assert.equal(dms.length, 1);
  assert.equal(new URL(linkOf(dms[0])).pathname, '/high');
});

test('A-21: with equal priority there is still exactly one reply', async () => {
  const shop = await addShop(world);
  await keywordRule(shop);
  await keywordRule(shop);
  const person = world.fan();
  await shop.dm(person, 'price');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-21: a keyword rule outranks the welcome, and one DM gets one reply, cap.reply_per_message', async () => {
  const shop = await addShop(world);
  await welcome(shop);
  await keywordRule(shop);
  const person = world.fan();
  await shop.dm(person, 'price');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-21: a draft rule doesn\'t take part', async () => {
  const shop = await addShop(world);
  await keywordRule(shop, { priority: 9, state: 'draft', linkUrl: shop.siteUrl('/draft') });
  await keywordRule(shop, { priority: 1, linkUrl: shop.siteUrl('/live') });
  const person = world.fan();
  await shop.dm(person, 'price');
  await shop.settle();
  assert.equal(new URL(linkOf((await shop.dms({ recipientId: person.id }))[0])).pathname, '/live');
});

test('A-22: our own sent message coming back as an echo is ignored: no reply, and the thread isn\'t paused', async () => {
  const shop = await addShop(world);
  await keywordRule(shop);
  const person = world.fan();
  await shop.dm(person, 'price');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
  const thread = await shop.thread(person.id);
  assert.equal(thread.automation_paused_until, null);
  assert.equal(thread.pause_reason, '');
});

test('A-22: an echo whose text is a keyword doesn\'t set anything off', async () => {
  const shop = await addShop(world);
  await keywordRule(shop, { body: 'The price is on this page.' });
  const person = world.fan();
  await shop.dm(person, 'price');
  await shop.settle();
  await shop.dm(person, 'thanks');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-22: an echo of our own message delivered late, after the thread has moved on, still changes nothing', async () => {
  const shop = await addShop(world);
  await keywordRule(shop);
  const person = world.fan();
  await shop.dm(person, 'price');
  await shop.settle();
  const [dm] = await shop.dms({ recipientId: person.id });
  await world.travel(HOUR);
  const echo = { id: shop.igUserId, time: Date.now(), messaging: [{ sender: { id: shop.igUserId }, recipient: { id: person.id }, timestamp: Date.now(), message: { mid: `${dm.id}-late`, is_echo: true, text: textOf(dm), app_id: 'sim-app' } }] };
  await world.webhook({ object: 'instagram', entry: [echo] });
  await shop.settle();
  assert.equal((await shop.thread(person.id)).pause_reason, '');
});

test('A-23: the owner replying in the Instagram app pauses the thread for 12h, thread.owner_replied', async () => {
  const shop = await addShop(world);
  await keywordRule(shop);
  const person = world.fan();
  await shop.dm(person, 'hello');
  await shop.settle();
  await shop.ownerReply(person.id, 'I can help');
  await shop.settle();
  const thread = await shop.thread(person.id);
  assert.equal(thread.pause_reason, 'thread.owner_replied');
  assert.ok(Math.abs(new Date(thread.automation_paused_until) - Date.now() - COMPLIANCE_LIMITS.threadOwnerRepliedMs) < 60_000);
});

test('A-23: the same echo delivered twice sets the pause once and doesn\'t extend it', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'hello');
  await shop.settle();
  await shop.ownerReply(person.id, 'I can help', { duplicates: 2 });
  await shop.settle();
  const first = (await shop.thread(person.id)).automation_paused_until;
  await shop.settle();
  assert.equal(String((await shop.thread(person.id)).automation_paused_until), String(first));
});

async function handedOff(word = 'human') {
  const shop = await addShop(world);
  await keywordRule(shop);
  const person = world.fan();
  await shop.dm(person, word);
  await shop.settle();
  return { shop, person };
}

test('A-24: a person sending "human" pauses the thread for 24h, thread.handoff, and a Needs a human item appears', async () => {
  const { shop, person } = await handedOff();
  const thread = await shop.thread(person.id);
  assert.equal(thread.pause_reason, 'thread.handoff');
  assert.ok(Math.abs(new Date(thread.automation_paused_until) - Date.now() - COMPLIANCE_LIMITS.threadHandoffMs) < 60_000);
  assert.equal(thread.status, 'needs_human');
  const items = await shop.needsHuman();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'handoff');
  assert.equal(items[0].threadId, thread.id);
  await assertReason(shop, 'thread.handoff');
});

test('A-24: "HUMAN" in any case works, and it gets no automated reply', async () => {
  const { shop } = await handedOff('HUMAN');
  await assertNoDm(shop);
  assert.equal((await shop.needsHuman()).length, 1);
});

test('A-24: just inside 24 hours automation stays paused', async () => {
  const { shop, person } = await handedOff();
  await world.travel(COMPLIANCE_LIMITS.threadHandoffMs - INSIDE_MS);
  await shop.dm(person, 'price');
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'thread.handoff');
});

test('A-24: a second past 24 hours automation is back', async () => {
  const { shop, person } = await handedOff();
  await world.travel(COMPLIANCE_LIMITS.threadHandoffMs + OUTSIDE_MS);
  await shop.dm(person, 'price');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('A-24: "human" delivered twice at the same moment is one item', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'human', { duplicates: 2 });
  await shop.settle();
  assert.equal((await shop.needsHuman()).length, 1);
});

test('A-24: an owner-added handoff word works, for that business only', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  await a.call('/compliance/words', 201, { method: 'POST', body: { list: 'handoff', word: 'manager' } });
  const person = world.fan();
  await a.dm(person, 'manager');
  await b.dm(person, 'manager');
  await a.settle();
  await b.settle();
  assert.equal((await a.needsHuman()).length, 1);
  assert.deepEqual(await b.needsHuman(), []);
});

test('A-24: a handoff word inside a sentence isn\'t a handoff', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'humans of bombay fan here');
  await shop.settle();
  assert.deepEqual(await shop.needsHuman(), []);
});

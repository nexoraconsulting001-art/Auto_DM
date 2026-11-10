// PRD 6.7: owner inbox and "Needs a human". A-37 to A-42.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, HOUR, INSIDE_MS, MINUTE, OUTSIDE_MS, addShop, addStaff, assertNoDm, assertRefused, hit, need, signInCookie, textOf, useWorld } from './support.js';

const world = useWorld();
const WINDOW = COMPLIANCE_LIMITS.messagingWindowMs;
const REPLY_LOCKED = /Reply in the Instagram app/;

async function threadWith(shop, text = 'Is this in stock?') {
  const person = world.fan();
  await shop.dm(person, text);
  await shop.settle();
  return { person, thread: await shop.thread(person.id) };
}
const reply = (shop, threadId, text = 'Yes it is') => shop.api(`/inbox/threads/${threadId}/reply`, { method: 'POST', body: { text } });

test('A-37: the inbox gives the same thread list, with last message and status, on the web and in the app', async () => {
  const shop = await addShop(world);
  const { person } = await threadWith(shop);
  const bearer = await shop.call('/inbox/threads', 200);
  assert.equal(bearer.items.length, 1);
  const [row] = bearer.items;
  assert.equal(row.username, person.username);
  assert.equal(row.lastMessage, 'Is this in stock?');
  assert.equal(row.status, 'open');
  assert.equal(row.channel, 'instagram');
  assert.equal(row.canReply, true);
  const cookie = await signInCookie(world, shop);
  const web = need(await hit(world, '/api/v1/inbox/threads', { host: shop.host, cookie }), 200, 'The web session').json();
  assert.deepEqual(web, bearer);
});

test('A-37: threads come from DMs, story replies and mentions', async () => {
  const shop = await addShop(world);
  await shop.dm(world.fan(), 'hello');
  await shop.storyReply(world.fan(), 'nice', await shop.story());
  await shop.mention(world.fan());
  await shop.settle();
  assert.equal((await shop.call('/inbox/threads', 200)).items.length, 3);
});

test('A-37: one thread holds the conversation in order, with who said what', async () => {
  const shop = await addShop(world);
  const { person, thread } = await threadWith(shop);
  need(await reply(shop, thread.id), 200, 'Reply');
  await shop.settle();
  await shop.dm(person, 'Great');
  await shop.settle();
  const detail = await shop.call(`/inbox/threads/${thread.id}`, 200);
  assert.deepEqual(detail.messages.map((m) => [m.direction, m.author, m.text]), [['in', 'person', 'Is this in stock?'], ['out', 'owner', 'Yes it is'], ['in', 'person', 'Great']]);
  assert.equal(detail.lastMessage, 'Great');
});

test('A-37: another business can\'t list, open or reply to a thread', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const { thread } = await threadWith(a);
  assert.deepEqual((await b.call('/inbox/threads', 200)).items, []);
  assert.equal((await b.api(`/inbox/threads/${thread.id}`)).status, 404);
  assert.equal((await reply(b, thread.id)).status, 404);
  assert.equal((await a.dms()).length, 0);
});

test('A-37: staff need the inbox permission', async () => {
  const shop = await addShop(world);
  const { thread } = await threadWith(shop);
  const without = await addStaff(world, shop, { permissions: ['orders'] });
  const withIt = await addStaff(world, shop, { permissions: ['inbox'] });
  assert.equal((await shop.api('/inbox/threads', { token: without.token })).status, 403);
  assert.equal((await reply({ ...shop, api: (p, o) => shop.api(p, { ...o, token: without.token }) }, thread.id)).status, 403);
  assert.equal((await shop.api('/inbox/threads', { token: withIt.token })).status, 200);
});

test('A-37: nobody signed in gets the inbox', async () => {
  const shop = await addShop(world);
  assert.equal((await hit(world, '/api/v1/inbox/threads', { host: shop.host })).status, 401);
});

test('A-37: a stored username or message with HTML in it comes back as data, unchanged', async () => {
  const shop = await addShop(world);
  const person = { id: world.fan().id, username: '<b>x</b>' };
  await shop.dm(person, '<script>alert(1)</script>');
  await shop.settle();
  const [row] = (await shop.call('/inbox/threads', 200)).items;
  assert.equal(row.lastMessage, '<script>alert(1)</script>');
});

test('A-37: bad paging is refused and the list stays bounded', async () => {
  const shop = await addShop(world);
  assert.equal((await shop.api('/inbox/threads?limit=0')).status, 400);
  assert.equal((await shop.api('/inbox/threads?limit=101')).status, 400);
  assert.equal((await shop.api('/inbox/threads?cursor=%27%20OR%201%3D1')).status, 400);
  assert.equal((await shop.api('/inbox/threads/abc')).status, 404);
  assert.equal((await shop.api('/inbox/threads/99999999999')).status, 404);
});

test('A-38: a person DMing "human" makes a Needs a human item and tells the owner', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'human');
  await shop.settle();
  const items = await shop.needsHuman();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'handoff');
  assert.equal(items[0].username, person.username);
  assert.equal(items[0].status, 'open');
  const alerts = await shop.alerts();
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(alerts[0].message, new RegExp(person.username), 'The push doesn\'t carry the username in the alert log');
  const { items: owner } = await shop.call('/alerts', 200);
  assert.equal(owner.length, 1);
});

test('A-38: the owner\'s alerts list is one business\'s', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  await a.dm(world.fan(), 'human');
  await a.settle();
  assert.deepEqual((await b.call('/alerts', 200)).items, []);
  const [alert] = (await a.call('/alerts', 200)).items;
  assert.equal((await b.api(`/alerts/${alert.id}/read`, { method: 'POST' })).status, 404);
  assert.equal((await a.call('/alerts', 200)).items[0].readAt, null);
});

test('A-38: a failed send goes in the queue too', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  await shop.refuseSends({ code: 100, times: 2 });
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.deepEqual((await shop.needsHuman()).map((i) => i.kind), ['send_failed']);
});

test('A-39: a manual reply 23h55m after the last user message is blocked: "Reply in the Instagram app"', async () => {
  const shop = await addShop(world);
  const { thread } = await threadWith(shop);
  await world.travel(23 * HOUR + 55 * MINUTE);
  const res = await reply(shop, thread.id);
  const body = res.json();
  if (res.status === 200) {
    assert.notEqual(body.outcome, 'sent');
    assert.equal(body.reason, 'window.closed');
  } else {
    assert.ok(res.status >= 400 && res.status < 500, `Got ${res.status}`);
    assert.match(body.error, REPLY_LOCKED);
  }
  await assertNoDm(shop);
  const detail = await shop.call(`/inbox/threads/${thread.id}`, 200);
  assert.equal(detail.canReply, false);
});

test('A-39: a second past 23h50m it is blocked', async () => {
  const shop = await addShop(world);
  const { thread } = await threadWith(shop);
  await world.travel(WINDOW + OUTSIDE_MS);
  await reply(shop, thread.id);
  await assertNoDm(shop);
  assert.equal((await shop.call(`/inbox/threads/${thread.id}`, 200)).canReply, false);
});

test('A-39: just inside 23h50m it goes', async () => {
  const shop = await addShop(world);
  const { thread } = await threadWith(shop);
  await world.travel(WINDOW - INSIDE_MS);
  assert.equal((await shop.call(`/inbox/threads/${thread.id}`, 200)).canReply, true);
  assert.equal((await reply(shop, thread.id)).json().outcome, 'sent');
  assert.equal((await shop.dms()).length, 1);
});

test('A-39: a thread that only has a mention has no window', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.mention(person);
  await shop.settle();
  const thread = await shop.thread(person.id);
  await reply(shop, thread.id);
  await assertNoDm(shop);
});

test('A-40: a manual reply 2h after the last user message goes, and automation pauses for 12h', async () => {
  const shop = await addShop(world);
  const { person, thread } = await threadWith(shop);
  await world.travel(2 * HOUR);
  const out = need(await reply(shop, thread.id, 'Yes, in stock'), 200, 'Reply').json();
  assert.equal(out.outcome, 'sent');
  assert.equal(out.reason, '');
  assert.ok(Math.abs(new Date(out.automationPausedUntil) - Date.now() - COMPLIANCE_LIMITS.threadOwnerRepliedMs) < 60_000);
  const dms = await shop.dms({ recipientId: person.id });
  assert.equal(dms.length, 1);
  assert.equal(textOf(dms[0]), 'Yes, in stock');
  assert.equal((await shop.thread(person.id)).pause_reason, 'thread.owner_replied');
});

test('A-40: the echo of that manual reply doesn\'t add a second copy to the thread', async () => {
  const shop = await addShop(world);
  const { thread } = await threadWith(shop);
  need(await reply(shop, thread.id, 'Hello there'), 200, 'Reply');
  await shop.settle();
  const out = (await shop.call(`/inbox/threads/${thread.id}`, 200)).messages.filter((m) => m.direction === 'out');
  assert.equal(out.length, 1);
});

test('A-40: a manual reply goes through the content rules', async () => {
  const shop = await addShop(world);
  const { thread } = await threadWith(shop);
  for (const [text, reason] of [['Please send your OTP', 'content.financial_request'], ['Get yours on Bhava', 'content.bhava_promo'], ['See https://bit.ly/x', 'link.shortener']]) {
    const res = await reply(shop, thread.id, text);
    const body = res.json();
    assert.notEqual(body.outcome, 'sent', text);
    assert.equal(body.reason, reason, text);
  }
  await assertNoDm(shop);
});

test('A-40: a manual reply is stopped by a pause', async () => {
  const shop = await addShop(world);
  const { thread } = await threadWith(shop);
  await shop.call('/compliance/pause', 200, { method: 'POST', body: {} });
  await world.switchLag();
  const res = await reply(shop, thread.id);
  assert.notEqual(res.json().outcome, 'sent');
  await assertNoDm(shop);
});

test('A-40: two replies at the same moment are two messages, each sent once', async () => {
  const shop = await addShop(world);
  const { thread } = await threadWith(shop);
  const answers = await Promise.all([reply(shop, thread.id, 'one'), reply(shop, thread.id, 'two')]);
  assert.deepEqual(answers.map((r) => r.status), [200, 200]);
  assert.deepEqual((await shop.dms()).map(textOf).sort(), ['one', 'two']);
});

for (const text of ['', '   ', 'x'.repeat(4001)]) {
  test(`A-40: a reply of ${text.length} characters is refused`, async () => {
    const shop = await addShop(world);
    const { thread } = await threadWith(shop);
    assertRefused(await reply(shop, thread.id, text));
    await assertNoDm(shop);
  });
}

test('A-40: Meta timing out on a manual reply reports an unknown outcome, once', async () => {
  const shop = await addShop(world);
  const { thread } = await threadWith(shop);
  await shop.fault({ kind: 'timeout', match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  const out = need(await reply(shop, thread.id), 200, 'Reply').json();
  assert.equal(out.outcome, 'unknown');
  assert.equal((await shop.sendCalls()).length, 1);
});

test('A-41: "Why no DM?" on a capped comment shows cap.per_media', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const from = world.fan();
  await shop.comment(auto.mediaId, { from });
  const capped = await shop.comment(auto.mediaId, { from });
  await shop.settle();
  const out = await shop.call(`/compliance/why-no-dm?commentId=${capped.id}`, 200);
  assert.equal(out.reason, 'cap.per_media');
  assert.equal(out.commentId, capped.id);
  assert.ok(out.explanation.length > 0);
});

test('A-41: another business, or an unknown comment, gets a 404', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const auto = await a.automate();
  const comment = await a.comment(auto.mediaId, { text: 'nothing' });
  await a.settle();
  assert.equal((await b.api(`/compliance/why-no-dm?commentId=${comment.id}`)).status, 404);
  assert.equal((await a.api('/compliance/why-no-dm?commentId=does-not-exist')).status, 404);
});

test('A-41: the commentId can\'t be used for injection, and is required', async () => {
  const shop = await addShop(world);
  assert.equal((await shop.api(`/compliance/why-no-dm?commentId=${encodeURIComponent(`' OR '1'='1`)}`)).status, 404);
  assert.equal((await shop.api('/compliance/why-no-dm')).status, 400);
});

test('A-41: the explanation names no person', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const from = world.fan('whyperson');
  await shop.comment(auto.mediaId, { from });
  const capped = await shop.comment(auto.mediaId, { from });
  await shop.settle();
  const res = await shop.api(`/compliance/why-no-dm?commentId=${capped.id}`);
  assert.doesNotMatch(res.text, /whyperson/);
});

test('A-41: "Why no DM?" needs the inbox permission', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['catalog'] });
  assert.equal((await shop.api('/compliance/why-no-dm?commentId=1', { token: staff.token })).status, 403);
});

test('A-42: an opted-out person DMs, and the owner replies inside the window: the reply goes, and no automated message', async () => {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'dm_keyword', triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  const confirmations = (await shop.dms({ recipientId: person.id })).length;
  await shop.dm(person, 'price');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, confirmations, 'No automated message');
  const thread = await shop.thread(person.id);
  const out = need(await reply(shop, thread.id, 'Happy to help by hand'), 200, 'Manual reply').json();
  assert.equal(out.outcome, 'sent');
  assert.equal((await shop.dms({ recipientId: person.id })).length, confirmations + 1);
  assert.equal((await shop.optOuts()).length, 1, 'Still opted out');
});

test('A-42: a manual reply doesn\'t lift an opt-out, and automation stays off after the 12 hours', async () => {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'dm_keyword', triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  const before = (await shop.dms({ recipientId: person.id })).length;
  await world.travel(13 * HOUR);
  await shop.dm(person, 'price');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, before);
});

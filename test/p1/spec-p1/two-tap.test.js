// PRD 6.13: the two-tap "Send me the link" flow. A-67 to A-73.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, HOUR, addShop, assertReason, buttonsOf, isButtonTemplate, linkOf, textOf, unique, useWorld } from './support.js';

const world = useWorld();

async function firstDm(extra = {}, shopOptions = {}) {
  const shop = await addShop(world, shopOptions);
  const auto = await shop.automate({ linkMode: 'two_tap', linkUrl: shop.siteUrl('/p/direct'), ...extra });
  const person = world.fan();
  const comment = await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  const [dm] = await shop.dms();
  assert.ok(dm, 'The first DM went');
  return { shop, auto, person, comment, dm, payload: buttonsOf(dm)[0]?.payload };
}

const taps = async (shop) => (await shop.call('/links/taps', 200)).items;
const linkMessages = async (shop, person) => (await shop.dms({ recipientId: person.id, kind: 'send_api' }));

test('A-67: a matching comment on a two-tap automation: one private reply with a "Send me the link" button and no URL', async () => {
  const { dm, comment } = await firstDm();
  assert.equal(dm.kind, 'private_reply');
  assert.equal(dm.commentId, comment.id);
  assert.equal(isButtonTemplate(dm), true);
  const buttons = buttonsOf(dm);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].type, 'postback');
  assert.equal(buttons[0].title, 'Send me the link');
  assert.doesNotMatch(JSON.stringify(dm.message), /https?:\/\//);
});

test('A-67: the message reads correctly without the button', async () => {
  const { dm } = await firstDm({ body: 'Thanks for asking! I can send the link here.' });
  assert.equal(textOf(dm), 'Thanks for asking! I can send the link here.');
});

test('A-67: the payload isn\'t a person\'s data or the link', async () => {
  const { payload, person, shop } = await firstDm();
  assert.equal(payload.includes(person.id), false);
  assert.equal(payload.includes(person.username), false);
  assert.equal(payload.includes(shop.siteHost), false);
});

test('A-68: tapping records it for that reel and person, and the second message has the direct link button', async () => {
  const { shop, auto, person, payload } = await firstDm();
  const before = Date.now();
  await shop.tap(person, payload);
  await shop.settle();
  const [summary] = await taps(shop);
  assert.deepEqual([summary.automationId, summary.mediaId, summary.people, summary.channel], [auto.id, auto.mediaId, 1, 'instagram']);
  const [link] = await linkMessages(shop, person);
  assert.ok(link, 'The second message went');
  assert.equal(isButtonTemplate(link), true);
  assert.equal(buttonsOf(link)[0].type, 'web_url');
  assert.equal(new URL(linkOf(link)).host, shop.siteHost);
  assert.equal(new URL(linkOf(link)).pathname, '/p/direct');
  assert.ok(link.at - before < 5000, 'Within seconds');
});

test('A-68: the second message is a normal reply inside the window, not a second private reply', async () => {
  const { shop, person, payload, comment } = await firstDm();
  await shop.tap(person, payload);
  await shop.settle();
  assert.equal((await shop.dms({ kind: 'private_reply', commentId: comment.id })).length, 1);
  assert.equal((await linkMessages(shop, person)).length, 1);
  assert.equal((await shop.reasons()).includes('cap.per_comment'), false);
});

test('A-68: the first DM and its second message count as one DM for the caps', async () => {
  const { shop, person, payload, auto } = await firstDm();
  await shop.tap(person, payload);
  await shop.settle();
  const claims = await shop.sql(`SELECT cap FROM cap_claims WHERE tenant_id = $1 AND cap = 'cap.per_person_24h'`, [shop.tenantId]);
  assert.equal(claims.length, 1, 'One rolling-cap claim for the pair');
  const again = await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  await assertReason(shop, 'cap.per_media', again.id);
});

test('A-68: a tap counts as a response and opens the window for what follows', async () => {
  const { shop, person, payload } = await firstDm();
  await shop.tap(person, payload);
  await shop.settle();
  const thread = await shop.thread(person.id);
  assert.ok(Date.now() - new Date(thread.last_user_message_at).getTime() < 60_000);
});

for (const [label, build] of [
  ['junk', () => `junk-${unique()}`],
  ['very long', () => 'x'.repeat(1000)],
  ['a SQL string', () => `' OR 1=1 --`],
  ['empty JSON', () => '{}'],
]) {
  test(`A-68: a postback whose payload is ${label} sends nothing and breaks nothing`, async () => {
    const { shop, person } = await firstDm();
    await shop.tap(person, build());
    await shop.settle();
    assert.deepEqual(await taps(shop), []);
    assert.equal((await linkMessages(shop, person)).length, 0);
  });
}

test('A-68: a payload from another business\'s automation does nothing here', async () => {
  const a = await firstDm();
  const b = await firstDm();
  await b.shop.tap(b.person, a.payload);
  await b.shop.settle();
  assert.deepEqual(await taps(b.shop), []);
  assert.equal((await linkMessages(b.shop, b.person)).length, 0);
  assert.deepEqual(await taps(a.shop), []);
});

test('A-68: someone else tapping a copy of the payload doesn\'t get counted as the person it was sent to', async () => {
  const { shop, person, payload } = await firstDm();
  const stranger = world.fan();
  await shop.tap(stranger, payload);
  await shop.settle();
  assert.equal((await linkMessages(shop, person)).length, 0);
});

test('A-69: tapping 3 times keeps the count of people at 1, and the link resends within the cap', async () => {
  const { shop, person, payload } = await firstDm();
  for (let i = 0; i < 3; i++) {
    await shop.tap(person, payload);
    await shop.settle();
  }
  const [summary] = await taps(shop);
  assert.equal(summary.people, 1);
  assert.equal(summary.taps, 3);
  const [row] = await shop.sql('SELECT tap_count FROM link_taps WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(row.tap_count, 3);
  assert.equal((await linkMessages(shop, person)).length, 3);
});

test('A-69: 12 taps stop resending at cap.dm_replies_24h', async () => {
  const { shop, person, payload } = await firstDm();
  for (let i = 0; i < 12; i++) {
    await shop.tap(person, payload);
    await shop.settle({ ms: 2000 });
  }
  assert.equal((await linkMessages(shop, person)).length, COMPLIANCE_LIMITS.capDmReplies24h);
  await assertReason(shop, 'cap.dm_replies_24h');
  assert.equal((await taps(shop))[0].people, 1);
});

test('A-69: 3 taps at the same moment still make 1 person', async () => {
  const { shop, person, payload } = await firstDm();
  await Promise.all([shop.tap(person, payload), shop.tap(person, payload), shop.tap(person, payload)]);
  await shop.settle();
  const [summary] = await taps(shop);
  assert.equal(summary.people, 1);
  assert.ok((await linkMessages(shop, person)).length <= 3);
});

test('A-69: one tap delivered twice is one tap', async () => {
  const { shop, person, payload } = await firstDm();
  await shop.tap(person, payload, { duplicates: 2 });
  await shop.settle();
  assert.equal((await taps(shop))[0].taps, 1);
  assert.equal((await linkMessages(shop, person)).length, 1);
});

test('A-70: a person tapping 30 hours after the first DM: tap recorded, and the link goes', async () => {
  const { shop, person, payload } = await firstDm();
  await world.travel(30 * HOUR);
  await shop.tap(person, payload);
  await shop.settle();
  assert.equal((await taps(shop))[0].people, 1);
  assert.equal((await linkMessages(shop, person)).length, 1);
});

test('A-70: the window runs from the tap: a second message held past 23h50m after the tap doesn\'t go', async () => {
  const { shop, person, payload } = await firstDm();
  await shop.call('/compliance/pause', 200, { method: 'POST', body: {} });
  await world.switchLag();
  await shop.tap(person, payload);
  await shop.settle();
  await world.travel(COMPLIANCE_LIMITS.messagingWindowMs + 1000);
  await shop.call('/compliance/resume', 200, { method: 'POST' });
  await world.switchLag();
  await shop.settle();
  assert.equal((await linkMessages(shop, person)).length, 0);
  await assertReason(shop, 'window.closed');
});

test('A-71: a person who opted out after the first DM and then taps gets no second message, optout', async () => {
  const { shop, person, payload } = await firstDm();
  await shop.dm(person, 'STOP');
  await shop.settle();
  const before = (await shop.dms({ recipientId: person.id })).length;
  await shop.tap(person, payload);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, before);
  await assertReason(shop, 'optout');
});

for (const [state, reason] of [['paused', 'paused.automation']]) {
  test(`A-71: a tap on a ${state} automation sends nothing, ${reason}`, async () => {
    const { shop, auto, person, payload } = await firstDm();
    await shop.call(`/automations/${auto.id}/state`, 200, { method: 'POST', body: { state } });
    await world.switchLag();
    await shop.tap(person, payload);
    await shop.settle();
    assert.equal((await linkMessages(shop, person)).length, 0);
    await assertReason(shop, reason);
  });
}

test('A-71: test mode applies to the second message as well', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.setState(auto.id, 'test');
  await world.switchLag();
  await shop.tap(person, payload);
  await shop.settle();
  assert.equal((await linkMessages(shop, person)).length, 0);
  await assertReason(shop, 'test_mode');
});

test('A-72: changing the button to "Get the link": new DMs show it, and earlier taps still count', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.tap(person, payload);
  await shop.settle();
  await shop.call(`/automations/${auto.id}`, 200, { method: 'PATCH', body: { tapButtonTitle: 'Get the link' } });
  const next = await shop.comment(auto.mediaId, { from: world.fan() });
  await shop.settle();
  const [dm] = await shop.dms({ commentId: next.id });
  assert.equal(buttonsOf(dm)[0].title, 'Get the link');
  assert.equal((await taps(shop))[0].people, 1);
});

test('A-72: a tap on an old button still works after the title changes', async () => {
  const { shop, auto, person, payload } = await firstDm();
  await shop.call(`/automations/${auto.id}`, 200, { method: 'PATCH', body: { tapButtonTitle: 'Get the link' } });
  await shop.tap(person, payload);
  await shop.settle();
  assert.equal((await taps(shop))[0].people, 1);
  assert.equal((await linkMessages(shop, person)).length, 1);
});

test('A-72: a title of 21 characters is refused, content.button_title', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ linkMode: 'two_tap' });
  const res = await shop.api(`/automations/${auto.id}`, { method: 'PATCH', body: { tapButtonTitle: 'x'.repeat(21) } });
  assert.equal(res.status, 400);
  assert.equal(res.json().reason, 'content.button_title');
});

test('A-73: the second message failing with a Meta error: tap still counted, send.error, a Needs a human item', async () => {
  const { shop, person, payload } = await firstDm();
  await shop.refuseSends({ code: 100, times: 2 });
  await shop.tap(person, payload);
  await shop.settle();
  assert.equal((await taps(shop))[0].people, 1);
  await assertReason(shop, 'send.error');
  const items = await shop.needsHuman();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'send_failed');
});

test('A-73: a timeout on the second message: tap counted, unknown outcome, never resent', async () => {
  const { shop, person, payload } = await firstDm();
  const before = (await shop.sendCalls()).length;
  await shop.fault({ kind: 'timeout', match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  await shop.tap(person, payload);
  await shop.settle({ ms: 5000 });
  assert.equal((await taps(shop))[0].people, 1);
  await assertReason(shop, 'send.unknown_outcome');
  assert.equal((await shop.sendCalls()).length, before + 1);
  assert.deepEqual((await shop.needsHuman()).map((i) => i.kind), ['unknown_outcome']);
});

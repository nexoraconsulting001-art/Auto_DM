// PRD 4.5: windows, follow-ups, no cold DMs. C-18 to C-21.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, HOUR, INSIDE_MS, MINUTE, OUTSIDE_MS, addShop, assertNoDm, assertReason, buttonsOf, mentionAutomation, need, routesInclude, unique, useWorld } from './support.js';

const world = useWorld();
const WINDOW = COMPLIANCE_LIMITS.messagingWindowMs;
const FOLLOWUP_MIN = COMPLIANCE_LIMITS.followupMinDelayMs;

test('the limits used below are the PRD\'s: 23h50m, and 30 minutes before a follow-up', () => {
  assert.equal(WINDOW, 23 * HOUR + 50 * MINUTE);
  assert.equal(FOLLOWUP_MIN, 30 * MINUTE);
});

/** A DM automation, and a person whose message is held by a tenant pause, so the answer is decided later. */
async function heldReply(ageBeforeResume) {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'dm_keyword', triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  need(await shop.api('/compliance/pause', { method: 'POST', body: {} }), 200, 'Pause');
  await world.switchLag();
  const person = world.fan();
  await shop.dm(person, 'price');
  await shop.settle();
  await world.travel(ageBeforeResume);
  need(await shop.api('/compliance/resume', { method: 'POST' }), 200, 'Resume');
  await world.switchLag();
  await shop.settle();
  return { shop, person };
}

test('C-18: a person who last messaged 25h ago is window.closed, with no API call', async () => {
  const { shop } = await heldReply(25 * HOUR);
  await assertNoDm(shop);
  await assertReason(shop, 'window.closed');
});

test('C-18: a second past 23h50m the window is closed', async () => {
  const { shop } = await heldReply(WINDOW + OUTSIDE_MS);
  await assertNoDm(shop);
  await assertReason(shop, 'window.closed');
});

test('C-18: just inside 23h50m the reply still goes', async () => {
  const { shop, person } = await heldReply(WINDOW - INSIDE_MS);
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('C-18: a newer message reopens the window, and it is that message that counts', async () => {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'dm_keyword', triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  const person = world.fan();
  await shop.dm(person, 'hello there');
  await shop.settle();
  await world.travel(25 * HOUR);
  await shop.dm(person, 'price');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
  assert.ok(Date.now() - new Date((await shop.thread(person.id)).last_user_message_at).getTime() < 60_000);
});

test('C-18: an automated job is never sent with a message tag', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.comment(reel.mediaId);
  const person = world.fan();
  await shop.automate({ triggerType: 'dm_keyword', triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  await shop.dm(person, 'price');
  await shop.settle();
  for (const call of await shop.sendCalls()) assert.equal(call.body?.tag ?? call.query?.tag, undefined);
  assert.ok((await shop.dms()).every((m) => !m.tag));
});

test('C-18: there is no broadcast or message-all feature to call', () => {
  const offenders = routesInclude(/broadcast|message.?all|blast|nudge/i);
  assert.deepEqual(offenders, []);
});

test('C-19: a mention from someone with no recent DM gets no DM, mention.no_window', async () => {
  const shop = await addShop(world);
  await mentionAutomation(shop);
  await shop.mention(world.fan());
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'mention.no_window');
});

test('C-19: a second past 23h50m since their last DM is still mention.no_window', async () => {
  const shop = await addShop(world);
  await mentionAutomation(shop);
  const person = world.fan();
  await shop.dm(person, 'just saying hello');
  await shop.settle();
  await world.travel(WINDOW + OUTSIDE_MS);
  await shop.mention(person);
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'mention.no_window');
});

test('C-19: the mention\'s media is kept as a reference, and never fetched or re-hosted', async () => {
  const shop = await addShop(world);
  await mentionAutomation(shop);
  const person = world.fan();
  const url = `https://media.invalid/mention-${unique()}.jpg`;
  await shop.mention(person, { url });
  await shop.settle();
  const thread = await shop.thread(person.id);
  const [message] = await shop.sql('SELECT * FROM inbox_messages WHERE tenant_id = $1 AND thread_id = $2', [shop.tenantId, thread.id]);
  assert.equal(message.kind, 'story_mention');
  assert.equal(message.media_ref, url);
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM media WHERE tenant_id = $1', [shop.tenantId]))[0].n, 0, 'Nothing was stored from it');
});

async function followupAutomation(extra = {}) {
  const shop = await addShop(world);
  const reel = await shop.automate({ followupEnabled: true, followupDelayMinutes: 30, followupText: 'Did you find what you wanted?', ...extra });
  const person = world.fan();
  const comment = await shop.comment(reel.mediaId, { from: person });
  await shop.settle();
  assert.equal((await shop.dms()).length, 1, 'The first DM');
  return { shop, reel, person, comment };
}

test('C-20: a follow-up where the person never replied is blocked, followup.no_response', async () => {
  const { shop } = await followupAutomation();
  await world.travel(31 * MINUTE);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  await assertReason(shop, 'followup.no_response');
});

test('C-20: no reply a day later is still no follow-up', async () => {
  const { shop } = await followupAutomation();
  await world.travel(23 * HOUR);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
});

test('C-20: a message from before our DM does not count as a reply', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate({ followupEnabled: true, followupDelayMinutes: 30, followupText: 'Still interested?' });
  const person = world.fan();
  await shop.dm(person, 'hello');
  await shop.settle();
  await shop.comment(reel.mediaId, { from: person });
  await shop.settle();
  await world.travel(31 * MINUTE);
  await shop.settle();
  assert.equal((await shop.dms()).filter((m) => /Still interested/.test(JSON.stringify(m.message))).length, 0);
});

const followupCount = async (shop) => (await shop.dms()).filter((m) => /find what you wanted/.test(JSON.stringify(m.message))).length;

test('C-21: a person replies after our DM: 1 follow-up, not before 30 minutes', async () => {
  const { shop, person } = await followupAutomation();
  await shop.dm(person, 'Looks nice');
  await shop.settle();
  await world.travel(FOLLOWUP_MIN - INSIDE_MS);
  await shop.settle();
  assert.equal(await followupCount(shop), 0, 'Just inside 30 minutes');
  await world.travel(INSIDE_MS + OUTSIDE_MS);
  await shop.settle();
  assert.equal(await followupCount(shop), 1);
});

test('C-21: replying three times still gets one follow-up, cap.followup', async () => {
  const { shop, person } = await followupAutomation();
  for (const text of ['one', 'two', 'three']) {
    await shop.dm(person, text);
    await shop.settle();
  }
  await world.travel(FOLLOWUP_MIN + OUTSIDE_MS);
  await shop.settle();
  assert.equal(await followupCount(shop), 1);
  await shop.dm(person, 'four');
  await shop.settle();
  await world.travel(FOLLOWUP_MIN + OUTSIDE_MS);
  await shop.settle();
  assert.equal(await followupCount(shop), 1);
});

test('C-21: two replies at the same moment make one follow-up', async () => {
  const { shop, person } = await followupAutomation();
  await Promise.all([shop.dm(person, 'a'), shop.dm(person, 'b')]);
  await shop.settle();
  await world.travel(FOLLOWUP_MIN + OUTSIDE_MS);
  await shop.settle();
  assert.equal(await followupCount(shop), 1);
});

test('C-21: a follow-up delayed to 23h50m, the edge of the window, doesn\'t go', async () => {
  const { shop, person } = await followupAutomation({ followupDelayMinutes: 1430 });
  await shop.dm(person, 'Looks nice');
  await shop.settle();
  await world.travel(WINDOW + OUTSIDE_MS);
  await shop.settle();
  assert.equal(await followupCount(shop), 0);
  await assertReason(shop, 'window.closed');
});

test('C-21: a delay under 30 minutes can\'t be saved', async () => {
  const shop = await addShop(world);
  const res = await shop.tryAutomation({ mediaId: await shop.reel(), followupEnabled: true, followupDelayMinutes: 29, followupText: 'Hi' });
  assert.equal(res.status, 400);
});

for (const [label, act] of [
  ['opting out', (shop, person) => shop.dm(person, 'STOP')],
  ['asking for a human', (shop, person) => shop.dm(person, 'human')],
]) {
  test(`C-21: ${label} cancels a scheduled follow-up`, async () => {
    const { shop, person } = await followupAutomation();
    await shop.dm(person, 'Looks nice');
    await shop.settle();
    await act(shop, person);
    await shop.settle();
    await world.travel(FOLLOWUP_MIN + OUTSIDE_MS);
    await shop.settle();
    assert.equal(await followupCount(shop), 0);
  });
}

test('C-21: tapping the two-tap button cancels a scheduled follow-up', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate({ linkMode: 'two_tap', followupEnabled: true, followupDelayMinutes: 30, followupText: 'Did you find what you wanted?' });
  const person = world.fan();
  await shop.comment(reel.mediaId, { from: person });
  await shop.settle();
  const [first] = await shop.dms();
  await shop.tap(person, buttonsOf(first)[0].payload);
  await shop.settle();
  await world.travel(FOLLOWUP_MIN + OUTSIDE_MS);
  await shop.settle();
  assert.equal(await followupCount(shop), 0);
});

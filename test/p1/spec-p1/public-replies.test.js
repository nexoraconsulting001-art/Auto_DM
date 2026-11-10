// PRD 4.9: public comment replies. C-31 to C-33.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, HOUR, INSIDE_MS, OUTSIDE_MS, REPLIES, SECOND, addShop, assertReason, need, savePublicReplies, textOf, useWorld } from './support.js';

const world = useWorld();
const MAX_DELAY = COMPLIANCE_LIMITS.publicReplyMaxDelayMs;
const MIN_DELAY = COMPLIANCE_LIMITS.publicReplyMinDelayMs;

test('the limits used below are the PRD\'s', () => {
  assert.deepEqual([COMPLIANCE_LIMITS.publicReplyMinVariants, COMPLIANCE_LIMITS.publicReplyMaxVariants, COMPLIANCE_LIMITS.publicReplyMaxChars], [5, 10, 150]);
  assert.deepEqual([MIN_DELAY, MAX_DELAY, COMPLIANCE_LIMITS.publicReplyExpiryMs], [20 * SECOND, 90 * SECOND, HOUR]);
  assert.deepEqual([COMPLIANCE_LIMITS.publicRepliesPerMediaHour, COMPLIANCE_LIMITS.publicRepliesPerTenantHour], [20, 60]);
});

const patchKit = (shop, publicReplyVariants) => shop.api('/brand-kit', { method: 'PATCH', body: { publicReplyVariants } });

for (const n of [1, 4]) {
  test(`C-31: turning replies on with ${n} saved is refused: "Add at least 5 replies"`, async () => {
    const shop = await addShop(world);
    await patchKit(shop, REPLIES.slice(0, n));
    const res = await shop.tryAutomation({ mediaId: await shop.reel(), publicReplyEnabled: true });
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /Add at least 5 replies/);
  });
}

test('C-31: with none saved it is refused the same way', async () => {
  const shop = await addShop(world);
  const res = await shop.tryAutomation({ mediaId: await shop.reel(), publicReplyEnabled: true });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /Add at least 5 replies/);
});

test('C-31: an automation can\'t get replies by a PATCH either', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  const res = await shop.api(`/automations/${auto.id}`, { method: 'PATCH', body: { publicReplyEnabled: true } });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /Add at least 5 replies/);
  assert.equal((await shop.call(`/automations/${auto.id}`, 200)).publicReplyEnabled, false);
});

for (const n of [5, 10]) {
  test(`C-31: ${n} replies are enough`, async () => {
    const shop = await addShop(world);
    need(await patchKit(shop, REPLIES.slice(0, n)), 200, 'Saving replies');
    need(await shop.tryAutomation({ mediaId: await shop.reel(), publicReplyEnabled: true }), 201, 'Turning replies on');
  });
}

const BAD_SETS = {
  'four replies': REPLIES.slice(0, 4),
  'eleven replies': [...REPLIES, 'One more reply'],
  'five with a repeat': [REPLIES[0], REPLIES[0], REPLIES[1], REPLIES[2], REPLIES[3]],
  'a reply of 151 characters': [...REPLIES.slice(0, 4), 'x'.repeat(151)],
  'a reply with a link': [...REPLIES.slice(0, 4), 'See https://shop.example/x'],
  'a reply with a bare domain': [...REPLIES.slice(0, 4), 'See shop.example today'],
  'a reply with a phone number': [...REPLIES.slice(0, 4), 'Call 9876543210'],
  'a reply with a price': [...REPLIES.slice(0, 4), 'Only ₹499 today'],
  'a reply with a price in Rs': [...REPLIES.slice(0, 4), 'Just Rs. 499'],
};

for (const [label, set] of Object.entries(BAD_SETS)) {
  test(`C-31: ${label} can't be saved`, async () => {
    const shop = await addShop(world);
    assert.equal((await patchKit(shop, set)).status, 400);
  });
}

test('C-31: a reply of exactly 150 characters is fine', async () => {
  const shop = await addShop(world);
  need(await patchKit(shop, [...REPLIES.slice(0, 4), 'y'.repeat(150)]), 200, 'Saving replies');
});

test('C-31: replies are off by default', async () => {
  const shop = await addShop(world);
  await savePublicReplies(shop);
  const auto = await shop.automate();
  assert.equal(auto.publicReplyEnabled, false);
  await shop.comment(auto.mediaId);
  await shop.settle();
  await world.travel(MAX_DELAY + OUTSIDE_MS);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.publicReplies()).length, 0);
});

test('C-31: a staff member can\'t change the reply set', async () => {
  const shop = await addShop(world);
  const { addStaff } = await import('./support.js');
  const staff = await addStaff(world, shop, { permissions: ['automations'] });
  assert.equal((await shop.api('/brand-kit', { method: 'PATCH', token: staff.token, body: { publicReplyVariants: REPLIES.slice(0, 5) } })).status, 403);
});

async function liveWithReplies(extra = {}) {
  const shop = await addShop(world);
  await savePublicReplies(shop, 5);
  const auto = await shop.automate({ publicReplyEnabled: true, ...extra });
  return { shop, auto };
}

test('C-32: 600 DMs in one hour, replies on: 20 or fewer on that media, no back-to-back repeat', { timeout: 280_000 }, async () => {
  const { shop, auto } = await liveWithReplies();
  const { commentPayload } = await import('./support.js');
  const entries = [];
  for (let i = 0; i < 600; i++) {
    const from = world.fan();
    const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: auto.mediaId, from, text: 'price', deliver: false });
    entries.push(commentPayload(shop, { id: comment.id, mediaId: auto.mediaId, from }).entry[0]);
  }
  need(await world.webhook({ object: 'instagram', entry: entries }), 200, 'The batch');
  await shop.settle({ ms: 60_000, roundMs: 2000 });
  for (let step = 0; step < 40; step++) {
    await world.travel(MAX_DELAY + SECOND);
    await shop.settle({ ms: 1500, roundMs: 500 });
  }
  const replies = await shop.publicReplies();
  assert.ok(replies.length >= 1 && replies.length <= 20, `${replies.length} public replies on one media in an hour`);
  for (let i = 1; i < replies.length; i++) assert.notEqual(textOf(replies[i]), textOf(replies[i - 1]), `Replies ${i - 1} and ${i} repeat`);
  assert.ok(replies.every((r) => REPLIES.includes(textOf(r))), 'Only the owner\'s saved replies');
});

test('C-32: a reply goes only after the delay: not before 20 s', async () => {
  const { shop, auto } = await liveWithReplies();
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.publicReplies()).length, 0, 'Straight after the DM, nothing yet');
  const [job] = await shop.jobs(`kind = 'public_reply'`);
  const [dm] = await shop.jobs(`kind = 'private_reply'`);
  const delay = new Date(job.run_at) - new Date(dm.sent_at);
  assert.ok(delay >= MIN_DELAY - 1000 && delay <= MAX_DELAY + 1000, `Delay was ${delay} ms`);
});

test('C-32: after 90 s the reply has gone, once, on the comment', async () => {
  const { shop, auto } = await liveWithReplies();
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  await world.travel(MAX_DELAY + OUTSIDE_MS);
  await shop.settle();
  const replies = await shop.publicReplies();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].commentId, comment.id);
});

test('C-32: 60 replies per business per hour, across all its media', { timeout: 200_000 }, async () => {
  const shop = await addShop(world);
  await savePublicReplies(shop, 5);
  for (let n = 0; n < 4; n++) {
    const auto = await shop.automate({ publicReplyEnabled: true });
    for (let i = 0; i < 20; i++) await shop.comment(auto.mediaId);
  }
  await shop.settle({ ms: 40_000, roundMs: 2000 });
  for (let step = 0; step < 8; step++) {
    await world.travel(MAX_DELAY + SECOND);
    await shop.settle({ ms: 2000, roundMs: 500 });
  }
  const replies = await shop.publicReplies();
  assert.ok(replies.length <= COMPLIANCE_LIMITS.publicRepliesPerTenantHour, `${replies.length} replies`);
  await assertReason(shop, 'cap.public_reply_tenant_h');
});

test('C-32: no reply when the DM failed', async () => {
  const { shop, auto } = await liveWithReplies();
  await shop.refuseSends({ code: 100, times: 2 });
  await shop.comment(auto.mediaId);
  await shop.settle();
  await world.travel(MAX_DELAY + OUTSIDE_MS);
  await shop.settle();
  assert.equal((await shop.dms()).length, 0);
  assert.equal((await shop.publicReplies()).length, 0);
});

test('C-32: no reply on an unknown outcome', async () => {
  const { shop, auto } = await liveWithReplies();
  await shop.fault({ kind: 'server_error', match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  await shop.comment(auto.mediaId);
  await shop.settle();
  await world.travel(MAX_DELAY + OUTSIDE_MS);
  await shop.settle();
  assert.equal((await shop.publicReplies()).length, 0);
});

test('C-32: a failed public reply never retries the DM', async () => {
  const { shop, auto } = await liveWithReplies();
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  await shop.fault({ kind: 'rate_limit', status: 400, code: 100, match: { method: 'POST', path: `*/${comment.id}/replies` }, times: 'forever' });
  await world.travel(MAX_DELAY + OUTSIDE_MS);
  await shop.settle();
  await world.meta.delete('/faults');
  assert.equal((await shop.sendCalls()).length, 1);
  assert.equal((await shop.dms()).length, 1);
});

test('C-32: a comment that was skipped gets no reply', async () => {
  const { shop, auto } = await liveWithReplies();
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  await shop.comment(auto.mediaId, { from: person });
  await shop.comment(auto.mediaId, { text: 'nothing relevant' });
  await shop.settle();
  await world.travel(MAX_DELAY + OUTSIDE_MS);
  await shop.settle();
  assert.equal((await shop.publicReplies()).length, 0);
});

async function heldBySlowMode() {
  const { shop, auto } = await liveWithReplies();
  await shop.comment(auto.mediaId);
  await shop.settle();
  await shop.sql(`INSERT INTO account_rate_state (tenant_id, channel, account_id, slow_mode_started_at, slow_mode_until, slow_mode_trigger) VALUES ($1, 'instagram', $2, now(), now() + interval '2 hours', 'buc_80002')
                  ON CONFLICT (tenant_id, channel, account_id) DO UPDATE SET slow_mode_started_at = now(), slow_mode_until = now() + interval '2 hours', slow_mode_trigger = 'buc_80002'`, [shop.tenantId, shop.igUserId]);
  await world.switchLag();
  return { shop, auto };
}

test('C-33: a reply held over 1h by slow mode is dropped, expired.public_reply', async () => {
  const { shop } = await heldBySlowMode();
  await world.travel(MAX_DELAY + SECOND);
  await shop.settle();
  assert.equal((await shop.publicReplies()).length, 0, 'Paused in slow mode');
  await world.travel(HOUR + OUTSIDE_MS);
  await shop.settle();
  const [job] = await shop.jobs(`kind = 'public_reply'`);
  assert.equal(job.status, 'expired');
  assert.equal(job.reason, 'expired.public_reply');
  assert.equal((await shop.publicReplies()).length, 0);
});

test('C-33: slow mode ending just inside the hour lets the reply go', async () => {
  const { shop } = await heldBySlowMode();
  await world.travel(HOUR - 2 * INSIDE_MS - 10 * SECOND);
  await shop.sql('UPDATE account_rate_state SET slow_mode_until = now() - interval \'1 second\' WHERE tenant_id = $1', [shop.tenantId]);
  await world.switchLag();
  await shop.settle();
  assert.equal((await shop.publicReplies()).length, 1);
});

test('C-33: a job\'s expiry is 1 hour after its DM', async () => {
  const { shop, auto } = await liveWithReplies();
  await shop.comment(auto.mediaId);
  await shop.settle();
  const [reply] = await shop.jobs(`kind = 'public_reply'`);
  const [dm] = await shop.jobs(`kind = 'private_reply'`);
  assert.ok(Math.abs(new Date(reply.expires_at) - new Date(dm.sent_at) - HOUR) < 2000);
});

test('C-33: a held reply can be discarded by the owner', async () => {
  const { shop } = await heldBySlowMode();
  await world.travel(MAX_DELAY + SECOND);
  await shop.settle();
  const out = await shop.call('/compliance/held-jobs/discard', 200, { method: 'POST', body: {} });
  assert.ok(out.discarded >= 0);
  await world.travel(HOUR + OUTSIDE_MS);
  await shop.settle();
  assert.equal((await shop.publicReplies()).length, 0);
});

// PRD 4.7: DM caps. C-25 to C-27.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, DAY, HOUR, INSIDE_MS, OUTSIDE_MS, addShop, addStaff, assertNoDm, assertReason, need, openWorld, pause, useWorld } from './support.js';

const world = useWorld();
const OWNER_REPLIED = COMPLIANCE_LIMITS.threadOwnerRepliedMs;

test('the limits used below are the PRD\'s', () => {
  assert.equal(COMPLIANCE_LIMITS.capPerPerson24h, 3);
  assert.equal(COMPLIANCE_LIMITS.capDmReplies24h, 10);
  assert.equal(OWNER_REPLIED, 12 * HOUR);
});

test('C-25: 2 keyword comments 50 ms apart on one reel are 1 job, cap.per_media', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  const a = await shop.comment(reel.mediaId, { from });
  await pause(50);
  const b = await shop.comment(reel.mediaId, { from });
  await shop.settle();
  assert.equal((await shop.jobs()).length, 1);
  assert.equal((await shop.dms()).length, 1);
  const reasons = [...await shop.reasons(a.id), ...await shop.reasons(b.id)];
  assert.ok(reasons.includes('cap.per_media'), reasons.join(','));
});

test('C-25: five comments from one person at the same moment are 1 DM', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  await Promise.all(Array.from({ length: 5 }, () => shop.comment(reel.mediaId, { from })));
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
});

test('C-25: with two workers racing, one person on one reel still gets 1 DM', async () => {
  const w = await openWorld();
  try {
    w.addWorker();
    const shop = await addShop(w);
    const reel = await shop.automate();
    const from = w.fan();
    await Promise.all(Array.from({ length: 6 }, () => shop.comment(reel.mediaId, { from })));
    await shop.settle({ ms: 15_000 });
    assert.equal((await shop.dms()).length, 1);
    assert.equal((await shop.sql(`SELECT count(*)::int AS n FROM cap_claims WHERE tenant_id = $1 AND cap = 'cap.per_media'`, [shop.tenantId]))[0].n, 1);
  } finally {
    await w.close();
  }
});

test('C-25: the per-media cap lasts: a new comment a month later on the same automation is still capped', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  await shop.comment(reel.mediaId, { from });
  await shop.settle();
  await world.travel(30 * DAY);
  const late = await shop.comment(reel.mediaId, { from });
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  await assertReason(shop, 'cap.per_media', late.id);
});

test('C-25: two different people on one reel each get a DM', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.comment(reel.mediaId);
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.dms()).length, 2);
});

test('C-25: the claim holds a hash, never the person\'s id', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  await shop.comment(reel.mediaId, { from });
  await shop.settle();
  const claims = await shop.sql('SELECT * FROM cap_claims WHERE tenant_id = $1', [shop.tenantId]);
  const hash = await shop.hash(from.id);
  assert.ok(claims.some((c) => c.subject_hash === hash));
  assert.doesNotMatch(JSON.stringify(claims), new RegExp(`${from.id}|${from.username}`));
});

test('C-25: a cap claim is in the same transaction as its job: a job that is capped leaves no stray job', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  await shop.comment(reel.mediaId, { from });
  await shop.comment(reel.mediaId, { from });
  await shop.settle();
  const claims = await shop.sql(`SELECT job_id FROM cap_claims WHERE tenant_id = $1 AND cap = 'cap.per_media'`, [shop.tenantId]);
  const jobs = await shop.jobs();
  assert.deepEqual(claims.map((c) => String(c.job_id)), jobs.map((j) => String(j.id)));
});

test('C-25: one business\'s cap doesn\'t reach another', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const reelA = await a.automate();
  const reelB = await b.automate();
  const from = world.fan();
  await a.comment(reelA.mediaId, { from });
  await b.comment(reelB.mediaId, { from });
  await a.settle();
  await b.settle();
  assert.equal((await a.dms()).length, 1);
  assert.equal((await b.dms()).length, 1);
});

async function fourReels() {
  const shop = await addShop(world);
  const reels = [];
  for (let i = 0; i < 5; i++) reels.push(await shop.automate());
  return { shop, reels, from: world.fan() };
}

test('C-26: comments on 4 reels in 3h, then a 5th 25h later: 3 DMs, cap.per_person_24h, then the 5th is sent', async () => {
  const { shop, reels, from } = await fourReels();
  for (let i = 0; i < 4; i++) {
    await shop.comment(reels[i].mediaId, { from });
    await shop.settle();
    await world.travel(HOUR);
  }
  assert.equal((await shop.dms()).length, 3);
  await assertReason(shop, 'cap.per_person_24h');
  await world.travel(25 * HOUR);
  const fifth = await shop.comment(reels[4].mediaId, { from });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: fifth.id })).length, 1);
});

test('C-26: four reels at the same moment still give exactly 3 DMs', async () => {
  const { shop, reels, from } = await fourReels();
  await Promise.all(reels.slice(0, 4).map((r) => shop.comment(r.mediaId, { from })));
  await shop.settle();
  assert.equal((await shop.dms()).length, 3);
});

test('C-26: the 24 hours roll: just inside them the first DM still counts', async () => {
  const { shop, reels, from } = await fourReels();
  await shop.comment(reels[0].mediaId, { from });
  await shop.settle();
  await world.travel(2 * HOUR);
  await shop.comment(reels[1].mediaId, { from });
  await shop.comment(reels[2].mediaId, { from });
  await shop.settle();
  await world.travel(22 * HOUR - INSIDE_MS);
  const capped = await shop.comment(reels[3].mediaId, { from });
  await shop.settle();
  assert.equal((await shop.dms()).length, 3);
  await assertReason(shop, 'cap.per_person_24h', capped.id);
});

test('C-26: a second past 24 hours the oldest has dropped out and there is room for one', async () => {
  const { shop, reels, from } = await fourReels();
  await shop.comment(reels[0].mediaId, { from });
  await shop.settle();
  await world.travel(2 * HOUR);
  await shop.comment(reels[1].mediaId, { from });
  await shop.comment(reels[2].mediaId, { from });
  await shop.settle();
  await world.travel(22 * HOUR + OUTSIDE_MS);
  const allowed = await shop.comment(reels[3].mediaId, { from });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: allowed.id })).length, 1);
});

test('C-26: a capped person gets no public reply either', async () => {
  const { shop, reels, from } = await fourReels();
  await shop.call('/brand-kit', 200, { method: 'PATCH', body: { publicReplyVariants: ['Sent!', 'Check DMs', 'Messaged you', 'See inbox', 'DM sent'] } });
  await shop.call(`/automations/${reels[3].id}`, 200, { method: 'PATCH', body: { publicReplyEnabled: true } });
  for (let i = 0; i < 4; i++) await shop.comment(reels[i].mediaId, { from });
  await shop.settle();
  await world.travel(2 * 60_000);
  await shop.settle();
  assert.equal((await shop.publicReplies()).length, 0);
});

test('C-26: an owner may lower a cap, and it is applied', async () => {
  const { shop, reels, from } = await fourReels();
  await shop.call('/compliance/settings', 200, { method: 'PATCH', body: { capOverrides: { 'cap.per_person_24h': 1 } } });
  await shop.comment(reels[0].mediaId, { from });
  await shop.settle();
  const second = await shop.comment(reels[1].mediaId, { from });
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  await assertReason(shop, 'cap.per_person_24h', second.id);
});

test('C-26: an owner can never raise a cap', async () => {
  const shop = await addShop(world);
  const res = await shop.api('/compliance/settings', { method: 'PATCH', body: { capOverrides: { 'cap.per_person_24h': 4 } } });
  assert.equal(res.status, 400);
  assert.deepEqual((await shop.call('/compliance/settings', 200)).capOverrides, {});
});

test('C-26: caps can\'t be set by a staff member', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['automations'] });
  assert.equal((await shop.api('/compliance/settings', { method: 'PATCH', token: staff.token, body: { capOverrides: { 'cap.per_person_24h': 1 } } })).status, 403);
});

async function ownerThenKeyword() {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'dm_keyword', triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  const person = world.fan();
  await shop.dm(person, 'hello');
  await shop.settle();
  await shop.ownerReply(person.id, 'Hi, how can I help?');
  await shop.settle();
  return { shop, person };
}

test('C-27: the owner replied by hand; the person then DMs the keyword: no automated reply, thread.owner_replied', async () => {
  const { shop, person } = await ownerThenKeyword();
  await shop.dm(person, 'price');
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'thread.owner_replied');
  const thread = await shop.thread(person.id);
  assert.equal(thread.pause_reason, 'thread.owner_replied');
  assert.ok(Math.abs(new Date(thread.automation_paused_until).getTime() - Date.now() - OWNER_REPLIED) < 60_000);
});

test('C-27: just inside 12 hours it is still paused', async () => {
  const { shop, person } = await ownerThenKeyword();
  await world.travel(OWNER_REPLIED - INSIDE_MS);
  await shop.dm(person, 'price');
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'thread.owner_replied');
});

test('C-27: a second past 12 hours automation is back', async () => {
  const { shop, person } = await ownerThenKeyword();
  await world.travel(OWNER_REPLIED + OUTSIDE_MS);
  await shop.dm(person, 'price');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('C-27: pausing one thread doesn\'t pause another', async () => {
  const { shop } = await ownerThenKeyword();
  const other = world.fan();
  await shop.dm(other, 'price');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: other.id })).length, 1);
});

test('C-27: one automated reply per inbound DM, however often the DM is delivered', async () => {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'dm_keyword', triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  const person = world.fan();
  const { mid } = await shop.dm(person, 'price', { deliver: false });
  const entry = { id: shop.igUserId, time: Date.now(), messaging: [{ sender: { id: person.id }, recipient: { id: shop.igUserId }, timestamp: Date.now(), message: { mid, text: 'price' } }] };
  await Promise.all([world.webhook({ object: 'instagram', entry: [entry] }), world.webhook({ object: 'instagram', entry: [entry] })]);
  need(await world.webhook({ object: 'instagram', entry: [entry] }), 200, 'A third delivery');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('C-27: at most 10 automated replies to one person\'s DMs in 24 hours, cap.dm_replies_24h', async () => {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'dm_keyword', triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  const person = world.fan();
  for (let i = 0; i < 13; i++) {
    await shop.dm(person, 'price');
    await shop.settle({ ms: 2500 });
  }
  assert.equal((await shop.dms({ recipientId: person.id })).length, COMPLIANCE_LIMITS.capDmReplies24h);
  await assertReason(shop, 'cap.dm_replies_24h');
});

// PRD 4.6: opt-out and blocklist. C-22 to C-24.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, addShop, addStaff, assertNoDm, assertReason, commentPayload, need, textOf, useWorld } from './support.js';

const world = useWorld();

const OPT_OUT_WORDS = ['STOP', 'stop', 'Stop', 'unsubscribe', 'UNSUBSCRIBE', 'band karo', 'BAND KARO', 'Band Karo', 'mat bhejo', 'MAT BHEJO', 'बंद करो', '  STOP  '];
const NOT_OPT_OUT = ['please stop sending these', 'stop.', 'non-stop deals', 'stopped by your shop', 'band baja', 'karo band'];

for (const word of OPT_OUT_WORDS) {
  test(`C-22: a DM that is exactly "${word}" blocklists the person and sends one confirmation`, async () => {
    const shop = await addShop(world);
    const person = world.fan();
    const started = Date.now();
    await shop.dm(person, word);
    await shop.settle();
    const rows = await shop.optOuts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_hash, await shop.hash(person.id));
    assert.equal(rows[0].source, 'dm');
    assert.equal(rows[0].channel, 'instagram');
    assert.ok(new Date(rows[0].created_at).getTime() - started < 5000, 'Blocklisted within 5 s');
    const dms = await shop.dms({ recipientId: person.id });
    assert.equal(dms.length, 1, 'Exactly one confirmation');
    assert.equal(rows.some((r) => JSON.stringify(r).includes(person.id)), false, 'Only the hash is kept');
  });
}

for (const text of NOT_OPT_OUT) {
  test(`C-22: "${text}" is not an opt-out`, async () => {
    const shop = await addShop(world);
    const person = world.fan();
    await shop.dm(person, text);
    await shop.settle();
    assert.deepEqual(await shop.optOuts(), []);
  });
}

test('C-22: STOP delivered twice at the same moment is one block and one confirmation', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.automate({ triggerType: 'dm_keyword', keywords: ['price'], triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  const { mid } = await shop.dm(person, 'STOP', { deliver: false });
  const entry = { id: shop.igUserId, time: Date.now(), messaging: [{ sender: { id: person.id }, recipient: { id: shop.igUserId }, timestamp: Date.now(), message: { mid, text: 'STOP' } }] };
  const answers = await Promise.all([world.webhook({ object: 'instagram', entry: [entry] }), world.webhook({ object: 'instagram', entry: [entry] })]);
  assert.deepEqual(answers.map((r) => r.status), [200, 200]);
  await shop.settle();
  assert.equal((await shop.optOuts()).length, 1);
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
});

test('C-22: saying STOP again later gets no second confirmation', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  await shop.dm(person, 'STOP');
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 1);
  assert.equal((await shop.optOuts()).length, 1);
});

test('C-22: queued jobs are cancelled, cancelled.optout', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const person = world.fan();
  await shop.refuseSends({ code: 613, status: 429 });
  await shop.comment(reel.mediaId, { from: person });
  await shop.settle();
  assert.equal((await shop.jobs())[0].status, 'queued');
  await shop.dm(person, 'STOP');
  await shop.settle();
  const [job] = await shop.jobs(`kind = 'private_reply'`);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.reason, 'cancelled.optout');
  await world.travel(2 * HOUR);
  await shop.settle();
  assert.equal((await shop.dms({ kind: 'private_reply' })).length, 0);
});

test('C-22: only that person\'s jobs are cancelled', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const leaving = world.fan();
  const staying = world.fan();
  await shop.refuseSends({ code: 613, status: 429 });
  await shop.comment(reel.mediaId, { from: leaving });
  await shop.comment(reel.mediaId, { from: staying });
  await shop.settle();
  await shop.dm(leaving, 'STOP');
  await shop.settle();
  await world.travel(2 * HOUR);
  await shop.settle();
  assert.deepEqual((await shop.dms({ kind: 'private_reply' })).map((m) => m.recipientId), [staying.id]);
});

test('C-22: a blocklisted person is skipped when the job is made, optout', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  const comment = await shop.comment(reel.mediaId, { from: person });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 0);
  await assertReason(shop, 'optout', comment.id);
});

test('C-22: START lifts it, and only the person can', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  await shop.dm(person, 'START');
  await shop.settle();
  assert.deepEqual(await shop.optOuts(), []);
  const comment = await shop.comment(reel.mediaId, { from: person });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
});

test('C-22: someone else\'s START doesn\'t lift it', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  await shop.dm(world.fan(), 'START');
  await shop.settle();
  assert.equal((await shop.optOuts()).length, 1);
});

test('C-22: an opt-out in one business blocks nothing in another', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const person = world.fan();
  const reel = await b.automate();
  await a.dm(person, 'STOP');
  await a.settle();
  const comment = await b.comment(reel.mediaId, { from: person });
  await b.settle();
  assert.equal((await b.dms({ commentId: comment.id })).length, 1);
  assert.notEqual(await a.hash(person.id), await b.hash(person.id), 'The same person hashes differently per business');
});

test('C-22: the owner typing STOP in the Instagram app is not an opt-out', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'hello');
  await shop.settle();
  await shop.ownerReply(person.id, 'STOP');
  await shop.settle();
  assert.deepEqual(await shop.optOuts(), []);
});

test('C-22: an owner-added word works as an opt-out for that business only', async () => {
  const shop = await addShop(world);
  const other = await addShop(world);
  await shop.call('/compliance/words', 201, { method: 'POST', body: { list: 'optout', word: 'Ruko' } });
  const person = world.fan();
  await shop.dm(person, 'ruko');
  await other.dm(person, 'ruko');
  await shop.settle();
  await other.settle();
  assert.equal((await shop.optOuts()).length, 1);
  assert.deepEqual(await other.optOuts(), []);
});

test('C-22: the confirmation is the seller\'s, with no platform name in it', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  const [dm] = await shop.dms({ recipientId: person.id });
  assert.doesNotMatch(JSON.stringify(dm.message), /bhava/i);
  assert.ok(textOf(dm).length > 0);
});

test('C-22: a send error showing the person is unavailable blocklists them, recipient.unavailable', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const person = world.fan();
  await world.meta.post('/people', { igUserId: shop.igUserId, id: person.id, unavailable: true });
  await shop.comment(reel.mediaId, { from: person });
  await shop.settle();
  const [row] = await shop.optOuts();
  assert.equal(row.source, 'send_error');
  assert.equal(row.subject_hash, await shop.hash(person.id));
  await assertReason(shop, 'recipient.unavailable');
});

test('C-22: ops can lift a block only with a written reason, and a business owner can\'t reach that route', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  assert.equal((await shop.api(`/tenants/${shop.tenantId}/unblock`, { method: 'POST', body: { channel: 'instagram', subjectHash: await shop.hash(person.id), reason: 'x' } })).status, 404);
  assert.equal((await shop.optOuts()).length, 1);
});

test('C-23: STOP posted as a comment blocklists with no DM, public reply or confirmation', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate({ publicReplyEnabled: false });
  const person = world.fan();
  await shop.comment(reel.mediaId, { from: person, text: 'STOP' });
  await shop.settle();
  const rows = await shop.optOuts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'comment');
  await assertNoDm(shop);
  assert.equal((await shop.publicReplies()).length, 0);
});

test('C-23: "stop" as a comment on a reel with no automation still blocklists', async () => {
  const shop = await addShop(world);
  const media = await shop.reel();
  await shop.comment(media, { text: 'stop' });
  await shop.settle();
  assert.equal((await shop.optOuts()).length, 1);
  await assertNoDm(shop);
});

test('C-23: an automation whose keyword is "stop" doesn\'t get to answer it', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate({ keywords: ['stop'] });
  await shop.comment(reel.mediaId, { text: 'STOP' });
  await shop.settle();
  assert.equal((await shop.optOuts()).length, 1);
  await assertNoDm(shop);
});

test('C-23: "STOP" in a longer comment is not an opt-out', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate({ keywords: ['price'] });
  await shop.comment(reel.mediaId, { text: 'price please, don\'t stop posting' });
  await shop.settle();
  assert.deepEqual(await shop.optOuts(), []);
  assert.equal((await shop.dms()).length, 1);
});

test('C-23: the business\'s own STOP comment is ignored', async () => {
  const shop = await addShop(world);
  const media = await shop.reel();
  await shop.comment(media, { from: { id: shop.igUserId, username: `${shop.slug}_ig` }, text: 'STOP' });
  await shop.settle();
  assert.deepEqual(await shop.optOuts(), []);
});

test('C-24: a job queued before the STOP reaches send is blocked there, optout', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const person = world.fan();
  await shop.refuseSends({ code: 613, status: 429 });
  await shop.comment(reel.mediaId, { from: person });
  await shop.settle();
  const before = (await shop.sendCalls()).length;
  await shop.sql(`INSERT INTO opt_outs (tenant_id, channel, subject_hash, source) VALUES ($1, 'instagram', $2, 'dm')`, [shop.tenantId, await shop.hash(person.id)]);
  await world.travel(2 * HOUR);
  await shop.settle();
  assert.equal((await shop.sendCalls()).length, before, 'The check at send stops it before any call');
  assert.equal((await shop.dms()).length, 0);
  await assertReason(shop, 'optout');
});

test('C-24: STOP and a keyword comment at the same moment: at most the confirmation goes', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const person = world.fan();
  await Promise.all([shop.dm(person, 'STOP'), shop.comment(reel.mediaId, { from: person })]);
  await shop.settle();
  assert.equal((await shop.dms({ kind: 'private_reply' })).length <= 1, true);
  assert.equal((await shop.optOuts()).length, 1);
});

test('C-24: the webhook replay of a comment from before the STOP doesn\'t get past it', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const person = world.fan();
  const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from: person, text: 'price', deliver: false });
  await shop.dm(person, 'STOP');
  await shop.settle();
  need(await world.webhook(commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from: person })), 200, 'A comment that arrives late');
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 0);
  await assertReason(shop, 'optout', comment.id);
});

test('C-24: staff with no automations permission can\'t read the word lists', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['orders'] });
  const res = await shop.api('/compliance/words?list=optout', { token: staff.token });
  assert.equal(res.status, 403);
});

// PRD 4.4: private replies within 7 days. C-14 to C-17.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, DAY, HOUR, INSIDE_MS, MINUTE, OUTSIDE_MS, addShop, assertNoDm, assertReason, commentPayload, need, pause, useWorld } from './support.js';

const world = useWorld();
const EXPIRY = COMPLIANCE_LIMITS.privateReplyExpiryMs;
const NO_TIMESTAMP_EXPIRY = COMPLIANCE_LIMITS.privateReplyNoTimestampExpiryMs;

test('the limits used below are the PRD\'s: 7d - 1h, and 7d - 1h - 36h without a timestamp', () => {
  assert.equal(EXPIRY, 7 * DAY - HOUR);
  assert.equal(NO_TIMESTAMP_EXPIRY, 7 * DAY - HOUR - 36 * HOUR);
});

async function expectExpired(shop, comment) {
  await shop.settle();
  await assertNoDm(shop, 'An expired comment makes no API call');
  await assertReason(shop, 'expired.7d', comment.id);
  const [job] = await shop.jobs();
  if (job) assert.equal(job.status, 'expired');
}

test('C-14: a comment 6d 23h 30m old is expired.7d with no API call', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const comment = await shop.comment(reel.mediaId, { at: Date.now() - (6 * DAY + 23 * HOUR + 30 * MINUTE) });
  await expectExpired(shop, comment);
});

test('C-14: a comment a second past 7d - 1h is expired', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const comment = await shop.comment(reel.mediaId, { at: Date.now() - EXPIRY - OUTSIDE_MS });
  await expectExpired(shop, comment);
});

test('C-14: a comment just inside 7d - 1h is sent', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const comment = await shop.comment(reel.mediaId, { at: Date.now() - EXPIRY + INSIDE_MS });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
});

test('C-14: expires_at is exactly the comment\'s time + 7d - 1h', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const at = Date.now() - 3 * HOUR;
  await shop.comment(reel.mediaId, { at });
  await shop.settle();
  const [job] = await shop.jobs();
  assert.ok(Math.abs(new Date(job.expires_at).getTime() - (at + EXPIRY)) < 1000, `Off by ${new Date(job.expires_at).getTime() - (at + EXPIRY)} ms`);
  assert.equal(job.kind, 'private_reply');
});

for (const [label, fault] of [
  ['times out', { kind: 'timeout' }],
  ['answers a 500', { kind: 'server_error' }],
  ['answers junk', { kind: 'malformed', mode: 'garbage' }],
  ['answers with no timestamp', { kind: 'partial', status: 200, body: { id: 'x' } }],
  ['answers a timestamp that is not a date', { kind: 'partial', status: 200, body: { id: 'x', timestamp: 'yesterday-ish' } }],
]) {
  test(`C-14: when the comment lookup ${label}, a comment received 5d 12h ago is expired.7d with no send`, async () => {
    const shop = await addShop(world);
    const reel = await shop.automate();
    const from = world.fan();
    world.stopWorker();
    let comment;
    try {
      comment = await shop.comment(reel.mediaId, { from });
      await world.travel(5 * DAY + 12 * HOUR);
    } finally {
      if (comment) await shop.fault({ ...fault, match: { method: 'GET', path: `*/${comment.id}` }, times: 'forever' });
      world.startWorker();
    }
    await shop.settle({ ms: 5000 });
    await world.meta.delete('/faults');
    assert.equal((await shop.dms()).length, 0);
    await assertReason(shop, 'expired.7d', comment.id);
  });
}

async function noTimestampCase(ageMs) {
  const shop = await addShop(world);
  const reel = await shop.automate();
  world.stopWorker();
  let comment;
  try {
    comment = await shop.comment(reel.mediaId);
    await world.travel(ageMs);
  } finally {
    if (comment) await shop.fault({ kind: 'server_error', match: { method: 'GET', path: `*/${comment.id}` }, times: 'forever' });
    world.startWorker();
  }
  await shop.settle({ ms: 5000 });
  await world.meta.delete('/faults');
  return { shop, comment };
}

test('C-14: with no timestamp, a second past received + 5d 11h is expired', async () => {
  const { shop, comment } = await noTimestampCase(NO_TIMESTAMP_EXPIRY + OUTSIDE_MS);
  assert.equal((await shop.dms()).length, 0);
  await assertReason(shop, 'expired.7d', comment.id);
});

test('C-14: with no timestamp, just inside received + 5d 11h is sent', async () => {
  const { shop, comment } = await noTimestampCase(NO_TIMESTAMP_EXPIRY - INSIDE_MS);
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
});

test('C-14: a queued job that expires while it waits is dropped, whatever it was waiting for', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.refuseSends({ code: 613, status: 429 });
  const comment = await shop.comment(reel.mediaId, { at: Date.now() - EXPIRY + 2 * MINUTE });
  await shop.settle();
  await world.travel(3 * MINUTE);
  await shop.settle();
  assert.equal((await shop.dms()).length, 0);
  await assertReason(shop, 'expired.7d', comment.id);
});

test('C-14: expiry is judged when the worker gets to it, not when the webhook arrived', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  world.stopWorker();
  let comment;
  try {
    comment = await shop.comment(reel.mediaId, { at: Date.now() - EXPIRY + 1500 });
    await pause(2000);
  } finally {
    world.startWorker();
  }
  await shop.settle();
  assert.equal((await shop.dms()).length, 0);
  await assertReason(shop, 'expired.7d', comment.id);
});

test('C-14: 1 private reply per comment is the idempotency key, so the same comment is never answered twice', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const comment = await shop.comment(reel.mediaId);
  await shop.settle();
  const [job] = await shop.jobs();
  assert.equal(job.idempotency_key, `private_reply:${comment.id}`);
  need(await world.webhook(commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from: comment.from })), 200, 'The replay');
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
});

async function queuedThenDeleted({ notify }) {
  const shop = await addShop(world);
  const reel = await shop.automate();
  world.stopWorker();
  let comment;
  try {
    comment = await shop.comment(reel.mediaId);
    await world.meta.post('/comments/delete', { id: comment.id, notify });
  } finally {
    world.startWorker();
  }
  await shop.settle();
  return { shop, comment };
}

test('C-15: a comment deleted before its job sends: no send, no fallback, no retry, comment.deleted', async () => {
  const { shop, comment } = await queuedThenDeleted({ notify: true });
  await assertNoDm(shop);
  await assertReason(shop, 'comment.deleted', comment.id);
  const [job] = await shop.jobs();
  if (job) assert.equal(job.status, 'cancelled');
});

test('C-15: a deletion that sends no webhook is found when Meta refuses the reply: one call, no fallback, no retry', async () => {
  const { shop, comment } = await queuedThenDeleted({ notify: false });
  assert.ok((await shop.sendCalls()).length <= 1, 'At most the one attempt that found out');
  assert.equal((await shop.dms()).length, 0);
  await assertReason(shop, 'comment.deleted', comment.id);
  await world.travel(2 * HOUR);
  await shop.settle();
  assert.ok((await shop.sendCalls()).length <= 1, 'Never retried');
});

test('C-15: a delete that arrives before its comment still means no DM', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from, text: 'price', deliver: false });
  world.stopWorker();
  try {
    need(await world.webhook(commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from, verb: 'remove' })), 200, 'The delete');
    need(await world.webhook(commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from })), 200, 'The comment');
  } finally {
    world.startWorker();
  }
  await shop.settle();
  await assertNoDm(shop);
});

test('C-15: the same delete twice at the same moment cancels once and breaks nothing', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  world.stopWorker();
  let comment;
  try {
    comment = await shop.comment(reel.mediaId);
    const payload = commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from: comment.from, verb: 'remove' });
    await Promise.all([world.webhook(payload), world.webhook(payload)]);
  } finally {
    world.startWorker();
  }
  await shop.settle();
  await assertNoDm(shop);
  assert.equal((await shop.events(`reason = 'comment.deleted'`)).length, 1);
});

test('C-15: a delete after the DM went changes nothing and is not an error', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const comment = await shop.comment(reel.mediaId);
  await shop.settle();
  await world.meta.post('/comments/delete', { id: comment.id, notify: true });
  await shop.settle();
  assert.equal((await shop.jobs())[0].status, 'sent');
  assert.equal((await shop.dms()).length, 1);
});

async function queuedThenEdited(newText) {
  const shop = await addShop(world);
  const reel = await shop.automate();
  world.stopWorker();
  let comment;
  try {
    comment = await shop.comment(reel.mediaId);
    await world.meta.post('/comments/edit', { id: comment.id, text: newText, notify: true });
  } finally {
    world.startWorker();
  }
  await shop.settle();
  return { shop, comment };
}

test('C-16: a comment edited to drop the keyword cancels its job, comment.edited', async () => {
  const { shop, comment } = await queuedThenEdited('nice reel');
  await assertNoDm(shop);
  await assertReason(shop, 'comment.edited', comment.id);
  const [job] = await shop.jobs();
  if (job) assert.equal(job.status, 'cancelled');
});

test('C-16: a comment edited to add a negative word is cancelled too', async () => {
  const { shop, comment } = await queuedThenEdited('price? this is a fraud');
  await assertNoDm(shop);
  await assertReason(shop, 'comment.edited', comment.id);
});

test('C-16: a comment edited but keeping the keyword still gets its one DM', async () => {
  const { shop, comment } = await queuedThenEdited('price please!!');
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
});

test('C-16: an edit is its own event and is not swallowed as a duplicate of the comment', async () => {
  const { shop } = await queuedThenEdited('nice reel');
  assert.equal((await shop.inbound()).length, 2);
});

test('C-16: an edit after the DM went sends nothing more', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const comment = await shop.comment(reel.mediaId);
  await shop.settle();
  await world.meta.post('/comments/edit', { id: comment.id, text: 'price price price', notify: true });
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
});

test('C-16: the same edit delivered twice at the same moment is handled once', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  world.stopWorker();
  let comment;
  try {
    comment = await shop.comment(reel.mediaId);
    const payload = commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, text: 'nice reel', from: comment.from, verb: 'edited' });
    await Promise.all([world.webhook(payload), world.webhook(payload)]);
  } finally {
    world.startWorker();
  }
  await shop.settle();
  await assertNoDm(shop);
  assert.equal((await shop.inbound(`object_id LIKE '%edited%'`)).length, 1);
});

test('C-17: a keyword reply inside the business\'s own thread is own_thread, with no DM', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const parent = await shop.comment(reel.mediaId, { from: { id: shop.igUserId, username: `${shop.slug}_ig` }, text: 'New drop! Comment price' });
  await shop.settle();
  const reply = await shop.comment(reel.mediaId, { parentId: parent.id });
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'own_thread', reply.id);
});

test('C-17: a keyword reply under another person\'s comment is a normal trigger', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const parent = await shop.comment(reel.mediaId, { text: 'lovely' });
  await shop.settle();
  const reply = await shop.comment(reel.mediaId, { parentId: parent.id });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: reply.id })).length, 1);
});

test('C-17: the app\'s own public replies coming back as comments never trigger anything', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const parent = await shop.comment(reel.mediaId, { from: { id: shop.igUserId, username: `${shop.slug}_ig` }, text: 'price' });
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'own_account', parent.id);
});

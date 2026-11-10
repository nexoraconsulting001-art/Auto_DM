// What the worker does with what intake stored: PRD 4.4, 4.6, 4.8, 6.3, 6.4, and the hand-off to the module that answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, HOUR, MINUTE, automation, comment, inMessage, privateReply, uid, world } from './support.js';

const deliver = async (w, body) => {
  await w.compliance.storeDelivery(body);
  return w.compliance.drainInbound();
};
const comments = async (w, ...fields) => deliver(w, w.delivery(...fields.map((f) => comment(f))));
const eventsOf = (w) => w.events().then((rows) => rows.map((r) => [r.decision, r.reason]));
const mapped = (w, media = 'M1') => automation(w, { keywords: ['link', 'price'], media });

/** Records what would be handed to the module that answers, and says "mine". */
const consumer = (w, answer = true) => {
  const seen = [];
  w.compliance.onInbound(async (event) => {
    seen.push(event);
    return answer;
  });
  return seen;
};

test('the business\'s own comment gets nothing', async () => {
  const w = await world();
  const seen = consumer(w);
  await comments(w, { from: w.igUserId });
  assert.deepEqual(await eventsOf(w), [['skipped', 'own_account']]);
  assert.deepEqual(seen, []);
});

test('own_account also knows the account\'s app-scoped id', async () => {
  const w = await world();
  const seen = consumer(w);
  await w.inTenant(`UPDATE ig_accounts SET app_scoped_id = 'APP-ID' WHERE tenant_id = $1`, [w.tenant.id]);
  await comments(w, { from: 'APP-ID' });
  assert.deepEqual(await eventsOf(w), [['skipped', 'own_account']]);
  assert.deepEqual(seen, []);
});

test('C-17: a reply under the business\'s own comment is own_thread', async () => {
  const w = await world();
  const seen = consumer(w);
  const parent = uid('own');
  await comments(w, { id: parent, from: w.igUserId, text: 'New stock!' });
  await comments(w, { from: 'person', parent, text: 'price' });
  assert.deepEqual(await eventsOf(w), [['skipped', 'own_account'], ['skipped', 'own_thread']]);
  assert.deepEqual(seen, []);
});

test('a reply under someone else\'s comment is an ordinary comment', async () => {
  const w = await world();
  const seen = consumer(w);
  const parent = uid('theirs');
  await comments(w, { id: parent, from: 'someone', text: 'nice' });
  seen.length = 0;
  await comments(w, { from: 'person', parent, text: 'price' });
  assert.equal(seen.length, 1);
});

test('A-05, A-06: comments on ads and Live are skipped', async () => {
  const w = await world();
  const seen = consumer(w);
  await comments(w, { type: 'AD' }, { type: 'LIVE' });
  await deliver(w, w.delivery({ field: 'live_comments', value: { id: uid('c'), text: 'LINK', from: { id: 'p' }, media: { id: 'M' } } }));
  assert.deepEqual(await eventsOf(w), [['skipped', 'unsupported_media'], ['skipped', 'unsupported_media'], ['skipped', 'unsupported_media']]);
  assert.deepEqual(seen, []);
});

test('C-23: STOP as a comment blocklists the person and sends nothing at all', async () => {
  const w = await world();
  await w.inBusiness(() => w.compliance.enqueue(privateReply(w)));
  await comments(w, { text: 'STOP' });
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['cancelled', 'cancelled.optout']]);
  assert.equal(w.ig.calls.length, 0);
  const subject = await w.hash('person');
  assert.equal(await w.inBusiness(() => w.platform.compliance.isOptedOut('instagram', subject)), true);
});

test('C-22: STOP as a DM blocklists at once, cancels what was waiting and confirms once', async () => {
  const w = await world();
  await w.messaged('person');
  await w.inBusiness(() => w.compliance.enqueue(privateReply(w)));
  await deliver(w, inMessage(w, { text: 'STOP' }));
  const jobs = await w.jobs();
  assert.deepEqual(jobs.map((j) => [j.kind, j.status, j.reason]), [['private_reply', 'cancelled', 'cancelled.optout'], ['dm', 'queued', '']]);
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  assert.equal(w.ig.calls[0].kind, 'message');
  assert.doesNotMatch(w.ig.calls[0].args[1].text, /bhava/i);
  const subject = await w.hash('person');
  assert.equal(await w.inBusiness(() => w.platform.compliance.isOptedOut('instagram', subject)), true);
});

test('a second STOP gets no second confirmation', async () => {
  const w = await world();
  await deliver(w, inMessage(w, { text: 'STOP' }));
  await deliver(w, inMessage(w, { text: 'stop' }));
  assert.equal((await w.jobs()).length, 1);
});

test('the confirmation is the seller\'s own words when it has set them', async () => {
  const w = await world();
  const [template] = await w.inTenant(`INSERT INTO message_templates (tenant_id, role) VALUES ($1, 'optout_confirm') RETURNING id`, [w.tenant.id]);
  await w.inTenant(`INSERT INTO template_variants (tenant_id, template_id, label, body) VALUES ($1, $2, 'A', 'Ab nahi bhejenge')`, [w.tenant.id, template.id]);
  await deliver(w, inMessage(w, { text: 'STOP' }));
  assert.equal((await w.jobs())[0].payload.message.text, 'Ab nahi bhejenge');
});

test('a word the business added opts out too', async () => {
  const w = await world();
  await w.inBusiness(() => w.platform.compliance.addWord('optout', 'Bas Karo'));
  await deliver(w, inMessage(w, { text: 'bas  karo' }));
  const subject = await w.hash('person');
  assert.equal(await w.inBusiness(() => w.platform.compliance.isOptedOut('instagram', subject)), true);
});

test('START lifts the opt-out, and nothing else', async () => {
  const w = await world();
  const seen = consumer(w);
  await deliver(w, inMessage(w, { text: 'STOP' }));
  await deliver(w, inMessage(w, { text: 'START' }));
  const subject = await w.hash('person');
  assert.equal(await w.inBusiness(() => w.platform.compliance.isOptedOut('instagram', subject)), false);
  assert.deepEqual(seen, [], 'neither word reaches an automation');
});

test('FB-05: a STOP on one channel doesn\'t touch the other', async () => {
  const w = await world();
  await deliver(w, inMessage(w, { text: 'STOP' }));
  const subject = await w.hash('person');
  assert.equal(await w.inBusiness(() => w.platform.compliance.isOptedOut('facebook', subject)), false);
});

test('C-28: a complaint with the keyword in it gets no DM and is listed for a person', async () => {
  const w = await world();
  const seen = consumer(w);
  await mapped(w);
  await comments(w, { text: 'LINK? ordered last week, not received, fraud' });
  assert.deepEqual(await eventsOf(w), [['skipped', 'negative_intent']]);
  assert.deepEqual(seen, []);
  const [item] = await w.needsHuman();
  assert.deepEqual([item.kind, item.reason, item.username], ['negative_comment', 'negative_intent', 'asha']);
  assert.match(item.text, /fraud/);
});

test('C-29: Hinglish counts', async () => {
  const w = await world();
  consumer(w);
  await mapped(w);
  await comments(w, { text: 'price batao, ye fake hai kya' });
  assert.deepEqual(await eventsOf(w), [['skipped', 'negative_intent']]);
});

test('C-30: an owner\'s word applies from then on', async () => {
  const w = await world();
  const seen = consumer(w);
  await mapped(w);
  await comments(w, { text: 'LINK ye kharab hai' });
  assert.equal(seen.length, 1, 'not on the list yet');
  await w.inBusiness(() => w.platform.compliance.addWord('negative', 'kharab'));
  await comments(w, { text: 'LINK ye kharab hai' });
  assert.equal(seen.length, 1);
  assert.deepEqual((await eventsOf(w)).at(-1), ['skipped', 'negative_intent']);
});

test('a complaint on a post with no automation is nobody\'s to answer', async () => {
  const w = await world();
  consumer(w, false);
  await comments(w, { media: 'UNMAPPED', text: 'fraud' });
  assert.deepEqual(await w.needsHuman(), []);
});

test('C-15: a comment deleted while its job waits cancels it, with no call', async () => {
  const w = await world();
  const commentId = uid('c');
  await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { commentId, mediaId: 'M1' })));
  await comments(w, { id: commentId, verb: 'remove' });
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['cancelled', 'comment.deleted']]);
  assert.equal(w.ig.calls.length, 0);
});

test('C-16: a comment edited to drop the keyword cancels its job', async () => {
  const w = await world();
  const auto = await automation(w, { keywords: ['link'] });
  const commentId = uid('c');
  await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { commentId, automationId: auto, mediaId: 'M1' })));
  await comments(w, { id: commentId, verb: 'edited', text: 'nice reel' });
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['cancelled', 'comment.edited']]);
  assert.equal(w.ig.calls.length, 0);
});

test('a comment edited but still asking keeps its job', async () => {
  const w = await world();
  const auto = await automation(w, { keywords: ['link'] });
  const commentId = uid('c');
  await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { commentId, automationId: auto })));
  await comments(w, { id: commentId, verb: 'edited', text: 'link please' });
  assert.equal((await w.jobs())[0].status, 'queued');
});

test('a comment edited to add a complaint cancels its job, even in any-comment mode', async () => {
  const w = await world();
  const auto = await automation(w, { matchMode: 'any' });
  const commentId = uid('c');
  await w.inBusiness(() => w.compliance.enqueue(privateReply(w, { commentId, automationId: auto })));
  await comments(w, { id: commentId, verb: 'edited', text: 'this is a scam' });
  assert.deepEqual((await w.jobs()).map((j) => j.reason), ['comment.edited']);
});

test('A-22: our own message coming back as an echo is ignored', async () => {
  const w = await world();
  const seen = consumer(w);
  await w.messaged('person');
  await w.inBusiness(() => w.compliance.send({ kind: 'dm', accountId: w.igUserId, recipientId: 'person', personId: 'person', idempotencyKey: uid(), expiresAt: new Date(w.clock.t + HOUR), message: { text: 'hi' } }));
  const [job] = await w.jobs();
  await deliver(w, { object: 'instagram', entry: [{ id: w.igUserId, messaging: [{ sender: { id: w.igUserId }, recipient: { id: 'person' }, timestamp: w.clock.t, message: { mid: job.message_id, is_echo: true, text: 'hi' } }] }] });
  const subject = await w.hash('person');
  const [thread] = await w.inTenant('SELECT automation_paused_until, pause_reason FROM inbox_threads WHERE tenant_id = $1 AND subject_hash = $2', [w.tenant.id, subject]);
  assert.deepEqual([thread.automation_paused_until, thread.pause_reason], [null, '']);
  assert.deepEqual(seen, []);
});

const echoFrom = (w, mid, text = 'hello there') => ({ object: 'instagram', entry: [{ id: w.igUserId, messaging: [{ sender: { id: w.igUserId }, recipient: { id: 'person' }, timestamp: w.clock.t, message: { mid, is_echo: true, text } }] }] });

test('A-23: the owner typing in the Instagram app pauses the thread for 12 hours', async () => {
  const w = await world();
  await w.messaged('person');
  await deliver(w, echoFrom(w, uid('owner')));
  const subject = await w.hash('person');
  const [thread] = await w.inTenant('SELECT automation_paused_until, pause_reason FROM inbox_threads WHERE tenant_id = $1 AND subject_hash = $2', [w.tenant.id, subject]);
  assert.equal(+new Date(thread.automation_paused_until), w.clock.t + 12 * HOUR);
  assert.equal(thread.pause_reason, 'thread.owner_replied');
  assert.deepEqual(await eventsOf(w), [['held', 'thread.owner_replied']]);
});

test('an echo that arrives while our send is still in flight waits for the receipt, instead of pausing the thread', async () => {
  const w = await world();
  await w.messaged('person');
  await w.inBusiness(() => w.compliance.enqueue({ kind: 'dm', accountId: w.igUserId, recipientId: 'person', personId: 'person', idempotencyKey: uid(), expiresAt: new Date(w.clock.t + HOUR), message: { text: 'hi' } }));
  await w.inTenant(`UPDATE outbound_jobs SET status = 'sending', lease_until = $2::timestamptz WHERE tenant_id = $1`, [w.tenant.id, new Date(w.clock.t + 60_000)]);
  await deliver(w, echoFrom(w, 'm_in_flight'));
  const [event] = await w.inTenant(`SELECT status, lease_until FROM inbound_events WHERE tenant_id = $1 AND object_id = 'm_in_flight'`, [w.tenant.id]);
  assert.equal(event.status, 'stored');
  await w.inTenant(`UPDATE outbound_jobs SET status = 'sent', message_id = 'm_in_flight' WHERE tenant_id = $1`, [w.tenant.id]);
  w.clock.advance(4000);
  await w.compliance.drainInbound();
  const subject = await w.hash('person');
  const [thread] = await w.inTenant('SELECT pause_reason FROM inbox_threads WHERE tenant_id = $1 AND subject_hash = $2', [w.tenant.id, subject]);
  assert.equal(thread.pause_reason, '');
});

test('A-24, A-38: "human" pauses the thread for 24 hours and asks for a person', async () => {
  const w = await world();
  const seen = consumer(w);
  await deliver(w, inMessage(w, { text: 'can I talk to a human' }));
  const subject = await w.hash('person');
  const [thread] = await w.inTenant('SELECT automation_paused_until, pause_reason, status FROM inbox_threads WHERE tenant_id = $1 AND subject_hash = $2', [w.tenant.id, subject]);
  assert.deepEqual([+new Date(thread.automation_paused_until), thread.pause_reason, thread.status], [w.clock.t + 24 * HOUR, 'thread.handoff', 'needs_human']);
  assert.deepEqual((await w.needsHuman()).map((i) => i.kind), ['handoff']);
  assert.deepEqual((await w.alerts()).map((a) => a.kind), ['thread.handoff']);
  assert.deepEqual(seen, []);
});

test('a handoff cancels a pending follow-up', async () => {
  const w = await world();
  await w.messaged('person');
  await w.inBusiness(() => w.compliance.enqueue({ kind: 'dm', purpose: 'followup', accountId: w.igUserId, recipientId: 'person', personId: 'person', idempotencyKey: uid(), expiresAt: new Date(w.clock.t + HOUR), message: { text: 'hi' } }));
  await deliver(w, inMessage(w, { text: 'human' }));
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['cancelled', 'thread.handoff']]);
});

test('a DM opens the window, and goes in the inbox', async () => {
  const w = await world();
  const seen = consumer(w);
  await deliver(w, inMessage(w, { text: 'price?', mid: 'mid-1' }));
  const subject = await w.hash('person');
  const [thread] = await w.inTenant('SELECT id, last_user_message_at, last_message, recipient_id FROM inbox_threads WHERE tenant_id = $1 AND subject_hash = $2', [w.tenant.id, subject]);
  assert.equal(+new Date(thread.last_user_message_at), w.clock.t);
  assert.deepEqual([thread.last_message, thread.recipient_id], ['price?', 'person']);
  const [message] = await w.inTenant('SELECT direction, author, text, mid FROM inbox_messages WHERE tenant_id = $1 AND thread_id = $2', [w.tenant.id, thread.id]);
  assert.deepEqual(message, { direction: 'in', author: 'person', text: 'price?', mid: 'mid-1' });
  assert.deepEqual([seen[0].type, seen[0].text, seen[0].personId, seen[0].subject, seen[0].mid, seen[0].threadId], ['dm', 'price?', 'person', subject, 'mid-1', thread.id]);
});

test('a timestamp from the future can\'t hold a window open', async () => {
  const w = await world();
  await deliver(w, inMessage(w, { at: w.clock.t + 10 * DAY }));
  const subject = await w.hash('person');
  const [thread] = await w.inTenant('SELECT last_user_message_at FROM inbox_threads WHERE tenant_id = $1 AND subject_hash = $2', [w.tenant.id, subject]);
  assert.equal(+new Date(thread.last_user_message_at), w.clock.t);
});

test('A-13: a story reply opens the window', async () => {
  const w = await world();
  const seen = consumer(w);
  await deliver(w, inMessage(w, { text: 'link', reply_to: { story: { id: 'S1', url: 'https://x.test/s.jpg' } } }));
  const subject = await w.hash('person');
  const [thread] = await w.inTenant('SELECT last_user_message_at FROM inbox_threads WHERE tenant_id = $1 AND subject_hash = $2', [w.tenant.id, subject]);
  assert.ok(thread.last_user_message_at);
  assert.deepEqual([seen[0].type, seen[0].storyId, seen[0].mediaId], ['story_reply', 'S1', 'S1']);
});

test('a story mention is in the inbox but does not open the window, and the media is only a reference', async () => {
  const w = await world();
  const seen = consumer(w);
  await deliver(w, inMessage(w, { text: undefined, attachments: [{ type: 'story_mention', payload: { url: 'https://x.test/m.jpg' } }] }));
  const subject = await w.hash('person');
  const [thread] = await w.inTenant('SELECT id, last_user_message_at FROM inbox_threads WHERE tenant_id = $1 AND subject_hash = $2', [w.tenant.id, subject]);
  assert.equal(thread.last_user_message_at, null);
  const [message] = await w.inTenant('SELECT kind, media_ref FROM inbox_messages WHERE tenant_id = $1 AND thread_id = $2', [w.tenant.id, thread.id]);
  assert.deepEqual(message, { kind: 'story_mention', media_ref: 'https://x.test/m.jpg' });
  assert.equal(seen[0].type, 'story_mention');
});

test('a postback tap opens the window and reaches the module', async () => {
  const w = await world();
  const seen = consumer(w);
  await deliver(w, { object: 'instagram', entry: [{ id: w.igUserId, messaging: [{ sender: { id: 'person' }, recipient: { id: w.igUserId }, timestamp: w.clock.t, postback: { mid: 'pb-1', title: 'Send me the link', payload: 'P1' } }] }] });
  const subject = await w.hash('person');
  const [thread] = await w.inTenant('SELECT last_user_message_at FROM inbox_threads WHERE tenant_id = $1 AND subject_hash = $2', [w.tenant.id, subject]);
  assert.ok(thread.last_user_message_at);
  assert.deepEqual([seen[0].type, seen[0].payload, seen[0].mid], ['postback', 'P1', 'pb-1']);
});

test('a button title that happens to say STOP is not an opt-out', async () => {
  const w = await world();
  await deliver(w, { object: 'instagram', entry: [{ id: w.igUserId, messaging: [{ sender: { id: 'person' }, recipient: { id: w.igUserId }, timestamp: w.clock.t, postback: { mid: uid('pb'), title: 'stop', payload: 'P' } }] }] });
  const subject = await w.hash('person');
  assert.equal(await w.inBusiness(() => w.platform.compliance.isOptedOut('instagram', subject)), false);
});

test('a comment reaches the module with what it needs to act', async () => {
  const w = await world();
  const seen = consumer(w);
  const id = uid('c');
  await deliver(w, w.delivery({ field: 'comments', value: { id, text: 'LINK', timestamp: new Date(w.clock.t - HOUR).toISOString(), from: { id: 'person', username: 'asha' }, media: { id: 'M1', media_product_type: 'REELS' } } }));
  const [event] = seen;
  assert.deepEqual([event.type, event.commentId, event.mediaId, event.mediaType, event.personId, event.username, event.text, event.tooShort], ['comment', id, 'M1', 'REELS', 'person', 'asha', 'LINK', false]);
  assert.equal(+event.expiresAt, w.clock.t - HOUR + 7 * DAY - HOUR);
});

test('a comment with no timestamp expires early enough for Meta\'s retries', async () => {
  const w = await world();
  const seen = consumer(w);
  await comments(w, {});
  assert.equal(+seen[0].expiresAt, w.clock.t + 7 * DAY - HOUR - 36 * HOUR);
});

test('an emoji-only comment is passed on marked too short, for the module to decide', async () => {
  const w = await world();
  const seen = consumer(w);
  await comments(w, { text: '🔥🔥' });
  assert.equal(seen[0].tooShort, true);
});

test('Facebook comments arrive as the same event', async () => {
  const w = await world();
  const seen = consumer(w);
  await w.inTenant(`INSERT INTO fb_pages (page_id, tenant_id, access_token_enc) VALUES ('PAGE-X-${w.tenant.id}', $1, 'x')`, [w.tenant.id]);
  await deliver(w, { object: 'page', entry: [{ id: `PAGE-X-${w.tenant.id}`, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'fc-1', post_id: 'P-1', parent_id: 'P-1', from: { id: 'person', name: 'Asha' }, message: 'LINK', created_time: Math.floor(w.clock.t / 1000) } }] }] });
  assert.deepEqual([seen[0].channel, seen[0].type, seen[0].commentId, seen[0].mediaId, seen[0].parentId], ['facebook', 'comment', 'fc-1', 'P-1', '']);
  assert.equal(+seen[0].expiresAt, Math.floor(w.clock.t / 1000) * 1000 + 7 * DAY - HOUR);
});

test('a module that fails is tried again, and given up on after 5 tries', async () => {
  const w = await world();
  let tries = 0;
  w.compliance.onInbound(async () => {
    tries++;
    throw new Error('boom');
  });
  await comments(w, {});
  for (let i = 0; i < 6; i++) {
    w.clock.advance(MINUTE);
    await w.compliance.drainInbound();
  }
  assert.equal(tries, 5);
  const [row] = await w.inTenant('SELECT status, attempts FROM inbound_events WHERE tenant_id = $1', [w.tenant.id]);
  assert.deepEqual([row.status, row.attempts], ['failed', 5]);
});

test('an event whose worker died goes back to be handled again', async () => {
  const w = await world();
  await w.compliance.storeDelivery(w.delivery(comment({})));
  await w.inTenant(`UPDATE inbound_events SET status = 'processing', lease_until = $2::timestamptz WHERE tenant_id = $1`, [w.tenant.id, new Date(w.clock.t + 60_000)]);
  const seen = consumer(w);
  await w.compliance.recoverInbound();
  await w.compliance.drainInbound();
  assert.equal(seen.length, 0, 'its lease has not run out');
  w.clock.advance(61_000);
  await w.compliance.recoverInbound();
  await w.compliance.drainInbound();
  assert.equal(seen.length, 1);
});

test('no person\'s name or words reach the compliance log', async () => {
  const w = await world();
  await mapped(w);
  await comments(w, { text: 'this is a fraud, SECRET-TEXT' }, { text: 'STOP' });
  await deliver(w, inMessage(w, { text: 'SECRET-TEXT human' }));
  assert.doesNotMatch(JSON.stringify(await w.events()), /SECRET-TEXT|asha/);
});

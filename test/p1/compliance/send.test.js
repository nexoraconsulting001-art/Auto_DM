// compliance.send() and the job it becomes: PRD 4.2 to 4.7, 4.10, 4.16. Meta here is a script, so each answer is exactly the one under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ROLE } from '../../../src/db/index.js';
import { NoTenantError, withTenant } from '../../../src/tenancy.js';
import { DAY, HOUR, MINUTE, automation, dm, metaError, privateReply, scriptedIg, uid, world } from './support.js';

const button = { url: 'https://shop.test/x', title: 'Open' };
const enqueue = (w, action, options) => w.inBusiness(() => w.compliance.enqueue(action, options));
const send = (w, action, options) => w.inBusiness(() => w.compliance.send(action, options));
const check = (w, action) => w.inBusiness(() => w.compliance.check(action));

const reasonOf = async (w) => {
  const events = await w.events();
  return [events.at(-1).decision, events.at(-1).reason];
};

test('send, enqueue and check refuse to run outside a business', async () => {
  const w = await world();
  await assert.rejects(() => w.compliance.send(dm(w)), NoTenantError);
  await assert.rejects(() => w.compliance.enqueue(dm(w)), NoTenantError);
  await assert.rejects(() => w.compliance.check(dm(w)), NoTenantError);
});

test('C-14: a comment 6d 23h 30m old is dropped with no call to Meta', async () => {
  const w = await world();
  const expiresAt = w.compliance.privateReplyExpiresAt({ createdTime: new Date(w.clock.t - (6 * DAY + 23 * HOUR + 30 * MINUTE)), receivedAt: new Date(w.clock.t) });
  const result = await enqueue(w, privateReply(w, { expiresAt }));
  assert.deepEqual([result.outcome, result.reason], ['expired', 'expired.7d']);
  assert.deepEqual(await reasonOf(w), ['expired', 'expired.7d']);
  await w.turn();
  assert.equal(w.ig.calls.length, 0);
});

test('C-14: with no timestamp, one received 5d 12h ago is dropped too', async () => {
  const w = await world();
  const expiresAt = w.compliance.privateReplyExpiresAt({ receivedAt: new Date(w.clock.t - (5 * DAY + 12 * HOUR)) });
  const result = await enqueue(w, privateReply(w, { expiresAt }));
  assert.equal(result.reason, 'expired.7d');
  assert.equal(w.ig.calls.length, 0);
});

test('a job that waited past its expiry is dropped with the same reason, and no call', async () => {
  const w = await world();
  await enqueue(w, privateReply(w, { expiresAt: new Date(w.clock.t + MINUTE) }));
  w.clock.advance(2 * MINUTE);
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['expired', 'expired.7d']]);
  assert.equal(w.ig.calls.length, 0);
});

test('C-18: someone who last messaged 25 hours ago gets window.closed and no call', async () => {
  const w = await world();
  await w.messaged('person', w.clock.t - 25 * HOUR);
  await enqueue(w, dm(w));
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['skipped', 'window.closed']]);
  assert.equal(w.ig.calls.length, 0);
});

test('no cold DMs: someone who has never messaged can\'t be sent one directly either', async () => {
  const w = await world();
  const result = await send(w, dm(w));
  assert.deepEqual([result.outcome, result.reason], ['skipped', 'window.closed']);
  assert.equal(w.ig.calls.length, 0);
});

test('C-19: a mention with no recent DM gets none, and says why', async () => {
  const w = await world();
  await enqueue(w, dm(w, { idempotencyKey: `mention:${uid()}` }));
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => j.reason), ['mention.no_window']);
});

test('a mention with an open window gets one DM, once in 7 days', async () => {
  const w = await world();
  await w.messaged('person');
  await enqueue(w, dm(w, { idempotencyKey: `mention:${uid()}` }));
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  w.clock.advance(2 * DAY);
  await w.messaged('person');
  const again = await enqueue(w, dm(w, { idempotencyKey: `mention:${uid()}`, expiresAt: new Date(w.clock.t + HOUR) }));
  assert.deepEqual([again.outcome, again.reason], ['skipped', 'cap.mention_7d']);
  w.clock.advance(5 * DAY);
  await w.messaged('person');
  const later = await enqueue(w, dm(w, { idempotencyKey: `mention:${uid()}`, expiresAt: new Date(w.clock.t + HOUR) }));
  assert.equal(later.outcome, 'queued');
});

test('C-20: a follow-up scheduled when the person never replied is blocked', async () => {
  const w = await world();
  await w.messaged('person', w.clock.t - HOUR);
  const auto = await automation(w);
  await enqueue(w, dm(w, { automationId: auto, purpose: 'trigger', idempotencyKey: `dm_reply:${uid()}` }));
  await w.turn();
  w.clock.advance(MINUTE);
  await enqueue(w, dm(w, { automationId: auto, purpose: 'followup', expiresAt: new Date(w.clock.t + 20 * HOUR) }));
  await w.turn();
  const last = (await w.jobs()).at(-1);
  assert.deepEqual([last.purpose, last.status, last.reason], ['followup', 'skipped', 'followup.no_response']);
  assert.equal(w.ig.calls.length, 1);
});

test('C-21: after they reply, one follow-up goes, at least 30 minutes later', async () => {
  const w = await world();
  await w.messaged('person', w.clock.t - HOUR);
  const auto = await automation(w);
  await enqueue(w, dm(w, { automationId: auto, purpose: 'trigger', idempotencyKey: `dm_reply:${uid()}` }));
  await w.turn();
  w.clock.advance(HOUR);
  await w.messaged('person');
  await enqueue(w, dm(w, { automationId: auto, purpose: 'followup', expiresAt: new Date(w.clock.t + 20 * HOUR), idempotencyKey: 'fu-1' }));
  w.clock.advance(29 * MINUTE);
  await w.turn();
  assert.equal(w.ig.calls.length, 1, 'too soon');
  w.clock.advance(MINUTE);
  await w.turn();
  assert.equal(w.ig.calls.length, 2);

  const second = await enqueue(w, dm(w, { automationId: auto, purpose: 'followup', expiresAt: new Date(w.clock.t + 20 * HOUR), idempotencyKey: 'fu-2' }));
  assert.deepEqual([second.outcome, second.reason], ['skipped', 'cap.followup']);
});

test('C-24: a job queued before the STOP reaches send is blocked there', async () => {
  const w = await world();
  await enqueue(w, privateReply(w));
  const subject = await w.hash('person');
  await w.inBusiness(() => w.platform.compliance.addOptOut('instagram', subject, 'dm'));
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['skipped', 'optout']]);
  assert.equal(w.ig.calls.length, 0);
});

test('an opted-out person gets no job at all', async () => {
  const w = await world();
  await w.inBusiness(async () => w.platform.compliance.addOptOut('instagram', await w.platform.compliance.subjectHash('instagram', 'person'), 'dm'));
  const result = await enqueue(w, privateReply(w));
  assert.deepEqual([result.outcome, result.reason, result.jobId], ['skipped', 'optout', null]);
  assert.deepEqual(await w.jobs(), []);
});

test('C-55: a skip for optout is one row with a hashed subject and no username', async () => {
  const w = await world();
  const subject = await w.hash('person');
  await w.inBusiness(() => w.platform.compliance.addOptOut('instagram', subject, 'dm'));
  await enqueue(w, privateReply(w, { personId: 'person' }));
  const rows = await w.events();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, subject);
  assert.match(rows[0].subject, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(rows), /person|hello|token/);
});

test('C-56: the app\'s role can\'t change the compliance log', async () => {
  const w = await world();
  await enqueue(w, privateReply(w));
  await assert.rejects(() => w.db.platform.tx(async (t) => {
    await t.exec(`SET LOCAL ROLE ${APP_ROLE}; SELECT set_config('app.tenant_id', '${w.tenant.id}', true)`);
    await t.query(`UPDATE compliance_events SET reason = '' WHERE tenant_id = ${w.tenant.id}`);
  }), /permission denied/i);
});

test('C-25: two keyword comments on one reel make one job', async () => {
  const w = await world();
  const first = await enqueue(w, privateReply(w, { mediaId: 'M1' }));
  const second = await enqueue(w, privateReply(w, { mediaId: 'M1' }));
  assert.equal(first.outcome, 'queued');
  assert.deepEqual([second.outcome, second.reason], ['skipped', 'cap.per_media']);
  assert.equal((await w.jobs()).length, 1);
});

test('two at once still make one job', async () => {
  const w = await world();
  const results = await Promise.all([enqueue(w, privateReply(w, { mediaId: 'M1' })), enqueue(w, privateReply(w, { mediaId: 'M1' }))]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ['queued', 'skipped']);
  assert.equal((await w.jobs()).length, 1);
});

test('C-26: three DMs a day across media, then the 5th 25 hours later goes', async () => {
  const w = await world();
  for (const media of ['A', 'B', 'C']) {
    assert.equal((await enqueue(w, privateReply(w, { mediaId: media }))).outcome, 'queued');
    w.clock.advance(HOUR);
    await w.turn();
  }
  const fourth = await enqueue(w, privateReply(w, { mediaId: 'D' }));
  assert.deepEqual([fourth.outcome, fourth.reason], ['skipped', 'cap.per_person_24h']);
  w.clock.advance(25 * HOUR);
  assert.equal((await enqueue(w, privateReply(w, { mediaId: 'E' }))).outcome, 'queued');
  await w.turn();
  assert.equal(w.ig.calls.length, 4);
});

test('a cancelled job gives its cap back: nothing was ever sent', async () => {
  const w = await world();
  const first = privateReply(w, { mediaId: 'M1' });
  await enqueue(w, first);
  await w.inBusiness(() => w.compliance.discardHeld());
  await w.inTenant(`UPDATE outbound_jobs SET status = 'held' WHERE tenant_id = $1`, [w.tenant.id]);
  await w.inBusiness(() => w.compliance.discardHeld());
  assert.equal((await enqueue(w, privateReply(w, { mediaId: 'M1' }))).outcome, 'queued');
});

test('an unknown outcome keeps its cap: the DM may have arrived', async () => {
  const w = await world({ ig: scriptedIg([metaError({ status: 500, kind: 'server_error', delivery: 'unknown' })]) });
  await enqueue(w, privateReply(w, { mediaId: 'M1' }));
  await w.turn();
  const again = await enqueue(w, privateReply(w, { mediaId: 'M1' }));
  assert.equal(again.reason, 'cap.per_media');
});

test('owners can only lower a cap, and a lowered one applies', async () => {
  const w = await world();
  await w.inBusiness(() => w.platform.compliance.updateSettings({ capOverrides: { 'cap.per_person_24h': 1 } }));
  w.compliance.invalidateSwitches();
  assert.equal((await enqueue(w, privateReply(w, { mediaId: 'A' }))).outcome, 'queued');
  assert.equal((await enqueue(w, privateReply(w, { mediaId: 'B' }))).reason, 'cap.per_person_24h');
});

test('welcome: once per person, ever', async () => {
  const w = await world();
  await w.messaged('person');
  assert.equal((await enqueue(w, dm(w, { purpose: 'welcome' }))).outcome, 'queued');
  assert.equal((await enqueue(w, dm(w, { purpose: 'welcome' }))).reason, 'cap.welcome_once');
});

test('one automated reply per inbound DM', async () => {
  const w = await world();
  await w.messaged('person');
  const mid = uid('mid');
  assert.equal((await enqueue(w, dm(w, { purpose: 'faq' }), { inReplyTo: mid })).outcome, 'queued');
  assert.equal((await enqueue(w, dm(w, { purpose: 'faq' }), { inReplyTo: mid })).reason, 'cap.reply_per_message');
});

test('at most 10 automated replies to one person\'s DMs in a day', async () => {
  const w = await world();
  await w.messaged('person');
  for (let i = 0; i < 10; i++) assert.equal((await enqueue(w, dm(w, { purpose: 'faq' }), { inReplyTo: uid('mid') })).outcome, 'queued');
  assert.equal((await enqueue(w, dm(w, { purpose: 'faq' }), { inReplyTo: uid('mid') })).reason, 'cap.dm_replies_24h');
});

test('the opt-out confirmation is exempt from caps and from the blocklist', async () => {
  const w = await world();
  await w.messaged('person');
  const subject = await w.hash('person');
  await w.inBusiness(() => w.platform.compliance.addOptOut('instagram', subject, 'dm'));
  await enqueue(w, dm(w, { purpose: 'optout_confirm' }));
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
});

test('one key is one job: a second send is refused, and a private reply says cap.per_comment', async () => {
  const w = await world();
  await w.messaged('person');
  const action = dm(w, { idempotencyKey: 'once' });
  assert.equal((await send(w, action)).outcome, 'sent');
  assert.deepEqual((({ outcome, reason }) => [outcome, reason])(await send(w, action)), ['skipped', 'webhook.duplicate']);

  const reply = privateReply(w);
  await enqueue(w, reply);
  assert.deepEqual((({ outcome, reason }) => [outcome, reason])(await enqueue(w, reply)), ['skipped', 'cap.per_comment']);
  assert.equal(w.ig.calls.length, 1);
});

test('A-26: Meta refusing the template gets one plain-text DM, with the link in it', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 100 })]) });
  await enqueue(w, privateReply(w, { message: { text: 'Here you go', button } }));
  await w.turn();
  assert.equal(w.ig.calls.length, 2);
  assert.deepEqual(w.ig.calls.map((c) => (c.args[1].button ? 'template' : 'text')), ['template', 'text']);
  assert.equal(w.ig.calls[1].args[1].text, 'Here you go\nhttps://shop.test/x');
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['sent_fallback', 'fallback.validation']]);
});

test('A-26: a fallback is checked again, and one that breaks a rule does not go', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 100 })]) });
  await enqueue(w, privateReply(w, { message: { text: 'a'.repeat(630), button } }), {});
  await w.inTenant(`UPDATE outbound_jobs SET payload = jsonb_set(payload, '{fallbackText}', to_jsonb(repeat('b', 1001))) WHERE tenant_id = $1`, [w.tenant.id]);
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['failed', 'send.error']]);
});

test('the caller may give its own fallback text', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 100 })]) });
  await enqueue(w, privateReply(w, { message: { text: 'Here you go', button } }), { fallbackText: 'Plain version' });
  await w.turn();
  assert.equal(w.ig.calls[1].args[1].text, 'Plain version');
});

for (const [name, err] of [
  ['a 5xx', metaError({ status: 500, kind: 'server_error', delivery: 'unknown' })],
  ['a timeout', metaError({ status: 0, kind: 'timeout', delivery: 'unknown' })],
  ['a dropped connection', metaError({ status: 0, kind: 'network', delivery: 'unknown' })],
  ['a 200 we couldn\'t read', metaError({ status: 200, kind: 'malformed', delivery: 'unknown' })],
]) {
  test(`after ${name} there is no fallback and no resend: the job is unknown`, async () => {
    const w = await world({ ig: scriptedIg([err]) });
    await enqueue(w, privateReply(w, { message: { text: 'Here you go', button } }));
    await w.turn();
    w.clock.advance(HOUR);
    await w.turn();
    assert.equal(w.ig.calls.length, 1);
    assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['unknown', 'send.unknown_outcome']]);
    assert.deepEqual((await w.needsHuman()).map((i) => i.kind), ['unknown_outcome']);
  });
}

test('a crash while Meta was being called leaves the job unknown, and it is never sent again', async () => {
  const w = await world();
  await enqueue(w, privateReply(w));
  await w.inTenant(`UPDATE outbound_jobs SET status = 'sending', locked_by = 'dead-worker', lease_until = $2::timestamptz WHERE tenant_id = $1`, [w.tenant.id, new Date(w.clock.t + 60_000)]);

  await w.turn();
  assert.equal((await w.jobs())[0].status, 'sending', 'its lease is still running');

  w.clock.advance(61_000);
  await w.turn();
  const [job] = await w.jobs();
  assert.deepEqual([job.status, job.reason], ['unknown', 'send.unknown_outcome']);
  await w.turn();
  w.clock.advance(HOUR);
  await w.turn();
  assert.equal(w.ig.calls.length, 0);
  assert.deepEqual((await w.events()).at(-1).decision, 'unknown');
  assert.deepEqual((await w.needsHuman()).map((i) => i.kind), ['unknown_outcome']);
});

test('a job claimed but never started runs after its lease, because nothing can have gone', async () => {
  const w = await world();
  await enqueue(w, privateReply(w));
  await w.inTenant(`UPDATE outbound_jobs SET locked_by = 'dead-worker', lease_until = $2::timestamptz WHERE tenant_id = $1`, [w.tenant.id, new Date(w.clock.t + 60_000)]);
  await w.turn();
  assert.equal(w.ig.calls.length, 0, 'still leased');
  w.clock.advance(61_000);
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  assert.equal((await w.jobs())[0].status, 'sent');
});

test('C-04: a 190 after the token was swapped retries once with the new token, for one DM', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 190, status: 401 })]) });
  await enqueue(w, privateReply(w));
  const original = w.ig.sendMessage;
  w.ig.sendMessage = async (account, ...args) => {
    const out = original(account, ...args);
    await w.inBusiness(() => w.platform.igAccounts.setToken(w.igUserId, 'token-2'));
    await w.inTenant('UPDATE ig_accounts SET token_version = token_version + 1 WHERE tenant_id = $1', [w.tenant.id]);
    w.ig.sendMessage = original;
    return out;
  };
  await w.turn();
  assert.deepEqual(w.ig.calls.map((c) => c.token), ['token-1', 'token-2']);
  assert.equal((await w.jobs())[0].status, 'sent');
  const [account] = await w.inTenant('SELECT status FROM ig_accounts WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(account.status, 'active');
});

test('a 190 with no new token holds the job, asks for a reconnect and tells the owner', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 190, status: 401 })]) });
  await enqueue(w, privateReply(w));
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['held', 'paused.reconnect']]);
  const [account] = await w.inTenant('SELECT status FROM ig_accounts WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(account.status, 'reconnect_needed');
  assert.deepEqual((await w.alerts()).map((a) => a.kind).sort(), ['breaker.open', 'token.rejected']);
  assert.ok((await w.reasons()).includes('token.rejected'));
});

test('C-08: after a reconnect, held jobs before their expiry send', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 190, status: 401 })]) });
  await enqueue(w, privateReply(w));
  await w.turn();
  w.clock.advance(2 * HOUR);
  await w.inTenant(`UPDATE ig_accounts SET status = 'active', token_version = token_version + 1, token_updated_at = $2::timestamptz WHERE tenant_id = $1`, [w.tenant.id, new Date(w.clock.t)]);
  await w.settle();
  assert.equal((await w.jobs())[0].status, 'sent');
});

test('C-15: a comment deleted before its job sends: no fallback, no retry', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 100, subcode: 33 })]) });
  await enqueue(w, privateReply(w, { message: { text: 'x', button } }));
  await w.turn();
  w.clock.advance(HOUR);
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['cancelled', 'comment.deleted']]);
});

test('10900: Meta says it already has its reply, so it is not retried', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 10900 })]) });
  await enqueue(w, privateReply(w));
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['skipped', 'cap.per_comment']]);
});

test('10901: Meta says the comment is too old', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 10901 })]) });
  await enqueue(w, privateReply(w));
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['expired', 'expired.7d']]);
});

test('an unavailable recipient goes on the blocklist', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 551, subcode: 1545041 })]) });
  await enqueue(w, privateReply(w));
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['failed', 'recipient.unavailable']]);
  const again = await enqueue(w, privateReply(w));
  assert.equal(again.reason, 'optout');
});

test('a failed send is listed for a person to look at', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 1 })]) });
  await enqueue(w, privateReply(w));
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['failed', 'send.error']]);
  assert.deepEqual((await w.needsHuman()).map((i) => [i.kind, i.reason]), [['send_failed', 'send.error']]);
});

test('C-36: a message over the limit once filled is blocked at send and the owner is told', async () => {
  const w = await world();
  await enqueue(w, privateReply(w, { message: { text: 'a'.repeat(1010) } }));
  await w.turn();
  assert.equal(w.ig.calls.length, 0);
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['failed', 'content.too_long']]);
  assert.deepEqual((await w.alerts()).map((a) => a.kind), ['content.too_long']);
});

test('C-60: the disclosure is added to automated DMs only, and counted', async () => {
  const w = await world();
  await w.inBusiness(() => w.platform.compliance.updateSettings({ disclosureEnabled: true }));
  await w.messaged('person');
  await enqueue(w, dm(w));
  await w.turn();
  assert.match(w.ig.calls[0].args[1].text, /\n\nAutomated reply$/);
  assert.doesNotMatch(w.ig.calls[0].args[1].text, /bhava/i);

  await send(w, dm(w, { purpose: 'manual' }));
  assert.equal(w.ig.calls[1].args[1].text, 'hello');
  await enqueue(w, privateReply(w, { personId: 'someone-else', message: { text: 'a'.repeat(990) } }));
  await w.turn();
  assert.equal((await w.jobs()).at(-1).reason, 'content.too_long');
});

test('automated messages carry no tags', async () => {
  const w = await world();
  await w.messaged('person');
  const result = await send(w, { ...dm(w), tag: 'HUMAN_AGENT' });
  assert.deepEqual([result.outcome, result.reason], ['skipped', 'tag.not_allowed']);
  assert.equal(w.ig.calls.length, 0);
});

test('A-39: a manual reply at 23h55m is refused', async () => {
  const w = await world();
  await w.messaged('person', w.clock.t - (23 * HOUR + 55 * MINUTE));
  assert.deepEqual(await check(w, dm(w, { purpose: 'manual' })), { allow: false, outcome: 'skipped', reason: 'window.closed' });
  assert.equal((await send(w, dm(w, { purpose: 'manual' }))).reason, 'window.closed');
  assert.equal(w.ig.calls.length, 0);
});

test('A-40: a manual reply goes, and pauses automation in that thread for 12 hours', async () => {
  const w = await world();
  await w.messaged('person', w.clock.t - 2 * HOUR);
  assert.equal((await send(w, dm(w, { purpose: 'manual' }))).outcome, 'sent');
  const blocked = await enqueue(w, dm(w, { idempotencyKey: `dm_keyword:${uid()}` }));
  assert.deepEqual([blocked.outcome, blocked.reason], ['skipped', 'thread.owner_replied']);
  w.clock.advance(12 * HOUR);
  await w.messaged('person');
  assert.equal((await enqueue(w, dm(w, { idempotencyKey: `dm_keyword:${uid()}`, expiresAt: new Date(w.clock.t + HOUR) }))).outcome, 'queued');
});

test('C-27: the owner replied, then the person DMs the keyword: no automated reply for 12 hours', async () => {
  const w = await world();
  await w.messaged('person', w.clock.t - HOUR);
  const subject = await w.hash('person');
  await w.inTenant(`UPDATE inbox_threads SET automation_paused_until = $3::timestamptz, pause_reason = 'thread.owner_replied' WHERE tenant_id = $1 AND subject_hash = $2`, [w.tenant.id, subject, new Date(w.clock.t + 12 * HOUR)]);
  const result = await enqueue(w, dm(w, { idempotencyKey: `dm_keyword:${uid()}` }));
  assert.equal(result.reason, 'thread.owner_replied');
});

test('A-42: an opted-out person can still get the owner\'s own reply, but no automated message', async () => {
  const w = await world();
  await w.messaged('person');
  const subject = await w.hash('person');
  await w.inBusiness(() => w.platform.compliance.addOptOut('instagram', subject, 'dm'));
  assert.equal((await send(w, dm(w, { purpose: 'manual' }))).outcome, 'sent');
  assert.equal((await send(w, dm(w))).reason, 'optout');
});

test('A-51: a dry run runs every rule, records the payload, makes no call and uses up no cap', async () => {
  const w = await world();
  await w.inBusiness(() => w.platform.compliance.updateSettings({ dryRun: true }));
  w.compliance.invalidateSwitches();
  const first = await enqueue(w, privateReply(w, { mediaId: 'M1' }));
  assert.equal(first.outcome, 'queued');
  await w.turn();
  assert.equal(w.ig.calls.length, 0);
  const [job] = await w.jobs();
  assert.deepEqual([job.status, job.is_test, job.payload.message.text], ['would_send', true, 'hello']);
  assert.equal((await w.events()).at(-1).decision, 'would_send');

  await w.inBusiness(() => w.platform.compliance.updateSettings({ dryRun: false }));
  w.compliance.invalidateSwitches();
  assert.equal((await enqueue(w, privateReply(w, { mediaId: 'M1' }))).outcome, 'queued', 'the dry run did not use the cap');
});

test('a dry run still reports what a cap would do', async () => {
  const w = await world();
  await enqueue(w, privateReply(w, { mediaId: 'M1' }));
  await w.inBusiness(() => w.platform.compliance.updateSettings({ dryRun: true }));
  w.compliance.invalidateSwitches();
  assert.equal((await enqueue(w, privateReply(w, { mediaId: 'M1' }))).reason, 'cap.per_media');
});

test('an automation in dry run sends nothing', async () => {
  const w = await world();
  const auto = await automation(w, { dryRun: true });
  await enqueue(w, privateReply(w, { automationId: auto }));
  await w.turn();
  assert.equal(w.ig.calls.length, 0);
  assert.equal((await w.jobs())[0].status, 'would_send');
});

test('A-49: a tester\'s sends never use up a cap', async () => {
  const w = await world();
  for (let i = 0; i < 2; i++) assert.equal((await enqueue(w, privateReply(w, { mediaId: 'M1', isTest: true }))).outcome, 'queued');
  await w.turn();
  assert.equal(w.ig.calls.length, 2);
  assert.ok((await w.jobs()).every((j) => j.is_test));
});

test('check() applies every rule and changes nothing', async () => {
  const w = await world();
  assert.deepEqual(await check(w, privateReply(w)), { allow: true, outcome: 'queued', reason: '' });
  assert.deepEqual(await check(w, dm(w)), { allow: false, outcome: 'skipped', reason: 'window.closed' });
  assert.deepEqual(await w.jobs(), []);
  assert.deepEqual(await w.events(), []);
});

test('a paused automation holds its job, and an archived one cancels it', async () => {
  const w = await world();
  const paused = await automation(w, { state: 'paused' });
  assert.equal((await enqueue(w, privateReply(w, { automationId: paused }))).reason, 'paused.automation');
  const archived = await automation(w, { state: 'archived' });
  assert.equal((await enqueue(w, privateReply(w, { automationId: archived }))).reason, 'cancelled.owner');
});

test('an automation this business doesn\'t have is refused, and nothing links to it', async () => {
  const w = await world();
  const other = await world();
  const theirs = await automation(other);
  const result = await enqueue(w, privateReply(w, { automationId: theirs }));
  assert.deepEqual([result.outcome, result.reason], ['skipped', 'unmapped']);
  assert.deepEqual(await w.jobs(), []);
});

test('another business\'s account can\'t be sent from, or queued against', async () => {
  const w = await world();
  const other = await world();
  assert.deepEqual((({ outcome, reason }) => [outcome, reason])(await enqueue(other, privateReply(w))), ['held', 'paused.reconnect']);
  assert.deepEqual(await other.jobs(), []);
  assert.deepEqual((({ outcome, reason }) => [outcome, reason])(await send(other, privateReply(w))), ['held', 'paused.reconnect']);
  assert.equal(other.ig.calls.length, 0);
});

test('one business\'s blocklist and caps mean nothing to another', async () => {
  const a = await world();
  const b = await world();
  assert.equal((await enqueue(a, privateReply(a, { mediaId: 'M1' }))).outcome, 'queued');
  assert.equal((await enqueue(b, privateReply(b, { mediaId: 'M1' }))).outcome, 'queued');
  const subject = await a.hash('person');
  await a.inBusiness(() => a.platform.compliance.addOptOut('instagram', subject, 'dm'));
  assert.equal((await enqueue(b, privateReply(b, { mediaId: 'M2' }))).outcome, 'queued');
  assert.equal((await enqueue(a, privateReply(a, { mediaId: 'M2' }))).reason, 'optout');
});

test('C-59: nothing the engine adds to a DM names the platform', async () => {
  const w = await world();
  await w.inBusiness(() => w.platform.compliance.updateSettings({ disclosureEnabled: true }));
  await enqueue(w, privateReply(w, { message: { text: 'Here it is', button } }));
  await w.turn();
  assert.doesNotMatch(JSON.stringify(w.ig.calls[0].args), /bhava/i);
});

test('a token that can\'t be decrypted is a reconnect, not a crash', async () => {
  const w = await world();
  await w.inTenant(`UPDATE ig_accounts SET access_token_enc = 'garbage' WHERE tenant_id = $1`, [w.tenant.id]);
  const result = await send(w, privateReply(w));
  assert.deepEqual([result.outcome, result.reason], ['held', 'paused.reconnect']);
  assert.equal(w.ig.calls.length, 0);
});

test('a job for an account whose withTenant is another\'s can\'t be read', async () => {
  const w = await world();
  await enqueue(w, privateReply(w));
  const other = await world();
  assert.deepEqual(await withTenant(other.tenant, () => w.db.query('SELECT 1 FROM outbound_jobs')), []);
});

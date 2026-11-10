// PRD 4.9: off by default, after a confirmed DM, varied, capped, and dropped rather than sent late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS as limits } from '../../../src/contracts/compliance.js';
import { HOUR, MINUTE, automation, metaError, privateReply, scriptedIg, world } from './support.js';

const VARIANTS = ['Check your DMs!', 'Sent you a message', 'Just DMed you', 'Look in your inbox', 'Dropped it in your DMs', 'Sent!', 'In your DMs now'];
const enqueue = (w, action, options) => w.inBusiness(() => w.compliance.enqueue(action, options));

async function liveWorld(options) {
  const w = await world(options);
  await w.inBusiness(() => w.platform.brandKit.save({ publicReplyVariants: VARIANTS }));
  w.auto = await automation(w, { publicReply: true });
  return w;
}

const replies = async (w) => (await w.jobs()).filter((j) => j.kind === 'public_reply');
const dmToSend = (w, fields) => privateReply(w, { automationId: w.auto, mediaId: 'M1', ...fields });

test('C-31: fewer than 5 replies can\'t be saved', async () => {
  const w = await world();
  await assert.rejects(() => w.inBusiness(() => w.platform.brandKit.save({ publicReplyVariants: VARIANTS.slice(0, 4) })), /Add at least 5 replies/);
});

test('off by default: an automation with no public reply sends none', async () => {
  const w = await liveWorld();
  const auto = await automation(w, { publicReply: false });
  await enqueue(w, privateReply(w, { automationId: auto }));
  await w.turn();
  assert.deepEqual(await replies(w), []);
});

test('it is scheduled 20 to 90 seconds after the DM is confirmed, and expires an hour after', async () => {
  const w = await liveWorld({ random: 0 });
  await enqueue(w, dmToSend(w));
  await w.turn();
  const [reply] = await replies(w);
  assert.equal(+new Date(reply.run_at), w.clock.t + limits.publicReplyMinDelayMs);
  assert.equal(+new Date(reply.expires_at), w.clock.t + HOUR);

  const late = await liveWorld({ random: 0.99999 });
  await enqueue(late, dmToSend(late));
  await late.turn();
  const [other] = await replies(late);
  assert.ok(+new Date(other.run_at) <= late.clock.t + limits.publicReplyMaxDelayMs);
  assert.ok(+new Date(other.run_at) > late.clock.t + 89_000);
});

test('it doesn\'t go before its delay, and goes after it', async () => {
  const w = await liveWorld({ random: 0 });
  await enqueue(w, dmToSend(w));
  await w.turn();
  assert.deepEqual(w.ig.calls.map((c) => c.kind), ['message']);
  w.clock.advance(19_000);
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  w.clock.advance(1_000);
  await w.turn();
  assert.deepEqual(w.ig.calls.map((c) => c.kind), ['message', 'reply']);
  assert.ok(VARIANTS.includes(w.ig.calls[1].args[1]));
});

test('never for an unknown outcome or a skip', async () => {
  const w = await liveWorld({ ig: scriptedIg([metaError({ status: 500, kind: 'server_error', delivery: 'unknown' })]) });
  await enqueue(w, dmToSend(w));
  await w.turn();
  assert.deepEqual(await replies(w), []);
  await w.inTenant(`UPDATE automations SET public_reply_enabled = true WHERE tenant_id = $1`, [w.tenant.id]);
  const capped = await enqueue(w, dmToSend(w));
  assert.equal(capped.reason, 'cap.per_media');
  assert.deepEqual(await replies(w), [], 'a capped person gets no public reply');
});

test('not after the person opts out', async () => {
  const w = await liveWorld({ random: 0 });
  await enqueue(w, dmToSend(w));
  await w.turn();
  const subject = await w.hash('person');
  await w.inBusiness(() => w.platform.compliance.addOptOut('instagram', subject, 'dm'));
  w.clock.advance(30_000);
  await w.turn();
  const [reply] = await replies(w);
  assert.deepEqual([reply.status, reply.reason], ['skipped', 'optout']);
});

test('a failed public reply never retries the DM', async () => {
  const w = await liveWorld({ random: 0, ig: scriptedIg([null, metaError({ code: 1 })]) });
  await enqueue(w, dmToSend(w));
  await w.turn();
  w.clock.advance(30_000);
  await w.turn();
  w.clock.advance(HOUR);
  await w.turn();
  assert.deepEqual(w.ig.calls.map((c) => c.kind), ['message', 'reply']);
  assert.equal((await replies(w))[0].status, 'failed');
});

test('a comment deleted before its public reply cancels it', async () => {
  const w = await liveWorld({ random: 0, ig: scriptedIg([null, metaError({ code: 100, subcode: 33 })]) });
  await enqueue(w, dmToSend(w));
  await w.turn();
  w.clock.advance(30_000);
  await w.turn();
  assert.deepEqual((await replies(w)).map((r) => [r.status, r.reason]), [['cancelled', 'comment.deleted']]);
});

test('C-32: at most 20 on a media in an hour, and never the same reply twice running', async () => {
  const w = await liveWorld({ random: 0.5, limits: { privateRepliesPerHour: 1_000_000 } });
  const seen = [];
  for (let i = 0; i < 25; i++) await enqueue(w, dmToSend(w, { personId: `p${i}` }));
  await w.settle();
  w.clock.advance(100_000);
  await w.settle();
  for (const call of w.ig.calls.filter((c) => c.kind === 'reply')) seen.push(call.args[1]);
  assert.equal(seen.length, 20);
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1], `reply ${i} repeats the one before`);
  assert.ok((await w.reasons()).includes('cap.public_reply_media_h'));
});

test('at most 60 for a business in an hour, across media', async () => {
  const w = await liveWorld({ limits: { privateRepliesPerHour: 1_000_000, publicRepliesPerTenantHour: 5, publicRepliesPerMediaHour: 100 } });
  for (let i = 0; i < 7; i++) await enqueue(w, dmToSend(w, { personId: `p${i}`, mediaId: `M${i}` }));
  await w.settle();
  assert.equal((await replies(w)).length, 5);
  assert.ok((await w.reasons()).includes('cap.public_reply_tenant_h'));
});

test('the caps come back after an hour', async () => {
  const w = await liveWorld({ limits: { privateRepliesPerHour: 1_000_000, publicRepliesPerMediaHour: 1 } });
  await enqueue(w, dmToSend(w));
  await w.settle();
  await enqueue(w, dmToSend(w, { personId: 'p2', mediaId: 'M2' }));
  await w.settle();
  w.clock.advance(HOUR + MINUTE);
  await enqueue(w, dmToSend(w, { personId: 'p3', expiresAt: new Date(w.clock.t + HOUR) }));
  await w.settle();
  assert.equal((await replies(w)).length, 3);
});

test('C-33: a reply held over an hour by slow mode is dropped', async () => {
  const w = await liveWorld({ random: 0 });
  await enqueue(w, dmToSend(w));
  await w.turn();
  await w.inBusiness(() => w.compliance.startSlowMode('instagram', w.igUserId, 'buc_80002', new Date(w.clock.t + 3 * HOUR)));
  w.clock.advance(30_000);
  await w.turn();
  assert.deepEqual((await replies(w)).map((r) => [r.status, r.reason]), [['held', 'rate.slow_mode']]);
  assert.equal(w.ig.calls.length, 1);
  w.clock.advance(HOUR);
  await w.turn();
  assert.deepEqual((await replies(w)).map((r) => [r.status, r.reason]), [['expired', 'expired.public_reply']]);
  assert.deepEqual((await w.events()).at(-1).reason, 'expired.public_reply');
});

test('a public reply waits out a usage header at 75%', async () => {
  const w = await liveWorld({ random: 0 });
  await enqueue(w, dmToSend(w));
  await w.turn();
  await w.inBusiness(() => w.compliance.observeCall('instagram', w.igUserId, { usage: { percent: 78 } }));
  w.clock.advance(30_000);
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  assert.equal((await replies(w))[0].status, 'queued');
  assert.ok((await w.reasons()).includes('rate.usage_header'));
});

test('with fewer than 5 variants in the kit, no public reply goes', async () => {
  const w = await world();
  const auto = await automation(w, { publicReply: true });
  await enqueue(w, privateReply(w, { automationId: auto }));
  await w.turn();
  assert.deepEqual(await replies(w), []);
});

test('a variant that somehow breaks a rule is stopped at send', async () => {
  const w = await liveWorld({ random: 0 });
  await enqueue(w, dmToSend(w));
  await w.turn();
  await w.inTenant(`UPDATE outbound_jobs SET payload = '{"message":{"text":"Only ₹499 at https://x.test"}}'::jsonb WHERE tenant_id = $1 AND kind = 'public_reply'`, [w.tenant.id]);
  w.clock.advance(30_000);
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  assert.equal((await replies(w))[0].status, 'failed');
});

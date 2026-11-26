// B-MSG-6: Meta's release gates (PRD 4.15) are read at every send, not only when an automation goes to Test or Live. A business
// that passed them and then lost Meta access has its automated sends held; they go once if access is back within 24 hours, and
// are dropped with expired.meta_access, the seller told once, after that. A seller's own reply is refused while access is lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passReleaseGates } from '../../helpers.js';
import { DAY, HOUR, MINUTE, automation, dm, privateReply, scriptedIg, world } from './support.js';

const enqueue = (w, action, options) => w.inBusiness(() => w.compliance.enqueue(action, options));
const settingsRow = async (w) => (await w.inTenant('SELECT gate_passed_at, gate_lost_at FROM compliance_settings WHERE tenant_id = $1', [w.tenant.id]))[0];

/** The gates as ig-connect works them out, from the account's real row: the same call the hourly check and the callbacks make. */
const recordGates = (w, health = { privacy: true, deletion: true }) => w.inBusiness(async () => w.platform.igConnect.recordGates({ account: await w.platform.igAccounts.primary(), health }));
/** Live, the way a seller who may go live is: every gate passed. */
const goLive = (w) => passReleaseGates(w.db, w.tenant.id, w.igUserId);
/** The seller removed the messaging permission on Instagram: the next gate check fails gate.scope_missing. */
async function loseAccess(w) {
  await w.db.platform.query(`UPDATE ig_accounts SET granted_scopes = '{}' WHERE tenant_id = $1 AND ig_user_id = $2`, [w.tenant.id, w.igUserId]);
  const result = await recordGates(w);
  assert.equal(result.passed, false);
  w.compliance.invalidateSwitches(); // as any process sees it within COMPLIANCE_LIMITS.switchCacheMs
}
async function restoreAccess(w) {
  await goLive(w); // the scopes are granted again
  const result = await recordGates(w);
  assert.equal(result.passed, true);
  w.compliance.invalidateSwitches();
}
/** Calls to Meta that answer this comment, however the stand-in was called. */
const sentTo = (ig, commentId) => ig.calls.filter((c) => JSON.stringify(c.args).includes(`"${commentId}"`)).length;

test('B-MSG-6: once access is lost after go-live, every automated send is held, new and already queued, and nothing reaches Meta', async () => {
  const w = await world();
  await goLive(w);
  const automationId = await automation(w);
  const queued = await enqueue(w, privateReply(w, { automationId }));
  assert.equal(queued.outcome, 'queued');
  await loseAccess(w);
  assert.ok((await settingsRow(w)).gate_lost_at, 'recordGates marks access as lost');

  await w.messaged('person');
  const created = [
    await enqueue(w, privateReply(w, { automationId })), // a comment-keyword DM
    await enqueue(w, privateReply(w), { trigger: 'comment', legacy: true }), // the Phase 0 reel DM
    await enqueue(w, dm(w, { automationId, expiresAt: new Date(w.clock.t + 20 * HOUR) })),
  ];
  for (const result of created) assert.deepEqual([result.outcome, result.reason], ['held', 'paused.meta_access']);

  await w.turn();
  await w.settle();
  assert.equal(w.ig.calls.length, 0, 'nothing is sent');
  const jobs = await w.jobs();
  assert.equal(jobs.length, 4);
  assert.ok(jobs.every((j) => j.status === 'held' && j.reason === 'paused.meta_access'), JSON.stringify(jobs.map((j) => [j.status, j.reason])));
  assert.ok((await w.reasons()).includes('paused.meta_access'), 'the hold is in the compliance log');
});

test('B-MSG-6: a follow-up is held too, and the check sees the hold', async () => {
  const w = await world();
  await goLive(w);
  await loseAccess(w);
  await w.messaged('person');
  const verdict = await w.inBusiness(() => w.compliance.check(dm(w, { purpose: 'followup' })));
  assert.deepEqual([verdict.allow, verdict.outcome, verdict.reason], [false, 'held', 'paused.meta_access']);
  const created = await enqueue(w, dm(w, { purpose: 'followup' }));
  assert.deepEqual([created.outcome, created.reason], ['held', 'paused.meta_access']);
});

test('B-MSG-6: access back within 24 hours: each held send goes once, through the rules, and never twice', async () => {
  const w = await world({ ig: scriptedIg() });
  await goLive(w);
  const automationId = await automation(w);
  const first = privateReply(w, { automationId });
  const legacy = privateReply(w);
  await enqueue(w, first);
  await loseAccess(w);
  await enqueue(w, legacy, { trigger: 'comment', legacy: true });
  await w.turn();
  assert.equal(w.ig.calls.length, 0);

  w.clock.advance(23 * HOUR);
  await restoreAccess(w);
  assert.equal((await settingsRow(w)).gate_lost_at, null, 'passing again clears the loss');
  await w.turn();
  await w.settle();
  for (let i = 0; i < 3; i++) {
    w.clock.advance(MINUTE);
    await w.turn();
    await w.settle();
  }
  assert.equal(sentTo(w.ig, first.commentId), 1, 'the automation\'s DM went once');
  assert.equal(sentTo(w.ig, legacy.commentId), 1, 'the reel DM went once');
  const jobs = await w.jobs();
  assert.deepEqual(jobs.map((j) => j.status).sort(), ['sent', 'sent']);
  assert.equal((await w.alerts()).filter((a) => a.kind === 'expired.meta_access').length, 0, 'nothing was dropped, so nothing to tell');
});

test('B-MSG-6: a released send still meets the rules at sending: an opt-out made while it waited stops it', async () => {
  const w = await world();
  await goLive(w);
  await loseAccess(w);
  await enqueue(w, privateReply(w, { personId: 'quits' }));
  const subject = await w.hash('quits');
  await w.inBusiness(() => w.platform.compliance.addOptOut('instagram', subject, 'dm', new Date(w.clock.t)));
  await restoreAccess(w);
  await w.turn();
  await w.settle();
  assert.equal(w.ig.calls.length, 0);
  const [job] = await w.jobs();
  assert.deepEqual([job.status, job.reason], ['skipped', 'optout']);
});

test('B-MSG-6: released outside its automation\'s hours, a send waits for the hours (PRD 6.8) instead of going at once', async () => {
  const w = await world();
  await goLive(w);
  const automationId = await automation(w);
  // START is 15:30 in India: hours of 09:00 to 10:00 are closed.
  await w.inTenant(`UPDATE automations SET daily_start = '09:00', daily_end = '10:00' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, automationId]);
  await loseAccess(w);
  await enqueue(w, privateReply(w, { automationId }));
  await restoreAccess(w);
  await w.turn();
  await w.settle();
  assert.equal(w.ig.calls.length, 0);
  const [job] = await w.jobs();
  assert.deepEqual([job.status, job.reason], ['held', 'outside_hours']);
});

test('B-MSG-6: held for more than 24 hours, a send is dropped with expired.meta_access and the seller is told once, not per message', async () => {
  const w = await world();
  await goLive(w);
  const automationId = await automation(w);
  await loseAccess(w);
  for (let i = 0; i < 3; i++) await enqueue(w, privateReply(w, { automationId, personId: `p${i}` }));
  w.clock.advance(23 * HOUR);
  await w.turn();
  assert.ok((await w.jobs()).every((j) => j.status === 'held'), 'not before 24 hours');

  w.clock.advance(HOUR + MINUTE);
  await w.turn();
  let jobs = await w.jobs();
  assert.ok(jobs.every((j) => j.status === 'expired' && j.reason === 'expired.meta_access'), JSON.stringify(jobs.map((j) => [j.status, j.reason])));
  assert.equal((await w.reasons()).filter((r) => r === 'expired.meta_access').length, 3, 'each drop is logged with its reason');
  let alerts = (await w.alerts()).filter((a) => a.kind === 'expired.meta_access');
  assert.equal(alerts.length, 1, 'one notice for the three');
  assert.equal(alerts[0].audience, 'owner');

  // Still lost: a later send is held and dropped the same way, and the seller is not told again for the same loss.
  await enqueue(w, privateReply(w, { automationId, personId: 'later' }));
  w.clock.advance(DAY + MINUTE);
  await w.turn();
  jobs = await w.jobs();
  assert.equal(jobs.filter((j) => j.reason === 'expired.meta_access').length, 4);
  alerts = (await w.alerts()).filter((a) => a.kind === 'expired.meta_access');
  assert.equal(alerts.length, 1);

  // Access back after the drop: nothing dropped comes back.
  await restoreAccess(w);
  await w.turn();
  await w.settle();
  assert.equal(w.ig.calls.length, 0);
});

test('B-MSG-6: a seller\'s own reply is refused, not held, while access is lost', async () => {
  const w = await world();
  await goLive(w);
  await loseAccess(w);
  await w.messaged('person');
  const result = await w.inBusiness(() => w.compliance.send(dm(w, { purpose: 'manual' })));
  assert.deepEqual([result.outcome, result.reason], ['skipped', 'paused.meta_access']);
  assert.equal(w.ig.calls.length, 0);
  assert.equal((await w.jobs()).length, 0, 'nothing waits to go later');
});

test('B-MSG-6: another business on the same database keeps sending while this one has lost access', async () => {
  const ig = scriptedIg();
  const lost = await world({ fresh: true, ig });
  const fine = await world({ base: lost, ig });
  await goLive(lost);
  await goLive(fine);
  await loseAccess(lost);
  const held = privateReply(lost);
  const goes = privateReply(fine);
  assert.equal((await enqueue(lost, held)).reason, 'paused.meta_access');
  assert.equal((await enqueue(fine, goes)).outcome, 'queued');
  assert.equal((await settingsRow(fine)).gate_lost_at, null);
  await lost.turn();
  await lost.settle();
  assert.equal(sentTo(ig, goes.commentId), 1, 'the other business sends');
  assert.equal(sentTo(ig, held.commentId), 0);
  assert.deepEqual((await fine.jobs()).map((j) => j.status), ['sent']);

  // A day later the other business has nothing dropped and no notice.
  lost.clock.advance(DAY + MINUTE);
  fine.clock.advance(DAY + MINUTE);
  await lost.turn();
  assert.equal((await lost.alerts()).filter((a) => a.kind === 'expired.meta_access').length, 1);
  assert.equal((await fine.alerts()).filter((a) => a.kind === 'expired.meta_access').length, 0);
});

test('B-MSG-6: a business that never passed the gates, or that disconnected on purpose, has not "lost" access', async () => {
  const never = await world();
  await recordGates(never, {});
  assert.equal((await settingsRow(never)).gate_lost_at, null, 'never live: nothing to lose (the launch check stops it going live)');
  assert.equal((await enqueue(never, privateReply(never))).outcome, 'queued');

  const left = await world();
  await goLive(left);
  await left.inBusiness(() => left.platform.igAccounts.disconnect(left.igUserId, { actor: 'user:1' }));
  assert.equal(await left.inBusiness(() => left.platform.igAccounts.primary()), null);
  assert.equal((await recordGates(left)).passed, false);
  assert.equal((await settingsRow(left)).gate_lost_at, null, 'a seller who disconnected on purpose has not lost access');
});

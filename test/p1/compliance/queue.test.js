// PRD 4.3: budgets, throttling and slow mode, on the job queue and its worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS } from '../../../src/contracts/compliance.js';
import { compliance as moduleDefinition, createCompliance } from '../../../src/modules/compliance/index.js';
import { createQueue } from '../../../src/platform/queue.js';
import { HOUR, MINUTE, automation, dm, metaError, privateReply, scriptedIg, uid, world } from './support.js';

const enqueue = (w, action, options) => w.inBusiness(() => w.compliance.enqueue(action, options));
const statuses = async (w) => (await w.jobs()).map((j) => j.status);
const anyWindowOver = (times, windowMs, limit) => times.some((t, i) => times.filter((other, j) => j <= i && t - other < windowMs).length > limit);

test('C-09: a burst of comments goes at the budget, never above it in any hour, and drains in about 5 hours', async () => {
  // Scaled by five against the real 3,000 and 600 per hour, so the arithmetic is the same and the run is short.
  const w = await world({ limits: { privateRepliesPerHour: 120 } });
  const sent = [];
  w.onSend((t) => sent.push(t));
  const start = w.clock.t;
  for (let i = 0; i < 600; i++) await enqueue(w, privateReply(w, { personId: `p${i}`, expiresAt: new Date(start + 20 * HOUR) }));
  while (sent.length < 600 && w.clock.t < start + 8 * HOUR) {
    await w.settle();
    w.clock.advance(15_000);
  }
  assert.equal(sent.length, 600);
  assert.equal(anyWindowOver(sent, HOUR, 120), false, 'never more than 120 in any rolling hour');
  const hours = (sent.at(-1) - start) / HOUR;
  assert.ok(hours > 4.8 && hours < 5.4, `drained in ${hours} hours`);
  assert.ok((await statuses(w)).every((s) => s === 'sent'));
});

test('the real buckets: at most 600 in any hour with a burst of 10, and at most 20 in any second', async () => {
  const w = await world();
  const privateReplies = w.compliance.budgets.describe('private_reply', 1);
  assert.equal(privateReplies.capacity, 10);
  assert.equal(Math.round(privateReplies.capacity + privateReplies.perSecond * 3600), COMPLIANCE_LIMITS.privateRepliesPerHour);
  const sendApi = w.compliance.budgets.describe('send_api', 1);
  assert.equal(sendApi.capacity + sendApi.perSecond, COMPLIANCE_LIMITS.sendApiPerSecond);
  const halved = w.compliance.budgets.describe('private_reply', 0.5);
  assert.equal(Math.round(halved.capacity + halved.perSecond * 3600), COMPLIANCE_LIMITS.privateRepliesPerHour / 2);
});

test('the Send API: 20 a second at most', async () => {
  const w = await world();
  const sent = [];
  w.onSend((t) => sent.push(t));
  for (let i = 0; i < 60; i++) {
    await w.messaged(`p${i}`);
    await enqueue(w, dm(w, { recipientId: `p${i}`, personId: `p${i}`, expiresAt: new Date(w.clock.t + HOUR) }));
  }
  for (let i = 0; i < 100 && sent.length < 60; i++) {
    await w.settle();
    w.clock.advance(100);
  }
  assert.equal(sent.length, 60);
  assert.equal(anyWindowOver(sent, 1000, 20), false);
});

test('a budget belongs to one account: another business\'s queue never uses it', async () => {
  const a = await world({ limits: { privateRepliesPerHour: 1 } });
  const b = await world({ base: a, limits: { privateRepliesPerHour: 1 }, at: a.clock.t });
  for (let i = 0; i < 2; i++) {
    await enqueue(a, privateReply(a, { personId: `pa${i}` }));
    await enqueue(b, privateReply(b, { personId: `pb${i}` }));
  }
  await a.compliance.drainOutbound();
  const sentPer = async (w) => (await statuses(w)).filter((s) => s === 'sent').length;
  assert.deepEqual([await sentPer(a), await sentPer(b)], [1, 1]);
});

test('C-47: 2,400 jobs queued for one business don\'t delay another\'s', async () => {
  const a = await world({ limits: { privateRepliesPerHour: 100_000 } });
  const b = await world({ base: a, limits: { privateRepliesPerHour: 100_000 }, at: a.clock.t });
  const ready = new Date(a.clock.t - 1000).toISOString();
  const values = Array.from({ length: 300 }, (_, i) => `(${a.tenant.id}, 'instagram', '${a.igUserId}', 'private_reply', 'bulk-${i}', 'c${i}', '${ready}'::timestamptz + interval '1 day', '${ready}'::timestamptz, '{"message":{"text":"x"}}'::jsonb)`);
  await a.db.platform.query(`INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, idempotency_key, comment_id, expires_at, run_at, payload) VALUES ${values.join(',')}`);
  await enqueue(b, privateReply(b));
  await a.compliance.drainOutbound();
  assert.deepEqual(await statuses(b), ['sent'], 'the one job goes in the same turn as the first slice of the big queue');
  const left = (await statuses(a)).filter((s) => s === 'queued').length;
  assert.ok(left > 200 && left < 300, `and the big queue is going, a slice at a time: ${left} left`);
});

test('C-10: 613 on messaging pauses the account, keeps the job, and insights carry on', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 613 })]) });
  await enqueue(w, privateReply(w));
  await enqueue(w, privateReply(w, { personId: 'p2' }));
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  assert.deepEqual((await w.jobs()).map((j) => j.status), ['queued', 'queued']);
  assert.ok((await w.reasons()).includes('rate.throttled'));

  await w.turn();
  assert.equal(w.ig.calls.length, 1, 'messaging stays paused');
  assert.equal((await w.inBusiness(() => w.compliance.callAllowed('instagram', w.igUserId, 'insights'))).allow, true);

  w.clock.advance(MINUTE);
  await w.settle();
  assert.deepEqual(await statuses(w), ['sent', 'sent'], 'a throttled job is retried: nothing was delivered');
  assert.equal(w.ig.calls.length, 3);
});

test('C-10: Meta\'s regain time is used when it gives one', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 613, usage: { percent: 100, regainMinutes: 7 } })]) });
  await enqueue(w, privateReply(w));
  await w.turn();
  const [row] = await w.inTenant('SELECT messaging_paused_until FROM account_rate_state WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(+new Date(row.messaging_paused_until), w.clock.t + 7 * MINUTE);
});

test('backoff runs from 1 minute up to 60, and a success starts it over', async () => {
  const throttle = () => metaError({ code: 4 });
  const w = await world({ ig: scriptedIg([throttle(), throttle(), throttle()]) });
  await enqueue(w, privateReply(w, { expiresAt: new Date(w.clock.t + 24 * HOUR) }));
  const backoff = async () => (await w.inTenant('SELECT backoff_minutes FROM account_rate_state WHERE tenant_id = $1', [w.tenant.id]))[0].backoff_minutes;
  await w.turn();
  assert.equal(await backoff(), 1);
  w.clock.advance(2 * MINUTE);
  await w.turn();
  assert.equal(await backoff(), 2);
  w.clock.advance(3 * MINUTE);
  await w.turn();
  assert.equal(await backoff(), 4);
  w.clock.advance(HOUR);
  await w.turn();
  assert.equal(await backoff(), 0);
});

test('a throttled job that runs out of time expires instead of retrying', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 613, usage: { percent: 100, regainMinutes: 120 } })]) });
  await enqueue(w, privateReply(w, { expiresAt: new Date(w.clock.t + HOUR) }));
  await w.turn();
  w.clock.advance(2 * HOUR);
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['expired', 'expired.7d']]);
});

test('a 429 without a Graph body is a throttle, not a failure', async () => {
  const w = await world({ ig: scriptedIg([metaError({ status: 429, code: undefined })]) });
  await enqueue(w, privateReply(w));
  await w.turn();
  assert.equal((await w.jobs())[0].status, 'queued');
});

test('C-11: 80002 pauses insights and public replies; DMs go on at half speed', async () => {
  const w = await world({ limits: { privateRepliesPerHour: 60 } });
  const allowed = (cls) => w.inBusiness(() => w.compliance.callAllowed('instagram', w.igUserId, cls));
  await w.inBusiness(() => w.compliance.observeCall('instagram', w.igUserId, { kind: 'buc_throttled', usage: { percent: 100, regainMinutes: 30 } }));
  assert.equal((await allowed('insights')).allow, false);
  assert.equal((await allowed('token_refresh')).allow, true);

  const [rate] = await w.inTenant('SELECT slow_mode_trigger, slow_mode_until FROM account_rate_state WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(rate.slow_mode_trigger, 'buc_80002');
  assert.equal(+new Date(rate.slow_mode_until), w.clock.t + 30 * MINUTE + HOUR, 'until the regain time plus an hour');

  const sent = [];
  w.onSend((t) => sent.push(t));
  for (let i = 0; i < 40; i++) await w.inTenant(`INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, idempotency_key, comment_id, expires_at, run_at, payload) VALUES ($1, 'instagram', $2, 'private_reply', $3, $4, $5::timestamptz, $6::timestamptz, '{"message":{"text":"x"}}'::jsonb)`, [w.tenant.id, w.igUserId, uid('k'), uid('c'), new Date(w.clock.t + 10 * HOUR), new Date(w.clock.t - 1000)]);
  const start = w.clock.t;
  while (w.clock.t < start + HOUR) {
    await w.settle();
    w.clock.advance(30_000);
  }
  assert.ok(sent.length > 0, 'DMs continue');
  assert.ok(sent.length <= 30, `half of 60 an hour, got ${sent.length}`);
});

test('C-12: 78% usage on an insights call pauses non-story polling and leaves DMs alone', async () => {
  const w = await world();
  await w.inBusiness(() => w.compliance.observeCall('instagram', w.igUserId, { usage: { percent: 78, regainMinutes: 0 } }));
  const allowed = (cls) => w.inBusiness(() => w.compliance.callAllowed('instagram', w.igUserId, cls));
  assert.equal((await allowed('insights')).allow, false);
  assert.equal((await allowed('story_insights')).allow, true);
  await enqueue(w, privateReply(w));
  await w.turn();
  assert.equal((await w.jobs())[0].status, 'sent');
});

test('C-13: at 92% only token refresh runs', async () => {
  const w = await world();
  await w.inBusiness(() => w.compliance.observeCall('instagram', w.igUserId, { usage: { percent: 92 } }));
  const allowed = (cls) => w.inBusiness(() => w.compliance.callAllowed('instagram', w.igUserId, cls));
  assert.equal((await allowed('story_insights')).allow, false);
  assert.equal((await allowed('token_refresh')).allow, true);
});

test('a usage header at 90% on a message starts slow mode', async () => {
  const w = await world({ ig: scriptedIg([{ messageId: uid('m'), status: 200, usage: { percent: 91, regainMinutes: 0 } }]) });
  await w.messaged('person');
  await enqueue(w, dm(w));
  await w.turn();
  const [rate] = await w.inTenant('SELECT slow_mode_trigger, usage_percent FROM account_rate_state WHERE tenant_id = $1', [w.tenant.id]);
  assert.deepEqual([rate.usage_percent, rate.slow_mode_trigger], [91, 'buc_80002']);
  assert.ok((await w.reasons()).includes('rate.usage_header'));
});

test('an automation made during slow mode is held for review, and goes when slow mode ends', async () => {
  const w = await world();
  await w.inBusiness(() => w.compliance.startSlowMode('instagram', w.igUserId, 'reach_drop', new Date(w.clock.t + HOUR)));
  const fresh = await automation(w);
  await w.inTenant('UPDATE automations SET created_at = $2::timestamptz WHERE tenant_id = $1', [w.tenant.id, new Date(w.clock.t + 1000)]);
  const result = await enqueue(w, privateReply(w, { automationId: fresh }));
  assert.deepEqual([result.outcome, result.reason], ['held', 'held.review']);
  await w.turn();
  assert.equal(w.ig.calls.length, 0);
  w.clock.advance(HOUR + MINUTE);
  await w.settle();
  assert.equal(w.ig.calls.length, 1);
});

test('slow mode keeps 2 minutes between DMs on one media', async () => {
  const w = await world();
  await w.inBusiness(() => w.compliance.startSlowMode('instagram', w.igUserId, 'buc_80002', new Date(w.clock.t + 24 * HOUR)));
  for (const person of ['p1', 'p2']) {
    await w.messaged(person);
    await enqueue(w, dm(w, { recipientId: person, personId: person, purpose: 'link', mediaId: 'M1', expiresAt: new Date(w.clock.t + 20 * HOUR) }));
  }
  await w.turn();
  assert.equal(w.ig.calls.length, 1);
  w.clock.advance(MINUTE);
  await w.turn();
  assert.equal(w.ig.calls.length, 1, 'too soon');
  w.clock.advance(MINUTE);
  await w.turn();
  assert.equal(w.ig.calls.length, 2);
});

test('an account\'s webhooks and sends carry on while another account is throttled', async () => {
  const w = await world({ ig: scriptedIg([metaError({ code: 613 })]) });
  const other = `${w.igUserId}-second`;
  await w.platform.tenants.linkIgAccount(w.tenant.id, other, 'second');
  await w.inBusiness(() => w.platform.igAccounts.setToken(other, 'token-2'));
  await enqueue(w, privateReply(w));
  await w.turn();
  await enqueue(w, privateReply(w, { accountId: other, personId: 'p2' }));
  await w.turn();
  assert.deepEqual(await statuses(w), ['queued', 'sent']);
});

test('the worker runs on the platform queue, a poke wakes it, and it sends what is waiting', async () => {
  const w = await world({ fresh: true, at: Date.now(), config: { complianceNow: Date.now, complianceInline: false } });
  const queue = createQueue({ queueDriver: 'pg', queuePollMs: 10 }, { db: w.db });
  const engine = createCompliance({ db: w.db, repos: w.platform, ig: w.ig, config: { complianceInline: false }, platform: { queue } });
  const schedule = moduleDefinition.jobs({ db: w.db, repos: w.platform, platform: { queue }, config: {}, compliance: engine });
  await enqueue(w, privateReply(w));
  await schedule();
  for (let i = 0; i < 200 && !w.ig.calls.length; i++) await new Promise((r) => setTimeout(r, 25));
  await queue.close();
  assert.equal(w.ig.calls.length, 1);
  assert.equal((await w.jobs())[0].status, 'sent');
});

test('with nothing waiting the schedule adds nothing to the queue', async () => {
  const w = await world({ fresh: true });
  const queue = createQueue({ queueDriver: 'pg', queuePollMs: 10_000 }, { db: w.db });
  const schedule = moduleDefinition.jobs({ db: w.db, repos: w.platform, platform: { queue: { ...queue, work() {} } }, config: {}, compliance: w.compliance });
  await schedule();
  assert.deepEqual(await w.db.platform.query('SELECT queue FROM jobs'), []);
});

test('a turn that leaves jobs waiting asks for the next one, keyed by the second it is due', async () => {
  const w = await world({ fresh: true, at: Date.now(), config: { complianceNow: Date.now, complianceInline: false } });
  const queue = createQueue({ queueDriver: 'pg', queuePollMs: 10 }, { db: w.db });
  const engine = createCompliance({ db: w.db, repos: w.platform, ig: w.ig, config: { complianceLimits: { privateRepliesPerHour: 60 }, complianceInline: false }, platform: { queue } });
  for (let i = 0; i < 3; i++) await enqueue(w, privateReply(w, { personId: `p${i}` }));
  await engine.workOnce();
  await engine.workOnce();
  assert.equal(w.ig.calls.length, 1, 'the budget allows one');
  const rows = await w.db.platform.query(`SELECT dedupe_key FROM jobs WHERE queue = 'compliance.drain'`);
  assert.ok(rows.length >= 1 && rows.length <= 2, `got ${rows.length}`);
  assert.ok(rows.every((r) => r.dedupe_key.startsWith('wake:')));
});

test('two workers never send one job twice', async () => {
  const w = await world();
  const second = createCompliance({ db: w.db, repos: w.platform, ig: w.ig, config: { complianceNow: w.clock.now, complianceInline: false }, platform: {} });
  for (let i = 0; i < 12; i++) await enqueue(w, privateReply(w, { personId: `p${i}` }));
  await Promise.all([w.compliance.drainOutbound(), second.drainOutbound(), w.compliance.drainOutbound(), second.drainOutbound()]);
  const comments = w.ig.calls.map((c) => c.args[0].commentId);
  assert.equal(new Set(comments).size, comments.length);
});

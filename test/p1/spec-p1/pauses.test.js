// PRD 4.12 and 4.13: pause and breaker. C-42, C-43. (The kill switch, C-44 and C-45, is in pauses-switches.test.js; C-48 and C-57 are in pauses-breakers.test.js: one file took over 9 minutes.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, HOUR, UNPACED, INSIDE_MS, MINUTE, OUTSIDE_MS, SWITCH_LAG_MS, addShop, addStaff, assertNoDm, assertReason, consoleUser, need, onConsole, openWorld, pause, unique, useWorld } from './support.js';

const world = useWorld();
const PERMISSION = 200;

const breaker = async (shop, channel = 'instagram') => (await shop.sql('SELECT * FROM breakers WHERE tenant_id = $1 AND channel = $2', [shop.tenantId, channel]))[0];
const status = (shop) => shop.call('/compliance/status', 200);

/** n comments, each answered with a permission error. */
async function permissionErrors(shop, n) {
  const reel = await shop.automate();
  await shop.refuseSends({ code: PERMISSION, times: n });
  for (let i = 0; i < n; i++) {
    await shop.comment(reel.mediaId);
    await shop.settle({ ms: 2500 });
  }
  return reel;
}


test('C-42: 5 permission errors in 10 minutes open that business\'s breaker; another keeps sending', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const reelB = await b.automate();
  await permissionErrors(a, 5);
  assert.equal((await breaker(a)).state, 'open');
  assert.equal((await status(a)).breaker, 'open');
  await b.comment(reelB.mediaId);
  await b.settle();
  assert.equal((await b.dms()).length, 1);
  assert.equal((await status(b)).breaker, 'closed');
});

test('C-42: while open nothing is called, and new jobs are held, paused.breaker', async () => {
  const shop = await addShop(world);
  const reel = await permissionErrors(shop, 5);
  await world.switchLag();
  const calls = (await shop.sendCalls()).length;
  const comment = await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.sendCalls()).length, calls);
  await assertReason(shop, 'paused.breaker', comment.id);
  assert.equal((await shop.jobs('comment_id = $2', [comment.id]))[0].status, 'held');
});

test('C-42: 4 errors leave it closed', async () => {
  const shop = await addShop(world);
  await permissionErrors(shop, 4);
  assert.equal((await status(shop)).breaker, 'closed');
});

test('C-42: errors older than 15 minutes don\'t count', async () => {
  const shop = await addShop(world);
  const reel = await permissionErrors(shop, 4);
  await world.travel(15 * MINUTE + OUTSIDE_MS);
  await shop.refuseSends({ code: PERMISSION });
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await status(shop)).breaker, 'closed');
});

test('C-42: 5 errors just inside 15 minutes do', async () => {
  const shop = await addShop(world);
  const reel = await permissionErrors(shop, 4);
  await world.travel(15 * MINUTE - INSIDE_MS);
  await shop.refuseSends({ code: PERMISSION });
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await status(shop)).breaker, 'open');
});

test('C-42: any token-invalid error trips it at once', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await world.meta.post('/tokens/revoke', { token: shop.igToken });
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await status(shop)).breaker, 'open');
});

// Its own world without the hourly bucket: this is about the error rate over 50 sends, which pacing would stretch over minutes.
test('C-42: over 20% errors across 50 sends trips it', { timeout: 120_000 }, async () => {
  const fast = await openWorld({ overrides: UNPACED });
  try {
    const shop = await addShop(fast);
    const reel = await shop.automate();
    await shop.refuseSends({ code: 100, times: 22, after: 0 });
    for (let i = 0; i < 50; i++) await shop.comment(reel.mediaId);
    await shop.settle({ ms: 40_000, roundMs: 2000 });
    assert.equal((await status(shop)).breaker, 'open');
  } finally {
    await fast.close();
  }
});

test('C-42: 3 throttle backoff cycles in a row trip it', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.fault({ kind: 'rate_limit', code: 613, match: { method: 'POST', path: `*/${shop.igUserId}/messages` }, times: 'forever' });
  try {
    await shop.comment(reel.mediaId);
    for (let i = 0; i < 4; i++) {
      await shop.settle({ ms: 2000 });
      await world.travel(61 * MINUTE);
    }
    await shop.settle({ ms: 2000 });
  } finally {
    await world.meta.delete('/faults');
  }
  assert.equal((await breaker(shop)).state, 'open');
});

async function openedBreaker() {
  const shop = await addShop(world);
  const reel = await permissionErrors(shop, 5);
  assert.equal((await breaker(shop)).state, 'open');
  await world.switchLag();
  const comment = await shop.comment(reel.mediaId);
  await shop.settle();
  return { shop, reel, comment };
}

test('C-42: just inside 30 minutes no probe goes out', async () => {
  const { shop } = await openedBreaker();
  const calls = (await shop.sendCalls()).length;
  await world.travel(30 * MINUTE - INSIDE_MS);
  await shop.settle();
  assert.equal((await shop.sendCalls()).length, calls);
});

test('C-42: after 30 minutes exactly one half-open probe goes, and success closes it at x0.5 for 15 minutes', async () => {
  const { shop, comment } = await openedBreaker();
  const calls = (await shop.sendCalls()).length;
  await world.travel(30 * MINUTE + OUTSIDE_MS);
  await shop.settle();
  assert.equal((await shop.sendCalls()).length, calls + 1, 'One probe');
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
  const row = await breaker(shop);
  assert.equal(row.state, 'closed');
  assert.ok(Math.abs(new Date(row.reduced_until).getTime() - Date.now() - 15 * MINUTE) < MINUTE);
});

test('C-42: a failed probe reopens it and doubles the wait', async () => {
  const { shop } = await openedBreaker();
  await shop.refuseSends({ code: PERMISSION });
  await world.travel(30 * MINUTE + OUTSIDE_MS);
  await shop.settle();
  const row = await breaker(shop);
  assert.equal(row.state, 'open');
  assert.equal(row.wait_minutes, 60);
  assert.ok(Math.abs(new Date(row.open_until).getTime() - Date.now() - 60 * MINUTE) < MINUTE);
});

test('C-42: a Facebook breaker leaves Instagram running', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.sql(`INSERT INTO breakers (tenant_id, channel, state, opened_at, open_until) VALUES ($1, 'facebook', 'open', now(), now() + interval '30 minutes')`, [shop.tenantId]);
  await world.switchLag();
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
});

const pauseShop = (shop, body = {}) => shop.call('/compliance/pause', 200, { method: 'POST', body });
const resumeShop = (shop) => shop.call('/compliance/resume', 200, { method: 'POST' });

test('C-43: the owner resumes after a 2h pause: unexpired held jobs drain, once each', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await pauseShop(shop);
  await world.switchLag();
  const comments = [];
  for (let i = 0; i < 3; i++) comments.push(await shop.comment(reel.mediaId));
  await shop.settle();
  await assertNoDm(shop);
  const held = await shop.call('/compliance/held-jobs', 200);
  assert.equal(held.items.length, 3);
  assert.ok(held.items.every((j) => j.reason === 'paused.tenant'));
  await world.travel(2 * HOUR);
  await resumeShop(shop);
  await world.switchLag();
  await shop.settle();
  const dms = await shop.dms();
  assert.deepEqual(dms.map((m) => m.commentId).sort(), comments.map((c) => c.id).sort());
});

test('C-43: held jobs resume at the normal budget, never as a burst', { timeout: 120_000 }, async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await pauseShop(shop);
  await world.switchLag();
  const { commentPayload } = await import('./support.js');
  const entries = [];
  for (let i = 0; i < 700; i++) {
    const from = world.fan();
    const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from, text: 'price', deliver: false });
    entries.push(commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from }).entry[0]);
  }
  need(await world.webhook({ object: 'instagram', entry: entries }), 200, 'The batch');
  await shop.settle({ ms: 40_000, roundMs: 2000 });
  await world.travel(2 * HOUR);
  await resumeShop(shop);
  await world.switchLag();
  await shop.settle({ ms: 30_000, roundMs: 2000 });
  assert.ok((await shop.dms()).length <= COMPLIANCE_LIMITS.privateRepliesPerHour, 'Not more than an hour\'s budget at once');
});

test('C-43: a job that expired during the pause drops with its reason, and sends nothing', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await pauseShop(shop);
  await world.switchLag();
  await shop.comment(reel.mediaId, { at: Date.now() - COMPLIANCE_LIMITS.privateReplyExpiryMs + HOUR });
  await shop.settle();
  await world.travel(2 * HOUR);
  await resumeShop(shop);
  await world.switchLag();
  await shop.settle();
  const [job] = await shop.jobs();
  assert.equal(job.status, 'expired');
  assert.equal(job.reason, 'expired.7d');
  await assertNoDm(shop);
});

test('C-43: caps and the blocklist apply while paused', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  const blocked = world.fan();
  await shop.dm(blocked, 'STOP');
  await shop.settle();
  await pauseShop(shop);
  await world.switchLag();
  await shop.comment(reel.mediaId, { from });
  const capped = await shop.comment(reel.mediaId, { from });
  const optedOut = await shop.comment(reel.mediaId, { from: blocked });
  await shop.settle();
  assert.equal((await shop.jobs(`kind = 'private_reply' AND status = 'held'`)).length, 1);
  await assertReason(shop, 'cap.per_media', capped.id);
  await assertReason(shop, 'optout', optedOut.id);
});

test('C-43: the owner can discard held jobs, cancelled.owner', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await pauseShop(shop);
  await world.switchLag();
  await shop.comment(reel.mediaId);
  await shop.settle();
  const out = await shop.call('/compliance/held-jobs/discard', 200, { method: 'POST', body: {} });
  assert.equal(out.discarded, 1);
  const [job] = await shop.jobs();
  assert.equal(job.status, 'cancelled');
  assert.equal(job.reason, 'cancelled.owner');
  await resumeShop(shop);
  await world.switchLag();
  await shop.settle();
  await assertNoDm(shop);
});

test('C-43: discarding by automation touches only that automation', async () => {
  const shop = await addShop(world);
  const one = await shop.automate();
  const two = await shop.automate();
  await pauseShop(shop);
  await world.switchLag();
  await shop.comment(one.mediaId);
  await shop.comment(two.mediaId);
  await shop.settle();
  assert.equal((await shop.call('/compliance/held-jobs/discard', 200, { method: 'POST', body: { automationId: one.id } })).discarded, 1);
  assert.equal((await shop.jobs(`status = 'held'`)).length, 1);
});

test('C-43: another business can\'t discard this one\'s held jobs by naming its automation', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const reel = await a.automate();
  await pauseShop(a);
  await world.switchLag();
  await a.comment(reel.mediaId);
  await a.settle();
  const out = await b.api('/compliance/held-jobs/discard', { method: 'POST', body: { automationId: reel.id } });
  assert.ok(out.status === 200 ? out.json().discarded === 0 : out.status === 404);
  assert.equal((await a.jobs(`status = 'held'`)).length, 1);
});

test('C-43: archiving an automation cancels its held jobs', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  await pauseShop(shop);
  await world.switchLag();
  await shop.comment(auto.mediaId);
  await shop.settle();
  await shop.call(`/automations/${auto.id}/state`, 200, { method: 'POST', body: { state: 'archived' } });
  await shop.settle();
  assert.equal((await shop.jobs())[0].status, 'cancelled');
});

test('C-43: an automation past its end date moves to Paused and cancels its held jobs', async () => {
  const shop = await addShop(world);
  const endsAt = new Date(Date.now() + HOUR).toISOString();
  const auto = await shop.automate({ schedule: { startsAt: null, endsAt, dailyStart: null, dailyEnd: null, outsideHours: 'hold' } });
  await pauseShop(shop);
  await world.switchLag();
  await shop.comment(auto.mediaId);
  await shop.settle();
  await world.travel(HOUR + OUTSIDE_MS);
  await shop.settle();
  assert.equal((await shop.call(`/automations/${auto.id}`, 200)).state, 'paused');
  assert.equal((await shop.jobs())[0].status, 'cancelled');
});

test('C-43: a billing or ops pause can\'t be lifted by the owner, and says so', async () => {
  const shop = await addShop(world);
  const operator = await consoleUser(world);
  need(await onConsole(world, operator, `/tenants/${shop.tenantId}/pause`, { method: 'POST', body: { reason: 'Unpaid invoice', billing: true } }), 200, 'Ops pause');
  const s = await status(shop);
  assert.equal(s.paused, true);
  assert.equal(s.canResume, false);
  const res = await shop.api('/compliance/resume', { method: 'POST' });
  assert.ok(res.status >= 400 && res.status < 500, `Got ${res.status}`);
  assert.match(res.json().error, /Paused by support\. Contact support\./);
  assert.equal((await status(shop)).paused, true);
});

test('C-43: pause and resume need a manager; staff are refused', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['automations'] });
  assert.equal((await shop.api('/compliance/pause', { method: 'POST', token: staff.token, body: {} })).status, 403);
  assert.equal((await status(shop)).paused, false);
});

test('C-43: resuming a business that isn\'t paused changes nothing', async () => {
  const shop = await addShop(world);
  const s = await resumeShop(shop);
  assert.equal(s.paused, false);
});

test('C-43: the storefront stays up during a pause unless pause store is chosen', async () => {
  const { hit } = await import('./support.js');
  const shop = await addShop(world);
  await pauseShop(shop);
  assert.equal((await hit(world, '/', { host: shop.host })).status, 200);
  await pauseShop(shop, { pauseStore: true });
  assert.notEqual((await hit(world, '/', { host: shop.host })).status, 200);
  assert.equal((await status(shop)).pauseStore, true);
});

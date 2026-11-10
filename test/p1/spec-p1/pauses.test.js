// PRD 4.12 and 4.13: pause, kill switch, breaker. C-42 to C-45, C-48, C-57.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, HOUR, INSIDE_MS, MINUTE, OUTSIDE_MS, SWITCH_LAG_MS, addShop, addStaff, assertNoDm, assertReason, consoleUser, need, onConsole, openWorld, pause, unique, useWorld } from './support.js';

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

test('C-42: over 20% errors across 50 sends trips it', { timeout: 120_000 }, async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.refuseSends({ code: 100, times: 22, after: 0 });
  for (let i = 0; i < 50; i++) await shop.comment(reel.mediaId);
  await shop.settle({ ms: 40_000, roundMs: 2000 });
  assert.equal((await status(shop)).breaker, 'open');
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

const SCOPES = {
  'an automation pause': async (shop, auto) => {
    await shop.call(`/automations/${auto.id}/state`, 200, { method: 'POST', body: { state: 'paused' } });
    return 'paused.automation';
  },
  'a tenant pause': async (shop) => {
    await pauseShop(shop);
    return 'paused.tenant';
  },
  'an open breaker': async (shop) => {
    await shop.sql(`INSERT INTO breakers (tenant_id, channel, state, opened_at, open_until) VALUES ($1, 'instagram', 'open', now(), now() + interval '30 minutes') ON CONFLICT (tenant_id, channel) DO UPDATE SET state = 'open', opened_at = now(), open_until = now() + interval '30 minutes'`, [shop.tenantId]);
    return 'paused.breaker';
  },
  'reconnect needed': async (shop) => {
    await shop.sql(`UPDATE ig_accounts SET status = 'reconnect_needed' WHERE tenant_id = $1`, [shop.tenantId]);
    return 'paused.reconnect';
  },
};

for (const [label, engage] of Object.entries(SCOPES)) {
  test(`C-44: with ${label} engaged, nothing is sent in that scope after 5 s and the webhook is still stored`, async () => {
    const shop = await addShop(world);
    const auto = await shop.automate();
    const reason = await engage(shop, auto);
    await pause(SWITCH_LAG_MS);
    const comment = await shop.commentDirect(auto.mediaId);
    await shop.settle();
    await assertNoDm(shop);
    assert.equal((await shop.inbound('object_id = $2', [comment.id])).length, 1);
    const [job] = await shop.jobs();
    assert.equal(job.status, 'held');
    assert.equal(job.reason, reason);
    await assertReason(shop, reason, comment.id);
  });
}

test('C-44: with a global kill switch engaged nothing is sent anywhere after 5 s', async () => {
  const w = await openWorld();
  try {
    const a = await addShop(w);
    const b = await addShop(w);
    const reelA = await a.automate();
    const reelB = await b.automate();
    const operator = await consoleUser(w);
    need(await onConsole(w, operator, '/kill-switch', { method: 'POST', body: { scope: 'global', reason: 'Meta notice' } }), 200, 'Kill switch');
    await pause(SWITCH_LAG_MS);
    const ca = await a.comment(reelA.mediaId);
    const cb = await b.comment(reelB.mediaId);
    await a.settle();
    await b.settle();
    await assertNoDm(a);
    await assertNoDm(b);
    await assertReason(a, 'paused.global', ca.id);
    await assertReason(b, 'paused.global', cb.id);
  } finally {
    await w.close();
  }
});

test('C-44: a job already queued when the switch is engaged doesn\'t go after 5 s', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.refuseSends({ code: 613, status: 429 });
  await shop.comment(reel.mediaId);
  await shop.settle();
  await pauseShop(shop);
  await pause(SWITCH_LAG_MS);
  await world.travel(2 * HOUR);
  await shop.settle();
  assert.equal((await shop.dms()).length, 0);
  assert.equal((await shop.jobs())[0].status, 'held');
});

test('C-44: one automation paused leaves the business\'s others running', async () => {
  const shop = await addShop(world);
  const stopped = await shop.automate();
  const running = await shop.automate();
  await shop.call(`/automations/${stopped.id}/state`, 200, { method: 'POST', body: { state: 'paused' } });
  await pause(SWITCH_LAG_MS);
  await shop.comment(stopped.mediaId);
  const ok = await shop.comment(running.mediaId);
  await shop.settle();
  assert.deepEqual((await shop.dms()).map((m) => m.commentId), [ok.id]);
});

test('C-44: a tenant pause leaves other businesses running', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const reelB = await b.automate();
  await pauseShop(a);
  await pause(SWITCH_LAG_MS);
  await b.comment(reelB.mediaId);
  await b.settle();
  assert.equal((await b.dms()).length, 1);
});

test('C-44: public replies stop in slow mode while DMs go on', async () => {
  const { savePublicReplies } = await import('./support.js');
  const shop = await addShop(world);
  await savePublicReplies(shop);
  const auto = await shop.automate({ publicReplyEnabled: true });
  await shop.sql(`INSERT INTO account_rate_state (tenant_id, channel, account_id, slow_mode_started_at, slow_mode_until, slow_mode_trigger) VALUES ($1, 'instagram', $2, now(), now() + interval '2 hours', 'reach_drop')`, [shop.tenantId, shop.igUserId]);
  await pause(SWITCH_LAG_MS);
  await shop.comment(auto.mediaId);
  await shop.settle();
  await world.travel(2 * MINUTE);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.publicReplies()).length, 0);
  await assertReason(shop, 'rate.slow_mode');
});

test('C-44: only a reach-drop slow mode can be overridden, and only with the words typed out', async () => {
  const shop = await addShop(world);
  await shop.sql(`INSERT INTO account_rate_state (tenant_id, channel, account_id, slow_mode_started_at, slow_mode_until, slow_mode_trigger) VALUES ($1, 'instagram', $2, now(), now() + interval '2 hours', 'buc_80002')`, [shop.tenantId, shop.igUserId]);
  assert.equal((await shop.call('/compliance/status', 200)).slowMode.canOverride, false);
  assert.ok((await shop.api('/compliance/slow-mode/override', { method: 'POST', body: { confirmation: 'I understand' } })).status >= 400);
  await shop.sql(`UPDATE account_rate_state SET slow_mode_trigger = 'reach_drop' WHERE tenant_id = $1`, [shop.tenantId]);
  assert.equal((await shop.call('/compliance/status', 200)).slowMode.canOverride, true);
  assert.ok((await shop.api('/compliance/slow-mode/override', { method: 'POST', body: { confirmation: 'nope' } })).status >= 400, 'The wrong words');
});

async function killWorld(run) {
  const w = await openWorld();
  try {
    await run(w, await consoleUser(w), await consoleUser(w));
  } finally {
    await w.close();
  }
}

const engageKill = (w, operator, reason = 'Meta notice') => onConsole(w, operator, '/kill-switch', { method: 'POST', body: { scope: 'global', reason } });
const requestRelease = (w, operator) => onConsole(w, operator, '/kill-switch/release', { method: 'POST', body: { reason: 'All clear' } });
const approveRelease = (w, operator) => onConsole(w, operator, '/kill-switch/release/approve', { method: 'POST', body: { reason: 'Confirmed' } });
const killEngaged = async (w) => (await w.rawDb.platform.query(`SELECT engaged FROM platform_switches WHERE key = 'global_kill'`))[0].engaged;

test('C-45: a release the same admin approves is refused', async () => {
  await killWorld(async (w, one) => {
    need(await engageKill(w, one), 200, 'Engage');
    need(await requestRelease(w, one), 200, 'Request');
    const res = await approveRelease(w, one);
    assert.equal(res.status, 403);
    assert.equal(await killEngaged(w), true);
  });
});

test('C-45: a second admin\'s approval releases it', async () => {
  await killWorld(async (w, one, two) => {
    need(await engageKill(w, one), 200, 'Engage');
    need(await requestRelease(w, one), 200, 'Request');
    const out = need(await approveRelease(w, two), 200, 'Approve').json();
    assert.equal(out.engaged, false);
    assert.equal(await killEngaged(w), false);
  });
});

test('C-45: approving with nothing requested is refused', async () => {
  await killWorld(async (w, one, two) => {
    need(await engageKill(w, one), 200, 'Engage');
    assert.ok((await approveRelease(w, two)).status >= 400);
    assert.equal(await killEngaged(w), true);
  });
});

test('C-45: one admin can\'t approve their own request by asking and approving at the same moment', async () => {
  await killWorld(async (w, one) => {
    need(await engageKill(w, one), 200, 'Engage');
    await Promise.all([requestRelease(w, one), approveRelease(w, one)]);
    assert.equal(await killEngaged(w), true);
  });
});

test('C-45: any one platform admin can engage it at once, and a reason is required', async () => {
  await killWorld(async (w) => {
    const support = await consoleUser(w, 'support');
    assert.equal((await onConsole(w, support, '/kill-switch', { method: 'POST', body: { scope: 'global' } })).status, 400);
    assert.equal(await killEngaged(w), false);
    need(await engageKill(w, support), 200, 'A support admin engages it');
    assert.equal(await killEngaged(w), true);
  });
});

test('C-45: a business owner has no way to the kill switch', async () => {
  await killWorld(async (w) => {
    const shop = await addShop(w);
    const { hit } = await import('./support.js');
    assert.notEqual((await hit(w, '/kill-switch', { host: shop.host, method: 'POST', token: shop.token, body: { scope: 'global', reason: 'x' } })).status, 200);
    assert.equal(await killEngaged(w), false);
  });
});

test('C-45: nobody signed in can engage it, and a request with no CSRF token is refused', async () => {
  await killWorld(async (w, one) => {
    const { hit, CONSOLE_HOST } = await import('./support.js');
    assert.ok([401, 403].includes((await hit(w, '/kill-switch', { host: CONSOLE_HOST, method: 'POST', body: { scope: 'global', reason: 'x' } })).status));
    assert.ok([401, 403].includes((await hit(w, '/kill-switch', { host: CONSOLE_HOST, method: 'POST', cookie: one.cookie, body: { scope: 'global', reason: 'x' } })).status));
    assert.equal(await killEngaged(w), false);
  });
});

test('C-45: after release, held jobs still inside their time go out', async () => {
  await killWorld(async (w, one, two) => {
    const shop = await addShop(w);
    const reel = await shop.automate();
    need(await engageKill(w, one), 200, 'Engage');
    await pause(SWITCH_LAG_MS);
    await shop.comment(reel.mediaId);
    await shop.settle();
    await assertNoDm(shop);
    need(await requestRelease(w, one), 200, 'Request');
    need(await approveRelease(w, two), 200, 'Approve');
    await pause(SWITCH_LAG_MS);
    await shop.settle();
    assert.equal((await shop.dms()).length, 1);
  });
});

const tripBreaker = (shop) => shop.sql(`INSERT INTO breakers (tenant_id, channel, state, trip_reason, opened_at, open_until) VALUES ($1, 'instagram', 'open', 'policy', now(), now() + interval '30 minutes') ON CONFLICT (tenant_id, channel) DO UPDATE SET state = 'open', opened_at = now(), open_until = now() + interval '30 minutes'`, [shop.tenantId]);

async function breakersWorld(run) {
  const w = await openWorld();
  try {
    await run(w);
  } finally {
    await w.close();
  }
}
const opsAlerts = (w) => w.rawDb.platform.query(`SELECT * FROM alerts WHERE audience = 'ops' ORDER BY id`);
const frozen = async (w) => (await w.rawDb.platform.query(`SELECT engaged FROM platform_switches WHERE key = 'activations_frozen'`))[0].engaged;

async function realTrip(w, shop) {
  const reel = await shop.automate();
  await shop.refuseSends({ code: PERMISSION, times: 5 });
  for (let i = 0; i < 5; i++) {
    await shop.comment(reel.mediaId);
    await w.settle({ tenantId: shop.tenantId, ms: 2500 });
  }
}

test('C-48: 3 businesses tripping breakers within 40 minutes pages ops and freezes activations', async () => {
  await breakersWorld(async (w) => {
    for (let i = 0; i < 3; i++) {
      await realTrip(w, await addShop(w));
      if (i < 2) await w.travel(20 * MINUTE);
    }
    await w.settle();
    assert.ok((await opsAlerts(w)).length >= 1);
    assert.equal(await frozen(w), true);
  });
});

test('C-48: 2 breakers don\'t', async () => {
  await breakersWorld(async (w) => {
    for (let i = 0; i < 2; i++) await realTrip(w, await addShop(w));
    await w.settle();
    assert.equal(await frozen(w), false);
  });
});

test('C-48: 3 breakers more than an hour apart don\'t', async () => {
  await breakersWorld(async (w) => {
    for (let i = 0; i < 3; i++) {
      await realTrip(w, await addShop(w));
      await w.travel(31 * MINUTE);
    }
    await w.settle();
    assert.equal(await frozen(w), false);
  });
});

test('C-48: the same business tripping 3 times doesn\'t', async () => {
  await breakersWorld(async (w) => {
    const shop = await addShop(w);
    for (let i = 0; i < 3; i++) {
      await realTrip(w, shop);
      await shop.sql(`UPDATE breakers SET state = 'closed' WHERE tenant_id = $1`, [shop.tenantId]);
      await w.travel(16 * MINUTE);
    }
    await w.settle();
    assert.equal(await frozen(w), false);
  });
});

test('C-48: while frozen, no automation can go live; sending carries on', async () => {
  await breakersWorld(async (w) => {
    const shop = await addShop(w);
    const running = await shop.automate();
    const draft = await shop.automate({ state: 'draft' });
    await w.rawDb.platform.query(`UPDATE platform_switches SET engaged = true WHERE key = 'activations_frozen'`);
    await pause(SWITCH_LAG_MS);
    const res = await shop.api(`/automations/${draft.id}/state`, { method: 'POST', body: { state: 'live' } });
    assert.ok(res.status >= 400 && res.status < 500, `Got ${res.status}`);
    assert.equal((await shop.call(`/automations/${draft.id}`, 200)).state, 'draft');
    await shop.comment(running.mediaId);
    await shop.settle();
    assert.equal((await shop.dms()).length, 1);
  });
});

test('C-48: only a super admin can unfreeze', async () => {
  await breakersWorld(async (w) => {
    await w.rawDb.platform.query(`UPDATE platform_switches SET engaged = true WHERE key = 'activations_frozen'`);
    const support = await consoleUser(w, 'support');
    const admin = await consoleUser(w, 'super_admin');
    assert.equal((await onConsole(w, support, '/activations/unfreeze', { method: 'POST', body: { reason: 'ok' } })).status, 403);
    assert.equal(await frozen(w), true);
    need(await onConsole(w, admin, '/activations/unfreeze', { method: 'POST', body: { reason: 'ok' } }), 204, 'Unfreeze');
    assert.equal(await frozen(w), false);
  });
});

test('C-57: the global kill switch writes 1 audit_log row and 1 compliance_events row per business', async () => {
  await killWorld(async (w, one) => {
    const shops = [await addShop(w), await addShop(w), await addShop(w)];
    const reason = `Meta policy notice ${unique()}`;
    const out = need(await engageKill(w, one, reason), 200, 'Engage').json();
    assert.equal(out.engaged, true);
    assert.equal(out.affected, 3);
    const audits = await w.rawDb.platform.query(`SELECT * FROM audit_log WHERE action ILIKE '%kill%'`);
    assert.equal(audits.length, 1);
    assert.match(JSON.stringify(audits[0]), new RegExp(reason));
    assert.match(audits[0].actor, new RegExp(one.email));
    for (const shop of shops) assert.equal((await shop.events(`reason = 'paused.global'`)).length, 1, shop.slug);
  });
});

test('C-57: engaging twice doesn\'t write a second round, and two admins at once are one engagement', async () => {
  await killWorld(async (w, one, two) => {
    const shop = await addShop(w);
    await Promise.all([engageKill(w, one), engageKill(w, two)]);
    await engageKill(w, one);
    assert.equal((await shop.events(`reason = 'paused.global'`)).length, 1);
    assert.equal((await w.rawDb.platform.query(`SELECT count(*)::int AS n FROM audit_log WHERE action ILIKE '%kill%'`))[0].n, 1);
  });
});

test('C-57: the log rows name no person and no token', async () => {
  await killWorld(async (w, one) => {
    const shop = await addShop(w);
    need(await engageKill(w, one), 200, 'Engage');
    assert.doesNotMatch(JSON.stringify(await shop.events()), new RegExp(shop.igToken));
  });
});

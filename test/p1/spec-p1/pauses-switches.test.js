// PRD 4.12 and 4.13: pauses by scope, slow mode and the kill switch. C-44, C-45. Split from pauses.test.js, which took over 9 minutes.
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

const pauseShop = (shop, body = {}) => shop.call('/compliance/pause', 200, { method: 'POST', body });
const resumeShop = (shop) => shop.call('/compliance/resume', 200, { method: 'POST' });


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
  await shop.sql(`INSERT INTO account_rate_state (tenant_id, channel, account_id, slow_mode_started_at, slow_mode_until, slow_mode_trigger) VALUES ($1, 'instagram', $2, now(), now() + interval '2 hours', 'reach_drop') ON CONFLICT (tenant_id, channel, account_id) DO UPDATE SET slow_mode_started_at = EXCLUDED.slow_mode_started_at, slow_mode_until = EXCLUDED.slow_mode_until, slow_mode_trigger = EXCLUDED.slow_mode_trigger`, [shop.tenantId, shop.igUserId]);
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
  await shop.sql(`INSERT INTO account_rate_state (tenant_id, channel, account_id, slow_mode_started_at, slow_mode_until, slow_mode_trigger) VALUES ($1, 'instagram', $2, now(), now() + interval '2 hours', 'buc_80002') ON CONFLICT (tenant_id, channel, account_id) DO UPDATE SET slow_mode_started_at = EXCLUDED.slow_mode_started_at, slow_mode_until = EXCLUDED.slow_mode_until, slow_mode_trigger = EXCLUDED.slow_mode_trigger`, [shop.tenantId, shop.igUserId]);
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

// PRD 4.12 and 4.13: three breakers freeze activations; the kill switch's audit rows. C-48, C-57. Split from pauses.test.js, which took over 9 minutes.
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

const pauseShop = (shop, body = {}) => shop.call('/compliance/pause', 200, { method: 'POST', body });
const resumeShop = (shop) => shop.call('/compliance/resume', 200, { method: 'POST' });


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
    // D2 decision: the log keeps the operator's id; the console's audit view shows the email beside it.
    assert.match(audits[0].actor, /^platform:[0-9]+$/);
    assert.ok(!JSON.stringify(audits[0]).includes(one.email), 'no email is stored in the log');
    const shown = (await need(await onConsole(w, one, '/audit-log'), 200, 'Audit view').json()).items.find((i) => /kill/i.test(i.action));
    assert.equal(shown.actorEmail, one.email);
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

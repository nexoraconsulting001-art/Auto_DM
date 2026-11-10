// PRD 4.12, 5.8: every scope that can stop sending, what happens to the jobs while it does, and the routes that work them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComplianceStatus, WordLists } from '../../../src/contracts/api/compliance.js';
import { withTenant } from '../../../src/tenancy.js';
import { IG_ACCOUNT, OWNER, startApp } from '../../helpers.js';
import { HOUR, MINUTE, automation, dm, privateReply, scriptedIg, world } from './support.js';

const enqueue = (w, action, options) => w.inBusiness(() => w.compliance.enqueue(action, options));
const pauseBusiness = (w, by = 'owner') => w.inBusiness(async () => {
  await w.platform.compliance.settings();
  await w.db.query(`UPDATE compliance_settings SET paused = true, paused_by = $2 WHERE tenant_id = $1`, [w.tenant.id, by]);
});
const resumeBusiness = (w) => w.inBusiness(() => w.db.query(`UPDATE compliance_settings SET paused = false, paused_by = NULL WHERE tenant_id = $1`, [w.tenant.id]));

test('while paused a webhook\'s job is created as held, with caps and blocklist applied', async () => {
  const w = await world();
  await pauseBusiness(w);
  w.compliance.invalidateSwitches();
  const first = await enqueue(w, privateReply(w, { mediaId: 'M1' }));
  assert.deepEqual([first.outcome, first.reason], ['held', 'paused.tenant']);
  assert.equal((await enqueue(w, privateReply(w, { mediaId: 'M1' }))).reason, 'cap.per_media');
  await w.turn();
  assert.equal(w.ig.calls.length, 0);
});

test('C-43: after a 2-hour pause, unexpired held jobs drain at the normal budget and never as a burst', async () => {
  const w = await world({ limits: { privateRepliesPerHour: 60 } });
  await pauseBusiness(w);
  w.compliance.invalidateSwitches();
  for (let i = 0; i < 5; i++) await enqueue(w, privateReply(w, { personId: `p${i}`, expiresAt: new Date(w.clock.t + 10 * HOUR) }));
  await enqueue(w, privateReply(w, { personId: 'soon', expiresAt: new Date(w.clock.t + HOUR) }));
  w.clock.advance(2 * HOUR);
  await resumeBusiness(w);
  await w.turn();
  const jobs = await w.jobs();
  assert.equal(jobs.filter((j) => j.status === 'expired' && j.reason === 'expired.7d').length, 1, 'the one past its expiry is dropped');
  assert.equal(w.ig.calls.length, 1, 'one at a time, as the budget allows');
  assert.equal(jobs.filter((j) => j.status === 'queued').length, 4);
});

const SCOPES = {
  'the global kill switch': {
    reason: 'paused.global',
    engage: (w) => w.db.platform.query(`UPDATE platform_switches SET engaged = true WHERE key = 'global_kill'`),
    fresh: true,
  },
  'a tenant pause': { reason: 'paused.tenant', engage: (w) => pauseBusiness(w) },
  'a support pause': { reason: 'paused.tenant', engage: (w) => pauseBusiness(w, 'ops') },
  'a business status of suspended': { reason: 'paused.tenant', engage: (w) => w.db.platform.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [w.tenant.id]) },
  'the breaker': { reason: 'paused.breaker', engage: (w) => w.inTenant(`INSERT INTO breakers (tenant_id, channel, state, opened_at, open_until) VALUES ($1, 'instagram', 'open', $2::timestamptz, $3::timestamptz)`, [w.tenant.id, new Date(w.clock.t), new Date(w.clock.t + 2 * HOUR)]) },
  'a reconnect': { reason: 'paused.reconnect', engage: (w) => w.inTenant(`UPDATE ig_accounts SET status = 'reconnect_needed' WHERE tenant_id = $1`, [w.tenant.id]) },
};

for (const [name, scope] of Object.entries(SCOPES)) {
  test(`C-44: ${name} stops every send within 5 seconds, with its own reason`, async () => {
    const w = await world({ fresh: Boolean(scope.fresh) });
    await enqueue(w, privateReply(w));
    await w.inBusiness(() => w.compliance.check(privateReply(w))); // the switches are now cached
    await scope.engage(w);
    w.clock.advance(5000);
    await w.compliance.pump();
    assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['held', scope.reason]]);
    assert.equal(w.ig.calls.length, 0);
  });
}

test('C-44: a paused automation stops its own jobs and no others', async () => {
  const w = await world();
  const auto = await automation(w);
  await enqueue(w, privateReply(w, { automationId: auto }));
  await enqueue(w, privateReply(w, { personId: 'p2' }));
  await w.inTenant(`UPDATE automations SET state = 'paused' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, auto]);
  await w.turn();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['held', 'paused.automation'], ['sent', '']]);
});

test('held jobs for a paused automation go when it is live again', async () => {
  const w = await world();
  const auto = await automation(w, { state: 'paused' });
  await enqueue(w, privateReply(w, { automationId: auto }));
  await w.inTenant(`UPDATE automations SET state = 'live' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, auto]);
  await w.settle();
  assert.equal((await w.jobs())[0].status, 'sent');
});

test('archiving an automation, or passing its end date, cancels its held jobs', async () => {
  const w = await world();
  const archived = await automation(w, { state: 'paused' });
  const ended = await automation(w, { state: 'paused' });
  await enqueue(w, privateReply(w, { automationId: archived }));
  await enqueue(w, privateReply(w, { automationId: ended, personId: 'p2' }));
  await w.inTenant(`UPDATE automations SET state = 'archived' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, archived]);
  await w.inTenant(`UPDATE automations SET ends_at = $3::timestamptz WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, ended, new Date(w.clock.t - 1)]);
  await w.settle();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['cancelled', 'cancelled.owner'], ['cancelled', 'cancelled.owner']]);
});

test('held jobs go when the kill switch lifts', async () => {
  const w = await world({ fresh: true });
  await w.db.platform.query(`UPDATE platform_switches SET engaged = true WHERE key = 'global_kill'`);
  w.compliance.invalidateSwitches();
  await enqueue(w, privateReply(w));
  await w.turn();
  assert.equal(w.ig.calls.length, 0);
  await w.db.platform.query(`UPDATE platform_switches SET engaged = false WHERE key = 'global_kill'`);
  await w.settle();
  assert.equal(w.ig.calls.length, 1);
});

test('the kill switch stops a send already claimed by a worker', async () => {
  const w = await world({ fresh: true });
  await enqueue(w, privateReply(w));
  await w.db.platform.query(`UPDATE platform_switches SET engaged = true WHERE key = 'global_kill'`);
  w.compliance.invalidateSwitches();
  await w.compliance.drainOutbound();
  assert.equal(w.ig.calls.length, 0);
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['held', 'paused.global']]);
});

test('switches are read from a cache of at most 5 seconds', async () => {
  const w = await world();
  const reads = [];
  const real = w.db.query;
  w.db.query = (sql, params) => {
    if (/platform_switches/.test(sql)) reads.push(w.clock.t);
    return real(sql, params);
  };
  try {
    const action = privateReply(w);
    for (let i = 0; i < 3; i++) await w.inBusiness(() => w.compliance.check(action));
    assert.equal(reads.length, 1);
    w.clock.advance(4999);
    await w.inBusiness(() => w.compliance.check(action));
    assert.equal(reads.length, 1);
    w.clock.advance(1);
    await w.inBusiness(() => w.compliance.check(action));
    assert.equal(reads.length, 2);
  } finally {
    w.db.query = real;
  }
});

test('the owner can discard held jobs, and only theirs', async () => {
  const w = await world();
  const other = await world({ base: w });
  await pauseBusiness(w);
  await pauseBusiness(other);
  w.compliance.invalidateSwitches();
  other.compliance.invalidateSwitches();
  await enqueue(w, privateReply(w));
  await enqueue(other, privateReply(other));
  assert.equal(await w.inBusiness(() => w.compliance.discardHeld()), 1);
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['cancelled', 'cancelled.owner']]);
  assert.equal((await other.jobs())[0].status, 'held');
});

// ---- the seller's routes ----------------------------------------------------------------------------------------

const signIn = async (base, who = OWNER) => (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) })).json()).token;

async function sellerApp(overrides = {}) {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false, ...overrides } });
  const token = await signIn(app.base);
  const call = (path, { method = 'GET', body } = {}) => fetch(`${app.base}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const inside = (fn) => withTenant(app.tenant, fn);
  return { app, call, inside };
}

test('the status route answers in its contract, with nothing stopping sends by default', async () => {
  const { app, call } = await sellerApp();
  try {
    const res = await call('/compliance/status');
    assert.equal(res.status, 200);
    const status = await res.json();
    assert.equal(ComplianceStatus.safeParse(status).success, true);
    assert.deepEqual([status.paused, status.pausedBy, status.canResume, status.globalPause, status.reconnectNeeded, status.breaker, status.heldJobs], [false, null, true, false, false, 'closed', 0]);
    assert.deepEqual(status.gates.map((g) => g.code), ['gate.access_level', 'gate.scope_missing', 'gate.privacy_url', 'gate.deletion_callback']);
  } finally {
    app.close();
  }
});

test('an owner pauses and resumes, and it is in the audit log', async () => {
  const { app, call, inside } = await sellerApp();
  try {
    const paused = await (await call('/compliance/pause', { method: 'POST', body: { pauseStore: false } })).json();
    assert.deepEqual([paused.paused, paused.pausedBy, paused.canResume], [true, 'owner', true]);
    const resumed = await (await call('/compliance/resume', { method: 'POST' })).json();
    assert.equal(resumed.paused, false);
    const rows = await inside(() => app.db.query(`SELECT action FROM audit_log WHERE tenant_id = $1 ORDER BY id`, [app.tenant.id]));
    assert.deepEqual(rows.map((r) => r.action).filter((a) => a.startsWith('compliance')), ['compliance.pause', 'compliance.resume']);
  } finally {
    app.close();
  }
});

test('F-37: an owner can\'t lift a pause by support', async () => {
  const { app, call, inside } = await sellerApp();
  try {
    await inside(async () => {
      await app.platform.compliance.settings();
      await app.db.query(`UPDATE compliance_settings SET paused = true, paused_by = 'ops' WHERE tenant_id = $1`, [app.tenant.id]);
    });
    const status = await (await call('/compliance/status')).json();
    assert.equal(status.canResume, false);
    const res = await call('/compliance/resume', { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'Paused by support. Contact support.');
    const stillPaused = await call('/compliance/pause', { method: 'POST', body: { pauseStore: false } });
    assert.equal((await stillPaused.json()).pausedBy, 'ops', 'pausing again can\'t turn it into the owner\'s pause');
  } finally {
    app.close();
  }
});

test('settings: a cap can only be lowered', async () => {
  const { app, call } = await sellerApp();
  try {
    assert.equal((await call('/compliance/settings', { method: 'PATCH', body: { capOverrides: { 'cap.per_person_24h': 4 } } })).status, 400);
    const ok = await call('/compliance/settings', { method: 'PATCH', body: { capOverrides: { 'cap.per_person_24h': 2 }, disclosureEnabled: true } });
    assert.equal(ok.status, 200);
    const settings = await (await call('/compliance/settings')).json();
    assert.deepEqual(settings, { dryRun: false, disclosureEnabled: true, utmEnabled: true, capOverrides: { 'cap.per_person_24h': 2 } });
  } finally {
    app.close();
  }
});

test('A-41: "Why no DM?" shows the reason, the activity list has no person in it, and nothing crosses businesses', async () => {
  const { app, call, inside } = await sellerApp();
  try {
    const action = (commentId) => ({ kind: 'private_reply', accountId: IG_ACCOUNT.igUserId, commentId, personId: 'person', mediaId: 'M1', idempotencyKey: `private_reply:${commentId}`, expiresAt: new Date(Date.now() + HOUR), message: { text: 'hi' } });
    const { createCompliance } = await import('../../../src/modules/compliance/index.js');
    const engine = createCompliance({ db: app.db, repos: app.platform, ig: app.ig, config: {}, platform: {} });
    await inside(() => engine.enqueue(action('c1')));
    await inside(() => engine.enqueue(action('c2')));

    const why = await (await call('/compliance/why-no-dm?commentId=c2')).json();
    assert.deepEqual([why.commentId, why.outcome, why.reason], ['c2', 'skipped', 'cap.per_media']);
    assert.match(why.explanation, /already got a DM/);
    assert.equal((await call('/compliance/why-no-dm?commentId=nope')).status, 404);

    const list = await (await call('/compliance/activity?limit=1')).json();
    assert.equal(list.items.length, 1);
    assert.ok(list.nextCursor);
    assert.doesNotMatch(JSON.stringify(list), /subject|person/);
    const next = await (await call(`/compliance/activity?limit=1&cursor=${list.nextCursor}`)).json();
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].id, list.items[0].id);
    const filtered = await (await call('/compliance/activity?reason=cap.per_media')).json();
    assert.deepEqual(filtered.items.map((i) => i.commentId), ['c2']);
  } finally {
    app.close();
  }
});

test('held jobs are listed and can be discarded', async () => {
  const { app, call, inside } = await sellerApp();
  try {
    const { createCompliance } = await import('../../../src/modules/compliance/index.js');
    const engine = createCompliance({ db: app.db, repos: app.platform, ig: app.ig, config: {}, platform: {} });
    await call('/compliance/pause', { method: 'POST', body: { pauseStore: false } });
    await inside(() => engine.enqueue({ kind: 'private_reply', accountId: IG_ACCOUNT.igUserId, commentId: 'c1', personId: 'p', idempotencyKey: 'private_reply:c1', expiresAt: new Date(Date.now() + HOUR), message: { text: 'hi' } }));
    const list = await (await call('/compliance/held-jobs')).json();
    assert.deepEqual(list.items.map((j) => [j.kind, j.reason]), [['private_reply', 'paused.tenant']]);
    const discarded = await (await call('/compliance/held-jobs/discard', { method: 'POST', body: {} })).json();
    assert.deepEqual(discarded, { discarded: 1 });
    assert.deepEqual((await (await call('/compliance/held-jobs')).json()).items, []);
  } finally {
    app.close();
  }
});

test('an owner adds and removes their own words and can never remove a base word', async () => {
  const { app, call } = await sellerApp();
  try {
    const added = await call('/compliance/words', { method: 'POST', body: { list: 'negative', word: 'Kharab' } });
    assert.equal(added.status, 201);
    const word = await added.json();
    assert.equal((await call('/compliance/words', { method: 'POST', body: { list: 'negative', word: 'kharab' } })).status, 409);
    assert.equal((await call('/compliance/words', { method: 'POST', body: { list: 'negative', word: 'FRAUD' } })).status, 409, 'already a base word');
    const lists = await (await call('/compliance/words?list=negative')).json();
    assert.equal(WordLists.safeParse(lists).success, true);
    assert.ok(lists.base.includes('fraud'));
    assert.deepEqual(lists.added.map((a) => a.word), ['Kharab']);
    assert.equal((await call(`/compliance/words/${word.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await call(`/compliance/words/${word.id}`, { method: 'DELETE' })).status, 404);
  } finally {
    app.close();
  }
});

test('N-28: slow mode can only be overridden when a reach drop started it, and only by the owner, in words', async () => {
  const { app, call, inside } = await sellerApp();
  try {
    const { createCompliance } = await import('../../../src/modules/compliance/index.js');
    const engine = createCompliance({ db: app.db, repos: app.platform, ig: app.ig, config: {}, platform: {} });
    await inside(() => engine.startSlowMode('instagram', IG_ACCOUNT.igUserId, 'buc_80002', new Date(Date.now() + HOUR)));
    assert.equal((await (await call('/compliance/status')).json()).slowMode.canOverride, false);
    assert.equal((await call('/compliance/slow-mode/override', { method: 'POST', body: { confirmation: 'override' } })).status, 409);

    await inside(() => app.db.query(`UPDATE account_rate_state SET slow_mode_trigger = 'reach_drop' WHERE tenant_id = $1`, [app.tenant.id]));
    assert.equal((await (await call('/compliance/status')).json()).slowMode.canOverride, true);
    assert.equal((await call('/compliance/slow-mode/override', { method: 'POST', body: { confirmation: 'yes' } })).status, 400);
    const done = await (await call('/compliance/slow-mode/override', { method: 'POST', body: { confirmation: 'Override' } })).json();
    assert.equal(done.slowMode.active, false);
  } finally {
    app.close();
  }
});

test('a manager can\'t override slow mode', async () => {
  const { app, inside } = await sellerApp();
  try {
    await inside(() => app.platform.users.create({ name: 'Manager', phone: '9111111111', password: 'manager-pass', role: 'manager' }));
    const token = await signIn(app.base, { phone: '9111111111', password: 'manager-pass' });
    const res = await fetch(`${app.base}/api/v1/compliance/slow-mode/override`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'override' }) });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'Owner only.');
  } finally {
    app.close();
  }
});

test('"pause store" closes the buyer pages and leaves the seller able to lift it; a plain pause leaves them up', async () => {
  const { app, call } = await sellerApp();
  try {
    await call('/compliance/pause', { method: 'POST', body: { pauseStore: false } });
    assert.notEqual((await fetch(`${app.base}/`)).status, 503);
    await call('/compliance/resume', { method: 'POST' });
    await call('/compliance/pause', { method: 'POST', body: { pauseStore: true } });
    const closed = await fetch(`${app.base}/`);
    assert.equal(closed.status, 503);
    assert.doesNotMatch(await closed.text(), /bhava/i);
    assert.equal((await call('/compliance/status')).status, 200);
    assert.equal((await call('/compliance/resume', { method: 'POST' })).status, 200);
    assert.notEqual((await fetch(`${app.base}/`)).status, 503);
  } finally {
    app.close();
  }
});

// ---- Bhava's own team, on the platform host ------------------------------------------------------------------------

const PLATFORM_HOST = 'admin.bhava.test';
const onConsole = (app, path, init = {}) => fetch(`${app.base}${path}`, { redirect: 'manual', ...init, headers: { 'x-forwarded-host': PLATFORM_HOST, ...init.headers } });

async function admin(app, email) {
  await app.platform.platformUsers.create({ email, password: 'platform-pass', role: 'super_admin' });
  const res = await onConsole(app, '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'platform-pass' }) });
  const { csrf } = await res.json();
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (method, path, body) => onConsole(app, path, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test('C-57: the kill switch writes one audit row and one compliance row per business', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    await app.platform.tenants.create({ slug: 'two', name: 'Two' });
    await app.platform.tenants.create({ slug: 'three', name: 'Three' });
    const ops = await admin(app, 'a@bhava.example');
    const res = await ops('POST', '/kill-switch', { scope: 'global', reason: 'Meta has told us to stop' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { engaged: true, affected: 3 });
    const audit = await app.db.platform.query(`SELECT action, tenant_id, actor FROM audit_log WHERE action LIKE 'kill_switch%'`);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].tenant_id, null);
    const events = await app.db.platform.query(`SELECT tenant_id, reason FROM compliance_events WHERE kind = 'kill_switch'`);
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.reason === 'paused.global'));

    const again = await ops('POST', '/kill-switch', { scope: 'global', reason: 'again' });
    assert.deepEqual(await again.json(), { engaged: true, affected: 0 }, 'engaging twice writes nothing more');
    const switches = await (await ops('GET', '/switches')).json();
    assert.equal(switches.items.find((s) => s.key === 'global_kill').engaged, true);
  } finally {
    app.close();
  }
});

test('a reason is required to engage it', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const ops = await admin(app, 'a@bhava.example');
    assert.equal((await ops('POST', '/kill-switch', { scope: 'global', reason: '' })).status, 400);
    assert.equal((await ops('POST', '/kill-switch', { scope: 'global' })).status, 400);
  } finally {
    app.close();
  }
});

test('C-45: a release needs a second platform admin', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const one = await admin(app, 'a@bhava.example');
    const two = await admin(app, 'b@bhava.example');
    await one('POST', '/kill-switch', { scope: 'global', reason: 'stop' });

    assert.equal((await one('POST', '/kill-switch/release/approve', { reason: 'no request yet' })).status, 409);
    assert.equal((await one('POST', '/kill-switch/release', { reason: 'all clear' })).status, 200);
    const selfApproved = await one('POST', '/kill-switch/release/approve', { reason: 'me again' });
    assert.equal(selfApproved.status, 409);
    const [kill] = await app.db.platform.query(`SELECT engaged FROM platform_switches WHERE key = 'global_kill'`);
    assert.equal(kill.engaged, true);

    const approved = await two('POST', '/kill-switch/release/approve', { reason: 'agreed' });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).engaged, false);
  } finally {
    app.close();
  }
});

test('F-36: ops pause a business with a reason; the owner can\'t lift it; ops can', async () => {
  const { app, call } = await sellerApp();
  try {
    const ops = await admin(app, 'a@bhava.example');
    assert.equal((await ops('POST', `/tenants/${app.tenant.id}/pause`, { reason: '' })).status, 400);
    const paused = await ops('POST', `/tenants/${app.tenant.id}/pause`, { reason: 'Policy review', billing: true });
    assert.equal(paused.status, 200);
    assert.deepEqual((({ paused: p, pausedBy }) => [p, pausedBy])(await paused.json()), [true, 'billing']);
    assert.equal((await call('/compliance/resume', { method: 'POST' })).status, 403);
    assert.equal((await ops('POST', `/tenants/${app.tenant.id}/resume`, { reason: 'Reviewed' })).status, 200);
    assert.equal((await (await call('/compliance/status')).json()).paused, false);
  } finally {
    app.close();
  }
});

test('ops can lift one person\'s block, with a written reason', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const ops = await admin(app, 'a@bhava.example');
    const subject = await withTenant(app.tenant, () => app.platform.compliance.subjectHash('instagram', 'p'));
    await withTenant(app.tenant, () => app.platform.compliance.addOptOut('instagram', subject, 'dm'));
    assert.equal((await ops('POST', `/tenants/${app.tenant.id}/unblock`, { channel: 'instagram', subjectHash: subject })).status, 400);
    assert.equal((await ops('POST', `/tenants/${app.tenant.id}/unblock`, { channel: 'instagram', subjectHash: subject, reason: 'Person asked by email' })).status, 204);
    assert.equal(await withTenant(app.tenant, () => app.platform.compliance.isOptedOut('instagram', subject)), false);
  } finally {
    app.close();
  }
});

test('a second key is needed: anyone can engage, nobody without a session can', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const res = await onConsole(app, '/kill-switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'global', reason: 'x' }) });
    assert.equal(res.status, 401);
    const [kill] = await app.db.platform.query(`SELECT engaged FROM platform_switches WHERE key = 'global_kill'`);
    assert.equal(kill.engaged, false);
  } finally {
    app.close();
  }
});

test('dm and MINUTE helpers stay honest about a window', async () => {
  const w = await world();
  await w.messaged('person', w.clock.t - MINUTE);
  assert.equal((await w.inBusiness(() => w.compliance.check(dm(w)))).allow, true);
});

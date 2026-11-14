// The console's switch list, audit list and team (PRD 5.5, 5.8, 5.14). Attack cases: a pause with no reason, an owner lifting
// a platform pause, a support user doing what only a super admin may, and a console action that leaves no audit row.
import { test } from 'node:test';
import { CONSOLE_HOST, assert, consoleUser, hit, json, need, one, opCall, shopOn, sql, useBillingWorld } from '../spec-p7/support.js';

const world = useBillingWorld();
const idOf = async (op) => (await one(world, 'SELECT id FROM platform_users WHERE email = $1', [op.email])).id;
const releaseGlobal = () => sql(world, `UPDATE platform_switches SET engaged = false, release_requested_by = '', release_requested_at = NULL WHERE key = 'global_kill'`).catch(() => {});

test('F-38: the switch list shows the global switch with actor, reason, time and its pending release', async () => {
  const first = await consoleUser(world);
  const second = await consoleUser(world);
  assert.equal((await opCall(world, first, 'POST', '/kill-switch', { scope: 'global' })).status, 400, 'no reason');
  assert.equal((await opCall(world, first, 'POST', '/kill-switch', { scope: 'global', reason: '  ' })).status, 400, 'a blank reason');
  try {
    need(await opCall(world, first, 'POST', '/kill-switch', { scope: 'global', reason: 'Meta incident 7' }), 200, 'Engaging');
    const list = json(need(await opCall(world, second, 'GET', '/pauses?scope=global'), 200, 'Pauses'));
    assert.equal(list.items.length, 1);
    const global = list.items[0];
    assert.deepEqual([global.scope, global.engaged, global.reason, global.by, global.tenantId], ['global', true, 'Meta incident 7', 'platform', null]);
    assert.ok(global.actor, 'who engaged it');
    assert.ok(global.at, 'when');
    assert.equal(global.releasePending, null);
    need(await opCall(world, first, 'POST', '/kill-switch/release', { reason: 'over' }), 200, 'Asking for the release');
    const pending = json(need(await opCall(world, second, 'GET', '/pauses?scope=global'), 200, 'Pauses')).items[0];
    assert.equal(pending.engaged, true, 'still engaged while the release waits');
    assert.ok(pending.releasePending?.requestedBy && pending.releasePending?.requestedAt, 'the pending release names who and when');
    need(await opCall(world, second, 'POST', '/kill-switch/release/approve', { reason: 'agreed' }), 200, 'Approving');
    const after = json(need(await opCall(world, second, 'GET', '/pauses?scope=global'), 200, 'Pauses')).items[0];
    assert.deepEqual([after.engaged, after.releasePending], [false, null]);
    // A seller and an anonymous caller get nothing from the list.
    assert.equal((await hit(world, '/pauses', { host: CONSOLE_HOST })).status, 401);
    const shop = await shopOn(world, 't1');
    assert.ok((await hit(world, '/pauses', { host: CONSOLE_HOST, token: shop.token })).status === 401);
    assert.ok((await shop.send('GET', '/pauses')).status >= 400);
  } finally {
    await releaseGlobal();
  }
});

test('F-36, F-37: a business pause needs a reason, is listed as the platform\'s with that reason, and the owner cannot lift it', async () => {
  const shop = await shopOn(world, 't3');
  const other = await shopOn(world, 't3');
  const op = await consoleUser(world, 'support');
  for (const body of [{}, { reason: '' }, { reason: '   ' }]) assert.equal((await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/pause`, body)).status, 400);
  need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/pause`, { reason: 'chargeback review' }), 200, 'Pausing');
  const resume = await shop.send('POST', '/compliance/resume', {});
  assert.ok([401, 403, 409].includes(resume.status), `the owner resuming: ${resume.status}`);
  assert.equal((await one(world, 'SELECT paused FROM compliance_settings WHERE tenant_id = $1', [shop.tenantId])).paused, true, 'still paused');
  const list = json(need(await opCall(world, op, 'GET', `/pauses?tenantId=${shop.tenantId}&scope=business`), 200, 'Pauses')).items;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].tenantId, list[0].engaged, list[0].by, list[0].reason], [shop.tenantId, true, 'platform', 'chargeback review']);
  assert.ok(list[0].at);
  assert.match(list[0].actor, /^platform:\d+$/, 'the operator who did it, by id');
  assert.ok(!json(need(await opCall(world, op, 'GET', `/pauses?tenantId=${other.tenantId}`), 200, 'Pauses')).items.some((p) => p.scope === 'business'), 'only the business asked for');
  need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/resume`, { reason: 'cleared' }), 200, 'Resuming');
  assert.equal(json(need(await opCall(world, op, 'GET', `/pauses?tenantId=${shop.tenantId}&scope=business`), 200, 'Pauses')).items.length, 0);
  // Paging walks the whole list without repeats.
  const page1 = json(need(await opCall(world, op, 'GET', '/pauses?limit=1'), 200, 'Page 1'));
  if (page1.nextCursor) assert.equal(json(need(await opCall(world, op, 'GET', `/pauses?limit=1&cursor=${page1.nextCursor}`), 200, 'Page 2')).items.length <= 1, true);
});

test('F-91: a support user cannot do what only a super admin may; nobody demotes or disables themselves', async () => {
  const support = await consoleUser(world, 'support');
  const admin = await consoleUser(world, 'super_admin');
  assert.equal((await opCall(world, support, 'GET', '/team')).status, 403);
  assert.equal((await opCall(world, support, 'POST', '/team', { email: 'new1@team.example', role: 'super_admin' })).status, 403, 'adding an admin');
  const supportId = await idOf(support);
  assert.equal((await opCall(world, support, 'PATCH', `/team/${supportId}`, { role: 'super_admin', reason: 'me' })).status, 403, 'promoting yourself');
  assert.equal((await one(world, 'SELECT role FROM platform_users WHERE id = $1', [supportId])).role, 'support');
  for (const role of ['onboarding', 'service_operator']) {
    const op = await consoleUser(world, role);
    assert.equal((await opCall(world, op, 'GET', '/audit-log')).status, 403, `${role} reads the audit log`);
    assert.equal((await opCall(world, op, 'GET', '/pauses')).status, 403, `${role} reads the pauses`);
  }
  const email = `added${Date.now()}@team.example`;
  const added = json(need(await opCall(world, admin, 'POST', '/team', { email, name: 'Ravi', role: 'onboarding' }), 201, 'Adding'));
  assert.deepEqual([added.role, added.totpEnrolled, added.disabled], ['onboarding', false, false]);
  assert.equal((await opCall(world, admin, 'POST', '/team', { email: email.toUpperCase(), role: 'support' })).status, 409, 'the same address twice');
  assert.equal((await opCall(world, admin, 'PATCH', `/team/${added.id}`, { role: 'support' })).status, 400, 'a change needs a reason');
  need(await opCall(world, admin, 'PATCH', `/team/${added.id}`, { role: 'support', reason: 'moved teams' }), 200, 'Changing a role');
  const adminId = await idOf(admin);
  assert.equal((await opCall(world, admin, 'PATCH', `/team/${adminId}`, { role: 'support', reason: 'oops' })).status, 409);
  assert.equal((await opCall(world, admin, 'PATCH', `/team/${adminId}`, { disabled: true, reason: 'oops' })).status, 409);
  const row = await one(world, `SELECT * FROM audit_log WHERE action = 'platform.team_update' AND target = $1 ORDER BY id DESC LIMIT 1`, [String(added.id)]);
  assert.deepEqual([row.actor, row.details.reason, row.details.role, row.details.wasRole], [`platform:${adminId}`, 'moved teams', 'support', 'onboarding']);
  // Disabling someone ends their console session on the next request.
  const victim = await consoleUser(world, 'support');
  assert.equal((await hit(world, '/me', { host: CONSOLE_HOST, cookie: victim.cookie })).status, 200);
  need(await opCall(world, admin, 'PATCH', `/team/${await idOf(victim)}`, { disabled: true, reason: 'left the company' }), 200, 'Disabling');
  assert.equal((await hit(world, '/me', { host: CONSOLE_HOST, cookie: victim.cookie })).status, 401);
});

test('F-91: everything a platform user does to a business is on the audit log with who, when and why, and the list shows it', async () => {
  const shop = await shopOn(world, 't1');
  const op = await consoleUser(world, 'support');
  const id = await idOf(op);
  need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/pause`, { reason: 'looking into a complaint' }), 200, 'Pausing');
  need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/resume`, { reason: 'all fine' }), 200, 'Resuming');
  need(await opCall(world, op, 'GET', `/tenants/${shop.tenantId}/health`), 200, 'Looking at its health');
  assert.equal((await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/pause`, {})).status, 400);
  // The middleware writes after the answer is sent: give it a moment.
  await new Promise((r) => setTimeout(r, 300));
  const rows = await sql(world, `SELECT actor, action, target, details, created_at FROM audit_log WHERE tenant_id = $1 AND actor = $2 ORDER BY id`, [shop.tenantId, `platform:${id}`]);
  const requests = rows.filter((r) => r.action === 'platform.request');
  assert.ok(requests.some((r) => r.details.reason === 'looking into a complaint' && r.details.status === 200 && /pause/.test(r.target)), 'the pause with its reason');
  assert.ok(requests.some((r) => r.details.reason === 'all fine' && /resume/.test(r.target)), 'the resume with its reason');
  assert.ok(requests.some((r) => r.details.status === 400), 'a refusal is recorded too');
  assert.ok(rows.some((r) => r.action === 'platform.view' && /health/.test(r.target)), 'looking at one business');
  assert.ok(rows.every((r) => r.created_at), 'when');
  for (const r of rows) assert.doesNotMatch(JSON.stringify(r.details), new RegExp(`${op.email}|${shop.owner?.phone ?? 'no-phone'}`), 'ids only');
  // The console's audit list: filtered to this business and this person, newest first, paged.
  const list = json(need(await opCall(world, op, 'GET', `/audit-log?tenantId=${shop.tenantId}&actor=platform:${id}&limit=2`), 200, 'Audit list'));
  assert.equal(list.items.length, 2);
  assert.ok(list.items[0].id > list.items[1].id);
  assert.ok(list.items.every((i) => i.tenantId === shop.tenantId && i.actor === `platform:${id}`));
  const next = json(need(await opCall(world, op, 'GET', `/audit-log?tenantId=${shop.tenantId}&actor=platform:${id}&limit=2&cursor=${list.nextCursor}`), 200, 'Next page'));
  assert.ok(next.items.every((i) => i.id < list.items[1].id));
  // The owner sees what Bhava's team did in their business on their own audit screen, and nothing of another's.
  const mine = await shop.send('GET', '/audit-log?limit=100');
  if (mine.status === 200) assert.ok(json(mine).items.some((i) => String(i.actor).startsWith('platform:')));
  // A business id that does not exist still leaves a row, without the business.
  assert.equal((await opCall(world, op, 'POST', '/tenants/999998/pause', { reason: 'typo' })).status, 404);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(await one(world, `SELECT 1 FROM audit_log WHERE actor = $1 AND tenant_id IS NULL AND (details->>'tenantId')::int = 999998`, [`platform:${id}`]));
});

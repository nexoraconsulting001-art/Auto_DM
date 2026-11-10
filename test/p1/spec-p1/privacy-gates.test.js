// PRD 4.14, 4.15 and 4.16: logs, release gates and the compliance log. C-51 to C-56.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, HOUR, SCOPES, addShop, asAppRole, assertNoDm, assertRefused, captureLogs, commentPayload, connectInstagramFlow, fakeSite, findAppRole, need, unique, useWorld, REASON_CODES } from './support.js';

const world = useWorld();

async function batchComments(w, shop, mediaId, n, textOf = (i) => `price from a person ${i}`) {
  const fans = [];
  const entries = [];
  for (let i = 0; i < n; i++) {
    const from = w.fan();
    fans.push(from);
    const { comment } = await w.meta.post('/comments', { igUserId: shop.igUserId, mediaId, from, text: textOf(i), deliver: false });
    entries.push(commentPayload(shop, { id: comment.id, mediaId, from, text: textOf(i) }).entry[0]);
  }
  need(await w.webhook({ object: 'instagram', entry: entries }), 200, 'The batch');
  return fans;
}

test('C-51: after 1,000 sends the logs hold no username, message text, person id or token', { timeout: 280_000 }, async (t) => {
  const logs = captureLogs(t);
  const lines = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return stdout(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return stderr(chunk, ...rest); };
  t.after(() => { process.stdout.write = stdout; process.stderr.write = stderr; });

  const shops = [await addShop(world), await addShop(world)];
  const secretWords = `zebra-${unique()}`;
  const fans = [];
  for (const shop of shops) {
    const reel = await shop.automate();
    fans.push(...await batchComments(world, shop, reel.mediaId, 500, (i) => `price ${secretWords} 98765${String(i).padStart(5, '0')}`));
  }
  await Promise.all(shops.map((shop) => shop.settle({ ms: 200_000, roundMs: 3000 })));
  assert.equal((await shops[0].dms()).length + (await shops[1].dms()).length, 1000, 'All 1,000 went');

  const everything = logs.text() + lines.join('');
  assert.doesNotMatch(everything, new RegExp(secretWords), 'Message text in the logs');
  assert.doesNotMatch(everything, /98765\d{5}/, 'A phone number in the logs');
  assert.doesNotMatch(everything, /fan_\d+\w*_handle/, 'A username in the logs');
  for (const fan of fans.slice(0, 200)) assert.equal(everything.includes(fan.id), false, 'A person\'s id in the logs');
  for (const shop of shops) assert.equal(everything.includes(shop.igToken), false, 'A token in the logs');
});

test('C-51: failures log no person either: a refusal, a timeout and a junk answer', async (t) => {
  const logs = captureLogs(t);
  const shop = await addShop(world);
  const reel = await shop.automate();
  const secretWords = `quartz-${unique()}`;
  const from = world.fan('secretperson');
  await shop.refuseSends({ code: 100, message: `(#100) bad value ${secretWords}` });
  await shop.comment(reel.mediaId, { from, text: `price ${secretWords}` });
  await shop.settle();
  const other = world.fan('secretperson');
  await shop.fault({ kind: 'malformed', mode: 'garbage', match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  await shop.comment(reel.mediaId, { from: other, text: `price ${secretWords}` });
  await shop.settle();
  assert.doesNotMatch(logs.text(), new RegExp(`${secretWords}|secretperson|${from.id}|${shop.igToken}`));
});

test('C-51: tokens are never in a Graph URL', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.comment(reel.mediaId);
  await shop.settle();
  await shop.api('/instagram/media');
  for (const call of await world.meta.calls()) assert.equal(Object.keys(call.query ?? {}).includes('access_token') && call.query.access_token === shop.igToken, false, call.path);
});

test('C-51: usernames live only in the inbox: not in the log, the queue, the caps or the opt-outs', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan('onlyinbox');
  await shop.comment(reel.mediaId, { from, text: 'price' });
  await shop.settle();
  for (const table of ['compliance_events', 'outbound_jobs', 'cap_claims', 'opt_outs']) {
    const rows = await shop.sql(`SELECT * FROM ${table} WHERE tenant_id = $1`, [shop.tenantId]);
    assert.doesNotMatch(JSON.stringify(rows), /onlyinbox/, table);
  }
});

test('C-51: retention: inbox text and usernames are gone after 30 days, the thread\'s caps are not', async () => {
  const shop = await addShop(world);
  const person = world.fan();
  await shop.dm(person, 'a private question');
  await shop.settle();
  await world.travel(30 * DAY - HOUR);
  await shop.settle();
  assert.equal((await shop.sql('SELECT * FROM inbox_messages WHERE tenant_id = $1', [shop.tenantId])).length, 1, 'Not yet 30 days old');
  await world.travel(2 * HOUR);
  await shop.settle();
  assert.equal((await shop.sql('SELECT * FROM inbox_messages WHERE tenant_id = $1', [shop.tenantId])).length, 0, 'Past 30 days');
});

test('C-51: retention: compliance events stay 13 months and then go', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.comment(reel.mediaId);
  await shop.settle();
  const count = (await shop.events()).length;
  assert.ok(count > 0);
  await world.travel(390 * DAY);
  await shop.settle();
  assert.equal((await shop.events()).length, count, 'Still inside 13 months');
  await world.travel(10 * DAY);
  await shop.settle();
  assert.equal((await shop.events()).length, 0, 'Past 13 months');
});

const goLive = (shop, id) => shop.api(`/automations/${id}/state`, { method: 'POST', body: { state: 'live' } });
/** A draft on a link the checker can reach, so only the gate under test can stop it. */
async function draftOn(shop) {
  const linkUrl = shop.siteUrl('/p/gate');
  fakeSite(linkUrl);
  return shop.automate({ linkUrl, state: 'draft' });
}
const gatesOf = async (shop) => Object.fromEntries((await shop.call('/compliance/status', 200)).gates.map((g) => [g.code, g.passed]));

test('C-52: Standard Access, an account without an app role: gate.access_level, and it can\'t go live', async () => {
  const shop = await addShop(world);
  await shop.settingsRow({ access_level: 'standard', app_role_ok: false, gate_passed_at: null });
  const draft = await draftOn(shop);
  assertRefused(await goLive(shop, draft.id), 'gate.access_level', 'Going live');
  assert.equal((await gatesOf(shop))['gate.access_level'], false);
  assert.equal((await shop.call(`/automations/${draft.id}`, 200)).state, 'draft');
});

test('C-52: Standard Access with an app role passes the gate', async () => {
  const shop = await addShop(world);
  await shop.settingsRow({ access_level: 'standard', app_role_ok: true });
  const draft = await draftOn(shop);
  need(await goLive(shop, draft.id), 200, 'Going live');
  assert.equal((await gatesOf(shop))['gate.access_level'], true);
});

test('C-52: Advanced Access passes with no app role', async () => {
  const shop = await addShop(world);
  await shop.settingsRow({ access_level: 'advanced', app_role_ok: false });
  need(await goLive(shop, (await draftOn(shop)).id), 200, 'Going live');
});

test('C-52: only a super admin can change a business\'s access level', async () => {
  const { consoleUser, onConsole } = await import('./support.js');
  const shop = await addShop(world);
  const support = await consoleUser(world, 'support');
  const admin = await consoleUser(world, 'super_admin');
  assert.equal((await onConsole(world, support, `/tenants/${shop.tenantId}/meta-access`, { method: 'POST', body: { accessLevel: 'standard' } })).status, 403);
  need(await onConsole(world, admin, `/tenants/${shop.tenantId}/meta-access`, { method: 'POST', body: { accessLevel: 'standard', appRoleOk: false } }), 200, 'Super admin');
});

for (const [label, fields, reason] of [
  ['the privacy page has not passed its check', { privacy_url_ok_at: null, gate_passed_at: null }, 'gate.privacy_url'],
  ['the deletion callback has not passed its check', { deletion_callback_ok_at: null, gate_passed_at: null }, 'gate.deletion_callback'],
]) {
  test(`C-52: ${label}: it can't go live, ${reason}`, async () => {
    const shop = await addShop(world);
    await shop.settingsRow(fields);
    assertRefused(await goLive(shop, (await draftOn(shop)).id), reason, 'Going live');
  });
}

test('C-52: passing every gate is logged, gate.passed', async () => {
  const shop = await addShop(world);
  need(await goLive(shop, (await draftOn(shop)).id), 200, 'Going live');
  const reasons = await shop.reasons();
  assert.ok(reasons.includes('gate.passed'), reasons.join());
});

test('C-53: a token without the messages scope: gate.scope_missing, and reconnect is offered', async () => {
  const shop = await addShop(world, { scopes: [SCOPES.basic, SCOPES.comments, SCOPES.insights] });
  const connection = await shop.call('/instagram/connection', 200);
  assert.deepEqual(connection.missingScopes, [SCOPES.messages]);
  assertRefused(await goLive(shop, (await draftOn(shop)).id), 'gate.scope_missing', 'Going live');
  assert.equal((await gatesOf(shop))['gate.scope_missing'], false);
});

test('C-53: a token without the comments scope is refused the same way', async () => {
  const shop = await addShop(world, { scopes: [SCOPES.basic, SCOPES.messages, SCOPES.insights] });
  assertRefused(await goLive(shop, (await draftOn(shop)).id), 'gate.scope_missing', 'Going live');
});

test('C-53: connecting with a scope denied records exactly what was granted', async () => {
  const shop = await addShop(world);
  await connectInstagramFlow(world, shop, { scopes: [SCOPES.basic, SCOPES.comments, SCOPES.insights] });
  const connection = await shop.call('/instagram/connection', 200);
  assert.equal(connection.scopes.includes(SCOPES.messages), false);
  assert.deepEqual(connection.missingScopes, [SCOPES.messages]);
});

test('C-53: no connect request ever asks for publishing', async () => {
  const shop = await addShop(world);
  const { authorizeUrl } = await shop.call('/instagram/connect', 200, { method: 'POST', body: {} });
  const scope = new URL(authorizeUrl).searchParams.get('scope');
  assert.doesNotMatch(scope, /publish/);
  for (const name of Object.values(SCOPES)) assert.match(scope, new RegExp(name));
});

test('C-53: the connect link is only for managers, and a hostile return address is refused', async () => {
  const { addStaff } = await import('./support.js');
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['automations'] });
  assert.equal((await shop.api('/instagram/connect', { method: 'POST', token: staff.token, body: {} })).status, 403);
  for (const returnTo of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)']) {
    assert.equal((await shop.api('/instagram/connect', { method: 'POST', body: { returnTo } })).status, 400, returnTo);
  }
});

test('C-53: a callback with a forged or reused state connects nothing', async () => {
  const { hit } = await import('./support.js');
  const shop = await addShop(world);
  const before = await shop.account();
  for (const state of ['forged', '', 'x'.repeat(201)]) {
    const res = await hit(world, `/oauth/instagram/callback?code=abc&state=${state}`, { host: shop.host });
    assert.ok(res.status >= 300 && res.status !== 500, `state ${state.slice(0, 10)} answered ${res.status}`);
  }
  assert.equal((await shop.account()).access_token_enc, before.access_token_enc);
});

test('C-54: when the owner denies insights it can still go live, in slow mode', async () => {
  const shop = await addShop(world, { scopes: [SCOPES.basic, SCOPES.messages, SCOPES.comments] });
  const connection = await shop.call('/instagram/connection', 200);
  assert.equal(connection.insightsGranted, false);
  need(await goLive(shop, (await draftOn(shop)).id), 200, 'Going live without insights');
  await shop.settle();
  const status = await shop.call('/compliance/status', 200);
  assert.equal(status.slowMode.active, true);
  assert.equal(status.slowMode.canOverride, false, 'Only a reach drop can be overridden');
  const [state] = await shop.sql('SELECT * FROM account_rate_state WHERE tenant_id = $1 AND account_id = $2', [shop.tenantId, shop.igUserId]);
  assert.equal(state.slow_mode_trigger, 'insights_denied');
});

test('C-54: a live business with no insights scope still sends its DMs', async () => {
  const shop = await addShop(world, { scopes: [SCOPES.basic, SCOPES.messages, SCOPES.comments] });
  const auto = await shop.automate();
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
});

test('C-54: insights revoked later moves the business to slow mode', async () => {
  const shop = await addShop(world);
  await shop.sql('UPDATE ig_accounts SET granted_scopes = $3 WHERE tenant_id = $1 AND ig_user_id = $2', [shop.tenantId, shop.igUserId, [SCOPES.basic, SCOPES.messages, SCOPES.comments]]);
  await shop.settle();
  assert.equal((await shop.call('/instagram/connection', 200)).insightsGranted, false);
  assert.equal((await shop.call('/compliance/status', 200)).slowMode.active, true);
});

test('C-55: a comment skipped for opt-out is 1 row with a hashed subject and no username', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const person = world.fan('hiddenname');
  await shop.dm(person, 'STOP');
  await shop.settle();
  const comment = await shop.comment(reel.mediaId, { from: person, text: 'price please hiddentext' });
  await shop.settle();
  const rows = await shop.events(`comment_id = $2 AND reason = 'optout'`, [comment.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, await shop.hash(person.id));
  assert.match(rows[0].subject, /^[0-9a-f]{64}$/);
  assert.equal(rows[0].channel, 'instagram');
  assert.doesNotMatch(JSON.stringify(rows[0]), new RegExp(`hiddenname|hiddentext|${person.id}`));
  await assertNoDm(shop);
});

test('C-55: every reason the engine has logged is on the one list', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.comment(reel.mediaId);
  await shop.comment(await shop.reel());
  await shop.comment(reel.mediaId, { text: 'nothing' });
  await shop.settle();
  const logged = await shop.events();
  for (const row of logged) {
    assert.ok(REASON_CODES.includes(row.decision), `Decision ${row.decision}`);
    if (row.reason) assert.ok(REASON_CODES.includes(row.reason), `Reason ${row.reason}`);
    assert.ok(row.channel, 'The engine fills channel on every row');
  }
});

test('C-55: the activity view gives no person\'s id, hashed or otherwise', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const person = world.fan();
  await shop.comment(reel.mediaId, { from: person });
  await shop.settle();
  const text = JSON.stringify(await shop.call('/compliance/activity', 200));
  assert.equal(text.includes(await shop.hash(person.id)), false);
  assert.equal(text.includes(person.id), false);
  assert.equal(text.includes(person.username), false);
});

test('C-55: the activity view shows one business only, and filters by reason', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const reelA = await a.automate();
  const comment = await a.comment(reelA.mediaId, { text: 'nothing relevant' });
  await a.settle();
  assert.deepEqual((await b.call('/compliance/activity', 200)).items, []);
  const filtered = await a.call('/compliance/activity?reason=no_keyword', 200);
  assert.deepEqual(filtered.items.map((i) => i.commentId), [comment.id]);
  assert.deepEqual((await a.call('/compliance/activity?reason=optout', 200)).items, []);
  assert.equal((await a.api('/compliance/activity?reason=not_a_code')).status, 400);
});

for (const [verb, sql] of [
  ['UPDATE', `UPDATE compliance_events SET reason = 'tampered'`],
  ['DELETE', 'DELETE FROM compliance_events'],
]) {
  test(`C-56: the app role running ${verb} on compliance_events is refused`, async () => {
    const shop = await addShop(world);
    await shop.sql(`INSERT INTO compliance_events (tenant_id, kind, decision) VALUES ($1, 'dm', 'sent')`, [shop.tenantId]);
    const role = await findAppRole(world.rawDb);
    assert.ok(role, 'The app has its own role');
    await assert.rejects(() => asAppRole(world.rawDb, role, shop.tenantId, (t) => t.query(sql)), /permission denied/i);
    assert.equal((await shop.events()).length, 1);
  });
}

test('C-56: audit_log is just as closed', async () => {
  const shop = await addShop(world);
  await shop.sql(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'spec', 'login')`, [shop.tenantId]);
  const role = await findAppRole(world.rawDb);
  await assert.rejects(() => asAppRole(world.rawDb, role, shop.tenantId, (t) => t.query(`UPDATE audit_log SET actor = 'x'`)), /permission denied/i);
  await assert.rejects(() => asAppRole(world.rawDb, role, shop.tenantId, (t) => t.query('DELETE FROM audit_log')), /permission denied/i);
});

test('C-56: even the owner of the tables can\'t edit a row', async () => {
  const shop = await addShop(world);
  await shop.sql(`INSERT INTO compliance_events (tenant_id, kind, decision) VALUES ($1, 'dm', 'sent')`, [shop.tenantId]);
  await assert.rejects(() => shop.sql(`UPDATE compliance_events SET reason = 'x' WHERE tenant_id = $1`, [shop.tenantId]), /insert-only/);
});

test('C-56: the app role can add a row for its own business only, and read only its own', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  await b.sql(`INSERT INTO compliance_events (tenant_id, kind, decision) VALUES ($1, 'dm', 'sent')`, [b.tenantId]);
  const role = await findAppRole(world.rawDb);
  await asAppRole(world.rawDb, role, a.tenantId, (t) => t.query(`INSERT INTO compliance_events (tenant_id, kind, decision) VALUES ($1, 'dm', 'sent')`, [a.tenantId]));
  await assert.rejects(() => asAppRole(world.rawDb, role, a.tenantId, (t) => t.query(`INSERT INTO compliance_events (tenant_id, kind, decision) VALUES ($1, 'dm', 'sent')`, [b.tenantId])), /row-level security|policy/i);
  const seen = await asAppRole(world.rawDb, role, a.tenantId, (t) => t.query('SELECT tenant_id FROM compliance_events'));
  assert.deepEqual([...new Set(seen.map((r) => r.tenant_id))], [a.tenantId]);
});

test('C-56: a reason that isn\'t on the list can\'t be written', async () => {
  const shop = await addShop(world);
  await assert.rejects(() => shop.sql(`INSERT INTO compliance_events (tenant_id, kind, decision, reason, channel) VALUES ($1, 'dm', 'sent', 'made.up', 'instagram')`, [shop.tenantId]), /reason-code enum/);
});

// The review login into the demo business (PRD 5.11 F-50; 10.6 P-24, P-25): it opens the demo business only, only for
// the review number with the flag on, every try is logged, nothing in the demo business can be sent, and its screens
// show the stored sample instead of an Instagram error.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { SAMPLE_ACCOUNT } from '../../../src/modules/demo-tenant/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { checkFolders } from '../../../tools/policy-check.mjs';
import { REVIEW_CODE, REVIEW_LOCAL, call, reviewApp, reviewSession, verify } from './support.js';

let app;
let demo;
before(async () => {
  app = await reviewApp();
  // The login row is written when the first try comes in; the demo business made after it still claims it.
  assert.equal((await verify(app, REVIEW_LOCAL, REVIEW_CODE)).status, 401, 'no demo business yet: the login opens nothing');
  demo = await app.demo.ensure();
});
after(() => app?.close());

const uses = () => app.db.platform.query('SELECT accepted, reason FROM review_login_uses ORDER BY id');
const HOUR = 3_600_000;

test('F-50, P-24: the review login opens the demo business, and only it', async () => {
  const [login] = await app.db.platform.query('SELECT tenant_id FROM review_logins');
  assert.equal(login.tenant_id, demo.tenantId, 'ensure points the review login at the demo business');
  const session = await reviewSession(app);
  assert.equal(session.business.id, demo.tenantId);
  assert.deepEqual(session.businesses.map((b) => b.id), [demo.tenantId]);
  assert.deepEqual((await uses()).at(-1), { accepted: true, reason: '' });
  const orders = await call(app, '/api/v1/orders', { headers: session.headers });
  assert.equal(orders.status, 200);
  assert.equal(orders.json.items.length, 10, 'the sample orders');
  // Asking for another business with the review session gets nothing from it.
  const other = await call(app, '/api/v1/orders', { headers: { ...session.headers, 'x-tenant-id': String(app.tenant.id) } });
  assert.notEqual(other.status, 200);
  const there = await call(app, '/api/v1/orders', { headers: session.headers, host: 'default.bhava.test' });
  assert.notEqual(there.status, 200, "the review session is not accepted on another business's address");
});

test('F-50: the review code on any other number is refused and logged; with the flag off the review number is refused too', async () => {
  const other = await verify(app, '9876543210', REVIEW_CODE);
  assert.equal(other.status, 401);
  assert.deepEqual((await uses()).at(-1), { accepted: false, reason: 'wrong_number' });
  assert.equal((await verify(app, REVIEW_LOCAL, '111111')).status, 401);
  assert.deepEqual((await uses()).at(-1), { accepted: false, reason: 'wrong_code' });
  await app.db.platform.query('UPDATE review_logins SET enabled = false');
  try {
    assert.equal((await verify(app, REVIEW_LOCAL, REVIEW_CODE)).status, 401);
    assert.deepEqual((await uses()).at(-1), { accepted: false, reason: 'flag_off' });
  } finally {
    await app.db.platform.query('UPDATE review_logins SET enabled = true');
  }
  const stored = JSON.stringify(await app.db.platform.query('SELECT * FROM review_login_uses'));
  assert.equal(stored.includes(REVIEW_LOCAL) || stored.includes(REVIEW_CODE), false, 'no number or code in the log');
});

test('F-50: the review login never expires: a login set long ago still opens the demo business', async () => {
  await app.db.platform.query(`UPDATE review_logins SET updated_at = now() - interval '400 days'`);
  const session = await reviewSession(app);
  assert.equal(session.business.id, demo.tenantId);
});

test('the review login can never be tied to another business, whatever writes it', async () => {
  // review_logins names the demo business only.
  await assert.rejects(app.db.platform.query('UPDATE review_logins SET tenant_id = $1', [app.tenant.id]), /demo business only/);
  // No membership links the demo business with another, either way round.
  const [reviewUser] = await app.db.platform.query('SELECT id, person_id FROM users WHERE tenant_id = $1 AND person_id IS NOT NULL', [demo.tenantId]);
  const [owner] = await app.db.platform.query('SELECT id FROM users WHERE tenant_id = $1 LIMIT 1', [app.tenant.id]);
  await app.db.platform.query('INSERT INTO memberships (tenant_id, user_id, member_tenant_id, member_user_id) VALUES ($1, $2, $3, $4), ($3, $4, $1, $2)',
    [demo.tenantId, reviewUser.id, app.tenant.id, owner.id]);
  const links = await app.db.platform.query('SELECT 1 FROM memberships WHERE tenant_id = $1 OR member_tenant_id = $1', [demo.tenantId]);
  assert.equal(links.length, 0);
  // No other business may hold an account of the review number's person, so an invitation to it opens nothing.
  await assert.rejects(app.db.platform.query('UPDATE users SET person_id = $2 WHERE tenant_id = $1 AND id = $3', [app.tenant.id, reviewUser.person_id, owner.id]), /demo business only/);
  await assert.rejects(app.db.platform.query(`INSERT INTO users (tenant_id, name, phone, email, password_hash, role, person_id) VALUES ($1, 'x', '9000000077', '', '-', 'staff', $2)`,
    [app.tenant.id, reviewUser.person_id]), /demo business only/);
  const session = await reviewSession(app);
  assert.deepEqual(session.businesses.map((b) => b.id), [demo.tenantId]);
});

test('the demo business can never send: the compliance engine holds every message, and nothing lifts it', async () => {
  const send = (extra = {}) => withTenant({ id: demo.tenantId }, () => app.ctx.compliance.send({
    kind: 'dm', purpose: 'manual', accountId: SAMPLE_ACCOUNT.igUserId, recipientId: 'sample-igsid-anya', personId: 'sample-igsid-anya',
    idempotencyKey: crypto.randomUUID(), expiresAt: new Date(Date.now() + HOUR), message: { text: 'Hello' }, ...extra,
  }));
  const first = await send();
  assert.deepEqual([first.outcome, first.reason], ['held', 'paused.tenant']);
  // Whoever tries to switch sending on, owner or ops: the settings stay paused by ops, with dry run on.
  await app.db.platform.query(`UPDATE compliance_settings SET paused = false, paused_by = NULL, pause_store = false, dry_run = false WHERE tenant_id = $1`, [demo.tenantId]);
  const [settings] = await app.db.platform.query('SELECT paused, paused_by, dry_run, pause_store FROM compliance_settings WHERE tenant_id = $1', [demo.tenantId]);
  assert.deepEqual(settings, { paused: true, paused_by: 'ops', dry_run: true, pause_store: true });
  // A real account or a token can't be given to it, nor a Facebook Page or a WhatsApp account.
  await app.db.platform.query(`UPDATE ig_accounts SET access_token_enc = 'sealed-token', status = 'active' WHERE tenant_id = $1`, [demo.tenantId]);
  const [account] = await app.db.platform.query('SELECT access_token_enc, status FROM ig_accounts WHERE tenant_id = $1', [demo.tenantId]);
  assert.deepEqual(account, { access_token_enc: '', status: 'reconnect_needed' });
  await assert.rejects(app.db.platform.query(`INSERT INTO ig_accounts (ig_user_id, tenant_id) VALUES ('17841400000000001', $1)`, [demo.tenantId]), /no real Instagram account/);
  await assert.rejects(app.db.platform.query(`INSERT INTO fb_pages (page_id, tenant_id) VALUES ('100000000000001', $1)`, [demo.tenantId]), /no Facebook account/);
  await assert.rejects(app.db.platform.query(`INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id) VALUES ($1, '1', '2')`, [demo.tenantId]), /no WhatsApp account/);
  const again = await send({ purpose: 'trigger', kind: 'dm' });
  assert.equal(again.outcome, 'held');
  assert.deepEqual(app.ig.calls, [], 'nothing reached Instagram');
  // The reviewer replying from the inbox gets the same answer.
  const session = await reviewSession(app);
  const threads = await call(app, '/api/v1/inbox/threads', { headers: session.headers });
  assert.equal(threads.status, 200);
  const reply = await call(app, `/api/v1/inbox/threads/${threads.json.items[0].id}/reply`, { method: 'POST', headers: session.headers, body: { text: 'Hello there' } });
  assert.deepEqual([reply.status, reply.json?.outcome, reply.json?.reason], [200, 'held', 'paused.tenant']);
  assert.deepEqual(app.ig.calls, []);
  const sent = await app.db.platform.query(`SELECT count(*)::int AS n FROM compliance_events WHERE tenant_id = $1 AND decision IN ('sent', 'sent_fallback')`, [demo.tenantId]);
  assert.equal(sent[0].n, 0);
});

test('P-25: with Instagram unavailable the screens show the stored sample, not an error', async () => {
  const { headers } = await reviewSession(app);
  const status = await call(app, '/api/v1/insights/status', { headers });
  assert.equal(status.status, 200);
  assert.equal(status.json.connected, false, 'the connection is unavailable');
  assert.ok(status.json.lastUpdatedAt);
  const account = await call(app, '/api/v1/insights/account', { headers });
  assert.equal(account.status, 200);
  const reach = account.json.metrics.find((m) => m.metric === 'reach');
  assert.ok(reach.total > 0, 'figures, not an empty state');
  assert.ok(reach.days.filter((d) => d.state === 'ok').length >= 27, 'every day of the default range but today has figures');
  const audience = await call(app, '/api/v1/insights/audience?timeframe=this_month', { headers });
  assert.equal(audience.status, 200);
  assert.equal(audience.json.available, true);
  const media = await call(app, '/api/v1/insights/media', { headers });
  assert.equal(media.status, 200);
  assert.ok(media.json.items.length >= 3);
  const automations = await call(app, '/api/v1/automations', { headers });
  assert.equal(automations.status, 200);
  assert.equal(automations.json.items.length, 4);
  const threads = await call(app, '/api/v1/inbox/threads', { headers });
  assert.ok(threads.json.items.length >= 4);
});

test('one structure for every client: nothing names the demo business in code, and the policy check passes', () => {
  assert.deepEqual(checkFolders(), [], 'npm run policy-check');
  assert.deepEqual(checkFolders(['scripts']).filter((f) => f.file === 'scripts/demo-tenant.js'), []);
});

test('the script describes and keeps the demo business', async () => {
  const { demoTenantCommand } = await import('../../../scripts/demo-tenant.js');
  assert.match(await demoTenantCommand(app.demo, ['status']), /^Demo business demo-boutique \(id \d+\): sample v1 for \d{4}-\d{2}-\d{2}$/);
  assert.match(await demoTenantCommand(app.demo, ['ensure']), /^Kept: /);
  await assert.rejects(demoTenantCommand(app.demo, ['reset', '1 Nov']), /YYYY-MM-DD/);
  await assert.rejects(demoTenantCommand(app.demo, ['nonsense']), /Usage/);
});

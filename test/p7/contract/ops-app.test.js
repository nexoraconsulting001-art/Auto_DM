// The Platform Console contract in a running app and a real database (PRD 5.5, 5.6, 5.9, 5.10, 5.17): migration 730's
// tables and the rules they hold, a session Bhava's team opened going through the API router, the console's web app on the
// platform host only, and the two providers' simulators for KYC and pickup locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRazorpay } from '../../../src/adapters/razorpay/index.js';
import { createShiprocket } from '../../../src/adapters/shiprocket/index.js';
import { OPS_PLATFORM_OWNERS, platformRoutes } from '../../../src/contracts/api/index.js';
import { KYC_STATES } from '../../../src/contracts/onboarding.js';
import { hashSessionToken } from '../../../src/repos/sessions.js';
import { withTenant } from '../../../src/tenancy.js';
import { createRazorpay as createRazorpaySim } from '../../../tools/sim/razorpay/index.mjs';
import { createShiprocket as createShiprocketSim } from '../../../tools/sim/shiprocket/index.mjs';
import { CONSOLE_HOST, addBusiness, addProduct, consoleUser, hit, onConsole, startWorld } from '../../p0/spec-p0/support.js';
import { refusal } from '../../p4/contract/support.js';

const FENCED = ['impersonation_sessions', 'service_engagements', 'service_sessions', 'service_changes', 'onboarding_invites', 'onboarding_steps', 'onboarding_timings', 'tenant_health_checks'];
const READ_ONLY = ['impersonation_sessions', 'service_sessions', 'tenant_health_checks'];
const PLATFORM_ONLY = ['onboarding_invites', 'onboarding_timings', 'platform_recovery_codes', 'platform_login_codes', 'platform_users'];
const DENIED = /42501|permission denied/;

const sql = (app, text, params) => app.db.platform.query(text, params);
const asBusiness = (app, business, text, params) => withTenant(business.tenant, () => app.db.query(text, params));
const one = async (app, text, params) => (await sql(app, text, params))[0];

async function operatorRow(app, role = 'support', name = 'Meera') {
  return one(app, `INSERT INTO platform_users (email, name, role) VALUES ($1, $2, $3) RETURNING id`, [`${crypto.randomUUID()}@team.example`, name, role]);
}

/** A seller cookie session of the business's owner that names an impersonation or a service session, as the console will open it. */
async function operatorSession(app, business, { impersonationId = null, serviceSessionId = null }) {
  const owner = await one(app, `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner'`, [business.tenant.id]);
  const token = crypto.randomBytes(32).toString('base64url');
  await sql(app, `INSERT INTO sessions (id, tenant_id, user_id, kind, expires_at, fresh_until, impersonation_id, service_session_id) VALUES ($1, $2, $3, 'cookie', now() + interval '30 minutes', now() + interval '10 minutes', $4, $5)`,
    [hashSessionToken(token), business.tenant.id, owner.id, impersonationId, serviceSessionId]);
  const cookie = `sid=${token}`;
  const me = await hit(app, '/api/v1/auth/me', { host: business.host, cookie });
  const csrf = me.status === 200 ? me.json().csrf : '';
  const call = async (method, pathname, body, headers = {}) => {
    const res = await hit(app, `/api/v1${pathname}`, { host: business.host, cookie, method, body, headers: { 'x-csrf-token': csrf, ...headers } });
    return { status: res.status, json: res.text ? JSON.parse(res.text) : null };
  };
  return { owner, cookie, me, call };
}

test('migration 730: every table is fenced, and the rules behind impersonation, services and invites are held by the database', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'lamps', name: 'Lamp House' });
  const other = await addBusiness(app, { slug: 'pots', name: 'Pot House' });
  for (const table of FENCED) {
    assert.equal((await one(app, `SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id'`, [table]))?.is_nullable, 'NO', `${table}.tenant_id`);
    assert.ok(await one(app, `SELECT 1 AS ok FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_fence'`, [table]), `${table} has the fence`);
  }
  for (const table of READ_ONLY) {
    const grants = (await sql(app, `SELECT DISTINCT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'bhava_app' AND table_name = $1`, [table])).map((r) => r.privilege_type);
    assert.deepEqual(grants, ['SELECT'], `${table} is read-only to business code`);
  }
  for (const table of PLATFORM_ONLY) assert.match(String(await refusal(asBusiness(app, shop, `SELECT * FROM ${table} LIMIT 1`))), DENIED, `${table} is out of reach of business code`);

  // The four roles, and no fifth.
  const support = await operatorRow(app, 'support');
  const operator = await operatorRow(app, 'service_operator');
  await operatorRow(app, 'onboarding');
  assert.equal(await refusal(operatorRow(app, 'intern')), 'platform_users_role_check');
  const owner = await one(app, `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenant.id]);
  const stranger = await one(app, `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner'`, [other.tenant.id]);

  // Impersonation: a reason, at most 30 minutes, read-only until confirmed, and only as a user of that business.
  const start = (over = {}) => {
    const row = { tenant_id: shop.tenant.id, operator_id: support.id, owner_user_id: owner.id, reason: 'ticket 123', ...over };
    const columns = Object.keys(row);
    return sql(app, `INSERT INTO impersonation_sessions (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, mode, expires_at - started_at AS length`, columns.map((c) => row[c]));
  };
  const [opened] = await start();
  assert.equal(opened.mode, 'read');
  assert.notEqual(await refusal(start({ reason: '  ' })), null, 'F-42: no session without a reason');
  assert.notEqual(await refusal(start({ expires_at: new Date(Date.now() + 31 * 60_000) })), null, 'F-44: never longer than 30 minutes');
  assert.notEqual(await refusal(start({ mode: 'write' })), null, 'write mode needs its confirmation');
  assert.notEqual(await refusal(start({ owner_user_id: stranger.id })), null, 'the owner is a user of this business');
  assert.match(String(await refusal(asBusiness(app, shop, `UPDATE impersonation_sessions SET mode = 'write', write_confirmed_at = now()`))), DENIED, 'business code cannot give itself write mode');
  assert.equal((await asBusiness(app, shop, 'SELECT 1 FROM impersonation_sessions')).length, 1);
  assert.deepEqual(await asBusiness(app, other, 'SELECT 1 FROM impersonation_sessions'), [], 'another business sees nothing of it');

  // Managed services: an engagement per service, a session only with a task reference, changes in known states.
  await sql(app, `INSERT INTO service_engagements (tenant_id, service) VALUES ($1, 'catalog_management')`, [shop.tenant.id]);
  assert.notEqual(await refusal(sql(app, `INSERT INTO service_engagements (tenant_id, service) VALUES ($1, 'catalog_management')`, [shop.tenant.id])), null, 'one row per service');
  assert.notEqual(await refusal(sql(app, `INSERT INTO service_engagements (tenant_id, service) VALUES ($1, 'payouts')`, [shop.tenant.id])), null);
  const session = (over = {}) => sql(app, `INSERT INTO service_sessions (tenant_id, operator_id, service, task_ref) VALUES ($1, $2, $3, $4) RETURNING id`, [shop.tenant.id, operator.id, over.service ?? 'catalog_management', over.taskRef ?? 'TASK-9']);
  const [sitting] = await session();
  assert.notEqual(await refusal(session({ taskRef: ' ' })), null, 'no session without a task reference');
  assert.notEqual(await refusal(session({ service: 'merchandising' })), null, 'no session for a service the business never had');
  await asBusiness(app, shop, `UPDATE service_engagements SET mode = 'approve_first', updated_at = now() WHERE service = 'catalog_management'`);
  assert.match(String(await refusal(asBusiness(app, shop, `UPDATE service_engagements SET active_to = NULL`))), DENIED, 'the seller picks the mode and nothing else');
  const change = (state, extra = '') => asBusiness(app, shop, `INSERT INTO service_changes (tenant_id, session_id, service, operator_id, task_ref, route_id, state${extra ? ', undone_at' : ''}) VALUES ($1, $2, 'catalog_management', $3, 'TASK-9', 'products.update', $4${extra}) RETURNING id`, [shop.tenant.id, sitting.id, operator.id, state]);
  await change('applied');
  await change('draft');
  assert.notEqual(await refusal(change('published')), null);
  assert.notEqual(await refusal(change('undone')), null, 'undone carries when');
  assert.notEqual(await refusal(change('approved')), null, 'approved carries when it was decided');
  assert.match(String(await refusal(asBusiness(app, shop, 'DELETE FROM service_changes'))), DENIED, 'the record of the team’s work is never deleted');
  assert.notEqual(await refusal(asBusiness(app, shop, `INSERT INTO service_changes (tenant_id, session_id, service, operator_id, task_ref, route_id, state) VALUES ($1, $2, 'catalog_management', $3, 'T', 'products.update', 'applied')`, [other.tenant.id, sitting.id, operator.id])), null, 'and never written for another business');

  // A seller session names at most one of the two, and only a cookie session can.
  const ownerSession = (over) => sql(app, `INSERT INTO sessions (id, tenant_id, user_id, kind, expires_at, impersonation_id, service_session_id) VALUES ($1, $2, $3, $4, now() + interval '1 hour', $5, $6)`, [crypto.randomUUID(), shop.tenant.id, owner.id, over.kind ?? 'cookie', over.impersonationId ?? null, over.serviceSessionId ?? null]);
  assert.equal(await refusal(ownerSession({ impersonationId: opened.id })), null);
  assert.equal(await refusal(ownerSession({ impersonationId: opened.id, serviceSessionId: sitting.id })), 'sessions_one_operator');
  assert.equal(await refusal(ownerSession({ kind: 'bearer', impersonationId: opened.id })), 'sessions_operator_cookie');
  assert.notEqual(await refusal(sql(app, `INSERT INTO sessions (id, tenant_id, user_id, kind, expires_at, impersonation_id) VALUES ('x', $1, $2, 'cookie', now() + interval '1 hour', $3)`, [other.tenant.id, stranger.id, opened.id])), null, 'an impersonation of one business cannot back a session in another');

  // The owner's link: a hash, seven days at most, one live link per business.
  const invite = (hash, over = {}) => sql(app, `INSERT INTO onboarding_invites (tenant_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id`, [shop.tenant.id, hash, over.expiresAt ?? new Date(Date.now() + 7 * 86_400_000 - 60_000)]);
  const [first] = await invite('a'.repeat(43));
  assert.equal(await refusal(invite('b'.repeat(43))), 'onboarding_invites_live_idx', 'a resend revokes the old link first');
  await sql(app, 'UPDATE onboarding_invites SET revoked_at = now() WHERE id = $1', [first.id]);
  assert.equal(await refusal(invite('b'.repeat(43))), null);
  await sql(app, 'UPDATE onboarding_invites SET used_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL', [shop.tenant.id]);
  assert.notEqual(await refusal(invite('c'.repeat(43), { expiresAt: new Date(Date.now() + 8 * 86_400_000) })), null, 'F-27: never good for more than 7 days');
  assert.notEqual(await refusal(invite('short')), null, 'only a hash is stored');

  await asBusiness(app, shop, `INSERT INTO onboarding_steps (tenant_id, step, required, status) VALUES ($1, 'instagram', true, 'done')`, [shop.tenant.id]);
  assert.notEqual(await refusal(asBusiness(app, shop, `INSERT INTO onboarding_steps (tenant_id, step, required, status) VALUES ($1, 'terms', true, 'ticked')`, [shop.tenant.id])), null);
  await sql(app, `INSERT INTO tenant_health_checks (tenant_id, check_name, status) VALUES ($1, 'account.token', 'unreachable')`, [shop.tenant.id]);
  assert.notEqual(await refusal(sql(app, `INSERT INTO tenant_health_checks (tenant_id, check_name, status) VALUES ($1, 'domain.dns', 'fine')`, [shop.tenant.id])), null);
  assert.match(String(await refusal(asBusiness(app, shop, `UPDATE tenant_health_checks SET status = 'ok'`))), DENIED, 'a business cannot mark itself healthy');
});

test('impersonation in the router: read-only, the blocked list, masked contacts, an audit row per request, and an end at once', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'lamps', name: 'Lamp House' });
  const other = await addBusiness(app, { slug: 'pots', name: 'Pot House' });
  await addProduct(shop, 'Brass lamp');
  await shop.repos.users.create({ name: 'Asha K', phone: '9876543210', password: 'shopper-pass-1', role: 'customer' });
  const support = await operatorRow(app, 'support', 'Meera');
  const owner = await one(app, `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenant.id]);
  const imp = await one(app, `INSERT INTO impersonation_sessions (tenant_id, operator_id, operator_name, owner_user_id, reason) VALUES ($1, $2, 'Meera', $3, 'ticket 123') RETURNING id`, [shop.tenant.id, support.id, owner.id]);
  const s = await operatorSession(app, shop, { impersonationId: imp.id });

  // F-42: a read-only view, and the banner's data on auth.me.
  assert.equal(s.me.status, 200);
  const { operator } = s.me.json();
  assert.deepEqual([operator.kind, operator.mode, operator.operatorName, operator.consoleUrl], ['impersonation', 'read', 'Meera', `https://${CONSOLE_HOST}/console/`]);
  assert.ok(new Date(operator.expiresAt).getTime() - Date.now() <= 30 * 60_000);
  assert.equal(s.me.json().freshUntil, null, 'an operator’s session is never fresh');
  const products = await s.call('GET', '/products');
  assert.deepEqual([products.status, products.json.items.length], [200, 1]);

  // F-43: a save in read-only mode is 403, before the input is even read.
  const save = await s.call('PATCH', '/settings', { nonsense: true });
  assert.deepEqual([save.status, save.json.code], [403, 'impersonation.read_only']);
  assert.equal((await s.call('POST', '/products', { name: 'New', pricePaise: 100 })).json.code, 'impersonation.read_only');
  // Billing, the team and the owner's credentials: refused even to read.
  for (const [method, pathname] of [['GET', '/billing'], ['GET', '/team'], ['GET', '/auth/devices'], ['GET', '/auth/businesses']]) assert.deepEqual((({ status, json }) => [status, json.code])(await s.call(method, pathname)), [403, 'impersonation.blocked'], pathname);

  // Shopper contact details are masked outside order detail.
  const customers = await s.call('GET', '/customers');
  assert.equal(customers.status, 200);
  assert.equal(JSON.stringify(customers.json).includes('9876543210'), false, 'no phone number in the list');
  assert.equal(customers.json.items.find((c) => c.name === 'Asha K').phone, '98••••••10');

  // Write mode after the second confirmation: writes run, the blocked list still holds (F-45).
  await sql(app, `UPDATE impersonation_sessions SET mode = 'write', write_confirmed_at = now() WHERE id = $1`, [imp.id]);
  assert.equal((await s.call('GET', '/auth/me')).json.operator.mode, 'write');
  const invalid = await s.call('POST', '/products', { name: '', pricePaise: 100 });
  assert.deepEqual([invalid.status, invalid.json.code], [400, 'validation_failed'], 'now the route’s own checks answer');
  for (const [method, pathname, body] of [['PATCH', `/team/${owner.id}`, { role: 'staff' }], ['POST', '/auth/identities', {}], ['POST', '/auth/delete-account', {}], ['PATCH', '/settings/payment', {}], ['POST', '/billing/change', {}], ['POST', '/billing/payment-method', undefined]]) {
    assert.deepEqual((({ status, json }) => [status, json.code])(await s.call(method, pathname, body)), [403, 'impersonation.blocked'], `${method} ${pathname}`);
  }

  // The owner's password has an address outside the route table (Phase 0): the session does not exist there at all.
  const [before] = await sql(app, 'SELECT password_hash FROM users WHERE id = $1', [owner.id]);
  const password = await hit(app, '/api/v1/auth/password', { host: shop.host, cookie: s.cookie, method: 'POST', headers: { 'x-csrf-token': s.me.json().csrf }, body: { current: shop.owner.password, password: 'operator-chose-1', next: 'operator-chose-1' } }); // secret-scan:allow (a made-up value)
  assert.ok([401, 403, 404].includes(password.status), `changing the owner’s password answered ${password.status}`);
  assert.deepEqual(await sql(app, 'SELECT password_hash FROM users WHERE id = $1', [owner.id]), [before], 'F-45: the owner’s credentials are untouched');

  // Every request is on the audit log with both ids, refusals included, and nothing personal in it.
  const rows = await sql(app, `SELECT actor, action, target, details FROM audit_log WHERE tenant_id = $1 AND action = 'impersonation.request' ORDER BY id`, [shop.tenant.id]);
  assert.ok(rows.length >= 15, `${rows.length} audit rows`);
  for (const row of rows) assert.deepEqual([row.actor, row.details.operatorId, row.details.ownerId, row.details.impersonationId], [`platform:${support.id}`, support.id, owner.id, Number(imp.id)]);
  assert.deepEqual(rows.find((row) => row.target === 'settings.update').details.status, 403);
  assert.deepEqual(rows.find((row) => row.target === 'products.list').details.status, 200);
  assert.doesNotMatch(JSON.stringify(rows), /9876543210|Asha/);

  // The session is the API's alone, stays in its business, and ends the moment the impersonation does (F-44).
  const page = await hit(app, '/account', { host: shop.host, cookie: s.cookie });
  assert.notEqual(page.status, 200, 'no page outside the API is reachable with it');
  assert.equal((await s.call('GET', '/products', undefined, { 'x-tenant-id': String(other.tenant.id) })).status, 403);
  assert.equal((await hit(app, '/api/v1/products', { host: other.host, cookie: s.cookie })).status, 401, 'another business’s address does not know the session');
  await sql(app, `UPDATE impersonation_sessions SET expires_at = started_at + interval '1 second' WHERE id = $1`, [imp.id]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const ended = await s.call('GET', '/products');
  assert.deepEqual([ended.status, ended.json.code], [401, 'unauthorized']);
  assert.equal((await s.call('GET', '/auth/me')).status, 401);
});

test('a service operator in the router: only the service’s routes, every write recorded with before and after, drafts on approve-first, and an end when the service lapses', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'lamps', name: 'Lamp House' });
  const lamp = await addProduct(shop, 'Brass lamp');
  const operator = await operatorRow(app, 'service_operator', 'Kiran');
  await sql(app, `INSERT INTO service_engagements (tenant_id, service) VALUES ($1, 'catalog_management')`, [shop.tenant.id]);
  await sql(app, `INSERT INTO tenant_features (tenant_id, feature, enabled) VALUES ($1, 'service.catalog_management', true)`, [shop.tenant.id]);
  const sitting = await one(app, `INSERT INTO service_sessions (tenant_id, operator_id, operator_name, service, task_ref) VALUES ($1, $2, 'Kiran', 'catalog_management', 'TASK-41') RETURNING id`, [shop.tenant.id, operator.id]);
  const s = await operatorSession(app, shop, { serviceSessionId: sitting.id });
  const changes = () => sql(app, 'SELECT id, route_id, target, state, before, after, request, task_ref, operator_id, service FROM service_changes WHERE tenant_id = $1 ORDER BY id', [shop.tenant.id]);

  assert.deepEqual((({ kind, service, taskRef, mode }) => [kind, service, taskRef, mode])(s.me.json().operator), ['service', 'catalog_management', 'TASK-41', 'direct']);
  assert.equal((await s.call('GET', '/products')).status, 200);
  assert.equal((await s.call('GET', `/products/${lamp.id}`)).status, 200);
  // F-91: keys, billing, payouts, staff, and every other service's routes are 403.
  for (const pathname of ['/billing', '/payment-settings', '/payment-account', '/team', '/orders', '/customers', '/automations', '/pages', '/settings', '/api-keys', '/audit-log']) {
    assert.deepEqual((({ status, json }) => [status, json.code])(await s.call('GET', pathname)), [403, 'service.out_of_scope'], pathname);
  }
  assert.equal((await s.call('PATCH', '/settings', {})).json.code, 'service.out_of_scope');

  // F-90: a price change is saved, recorded with the task and the value before and after, and audited.
  const saved = await s.call('PATCH', `/products/${lamp.id}`, { pricePaise: 45000 });
  assert.deepEqual([saved.status, saved.json.pricePaise], [200, 45000]);
  const [priced] = await changes();
  assert.deepEqual([priced.route_id, priced.target, priced.state, priced.task_ref, priced.operator_id, priced.service], ['products.update', String(lamp.id), 'applied', 'TASK-41', operator.id, 'catalog_management']);
  assert.deepEqual([priced.before.pricePaise, priced.after.pricePaise, priced.before.name], [10000, 45000, 'Brass lamp']);
  assert.deepEqual(priced.request.body, { pricePaise: 45000 });
  const [audit] = await sql(app, `SELECT actor, target, details FROM audit_log WHERE tenant_id = $1 AND action = 'service.change'`, [shop.tenant.id]);
  assert.deepEqual([audit.actor, audit.target, audit.details.changeId, audit.details.service, audit.details.taskRef, audit.details.state], [`platform:${operator.id}`, 'products.update', Number(priced.id), 'catalog_management', 'TASK-41', 'applied']);
  // Something made has no before; a refused write leaves no change behind.
  const made = await s.call('POST', '/products', { name: 'Clay pot', pricePaise: 25000 });
  assert.equal(made.status, 201);
  assert.equal((await s.call('POST', '/products', { name: '', pricePaise: 1 })).status, 400);
  const afterCreate = await changes();
  assert.equal(afterCreate.length, 2);
  assert.deepEqual([afterCreate[1].route_id, afterCreate[1].before, afterCreate[1].after.name, afterCreate[1].target], ['products.create', null, 'Clay pot', String(made.json.id)]);

  // F-93: on "approve first" nothing changes: the request waits as a draft with the thing as it stands.
  await withTenant(shop.tenant, () => app.db.query(`UPDATE service_engagements SET mode = 'approve_first' WHERE service = 'catalog_management'`));
  const draft = await s.call('PATCH', `/products/${lamp.id}`, { pricePaise: 99000 });
  assert.deepEqual([draft.status, draft.json.draft], [202, true]);
  assert.equal((await s.call('GET', `/products/${lamp.id}`)).json.pricePaise, 45000, 'the product is as it was');
  const waiting = (await changes()).at(-1);
  assert.deepEqual([Number(waiting.id), waiting.state, waiting.before.pricePaise, waiting.after, waiting.request.body.pricePaise], [draft.json.changeId, 'draft', 45000, null, 99000]);
  assert.equal((await s.call('PATCH', `/products/${lamp.id}`, { pricePaise: -5 })).status, 400, 'a draft is still a request the route would take');

  // F-92: the entitlement goes, and so does the work; the engagement ends, and the session is nobody's.
  await sql(app, `UPDATE tenant_features SET enabled = false WHERE tenant_id = $1 AND feature = 'service.catalog_management'`, [shop.tenant.id]);
  assert.deepEqual((({ status, json }) => [status, json.code])(await s.call('GET', '/products')), [403, 'service.ended']);
  await sql(app, `UPDATE tenant_features SET enabled = true WHERE tenant_id = $1 AND feature = 'service.catalog_management'`, [shop.tenant.id]);
  assert.equal((await s.call('GET', '/products')).status, 200);
  await sql(app, `UPDATE service_engagements SET active_to = now() WHERE tenant_id = $1`, [shop.tenant.id]);
  assert.equal((await s.call('GET', '/products')).status, 401);
  assert.equal((await s.call('PATCH', `/products/${lamp.id}`, { pricePaise: 1 })).status, 401);
  assert.equal((await changes()).length, 3, 'nothing was written after it lapsed');
});

test('the console host: its web app is served there and nowhere else, sign-in routes are public and not built, password sign-in is behind PASSWORD_LOGIN', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-console-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'platform.html'), '<!doctype html><title>Bhava Console</title><div id="root"></div>');
  fs.writeFileSync(path.join(dir, 'assets', 'platform-abc.js'), 'console.log(1)');
  const app = await startWorld(t, { overrides: { platformConsoleDir: dir } });
  const shop = await addBusiness(app, { slug: 'lamps', name: 'Lamp House' });

  const shell = await hit(app, '/console/health', { host: CONSOLE_HOST });
  assert.equal(shell.status, 200);
  assert.match(shell.text, /Bhava Console/);
  assert.match(shell.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(shell.headers['cache-control'], 'no-store');
  assert.equal((await hit(app, '/console/assets/platform-abc.js', { host: CONSOLE_HOST })).status, 200);
  assert.equal((await hit(app, '/console/assets/nope.js', { host: CONSOLE_HOST })).status, 404);
  assert.deepEqual((({ status, headers }) => [status, headers.location])(await hit(app, '/', { host: CONSOLE_HOST })), [302, '/console/']);
  // On a business's address there is no such thing.
  for (const pathname of ['/console/', '/console/assets/platform-abc.js', '/console/health']) {
    const res = await hit(app, pathname, { host: shop.host });
    assert.equal(res.status, 404, pathname);
    assert.equal(res.text.includes('Bhava Console'), false);
  }

  // The three sign-in routes answer with nobody signed in; everything else needs a platform session and the role.
  for (const id of ['platform.signInStart', 'platform.signInVerify', 'platform.signInTotp']) {
    const res = await hit(app, platformRoutes[id].path, { host: CONSOLE_HOST, method: 'POST', body: {} });
    assert.deepEqual([res.status, res.json().code], [501, 'not_implemented'], id);
    assert.equal((await hit(app, platformRoutes[id].path, { host: shop.host, method: 'POST', body: {} })).status, 404, `${id} does not exist on a business address`);
  }
  for (const id of Object.values(OPS_PLATFORM_OWNERS).flat().filter((x) => !platformRoutes[x].public)) {
    const route = platformRoutes[id];
    assert.equal((await hit(app, route.path.replace(':id', '1'), { host: CONSOLE_HOST, method: route.method, body: route.method === 'GET' ? undefined : {} })).status, 401, id);
  }
  const admin = await consoleUser(app);
  const worker = await consoleUser(app, 'service_operator');
  assert.equal((await onConsole(app, worker, '/me')).json().user.role, 'service_operator');
  assert.equal((await onConsole(app, worker, '/tenant-health')).status, 403, 'a service operator has no health console');
  assert.equal((await onConsole(app, worker, '/tenants', { method: 'POST', body: {} })).status, 403, 'nor may one create a business');
  assert.equal((await onConsole(app, worker, '/services')).status, 501);
  assert.equal((await onConsole(app, admin, '/tenant-health')).status, 501);
  assert.equal((await onConsole(app, admin, '/impersonations')).status, 501);
  assert.equal((await onConsole(app, admin, `/tenants/${shop.tenant.id}/onboarding`)).status, 501);
  // F-25 both ways: a platform session means nothing on a business's address, and an owner's credentials nothing on the console.
  assert.equal((await hit(app, '/api/v1/auth/me', { host: shop.host, cookie: admin.cookie })).status, 401);
  assert.equal((await hit(app, '/login', { host: CONSOLE_HOST, method: 'POST', body: { email: shop.owner.phone, password: shop.owner.password } })).status, 401);
  // A disabled account is signed out at once.
  await sql(app, 'UPDATE platform_users SET disabled_at = now() WHERE email = $1', [worker.email]);
  assert.equal((await onConsole(app, worker, '/me')).status, 401);

  const strict = await startWorld(t, { overrides: { passwordLogin: false, platformConsoleDir: dir } });
  await strict.platform.platformUsers.create({ email: 'a@team.example', password: 'console-pass-1', role: 'support' });
  assert.equal((await hit(strict, '/login', { host: CONSOLE_HOST, method: 'POST', body: { email: 'a@team.example', password: 'console-pass-1' } })).status, 404, 'no password sign-in without PASSWORD_LOGIN');
});

test('the providers: a linked account’s KYC states with Razorpay’s reason, and a pickup location on the master Shiprocket account', async (t) => {
  const razorpaySim = createRazorpaySim();
  await razorpaySim.start();
  t.after(() => razorpaySim.close());
  const { route } = createRazorpay({ razorpayBaseUrl: razorpaySim.url, razorpayKeyId: razorpaySim.keyId, razorpayKeySecret: razorpaySim.keySecret }, { env: {} });
  const account = await route.createLinkedAccount({ email: 'owner@lamps.example', phone: '9000000001', legalName: 'Lamp House', businessType: 'proprietorship', contactName: 'Ravi', reference: 'tenant-1' });
  assert.deepEqual([account.status, account.reason], ['created', '']);
  assert.match((await route.kycLink(account.id)).url, /^https:\/\//);
  for (const state of ['under_review', 'needs_clarification', 'rejected', 'activated']) assert.ok(KYC_STATES.includes(state));
  // F-78: rejected for a bank name mismatch: the reason is Razorpay's own.
  await razorpaySim.post('/accounts/kyc', { id: account.id, status: 'needs_clarification', reason: 'The bank account name does not match the business name.', webhook: false });
  assert.deepEqual(await route.fetchLinkedAccount(account.id), { id: account.id, status: 'needs_clarification', reason: 'The bank account name does not match the business name.' });
  await razorpaySim.post('/accounts/kyc', { id: account.id, status: 'rejected', reason: 'Bank name mismatch.', webhook: false });
  assert.deepEqual((({ status, reason }) => [status, reason])(await route.fetchLinkedAccount(account.id)), ['rejected', 'Bank name mismatch.']);
  await razorpaySim.post('/accounts/kyc', { id: account.id, status: 'activated', webhook: false });
  assert.deepEqual(await route.fetchLinkedAccount(account.id), { id: account.id, status: 'activated', reason: '' });
  await assert.rejects(() => route.kycLink(account.id), 'nothing left to complete on an active account');

  const shiprocketSim = createShiprocketSim({ users: [{ email: 'own@seller.test', password: 'own-password' }] });
  await shiprocketSim.start();
  t.after(() => shiprocketSim.close());
  const master = createShiprocket({ shiprocketBaseUrl: shiprocketSim.url, shiprocketEmail: 'sim@bhava.test', shiprocketPassword: 'sim-shiprocket-password' }, { env: {} });
  const address = { code: 'bhava-12', name: 'Ravi', phone: '9000000001', email: 'owner@lamps.example', line1: '12 Lake Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' };
  assert.deepEqual(await master.pickupLocations(), []);
  // F-80: the owner's pickup address becomes a pickup location on Bhava's account, under this business's code.
  assert.deepEqual(await master.addPickupLocation(address), { code: 'bhava-12' });
  assert.deepEqual((await master.pickupLocations()).map(({ code, pincode, city }) => [code, pincode, city]), [['bhava-12', '411001', 'Pune']]);
  assert.deepEqual(await master.addPickupLocation(address), { code: 'bhava-12' }, 'asked twice, it is there once');
  assert.equal((await master.pickupLocations()).length, 1);
  await assert.rejects(() => master.addPickupLocation({ ...address, pincode: '560001' }), 'a different address under the same code is refused');
  await master.addPickupLocation({ ...address, code: 'bhava-13', pincode: '560001' });
  assert.equal((await master.pickupLocations()).length, 2);
  const own = master.forAccount({ email: 'own@seller.test', password: 'own-password' });
  assert.deepEqual(await own.pickupLocations(), [], 'a seller’s own account sees none of the master account’s');
});

// What the Phase 5 account tracks build against: the requirement list, the module folders, the route contract and its
// flags, the tables, the pure rules, and the wiring in the shared files (the sign-in host, sessions, the fresh check,
// the minimum app version, PASSWORD_LOGIN).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as accounts from '../../../src/contracts/accounts.js';
import { AUTH_PATHS, CONSOLE_ONLY_ROUTES, CodeStarted, ERROR_STATUS, FRESH_ROUTES, GoogleStartQuery, OWNER_ONLY, ROUTE_FIELDS, assertRouteFields, routeList, routes } from '../../../src/contracts/api/index.js';
import { assertStartable, platformAppHostOf } from '../../../src/config.js';
import { MODULES } from '../../../src/modules/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { createWhatsApp } from '../../../tools/sim/whatsapp/index.mjs';
import * as helpers from '../../helpers.js';

const { APP_HOST, OWNER, startApp } = helpers;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));

/** Which module answers each Phase 5 route. */
const ACCOUNTS = ['auth.start', 'auth.verify', 'auth.exchange', 'auth.apple', 'auth.refresh', 'auth.devices', 'auth.revokeDevice', 'auth.reauthStart', 'auth.reauthVerify', 'auth.enableDeviceUnlock', 'auth.linkIdentity', 'auth.deleteAccount', 'app.requirements'];
const TEAM = ['team.list', 'team.invite', 'team.update', 'team.remove'];
const PHASE0_AUTH = ['auth.login', 'auth.me', 'auth.logout', 'auth.businesses'];
const NO_BUSINESS = ['auth.start', 'auth.verify', 'auth.exchange', 'auth.apple', 'auth.refresh', 'app.requirements'];
const FRESH = [
  'auth.enableDeviceUnlock', 'auth.linkIdentity', 'auth.deleteAccount', 'team.invite', 'team.update', 'team.remove',
  'settings.updatePayment', 'paymentAccount.startLinked', 'paymentAccount.connectUrl', 'paymentAccount.setMode', 'paymentAccount.disconnect',
  'shippingSettings.update', 'shopify.connect', 'shopify.disconnect', 'whatsappAccount.connect', 'whatsappAccount.disconnect', 'tags.update', 'apiKeys.create', 'apiKeys.revoke',
];
const PLATFORM_TABLES = ['people', 'person_identities', 'seller_login_codes', 'token_families', 'refresh_tokens', 'auth_devices', 'auth_handoffs', 'review_logins', 'review_login_uses', 'account_deletion_requests', 'app_min_versions'];

test('requirements/p5.json lists the 46 Phase 5 scenarios once, with short titles, and I-02 waits in later.json', () => {
  const requirements = readJson('requirements/p5.json');
  const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${String(from + i).padStart(2, '0')}`);
  const expected = [...range('P', 2, 26), 'P-67', 'P-68', 'P-69', 'I-01', ...range('F', 46, 50), 'F-109', 'F-110', 'F-111', ...range('F', 56, 59), 'F-87', 'F-88', 'F-89', 'F-117', 'F-118'];
  assert.equal(expected.length, 46);
  assert.deepEqual(requirements.map((r) => r.id).sort(), [...expected].sort());
  for (const r of requirements) {
    assert.deepEqual(Object.keys(r), ['id', 'title']);
    assert.ok(r.title.length > 0 && r.title.length <= 80, r.id);
  }
  for (const earlier of ['p0', 'p1', 'p2', 'p3', 'p4']) {
    const theirs = readJson(`requirements/${earlier}.json`).map((r) => r.id);
    assert.deepEqual(expected.filter((id) => theirs.includes(id)), [], `no id is also in ${earlier}.json`);
  }
  const later = readJson('requirements/later.json').find((r) => r.id === 'I-02');
  assert.equal(later?.reason, 'needs an Apple Developer account and TestFlight');
  assert.equal(expected.includes('I-02') || expected.includes('P-01') || expected.includes('I-03'), false, 'P-01 and I-03 are Phase 6');
});

test('accounts, team and demo-tenant each have a folder, listed before api-auth', () => {
  const names = MODULES.map((m) => m.name);
  for (const name of ['accounts', 'team', 'demo-tenant']) {
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules', name, 'index.js')), name);
    assert.ok(names.includes(name), name);
    assert.ok(names.indexOf(name) < names.indexOf('api-auth'), `${name} before api-auth`);
    assert.ok(names.indexOf(name) > names.indexOf('audit'), `${name} after audit, which it writes to`);
  }
});

test('every Phase 5 route belongs to the module named for it, and every route in the contract has exactly one answer', () => {
  // The running app built its router from every module's answers, which refuses an id two modules answer or one the
  // contract does not have. What is left to check is who answers the account routes.
  const answers = new Map();
  for (const module of MODULES.filter((m) => ['accounts', 'team', 'demo-tenant', 'api-auth'].includes(m.name))) {
    for (const id of Object.keys(module.api?.({ repos: {}, config: {}, ig: {}, auth: {} }) ?? {})) {
      assert.equal(answers.has(id), false, `${id} is answered by both ${answers.get(id)} and ${module.name}`);
      answers.set(id, module.name);
    }
  }
  const phase5 = routeList.filter((r) => ['team', 'app'].includes(r.id.split('.')[0]) || (r.id.startsWith('auth.') && !PHASE0_AUTH.includes(r.id)));
  assert.deepEqual(phase5.map((r) => r.id).sort(), [...ACCOUNTS, ...TEAM].sort());
  for (const id of ACCOUNTS) assert.equal(answers.get(id), 'accounts', id);
  for (const id of TEAM) assert.equal(answers.get(id), 'team', id);
  for (const id of PHASE0_AUTH) assert.equal(answers.get(id), 'api-auth', `${id} stays with api-auth`);
  assert.equal(answers.size, ACCOUNTS.length + TEAM.length + PHASE0_AUTH.length, 'and they answer nothing else');
  // The client's test walks every route with one id in the path at most.
  for (const route of phase5) assert.ok((route.path.match(/:/g) ?? []).length <= 1 && (!route.path.includes(':') || route.path.includes(':id')), route.id);
});

test('the route flags: fresh on every key, credential, role and deletion; no business only before sign-in; never web-only', () => {
  assert.deepEqual([...FRESH_ROUTES].sort(), [...FRESH].sort());
  assert.deepEqual(routeList.filter((r) => r.noBusiness).map((r) => r.id).sort(), [...NO_BUSINESS].sort());
  for (const route of routeList) {
    if (route.noBusiness) assert.equal(route.access.public, true, `${route.id} is answered before sign-in, so it is public`);
    if (route.fresh) assert.notEqual(route.access.public, true, `${route.id} needs a session to be fresh`);
    for (const field of Object.keys(route)) assert.ok(field === 'id' || ROUTE_FIELDS.includes(field), `${route.id} has the unknown field ${field}`);
  }
  for (const id of TEAM) assert.equal(routes[id].access, OWNER_ONLY, `${id} is owner only: a manager is refused staff and roles`);

  // P-15: a web-only flag, however it is spelt, does not load.
  for (const flag of ['webOnly', 'web_only', 'webonly', 'web-only']) {
    assert.throws(() => assertRouteFields('orders.list', { ...routes['orders.list'], [flag]: true }), /route format does not have/, flag);
  }
  assert.throws(() => assertRouteFields('x.y', { ...routes['orders.list'], consoleOnly: 'yes' }), /true or absent/);
  assert.throws(() => assertRouteFields('x.y', { ...routes['orders.list'], noBusiness: true }), /must be PUBLIC/);
  assert.throws(() => assertRouteFields('x.y', { ...routes['auth.start'], fresh: true }), /no session to be fresh/);
  // Console-only is the one exemption from app parity, and nothing a seller uses carries it.
  assert.deepEqual(CONSOLE_ONLY_ROUTES, routeList.filter((r) => r.consoleOnly).map((r) => r.id));
  assert.deepEqual(CONSOLE_ONLY_ROUTES, []);
  assert.deepEqual([ERROR_STATUS.reauth_required, ERROR_STATUS.update_required], [403, 426]);
});

test('the sign-in shapes give nothing away and the browser routes are fixed', () => {
  // A bad phone is not a validation error: the answer is the same as for any number.
  assert.equal(routes['auth.start'].body.parse({ phone: 12345 }).phone, '');
  assert.equal(routes['auth.verify'].body.parse({ phone: '9876543210', code: ['x'], device: 'junk', transport: 'carrier-pigeon' }).transport, 'bearer');
  assert.equal(routes['auth.verify'].body.parse({ phone: '9876543210', code: '123456', device: { id: 'short', platform: 'android' } }).device, undefined);
  assert.deepEqual(Object.keys(CodeStarted.shape).sort(), ['alternatives', 'channel', 'expiresInSeconds', 'resendInSeconds', 'sent']);
  assert.equal(CodeStarted.safeParse({ sent: true, channel: 'sms', expiresInSeconds: 300, resendInSeconds: 30, alternatives: [] }).success, false, 'there is no SMS');
  assert.equal(routes['auth.deleteAccount'].body.safeParse({ confirm: 'delete' }).success, false);
  assert.equal(routes['team.update'].body.safeParse({}).success, false);
  assert.equal(routes['team.invite'].body.safeParse({ contact: '9876543210', role: 'admin' }).success, false);
  assert.deepEqual(AUTH_PATHS, { googleStart: '/auth/google/start', googleCallback: '/auth/google/callback', signIn: '/signin' });
  assert.equal(GoogleStartQuery.safeParse({ target: 'app' }).success, false, 'the app must send a PKCE challenge');
  assert.equal(GoogleStartQuery.safeParse({ target: 'app', challenge: accounts.pkceChallenge('v'.repeat(43)) }).success, true);
  assert.equal(GoogleStartQuery.safeParse({ target: 'web', next: '//evil.example' }).success, false);
});

test('the pure rules: codes, hashes, numbers, versions, PKCE and the review login', () => {
  assert.deepEqual([accounts.CODE_RULES.digits, accounts.CODE_RULES.ttlMs, accounts.CODE_RULES.maxAttempts, accounts.FRESH_MINUTES, accounts.HANDOFF_SECONDS], [6, 300_000, 5, 5, 60]);
  const codes = new Set(Array.from({ length: 200 }, () => accounts.newCode()));
  for (const code of codes) assert.match(code, /^\d{6}$/);
  assert.ok(codes.size > 190, 'codes are random');
  assert.equal(accounts.isCode('123456'), true);
  assert.equal(accounts.isCode('12345'), false);
  assert.equal(accounts.isCode(123456), false);

  const hash = accounts.codeHash('secret', { purpose: 'signin', subject: '+919876543210', code: '123456' });
  assert.notEqual(hash, accounts.codeHash('secret', { purpose: 'reauth', subject: '+919876543210', code: '123456' }), 'a sign-in code is not a re-auth code');
  assert.notEqual(hash, accounts.codeHash('secret', { purpose: 'signin', subject: '+919876543211', code: '123456' }), 'a code is for one number');
  assert.notEqual(hash, accounts.codeHash('other', { purpose: 'signin', subject: '+919876543210', code: '123456' }), 'the hash is keyed');
  assert.equal(hash.includes('123456'), false);
  assert.throws(() => accounts.codeHash('', { purpose: 'signin', subject: 'x', code: '1' }), /server secret/);
  assert.equal(accounts.subjectHash('s', 'email', ' Asha@Example.com '), accounts.subjectHash('s', 'email', 'asha@example.com'));
  assert.equal(accounts.sameSecret('abc', 'abc'), true);
  assert.equal(accounts.sameSecret('abc', 'abd'), false);
  assert.equal(accounts.sameSecret('abc', 'abcd'), false);
  assert.equal(accounts.sameSecret(undefined, ''), true);

  assert.equal(accounts.toE164('98765 43210'), '+919876543210');
  assert.equal(accounts.toE164('09876543210'), '+919876543210');
  assert.equal(accounts.toE164('+91 98765-43210'), '+919876543210');
  assert.equal(accounts.toE164('+1 (415) 555-0100'), '+14155550100');
  assert.equal(accounts.toE164('12345'), null);
  assert.equal(accounts.toE164('1234567890'), null, 'ten digits that are not an Indian mobile need a country code');
  assert.equal(accounts.localPhone('+919876543210'), '9876543210');
  assert.equal(accounts.localPhone('+14155550100'), null);
  assert.equal(accounts.maskPhone('+919876543210').includes('98765'), false);
  assert.equal(accounts.maskEmail('asha@example.com'), 'a•••@example.com');

  assert.equal(accounts.isBelowMinimum('1.0.0', '1.2.0'), true);
  assert.equal(accounts.isBelowMinimum('1.2.0', '1.2.0'), false);
  assert.equal(accounts.isBelowMinimum('1.10.0', '1.9.9'), false, 'numbers, not text');
  assert.equal(accounts.isBelowMinimum('2.0.0', '10.0.0'), true);
  assert.equal(accounts.isBelowMinimum('not-a-version', '1.0.0'), true, 'a version that cannot be read is too old');
  assert.equal(accounts.isBelowMinimum(undefined, '1.0.0'), true);
  assert.equal(accounts.isBelowMinimum('1.0.0', ''), false);

  const verifier = accounts.newToken(48);
  assert.equal(accounts.pkceMatches(verifier, accounts.pkceChallenge(verifier)), true);
  assert.equal(accounts.pkceMatches(`${verifier}x`, accounts.pkceChallenge(verifier)), false);
  assert.equal(accounts.pkceMatches('short', accounts.pkceChallenge('short')), false);

  const login = { phone: '+919000000099', enabled: true };
  assert.equal(accounts.reviewCodeProblem(login, { phone: '+919000000099', codeMatches: true }), '');
  assert.equal(accounts.reviewCodeProblem(login, { phone: '+919876543210', codeMatches: true }), 'wrong_number', 'F-50: the review code on another number');
  assert.equal(accounts.reviewCodeProblem({ ...login, enabled: false }, { phone: '+919000000099', codeMatches: true }), 'flag_off');
  assert.equal(accounts.reviewCodeProblem(login, { phone: '+919000000099', codeMatches: false }), 'wrong_code');
  assert.equal(accounts.reviewCodeProblem(null, { phone: '+919000000099', codeMatches: true }), 'wrong_number');
});

test('PASSWORD_LOGIN never starts in production, and the sign-in host is app.<PLATFORM_DOMAIN> unless set', () => {
  assert.throws(() => assertStartable({ passwordLogin: true }, { NODE_ENV: 'production' }), /PASSWORD_LOGIN/);
  assert.throws(() => assertStartable({ passwordLogin: true }, { NODE_ENV: ' Production ' }), /PASSWORD_LOGIN/);
  assert.doesNotThrow(() => assertStartable({ passwordLogin: false }, { NODE_ENV: 'production' }));
  assert.doesNotThrow(() => assertStartable({ passwordLogin: true }, { NODE_ENV: 'test' }));
  assert.equal(platformAppHostOf({ platformDomain: 'Shops.Example' }), 'app.shops.example');
  assert.equal(platformAppHostOf({ platformDomain: 'shops.example', platformAppHost: 'business.example' }), 'business.example');
  assert.equal(platformAppHostOf({}), '');
  const example = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  for (const name of ['PASSWORD_LOGIN', 'PLATFORM_APP_HOST', 'SELLER_GOOGLE_CLIENT_ID', 'SELLER_GOOGLE_CLIENT_SECRET', 'GOOGLE_KEYS_BASE_URL', 'APPLE_SIGNIN_AUDIENCES', 'APPLE_KEYS_BASE_URL', 'ACCESS_TOKEN_MINUTES', 'REFRESH_TOKEN_DAYS', 'REVIEW_LOGIN_PHONE', 'REVIEW_LOGIN_CODE_HASH']) {
    assert.match(example, new RegExp(`^#? ?${name}=`, 'm'), name);
  }
});

// ---- the wiring, against a running app ----

let app;
let ownerId;
const onAppHost = (headers = {}) => ({ 'x-forwarded-host': APP_HOST, ...headers });
const call = async (target, pathname, { method = 'GET', headers = {}, body } = {}) => {
  const res = await fetch(`${target.base}${pathname}`, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
};

/** A person with one refresh family, and an access session for the owner in it: what a sign-in from the app leaves behind. */
async function accessSession(target, { fresh = true, minutes = 15, userId = ownerId } = {}) {
  const [person] = await target.db.platform.query(`INSERT INTO people (name) VALUES ('Asha') RETURNING id`);
  const [family] = await target.db.platform.query(`INSERT INTO token_families (subject_kind, person_id, device_id) VALUES ('user', $1, 'device-0123456789abcdef') RETURNING id`, [person.id]);
  const token = await target.repos.sessions.createAccess(userId, { familyId: family.id, deviceId: 'device-0123456789abcdef', minutes, fresh });
  return { token, familyId: family.id, personId: person.id, bearer: { authorization: `Bearer ${token}` } };
}

before(async () => {
  app = await startApp();
  ownerId = (await app.repos.users.findByPhone(OWNER.phone)).id;
});
after(() => app?.close());

test('the account tables are the platform\'s alone, and the database holds their rules', async () => {
  const { db, tenant } = app;
  const rows = await db.platform.query(
    `SELECT c.relname AS name, has_table_privilege('bhava_app', c.oid, 'SELECT') AS app_reads, has_table_privilege('bhava_app', c.oid, 'INSERT') AS app_writes, c.relrowsecurity AS fenced
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const name of PLATFORM_TABLES) {
    assert.ok(byName.get(name), `${name} exists`);
    assert.deepEqual([byName.get(name).app_reads, byName.get(name).app_writes], [false, false], `${name}: business code cannot touch it`);
  }
  assert.deepEqual([byName.get('team_invites').app_reads, byName.get('team_invites').fenced], [true, true], 'team_invites is a business table, fenced');
  await assert.rejects(() => withTenant(tenant, () => db.query('SELECT 1 FROM people')), /permission denied/);
  await assert.rejects(() => withTenant(tenant, () => db.query('SELECT 1 FROM refresh_tokens')), /permission denied/);

  const columns = await db.platform.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('users', 'sessions', 'tenants')`);
  const has = (table, column) => columns.some((c) => c.table_name === table && c.column_name === column);
  for (const [table, column] of [['users', 'person_id'], ['users', 'removed_at'], ['sessions', 'family_id'], ['sessions', 'device_id'], ['sessions', 'fresh_until'], ['tenants', 'account_type']]) assert.ok(has(table, column), `${table}.${column}`);
  assert.equal((await db.platform.query('SELECT account_type FROM tenants WHERE id = $1', [tenant.id]))[0].account_type, 'seller');
  await assert.rejects(() => db.platform.query(`UPDATE tenants SET account_type = 'agency' WHERE id = $1`, [tenant.id]), /check/);

  const sql = (text, params) => db.platform.query(text, params);
  const [person] = await sql(`INSERT INTO people (name) VALUES ('P') RETURNING id`);
  const [other] = await sql(`INSERT INTO people (name) VALUES ('Q') RETURNING id`);
  await sql(`INSERT INTO person_identities (person_id, kind, subject, verified_at) VALUES ($1, 'phone', '+919876500001', now())`, [person.id]);
  await assert.rejects(() => sql(`INSERT INTO person_identities (person_id, kind, subject, verified_at) VALUES ($1, 'phone', '+919876500001', now())`, [other.id]), /unique|duplicate/, 'one number is one person');
  await assert.rejects(() => sql(`INSERT INTO person_identities (person_id, kind, subject, verified_at) VALUES ($1, 'phone', '9876500002', now())`, [other.id]), /check/, 'phone numbers are E.164');
  await assert.rejects(() => sql(`INSERT INTO person_identities (person_id, kind, subject, verified_at) VALUES ($1, 'sms', 'x', now())`, [other.id]), /check/);
  await assert.rejects(() => sql(`INSERT INTO person_identities (person_id, kind, subject) VALUES ($1, 'google', 'g-1')`, [other.id]), /null/, 'an identity is always a verified one');

  const [code] = await sql(`INSERT INTO seller_login_codes (subject_hash, code_hash, purpose, attempts, expires_at) VALUES ('s', 'c', 'signin', 5, now() + interval '5 minutes') RETURNING id`);
  await assert.rejects(() => sql('UPDATE seller_login_codes SET attempts = attempts + 1 WHERE id = $1', [code.id]), /check/, 'a sixth wrong try cannot be recorded');
  await assert.rejects(() => sql(`INSERT INTO seller_login_codes (subject_hash, code_hash, purpose, expires_at) VALUES ('s', 'c', 'reauth', now())`), /check/, 're-auth and link codes belong to a person');
  await assert.rejects(() => sql(`INSERT INTO seller_login_codes (subject_hash, code_hash, purpose, expires_at) VALUES ('s', 'c', 'sms', now())`), /check/);

  await assert.rejects(() => sql(`INSERT INTO token_families (subject_kind, device_id) VALUES ('user', 'd')`), /check/, 'a seller family belongs to a person');
  await assert.rejects(() => sql(`INSERT INTO token_families (subject_kind, shopper_id) VALUES ('shopper', 1)`), /check/, 'a shopper family belongs to a business');
  const [family] = await sql(`INSERT INTO token_families (subject_kind, person_id) VALUES ('user', $1) RETURNING id`, [person.id]);
  await assert.rejects(() => sql('UPDATE token_families SET revoked_at = now() WHERE id = $1', [family.id]), /check/, 'a revoked family says why');
  await assert.rejects(() => sql(`UPDATE token_families SET revoked_at = now(), revoke_reason = 'bored' WHERE id = $1`, [family.id]), /check/);
  await sql(`INSERT INTO refresh_tokens (family_id, token_hash, expires_at) VALUES ($1, 'h1', now() + interval '60 days')`, [family.id]);
  await assert.rejects(() => sql(`INSERT INTO refresh_tokens (family_id, token_hash, expires_at) VALUES ($1, 'h1', now() + interval '60 days')`, [family.id]), /unique|duplicate/);
  await assert.rejects(() => withTenant(tenant, () => db.query(`INSERT INTO sessions (id, tenant_id, user_id, kind, expires_at) VALUES ('no-family', $1, $2, 'access', now() + interval '15 minutes')`, [tenant.id, ownerId])), /check/, 'an access session belongs to a family');

  await sql(`INSERT INTO auth_devices (person_id, device_id, platform) VALUES ($1, 'device-0123456789abcdef', 'android')`, [person.id]);
  await assert.rejects(() => sql(`INSERT INTO auth_devices (person_id, device_id, platform) VALUES ($1, 'device-0123456789abcdef', 'ios')`, [person.id]), /unique|duplicate/);
  await assert.rejects(() => sql(`INSERT INTO auth_handoffs (code_hash, person_id, challenge, expires_at) VALUES ('h', $1, 'too-short', now())`, [person.id]), /check/);
  await sql(`INSERT INTO account_deletion_requests (person_id, due_at) VALUES ($1, now() + interval '30 days')`, [person.id]);
  await assert.rejects(() => sql(`INSERT INTO account_deletion_requests (person_id, due_at) VALUES ($1, now() + interval '30 days')`, [person.id]), /unique|duplicate/, 'one open request per person');
  await assert.rejects(() => sql(`INSERT INTO review_login_uses (subject_hash, accepted, reason) VALUES ('s', true, 'wrong_number')`), /check/);
  await assert.rejects(() => sql(`INSERT INTO app_min_versions (app, platform, min_version, store_url, tenant_id) VALUES ('owner', 'android', '1.0.0', 'https://x.example', $1)`, [tenant.id]), /check/, 'the owner app belongs to no business');
  await assert.rejects(() => sql(`INSERT INTO app_min_versions (app, platform, min_version, store_url) VALUES ('shopper', 'android', '1.0.0', 'https://x.example')`), /check/);

  // An invitation cannot name another business's user, and holds a hash, never the contact.
  await withTenant(tenant, () => db.query(`INSERT INTO team_invites (tenant_id, contact_kind, contact_hash, role, permissions, token_hash, invited_by, expires_at) VALUES ($1, 'phone', 'ch', 'staff', '{orders}', 'th', $2, now() + interval '7 days')`, [tenant.id, ownerId]));
  await assert.rejects(() => withTenant(tenant, () => db.query(`INSERT INTO team_invites (tenant_id, contact_kind, contact_hash, role, token_hash, invited_by, expires_at) VALUES ($1, 'phone', 'ch', 'manager', 'th2', $2, now() + interval '7 days')`, [tenant.id, ownerId])), /unique|duplicate/, 'one open invitation per contact');
  await assert.rejects(() => withTenant(tenant, () => db.query(`INSERT INTO team_invites (tenant_id, contact_kind, contact_hash, role, permissions, token_hash, invited_by, expires_at) VALUES ($1, 'email', 'e', 'manager', '{orders}', 'th3', $2, now() + interval '7 days')`, [tenant.id, ownerId])), /check/, 'only staff carry permissions');
  await assert.rejects(() => withTenant(tenant, () => db.query(`INSERT INTO team_invites (tenant_id, contact_kind, contact_hash, role, token_hash, invited_by, expires_at) VALUES ($1, 'email', 'e2', 'staff', 'th4', 999999, now() + interval '7 days')`, [tenant.id])), /foreign key|fkey/);
});

test('the sign-in host belongs to no business: only the routes that need none are answered before sign-in', async () => {
  assert.equal(platformAppHostOf(app.config), APP_HOST);
  // Reached with no business at all. The answer is the accounts module's own (a 501 until its track builds it): never 401, 404 or a fault.
  for (const [method, pathname, body] of [['POST', '/api/v1/auth/start', { phone: OWNER.phone }], ['POST', '/api/v1/auth/verify', { phone: OWNER.phone, code: '000000' }], ['POST', '/api/v1/auth/refresh', { refreshToken: 'x' }], ['GET', '/api/v1/app/requirements?platform=android']]) {
    const res = await call(app, pathname, { method, headers: onAppHost(), body });
    assert.equal([401, 403, 404, 500].includes(res.status), false, `${pathname} answered ${res.status}`);
  }
  // Everything else needs a session there: the default business does not answer on this host.
  for (const pathname of ['/api/v1/auth/me', '/api/v1/products', '/api/v1/settings', '/api/v1/team']) {
    const res = await call(app, pathname, { headers: onAppHost() });
    assert.deepEqual([res.status, res.json.code], [401, 'unauthorized'], pathname);
  }
  assert.equal((await call(app, '/api/v1/nothing-here', { headers: onAppHost() })).status, 404);
  assert.equal((await call(app, '/', { headers: onAppHost() })).status, 404, 'no store on the sign-in host');
  assert.equal((await call(app, '/media/anything', { headers: onAppHost() })).status, 404);
  assert.ok([200, 503].includes((await call(app, '/admin', { headers: onAppHost() })).status), 'the console shell is served there (503 until it is built)');
  // The same routes on a business's own address.
  assert.equal([401, 403, 404, 500].includes((await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone: OWNER.phone } })).status), false);
});

test('an access token names its business on any host, is looked up every time, and ends with its family', async () => {
  const session = await accessSession(app);
  for (const headers of [onAppHost(session.bearer), session.bearer]) {
    const me = await call(app, '/api/v1/auth/me', { headers });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.id, ownerId);
    assert.equal(me.json.business.accountType, 'seller');
    assert.ok(Date.parse(me.json.freshUntil) > Date.now(), 'a sign-in counts as a re-auth');
    assert.equal(me.json.csrf, undefined, 'CSRF is for cookie sessions only');
  }
  assert.equal((await call(app, '/api/v1/orders', { headers: onAppHost(session.bearer) })).status, 200, 'the session works in its business from the sign-in host');
  // Each token works only as its own kind.
  assert.equal((await call(app, '/api/v1/auth/me', { headers: { cookie: `sid=${session.token}` } })).status, 401);
  assert.equal((await call(app, '/api/v1/auth/me', { headers: onAppHost({ cookie: `sid=${session.token}` }) })).status, 401);
  assert.equal((await call(app, '/api/v1/auth/me', { headers: { authorization: 'Bearer made-up' } })).status, 401);
  // A cookie that cannot be decoded is no session, on either host: never a server fault.
  for (const headers of [{ cookie: 'sid=%E0%A4%A' }, onAppHost({ cookie: 'sid=%E0%A4%A' })]) assert.equal((await call(app, '/api/v1/auth/me', { headers })).status, 401);

  // P-08: revoking the family ends the session on the very next request.
  await app.db.platform.query(`UPDATE token_families SET revoked_at = now(), revoke_reason = 'device_revoked' WHERE id = $1`, [session.familyId]);
  assert.equal((await call(app, '/api/v1/auth/me', { headers: onAppHost(session.bearer) })).status, 401);

  // P-04: an expired access token is a 401.
  const short = await accessSession(app);
  await app.db.platform.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE family_id = $1`, [short.familyId]);
  assert.deepEqual([(await call(app, '/api/v1/orders', { headers: short.bearer })).status], [401]);

  // Signing out of the app ends the whole family.
  const leaving = await accessSession(app);
  assert.equal((await call(app, '/api/v1/auth/logout', { method: 'POST', headers: onAppHost(leaving.bearer) })).status, 204);
  assert.equal((await call(app, '/api/v1/auth/me', { headers: onAppHost(leaving.bearer) })).status, 401);
  const [family] = await app.db.platform.query('SELECT revoked_at, revoke_reason FROM token_families WHERE id = $1', [leaving.familyId]);
  assert.ok(family.revoked_at);
  assert.equal(family.revoke_reason, 'signed_out');
});

test('routes marked fresh answer reauth_required once the last re-auth is over five minutes old', async () => {
  const session = await accessSession(app);
  const headers = onAppHost(session.bearer);
  const unlock = () => call(app, '/api/v1/auth/device-unlock', { method: 'POST', headers });
  const removeMember = () => call(app, '/api/v1/team/999', { method: 'DELETE', headers });
  // Fresh: the request reaches its module (a 501 until the track builds it), whatever that then answers.
  const reached = (res) => res.json?.code !== 'reauth_required' && res.status !== 401;
  assert.ok(reached(await unlock()));
  assert.ok(reached(await removeMember()));

  await app.db.platform.query(`UPDATE sessions SET fresh_until = now() - interval '1 second' WHERE family_id = $1`, [session.familyId]);
  for (const res of [await unlock(), await removeMember(), await call(app, '/api/v1/settings/payment', { method: 'PATCH', headers, body: { upiId: 'shop@upi' } })]) {
    assert.deepEqual([res.status, res.json.code], [403, 'reauth_required']);
  }
  assert.equal((await call(app, '/api/v1/auth/me', { headers })).json.freshUntil !== null, true);
  assert.equal((await call(app, '/api/v1/orders', { headers })).status, 200, 'everything else still works');

  // A re-auth makes it fresh again.
  const until = await app.repos.sessions.markFresh(session.token);
  assert.ok(new Date(until).getTime() > Date.now() + 4 * 60_000);
  assert.ok(reached(await unlock()));

  // A session from a plain refresh proves only that the device holds its token: never fresh.
  const refreshed = await accessSession(app, { fresh: false });
  assert.equal((await call(app, '/api/v1/auth/device-unlock', { method: 'POST', headers: refreshed.bearer })).json.code, 'reauth_required');
  assert.equal((await call(app, '/api/v1/auth/me', { headers: refreshed.bearer })).json.freshUntil, null);

  // Who may call comes first: the answer to someone who may not is never "re-auth and try again".
  await app.db.platform.query(`UPDATE sessions SET fresh_until = NULL WHERE family_id = $1`, [session.familyId]);
  assert.ok(reached(await call(app, '/api/v1/team', { headers })), 'reading the team needs no re-auth');
});

test('an app below the minimum version gets 426 with the store link (P-07)', async () => {
  const session = await accessSession(app);
  const storeUrl = 'https://play.google.com/store/apps/details?id=example.business';
  await app.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '1.2.0', storeUrl });
  const as = (version, platform = 'android', name = 'owner') => onAppHost({ ...session.bearer, 'x-app': name, 'x-app-version': version, 'x-app-platform': platform });

  const old = await call(app, '/api/v1/orders', { headers: as('1.0.0') });
  assert.deepEqual([old.status, old.json.code, old.json.storeUrl], [426, 'update_required', storeUrl]);
  assert.match(old.json.error, /Update required/);
  assert.equal((await call(app, '/api/v1/orders', { headers: as('1.2.0') })).status, 200);
  assert.equal((await call(app, '/api/v1/orders', { headers: as('1.10.0') })).status, 200);
  assert.equal((await call(app, '/api/v1/orders', { headers: as('garbage') })).status, 426, 'a version that cannot be read is too old');
  assert.equal((await call(app, '/api/v1/orders', { headers: as('1.0.0', 'ios') })).status, 200, 'no minimum is set for iOS');
  assert.equal((await call(app, '/api/v1/orders', { headers: onAppHost(session.bearer) })).status, 200, 'the web console names no app and is never refused');
  assert.equal((await call(app, '/api/v1/orders', { headers: as('1.0.0', 'android', 'toaster') })).status, 400);
  // Before sign-in too, and the one route an old app may still call says where to update.
  assert.equal((await call(app, '/api/v1/auth/start', { method: 'POST', headers: onAppHost({ 'x-app': 'owner', 'x-app-version': '1.0.0', 'x-app-platform': 'android' }), body: { phone: OWNER.phone } })).status, 426);
  assert.equal((await call(app, '/api/v1/app/requirements?platform=android', { headers: onAppHost({ 'x-app': 'owner', 'x-app-version': '1.0.0', 'x-app-platform': 'android' }) })).status !== 426, true);

  assert.deepEqual(await app.platform.appVersions.minimum({ app: 'owner', platform: 'android' }), { app: 'owner', tenantId: null, platform: 'android', minVersion: '1.2.0', storeUrl });
  await app.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '1.0.0', storeUrl });
  assert.equal((await call(app, '/api/v1/orders', { headers: as('1.0.0') })).status, 200, 'setting it again replaces it');
  await assert.rejects(() => app.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '1.0', storeUrl }), /version like/);
  await assert.rejects(() => app.platform.appVersions.set({ app: 'owner', platform: 'android', minVersion: '1.0.0', storeUrl: 'http://insecure.example' }), /https/);
  await assert.rejects(() => app.platform.appVersions.set({ app: 'shopper', platform: 'android', minVersion: '1.0.0', storeUrl }), /needs one/);
  assert.equal(await app.platform.appVersions.minimum({ app: 'shopper', platform: 'android' }), null);
});

test('a removed team member is nobody on the next request, on web and app (F-47)', async () => {
  const staff = await app.repos.users.create({ name: 'Staff Member', phone: '9000000077', password: 'staff-pass', role: 'staff' });
  await app.repos.users.setPermissions(staff.id, ['orders']);
  const appSide = await accessSession(app, { userId: staff.id });
  const cookie = `sid=${await app.repos.sessions.create(staff.id, 30)}`;
  assert.equal((await call(app, '/api/v1/orders', { headers: appSide.bearer })).status, 200);
  assert.equal((await call(app, '/api/v1/orders', { headers: { cookie } })).status, 200);
  assert.equal((await call(app, '/api/v1/orders', { headers: onAppHost({ cookie }) })).status, 200, 'a cookie session names its own business on the sign-in host');
  assert.equal((await call(app, '/api/v1/automations', { headers: appSide.bearer })).status, 403, 'F-46: staff with orders only');

  await withTenant(app.tenant, () => app.db.query('UPDATE users SET removed_at = now() WHERE tenant_id = $1 AND id = $2', [app.tenant.id, staff.id]));
  assert.equal((await call(app, '/api/v1/orders', { headers: appSide.bearer })).status, 401);
  assert.equal((await call(app, '/api/v1/orders', { headers: { cookie } })).status, 401);
  assert.equal((await call(app, '/api/v1/orders', { headers: onAppHost({ cookie }) })).status, 401);
  assert.equal(await app.repos.users.get(staff.id), null);
  assert.equal(await app.repos.users.verify('9000000077', 'staff-pass'), null, 'nor can they sign back in');
  assert.equal((await app.repos.users.listTeam()).some((u) => u.id === staff.id), false);
});

test('a cookie session on the sign-in host still needs its CSRF token for a change', async () => {
  const cookie = `sid=${await app.repos.sessions.create(ownerId, 30)}`;
  const me = await call(app, '/api/v1/auth/me', { headers: onAppHost({ cookie }) });
  assert.equal(me.status, 200);
  assert.ok(me.json.csrf);
  const change = (headers) => call(app, '/api/v1/settings', { method: 'PATCH', headers: onAppHost({ cookie, ...headers }), body: {} });
  assert.equal((await change({})).status, 403);
  assert.equal((await change({ 'x-csrf-token': 'wrong' })).status, 403);
  assert.notEqual((await change({ 'x-csrf-token': me.json.csrf })).status, 403);
  // Sign out there ends it.
  assert.equal((await call(app, '/api/v1/auth/logout', { method: 'POST', headers: onAppHost({ cookie, 'x-csrf-token': me.json.csrf }) })).status, 204);
  assert.equal((await call(app, '/api/v1/auth/me', { headers: onAppHost({ cookie }) })).status, 401);
});

test('with PASSWORD_LOGIN off there is no password route and the Phase 0 bearer token is dead; with it on both work', async () => {
  // On (the default under test): the Phase 0 login and its 30-day token.
  const withPassword = await call(app, '/api/v1/auth/login', { method: 'POST', body: { phone: OWNER.phone, password: OWNER.password } });
  assert.equal(withPassword.status, 201);
  assert.equal((await call(app, '/api/v1/auth/me', { headers: { authorization: `Bearer ${withPassword.json.token}` } })).status, 200);
  assert.equal(typeof (await helpers.login(app.base)).cookie, 'string', 'login() still works');

  const off = await startApp({ overrides: { passwordLogin: false } });
  try {
    const refused = await call(off, '/api/v1/auth/login', { method: 'POST', body: { phone: OWNER.phone, password: OWNER.password } });
    assert.deepEqual([refused.status, refused.json.code], [404, 'not_found']);
    assert.equal((await call(off, '/api/v1/auth/login', { method: 'POST', headers: onAppHost(), body: { phone: OWNER.phone, password: OWNER.password } })).status, 404);
    for (const pathname of ['/login', '/signup']) {
      const res = await fetch(`${off.base}${pathname}`, { method: 'POST', body: new URLSearchParams({ phone: OWNER.phone, password: OWNER.password, name: 'Someone' }), redirect: 'manual' });
      assert.equal(res.status, 404, pathname);
      assert.equal(res.headers.get('set-cookie'), null);
    }
    const offOwner = (await off.repos.users.findByPhone(OWNER.phone)).id;
    const old = await off.repos.sessions.create(offOwner, 30, 'bearer');
    assert.equal((await call(off, '/api/v1/auth/me', { headers: { authorization: `Bearer ${old}` } })).status, 401, 'the 30-day token works only while PASSWORD_LOGIN is on');
    // Access tokens and the console's cookie sessions do not depend on it.
    const session = await accessSession(off, { userId: offOwner });
    assert.equal((await call(off, '/api/v1/auth/me', { headers: session.bearer })).status, 200);
    const cookie = `sid=${await off.repos.sessions.create(offOwner, 30)}`;
    assert.equal((await call(off, '/api/v1/auth/me', { headers: { cookie } })).status, 200);
  } finally {
    off.close();
  }
});

test('the helpers sign in without a password: the code is read from the WhatsApp simulator', async () => {
  for (const name of ['login', 'signIn', 'appSession', 'sellerCodeFor', 'testDevice']) assert.equal(typeof helpers[name], 'function', name);
  const whatsapp = createWhatsApp({ token: 'platform-token' });
  await whatsapp.start();
  try {
    const send = (to, body) => fetch(`${whatsapp.url}/v21.0/1000/messages`, { method: 'POST', headers: { authorization: 'Bearer platform-token', 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to, ...body }) });
    const template = (code) => ({ type: 'template', template: { name: 'login_code', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }] } });
    assert.equal((await send('919876500011', template('111222'))).status, 200);
    assert.equal((await send('919876500012', template('333444'))).status, 200);
    assert.equal((await send('919876500011', template('555666'))).status, 200);
    assert.equal(await helpers.sellerCodeFor(whatsapp, '9876500011'), '555666', 'the newest code for that number');
    assert.equal(await helpers.sellerCodeFor(whatsapp, '+91 98765 00012'), '333444');
    await assert.rejects(() => helpers.sellerCodeFor(whatsapp, '9876500099'), /No WhatsApp message/);
    await assert.rejects(() => helpers.signIn(app.base, { phone: OWNER.phone }), /WhatsApp simulator/);
    assert.match(helpers.testDevice().id, accounts.DEVICE_ID);
  } finally {
    await whatsapp.close();
  }
});

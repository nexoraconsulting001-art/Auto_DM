// What the Platform Console tracks build against (PRD 5.5, 5.6, 5.8, 5.9, 5.10, 5.17): the rules for Bhava's own team as data,
// the service and reads fields of the route format, TOTP, the four module folders with one module per route, the two clients,
// and the second web app, which is never part of the seller bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_ROUTES, createPlatformClient } from '@bhava/api-client/platform';
import { platformRoutesSource } from '../../../scripts/gen-platform-routes.mjs';
import {
  ALWAYS_ON, CONTACTS_SHOWN_ON, ERROR_STATUS, IMPERSONATION_BLOCKED, IMPERSONATION_MINUTES, OPS_PLATFORM_OWNERS, OPS_ROUTE_OWNERS, PLATFORM_LOGIN, PLATFORM_ROLES, ROUTE_FIELDS, SERVICE_ROUTES, SERVICE_ROUTE_IDS,
  SHOPPER_CONTACT_FIELDS, assertRouteFields, impersonationBlocked, isContractRoute, maskContact, maskShopperContacts, operatorRefusal, platformRouteList, platformRoutes, routeList, routes,
} from '../../../src/contracts/api/index.js';
import { CHECK_EVERY_MS, CHECK_TIMEOUT_MS, HEALTH_CHECKS, compareHealth, ranRecently, statusFromDeductions, withinTimeout, worstOf } from '../../../src/contracts/health.js';
import { HEALTH_DEDUCTIONS } from '../../../src/contracts/analytics.js';
import { BILLING_FEATURES, PLANS } from '../../../src/contracts/billing.js';
import { INVITE_DAYS, KYC_STATES, KYC_STEP_STATUS, ONBOARDING_STEPS, STEP_CHECKS, checkoutOpenFor, onboardingDone, stepsFor } from '../../../src/contracts/onboarding.js';
import { CHANGE_STATES, MASKED, NEVER_A_SERVICE, SERVICES, canMoveChange, canUndoChange, maskSecrets, serviceFeature } from '../../../src/contracts/services.js';
import { MODULES } from '../../../src/modules/index.js';
import { base32Decode, base32Encode, codeForStep, generateRecoveryCodes, generateSecret, hashRecoveryCode, otpauthUrl, stepAt, verifyTotp } from '../../../src/modules/platform-console/totp.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const moduleNamed = (name) => MODULES.find((m) => m.name === name);
const OPS_MODULES = ['impersonation', 'managed-services', 'onboarding', 'tenant-health'];
const route = (id) => ({ id, ...routes[id] });

test('platform roles, and who may call what in the console', () => {
  assert.deepEqual(PLATFORM_ROLES, ['super_admin', 'support', 'onboarding', 'service_operator']);
  for (const r of platformRouteList) {
    assert.ok(r.platformRoles.every((role) => PLATFORM_ROLES.includes(role)), r.id);
    assert.equal(r.public === true, r.platformRoles.length === 0, `${r.id}: only the sign-in routes are answered with nobody signed in`);
  }
  assert.deepEqual(platformRouteList.filter((r) => r.public).map((r) => r.id), ['platform.signInStart', 'platform.signInVerify', 'platform.signInTotp']);
  // A service operator reaches the managed-services workspace and nothing else; onboarding reaches businesses and the workspace.
  const reach = (role) => platformRouteList.filter((r) => r.platformRoles.includes(role)).map((r) => r.id).sort();
  assert.deepEqual(reach('service_operator'), ['platform.me', 'platform.signOut', ...OPS_PLATFORM_OWNERS['managed-services']].sort());
  assert.deepEqual(reach('onboarding'), ['platform.me', 'platform.signOut', 'platform.businesses', 'platform.createBusiness', 'platform.business', 'platform.retryImport', 'platform.businessHealth', ...OPS_PLATFORM_OWNERS.onboarding].sort());
  for (const id of ['platform.impersonate', 'platform.impersonations', 'platform.confirmImpersonationWrite', 'platform.endImpersonation', 'platform.pauses', 'platform.health']) assert.deepEqual(platformRoutes[id].platformRoles, ['super_admin', 'support'], id);
  for (const id of ['platform.team', 'platform.addTeamMember', 'platform.updateTeamMember']) assert.deepEqual(platformRoutes[id].platformRoles, ['super_admin'], id);
  // Starting anything inside a business takes a reason or a task reference.
  assert.ok(platformRoutes['platform.impersonate'].body.shape.reason);
  assert.ok(platformRoutes['platform.confirmImpersonationWrite'].body.shape.reason && platformRoutes['platform.confirmImpersonationWrite'].body.shape.confirm);
  assert.equal(platformRoutes['platform.startServiceSession'].body.safeParse({ service: 'catalog_management', taskRef: '  ' }).success, false, 'no session without a task reference');
  assert.equal(platformRoutes['platform.pauseBusiness'].body.safeParse({ reason: '' }).success, false, 'F-36: no pause without a reason');
});

test('TOTP is RFC 6238, one code works once, and recovery codes are stored as hashes', () => {
  // The RFC's SHA-1 test secret ("12345678901234567890") and its vectors, at 6 digits.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(' gezd gnbv-gy3t qojq gezd gnbv gy3t qojq ').toString(), '12345678901234567890');
  for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']]) assert.equal(codeForStep(secret, stepAt(seconds * 1000)), code, String(seconds));
  assert.throws(() => base32Decode('not base32!'));

  const now = 1_700_000_000_000;
  const step = stepAt(now);
  assert.equal(verifyTotp(secret, codeForStep(secret, step), { now }), step);
  assert.equal(verifyTotp(secret, codeForStep(secret, step - 1), { now }), step - 1, 'a clock one step behind');
  assert.equal(verifyTotp(secret, codeForStep(secret, step + 1), { now }), step + 1);
  assert.equal(verifyTotp(secret, codeForStep(secret, step - 2), { now }), null, 'two steps is too old');
  assert.equal(verifyTotp(secret, codeForStep(secret, step), { now, afterStep: step }), null, 'the same code never works twice');
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) assert.equal(verifyTotp(secret, bad, { now }), null);

  const fresh = generateSecret();
  assert.match(fresh, /^[A-Z2-7]{32}$/);
  assert.notEqual(fresh, generateSecret());
  const url = new URL(otpauthUrl(fresh, 'asha@bhava.test'));
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.searchParams.get('secret'), fresh);
  assert.equal(url.searchParams.get('issuer'), PLATFORM_LOGIN.issuer);
  const codes = generateRecoveryCodes();
  assert.equal(new Set(codes).size, PLATFORM_LOGIN.recoveryCodes);
  for (const code of codes) assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(hashRecoveryCode('k', ` ${codes[0].toUpperCase()} `), hashRecoveryCode('k', codes[0]));
  assert.notEqual(hashRecoveryCode('k', codes[0]), hashRecoveryCode('other', codes[0]));
  assert.equal(platformRoutes['platform.signInTotp'].body.safeParse({ ticket: 't', code: codes[0] }).success, true, 'a recovery code is accepted where the authenticator code is');
  assert.equal(read('src/modules/platform-console/totp.js').includes("from 'node:crypto'"), true);
  assert.equal(Object.keys(JSON.parse(read('package.json')).dependencies).some((name) => /otp|speakeasy|authenticator/i.test(name)), false, 'no new dependency for TOTP');
});

test('impersonation: read-only unless confirmed, the blocked list, and shopper contacts masked outside order detail', () => {
  assert.equal(IMPERSONATION_MINUTES, 30);
  const reading = { kind: 'impersonation', mode: 'read' };
  const writing = { kind: 'impersonation', mode: 'write' };
  assert.equal(operatorRefusal(route('products.list'), reading), null);
  assert.equal(operatorRefusal(route('auth.me'), reading), null);
  assert.equal(operatorRefusal(route('auth.logout'), reading), null, 'ending the session is always allowed');
  // F-43: every write is refused in read mode, whatever the route.
  for (const r of routeList.filter((x) => x.method !== 'GET' && x.id !== 'auth.logout')) assert.ok(['impersonation.read_only', 'impersonation.blocked'].includes(operatorRefusal(r, reading)?.code), r.id);
  assert.equal(operatorRefusal(route('products.update'), writing), null);
  // F-45 and the rest of the list: refused in any mode.
  for (const id of ['billing.plan', 'billing.change', 'billing.invoices', 'team.list', 'team.invite', 'team.update', 'team.remove', 'auth.linkIdentity', 'auth.deleteAccount', 'auth.revokeDevice', 'settings.updatePayment', 'customers.resetPassword', 'apiKeys.create', 'paymentAccount.setMode', 'setup.ownKeys', 'services.saveSettings', 'teamFeed.undo']) {
    for (const operator of [reading, writing]) assert.equal(operatorRefusal(route(id), operator)?.code, 'impersonation.blocked', `${id} in ${operator.mode} mode`);
  }
  for (const r of routeList) {
    if (r.fresh) assert.equal(impersonationBlocked(r), true, `${r.id} is fresh: an operator cannot re-auth as the owner`);
    if (r.id.startsWith('billing.')) assert.equal(impersonationBlocked(r), true, r.id);
  }
  for (const id of IMPERSONATION_BLOCKED.routes) assert.ok(routes[id], `${id} is a route`);
  for (const group of IMPERSONATION_BLOCKED.groups) assert.ok(routeList.some((r) => r.id.startsWith(`${group}.`)), `${group} is a group of routes`);
  for (const code of ['impersonation.blocked', 'impersonation.read_only', 'service.out_of_scope', 'service.ended']) assert.equal(ERROR_STATUS[code], 403, code);

  // The session counts only on the contract's own routes.
  assert.deepEqual([isContractRoute('GET', '/api/v1/products?limit=5'), isContractRoute('PATCH', '/api/v1/Products/12/'), isContractRoute('POST', '/api/v1/auth/password'), isContractRoute('GET', '/api/v1/products/12/extra'), isContractRoute('GET', '/account'), isContractRoute('DELETE', '/api/v1/products')], [true, true, false, false, false, false]);

  assert.deepEqual(CONTACTS_SHOWN_ON, ['orders.get']);
  for (const field of ['phone', 'email', 'line1']) assert.ok(SHOPPER_CONTACT_FIELDS.includes(field), field);
  const shopper = { id: 7, name: 'Asha', phone: '+919876543210', email: 'asha.rao@example.com', address: { line1: '12 Lake Road', city: 'Pune', pincode: '411001' }, orders: [{ id: 1, customerPhone: '9876543210', totalPaise: 50000 }] };
  const masked = maskShopperContacts('customers.list', { items: [shopper], nextCursor: null });
  const text = JSON.stringify(masked);
  for (const secret of ['9876543210', 'asha.rao', '12 Lake Road']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual([masked.items[0].id, masked.items[0].name, masked.items[0].orders[0].totalPaise, masked.nextCursor], [7, 'Asha', 50000, null], 'nothing else changes');
  assert.equal(masked.items[0].email, 'a•••@example.com');
  assert.deepEqual(maskShopperContacts('orders.get', shopper), shopper, 'order detail shows them');
  assert.equal(maskContact(''), '');
  assert.equal(shopper.phone, '+919876543210', 'the answer itself is never changed');
});

test('managed services: the route format has service, reads and undo, each service has a fixed reach, and nothing sensitive is in it', () => {
  for (const field of ['service', 'reads', 'undo']) assert.ok(ROUTE_FIELDS.includes(field), field);
  const sample = { method: 'PATCH', path: '/x/:id', access: routes['products.update'].access, response: null };
  assert.throws(() => assertRouteFields('x.y', { ...sample, service: 'cleaning' }), /managed service/);
  assert.throws(() => assertRouteFields('x.y', { ...sample, service: 'catalog_management' }), /names the route that reads/);
  assert.throws(() => assertRouteFields('x.y', { ...sample, reads: 'products.get' }), /reads names a route/);
  assert.throws(() => assertRouteFields('x.y', { ...sample, service: 'catalog_management', reads: 'products.get', fresh: true }), /never be given/);
  assert.throws(() => assertRouteFields('billing.x', { ...sample, service: 'catalog_management', reads: 'products.get' }), /never be given/);
  assert.throws(() => assertRouteFields('x.y', { ...sample, access: routes['billing.plan'].access, service: 'catalog_management', reads: 'products.get' }), /never be given/, 'nothing that is the owner’s alone');
  assert.equal(assertRouteFields('x.y', { ...sample, service: ['catalog_management', 'merchandising'], reads: 'products.get' }).reads, 'products.get');

  assert.deepEqual(SERVICES, BILLING_FEATURES.services.map((name) => name.replace('service.', '')), 'one service per entitlement');
  assert.equal(serviceFeature('reel_management'), 'service.reel_management');
  for (const [id, fields] of Object.entries(SERVICE_ROUTES)) {
    assert.deepEqual([routes[id].service, routes[id].reads, routes[id].undo], [fields.service, fields.reads, fields.undo], id);
    const r = routes[id];
    if (r.method === 'GET') continue;
    const reads = routes[r.reads];
    assert.equal(reads.method, 'GET', `${id} reads a GET`);
    assert.ok([r.service].flat().every((s) => [reads.service].flat().includes(s)), `${id}: its service may read ${r.reads}`);
    if (r.undo) assert.ok(routes[r.undo].body && [r.service].flat().every((s) => [routes[r.undo].service].flat().includes(s)), `${id} is undone through a route its service may write`);
  }
  const groupsOf = (service) => [...new Set(SERVICE_ROUTE_IDS[service].map((id) => id.split('.')[0]))].sort();
  assert.deepEqual(groupsOf('catalog_management'), ['categories', 'products']);
  assert.deepEqual(groupsOf('reel_management'), ['automations', 'categories', 'reels']);
  assert.deepEqual(SERVICE_ROUTE_IDS.reel_backlog, SERVICE_ROUTE_IDS.reel_management);
  assert.deepEqual(groupsOf('merchandising'), ['categories', 'pageBlocks', 'pages', 'products']);
  assert.deepEqual(SERVICE_ROUTE_IDS.merchandising.filter((id) => routes[id].method !== 'GET').map((id) => id.split('.')[0]).filter((g, i, all) => all.indexOf(g) === i).sort(), ['pageBlocks', 'pages'], 'merchandising writes pages and blocks only');
  assert.deepEqual(SERVICE_ROUTE_IDS.performance_report, [], 'the report changes nothing in the business');
  assert.ok(!SERVICE_ROUTE_IDS.catalog_management.includes('categories.setReels') && !SERVICE_ROUTE_IDS.reel_management.includes('products.update'), 'each service keeps to its own scope');

  // F-91: keys, payouts, refunds, billing, staff and roles are never given a service, so a service operator gets 403 there.
  const operator = { kind: 'service', service: 'catalog_management', mode: 'direct' };
  for (const r of routeList) {
    const group = r.id.split('.')[0];
    if (NEVER_A_SERVICE.includes(group) || r.fresh) assert.equal(r.service, undefined, `${r.id} has no service`);
    if (!r.service && r.id !== 'auth.me' && r.id !== 'auth.logout') assert.equal(operatorRefusal(r, operator)?.code, 'service.out_of_scope', r.id);
  }
  for (const id of ['paymentSettings.get', 'paymentAccount.get', 'billing.plan', 'refunds.create', 'team.list', 'apiKeys.list', 'settlements.list', 'orders.list']) assert.equal(operatorRefusal(route(id), operator)?.code, 'service.out_of_scope', id);
  assert.equal(operatorRefusal(route('products.update'), operator), null);
  assert.equal(operatorRefusal(route('automations.update'), operator)?.code, 'service.out_of_scope', 'another service’s route');
  assert.equal(operatorRefusal(route('automations.setState'), { ...operator, service: 'reel_management' }), null, 'F-94: the automation routes themselves run, so the Compliance Engine decides as it does for the owner');
  assert.equal(operatorRefusal(route('products.list'), null), null, 'a seller is never affected');

  assert.deepEqual(CHANGE_STATES, ['applied', 'draft', 'approved', 'rejected', 'undone']);
  assert.deepEqual([canMoveChange('applied', 'undone'), canMoveChange('draft', 'approved'), canMoveChange('draft', 'undone'), canMoveChange('undone', 'applied'), canMoveChange('rejected', 'approved')], [true, true, false, false, false]);
  assert.deepEqual([canUndoChange({ state: 'applied', before: { a: 1 }, after: { a: 2 } }), canUndoChange({ state: 'applied', before: null, after: { a: 2 } }), canUndoChange({ state: 'undone', before: {}, after: {} }), canUndoChange({ state: 'draft', before: {}, after: null })], [true, false, false, false]);
  assert.deepEqual(maskSecrets({ name: 'Lamp', keySecret: 'rzp_live_x', nested: [{ accessToken: 't', pricePaise: 5 }], password: '', at: new Date(0) }), { name: 'Lamp', keySecret: MASKED, nested: [{ accessToken: MASKED, pricePaise: 5 }], password: '', at: '1970-01-01T00:00:00.000Z' });
});

test('onboarding: the checklist is filtered by tier, each step is done by a live check, and KYC decides checkout', () => {
  assert.equal(INVITE_DAYS, 7);
  for (const step of ONBOARDING_STEPS) for (const check of step.checks) assert.ok(STEP_CHECKS[check], `${step.step}: ${check} is a check`);
  assert.deepEqual(Object.keys(STEP_CHECKS).sort(), ['dns', 'pickup_location', 'provider_test_call', 'route_kyc', 'subscribed_apps', 'terms_accepted', 'token_scopes']);
  for (const check of Object.values(STEP_CHECKS)) assert.ok(check.timeoutMs <= 10_000);
  const view = (plan) => Object.fromEntries(stepsFor(plan).map((s) => [s.step, s.required]));
  // F-28: tier 1 needs Instagram and the terms; the domain is there and optional.
  assert.deepEqual(view('t1'), { instagram: true, terms: true, domain: false });
  assert.deepEqual(view('free'), view('t1'));
  assert.deepEqual(view('t2'), { instagram: true, terms: true, domain: true });
  // F-77: from tier 3 payments and shipping are steps, done on Bhava's accounts with no keys; own keys stay optional.
  assert.deepEqual(view('t3'), { instagram: true, terms: true, domain: true, payments: true, shipping: true, own_keys: false });
  assert.deepEqual(view('t5'), view('t3'));
  for (const plan of PLANS) assert.ok(stepsFor(plan).length >= 3, plan);
  assert.equal(onboardingDone('t1', { instagram: 'done', terms: 'done' }), true, 'an optional step never holds a business back');
  assert.equal(onboardingDone('t3', { instagram: 'done', terms: 'done', domain: 'done', payments: 'waiting', shipping: 'done' }), false);
  assert.equal(onboardingDone('t3', { instagram: 'done', terms: 'done', domain: 'done', payments: 'done', shipping: 'done' }), true);
  for (const state of ['created', 'needs_clarification', 'activated', 'rejected']) assert.ok(KYC_STATES.includes(state), state);
  assert.deepEqual(KYC_STATES.filter(checkoutOpenFor), ['activated'], 'checkout opens only on an active Route account');
  assert.deepEqual([KYC_STEP_STATUS.created, KYC_STEP_STATUS.under_review, KYC_STEP_STATUS.needs_clarification, KYC_STEP_STATUS.activated, KYC_STEP_STATUS.rejected], ['pending', 'waiting', 'failed', 'done', 'failed']);
  assert.equal(routes['setup.ownKeys'].fresh, true, 'keys need a re-auth');
  assert.equal(routes['setup.pickupAddress'].body.safeParse({ name: 'Asha', phone: '9876543210', line1: '12 Lake Road', city: 'Pune', state: 'Maharashtra', pincode: '41100' }).success, false);
});

test('health: the checks are data, worst first, with a 10 s timeout and at most one run every 10 minutes', async () => {
  assert.deepEqual([CHECK_TIMEOUT_MS, CHECK_EVERY_MS], [10_000, 600_000]);
  const used = Object.values(HEALTH_CHECKS).flatMap((check) => (check.deductions ? [...check.deductions.bad, ...check.deductions.warn] : []));
  assert.deepEqual([...used].sort(), Object.keys(HEALTH_DEDUCTIONS).sort(), 'every Account Health deduction is read by exactly one check, and no threshold is set here');
  for (const name of ['domain.dns', 'domain.tls', 'keys.payments', 'keys.shipping']) assert.ok(HEALTH_CHECKS[name], name);
  assert.equal(statusFromDeductions('account.token', ['token_rejected']), 'bad');
  assert.equal(statusFromDeductions('account.token', ['token_14d']), 'warn');
  assert.equal(statusFromDeductions('account.token', ['usage_75']), 'ok');
  assert.equal(HEALTH_CHECKS['keys.payments'].notifies, 'reconnect.payments', 'F-41: the owner is told to reconnect');
  assert.equal(worstOf(['ok', 'warn', 'unreachable']), 'unreachable');
  assert.equal(worstOf([]), 'ok');
  // F-39: three businesses with different scores, worst first.
  const list = [{ name: 'B', worst: 'ok', score: 90 }, { name: 'A', worst: 'ok', score: 40 }, { name: 'C', worst: 'bad', score: 95 }, { name: 'D', worst: 'ok', score: null }];
  assert.deepEqual([...list].sort(compareHealth).map((item) => item.name), ['C', 'A', 'B', 'D']);
  const now = Date.now();
  assert.deepEqual([ranRecently(new Date(now - 9 * 60_000), now), ranRecently(new Date(now - 11 * 60_000), now), ranRecently(null, now)], [true, false, false]);
  // F-40: a check that hangs is "unreachable" when its time is up, and one that throws is too. Neither rejects.
  const started = Date.now();
  assert.deepEqual(await withinTimeout(() => new Promise(() => {}), 40), { status: 'unreachable', detail: { reason: 'timeout' } });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await withinTimeout(() => { throw new Error('boom'); }, 40), { status: 'unreachable', detail: { reason: 'error' } });
  assert.deepEqual(await withinTimeout(async () => ({ status: 'ok', detail: {} }), 40), { status: 'ok', detail: {} });
});

test('the four folders exist after platform-console, and every new route has exactly one module', () => {
  const names = MODULES.map((m) => m.name);
  assert.deepEqual(names.slice(names.indexOf('platform-console'), names.indexOf('platform-console') + 5), ['platform-console', ...OPS_MODULES]);
  for (const name of OPS_MODULES) {
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules', name, 'index.js')), name);
    assert.ok(moduleNamed(name).owns, `${name} says what it owns`);
    assert.equal(typeof moduleNamed(name).platformRoutes, 'function', `${name} mounts its console routes`);
  }
  const sellerIds = routeList.filter((r) => ['teamFeed', 'services', 'setup'].includes(r.id.split('.')[0])).map((r) => r.id);
  assert.deepEqual([...sellerIds].sort(), Object.values(OPS_ROUTE_OWNERS).flat().sort());
  for (const id of ['teamFeed.list', 'teamFeed.undo', 'teamFeed.approve', 'teamFeed.reject', 'services.settings', 'setup.get', 'setup.check', 'setup.acceptTerms', 'setup.pickupAddress', 'setup.kycLink', 'setup.ownKeys']) assert.ok(routes[id], id);
  for (const id of sellerIds) assert.ok(ALWAYS_ON.includes(id), `${id} is on every plan`);
  for (const [owner, ids] of Object.entries(OPS_ROUTE_OWNERS)) {
    assert.deepEqual(Object.keys(moduleNamed(owner).api({})).sort(), [...ids].sort(), `${owner} answers its routes`);
    assert.deepEqual([...moduleNamed(owner).owns.api].sort(), [...ids].sort());
  }
  const consoleIds = Object.values(OPS_PLATFORM_OWNERS).flat();
  assert.equal(new Set(consoleIds).size, consoleIds.length);
  for (const id of consoleIds) assert.ok(platformRoutes[id], `${id} is a Platform Console route`);
  for (const name of OPS_MODULES) assert.deepEqual([...moduleNamed(name).owns.platform].sort(), [...OPS_PLATFORM_OWNERS[name]].sort(), name);
  // What the API router reads on every request of a session Bhava's team opened.
  const repos = Object.assign({}, ...['impersonation', 'managed-services'].map((name) => moduleNamed(name).repos({ query: async () => [] })));
  assert.deepEqual([typeof repos.impersonation.live, typeof repos.serviceSessions.live, typeof repos.serviceChanges.record], ['function', 'function', 'function']);
  const tables = OPS_MODULES.flatMap((name) => moduleNamed(name).owns.tables).sort();
  assert.deepEqual(tables, ['impersonation_sessions', 'onboarding_invites', 'onboarding_steps', 'onboarding_timings', 'service_changes', 'service_engagements', 'service_sessions', 'tenant_health_checks']);
});

test('createPlatformClient is built from the table: every console route, with its method and path', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify({ csrf: 'tok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // The plain table the page uses is the route table, field for field: run npm run gen:platform-routes after changing a platform route.
  assert.equal(read('shared/api-client/platform-routes.js'), platformRoutesSource(), 'shared/api-client/platform-routes.js is out of date');
  assert.deepEqual(Object.keys(PLATFORM_ROUTES), platformRouteList.map((r) => r.id));
  for (const r of platformRouteList) assert.deepEqual(PLATFORM_ROUTES[r.id], { method: r.method, path: r.path, platformRoles: [...r.platformRoles], ...(r.public ? { public: true } : {}) }, r.id);
  const client = createPlatformClient({ fetch });
  assert.deepEqual(Object.keys(client).sort(), platformRouteList.map((r) => r.id.replace('platform.', '')).sort());
  for (const r of platformRouteList) {
    calls.length = 0;
    await client[r.id.replace('platform.', '')]({ params: { id: 12 }, body: r.body ? { reason: 'x' } : undefined });
    assert.deepEqual([calls[0].method, calls[0].url], [r.method, r.path.replace(':id', '12')], r.id);
    assert.equal(calls[0].credentials, 'same-origin');
  }
  calls.length = 0;
  await client.me();
  await client.pauseBusiness({ params: { id: '1/../2' }, body: { reason: 'ticket 123' } });
  await client.businesses({ query: { limit: 5, cursor: '', search: undefined } });
  assert.equal(calls[1].url, '/tenants/1%2F..%2F2/pause');
  assert.equal(calls[1].headers['x-csrf-token'], 'tok', 'the token from me is sent on every change');
  assert.equal(calls[1].body, JSON.stringify({ reason: 'ticket 123' }));
  assert.deepEqual([calls[2].url, calls[2].headers['x-csrf-token'], calls[2].body], ['/tenants?limit=5', undefined, undefined]);
  await assert.rejects(() => client.business({}), /needs "id"/);
  const refused = createPlatformClient({ routes: platformRoutes, fetch: async () => new Response(JSON.stringify({ error: 'Please sign in.' }), { status: 401 }) });
  await assert.rejects(() => refused.me(), (error) => error.name === 'PlatformError' && error.status === 401 && error.message === 'Please sign in.');
  assert.throws(() => createPlatformClient({ routes: { 'products.list': { method: 'GET', path: '/x' } } }), /not a Platform Console route/);
  for (const file of ['shared/api-client/platform.js', 'shared/api-client/platform-routes.js']) assert.equal(/from '[^']*(src\/contracts|zod)/.test(read(file)), false, `${file} does not import the server or its schemas`);
});

/** Every file under a folder, as repo-relative paths. */
function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const at = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(at));
    else out.push(at);
  }
  return out;
}

test('the Platform Console is a second entry of the console project, with its own registry, and never part of the seller bundle', () => {
  const FEATURES = ['apps', 'audit', 'billing', 'businesses', 'exports', 'flags', 'health', 'impersonation', 'onboarding', 'services', 'signup', 'switches'];
  assert.deepEqual(fs.readdirSync(path.join(repoRoot, 'console/src/platform/features'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(), FEATURES);
  for (const name of FEATURES) {
    const source = read(`console/src/platform/features/${name}/index.jsx`);
    assert.match(source, new RegExp(`name: '${name}'`), name);
    const roles = /roles: \[([^\]]+)\]/.exec(source)[1].split(',').map((role) => role.trim().replace(/'/g, ''));
    assert.ok(roles.length && roles.every((role) => PLATFORM_ROLES.includes(role)), `${name} names platform roles`);
  }
  assert.match(read('console/src/platform/features/index.js'), /import\.meta\.glob\('\.\/\*\/index\.jsx'/);
  assert.match(read('console/platform.html'), /src="\/src\/platform\/main\.jsx"/);
  assert.equal(read('console/index.html').includes('platform'), false);

  // Two builds, two folders: the seller's build has no input that reaches the platform's source.
  const seller = read('console/vite.config.js');
  const platform = read('console/vite.platform.config.js');
  assert.match(seller, /outDir: 'dist'/);
  assert.match(platform, /outDir: 'dist-platform'/);
  assert.match(platform, /base: '\/console\/'/);
  assert.match(platform, /input: path\.resolve\(here, 'platform\.html'\)/);
  const scripts = JSON.parse(read('console/package.json')).scripts;
  assert.match(scripts.build, /vite build && vite build --config vite\.platform\.config\.js/);
  assert.match(read('.gitignore'), /^console\/dist-platform\/$/m);

  const sellerFiles = filesUnder('console/src').filter((file) => !file.startsWith('console/src/platform/') && /\.(jsx?|css)$/.test(file));
  for (const file of sellerFiles) {
    const source = read(file);
    assert.equal(/from\s+['"][^'"]*\/platform\/[^'"]*['"]/.test(source) || source.includes('@bhava/api-client/platform'), false, `${file} imports nothing of the Platform Console`);
  }
  // And the other way: the Platform Console shares design and lib, never a seller screen or the seller's session.
  for (const file of filesUnder('console/src/platform').filter((f) => /\.jsx?$/.test(f))) {
    const source = read(file);
    assert.equal(/from\s+['"](\.\.\/)+(features|shell|components)\//.test(source) || /from\s+['"](\.\.\/)+lib\/(api|session)/.test(source), false, `${file} uses no seller screen`);
    assert.equal(source.includes("'@bhava/api-client'"), false, `${file} does not use the seller client`);
  }

  // When the builds are there, check them too: no chunk of one is in the other.
  const built = (dir) => (fs.existsSync(path.join(repoRoot, dir, 'assets')) ? fs.readdirSync(path.join(repoRoot, dir, 'assets')) : null);
  const sellerBuilt = built('console/dist');
  const platformBuilt = built('console/dist-platform');
  if (sellerBuilt && platformBuilt) {
    assert.ok(fs.existsSync(path.join(repoRoot, 'console/dist-platform/platform.html')));
    assert.equal(fs.existsSync(path.join(repoRoot, 'console/dist/platform.html')), false);
    assert.equal(sellerBuilt.some((file) => file.startsWith('platform-')), false);
    for (const file of sellerBuilt.filter((f) => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(repoRoot, 'console/dist/assets', file), 'utf8');
      for (const marker of ['/sign-in/totp', 'Bhava Console', '/impersonations']) assert.equal(source.includes(marker), false, `${file} holds nothing of the Platform Console (${marker})`);
    }
  }

  // The seller shell has the one banner slot, reading the session.
  const shell = read('console/src/shell/AppShell.jsx');
  assert.match(shell, /<OperatorBanner operator=\{session\.operator \?\? null\}/);
  assert.match(read('console/src/shell/OperatorBanner.jsx'), /if \(!operator\) return null;/);
});

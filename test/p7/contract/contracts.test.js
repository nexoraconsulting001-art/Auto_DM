// What the Phase 7 tracks build against (PRD 3, 5.7, 5.12, 5.20): the requirement list, the plan check on the route table
// (every route names its feature or says why not), the four module folders, every new route with exactly one module, and the
// router answering for the plan before any handler runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '@bhava/api-client';
import {
  ALWAYS_ON, BILLING_PLATFORM_OWNERS, BILLING_ROUTE_OWNERS, ERROR_STATUS, ErrorBody, FRESH_ROUTES, PLAN_IN_HANDLER, PLAN_NOT_ENFORCED, ROUTE_FEATURES, ROUTE_FIELDS, ROUTE_LIMITS,
  assertRouteFields, isPlanRefusal, planRefusalReason, platformRoutes, routeList, routes,
} from '../../../src/contracts/api/index.js';
import { JOB_ENTITLEMENTS } from '../../../src/contracts/billing.js';
import { config } from '../../../src/config.js';
import { MODULES } from '../../../src/modules/index.js';
import { OWNER, setup, startApp } from '../../helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
const P7_MODULES = ['billing', 'usage', 'signup', 'referrals'];
const SELLER_GROUPS = ['billing', 'referrals', 'signup'];
const moduleNamed = (name) => MODULES.find((m) => m.name === name);
const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${String(from + i).padStart(2, '0')}`);

test('requirements/p7.json lists the 70 Phase 7 scenarios once, in order; U-07 and U-08 left later.json and their test runs', () => {
  const requirements = readJson('requirements/p7.json');
  const expected = [...range('F', 26, 45), ...range('F', 51, 55), ...range('F', 77, 86), ...range('F', 90, 95), 'F-108', ...range('F', 112, 116), ...range('F', 121, 129), 'U-07', 'U-08', ...range('A', 55, 66)];
  assert.equal(expected.length, 70);
  assert.deepEqual(requirements.map((r) => r.id), expected);
  for (const r of requirements) {
    assert.deepEqual(Object.keys(r), ['id', 'title'], r.id);
    assert.ok(r.title.length >= 20 && r.title.length <= 100, `${r.id}: a short title`);
  }
  for (const earlier of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'later']) {
    const theirs = readJson(`requirements/${earlier}.json`).map((r) => r.id);
    assert.deepEqual(expected.filter((id) => theirs.includes(id)), [], `no id is also in ${earlier}.json`);
  }
  assert.deepEqual(readJson('requirements/later.json').map((r) => r.id), ['I-02']);
  const moved = fs.readFileSync(path.join(repoRoot, 'test/p7/creator-badge/u-07-u-08-creator-page.test.js'), 'utf8');
  assert.match(moved, /test\('U-07: /);
  assert.match(moved, /test\('U-08: /);
  assert.equal(fs.existsSync(path.join(repoRoot, 'test/later')) && fs.readdirSync(path.join(repoRoot, 'test/later')).length > 0, false, 'nothing waits in test/later');
});

test('the route format has feature and limit, and refuses a wrong one when the contract loads', () => {
  assert.ok(ROUTE_FIELDS.includes('feature') && ROUTE_FIELDS.includes('limit'));
  const base = routes['orders.list'];
  assert.doesNotThrow(() => assertRouteFields('x.y', { ...base, feature: 'store.checkout' }));
  assert.doesNotThrow(() => assertRouteFields('x.y', { ...base, feature: ['app.android', 'app.ios'] }));
  assert.doesNotThrow(() => assertRouteFields('x.y', { ...base, limit: { feature: 'automations', counts: 'automations.active' } }));
  for (const feature of ['', 'Store Checkout', [], ['ok', ''], 7, null, true]) assert.throws(() => assertRouteFields('x.y', { ...base, feature }), /entitlement name/, JSON.stringify(feature));
  for (const limit of [{}, { feature: 'automations' }, { counts: 'x' }, { feature: 'automations', counts: 'x', max: 3 }, 'automations', null]) assert.throws(() => assertRouteFields('x.y', { ...base, limit }), /limit is \{ feature, counts \}/, JSON.stringify(limit));
  assert.throws(() => assertRouteFields('x.y', { ...routes['auth.start'], feature: 'catalog' }), /no plan to check/);
  assert.deepEqual([ERROR_STATUS['plan.feature_off'], ERROR_STATUS['plan.limit_reached']], [403, 403]);
  assert.ok(ErrorBody.safeParse({ error: 'x', code: 'plan.limit_reached', feature: 'staff.seats', plan: 't2', limit: 3, used: 3, reason: 'plan' }).success);
  assert.deepEqual([isPlanRefusal({ code: 'plan.feature_off' }), isPlanRefusal({ code: 'plan.limit_reached' }), isPlanRefusal({ code: 'forbidden' }), isPlanRefusal(null)], [true, true, false, false]);
  assert.deepEqual([planRefusalReason('coupons.create'), planRefusalReason('themes.choose')], ['plan', 'plan.not_included'], 'the reason each screen already looks for');
});

test('every route names a feature or a limit, or is listed as always on, checked in its handler, or not enforced yet: a new route cannot forget', async () => {
  const known = new Set(routeList.map((r) => r.id));
  const lists = { ALWAYS_ON, PLAN_IN_HANDLER: Object.keys(PLAN_IN_HANDLER), PLAN_NOT_ENFORCED: Object.keys(PLAN_NOT_ENFORCED) };
  for (const [name, ids] of Object.entries(lists)) {
    assert.equal(new Set(ids).size, ids.length, `${name} lists each route once`);
    for (const id of ids) assert.ok(known.has(id), `${name} names "${id}", which is not a route`);
  }
  for (const route of routeList) {
    const places = [
      route.feature || route.limit ? 'the route table' : null,
      ALWAYS_ON.includes(route.id) ? 'ALWAYS_ON' : null,
      route.id in PLAN_IN_HANDLER ? 'PLAN_IN_HANDLER' : null,
      route.id in PLAN_NOT_ENFORCED ? 'PLAN_NOT_ENFORCED' : null,
    ].filter(Boolean);
    assert.equal(places.length, 1, `${route.id} must say where its plan check is, once: add \`feature\` to the route, or list it in src/contracts/api/plan.js (it is in: ${places.join(', ') || 'none'})`);
  }
  assert.deepEqual(Object.keys(ROUTE_FEATURES).sort(), routeList.filter((r) => r.feature).map((r) => r.id).sort());
  assert.deepEqual(ROUTE_LIMITS, { 'team.invite': { feature: 'staff.seats', counts: 'team.seats' } });
  assert.deepEqual(ROUTE_FEATURES['storeAccess.save'], ['app.android', 'app.ios'], 'either app is enough');
  // Paid features of PRD 3 that have routes, each gated where the handler was already refusing.
  for (const [id, feature] of Object.entries({
    'coupons.create': 'store.coupons', 'paymentAccount.startLinked': 'store.payments', 'shipments.create': 'store.shipping', 'reviews.list': 'store.reviews', 'wishlist.counts': 'store.wishlist',
    'loyalty.adjust': 'loyalty', 'shopify.connect': 'shopify.sync', 'leadForms.update': 'lead_form', 'domains.add': 'custom_domain', 'imports.csv': 'catalog.import',
    'categories.setReels': 'category_sequences', 'apiKeys.create': 'reporting.api', 'scheduledReports.create': 'reports.scheduled', 'creator.update': 'creator_page', 'themes.choose': 'theme_presets',
  })) assert.deepEqual(ROUTE_FEATURES[id], [feature], id);
  // Sign-in, compliance, analytics and Reach Guard are on in every tier (5.7), and so is the plan itself.
  for (const id of ['auth.me', 'compliance.status', 'insights.account', 'reachGuard.status', 'traffic.summary', 'billing.plan', 'billing.change', 'billing.features', 'orders.list', 'orders.get']) assert.ok(ALWAYS_ON.includes(id), id);

  // Every name used is a real entitlement: in a plan, or switched on by an add-on. And every counter has a module.
  const w = await setup();
  const real = new Set([
    ...(await w.db.platform.query('SELECT DISTINCT feature FROM plan_features')).map((r) => r.feature),
    ...(await w.db.platform.query('SELECT feature FROM addons WHERE feature IS NOT NULL')).map((r) => r.feature),
  ]);
  const named = [...Object.values(ROUTE_FEATURES).flat(), ...Object.values(ROUTE_LIMITS).map((l) => l.feature), ...Object.values(PLAN_IN_HANDLER).flat(), ...Object.values(PLAN_NOT_ENFORCED), ...Object.values(JOB_ENTITLEMENTS).flat()];
  for (const feature of new Set(named)) assert.ok(real.has(feature), `"${feature}" is not in plan_features or addons`);
  const counters = new Set(MODULES.flatMap((m) => Object.keys(m.counters?.({ db: w.db }) ?? {})));
  for (const [id, limit] of Object.entries(ROUTE_LIMITS)) assert.ok(counters.has(limit.counts), `${id}: no module counts "${limit.counts}"`);
  for (const job of ['automation runs', 'imports', 'checkout', 'reports']) assert.ok(JOB_ENTITLEMENTS[job]?.length, `${job} must check its entitlements itself`);
});

test('the four Phase 7 folders exist, sit directly after entitlements, and every Phase 7 route has exactly one module', () => {
  const names = MODULES.map((m) => m.name);
  assert.deepEqual(names.slice(names.indexOf('entitlements'), names.indexOf('entitlements') + 5), ['entitlements', ...P7_MODULES]);
  assert.ok(names.indexOf('referrals') < names.indexOf('compliance'), 'before anything that sends');
  for (const name of P7_MODULES) {
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules', name, 'index.js')), name);
    assert.ok(moduleNamed(name).owns, `${name} says what it owns`);
  }

  const answers = new Map();
  for (const module of MODULES) {
    // A Phase 7 folder's api() must not read ctx; earlier ones get the stub their own contract tests use.
    const ctx = P7_MODULES.includes(module.name) ? {} : { repos: {}, config: {}, ig: {}, auth: {}, db: {}, platform: {}, providers: {}, notify: {} };
    for (const id of Object.keys(module.api?.(ctx) ?? {})) {
      assert.equal(answers.has(id), false, `${id} is answered by both ${answers.get(id)} and ${module.name}`);
      answers.set(id, module.name);
    }
  }
  const phase7 = routeList.filter((r) => SELLER_GROUPS.includes(r.id.split('.')[0])).map((r) => r.id);
  assert.deepEqual([...phase7].sort(), Object.values(BILLING_ROUTE_OWNERS).flat().sort(), 'the 17 routes of the contract');
  assert.equal(phase7.length, 17);
  for (const [owner, ids] of Object.entries(BILLING_ROUTE_OWNERS)) {
    for (const id of ids) assert.equal(answers.get(id), owner, id);
    assert.deepEqual([...moduleNamed(owner).owns.api].sort(), [...ids].sort(), `${owner}.owns.api`);
  }
  for (const route of routeList) assert.ok(answers.has(route.id), `${route.id} has no module`);

  const consoleIds = Object.values(BILLING_PLATFORM_OWNERS).flat();
  assert.equal(new Set(consoleIds).size, consoleIds.length);
  for (const id of ['platform.overridePlan', 'platform.createCreditNote', 'platform.suspendBilling', 'platform.resumeBilling', 'platform.saveFlag', 'platform.setTenantFlag', 'platform.setSignupMode', 'platform.createSignupInvite', 'platform.revokeSignupInvite']) assert.ok(consoleIds.includes(id), id);
  for (const [owner, ids] of Object.entries(BILLING_PLATFORM_OWNERS)) {
    for (const id of ids) assert.ok(platformRoutes[id]?.platformRoles?.length, `${id} is a Platform Console route`);
    assert.deepEqual([...moduleNamed(owner).owns.platform].sort(), [...ids].sort(), `${owner}.owns.platform`);
    assert.equal(typeof moduleNamed(owner).platformRoutes, 'function', `${owner} mounts its console routes`);
  }
  for (const id of ['platform.overridePlan', 'platform.createCreditNote', 'platform.saveBillingSettings', 'platform.saveFlag', 'platform.setSignupMode']) assert.deepEqual(platformRoutes[id].platformRoles, ['super_admin'], id);
  for (const id of consoleIds) if (platformRoutes[id].method !== 'GET' && id !== 'platform.createSignupInvite' && id !== 'platform.revokeSignupInvite') assert.ok(platformRoutes[id].body.shape.reason, `${id} takes a reason`);
});

test('billing is the owner\'s alone, fresh where it changes money, takes no amount and no card; sign-up is public on the host of no business', () => {
  const client = createApiClient({ fetch: async () => new Response('{}') });
  for (const id of Object.values(BILLING_ROUTE_OWNERS).flat()) {
    const [group, name] = id.split('.');
    assert.equal(typeof client[group]?.[name], 'function', `the client has ${id}`);
  }
  const billingIds = routeList.filter((r) => r.id.startsWith('billing.') && r.id !== 'billing.features');
  for (const route of [...billingIds, routes['referrals.get']]) assert.deepEqual(route.access.roles, ['owner'], `${route.id ?? 'referrals.get'} is owner only`);
  assert.ok(routes['billing.features'].access.signedIn, 'any signed-in seller may read what the business has, to hide what it has not');
  assert.deepEqual(FRESH_ROUTES.filter((id) => id.startsWith('billing.')).sort(), ['billing.addItem', 'billing.change', 'billing.paymentMethod', 'billing.removeItem']);
  for (const route of routeList.filter((r) => SELLER_GROUPS.includes(r.id.split('.')[0]))) {
    const fields = Object.keys(route.body?.shape ?? {});
    for (const field of fields) assert.doesNotMatch(field, /paise|amount|price|total|discount|card|cvv|upi|tenantId/i, `${route.id} takes no ${field}: the server prices it and the provider's page takes the card`);
    assert.ok(/^(\/[a-z-]+|\/:id)+$/.test(route.path), `${route.id}: ${route.path}`);
  }
  assert.deepEqual(Object.keys(routes['billing.change'].body.shape).sort(), ['cycle', 'plan', 'requestKey']);
  assert.deepEqual(Object.keys(routes['billing.addItem'].body.shape).sort(), ['code', 'quantity', 'requestKey']);
  assert.equal(routes['billing.paymentMethod'].body, undefined, 'nothing is sent: the answer is the provider’s hosted page');
  assert.ok(routes['billing.paymentMethod'].response.shape.url);
  assert.equal(routes['billing.statements'].response.shape.items.element.shape.commissionPaise.safeParse(1).success, false, 'F-113: a statement cannot show a commission');

  const signupIds = routeList.filter((r) => r.id.startsWith('signup.'));
  assert.deepEqual(signupIds.map((r) => r.id).sort(), ['signup.finish', 'signup.firstAutomation', 'signup.start', 'signup.status']);
  for (const route of signupIds) assert.deepEqual([route.access.public, route.noBusiness], [true, true], route.id);
  assert.deepEqual(routes['signup.start'].body.shape.accountType.options, ['creator', 'seller']);
  for (const key of ['razorpayBillingKeyId', 'razorpayBillingKeySecret', 'razorpayBillingWebhookSecret', 'billingReturnUrl', 'signupHostSuffix']) assert.equal(typeof config[key], 'string', key);
  const example = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  for (const name of ['RAZORPAY_BILLING_KEY_ID', 'RAZORPAY_BILLING_KEY_SECRET', 'RAZORPAY_BILLING_WEBHOOK_SECRET', 'BILLING_RETURN_URL', 'SIGNUP_HOST_SUFFIX']) assert.match(example, new RegExp(`^${name}=$`, 'm'), name);
});

test('a running app: the router answers for the plan before the handler, from the route table, and a plan change applies to the next request', async () => {
  const app = await startApp();
  try {
    const { token } = await (await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) })).json();
    const call = async (method, pathname, body, bearer = token) => {
      const res = await fetch(`${app.base}/api/v1${pathname}`, { method, headers: { authorization: `Bearer ${bearer}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const setPlan = (plan) => app.db.platform.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, app.tenant.id]);

    // The Free plan: a store feature is off, and the answer names the feature and the lowest plan that has it.
    const off = await call('POST', '/coupons', { nonsense: true });
    assert.deepEqual([off.status, off.json.code, off.json.feature, off.json.plan, off.json.reason], [403, 'plan.feature_off', 'store.coupons', 't3', 'plan'], 'the plan is answered before the input is read');
    assert.match(off.json.error, /Store plan/);
    assert.deepEqual((({ status, json }) => [status, json.code, json.plan])(await call('GET', '/loyalty/settings')), [403, 'plan.feature_off', 't4'], 'loyalty is in the plans from tier 4');
    assert.deepEqual((({ status, json }) => [status, json.code, json.plan, json.reason])(await call('POST', '/imports/link', { url: 'https://shop.example/p/1' })), [403, 'plan.feature_off', 't2', 'plan.not_included']);
    assert.deepEqual((({ status, json }) => [status, json.code, json.feature])(await call('GET', '/store-access')), [403, 'plan.feature_off', 'app.android']);

    // F-33: the upgrade applies to the very next request, with no restart.
    await setPlan('t3');
    const on = await call('POST', '/coupons', { nonsense: true });
    assert.deepEqual([on.status, on.json.code], [400, 'validation_failed'], 'now the handler’s own checks answer');
    assert.equal((await call('GET', '/coupons')).status, 200);
    assert.equal((await call('GET', '/loyalty/settings')).json.code, 'plan.feature_off', 'on tier 3 loyalty is still an add-on');
    await app.db.platform.query(`INSERT INTO tenant_features (tenant_id, feature, enabled) VALUES ($1, 'loyalty', true)`, [app.tenant.id]);
    assert.equal((await call('GET', '/loyalty/settings')).status, 200, 'the add-on turns it on for this business');
    // F-34: after a downgrade the feature is off again, at once, and what exists can still be read.
    await setPlan('t2');
    assert.equal((await call('POST', '/coupons', { nonsense: true })).json.code, 'plan.feature_off');
    assert.equal((await call('GET', '/orders')).status, 200, 'orders stay manageable');

    // Who is asking comes first: someone who may not call the route learns nothing about the plan.
    await app.repos.users.create({ name: 'Ravi S', phone: '9876543211', password: 'secret1', role: 'staff' });
    const staff = (await (await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '9876543211', password: 'secret1' }) })).json()).token;
    assert.equal((await call('POST', '/coupons', { nonsense: true }, staff)).json.code, 'forbidden');
    assert.equal((await fetch(`${app.base}/api/v1/coupons`)).status, 401);

    // A limit: the seat in use is the staff account above.
    const invite = { phone: '9876500000', role: 'staff', permissions: ['orders'] };
    await app.db.platform.query(`INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, 'staff.seats', true, 1)`, [app.tenant.id]);
    const full = await call('POST', '/team/invites', invite);
    assert.deepEqual([full.status, full.json.code, full.json.feature, full.json.limit, full.json.used, full.json.reason], [403, 'plan.limit_reached', 'staff.seats', 1, 1, 'plan']);
    await app.db.platform.query(`UPDATE tenant_features SET limit_value = 2 WHERE tenant_id = $1 AND feature = 'staff.seats'`, [app.tenant.id]);
    assert.notEqual((await call('POST', '/team/invites', invite)).json?.code, 'plan.limit_reached', 'with room, the handler answers');
    await app.db.platform.query(`UPDATE tenant_features SET enabled = false WHERE tenant_id = $1 AND feature = 'staff.seats'`, [app.tenant.id]);
    assert.deepEqual((({ json }) => [json.code, json.limit])(await call('POST', '/team/invites', invite)), ['plan.limit_reached', 0], 'switched off is a limit of none');

    // billing.features is built: what this business has, for the console and the owner app to hide what it has not.
    const features = await call('GET', '/billing/features');
    assert.equal(features.status, 200);
    assert.equal(features.json.plan, 't2');
    assert.deepEqual([features.json.features.catalog, features.json.features['dms.monthly'], features.json.features.loyalty, features.json.features['staff.seats']], [{ on: true, limit: null }, { on: true, limit: 15000 }, { on: true, limit: null }, { on: false, limit: null }]);
    assert.equal(features.json.features['store.checkout'], undefined, 'what the plan does not have is not listed');

    // Each Phase 7 module answers its routes with 501 until its track builds them.
    for (const [method, pathname, owner] of [['GET', '/billing', 'billing'], ['GET', '/billing/catalog', 'billing'], ['GET', '/billing/usage', 'usage'], ['GET', '/referrals', 'referrals'], ['GET', '/signup', 'signup']]) {
      const res = await call(method, pathname);
      assert.deepEqual([res.status, res.json.code], [501, 'not_implemented'], `${owner}: ${pathname}`);
    }
    assert.equal((await call('GET', '/billing', null, staff)).json.code, 'forbidden', 'billing is the owner’s');
    assert.equal((await call('GET', '/billing/invoices/abc/file')).status, 404, ':id is a number');
  } finally {
    app.close();
  }
});

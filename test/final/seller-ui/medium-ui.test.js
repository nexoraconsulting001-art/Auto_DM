// Medium seller-ui findings (final review): notification links, AI replies permissions, the loyalty probe, app/console parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOTIFY_EVENTS } from '../../../src/contracts/notifications.js';
import { routes } from '../../../src/contracts/api/index.js';
import { MANAGERS } from '../../../src/contracts/api/access.js';
import { loyaltyFromFeatures } from '../../../console/src/features/loyalty/entitled.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const indexes = (dir, name) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name, name)).filter((f) => fs.existsSync(path.join(root, f)));
const pathsIn = (files) => files.flatMap((f) => [...read(f).matchAll(/path: '([^']*)'/g)].map((m) => m[1]));

const matches = (pattern, link) => {
  const a = pattern.split('/').filter(Boolean);
  const b = link.split('/').filter(Boolean);
  return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
};

test('seller-ui-7: every notification link opens a screen in the console and in the owner app', () => {
  const consolePages = pathsIn(indexes('console/src/features', 'index.jsx'));
  const appScreens = pathsIn(indexes('apps/owner/src/features', 'index.js'));
  for (const [kind, spec] of Object.entries(NOTIFY_EVENTS)) {
    const link = spec.link.replace(/\{[A-Za-z]+\}/g, 'x');
    assert.ok(consolePages.some((p) => matches(p, link)), `${kind}: console has no page for ${spec.link}`);
    assert.ok(appScreens.some((p) => matches(p, link)), `${kind}: the owner app has no screen for ${spec.link}`);
  }
});

test('seller-ui-3: the AI replies toggle and confidence are offered only to those the server lets save them', () => {
  assert.equal(routes['aiReplies.save'].access, MANAGERS);
  const page = read('console/src/features/ai-replies/AiRepliesPage.jsx');
  const settings = page.slice(page.indexOf('function Settings('), page.indexOf('function TestQuestion('));
  assert.match(settings, /useAllowed\(\)\(MANAGERS\)/);
  const gated = settings.match(/!canChange/g) ?? [];
  assert.ok(gated.length >= 3, 'the toggle, the number field and the save button are each disabled for staff');
});

test('seller-ui-5: loyalty on tier 3 is read from billing.features, never probed with a plan-gated route', () => {
  assert.ok(routes['loyalty.members'].feature, 'loyalty.members is plan gated, so calling it on tier 3 raises the plan refusal');
  const hook = read('console/src/features/loyalty/useLoyalty.js');
  assert.doesNotMatch(hook, /api\.loyalty\./);
  assert.match(hook, /api\.billing\.features\(\)/);
  assert.equal(loyaltyFromFeatures({ plan: 't3', features: { loyalty: { on: true, limit: null } } }), true);
  assert.equal(loyaltyFromFeatures({ plan: 't3', features: { loyalty: { on: false, limit: null } } }), false);
  assert.equal(loyaltyFromFeatures({ plan: 't3', features: {} }), false);
  assert.equal(loyaltyFromFeatures(undefined), false);
});

test('D-14: every console page has an owner app screen (parity check passes)', () => {
  execFileSync(process.execPath, ['tools/parity-check.mjs'], { cwd: root, stdio: 'pipe' });
});

// ---- Second pass: the findings the first pass deferred, and D-14's registry part.

const featureDirs = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const sourceFiles = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && /\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name))
  .map((e) => path.relative(root, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'));
const screenPaths = (file) => {
  const text = read(file);
  const screens = text.slice(text.indexOf('screens:'), text.indexOf('nav:', text.indexOf('screens:')));
  return [...screens.matchAll(/path: '([^']*)'/g)].map((m) => m[1]);
};

test('D-14: no two owner app features register a screen for the same path (registryProblems: one screen per path)', () => {
  const owners = new Map();
  const twice = [];
  for (const name of featureDirs('apps/owner/src/features')) {
    const file = `apps/owner/src/features/${name}/index.js`;
    if (!fs.existsSync(path.join(root, file))) continue;
    for (const p of screenPaths(file)) {
      const shape = p.replace(/:[A-Za-z]+/g, ':');
      if (owners.has(shape)) twice.push(`${p}: ${owners.get(shape)} and ${name}`);
      else owners.set(shape, name);
    }
  }
  assert.deepEqual(twice, []);
  assert.equal(owners.get('settings/api-keys'), 'settings', 'API keys are Settings’ screen; Reports links to it');
});

test('D-14: the registry test’s staff expectation follows the contract: alerts are staff with automations', () => {
  assert.deepEqual({ ...routes['alerts.list'].access }, { roles: ['owner', 'manager', 'staff'], permission: 'automations' });
  assert.match(read('apps/owner/src/features/alerts/index.js'), /access: staffWith\('automations'\)/);
});

test('seller-ui-7: a report notification keeps its deep link to the run, which the console lists on Reports', () => {
  for (const kind of ['report.weekly', 'report.monthly']) assert.equal(NOTIFY_EVENTS[kind].link, '/reports/{reportRunId}');
  assert.match(read('console/src/features/reports/index.jsx'), /path: 'reports\/:id', element: <Navigate to="\/reports" replace \/>/);
});

test('seller-ui-6: billing.features becomes the entitlements canOpen reads, and a plan without a feature hides it', async () => {
  const { canOpen, entitlementsOf, staffWith: appStaffWith } = await import('../../../packages/app-core/src/access.js');
  const answer = { plan: 't2', features: { loyalty: { on: false, limit: null }, automations: { on: true, limit: 50 } } };
  assert.deepEqual(entitlementsOf(answer), { loyalty: false, automations: true });
  assert.equal(entitlementsOf(undefined), null);
  assert.equal(entitlementsOf({ plan: 't2' }), null);
  const owner = { id: 1, role: 'owner', permissions: [] };
  const loyalty = { access: appStaffWith('customers'), feature: 'loyalty', nav: null };
  assert.equal(canOpen(loyalty, { user: owner, entitlements: entitlementsOf(answer) }), false);
  assert.equal(canOpen(loyalty, { user: owner, entitlements: entitlementsOf(undefined) }), true, 'not known yet: shown, the server decides');
});

test('seller-ui-6: the owner app’s menu and automation triggers read the plan from billing.features, not a session field nothing sets', () => {
  const hook = read('apps/owner/src/shell/entitlements.js');
  assert.match(hook, /api\.billing\.features\(\)/);
  assert.match(hook, /entitlementsOf\(/);
  assert.match(read('apps/owner/src/features/billing/BillingScreen.js'), /queryKey: \['billing', name\]/, 'the same key as Plan and billing’s own read');
  assert.match(read('apps/owner/src/shell/Navigation.js'), /const entitlements = usePlanEntitlements\(\)/);
  assert.match(read('apps/owner/src/features/automations/BuilderScreen.js'), /const entitlements = usePlanEntitlements\(\)/);
  const stale = [...sourceFiles('apps/owner/src'), ...sourceFiles('packages/app-core/src')]
    .filter((f) => /state\.entitlements|\{[^}]*\bentitlements\b[^}]*\}\s*=\s*useSession\(\)/.test(read(f)));
  assert.deepEqual(stale, []);
});

test('seller-ui-6: a plan refusal is told apart from a role refusal, so the owner is never told to ask the owner', async () => {
  const { errorKey, planRefusal } = await import('../../../packages/app-core/src/refusals.js');
  assert.equal(errorKey({ status: 403, code: 'plan.feature_off', reason: 'plan' }), 'error.planFeature');
  assert.equal(errorKey({ status: 403, code: 'plan.limit_reached', reason: 'plan' }), 'error.planLimit');
  assert.equal(errorKey({ status: 403, code: 'forbidden', reason: 'plan.not_included' }), 'error.planFeature');
  assert.equal(errorKey({ status: 403, code: 'forbidden' }), 'error.forbidden');
  assert.equal(errorKey({ status: 0, code: 'network' }), 'error.network');
  assert.equal(planRefusal({ status: 400, code: 'plan.feature_off' }), null);
  const { refusalText } = await import('../../../apps/owner/src/features/products/upload.js');
  assert.equal(refusalText((k) => k, { status: 403, code: 'plan.feature_off', reason: 'plan' }), 'error.planFeature');
  const en = (await import('../../../packages/app-core/src/strings/en.js')).default;
  const hi = (await import('../../../packages/app-core/src/strings/hi.js')).default;
  for (const key of ['error.planFeature', 'error.planLimit']) {
    assert.equal(typeof en[key], 'string', key);
    assert.equal(typeof hi[key], 'string', key);
    assert.doesNotMatch(en[key], /ask the owner of this business/i);
  }
  // One mapping: no owner app or app-core file turns a 403 into "Ask the owner" by itself.
  const own = [...sourceFiles('apps/owner/src'), ...sourceFiles('packages/app-core/src')].filter((f) => !/strings|refusals\.js$/.test(f) && read(f).includes("'error.forbidden'"));
  assert.deepEqual(own, []);
});

test('seller-ui-9: "Sign in instead" on the lock screen goes through the one sign-out path, and never reads the refresh token', () => {
  const app = read('apps/owner/src/App.js');
  const locked = app.slice(app.indexOf('function Locked('), app.indexOf('function Shell('));
  assert.ok(locked.includes('signOutEverywhere({ session, store, requireServer: false })'));
  assert.ok(!locked.includes('store.clearSession()') && !locked.includes('session.start()'), 'emptying SecureStore by hand skips the signedOut listeners');
  const out = read('apps/owner/src/shell/sign-out.js');
  assert.ok(out.includes('if (session.getState().status !== SESSION_STATUS.locked) await unregisterFromPush('), 'a locked session has no token to unregister with');
  assert.ok(out.indexOf('unregisterFromPush({') < out.indexOf('session.signOut('), 'the push first, while the session still works');
});

test('seller-ui-4: a reel’s product picker reads reels.products, which automations staff may call and which shows only what it needs', async () => {
  const { ReelProductChoice } = await import('../../../src/contracts/api/reels.js');
  assert.deepEqual(routes['reels.products'].access, routes['reels.save'].access);
  assert.deepEqual(Object.keys(ReelProductChoice.shape).sort(), ['active', 'id', 'images', 'name', 'pricePaise']);
  for (const file of [...sourceFiles('console/src/features/reels'), ...sourceFiles('apps/owner/src/features/reels')]) {
    assert.doesNotMatch(read(file), /api\.products\./, `${file} reads the catalog, which staff with automations may not`);
  }
  assert.match(read('console/src/features/reels/ReelFormPage.jsx'), /api\.reels\.products/);
  assert.match(read('apps/owner/src/features/reels/ReelScreen.js'), /api\.reels\.products\(/);
});

test('seller-ui-4: an owner app feature open to one staff permission lists no route that needs another, except where its screen checks first', async () => {
  const { createRequire } = await import('node:module');
  const { readAppFeatures } = createRequire(import.meta.url)('../../../tools/parity-read.cjs');
  // Each of these is called only behind a role or permission check on the screen, or is listed for parity and not called.
  const CHECKED = new Set([
    'inbox compliance.status', 'inbox instagram.connection', 'inbox facebook.connection', // parity listing; the inbox screens do not call them
    'returns categories.list', // the return settings form, which is managers only (returnSettings.get)
    'reviews wishlist.counts', // the Saves button shows only to staff with analytics
  ]);
  const crossed = [];
  for (const feature of readAppFeatures(root).features) {
    const file = path.join(root, 'apps/owner/src/features', feature.name, 'index.js');
    if (!fs.existsSync(file)) continue;
    const own = fs.readFileSync(file, 'utf8').match(/^\s*access: staffWith\('([a-z_]+)'\)/m)?.[1];
    if (!own) continue;
    for (const id of feature.routeIds) {
      const needs = routes[id]?.access?.permission;
      if (needs && needs !== own && !CHECKED.has(`${feature.name} ${id}`)) crossed.push(`${feature.name} (${own}) lists ${id} (${needs})`);
    }
  }
  assert.deepEqual(crossed, []);
});

// The mobile workspace (PRD 10.1, 10.4, "iOS ready from day one"): one lockfile for the server and the apps, a server
// install with no React Native, the parity check, and the tools that hold the apps to the product's rules.
// The apps' own tests are jest (npm run test:apps); these are the parts that run with the server's tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { AUTH_PATHS, CONSOLE_ONLY_ROUTES, MANAGERS, OWNER_APP_SCHEME, OWNER_ONLY, PUBLIC, SIGNED_IN, assertRouteFields, routeList, staffWith } from '../../../src/contracts/api/index.js';
import { OWNER_APP_LINK_SCHEME } from '../../../src/contracts/notifications.js';
import { MIN_IOS_SDK, MIN_TARGET_SDK, MIN_XCODE, checkApkBadging, checkXcode } from '../../../tools/build-check.mjs';
import { appPhaseOf, appTestFiles, checkRequirements, maestroFlows, phaseFileHashes, phaseOf, readJestResults, repoRoot } from '../../../tools/gate-lib.mjs';
import { PENDING_PATH, checkParity, gather, readPending } from '../../../tools/parity-check.mjs';
import { checkBrandNames, checkFolders } from '../../../tools/policy-check.mjs';
import { scanFileName } from '../../../tools/secret-scan.mjs';

const require = createRequire(import.meta.url);
const { pageId, readAppFeatures, readConsolePages, readRouteIds } = require('../../../tools/parity-read.cjs');

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-apps-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

// ---- Layout and dependencies ----

test('the apps and their packages are workspaces beside the console and the shared client', () => {
  const root = json('package.json');
  assert.deepEqual(root.workspaces, ['console', 'shared/*', 'apps/*', 'packages/*']);
  for (const [dir, name] of [['apps/owner', '@bhava/owner-app'], ['packages/theme', '@bhava/theme'], ['packages/ui', '@bhava/ui'], ['packages/app-core', '@bhava/app-core'], ['shared/api-client', '@bhava/api-client']]) {
    assert.equal(json(`${dir}/package.json`).name, name);
  }
  assert.equal(json('apps/owner/package.json').dependencies['@bhava/api-client'], '*', 'the app uses the shared client by its package name');
  assert.equal(json('packages/app-core/package.json').dependencies['@bhava/api-client'], '*');
  assert.ok(!fs.existsSync(path.join(repoRoot, 'packages/api-client')), 'the client stays in shared/api-client');
  for (const script of ['test:apps', 'parity', 'app:export']) assert.equal(typeof root.scripts[script], 'string', script);
});

test('the owner app has every dependency the tracks need, at one Expo SDK', () => {
  const pkg = json('apps/owner/package.json');
  const needed = [
    'expo', 'react', 'react-native', '@react-navigation/native', '@react-navigation/native-stack', '@react-navigation/bottom-tabs',
    'expo-secure-store', 'expo-local-authentication', 'expo-notifications', 'expo-web-browser', 'expo-linking', 'expo-apple-authentication', 'expo-updates',
    'expo-image', 'expo-image-picker', 'expo-document-picker', 'expo-file-system', 'expo-application', 'expo-device', 'expo-constants', 'expo-crypto', 'expo-sqlite',
    '@tanstack/react-query', '@tanstack/react-query-persist-client', 'react-native-reanimated', 'react-native-gesture-handler', 'react-native-safe-area-context',
    'react-native-screens', 'react-native-svg', '@shopify/flash-list', 'zod',
  ];
  for (const name of needed) assert.ok(pkg.dependencies[name], `apps/owner depends on ${name}`);
  for (const name of ['jest-expo', '@testing-library/react-native', '@expo/fingerprint']) assert.ok(pkg.devDependencies[name], `apps/owner has ${name} for development`);
  assert.equal(pkg.dependencies['expo-router'], undefined, 'screens register from feature folders, not a routes folder');
  const sdk = /(\d+)\./.exec(pkg.dependencies.expo)[1];
  for (const [name, range] of Object.entries(pkg.dependencies)) {
    if (/^expo-/.test(name)) assert.match(range, new RegExp(`^[~^]?${sdk}\\.`), `${name} is at Expo SDK ${sdk}`);
  }
  assert.match(read('apps/owner/README.md'), new RegExp(`SDK ${sdk}`), 'the README records the SDK chosen and why');
});

test('no workspace depends on AsyncStorage, and it is not in the lockfile', () => {
  const lock = json('package-lock.json');
  assert.deepEqual(Object.keys(lock.packages).filter((name) => /async-storage/i.test(name)), []);
  for (const dir of ['apps/owner', 'packages/theme', 'packages/ui', 'packages/app-core']) {
    const pkg = json(`${dir}/package.json`);
    assert.deepEqual(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }).filter((name) => /async-storage/i.test(name)), [], dir);
  }
});

test('one lockfile serves the server and the apps, with one React and no React Native in the server', () => {
  const lock = json('package-lock.json');
  for (const dir of ['apps/owner', 'packages/theme', 'packages/ui', 'packages/app-core', 'console', 'shared/api-client']) assert.ok(lock.packages[dir], `${dir} is in the lockfile`);
  assert.equal(fs.readdirSync(repoRoot).filter((name) => /lock/.test(name) && !name.endsWith('.md')).join(), 'package-lock.json');
  for (const dir of ['apps/owner', 'packages/app-core', 'console']) assert.ok(!fs.existsSync(path.join(repoRoot, dir, 'package-lock.json')), `${dir} has no lockfile of its own`);
  const reacts = Object.entries(lock.packages).filter(([name]) => /(^|\/)node_modules\/react$/.test(name));
  assert.equal(reacts.length, 1, `one copy of React, found ${reacts.map(([name]) => name).join(', ')}`);
  assert.equal(reacts[0][1].version, json('apps/owner/package.json').dependencies.react);
  const server = json('package.json');
  for (const name of Object.keys({ ...server.dependencies, ...server.devDependencies })) assert.doesNotMatch(name, /react-native|^expo|^react$/, `the server does not depend on ${name}`);
});

test('the server image and the server CI jobs install only the server, the console and the shared client', () => {
  const filter = 'npm ci --workspace @bhava/console --workspace @bhava/api-client --include-workspace-root';
  const docker = read('Dockerfile');
  const installs = docker.split('\n').filter((line) => /^RUN npm (ci|install)/.test(line));
  assert.equal(installs.length, 2);
  for (const line of installs) assert.match(line, /--workspace @bhava\/console --workspace @bhava\/api-client --include-workspace-root/, line);
  assert.match(docker, /npm ci --omit=dev --workspace/);
  assert.match(docker, /test ! -e node_modules\/react-native/);
  assert.doesNotMatch(docker, /COPY (apps|packages)/);
  const ignored = read('.dockerignore').split(/\r?\n/);
  assert.ok(ignored.includes('apps') && ignored.includes('packages'), 'the apps stay out of the image');

  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes(`SERVER_INSTALL: ${filter}`));
  assert.equal((ci.match(/run: \$\{\{ env\.SERVER_INSTALL \}\}/g) ?? []).length, 3);
  assert.doesNotMatch(ci, /run: npm (ci|install)\s*$/m, 'no server job installs every workspace');
});

// ---- Parity (10.4) ----

const route = (id, access, extra = {}) => ({ id, method: 'GET', path: `/${id}`, access, ...extra });
const parityInput = (over = {}) => ({
  routes: [route('orders.list', staffWith('orders')), route('coupons.list', MANAGERS), route('audit.list', OWNER_ONLY), route('app.requirements', PUBLIC)],
  pages: [{ id: 'console:/orders', feature: 'orders' }, { id: 'console:/coupons', feature: 'coupons' }],
  features: [{ name: 'orders', routeIds: ['orders.list', 'console:/orders'] }, { name: 'coupons', routeIds: ['coupons.list', 'console:/coupons'] }, { name: 'audit-log', routeIds: ['audit.list'] }, { name: 'shell', routeIds: ['app.requirements'] }],
  pending: { routes: [], pages: [] },
  ...over,
});

test('P-14 a console page or a seller route with no app screen fails the parity check by name', () => {
  assert.equal(checkParity(parityInput()).ok, true);

  const base = parityInput();
  const page = checkParity({ ...base, pages: [...base.pages, { id: 'console:/coupons/bulk', feature: 'coupons' }] });
  assert.equal(page.ok, false);
  assert.deepEqual(page.missing, ['console:/coupons/bulk']);
  assert.match(page.problems.join('\n'), /No app screen for console page \/coupons\/bulk \(console\/src\/features\/coupons\)/);

  const added = checkParity({ ...base, routes: [...base.routes, route('coupons.archive', MANAGERS)] });
  assert.deepEqual(added.missing, ['coupons.archive']);
  assert.match(added.problems[0], /No app screen for route coupons\.archive: add "coupons\.archive" to the routeIds/);

  // Every kind of seller route counts: the owner's, a manager's, staff's, any signed-in person's and the public ones.
  const none = checkParity({ ...base, features: [] });
  assert.deepEqual(none.missing.sort(), ['app.requirements', 'audit.list', 'console:/coupons', 'console:/orders', 'coupons.list', 'orders.list']);
});

test('P-14 the check exits 1 and names the route when run on a repository with an unmapped console page', () => {
  const root = tree({
    'src/contracts/api/index.js': "export const routeList = [{ id: 'orders.list', method: 'GET', path: '/orders', access: { roles: ['owner', 'manager', 'staff'], permission: 'orders' } }];\n",
    'console/src/features/orders/index.jsx': "export default { name: 'orders', routes: [{ path: 'orders', element: <A /> }] };\n",
    'console/src/features/coupons/index.jsx': "export default { name: 'coupons', routes: [{ path: 'coupons', element: <B /> }] };\n",
    'apps/owner/src/features/index.js': "export const shell = { name: 'shell', routeIds: [] };\n",
    'apps/owner/src/features/orders/index.js': "export default { name: 'orders', routeIds: ['orders.list', 'console:/orders'] };\n",
    'tools/parity-pending.json': '{ "routes": [], "pages": [] }\n',
    'tools/parity-check.mjs': read('tools/parity-check.mjs'),
    'tools/parity-read.cjs': read('tools/parity-read.cjs'),
    'package.json': '{ "type": "module" }\n',
  });
  const run = spawnSync(process.execPath, ['tools/parity-check.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /No app screen for console page \/coupons \(console\/src\/features\/coupons\): add "console:\/coupons"/);
  assert.doesNotMatch(run.stderr, /orders/);

  fs.writeFileSync(path.join(root, 'apps/owner/src/features/coupons.js'), '');
  fs.mkdirSync(path.join(root, 'apps/owner/src/features/coupons'));
  fs.writeFileSync(path.join(root, 'apps/owner/src/features/coupons/index.js'), "export default { name: 'coupons', routeIds: ['console:/coupons'] };\n");
  const fixed = spawnSync(process.execPath, ['tools/parity-check.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.match(fixed.stdout, /3 routes and pages; 3 mapped to app screens/);
});

test('P-15 a web-only flag on a route is rejected: by the contract when it loads, and by the parity check', () => {
  for (const flag of ['webOnly', 'web_only', 'weboOnly']) {
    assert.throws(() => assertRouteFields('orders.list', { method: 'GET', path: '/orders', access: SIGNED_IN, [flag]: true }), /which the route format does not have/, flag);
  }
  assert.throws(() => assertRouteFields('orders.list', { method: 'GET', path: '/orders', access: SIGNED_IN, consoleOnly: 'yes' }), /true or absent/);
  for (const r of routeList) assert.deepEqual(Object.keys(r).filter((field) => /web/i.test(field)), [], r.id);

  const base = parityInput();
  const flagged = checkParity({ ...base, routes: [...base.routes.slice(1), route('orders.list', staffWith('orders'), { webOnly: true })], features: base.features.filter((f) => f.name !== 'orders') });
  assert.equal(flagged.ok, false);
  assert.match(flagged.problems.join('\n'), /Route "orders\.list" is flagged webOnly: there is no web-only flag/);
  assert.ok(flagged.missing.includes('orders.list'), 'and the flag exempts nothing');
});

test('the only exemption is consoleOnly, and the allowance file can only shrink', () => {
  const base = parityInput();
  const ops = checkParity({ ...base, routes: [...base.routes, route('ops.reindex', OWNER_ONLY, { consoleOnly: true })] });
  assert.equal(ops.ok, true);

  const unmapped = { ...base, features: base.features.filter((f) => f.name !== 'coupons') };
  assert.equal(checkParity(unmapped).ok, false);
  const allowed = checkParity({ ...unmapped, pending: { routes: ['coupons.list'], pages: ['console:/coupons'] } });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.counts, { required: 6, mapped: 4, pending: 2 });
  assert.equal(checkParity({ ...unmapped, pending: { routes: ['coupons.list'], pages: ['console:/coupons'] }, strict: true }).ok, false, 'strict ignores the allowance');

  const stale = checkParity({ ...base, pending: { routes: ['coupons.list', 'gone.route'], pages: [] } });
  assert.deepEqual(stale.stale.sort(), ['coupons.list', 'gone.route']);
  assert.match(stale.problems.join('\n'), /still lists "coupons\.list", which is mapped now: delete it/);
  assert.match(stale.problems.join('\n'), /still lists "gone\.route", which is not a route or page any more/);

  const typo = checkParity({ ...base, features: [...base.features, { name: 'orders2', routeIds: ['orders.lst'] }] });
  assert.deepEqual(typo.unknown, ['orders.lst']);
  assert.match(typo.problems.join('\n'), /orders2 lists "orders\.lst", which is not a route id or a console page/);
});

test('this repository passes the parity check, and every allowance names something real and still unmapped', async () => {
  const input = await gather();
  assert.deepEqual(input.readProblems, []);
  const result = checkParity(input);
  assert.deepEqual(result.problems, []);
  const pending = readPending();
  assert.equal(PENDING_PATH, 'tools/parity-pending.json');
  assert.equal(result.counts.pending, pending.routes.length + pending.pages.length);
  assert.equal(result.counts.mapped + result.counts.pending, result.counts.required);
  assert.ok(pending.routes.every((id) => !id.startsWith('console:')) && pending.pages.every((id) => id.startsWith('console:')));
  assert.deepEqual(CONSOLE_ONLY_ROUTES, [], 'nothing a seller uses is console-only');
  // The shell's own calls are mapped from the start: sign-in, the session, the switcher and push.
  const mapped = new Set(input.features.flatMap((f) => f.routeIds));
  for (const id of ['auth.start', 'auth.verify', 'auth.exchange', 'auth.apple', 'auth.refresh', 'auth.me', 'auth.logout', 'auth.businesses', 'app.requirements', 'push.register', 'push.unregister']) assert.ok(mapped.has(id), id);
});

test('route ids are read from each feature file, and anything but a written-out list is refused', () => {
  assert.deepEqual(readRouteIds("export default { routeIds: ['a.b', \"console:/x/:id\",\n  'c.d', ] }", 'f.js'), { ids: ['a.b', 'console:/x/:id', 'c.d'], problems: [] });
  assert.deepEqual(readRouteIds('export default { routeIds: [] }', 'f.js'), { ids: [], problems: [] });
  assert.deepEqual(readRouteIds("// routeIds: ['in.a.comment']\nexport default { routeIds: [/* 'x.y' */ 'a.b'] }", 'f.js').ids, ['a.b']);
  for (const source of ["{ routeIds: [...others, 'a.b'] }", '{ routeIds: ids }', "{ routeIds: ['a.b'].concat(more) }", '{ routeIds: [`a.${b}`] }', '{ name: 1 }']) {
    assert.notDeepEqual(readRouteIds(source, 'f.js').problems, [], source);
  }
  assert.equal(pageId('orders/:id'), 'console:/orders/:id');
  assert.equal(pageId(''), 'console:/');
});

test('every page the console registers is read, and every owner app feature folder too', () => {
  const { pages, problems } = readConsolePages(repoRoot);
  assert.deepEqual(problems, []);
  const folders = fs.readdirSync(path.join(repoRoot, 'console/src/features'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.deepEqual([...new Set(pages.map((p) => p.feature))].sort(), folders.sort(), 'every console feature registers at least one page, and each is read');
  assert.equal(new Set(pages.map((p) => p.id)).size, pages.length, 'no two console pages share a path');
  // A console file whose pages cannot all be read is a problem, never a silent gap.
  const odd = tree({ 'console/src/features/x/index.jsx': "export default { routes: [{ path: 'x', element: <A /> }, { path: somewhere, element: <B /> }] };\n" });
  assert.match(readConsolePages(odd).problems[0], /2 page\(s\) but 1 path\(s\) could be read/);
  for (const id of ['console:/', 'console:/orders', 'console:/orders/:id', 'console:/inbox']) assert.ok(pages.some((p) => p.id === id), id);

  const app = readAppFeatures(repoRoot);
  assert.deepEqual(app.problems, []);
  assert.equal(app.features.length, 51, '50 features and the shell');
});

// ---- The app's contract with the server ----

test('the app opens the link scheme the server writes, and starts Google sign-in where the server listens', () => {
  assert.equal(OWNER_APP_LINK_SCHEME, OWNER_APP_SCHEME);
  assert.match(read('packages/app-core/src/links.js'), new RegExp(`export const OWNER_APP_SCHEME = '${OWNER_APP_SCHEME}';`));
  assert.match(read('apps/owner/app.config.js'), new RegExp(`const SCHEMES = \\['${OWNER_APP_SCHEME}', 'bhava'\\];`));
  assert.match(read('apps/owner/src/shell/sign-in.js'), new RegExp(`const GOOGLE_START = '${AUTH_PATHS.googleStart}';`));
});

test('every entitlement an app feature names is one a plan can hold', () => {
  const migrations = fs.readdirSync(path.join(repoRoot, 'src/db/migrations')).map((file) => read(`src/db/migrations/${file}`)).join('\n');
  const dir = path.join(repoRoot, 'apps/owner/src/features');
  for (const name of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    const feature = /\bfeature: (?:'([^']+)'|null)/.exec(read(`apps/owner/src/features/${name}/index.js`));
    assert.ok(feature, `${name} names an entitlement or null`);
    if (feature[1]) assert.ok(migrations.includes(`'${feature[1]}'`), `${name}: "${feature[1]}" is in plan_features`);
  }
});

// ---- Policy and secrets ----

test('P-03 no business is named anywhere under apps/ or packages/', () => {
  assert.deepEqual(checkFolders(['apps', 'packages']), []);
  assert.deepEqual(checkFolders().filter((f) => /^(apps|packages)\//.test(f.file)), [], 'and the default run covers them');

  const root = tree({
    'apps/owner/src/a.js': "// built first for Mehta Mart\nexport const a = 1;\n",
    'apps/owner/src/b.test.js': "test('opens Plant Store', () => {});\n",
    'apps/owner/app.json': '{ "name": "MehtaMart" }\n',
    'apps/owner/.maestro/flow.yaml': 'appId: com.offerwalebaba.app\n---\n- launchApp\n',
    'packages/ui/README.md': 'Looks like the plantstore theme.\n',
    'packages/ui/src/ok.js': "export const title = 'Your shop';\n",
    'apps/owner/node_modules/x/index.js': "// Mehta Mart\n",
    'apps/owner/android/app/strings.xml': '<string>Mehta Mart</string>\n',
    'src/a.js': "// Mehta Mart's price bands are data now\n",
  });
  const found = checkFolders(['src', 'apps', 'packages'], root).map((f) => `${f.file}:${f.line}`).sort();
  assert.deepEqual(found, ['apps/owner/.maestro/flow.yaml:1', 'apps/owner/app.json:1', 'apps/owner/src/a.js:1', 'apps/owner/src/b.test.js:1', 'packages/ui/README.md:1']);
  assert.equal(checkBrandNames('const shop = "Mehta  Mart";', 'apps/x.js')[0].rule, 'business-name-in-app');
  assert.deepEqual(checkBrandNames('const shop = "Your shop";', 'apps/x.js'), []);
});

test('keystores, Apple keys and Firebase files are refused by name', () => {
  for (const file of ['apps/owner/release.keystore', 'apps/owner/android/app/upload.jks', 'deploy/AuthKey_ABC123.p8', 'apps/shopper/certs/dist.p12', 'apps/owner/google-services.json', 'apps/owner/google-services-prod.json', 'apps/owner/ios/GoogleService-Info.plist', 'a/b/profile.mobileprovision', 'deploy/firebase-service-account.json']) {
    assert.match(scanFileName(file)?.rule ?? '', /keep it outside the repository/, file);
  }
  for (const file of ['apps/owner/app.config.js', 'apps/owner/eas.json', 'apps/owner/package.json', 'apps/owner/assets/icon.png', 'tools/secret-scan.mjs', 'docs/keystore.md', 'apps/owner/src/features/account/index.js']) {
    assert.equal(scanFileName(file), null, file);
  }
  const ignore = read('apps/owner/.gitignore');
  for (const pattern of ['*.jks', '*.keystore', '*.p8', '*.p12', 'google-services.json', 'GoogleService-Info.plist', 'android/', 'ios/']) assert.ok(ignore.includes(pattern), pattern);
});

// ---- The gate ----

test('app tests and Maestro flows count toward requirements by name', () => {
  const root = tree({
    'apps/owner/src/a.test.js': '',
    'apps/owner/src/deep/b.test.jsx': '',
    'apps/owner/src/not-a-test.js': '',
    'apps/owner/node_modules/x/y.test.js': '',
    'apps/owner/android/z.test.js': '',
    'apps/shopper/src/c.test.js': '',
    'packages/ui/src/d.test.js': '',
    'packages/pay/src/e.test.js': '',
    'apps/owner/.maestro/sign-in.yaml': 'appId: x\nname: P-11 sign-in offers Google and a WhatsApp code\n---\n- launchApp\n',
    'apps/owner/.maestro/sub/quoted.yml': 'appId: x\nname: "P-19 offline, Orders shows cached rows"\n---\n- launchApp\n',
    'apps/owner/.maestro/unnamed.yaml': 'appId: x\n---\n- launchApp\n- assertVisible:\n    name: P-99 not a header\n',
    'apps/shopper/.maestro/buy.yaml': 'name: P-30 a shopper buys\n---\n- launchApp\n',
    'requirements/p5.json': JSON.stringify([{ id: 'P-11', title: 'a' }, { id: 'P-19', title: 'b' }, { id: 'P-04', title: 'c' }, { id: 'P-99', title: 'd' }]),
    'requirements/p0.json': '[]', 'requirements/p1.json': '[]', 'requirements/p2.json': '[]', 'requirements/p3.json': '[]', 'requirements/p4.json': '[]',
  });
  assert.deepEqual(appTestFiles(root), ['apps/owner/src/a.test.js', 'apps/owner/src/deep/b.test.jsx', 'apps/shopper/src/c.test.js', 'packages/pay/src/e.test.js', 'packages/ui/src/d.test.js']);
  assert.deepEqual(appTestFiles(root, [6]), ['apps/shopper/src/c.test.js', 'packages/pay/src/e.test.js']);
  const flows = maestroFlows(root);
  assert.deepEqual(flows.map((f) => f.name), ['P-11 sign-in offers Google and a WhatsApp code', 'P-19 offline, Orders shows cached rows', 'unnamed', 'P-30 a shopper buys']);
  assert.deepEqual(maestroFlows(root, [5]).length, 3);

  const jest = readJestResults({
    testResults: [
      { name: path.join(root, 'apps/owner/src/a.test.js'), status: 'passed', assertionResults: [
        { title: 'P-04 an expired token is refreshed', fullName: 'the session P-04 an expired token is refreshed', status: 'passed', failureMessages: [] },
        { title: 'later', status: 'pending', failureMessages: [] },
        { title: 'planned', status: 'todo', failureMessages: [] },
        { title: 'broken', status: 'failed', failureMessages: ['expected 1 to be 2'] },
      ] },
      { name: path.join(root, 'packages/ui/src/d.test.js'), status: 'failed', message: 'SyntaxError: nope', assertionResults: [] },
    ],
  }, root);
  assert.deepEqual(jest.map((r) => [r.source, r.name, r.file, r.outcome]), [
    ['app', 'P-04 an expired token is refreshed', 'apps/owner/src/a.test.js', 'pass'],
    ['app', 'later', 'apps/owner/src/a.test.js', 'skip'],
    ['app', 'planned', 'apps/owner/src/a.test.js', 'todo'],
    ['app', 'broken', 'apps/owner/src/a.test.js', 'fail'],
    ['app', 'packages/ui/src/d.test.js could not run', 'packages/ui/src/d.test.js', 'fail'],
  ]);
  assert.equal(jest[3].message, 'expected 1 to be 2');

  const names = [...jest.map((r) => r.name), ...maestroFlows(root, [5]).map((f) => f.name)];
  assert.deepEqual(checkRequirements(root, 5, names).missing, ['P-99'], 'a name inside a flow body is not the flow’s name');
});

test('app tests belong to a phase and are locked with it', () => {
  assert.equal(phaseOf('apps/owner/src/shell.test.js'), 5);
  assert.equal(phaseOf('packages/app-core/src/session.test.js'), 5);
  assert.equal(phaseOf('apps/shopper/src/cart.test.js'), 6);
  assert.equal(appPhaseOf('packages/store-client/src/a.test.js'), 6);
  assert.equal(phaseOf('test/p3/x.test.js'), 3);
  assert.equal(phaseOf('test/tenancy.test.js'), 0);
  const locked = Object.keys(phaseFileHashes(repoRoot, 5));
  for (const file of ['apps/owner/src/shell.test.js', 'packages/app-core/src/session.test.js', 'packages/theme/src/theme.test.js', 'apps/owner/.maestro/sign-in.yaml', 'requirements/p5.json']) assert.ok(locked.includes(file), file);
  assert.ok(!Object.keys(phaseFileHashes(repoRoot, 4)).some((file) => /^(apps|packages)\//.test(file)), 'earlier phases lock nothing new');
  assert.ok(appTestFiles(repoRoot).length >= 7);
  assert.match(read('tools/gate.mjs'), /readJestResults\(readJson\(report\), repoRoot\)/);
});

// ---- Builds (P-02, I-01) ----

const BADGING = (target, extra = '') => `package: name='com.bhava.business' versionCode='1' versionName='0.1.0' platformBuildVersionName='16' compileSdkVersion='37'\nsdkVersion:'24'\ntargetSdkVersion:'${target}'\n${extra}application-label:'Bhava for Business'\n`;
const XCODE = (xcode, sdk) => `Xcode ${xcode}\nBuild version 17A324\niOS SDKs:\n\tiOS ${sdk}                      \t-sdk iphoneos${sdk}\n\niOS Simulator SDKs:\n\tSimulator - iOS ${sdk}          \t-sdk iphonesimulator${sdk}\n`;

test('P-02 an APK below API 36 or an iOS SDK below 26 fails the build check, and the app asks for 36', () => {
  assert.deepEqual([MIN_TARGET_SDK, MIN_XCODE, MIN_IOS_SDK], [36, 26, 26]);
  assert.deepEqual(checkApkBadging(BADGING(36), { packageName: 'com.bhava.business' }), { ok: true, packageName: 'com.bhava.business', targetSdk: 36, minSdk: 24, debuggable: false, problems: [] });
  assert.equal(checkApkBadging(BADGING(37)).ok, true);
  assert.match(checkApkBadging(BADGING(35)).problems[0], /targetSdkVersion is 35; it must be 36 or higher/);
  assert.match(checkApkBadging(BADGING(36), { packageName: 'com.other.app' }).problems[0], /not com\.other\.app/);
  assert.match(checkApkBadging(BADGING(36, 'application-debuggable\n')).problems[0], /debuggable/);
  assert.equal(checkApkBadging('').ok, false);

  assert.deepEqual(checkXcode(XCODE('26.1', '26.1')), { ok: true, xcode: '26.1', iosSdk: '26.1', problems: [] });
  assert.equal(checkXcode(XCODE('27.0', '27.0')).ok, true);
  assert.match(checkXcode(XCODE('16.4', '18.5')).problems.join(' '), /Xcode is 16\.4.*iOS SDK is 18\.5/);
  assert.equal(checkXcode('Xcode 26.0\n\t-sdk iphonesimulator26.0\n').ok, true);
  assert.equal(checkXcode('').ok, false);

  assert.match(read('apps/owner/app.config.js'), /targetSdkVersion: 36/);
  const run = spawnSync(process.execPath, ['tools/build-check.mjs', 'apk', '--package', 'com.bhava.business'], { cwd: repoRoot, input: BADGING(34), encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /targetSdkVersion is 34/);
  // The checks on the real artifacts run in CI, on the tools' own output.
  const workflow = read('.github/workflows/apps.yml');
  assert.match(workflow, /aapt2.*\n.*dump badging[\s\S]*node tools\/build-check\.mjs apk --package "\$APP_ID"/);
  assert.match(workflow, /xcodebuild -version; xcodebuild -showsdks[\s\S]*node tools\/build-check\.mjs xcode/);
});

test('I-01 every push and pull request builds an Android APK and an iOS simulator app, with no secret and no account', () => {
  const workflow = read('.github/workflows/apps.yml');
  assert.match(workflow, /on:\n {2}push:\n {4}branches: \['bhava\/\*\*', main\]\n {2}pull_request:/);
  const jobs = Object.fromEntries(workflow.split(/\n {2}(?=[a-z][a-z0-9-]*:\n {4}name:)/).slice(1).map((block) => [block.slice(0, block.indexOf(':')), block]));
  assert.deepEqual(Object.keys(jobs), ['app-tests', 'android', 'ios', 'android-e2e']);

  assert.match(jobs['app-tests'], /npm run test:apps/);
  assert.match(jobs['app-tests'], /npm run parity/);
  assert.match(jobs['app-tests'], /npm run app:export/);
  assert.match(read('apps/owner/package.json'), /expo export --platform android --platform ios/);

  assert.match(jobs.android, /java-version: 17/);
  assert.match(jobs.android, /expo prebuild --platform android/);
  assert.match(jobs.android, /gradlew :app:assembleRelease/);
  assert.match(jobs.android, /keytool -genkeypair/);
  assert.match(jobs.android, /rm -f "\$RUNNER_TEMP\/ci\.keystore"/);
  assert.match(jobs.android, /upload-artifact@v4[\s\S]*app-release\.apk/);

  assert.match(jobs.ios, /runs-on: macos-26/);
  assert.match(jobs.ios, /expo prebuild --platform ios/);
  assert.match(jobs.ios, /pod install/);
  assert.match(jobs.ios, /xcodebuild -workspace[\s\S]*-sdk iphonesimulator[\s\S]*CODE_SIGNING_ALLOWED=NO/);
  assert.match(jobs.ios, /upload-artifact@v4/);

  assert.match(jobs['android-e2e'], /android-emulator-runner/);
  assert.match(jobs['android-e2e'], /node tools\/app-e2e-server\.mjs/);
  assert.match(jobs['android-e2e'], /API_BASE_URL: http:\/\/10\.0\.2\.2/);
  assert.match(jobs['android-e2e'], /maestro test .* apps\/owner\/\.maestro/);

  // Nothing lets a broken build pass, and nothing needs an account.
  assert.doesNotMatch(workflow, /continue-on-error|secrets\.|EXPO_TOKEN|\beas (build|update|submit)\b|expo login/);
  for (const [name, block] of Object.entries(jobs)) assert.doesNotMatch(block.replace(/if: always\(\)/g, ''), /^\s+if:/m, `${name} always runs`);
  assert.doesNotMatch(JSON.stringify(json('apps/owner/eas.json')), /projectId/);
});

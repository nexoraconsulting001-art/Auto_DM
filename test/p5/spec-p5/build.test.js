// PRD 10.1, 10.4 and "iOS ready from day one", checked on the repository itself: the workflow file, the app config, the
// build checks, the parity tool and the policy check. These run with no device, no account and no network.
// P-02, P-03, P-14, P-15, P-16, I-01.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRouteFields, routeList, routes } from '../../../src/contracts/api/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const node = (args, input) => spawnSync(process.execPath, args, { cwd: root, input, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '' } });
const workflow = read('.github/workflows/apps.yml');
const parity = await import(pathToFileURL(path.join(root, 'tools/parity-check.mjs')).href);
const { readAppFeatures, readConsolePages } = require(path.join(root, 'tools/parity-read.cjs'));

/** The jobs of a workflow file, by name, each with its text. Plain text reading: no YAML library is installed for this. */
function jobsOf(text) {
  const body = text.slice(text.indexOf('\njobs:') + 6);
  const jobs = {};
  let name = null;
  for (const line of body.split('\n')) {
    const top = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (top) {
      name = top[1];
      jobs[name] = '';
    } else if (name) jobs[name] += `${line}\n`;
  }
  return jobs;
}
const jobs = jobsOf(workflow);

/** The owner app's config, as Expo reads it, with no build settings. */
function appConfig(env = {}) {
  const file = path.join(root, 'apps/owner/app.config.js');
  const saved = { ...process.env };
  Object.assign(process.env, { APP_ENV: '', API_BASE_URL: '', GOOGLE_SERVICES_JSON: '', APNS_ENV: '', ...env });
  try {
    delete require.cache[file];
    const made = require(file);
    return typeof made === 'function' ? made({ config: {} }) : made;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('P-02: the Android build targets API 36 or higher, and the release APK is checked for it', () => {
  const config = appConfig();
  const props = config.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties')?.[1];
  assert.ok(props, 'expo-build-properties is not configured');
  assert.ok(props.android.targetSdkVersion >= 36, `targetSdkVersion is ${props.android.targetSdkVersion}`);
  const rnCatalogue = path.join(root, 'node_modules/react-native/gradle/libs.versions.toml');
  if (fs.existsSync(rnCatalogue)) {
    const target = Number(/^targetSdk\s*=\s*"(\d+)"/m.exec(fs.readFileSync(rnCatalogue, 'utf8'))?.[1]);
    assert.ok(target >= 36, `React Native's own targetSdk is ${target}`);
  }
  assert.match(jobs.android ?? '', /assembleRelease/, 'The android job does not build a release APK');
  assert.match(jobs.android ?? '', /aapt2"? dump badging/i,'The android job does not read the APK\'s manifest');
  assert.match(jobs.android ?? '', /build-check\.mjs apk/, 'The android job does not check the target SDK');
  const badging = (target) => `package: name='com.bhava.business' versionCode='1' versionName='0.1.0'\nsdkVersion:'24'\ntargetSdkVersion:'${target}'\napplication-label:'Bhava for Business'\n`;
  for (const target of [35, 34, 26]) {
    const run = node(['tools/build-check.mjs', 'apk', '--package', 'com.bhava.business'], badging(target));
    assert.equal(run.status, 1, `An APK targeting API ${target} passed the check`);
    assert.match(run.stderr, /targetSdkVersion/);
  }
  for (const target of [36, 37]) assert.equal(node(['tools/build-check.mjs', 'apk', '--package', 'com.bhava.business'], badging(target)).status, 0, `An APK targeting API ${target} failed the check`);
  assert.equal(node(['tools/build-check.mjs', 'apk'], 'not aapt2 output').status, 1, 'Junk passed the APK check');
  assert.equal(node(['tools/build-check.mjs', 'apk'], `${badging(36)}application-debuggable\n`).status, 1, 'A debuggable APK passed');
});

test('P-02: iOS builds use Xcode 26 and the iOS 26 SDK, on a runner that has them, checked on the build itself', () => {
  assert.match(jobs.ios ?? '', /runs-on:\s*macos-(2[6-9]|[3-9]\d)/, 'The iOS job does not run on macOS 26 or newer');
  assert.match(jobs.ios ?? '', /Xcode_26/, 'The iOS job does not choose Xcode 26');
  assert.match(jobs.ios ?? '', /build-check\.mjs xcode/, 'The iOS job does not check the Xcode and SDK versions');
  assert.match(jobs.ios ?? '', /DTSDKName/, 'The iOS job does not read the SDK the app was built with');
  const xcode = (version, sdk) => `Xcode ${version}\nBuild version 17A324\niOS SDKs:\n\tiOS ${sdk}\t-sdk iphoneos${sdk}\niOS Simulator SDKs:\n\tSimulator - iOS ${sdk}\t-sdk iphonesimulator${sdk}\n`;
  assert.equal(node(['tools/build-check.mjs', 'xcode'], xcode('26.0', '26.0')).status, 0);
  assert.equal(node(['tools/build-check.mjs', 'xcode'], xcode('26.1', '26.1')).status, 0);
  for (const [version, sdk] of [['16.4', '18.4'], ['26.0', '18.5'], ['15.0', '26.0']]) {
    const run = node(['tools/build-check.mjs', 'xcode'], xcode(version, sdk));
    assert.equal(run.status, 1, `Xcode ${version} with the iOS ${sdk} SDK passed`);
  }
  assert.equal(node(['tools/build-check.mjs', 'xcode'], '').status, 1, 'No output passed the Xcode check');
});

test('P-03: no business\'s brand name appears anywhere under apps/ or packages/', () => {
  const seed = JSON.parse(read('seed/mehtamart.json'));
  const names = [seed.store?.store_name, seed.store?.store_name?.replace(/\s+MHM$/i, ''), seed.store?.instagram_handle, 'Plant Store'].filter(Boolean);
  const patterns = names.flatMap((n) => [n, n.replace(/[\s_]+/g, ''), n.replace(/\s+/g, '-')]).map((n) => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  const skip = new Set(['node_modules', 'android', 'ios', 'dist', 'build', '.expo']);
  const hits = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.(js|jsx|cjs|mjs|json|ya?ml|md|txt|xml|plist|html|css|ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(path.join(root, child), 'utf8');
        for (const p of patterns) if (p.test(text)) hits.push(`${child}: ${p.source}`);
      }
    }
  };
  for (const dir of ['apps', 'packages']) if (fs.existsSync(path.join(root, dir))) walk(dir);
  assert.deepEqual(hits, [], 'A business is named in the apps');
  // The repository's own check agrees, and is run in CI.
  const run = node(['tools/policy-check.mjs', 'apps', 'packages']);
  assert.equal(run.status, 0, `npm run policy-check over apps and packages: ${run.stdout}${run.stderr}`.slice(0, 600));
  assert.match(jobs['app-tests'] ?? '', /policy-check/, 'CI does not run the policy check for the apps');
});

test('P-03: the policy check catches a business name in an app file, even in a comment', async () => {
  const policy = await import(pathToFileURL(path.join(root, 'tools/policy-check.mjs')).href);
  const seed = JSON.parse(read('seed/mehtamart.json'));
  const name = seed.store.store_name.replace(/\s+MHM$/i, '');
  assert.ok(policy.checkBrandNames(`// Made for ${name}\nconst x = 1;`, 'apps/owner/src/x.js').length >= 1, 'A business name in a comment passed');
  assert.ok(policy.checkBrandNames(`export const title = '${name.toUpperCase()}';`, 'apps/owner/src/x.js').length >= 1, 'A business name in capitals passed');
  assert.ok(policy.checkBrandNames('name: plant store\n', 'apps/owner/.maestro/x.yaml').length >= 1);
  assert.equal(policy.checkBrandNames('Bhava for Business\n', 'apps/owner/src/x.js').length, 0);
});

test('P-14: a console page with no app screen fails the parity check, which names it, and CI runs that check', () => {
  // A console feature that registers a page no app feature lists, as a track adding /admin/coupons-only-here would.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-p14-'));
  try {
    const feature = path.join(tmp, 'console/src/features/spec-coupons');
    fs.mkdirSync(feature, { recursive: true });
    fs.writeFileSync(path.join(feature, 'index.jsx'), "export default { name: 'spec-coupons', routes: [{ path: 'spec-coupons', element: <Page /> }] };\n");
    const added = readConsolePages(tmp);
    assert.deepEqual(added.pages.map((p) => p.id), ['console:/spec-coupons']);
    const features = readAppFeatures(root);
    const pending = parity.readPending(root);
    const result = parity.checkParity({ routes: routeList.map((r) => ({ ...r })), pages: [...readConsolePages(root).pages, ...added.pages], features: features.features, pending });
    assert.equal(result.ok, false, 'A console page with no app screen passed the parity check');
    assert.ok(result.problems.some((p) => p.includes('/spec-coupons')), `The check did not name the page: ${result.problems.join(' | ').slice(0, 400)}`);
    // A seller route with no screen and no allowance fails the same way.
    const route = { id: 'specCoupons.list', method: 'GET', path: '/spec-coupons', access: { roles: ['owner', 'manager'] } };
    const withRoute = parity.checkParity({ routes: [...routeList.map((r) => ({ ...r })), route], pages: readConsolePages(root).pages, features: features.features, pending });
    assert.ok(withRoute.problems.some((p) => p.includes('specCoupons.list')), 'A seller route with no app screen was not named');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.match(jobs['app-tests'] ?? '', /npm run parity/, 'CI does not run the parity check');
  assert.match(workflow, /on:[\s\S]*push:[\s\S]*pull_request/, 'The parity check does not run on every push and pull request');
});

test('P-14: the parity check on the repository as it is passes, and the allowance file only names real, unmapped ids', () => {
  const run = node(['tools/parity-check.mjs']);
  assert.equal(run.status, 0, `npm run parity: ${run.stderr}`.slice(0, 800));
  const pending = parity.readPending(root);
  const known = new Set(routeList.map((r) => r.id));
  const mapped = new Set(readAppFeatures(root).features.flatMap((f) => f.routeIds));
  for (const id of pending.routes) {
    assert.ok(known.has(id), `${id} in parity-pending.json is not a route`);
    assert.ok(!mapped.has(id), `${id} is mapped and still allowed`);
  }
});

test('P-15: a web-only flag on a route is rejected by the contract and by the parity check', () => {
  for (const flag of ['webOnly', 'web_only', 'webonly', 'WebOnly', 'web-only']) {
    assert.throws(() => assertRouteFields('orders.list', { ...routes['orders.list'], [flag]: true }), /./, `The contract took ${flag}`);
    const result = parity.checkParity({ routes: [{ id: 'orders.list', ...routes['orders.list'], [flag]: true }], pages: [], features: [{ name: 'orders', routeIds: ['orders.list'] }] });
    assert.equal(result.ok, false, `The parity check took ${flag}`);
    assert.ok(result.problems.some((p) => p.includes('orders.list') && p.includes(flag)), `The parity check did not name orders.list and ${flag}`);
  }
  for (const route of routeList) for (const field of Object.keys(route)) assert.doesNotMatch(field, /web.?only|desktop.?only|no.?app/i, `${route.id} has ${field}`);
  // console-only is the one exemption, for ops, and no seller route carries it.
  assert.deepEqual(routeList.filter((r) => r.consoleOnly).map((r) => r.id), []);
});

test('P-16: the parity check maps the owner inbox and key entry to app screens', () => {
  const features = readAppFeatures(root).features;
  const pending = parity.readPending(root);
  const mapped = new Map();
  for (const f of features) for (const id of f.routeIds) mapped.set(id, f.name);
  const inbox = routeList.filter((r) => /^inbox\./.test(r.id)).map((r) => r.id);
  const keys = routeList.filter((r) => r.fresh && /payment|shipping|shopify|whatsappAccount|apiKeys|tags|settings\.updatePayment/i.test(r.id)).map((r) => r.id);
  assert.ok(inbox.length >= 2, `Only ${inbox.length} inbox routes`);
  assert.ok(keys.includes('settings.updatePayment') && keys.includes('apiKeys.create'), `Key entry routes: ${keys}`);
  const unmapped = [...inbox, ...keys].filter((id) => !mapped.has(id));
  assert.deepEqual(unmapped, [], 'The owner inbox or key entry has no app screen');
  assert.deepEqual([...inbox, ...keys].filter((id) => pending.routes.includes(id)), [], 'They are only allowed for now in parity-pending.json');
  const pages = readConsolePages(root).pages.filter((p) => /inbox|needs-human|payment|keys|integrations/i.test(p.id)).map((p) => p.id);
  assert.deepEqual(pages.filter((id) => !mapped.has(id)), [], 'A console inbox or key page has no app screen');
});

test('I-01: every merge builds an Android APK and an iOS simulator app, and a failure of either blocks the release', () => {
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[[^\]]*\bmain\b/, 'The apps workflow does not run on merges to main');
  for (const [job, artifact] of [['android', /name:\s*owner-android-apk/], ['ios', /name:\s*owner-ios-simulator-app/]]) {
    assert.ok(jobs[job], `No ${job} job`);
    assert.match(jobs[job], artifact, `The ${job} job does not keep what it built`);
    assert.match(jobs[job], /if-no-files-found:\s*error/, `The ${job} job does not fail when nothing was built`);
  }
  assert.match(jobs.ios, /-sdk iphonesimulator/);
  assert.match(jobs.ios, /CODE_SIGNING_ALLOWED=NO/, 'The simulator build needs signing');
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/, 'A job may fail without failing the workflow');
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./, 'The app builds need a secret');
  assert.doesNotMatch(workflow, /eas build|EXPO_TOKEN/i, 'The builds depend on an EAS account');
  for (const [name, text] of Object.entries(jobs)) {
    if (!/release|deploy|publish|submit/i.test(name)) continue;
    assert.match(text, /needs:[^\n]*android/, `${name} does not wait for the Android build`);
    assert.match(text, /needs:[^\n]*ios/, `${name} does not wait for the iOS build`);
  }
});

test('I-01: the app is ready for iOS: Sign in with Apple, permission texts, the privacy manifest, Apple-size icons and no Android-only start', () => {
  const config = appConfig();
  assert.equal(config.ios.usesAppleSignIn, true, 'Sign in with Apple is not on');
  assert.ok(config.ios.bundleIdentifier, 'No iOS bundle id');
  for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSFaceIDUsageDescription']) assert.ok(config.ios.infoPlist?.[key], `No ${key}`);
  assert.equal(config.ios.privacyManifests?.NSPrivacyTracking, false);
  assert.ok((config.ios.privacyManifests?.NSPrivacyAccessedAPITypes ?? []).length >= 1, 'The privacy manifest names no required-reason API');
  assert.deepEqual([...config.platforms].sort(), ['android', 'ios']);
  assert.equal(config.name, 'Bhava for Business', 'The app is not Bhava-branded');
  const pkg = JSON.parse(read('apps/owner/package.json'));
  for (const dep of ['expo-apple-authentication', 'expo-local-authentication', 'expo-secure-store', 'expo-notifications']) assert.ok(pkg.dependencies[dep], `${dep} is missing`);
  assert.ok(!Object.keys(pkg.dependencies).some((d) => /async-storage/i.test(d)), 'AsyncStorage is a dependency');
  const icon = fs.readFileSync(path.join(root, 'apps/owner', config.icon));
  assert.equal(icon.readUInt32BE(16), 1024, 'The app icon is not 1024 px wide, the size Apple asks for');
  assert.equal(icon.readUInt32BE(20), 1024, 'The app icon is not 1024 px high');
  // A production build refuses plain http for the API.
  assert.throws(() => appConfig({ APP_ENV: 'production', API_BASE_URL: 'http://api.example' }), /https/);
});

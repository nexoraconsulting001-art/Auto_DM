// The pre-submit gate (PRD 10.14, P-59, P-57) as a tool: every check named by its guideline, run on the facts of a built app and
// on a built app folder, the command's exit code, the release facts the server reads kept equal to the app, and a playbook file
// for every playbook. No database and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLAYBOOKS, PRESUBMIT_CHECKS, namesPlatform, presubmitChecksFor } from '../../../src/contracts/apps.js';
import {
  DEFAULT_APP_DIR, LOCAL_SERVER_FACTS, NATIVE_SCREENS, REPO_ROOT, REQUIRED_REASON_APIS, failureSummary, inspectApp, main, parseToolchain, readReleaseFacts,
  releaseFactsFile, runPresubmit, versionAtLeast,
} from '../../../tools/presubmit/index.mjs';

const MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyAccessedAPITypes: REQUIRED_REASON_APIS.map((type, i) => ({ NSPrivacyAccessedAPIType: type, NSPrivacyAccessedAPITypeReasons: [['CA92.1', 'C617.1', '35F9.1', 'E174.1'][i]] })),
};
const goodApp = () => ({
  appVersion: '1.0.0', expoSdk: 58, dependencies: ['expo', 'expo-notifications', 'expo-web-browser', 'react-native', 'react-native-razorpay'], webviewImports: [],
  features: [...NATIVE_SCREENS, 'reels', 'sign-in'], accountDeleteScreen: true, accountDeleteCall: true, pushAtLaunch: [],
  android: { targetSdkVersion: 36, permissions: ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS'] },
  ios: { privacyManifest: structuredClone(MANIFEST), entitlements: {}, toolchain: { xcode: '26.0', sdk: '26.0', source: 'test' } },
  brandTexts: ['Mehta Mart', 'in.example.mehta'],
});
const goodServer = () => ({ ...LOCAL_SERVER_FACTS, reviewAccess: { enabled: true, phone: true, code: true }, brand: { texts: ['Mehta Mart', 'shop.mehta.example'] } });
const run = (platform, app = goodApp(), server = goodServer()) => runPresubmit({ platform, app, server });
const failed = (report) => report.checks.filter((c) => !c.passed).map((c) => c.code);

test('a complete build passes every check of its platform, one entry per check in the contract\'s order', () => {
  for (const platform of ['android', 'ios']) {
    const report = run(platform);
    assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.passed)));
    assert.deepEqual(report.checks.map((c) => c.code), presubmitChecksFor(platform).map((c) => c.code));
    assert.deepEqual(report.checks.map((c) => c.guideline), presubmitChecksFor(platform).map((c) => c.guideline));
    for (const c of report.checks) assert.ok(c.detail.length > 5 && c.detail.length <= 500 && !namesPlatform(c.detail));
  }
  // The privacy manifest's pass says nothing a store would read as a warning (P-57).
  assert.doesNotMatch(run('ios').checks.find((c) => c.code === 'privacy_manifest').detail, /warning|missing|ITMS/i);
});

test('P-59: a build missing account deletion, native screens, gateway payments, demo access or push opt-out fails and names the guideline', () => {
  const cases = [
    ['account deletion screen', (a) => { a.accountDeleteScreen = false; }, 'account_deletion', '5.1.1(v)'],
    ['account deletion call', (a) => { a.accountDeleteCall = false; }, 'account_deletion', '5.1.1(v)'],
    ['a web view library', (a) => { a.dependencies.push('react-native-webview'); }, 'native_screens', '4.2'],
    ['a screen that is a web page', (a) => { a.webviewImports = ['apps/shopper/src/features/cart/CartScreen.js']; }, 'native_screens', '4.2'],
    ['a missing native screen', (a) => { a.features = a.features.filter((f) => f !== 'checkout'); }, 'native_screens', '4.2'],
    ['an in-app purchase library', (a) => { a.dependencies.push('react-native-iap'); }, 'gateway_payments', '3.1.3(e)'],
    ['a purchases SDK', (a) => { a.dependencies.push('react-native-purchases'); }, 'gateway_payments', '3.1.3(e)'],
    ['a permission request at launch', (a) => { a.pushAtLaunch = ['apps/shopper/src/App.js']; }, 'push_opt_in_out', '4.5.4'],
  ];
  for (const [what, spoil, code, guideline] of cases) {
    for (const platform of ['android', 'ios']) {
      const app = goodApp();
      spoil(app);
      const report = run(platform, app);
      assert.equal(report.passed, false, `${what} passed on ${platform}`);
      assert.deepEqual(failed(report), [code], `${what} on ${platform}`);
      assert.ok(failureSummary(report.checks).includes(guideline), `${what}: the summary does not name ${guideline}`);
    }
  }
  // The in-app payment entitlement on iOS, the store billing permission on Android.
  const ios = goodApp();
  ios.ios.entitlements = { 'com.apple.developer.in-app-payments': ['merchant.x'] };
  assert.deepEqual(failed(run('ios', ios)), ['gateway_payments']);
  const android = goodApp();
  android.android.permissions.push('com.android.vending.BILLING');
  assert.deepEqual(failed(run('android', android)), ['gateway_payments']);
  // Demo access: off, or on without a number or a code. Offers on by default; a switch missing.
  for (const reviewAccess of [{ enabled: false, phone: true, code: true }, { enabled: true, phone: false, code: true }, { enabled: true, phone: true, code: false }, undefined]) {
    const report = run('ios', goodApp(), { ...goodServer(), reviewAccess });
    assert.deepEqual(failed(report), ['demo_access']);
    assert.match(failureSummary(report.checks), /2\.1\(a\)/);
  }
  assert.deepEqual(failed(run('android', goodApp(), { ...goodServer(), push: { toggles: ['order_updates', 'offers', 'new_reels'], defaultOn: ['offers'] } })), ['push_opt_in_out']);
  assert.deepEqual(failed(run('android', goodApp(), { ...goodServer(), push: { toggles: ['order_updates', 'offers'], defaultOn: [] } })), ['push_opt_in_out']);
  // The server's own route.
  assert.deepEqual(failed(run('android', goodApp(), { ...goodServer(), accountDeletionRoute: false })), ['account_deletion']);
  // The system browser tab is not a web view, and the gateway's SDK is not in-app purchase.
  assert.equal(run('android').checks.find((c) => c.code === 'native_screens').passed, true);
});

test('the platform minimums and the privacy manifest: each failure names its own guideline', () => {
  const low = goodApp();
  low.android.targetSdkVersion = 35;
  assert.deepEqual(failed(run('android', low)), ['target_api']);
  assert.match(failureSummary(run('android', low).checks), /play:target_api/);
  const unknown = goodApp();
  unknown.android.targetSdkVersion = null;
  assert.deepEqual(failed(run('android', unknown)), ['target_api']);
  // target_api is Android's only; the iOS checks are iOS's only.
  assert.equal(run('ios', low).passed, true);
  for (const [xcode, sdk] of [['16.4', '18.5'], ['26.0', '18.0'], [null, null]]) {
    const old = goodApp();
    old.ios.toolchain = { xcode, sdk };
    assert.deepEqual(failed(run('ios', old)), ['ios_sdk'], `${xcode} / ${sdk}`);
    assert.equal(run('android', old).passed, true);
  }
  const later = goodApp();
  later.ios.toolchain = { xcode: '26.2', sdk: '26.2' };
  assert.equal(run('ios', later).passed, true);
  const spoilers = [
    (m) => null,
    (m) => ({ ...m, NSPrivacyTracking: true }),
    (m) => ({ ...m, NSPrivacyTrackingDomains: ['ads.example'] }),
    (m) => ({ ...m, NSPrivacyAccessedAPITypes: m.NSPrivacyAccessedAPITypes.slice(1) }),
    (m) => ({ ...m, NSPrivacyAccessedAPITypes: m.NSPrivacyAccessedAPITypes.map((e, i) => (i ? e : { ...e, NSPrivacyAccessedAPITypeReasons: [] })) }),
    (m) => ({ ...m, NSPrivacyAccessedAPITypes: m.NSPrivacyAccessedAPITypes.map((e, i) => (i ? e : { ...e, NSPrivacyAccessedAPITypeReasons: ['because'] })) }),
  ];
  for (const spoil of spoilers) {
    const app = goodApp();
    app.ios.privacyManifest = spoil(app.ios.privacyManifest);
    const report = run('ios', app);
    assert.deepEqual(failed(report), ['privacy_manifest']);
    assert.match(failureSummary(report.checks), /ios:privacy_manifest/);
  }
  assert.equal(versionAtLeast('26.0', '26'), true);
  assert.equal(versionAtLeast('25.9.9', '26.0'), false);
  assert.equal(versionAtLeast(null, '26.0'), false);
});

test('brand only: a brand text that names the platform fails, and no brand texts at all is not a pass', () => {
  const app = goodApp();
  app.brandTexts.push('shop.bhava.example');
  assert.deepEqual(failed(run('android', app)), ['brand_only']);
  assert.deepEqual(failed(run('android', goodApp(), { ...goodServer(), brand: { texts: ['Bhava Mart'] } })), ['brand_only']);
  const none = goodApp();
  none.brandTexts = [];
  assert.deepEqual(failed(run('android', none, { ...goodServer(), brand: { texts: [] } })), ['brand_only']);
  // Facts that are junk fail their checks; they never crash the run.
  const junk = runPresubmit({ platform: 'ios', app: { dependencies: 'x', features: 7, ios: 'no' }, server: null });
  assert.equal(junk.passed, false);
  assert.equal(junk.checks.length, presubmitChecksFor('ios').length);
  assert.throws(() => runPresubmit({ platform: 'web', app: goodApp() }), /android or ios/);
});

/** A built app's folder: package.json, its resolved config, its features and its launch path. */
function builtApp({ deps = {}, config = {}, accountDelete = true, launch = '', features = [...NATIVE_SCREENS, 'reels'], extraFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'built-app-'));
  const app = path.join(dir, 'apps', 'shopper');
  fs.mkdirSync(path.join(app, 'src', 'features'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'shop-app', version: '1.0.0', dependencies: { expo: '~58.0.1', 'react-native': '0.88.1', 'expo-web-browser': '~58.0.1', ...deps } }));
  const resolved = {
    name: 'Mehta Mart', slug: 'mehtamart', scheme: 'mehtamart',
    ios: { bundleIdentifier: 'in.example.mehta', privacyManifests: MANIFEST, entitlements: {}, associatedDomains: ['applinks:shop.mehta.example'], ...config.ios },
    android: { package: 'in.example.mehta', permissions: ['android.permission.POST_NOTIFICATIONS'], ...config.android },
    plugins: [['expo-build-properties', { android: { targetSdkVersion: config.targetSdk ?? 36 } }]],
  };
  fs.writeFileSync(path.join(app, 'app.config.json'), JSON.stringify(resolved));
  for (const name of features) {
    fs.mkdirSync(path.join(app, 'src', 'features', name));
    const screens = name === 'account' && accountDelete ? "[{ name: 'account' }, { name: 'delete', path: 'account/delete' }]" : `[{ name: '${name}' }]`;
    fs.writeFileSync(path.join(app, 'src', 'features', name, 'index.js'), `export default { name: '${name}', screens: ${screens} };\n`);
  }
  fs.writeFileSync(path.join(app, 'src', 'api.js'), accountDelete ? "export const remove = (client) => client.call('appAccountDelete', {});\n" : 'export {};\n');
  fs.writeFileSync(path.join(app, 'src', 'App.js'), `export default function App() { ${launch} return null; }\n`);
  for (const [file, text] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    fs.writeFileSync(path.join(app, file), text);
  }
  return { dir, app };
}

test('the tool reads a built app folder: each thing a reviewer would reject is found in the files and fails its check', () => {
  const made = [];
  const inspect = (options) => {
    const built = builtApp(options);
    made.push(built.dir);
    return inspectApp({ appDir: built.app, toolchain: { xcode: '26.0', sdk: '26.0' } });
  };
  try {
    const good = inspect();
    assert.equal(runPresubmit({ platform: 'android', app: good, server: goodServer() }).passed, true, JSON.stringify(runPresubmit({ platform: 'android', app: good, server: goodServer() }).checks.filter((c) => !c.passed)));
    assert.equal(runPresubmit({ platform: 'ios', app: good, server: goodServer() }).passed, true);
    assert.ok(good.brandTexts.includes('shop.mehta.example') && good.brandTexts.includes('Mehta Mart'));
    const cases = [
      [{ deps: { 'react-native-webview': '13.0.0' } }, 'native_screens'],
      [{ extraFiles: { 'src/features/cart/Web.js': "import { WebView } from 'some-web-thing';\nexport const X = () => <WebView />;\n" } }, 'native_screens'],
      [{ accountDelete: false }, 'account_deletion'],
      [{ deps: { 'expo-in-app-purchases': '1.0.0' } }, 'gateway_payments'],
      [{ launch: 'Notifications.requestPermissionsAsync();' }, 'push_opt_in_out'],
      [{ config: { targetSdk: 34 } }, 'target_api'],
    ];
    for (const [options, code] of cases) {
      const report = runPresubmit({ platform: 'android', app: inspect(options), server: goodServer() });
      assert.deepEqual(failed(report), [code], JSON.stringify(options));
    }
    const noManifest = runPresubmit({ platform: 'ios', app: inspect({ config: { ios: { privacyManifests: undefined } } }), server: goodServer() });
    assert.deepEqual(failed(noManifest), ['privacy_manifest']);
    // A test file that shows a web view does not count: it is not in the build.
    const testOnly = inspect({ extraFiles: { 'src/features/cart/Web.test.js': "import { WebView } from 'react-native-webview';\n" } });
    assert.deepEqual(testOnly.webviewImports, []);
  } finally {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the command exits 1 naming the guideline, 0 when everything passes, 2 when used wrongly; the toolchain is read from xcodebuild', async () => {
  const built = builtApp();
  try {
    const out = [];
    const sink = { write: (s) => out.push(s) };
    assert.equal(await main(['--platform', 'ios', '--app', built.app], { stdout: sink, stderr: sink }), 1, 'Review access is off away from the server');
    assert.match(out.join(''), /FAIL\s+demo_access\s+2\.1\(a\)/);
    const facts = path.join(built.dir, 'server.json');
    fs.writeFileSync(facts, JSON.stringify({ reviewAccess: { enabled: true, phone: true, code: true } }));
    const xcode = path.join(built.dir, 'xcode.txt');
    fs.writeFileSync(xcode, 'Xcode 26.1\nBuild version 17B55\niOS SDKs:\n\tiOS 26.1 -sdk iphoneos26.1\n');
    out.length = 0;
    assert.equal(await main(['--platform', 'ios', '--app', built.app, '--server', facts, '--toolchain', xcode, '--json'], { stdout: sink, stderr: sink }), 0, out.join(''));
    const report = JSON.parse(out.join(''));
    assert.equal(report.passed, true);
    assert.match(report.checks.find((c) => c.code === 'ios_sdk').detail, /Xcode 26\.1 with the iOS 26\.1 SDK/);
    assert.equal(await main(['--platform', 'web'], { stdout: sink, stderr: sink }), 2);
    assert.equal(await main(['--platform', 'ios', '--app', path.join(built.dir, 'nothing')], { stdout: sink, stderr: sink }), 2);
    assert.deepEqual(parseToolchain('Xcode 26.0\n\t-sdk iphoneos26.0\n\t-sdk iphonesimulator26.0'), { xcode: '26.0', sdk: '26.0' });
    assert.deepEqual(parseToolchain('nothing here'), { xcode: null, sdk: null });
  } finally {
    fs.rmSync(built.dir, { recursive: true, force: true });
  }
});

test('the release facts the server reads are the shopper app\'s own, for its current version, and they pass the app\'s checks', () => {
  const committed = readReleaseFacts();
  assert.ok(committed, 'src/modules/app-submissions/release-facts.json is missing');
  const now = releaseFactsFile({ current: committed });
  const version = JSON.parse(fs.readFileSync(path.join(DEFAULT_APP_DIR, 'package.json'), 'utf8')).version;
  assert.deepEqual(committed.releases[version], now.releases[version], 'The shopper app changed: run node tools/presubmit/index.mjs --release-facts --write');
  assert.ok(!namesPlatform(JSON.stringify(committed)), 'The release facts name the platform');
  // What the app itself holds passes every check that is the app's (the server adds review access and the brand).
  for (const platform of ['android', 'ios']) {
    const report = runPresubmit({ platform, app: committed.releases[version], server: goodServer() });
    assert.deepEqual(failed(report), [], `${platform}: ${failureSummary(report.checks)}`);
  }
});

test('every playbook has its file in docs/playbooks, and none names the platform', () => {
  for (const book of Object.values(PLAYBOOKS)) {
    const file = path.join(REPO_ROOT, book.doc);
    assert.ok(fs.existsSync(file), `${book.doc} is missing`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(book.title), `${book.doc} does not carry its title`);
    assert.ok(!namesPlatform(text), `${book.doc} names the platform`);
  }
  assert.equal(PRESUBMIT_CHECKS.length, 9);
});

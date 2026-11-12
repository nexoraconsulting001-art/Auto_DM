// The shopper app's workspace (PRD 10.1, 10.7, 10.8): the store client against the contract, one source tree for many brands,
// the brand build tool's steps, and the tools that hold the app to the product's rules. The app's own tests are jest
// (npm run test:apps); these are the parts that run with the server's tests, with no React Native installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_LINK_PATHS, BUILD_DRIVERS, BUILD_STEPS, BrandFile, SHOPPER_APP_HEADERS, SHOPPER_AUTH_SCHEME, namesPlatform } from '../../../src/contracts/apps.js';
import { APP_ROUTES, STORE_ROUTES } from '../../../src/contracts/store-routes.js';
import { APP_NAME, AUTH_SCHEME, HEADERS, PAGES, ROUTES, STORE_APP_CALLS } from '../../../packages/store-client/src/routes.js';
import { linkPattern } from '../../../apps/shopper/src/shell/menu.js';
import { STEPS, STEP_NAMES, buildBrand, parseArgs } from '../../../tools/build-brand/index.mjs';
import { buildEnv, localCommands } from '../../../tools/build-brand/drivers/local.mjs';
import { BRAND_ASSETS } from '../../../tools/build-brand/steps/assets.mjs';
import { brandProblems } from '../../../tools/build-brand/steps/validate.mjs';
import { checkApkBadging } from '../../../tools/build-check.mjs';
import { BRAND_FIXTURES, appPhaseOf, appTestFiles, maestroFlows, phaseFileHashes, repoRoot } from '../../../tools/gate-lib.mjs';
import { brandValues, checkBrandNames, checkBrandValues, checkFolders, checkShopperSource } from '../../../tools/policy-check.mjs';
import { scanFileName } from '../../../tools/secret-scan.mjs';

const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const FIXTURES = path.join(repoRoot, BRAND_FIXTURES);
const brands = fs.readdirSync(FIXTURES).filter((name) => fs.existsSync(path.join(FIXTURES, name, 'brand.json'))).sort();
const brandFile = (name) => path.join(FIXTURES, name, 'brand.json');
const brandOf = (name) => JSON.parse(fs.readFileSync(brandFile(name), 'utf8'));
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const quiet = { log: () => {} };

/** A copy of a fixture brand with one thing changed. Answers the brand file's path. */
function changedBrand(change) {
  const dir = temp('brand-');
  fs.cpSync(path.join(FIXTURES, brands[0]), dir, { recursive: true });
  const brand = JSON.parse(fs.readFileSync(path.join(dir, 'brand.json'), 'utf8'));
  change(brand, dir);
  fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify(brand, null, 2));
  return path.join(dir, 'brand.json');
}

// ---- the store client and the contract ----

test('the store client’s routes are the contract’s: every app route, and each store call the app uses, with the same method and path', () => {
  const appJson = Object.entries(APP_ROUTES).filter(([, route]) => route.kind === 'json');
  for (const [id, route] of appJson) assert.deepEqual(ROUTES[id], { method: route.method, path: route.path, auth: route.auth }, id);
  for (const id of STORE_APP_CALLS) {
    const route = STORE_ROUTES[id];
    assert.ok(route && route.kind === 'json', `${id} is a JSON call of the store`);
    assert.deepEqual(ROUTES[id], { method: route.method, path: route.path, auth: 'app' }, id);
  }
  assert.deepEqual(Object.keys(ROUTES).sort(), [...appJson.map(([id]) => id), ...STORE_APP_CALLS].sort(), 'and nothing the contract does not have');
  assert.equal(new Set(Object.keys(ROUTES)).size, appJson.length + STORE_APP_CALLS.length, 'no id is in both lists');
});

test('the store calls the client carries are the ones the contract says the app uses unchanged', () => {
  const text = read('src/contracts/store-routes.js').replace(/\n \* ?/g, ' ');
  const listed = /Phase 4 JSON the app calls unchanged, with its app session: (.*?)\. Payment uses/.exec(text)?.[1];
  assert.ok(listed, 'the contract still lists them');
  const ids = listed.split(',').map((part) => part.trim().split(' ')[0]);
  assert.deepEqual([...STORE_APP_CALLS].sort(), ids.sort());
});

test('the client sends the contract’s headers and scheme, and opens the contract’s pages', () => {
  assert.deepEqual({ ...HEADERS }, { ...SHOPPER_APP_HEADERS });
  assert.equal(AUTH_SCHEME, SHOPPER_AUTH_SCHEME);
  assert.equal(APP_NAME, 'shopper');
  assert.deepEqual({ ...PAGES }, { order: STORE_ROUTES.order.path, googleStart: APP_ROUTES.appGoogleStart.path });
  assert.ok(!/from '|require\(/.test(read('packages/store-client/src/routes.js')), 'the route table imports nothing');
  assert.deepEqual(Object.keys(json('packages/store-client/package.json').dependencies ?? {}), [], 'and the client has no dependencies');
});

// ---- the workspace ----

test('apps/shopper is a workspace on the owner app’s Expo SDK and libraries, without the seller client', () => {
  const owner = json('apps/owner/package.json');
  const shopper = json('apps/shopper/package.json');
  for (const [dir, name] of [['apps/shopper', '@bhava/shopper-app'], ['packages/store-client', '@bhava/store-client'], ['packages/pay', '@bhava/pay']]) assert.equal(json(`${dir}/package.json`).name, name);
  for (const name of ['@bhava/app-core', '@bhava/theme', '@bhava/ui', '@bhava/store-client', '@bhava/pay']) assert.equal(shopper.dependencies[name], '*', name);
  assert.equal(shopper.dependencies['@bhava/api-client'], undefined);
  for (const [name, range] of Object.entries(shopper.dependencies)) {
    if (owner.dependencies[name]) assert.equal(range, owner.dependencies[name], `${name} is at the owner app's version`);
  }
  const sdk = /(\d+)\./.exec(shopper.dependencies.expo)[1];
  for (const [name, range] of Object.entries(shopper.dependencies)) if (/^expo-/.test(name)) assert.match(range, new RegExp(`^[~^]?${sdk}\\.`), `${name} is at Expo SDK ${sdk}`);
  for (const name of ['expo-video', 'expo-web-browser', 'expo-linking', 'expo-apple-authentication', 'expo-notifications', 'expo-updates', 'expo-secure-store', 'expo-sqlite', 'react-native-razorpay']) {
    assert.ok(shopper.dependencies[name], `apps/shopper depends on ${name}`);
  }
  assert.equal(shopper.dependencies['expo-router'], undefined);
  assert.deepEqual(Object.keys(shopper.dependencies).filter((name) => /async-storage|iap|in-app-purchase|purchases/i.test(name)), []);
  assert.deepEqual(shopper.devDependencies, owner.devDependencies);
});

test('the commands and the jest projects exist, and app-core can be taken by its parts', () => {
  const root = json('package.json');
  assert.equal(root.scripts['build-brand'], 'node tools/build-brand/index.mjs');
  assert.equal(typeof root.scripts['shopper:export'], 'string');
  const projects = require(path.join(repoRoot, 'jest.apps.config.cjs')).projects;
  for (const dir of ['apps/shopper', 'packages/store-client', 'packages/pay']) assert.ok(projects.includes(`<rootDir>/${dir}`), dir);
  const core = json('packages/app-core/package.json').exports;
  for (const part of ['strings', 'cache', 'links', 'push', 'storage', 'time']) assert.ok(fs.existsSync(path.join(repoRoot, 'packages/app-core', core[`./${part}`])), part);
});

test('twenty feature folders, each with an index that default-exports name, screens and nav', () => {
  const dir = path.join(repoRoot, 'apps/shopper/src/features');
  const folders = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(folders, ['account', 'addresses', 'cart', 'catalog', 'category', 'checkout', 'home', 'legal', 'notifications', 'orders', 'payment', 'product', 'returns', 'reviews', 'rewards', 'search', 'sign-in', 'tracking', 'wishlist']
    .concat('reels').sort());
  const registry = read('apps/shopper/src/features/index.js');
  for (const name of folders) {
    const code = read(`apps/shopper/src/features/${name}/index.js`);
    assert.match(code, new RegExp(`export default \\{\\n {2}name: '${name}',\\n {2}screens: \\[`), name);
    assert.match(code, /\n {2}nav: /, name);
    assert.ok(registry.includes(`'./${name}/index.js'`), `${name} is registered`);
  }
});

test('every screen a link opens is a path the server lists, and every path the server lists has a screen', () => {
  const dir = path.join(repoRoot, 'apps/shopper/src/features');
  const linked = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'index.js');
    if (!fs.existsSync(file) || name === 'index.js') continue;
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/path: '([^']*)'[^}\n]*link: true/g)) linked.push(linkPattern(match[1]));
  }
  assert.deepEqual([...linked].sort(), [...APP_LINK_PATHS.open].sort());
});

// ---- one source tree, many brands ----

test('there are two fixture brands, invented, complete and different in everything a brand differs by', () => {
  assert.equal(brands.length, 2);
  const [a, b] = brands.map(brandOf);
  for (const brand of [a, b]) {
    assert.deepEqual(BrandFile.parse(brand), brand, 'the committed file is in the schema’s own shape');
    assert.deepEqual(brandProblems(brand), []);
    assert.deepEqual(brand.linkPaths, JSON.parse(JSON.stringify(APP_LINK_PATHS)));
    assert.match(brand.shopDomain, /\.example$/, 'its address is under the reserved .example domain');
    assert.deepEqual(checkBrandNames(JSON.stringify(brand)), [], 'it is not a sample business');
    assert.ok(!namesPlatform(JSON.stringify(brand)));
    for (const key of Object.keys(BRAND_ASSETS)) assert.ok(fs.statSync(path.join(FIXTURES, brands[[a, b].indexOf(brand)], brand.assets[key])).size < 20_000, `${key} is a small image`);
  }
  for (const pick of [(x) => x.tenantId, (x) => x.name, (x) => x.shortName, (x) => x.scheme, (x) => x.android.package, (x) => x.ios.bundleId, (x) => x.ios.teamId, (x) => x.shopDomain,
    (x) => x.colors.primary, (x) => x.fonts.heading, (x) => x.updates.channel, (x) => x.android.versionCode]) assert.notEqual(pick(a), pick(b));
  assert.equal(a.appVersion, b.appVersion, 'every brand ships one app version');
  assert.equal(a.appVersion, json('apps/shopper/package.json').version);
});

test('the app’s brand reader knows exactly the schema’s keys', () => {
  const { BRAND_KEYS, ASSET_KEYS } = require(path.join(repoRoot, 'apps/shopper/brand.cjs'));
  assert.deepEqual([...BRAND_KEYS].sort(), Object.keys(BrandFile.shape).sort());
  assert.deepEqual([...ASSET_KEYS].sort(), Object.keys(BrandFile.shape.assets.shape).sort());
  assert.deepEqual([...ASSET_KEYS].sort(), Object.keys(BRAND_ASSETS).sort());
});

test('the app’s config reads with no Expo installed: two brands, two different apps from one file', () => {
  const appConfig = require(path.join(repoRoot, 'apps/shopper/app.config.js'));
  const before = { BRAND_FILE: process.env.BRAND_FILE, PAY_DRIVER: process.env.PAY_DRIVER, API_BASE_URL: process.env.API_BASE_URL, APP_ENV: process.env.APP_ENV };
  try {
    delete process.env.PAY_DRIVER;
    delete process.env.API_BASE_URL;
    process.env.APP_ENV = 'production';
    const configs = brands.map((name) => {
      process.env.BRAND_FILE = brandFile(name);
      return appConfig();
    });
    const [a, b] = configs;
    for (const pick of [(c) => c.name, (c) => c.android.package, (c) => c.ios.bundleIdentifier, (c) => c.icon, (c) => c.scheme, (c) => c.extra.brand.colors.primary]) assert.notEqual(pick(a), pick(b));
    assert.equal(a.android.intentFilters[0].autoVerify, true);
    assert.equal(a.ios.supportsTablet, false);
    delete process.env.BRAND_FILE;
    assert.throws(() => appConfig(), /BRAND_FILE is not set/);
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ---- the brand build tool ----

test('the build tool runs its steps in the contract’s order, each from its own file', () => {
  assert.deepEqual(STEP_NAMES, [...BUILD_STEPS, 'submit', 'report']);
  for (const step of STEPS) {
    assert.equal(typeof step.run, 'function', step.name);
    assert.equal(typeof step.name, 'string');
  }
  for (const file of ['load', 'validate', 'assets', 'brand-file', 'build', 'submit', 'report']) assert.ok(fs.existsSync(path.join(repoRoot, 'tools/build-brand/steps', `${file}.mjs`)), file);
  for (const driver of BUILD_DRIVERS) assert.ok(fs.existsSync(path.join(repoRoot, 'tools/build-brand/drivers', `${driver}.mjs`)), driver);
});

test('a fixture brand goes through load, validate, assets and the brand file, and the folder written is all a build reads', async () => {
  const out = temp('brands-');
  const report = await buildBrand(brandFile(brands[0]), { ...quiet, outDir: out, skipBuild: true, reportFile: path.join(out, 'report.json') });
  const brand = brandOf(brands[0]);
  assert.equal(report.ok, true, report.message);
  assert.equal(report.tenantId, brand.tenantId);
  assert.deepEqual(report.builds.map((b) => [b.platform, b.status, b.buildNumber]), [['android', 'skipped', brand.android.versionCode], ['ios', 'skipped', brand.ios.buildNumber]]);
  assert.equal(report.brandFile, path.join(out, `t${brand.tenantId}`, 'brand.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(report.brandFile, 'utf8')), brand);
  for (const file of Object.values(brand.assets)) assert.ok(fs.existsSync(path.join(out, `t${brand.tenantId}`, file)), file);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).ok, true);
  const text = JSON.stringify(report);
  assert.ok(!/password|secret|token/i.test(text), 'nothing secret is in a report');
});

test('P-33 a brand with no privacy URL stops before anything is made, and the report names the field', async () => {
  const out = temp('brands-');
  const lines = [];
  const report = await buildBrand(changedBrand((b) => { delete b.privacyUrl; }), { log: (line) => lines.push(line), outDir: out, exec: () => assert.fail('nothing is built') });
  assert.equal(report.ok, false);
  assert.equal(report.step, 'validate');
  assert.equal(report.field, 'privacyUrl');
  assert.deepEqual(report.builds, []);
  assert.deepEqual(fs.readdirSync(out), [], 'no brand folder was written');
  assert.ok(lines.some((line) => /stopped at validate/.test(line)) && lines.some((line) => /privacyUrl/.test(line)));

  const named = await buildBrand(changedBrand((b) => { b.name = 'Bhava Shop'; }), { ...quiet, outDir: out });
  assert.deepEqual([named.step, named.field, named.code], ['validate', 'name', 'names_platform']);
  const version = await buildBrand(changedBrand((b) => { b.appVersion = '0.0.9'; }), { ...quiet, outDir: out });
  assert.deepEqual([version.step, version.field], ['validate', 'appVersion']);
  const noIos = await buildBrand(changedBrand((b) => { b.ios = null; }), { ...quiet, outDir: out, platforms: ['ios'] });
  assert.deepEqual([noIos.step, noIos.field], ['validate', 'ios']);
});

test('P-34 an icon that fails the store’s spec stops the run with the spec’s own message', async () => {
  const { default: sharp } = await import('sharp');
  const out = temp('brands-');
  const small = changedBrand(() => {});
  await sharp({ create: { width: 512, height: 512, channels: 3, background: '#333333' } }).png().toFile(path.join(path.dirname(small), 'icon.png'));
  const report = await buildBrand(small, { ...quiet, outDir: out, exec: () => assert.fail('nothing is built') });
  assert.deepEqual([report.ok, report.step, report.field, report.code], [false, 'assets', 'icon', 'wrong_size']);
  assert.match(report.message, /1024 x 1024 pixels; this one is 512 x 512/);
  assert.deepEqual(fs.readdirSync(out), []);

  const missing = await buildBrand(changedBrand((b, dir) => fs.rmSync(path.join(dir, b.assets.splash))), { ...quiet, outDir: out });
  assert.deepEqual([missing.step, missing.field, missing.code], ['assets', 'splash', 'missing_image']);
});

test('a business named by its slug needs the database loader, which the pipeline supplies', async () => {
  const report = await buildBrand('some-shop', { ...quiet, outDir: temp('brands-') });
  assert.deepEqual([report.ok, report.step, report.code], [false, 'load', 'not_built']);
  const bad = await buildBrand('Not A Slug!', { ...quiet });
  assert.deepEqual([bad.step, bad.code], ['load', 'bad_slug']);
  const gone = await buildBrand('nowhere/brand.json', { ...quiet });
  assert.deepEqual([gone.step, gone.code], ['load', 'no_brand_file']);
  let asked = null;
  const loaded = await buildBrand('some-shop', { ...quiet, outDir: temp('brands-'), skipBuild: true, loadBySlug: async (slug) => { asked = slug; return { brand: brandOf(brands[1]), sourceDir: path.join(FIXTURES, brands[1]) }; } });
  assert.equal(asked, 'some-shop');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.name, brandOf(brands[1]).name);
});

test('each platform is built through the driver; one failing does not stop the other, and the report lists both', async () => {
  const seen = [];
  const drivers = { local: { build: async ({ platform, brandFile: file, profile }) => {
    seen.push([platform, path.basename(file), profile]);
    if (platform === 'android') throw new Error('gradle exited with 1');
    return { platform, status: 'built', artifact: '/tmp/App.app', detail: 'ok' };
  } } };
  const report = await buildBrand(brandFile(brands[0]), { ...quiet, outDir: temp('brands-'), drivers });
  assert.deepEqual(seen, [['android', 'brand.json', 'preview'], ['ios', 'brand.json', 'preview']]);
  assert.deepEqual(report.builds.map((b) => [b.platform, b.status]), [['android', 'failed'], ['ios', 'built']]);
  assert.deepEqual([report.ok, report.step, report.code], [false, 'build', 'build_failed']);
  assert.ok(!/gradle exited/.test(JSON.stringify(report)), 'a tool’s own error text stays in the log, not the report');

  const eas = await buildBrand(brandFile(brands[0]), { ...quiet, outDir: temp('brands-'), driver: 'eas' });
  assert.deepEqual([eas.step, eas.code], ['build', 'not_built']);
  const unknown = await buildBrand(brandFile(brands[0]), { ...quiet, outDir: temp('brands-'), driver: 'make' });
  assert.deepEqual([unknown.step, unknown.code], ['build', 'unknown_driver']);
  const store = await buildBrand(brandFile(brands[0]), { ...quiet, outDir: temp('brands-'), platforms: ['android'], profile: 'production', exec: () => assert.fail('never run') });
  assert.equal(store.builds[0].status, 'failed');
  assert.match(store.builds[0].detail, /eas driver/);
});

test('nothing is submitted unless asked, and submitting needs the pipeline’s part', async () => {
  const built = { local: { build: async ({ platform }) => ({ platform, status: 'built', artifact: null, detail: '' }) } };
  const plain = await buildBrand(brandFile(brands[0]), { ...quiet, outDir: temp('brands-'), drivers: built, platforms: ['android'] });
  assert.deepEqual([plain.ok, plain.submissions], [true, []]);
  const asked = await buildBrand(brandFile(brands[0]), { ...quiet, outDir: temp('brands-'), drivers: built, platforms: ['android'], submit: true });
  assert.deepEqual([asked.ok, asked.step, asked.code], [false, 'submit', 'not_built']);
  const sent = await buildBrand(brandFile(brands[0]), { ...quiet, outDir: temp('brands-'), drivers: built, platforms: ['android'], submit: true, submitBuild: async () => ({ status: 'submitted', detail: '' }) });
  assert.deepEqual(sent.submissions, [{ status: 'submitted', detail: '', platform: 'android' }]);
});

test('the local driver’s commands: prebuild then Gradle for an APK, prebuild, pods and xcodebuild with signing off for the simulator', () => {
  const brandDir = path.join(os.tmpdir(), 't1');
  const android = localCommands({ platform: 'android', brandDir, windows: false, options: { androidArchitectures: 'x86_64', signing: { storeFile: '/tmp/k.keystore', storePassword: 'pw-one', keyAlias: 'ci', keyPassword: 'pw-two' } } });
  assert.deepEqual(android.map((c) => c.command), ['npx', './gradlew']);
  assert.deepEqual(android[0].args, ['expo', 'prebuild', '--platform', 'android', '--no-install', '--clean']);
  assert.ok(android[0].cwd.endsWith(path.join('apps', 'shopper')));
  assert.deepEqual(android[1].args.slice(0, 3), [':app:assembleRelease', '--no-daemon', '-PreactNativeArchitectures=x86_64']);
  assert.deepEqual(android[1].secret.map((i) => android[1].args[i].replace(/=.*/, '')), ['-Pandroid.injected.signing.store.password', '-Pandroid.injected.signing.key.password']);
  assert.equal(localCommands({ platform: 'android', brandDir, windows: true })[1].command, 'gradlew.bat');
  const ios = localCommands({ platform: 'ios', brandDir });
  assert.deepEqual(ios.map((c) => c.command), ['npx', 'pod', 'sh']);
  assert.match(ios[2].args[1], /-sdk iphonesimulator .*CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO/);
  const env = buildEnv({ brand: { payDriver: 'hosted' }, brandFile: '/tmp/t1/brand.json', profile: 'preview', env: { PATH: '/bin', PAY_DRIVER: 'native' } });
  assert.deepEqual([env.BRAND_FILE, env.APP_ENV, env.PAY_DRIVER, env.PATH], ['/tmp/t1/brand.json', 'preview', 'hosted', '/bin']);
});

test('a signing password is never printed by the build tool', async () => {
  const lines = [];
  const ran = [];
  const signing = { storeFile: '/tmp/k.keystore', storePassword: 'pw-store-12345', keyAlias: 'ci', keyPassword: 'pw-key-67890' };
  const report = await buildBrand(brandFile(brands[0]), { log: (line) => lines.push(line), outDir: temp('brands-'), platforms: ['android'], signing, exec: async (command, args, { env }) => { ran.push({ command, args, brand: env.BRAND_FILE }); } });
  assert.deepEqual(ran.map((r) => r.command), ['npx', process.platform === 'win32' ? 'gradlew.bat' : './gradlew']);
  assert.ok(ran[1].args.includes('-Pandroid.injected.signing.store.password=pw-store-12345'), 'Gradle is given the key');
  assert.ok(ran.every((r) => r.brand === report.brandFile), 'every command runs with this run’s brand file');
  const printed = lines.join('\n');
  assert.ok(/store\.password=\*\*\*/.test(printed) && !/pw-store-12345|pw-key-67890/.test(printed + JSON.stringify(report)));
});

test('the command line: one brand, its platforms, the driver and the profile', () => {
  const { input, options } = parseArgs(['zed', '--platform', 'android', '--platform', 'ios', '--driver', 'eas', '--profile', 'production', '--submit', '--pay', 'native', '--report', 'r.json'], {});
  assert.equal(input, 'zed');
  assert.deepEqual([options.platforms, options.driver, options.profile, options.submit, options.payDriver, options.reportFile, options.skipBuild], [['android', 'ios'], 'eas', 'production', true, 'native', 'r.json', false]);
  assert.deepEqual([parseArgs(['zed'], {}).options.driver, parseArgs(['zed'], { APP_BUILD_DRIVER: 'eas' }).options.driver, parseArgs(['zed', '--no-build'], {}).options.skipBuild], ['local', 'eas', true]);
  assert.equal(parseArgs(['zed'], { PAY_DRIVER: 'native' }).options.payDriver, 'native');
  for (const bad of [['a', 'b'], ['a', '--profile', 'debug'], ['a', '--pay', 'card'], ['a', '--turbo'], ['a', '--driver']]) assert.throws(() => parseArgs(bad, {}));
});

test('the pay driver asked for is written into the brand file the build reads', async () => {
  const report = await buildBrand(brandFile(brands[0]), { ...quiet, outDir: temp('brands-'), skipBuild: true, payDriver: 'native' });
  assert.equal(JSON.parse(fs.readFileSync(report.brandFile, 'utf8')).payDriver, 'native');
});

// ---- the gate, the policy check and the secret scan ----

test('no brand, no colour and no platform name in the shopper app’s source, and this repository passes', () => {
  assert.deepEqual(checkFolders(['apps', 'packages', 'tools/build-brand']), []);
  assert.deepEqual(checkShopperSource("import { Screen } from '@bhava/ui';\nconst x = require('@bhava/app-core/strings');\n", 'apps/shopper/src/a.js'), []);
  const findings = checkShopperSource("const title = 'Welcome to Bhava';\n// made by bhava\nconst c = '#3B2FC9';\nconst short = '#fff';\nconst id = '#12';\n", 'apps/shopper/src/a.js');
  assert.deepEqual(findings.map((f) => [f.line, f.rule]), [[1, 'platform-name-in-shopper-app'], [2, 'platform-name-in-shopper-app'], [3, 'colour-in-shopper-app'], [4, 'colour-in-shopper-app']]);
  assert.deepEqual(checkShopperSource('# A heading\nSee #3B2FC9\n', 'apps/shopper/README.md').map((f) => f.rule), [], 'colours are looked for in code and JSON');

  const values = brandValues();
  const brand = brandOf(brands[0]);
  for (const value of [brand.name, brand.scheme, brand.android.package, brand.shopDomain]) assert.ok(values.includes(value.toLowerCase()), value);
  const root = temp('tree-');
  for (const [rel, text] of Object.entries({
    'apps/shopper/src/a.js': `export const title = '${brand.shortName}';\n`,
    'packages/ui/src/b.js': `// for ${brand.shopDomain}\n`,
    'apps/shopper/src/c.js': "export const ok = 'a shop';\n",
    [`tools/build-brand/fixtures/${brands[0]}/brand.json`]: JSON.stringify(brand),
  })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  assert.deepEqual(checkFolders(['apps', 'packages', 'tools/build-brand'], root).map((f) => [f.file, f.rule]), [['apps/shopper/src/a.js', 'brand-in-app-source'], ['packages/ui/src/b.js', 'brand-in-app-source']]);
  assert.deepEqual(checkBrandValues('nothing here', 'x.js', values), []);
});

test('a brand’s files and a build service’s credentials are refused by name outside the fixtures', () => {
  for (const file of ['apps/shopper/brand.json', 'packages/ui/brand.json', 'apps/shopper/brands/one/brand.json', '.brand-builds/t7/brand.json', '.brand-builds/t7/icon.png', 'apps/shopper/credentials.json', 'credentials.json', 'apps/shopper/android/app/release.keystore', 'keys/AuthKey_ABC123.p8', 'play-service-account.json']) {
    assert.ok(scanFileName(file), file);
  }
  for (const file of [`${BRAND_FIXTURES}/${brands[0]}/brand.json`, `${BRAND_FIXTURES}/${brands[0]}/icon.png`, 'apps/shopper/brand.cjs', 'apps/shopper/eas.json']) assert.equal(scanFileName(file), null, file);
  const ignored = read('.gitignore').split(/\r?\n/);
  assert.ok(ignored.includes('.brand-builds/'));
  assert.ok(read('apps/shopper/.gitignore').split(/\r?\n/).includes('brand.json'));
});

test('the shopper app’s tests, flows and fixture brands belong to phase 6 and are locked with it', () => {
  for (const file of ['apps/shopper/src/build.test.js', 'packages/store-client/src/client.test.js', 'packages/pay/src/pay.test.js']) {
    assert.equal(appPhaseOf(file), 6, file);
    assert.ok(appTestFiles(repoRoot, [6]).includes(file), file);
  }
  const flows = maestroFlows(repoRoot, [6]);
  assert.ok(flows.some((flow) => flow.file === 'apps/shopper/.maestro/launch.yaml' && /^The app opens on its tabs/.test(flow.name)));
  assert.ok(!maestroFlows(repoRoot, [5]).some((flow) => flow.file.startsWith('apps/shopper/')));
  const locked = Object.keys(phaseFileHashes(repoRoot, 6));
  for (const file of ['apps/shopper/src/registry.test.js', 'apps/shopper/.maestro/launch.yaml', `${BRAND_FIXTURES}/${brands[0]}/brand.json`, `${BRAND_FIXTURES}/${brands[1]}/icon.png`, 'test/p6/shopper-app-workspace/workspace.test.js']) assert.ok(locked.includes(file), file);
  assert.ok(!Object.keys(phaseFileHashes(repoRoot, 5)).some((file) => file.startsWith('apps/shopper/') || file.startsWith(BRAND_FIXTURES)));
});

test('the APK check holds a brand’s build to its package and its name', () => {
  const badging = "package: name='example.one.shop' versionCode='3' versionName='1.0.0'\nsdkVersion:'24'\ntargetSdkVersion:'36'\napplication-label:'One'\n";
  assert.equal(checkApkBadging(badging, { packageName: 'example.one.shop', label: 'One' }).ok, true);
  assert.deepEqual(checkApkBadging(badging, { packageName: 'example.one.shop', label: 'Two' }).problems, ['The APK is named One, not Two']);
  assert.equal(checkApkBadging(badging, { packageName: 'example.two.shop' }).ok, false);
});

test('brand-apps.yml builds every fixture brand for both platforms with the local driver, runs the flows, and needs no secret', () => {
  const workflow = read('.github/workflows/brand-apps.yml');
  const jobs = Object.fromEntries(workflow.split(/\n {2}(?=[a-z][a-z0-9-]*:\n {4}name:)/).slice(1).map((block) => [block.slice(0, block.indexOf(':')), block]));
  assert.deepEqual(Object.keys(jobs), ['brands', 'app-tests', 'android', 'ios', 'android-e2e', 'ready']);
  assert.ok(!/\$\{\{\s*secrets\./.test(workflow), 'no secret');
  assert.ok(!/EXPO_TOKEN|eas build|eas-cli|expo login|APPLE_ID|GOOGLE_SERVICES/.test(workflow), 'no account');
  for (const job of ['android', 'ios', 'android-e2e']) {
    assert.match(jobs[job], /brand: \$\{\{ fromJSON\(needs\.brands\.outputs\.brands\) \}\}/, `${job} runs once per fixture brand`);
    assert.match(jobs[job], /npm run build-brand -- "\$FIXTURES\/\$BRAND\/brand\.json" --platform (android|ios) --driver local/, `${job} builds through the command`);
  }
  assert.match(jobs.android, /build-check\.mjs apk \\\n\s+--package .*\n\s+--label /);
  assert.match(jobs.android, /upload-artifact@v4[\s\S]*shopper-android-apk-\$\{\{ matrix\.brand \}\}/);
  assert.match(jobs.ios, /runs-on: macos-26/);
  assert.match(jobs.ios, /CFBundleIdentifier[\s\S]*PrivacyInfo\.xcprivacy/);
  assert.match(jobs['android-e2e'], /apps\/shopper\/\.maestro\/support\/server\.mjs --brand/);
  assert.match(jobs['android-e2e'], /android-emulator-runner@v2[\s\S]*run-flows\.sh/);
  assert.match(jobs['app-tests'], /--selectProjects shopper store-client pay/);
  assert.match(jobs['app-tests'], /npm run policy-check/);
  assert.match(jobs['app-tests'], /npm run secret-scan/);
  assert.match(jobs.ready, /needs: \[brands, app-tests, android, ios, android-e2e\]/);
  const eas = json('apps/shopper/eas.json');
  assert.ok(!/projectId|"owner"|appleId|ascAppId|serviceAccountKeyPath/.test(JSON.stringify(eas)), 'eas.json names no project and no account');
});

test('the flows’ seed gives the store the brand file’s own business id, name and app ids', async () => {
  const { seedDataDir, slugOf } = await import(pathToFileURL(path.join(repoRoot, 'apps/shopper/.maestro/support/seed.mjs')).href);
  const { openDb } = await import('../../../src/db/index.js');
  const brand = brandOf(brands[1]);
  const dataDir = temp('shopper-seed-');
  const seeded = await seedDataDir(dataDir, brand, { env: {}, dataKey: Buffer.alloc(32, 7).toString('base64') });
  assert.deepEqual([seeded.tenantId, seeded.slug], [brand.tenantId, slugOf(brand)]);
  const db = await openDb({ dataDir, migrate: false });
  try {
    const [tenant] = await db.platform.query('SELECT id, name, plan FROM tenants WHERE slug = $1', [seeded.slug]);
    assert.deepEqual([Number(tenant.id), tenant.name, tenant.plan], [brand.tenantId, brand.name, 't4']);
    const [config] = await db.platform.query('SELECT android_package, url_scheme, shop_domain FROM app_configs WHERE tenant_id = $1', [brand.tenantId]);
    assert.deepEqual(config, { android_package: brand.android.package, url_scheme: brand.scheme, shop_domain: brand.shopDomain });
  } finally {
    await db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  await assert.rejects(() => seedDataDir(dataDir, brand, { env: { NODE_ENV: 'production' }, dataKey: 'k' }), /never runs in production/);
  await assert.rejects(() => seedDataDir(dataDir, brand, { env: { DATABASE_URL: 'postgres://x' }, dataKey: 'k' }), /built-in database/);
});

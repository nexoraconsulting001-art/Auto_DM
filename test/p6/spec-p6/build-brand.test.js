// PRD 10.1 and 10.8 (one source tree, one binary per brand; the build pipeline), 10.13 (listing assets), 10.14 (the pre-submit
// gate's build side) and "iOS ready from day one". Everything runs the build-brand tool (tools/build-brand) with its local driver
// (a fake runner that records commands) and its EAS driver against the simulator, and reads its output, the brand folder it writes,
// the app config it feeds and the workflow file. P-01, P-32, P-33, P-34, P-35, P-36, P-55, P-56, P-57, P-59, I-03.
import '../../../tools/net-guard.mjs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createEas as createEasClient } from '../../../src/adapters/eas/index.js';
import { createEas } from '../../../tools/sim/eas/index.mjs';
import { buildBrand, parseArgs } from '../../../tools/build-brand/index.mjs';
import { localCommands } from '../../../tools/build-brand/drivers/local.mjs';
import * as apps from '../../../src/contracts/apps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURES = path.join(ROOT, 'tools/build-brand/fixtures');
const require = createRequire(import.meta.url);
const BRANDS = fs.readdirSync(FIXTURES).filter((n) => fs.existsSync(path.join(FIXTURES, n, 'brand.json'))).sort();
const brandOf = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'brand.json'), 'utf8'));
const TOKEN = 'expo-build-spec-token';
const SECRET = 'S3cretKeystorePw-9f2b7c1d';

let eas;
before(async () => { eas = await createEas({ token: TOKEN }).start(); });
after(async () => { await eas?.close(); });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
/** A copy of a fixture brand in a folder of its own, changed by `change(brand, dir)`. Returns the brand file's path. */
function variant(change, from = BRANDS[0]) {
  const dir = tmp();
  fs.cpSync(path.join(FIXTURES, from), dir, { recursive: true });
  const file = path.join(dir, 'brand.json');
  const brand = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = change(brand, dir);
  fs.writeFileSync(file, JSON.stringify(result ?? brand, null, 2));
  return file;
}
const png = (width, height, { alpha = false, color = '#2E7D5B' } = {}) => sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : color } }).png().toBuffer();
async function run(input, extra = {}) {
  const lines = [];
  const commands = [];
  const report = await buildBrand(input, {
    cwd: ROOT, outDir: tmp(), log: (l) => lines.push(l), exec: async (command, args, o) => { commands.push({ command, args, env: o?.env }); },
    drivers: { local: { name: 'local', build: async ({ platform }) => ({ platform, status: 'built', artifact: `/tmp/${platform}.bin`, detail: 'fake' }) } }, driver: 'local', ...extra,
  });
  return { report, lines, commands };
}

/** The EAS driver against the simulator: builds, waits on the simulator's clock, and answers what the driver expects. */
function easDriver(overrides = {}) {
  const client = createEasClient({ easBaseUrl: eas.url, expoToken: TOKEN, providerTimeoutMs: 700 });
  return {
    client,
    easBuild: async ({ platform, brand }) => {
      const started = await client.startBuild({
        platform, profile: 'production', channel: brand.updates.channel, appVersion: brand.appVersion,
        buildNumber: platform === 'ios' ? brand.ios.buildNumber : brand.android.versionCode, runtimeVersion: brand.runtimeVersion, brandFile: brand,
        idempotencyKey: `bb-${crypto.randomUUID()}`,
      });
      for (let i = 0; i < 20; i++) {
        await eas.post('/clock', { advanceMs: 10_000 });
        const b = await client.getBuild(started.buildId);
        if (b.status === 'built') return { status: 'built', artifact: b.artifactUrl, buildId: started.buildId, detail: 'Built on EAS.' };
        if (b.status === 'failed') return { status: 'failed', artifact: null, buildId: started.buildId, detail: b.error?.message ?? 'The build failed.' };
      }
      return { status: 'failed', artifact: null, detail: 'The build did not finish.' };
    },
    submitBuild: async ({ build }) => {
      const sub = await client.submit({ buildId: build.buildId, platform: build.platform, track: 'production', credentials: { ascApiKey: { keyId: 'ABCDE12345' } }, idempotencyKey: `sub-${crypto.randomUUID()}` });
      for (let i = 0; i < 6; i++) {
        await eas.post('/clock', { advanceMs: 5_000 });
        const s = await client.getSubmission(sub.submissionId);
        if (s.status === 'finished') return { status: 'submitted', detail: 'Sent to the brand\'s store account.' };
        if (s.status === 'errored') return { status: 'failed', detail: s.error ?? 'The store refused it.' };
      }
      return { status: 'failed', detail: 'Not finished.' };
    },
    ...overrides,
  };
}

// ---- P-01 ---------------------------------------------------------------------------------------------------------------

test('P-01: two fixture brands build to two different binaries from one source tree: name, icon, ids, scheme and colours differ, nothing else', async () => {
  assert.ok(BRANDS.length >= 2, 'Two brands are needed');
  const configs = [];
  for (const name of BRANDS) {
    const { report } = await run(path.join(FIXTURES, name, 'brand.json'), { skipBuild: true });
    assert.equal(report.ok, true, `${name}: ${report.message}`);
    assert.ok(fs.existsSync(report.brandFile), 'No brand folder was written');
    const before = process.env.BRAND_FILE;
    process.env.BRAND_FILE = report.brandFile;
    try {
      delete require.cache[require.resolve('../../../apps/shopper/app.config.js')];
      configs.push({ name, brand: brandOf(name), config: JSON.parse(JSON.stringify(require('../../../apps/shopper/app.config.js')())), folder: path.dirname(report.brandFile) });
    } finally {
      if (before === undefined) delete process.env.BRAND_FILE;
      else process.env.BRAND_FILE = before;
    }
  }
  const [a, b] = configs;
  for (const key of ['name', 'scheme']) assert.notEqual(a.config[key], b.config[key], `${key} is the same for both brands`);
  assert.notEqual(a.config.android.package, b.config.android.package);
  assert.notEqual(a.config.ios.bundleIdentifier, b.config.ios.bundleIdentifier);
  assert.notEqual(a.config.extra.brand.colors.primary, b.config.extra.brand.colors.primary);
  const icon = (c) => crypto.createHash('sha256').update(fs.readFileSync(path.join(c.folder, c.brand.assets.icon))).digest('hex');
  assert.notEqual(icon(a), icon(b), 'The two icons are the same file');
  // Same everything else: version, SDK targets, permissions, plugin list (by name), no tablet.
  const shape = (c) => ({
    version: c.config.version, target: c.config.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties')[1].android.targetSdkVersion,
    permissions: c.config.android.permissions, tablet: c.config.ios.supportsTablet, plugins: c.config.plugins.map((p) => (Array.isArray(p) ? p[0] : p)).filter((p) => typeof p === 'string'),
    manifests: c.config.ios.privacyManifests,
  });
  assert.deepEqual(shape(a), shape(b), 'The two brands differ in more than their brand');
  assert.equal(shape(a).version, a.brand.appVersion);
  assert.equal(a.brand.appVersion, b.brand.appVersion, 'All brands share the app version');
  assert.equal(shape(a).tablet, false, 'The app is iPhone-only');
  assert.ok(shape(a).target >= apps.ANDROID_TARGET_SDK_MIN);
  // Each build number is the brand\'s own; link hosts and the update channel belong to the brand.
  assert.notEqual(a.config.extra.brand.shopDomain, b.config.extra.brand.shopDomain);
  assert.notEqual(a.brand.updates.channel, b.brand.updates.channel);
  assert.match(a.brand.updates.channel, /^t[0-9]+$/, 'The update channel is t<id>, never a name');
  assert.ok(a.config.android.intentFilters[0].autoVerify === true);
  assert.ok(a.config.android.intentFilters[0].data.every((d) => d.host === a.brand.shopDomain || a.brand.linkHosts.includes(d.host)), 'A link filter on a host that is not the brand\'s');
  // No tenant brand name in the shared source: apps/ and packages/ (this track\'s tests read the names from the fixtures).
  const names = BRANDS.flatMap((n) => { const x = brandOf(n); return [x.name, x.shortName, x.scheme, x.shopDomain.split('.')[1] ?? ''].filter((s) => s.length >= 4); });
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.expo', 'dist', 'ios', 'android', '.brand-builds', 'coverage'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|mjs|cjs|json|ts|tsx|md)$/.test(entry.name) && fs.statSync(full).size < 400_000) {
        const text = fs.readFileSync(full, 'utf8').toLowerCase();
        for (const n of names) if (text.includes(n.toLowerCase())) hits.push(`${path.relative(ROOT, full)}: ${n}`);
      }
    }
  };
  walk(path.join(ROOT, 'apps'));
  walk(path.join(ROOT, 'packages'));
  assert.deepEqual(hits, [], "A tenant brand's name is in the shared source");
});

test('P-01: the word of the platform is nowhere in a built brand: its brand folder, its app config, its strings, its metadata', async () => {
  for (const name of BRANDS) {
    const { report } = await run(path.join(FIXTURES, name, 'brand.json'), { skipBuild: true });
    const folder = path.dirname(report.brandFile);
    for (const file of fs.readdirSync(folder)) {
      if (/\.json$/.test(file)) assert.ok(!apps.namesPlatform(fs.readFileSync(path.join(folder, file), 'utf8')), `${name}/${file} names the platform`);
    }
    const before = process.env.BRAND_FILE;
    process.env.BRAND_FILE = report.brandFile;
    try {
      delete require.cache[require.resolve('../../../apps/shopper/app.config.js')];
      const text = JSON.stringify(require('../../../apps/shopper/app.config.js')());
      assert.ok(!apps.namesPlatform(text), `${name}: the app config names the platform: ${text.match(/.{0,40}bhava.{0,40}/i)?.[0]}`);
    } finally {
      if (before === undefined) delete process.env.BRAND_FILE;
      else process.env.BRAND_FILE = before;
    }
    assert.ok(!apps.namesPlatform(report.message ?? ''), 'The report names the platform');
  }
  // A brand file that does name it is stopped, naming the field.
  for (const [field, change] of [['name', (b) => { b.name = 'Bhava Home'; }], ['shortName', (b) => { b.shortName = 'Bhava'; }], ['supportEmail', (b) => { b.supportEmail = 'help@bhava.example'; }], ['shopDomain', (b) => { b.shopDomain = 'shop.bhava.example'; b.linkHosts = [b.shopDomain]; b.apiBaseUrl = `https://${b.shopDomain}`; }]]) {
    const { report } = await run(variant(change), { skipBuild: true });
    assert.equal(report.ok, false, `${field} naming the platform was built`);
    assert.equal(report.step, 'validate');
    assert.ok(report.problems.some((p) => p.code === 'names_platform' || p.field === field), `${field}: ${JSON.stringify(report.problems)}`);
  }
});

// ---- P-33: validation first ---------------------------------------------------------------------------------------------

test('P-33: a missing or bad privacy URL stops the run before anything is built and the report names the field', async () => {
  for (const [what, change] of [['missing', (b) => { delete b.privacyUrl; }], ['empty', (b) => { b.privacyUrl = ''; }], ['http', (b) => { b.privacyUrl = 'http://shop.example/privacy'; }], ['script', (b) => { b.privacyUrl = 'javascript:alert(1)'; }]]) {
    let built = 0;
    const { report, lines } = await run(variant(change), { driver: 'eas', easBuild: async () => { built += 1; return { status: 'built' }; } });
    assert.equal(report.ok, false, `${what}: the run went on`);
    assert.equal(report.step, 'validate', `${what}: stopped at ${report.step}`);
    assert.equal(report.field, 'privacyUrl', `${what}: the field is ${report.field}`);
    assert.match(report.message, /privacyUrl/);
    assert.equal(built, 0, `${what}: a build was started`);
    assert.deepEqual(report.builds, []);
    assert.ok(lines.some((l) => /privacyUrl/.test(l)), 'The printed report does not name the field');
  }
  assert.equal((await eas.get('/builds')).builds.length, 0, 'The build service saw a build');
  // Every key of the brand file is named when it is the one missing.
  const keys = Object.keys(brandOf(BRANDS[0]));
  for (const key of keys.filter((k) => !['android', 'ios'].includes(k))) {
    const { report } = await run(variant((b) => { delete b[key]; }), { skipBuild: true });
    assert.equal(report.ok, false, `${key} missing was built`);
    assert.equal(report.step, 'validate');
    assert.ok(report.problems.some((p) => p.field === key || p.field.startsWith(`${key}.`)), `${key} is not named: ${JSON.stringify(report.problems.map((p) => p.field))}`);
  }
  // A key that the file should not have (a secret, a path) is refused, not ignored.
  for (const extra of [{ keystorePassword: SECRET }, { p8: 'AuthKey_X.p8' }, { apiKey: 'sk_live_x' }]) {
    const { report } = await run(variant((b) => Object.assign(b, extra)), { skipBuild: true });
    assert.equal(report.ok, false, `A brand file with ${Object.keys(extra)[0]} was accepted`);
    assert.ok(!JSON.stringify(report).includes(SECRET), 'The refused secret was printed');
  }
  // A brand with no platform at all, and a platform asked for that it lacks.
  assert.equal((await run(variant((b) => { b.android = null; b.ios = null; }), { skipBuild: true })).report.ok, false);
  const noIos = await run(variant((b) => { b.ios = null; b.associatedDomains = []; }), { skipBuild: true, platforms: ['ios'] });
  assert.equal(noIos.report.ok, false);
  assert.equal(noIos.report.field, 'ios');
  // A version other than every brand\'s shared one, and link paths that drift from the server\'s list.
  assert.equal((await run(variant((b) => { b.appVersion = '9.9.9'; }), { skipBuild: true })).report.field, 'appVersion');
  assert.equal((await run(variant((b) => { b.linkPaths.open.push('/admin'); }), { skipBuild: true })).report.field, 'linkPaths');
  assert.equal((await run(variant((b) => { b.linkHosts = ['other.example']; }), { skipBuild: true })).report.field, 'linkHosts');
  // From the database the same check names the same fields.
  const config = { appName: 'Shop', shortName: 'Shop', shopDomain: 'shop.example', supportEmail: 'a@b.co', privacyUrl: '', iconMediaId: 'x', urlScheme: 'shopx', androidPackage: 'in.ex.shop', playSigningSha256: [], iosBundleId: 'in.ex.shop', appleTeamId: '' };
  const viaDb = await run('kesar-kitchen', { loadBySlug: async () => ({ config, kit: { colors: { primary: '#112233' } }, hosts: ['shop.example'], sourceDir: tmp() }) });
  assert.equal(viaDb.report.ok, false);
  assert.equal(viaDb.report.step, 'validate');
  const fields = viaDb.report.problems.map((p) => p.field);
  for (const field of ['privacyUrl', 'playSigningSha256', 'appleTeamId']) assert.ok(fields.includes(field), `${field} is not named from the database`);
  assert.equal((await run('Bad Slug!', {})).report.code, 'bad_slug');
  assert.equal((await run('', {})).report.code, 'no_input');
  assert.equal((await run('missing/brand.json', {})).report.code, 'no_brand_file');
});

// ---- P-34: assets ----------------------------------------------------------------------------------------------------------

test('P-34: an icon or splash that fails the current store spec stops the run with the spec\'s own message and the field', async () => {
  const cases = [
    ['an undersized icon', 'icon', async (dir, b) => fs.writeFileSync(path.join(dir, b.assets.icon), await png(600, 600)), /1024/],
    ['a non-square icon', 'icon', async (dir, b) => fs.writeFileSync(path.join(dir, b.assets.icon), await png(1200, 1024)), /1024|square/i],
    ['a transparent store icon', 'icon', async (dir, b) => fs.writeFileSync(path.join(dir, b.assets.icon), await png(1024, 1024, { alpha: true })), /transparent|solid/i],
    ['an adaptive foreground of the wrong size', 'icon', async (dir, b) => fs.writeFileSync(path.join(dir, b.assets.adaptiveForeground), await png(512, 512, { alpha: true })), /1024/],
    ['an opaque notification icon', 'icon', async (dir, b) => fs.writeFileSync(path.join(dir, b.assets.notificationIcon), await png(96, 96)), /transparent/i],
    ['a splash of the wrong size', 'splash', async (dir, b) => fs.writeFileSync(path.join(dir, b.assets.splash), await png(300, 300)), /1024/],
    ['a file that is not an image', 'icon', async (dir, b) => fs.writeFileSync(path.join(dir, b.assets.icon), 'not a png at all'), null],
    ['an empty file', 'icon', async (dir, b) => fs.writeFileSync(path.join(dir, b.assets.icon), ''), null],
  ];
  for (const [what, field, damage, pattern] of cases) {
    const dir = tmp();
    fs.cpSync(path.join(FIXTURES, BRANDS[0]), dir, { recursive: true });
    const brand = JSON.parse(fs.readFileSync(path.join(dir, 'brand.json'), 'utf8'));
    await damage(dir, brand);
    let built = 0;
    const { report } = await run(path.join(dir, 'brand.json'), { driver: 'eas', easBuild: async () => { built += 1; return { status: 'built' }; } });
    assert.equal(report.ok, false, `${what}: the run went on`);
    assert.equal(report.step, 'assets', `${what}: stopped at ${report.step}`);
    assert.equal(built, 0, `${what}: a build was started`);
    if (pattern) {
      assert.equal(report.field, field, `${what}: the field is ${report.field}`);
      assert.match(report.message, pattern, `${what}: the message is "${report.message}"`);
    }
  }
  // A missing image names the field, and the fine fixtures pass every spec.
  const gone = tmp();
  fs.cpSync(path.join(FIXTURES, BRANDS[0]), gone, { recursive: true });
  fs.rmSync(path.join(gone, brandOf(BRANDS[0]).assets.splash));
  const missing = await run(path.join(gone, 'brand.json'), { skipBuild: true });
  assert.equal(missing.report.step, 'assets');
  assert.equal(missing.report.field, 'splash');
  for (const name of BRANDS) assert.equal((await run(path.join(FIXTURES, name, 'brand.json'), { skipBuild: true })).report.ok, true, `${name} does not pass its own specs`);
  // The spec messages are the contract\'s, in plain words.
  const msg = apps.checkAsset('icon_ios', { width: 600, height: 600, mime: 'image/png', hasAlpha: false });
  assert.match(msg[0].message, /1024 x 1024/);
});

// ---- P-32: both builds on EAS and submitted ---------------------------------------------------------------------------------

test('P-32: with a complete kit both platforms build on EAS and are submitted to the brand\'s accounts, and the report says so', async () => {
  await eas.post('/reset');
  const driver = easDriver();
  const file = path.join(FIXTURES, BRANDS[0], 'brand.json');
  const brand = brandOf(BRANDS[0]);
  const reportFile = path.join(tmp(), 'report.json');
  const { report, lines } = await run(file, { driver: 'eas', easBuild: driver.easBuild, submitBuild: driver.submitBuild, submit: true, reportFile });
  assert.equal(report.ok, true, `${report.step}: ${report.message}`);
  assert.deepEqual(report.builds.map((b) => [b.platform, b.status]).sort(), [['android', 'built'], ['ios', 'built']]);
  assert.deepEqual(report.submissions.map((s) => [s.platform, s.status]).sort(), [['android', 'submitted'], ['ios', 'submitted']]);
  assert.equal(report.tenantId, brand.tenantId);
  assert.deepEqual(report.builds.map((b) => b.buildNumber).sort(), [brand.android.versionCode, brand.ios.buildNumber].sort());
  assert.equal((await eas.get('/builds')).builds.length, 2);
  const onEas = (await eas.calls({ method: 'POST', path: '/v1/builds' })).map((c) => c.body);
  assert.equal(onEas.length, 2);
  for (const b of onEas) {
    assert.equal(b.channel, brand.updates.channel);
    assert.equal(b.runtimeVersion, brand.runtimeVersion);
    assert.equal(b.appVersion, brand.appVersion);
  }
  assert.equal((await eas.get('/submissions')).submissions.length, 2);
  // Everything printed and written is free of secrets, tokens and the platform\'s name.
  const everything = `${lines.join('\n')}\n${fs.readFileSync(reportFile, 'utf8')}\n${JSON.stringify(await eas.get('/builds'))}\n${JSON.stringify(await eas.get('/submissions'))}`;
  assert.ok(!everything.includes(TOKEN), 'The build service token was printed');
  assert.ok(!/PRIVATE KEY|ABCDE12345|\.p8|\.p12|keystore/i.test(everything), 'A key or a credential was printed or echoed');
  assert.ok(!apps.namesPlatform(everything), 'The run names the platform');
  assert.ok(lines.some((l) => /done/.test(l)), 'The run does not say it is done');
  // Only one platform when one is asked for; a platform the brand lacks is refused.
  const one = await run(file, { driver: 'eas', easBuild: driver.easBuild, platforms: ['android'] });
  assert.deepEqual(one.report.builds.map((b) => b.platform), ['android']);
  const unknown = await run(file, { driver: 'eas', easBuild: driver.easBuild, platforms: ['windows'] });
  assert.equal(unknown.report.code, 'unknown_platform');
  // --submit with nothing built sends nothing; an unknown driver is named.
  assert.equal((await run(file, { driver: 'fax', easBuild: driver.easBuild })).report.code, 'unknown_driver');
  assert.equal((await run(file, { driver: 'eas', easBuild: driver.easBuild, skipBuild: true, submit: true, submitBuild: driver.submitBuild })).report.submissions.length, 0);
});

test('P-32: a platform that fails to build or to submit is reported with its reason; the other platform and the secrets are untouched', async () => {
  await eas.post('/reset');
  const driver = easDriver();
  const file = path.join(FIXTURES, BRANDS[1], 'brand.json');
  await eas.post('/builds/behaviour', { kind: 'fail', platform: 'ios', message: 'Provisioning profile is missing.' });
  const failed = await run(file, { driver: 'eas', easBuild: driver.easBuild, submitBuild: driver.submitBuild, submit: true });
  assert.equal(failed.report.ok, false);
  assert.equal(failed.report.step, 'build');
  assert.equal(failed.report.code, 'build_failed');
  const byPlatform = Object.fromEntries(failed.report.builds.map((b) => [b.platform, b]));
  assert.equal(byPlatform.android.status, 'built');
  assert.equal(byPlatform.ios.status, 'failed');
  assert.match(byPlatform.ios.detail, /Provisioning/);
  assert.deepEqual(failed.report.submissions.map((s) => s.platform), ['android'], 'The failed build was submitted');
  // The store refusing the submit.
  await eas.post('/submissions/behaviour', { kind: 'fail', message: 'Missing compliance answer.' });
  const refused = await run(file, { driver: 'eas', easBuild: driver.easBuild, submitBuild: driver.submitBuild, submit: true, platforms: ['android'] });
  assert.equal(refused.report.ok, false);
  assert.equal(refused.report.step, 'submit');
  assert.match(refused.report.submissions[0].detail, /compliance/i);
  // The build service timing out, answering junk or an error: failed with a plain sentence, no token, no address.
  for (const fault of [{ kind: 'timeout' }, { kind: 'malformed', mode: 'garbage' }, { kind: 'malformed', mode: 'html' }, { kind: 'server_error', status: 500 }, { kind: 'rate_limit' }, { kind: 'drop' }]) {
    await eas.post('/faults', { ...fault, times: 'forever', match: { path: '/v1/builds*' } });
    const started = Date.now();
    const res = await run(file, { driver: 'eas', easBuild: driver.easBuild, platforms: ['android'] });
    await eas.delete('/faults');
    assert.equal(res.report.ok, false, `A ${fault.kind} from EAS passed`);
    assert.equal(res.report.builds[0].status, 'failed');
    assert.ok(Date.now() - started < 20_000, `A ${fault.kind} held the run`);
    const text = JSON.stringify(res.report) + res.lines.join('\n');
    assert.ok(!text.includes(TOKEN) && !text.includes(eas.url), `A ${fault.kind} answer leaked the token or the address`);
  }
  // No EAS configured at all: the driver says so and nothing else happens.
  const none = await run(file, { driver: 'eas' });
  assert.equal(none.report.ok, false);
  assert.ok(['not_built', 'build_failed'].includes(none.report.code) || none.report.step === 'build');
});

// ---- P-35: a native change rebuilds every brand -----------------------------------------------------------------------------

test('P-35: every brand is rebuilt and the report lists each result; one brand failing does not stop the others', async () => {
  await eas.post('/reset');
  const driver = easDriver();
  await eas.post('/builds/behaviour', { kind: 'fail', platform: 'ios', message: 'Pod install failed.', times: 1 });
  const reports = [];
  for (const name of BRANDS) reports.push(await run(path.join(FIXTURES, name, 'brand.json'), { driver: 'eas', easBuild: driver.easBuild }));
  assert.equal(reports.length, BRANDS.length);
  assert.deepEqual(reports.map((r) => r.report.tenantId).sort(), BRANDS.map((n) => brandOf(n).tenantId).sort(), 'A brand is missing from the rebuild');
  for (const { report } of reports) assert.equal(report.builds.length, 2, 'Each brand lists each of its platforms');
  const failures = reports.flatMap((r) => r.report.builds.filter((b) => b.status === 'failed'));
  assert.equal(failures.length, 1, 'Exactly one build was made to fail');
  assert.ok(reports.filter((r) => r.report.ok).length === BRANDS.length - 1, 'The others did not carry on');
  assert.equal((await eas.get('/builds')).builds.length, BRANDS.length * 2);
  // The CI makes the same promise for the shared source: every fixture brand has its own Android and iOS job, and "ready" waits for all.
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/brand-apps.yml'), 'utf8');
  assert.match(workflow, /brands:\s*\$\{\{ steps\.list\.outputs\.brands \}\}/, 'The brand list is not built from the fixtures folder');
  assert.ok((workflow.match(/matrix:\s*\n\s+brand: \$\{\{ fromJSON\(needs\.brands\.outputs\.brands\) \}\}/g) ?? []).length >= 3, 'Android, iOS and the emulator flows are not run for every brand');
  assert.match(workflow, /fail-fast: false/, 'One brand failing stops the others');
  assert.match(workflow, /Brand apps ready/);
  const ready = workflow.slice(workflow.indexOf('Brand apps ready'));
  assert.match(ready, /needs:[^\n]*android[^\n]*ios|needs:[\s\S]{0,200}ios/, 'The final gate does not wait for the iOS job');
  assert.match(workflow, /on:\s*\n\s+push:\s*\n\s+branches:\s*\[main, '\*\*'\]/, 'A change to a dependency does not run every brand');
  // A changed lockfile is the native change: the workflow runs for every push, with no path filter that would skip it.
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('jobs:')), /paths(-ignore)?:/, 'A path filter can skip the brand builds');
});

// ---- P-36: no secret in the repository or the logs ------------------------------------------------------------------------

test('P-36: the repository holds no keystore, .p8, .p12 or private key, and the repo\'s own scanner agrees', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
  const banned = files.filter((f) => /\.(keystore|jks|p8|p12|pfx|mobileprovision|pem|key)$/i.test(f) || /(^|\/)(google-services\.json|GoogleService-Info\.plist|AuthKey_[A-Z0-9]+\.p8|\.env)$/i.test(f));
  assert.deepEqual(banned, [], 'A signing, Apple or Firebase file is tracked');
  const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{80,}/;
  const found = [];
  for (const f of files) {
    if (!/\.(js|mjs|cjs|json|ya?ml|md|txt|properties|gradle|sh|env|plist|xml)$/i.test(f)) continue;
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full) || fs.statSync(full).size > 1_000_000) continue;
    if (pem.test(fs.readFileSync(full, 'utf8'))) found.push(f);
  }
  assert.deepEqual(found, [], 'A private key is in a tracked file');
  for (const pattern of ['.brand-builds/t1/brand.json', 'apps/shopper/release.keystore', 'apps/shopper/AuthKey_X.p8', 'apps/shopper/credentials.json', 'apps/shopper/google-services.json', 'apps/shopper/x.p12', 'apps/shopper/x.jks', 'apps/shopper/brand.json']) {
    const ignored = spawnSync('git', ['check-ignore', '-q', pattern], { cwd: ROOT });
    assert.equal(ignored.status, 0, `${pattern} is not git-ignored`);
  }
  const scan = spawnSync(process.execPath, ['tools/secret-scan.mjs'], { cwd: ROOT, timeout: 120_000 });
  assert.equal(scan.status, 0, `The secret scan failed: ${String(scan.stdout).slice(-400)}${String(scan.stderr).slice(-400)}`);
});

test('P-36: a build\'s log, report and failure messages never hold the signing password, the key file\'s content or an Apple key', async () => {
  const keystore = path.join(tmp(), 'ci.keystore');
  fs.writeFileSync(keystore, `KEYSTORE-BYTES-${SECRET}`);
  const signing = { storeFile: keystore, storePassword: SECRET, keyAlias: 'ci', keyPassword: `${SECRET}-key` };
  const reportFile = path.join(tmp(), 'r.json');
  for (const platform of ['android', 'ios']) {
    // The real local driver with a runner that records what it is given, and one that fails with the password in its message.
    for (const fails of [false, true]) {
      const lines = [];
      const seen = [];
      const report = await buildBrand(path.join(FIXTURES, BRANDS[0], 'brand.json'), {
        cwd: ROOT, outDir: tmp(), driver: 'local', profile: 'preview', platforms: [platform], anyHost: true, signing, reportFile, log: (l) => lines.push(l),
        exec: async (command, args) => { seen.push([command, ...args].join(' ')); if (fails) throw new Error(`failed: ${args.join(' ')} ${SECRET}`); },
      });
      const out = `${lines.join('\n')}\n${JSON.stringify(report)}\n${fs.readFileSync(reportFile, 'utf8')}`;
      assert.ok(!out.includes(SECRET), `${platform}${fails ? ' (failing)' : ''}: the password was printed`);
      assert.ok(!out.includes('KEYSTORE-BYTES'), 'The key file\'s content was printed');
      if (platform === 'android' && !fails) assert.ok(seen.some((s) => s.includes(SECRET)), 'The runner was not given the key to sign with');
      assert.ok(lines.some((l) => /build-brand/.test(l)));
    }
  }
  // The commands as data: the secret arguments are marked, and no command writes a key to disk.
  const commands = localCommands({ platform: 'android', brandDir: tmp(), options: { signing } });
  const gradle = commands.at(-1);
  assert.ok(gradle.secret.length >= 2, 'The password arguments are not marked secret');
  for (const i of gradle.secret) assert.match(gradle.args[i], /password/);
  assert.ok(!commands.some((c) => /keytool|openssl|base64/.test(c.command) || c.args.some((a) => /\.p8|\.p12/.test(a))));
  // A production build is refused on this runner: store builds are signed by the build service only.
  const prod = await buildBrand(path.join(FIXTURES, BRANDS[0], 'brand.json'), { cwd: ROOT, outDir: tmp(), driver: 'local', profile: 'production', platforms: ['android'], log: () => {}, exec: async () => {} });
  assert.equal(prod.builds[0].status, 'failed');
  assert.match(prod.builds[0].detail, /eas driver|build service/i);
  // The workflow: the key is made in the job, masked, and removed even on failure; nothing echoes it.
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/brand-apps.yml'), 'utf8');
  assert.match(workflow, /::add-mask::\$KEY_PASS/);
  assert.ok(workflow.indexOf('::add-mask::') < workflow.indexOf('keytool'), 'The key is made before it is masked');
  assert.match(workflow, /if: always\(\)\s*\n\s+run: rm -f "\$RUNNER_TEMP\/ci\.keystore"/, 'The key is not thrown away after a failure');
  assert.doesNotMatch(workflow, /set -x|echo "\$KEY_PASS"|echo \$KEY_PASS|cat "?\$RUNNER_TEMP\/ci\.keystore|secrets\.[A-Z_]*(KEYSTORE|P8|P12|APPLE|PLAY)/i, 'The workflow prints or reads a signing secret');
  assert.doesNotMatch(workflow, /upload-artifact@v4[\s\S]{0,200}path:[^\n]*(keystore|\.p8|\.p12|\.brand-builds)/, 'An artifact carries a key');
  // EAS builds carry credentials by the service\'s own store: the brand file has no field for any.
  for (const key of Object.keys(brandOf(BRANDS[0]))) assert.doesNotMatch(key, /key|secret|password|token|credential|cert|profile|keystore/i, `The brand file has a field named ${key}`);
});

// ---- P-55, P-56, P-57, P-59 and I-03: what the build carries ----------------------------------------------------------------

test('P-55: the images of every fixture brand pass the stores\' current spec, and the listing rules the pipeline reads are the stores\'', async () => {
  for (const name of BRANDS) {
    const brand = brandOf(name);
    const { measure } = await import('../../../tools/build-brand/steps/assets.mjs');
    for (const [key, spec] of [['icon', 'icon_ios'], ['adaptiveForeground', 'adaptive_foreground'], ['adaptiveBackground', 'adaptive_background'], ['notificationIcon', 'notification_icon'], ['splash', 'splash']]) {
      const problems = apps.checkAsset(spec, await measure(path.join(FIXTURES, name, brand.assets[key])));
      assert.deepEqual(problems, [], `${name} ${key}: ${JSON.stringify(problems)}`);
    }
  }
  assert.equal(apps.STORE_LIMITS.play.shortDescription, 80);
  assert.equal(apps.STORE_LIMITS.appStore.shortDescription, 30);
  assert.equal(apps.STORE_LIMITS.play.featureGraphic.width, 1024);
  assert.equal(apps.STORE_LIMITS.play.featureGraphic.height, 500);
  assert.equal(apps.ASSET_SPECS.icon_ios.width, 1024);
  assert.equal(apps.ASSET_SPECS.icon_play.width, 512);
  // Screenshot sizes: a size the store does not list fails, one it does passes (portrait or turned on its side).
  assert.deepEqual(apps.checkAsset('screenshot_iphone_6_9', { width: 1320, height: 2868, mime: 'image/png', hasAlpha: false }), []);
  assert.deepEqual(apps.checkAsset('screenshot_iphone_6_9', { width: 2868, height: 1320, mime: 'image/png', hasAlpha: false }), []);
  assert.ok(apps.checkAsset('screenshot_iphone_6_9', { width: 1000, height: 2000, mime: 'image/png', hasAlpha: false }).some((p) => p.code === 'wrong_size'));
  assert.ok(apps.checkAsset('screenshot_iphone_6_9', { width: 1320, height: 2868, mime: 'image/png', hasAlpha: true }).some((p) => p.code === 'has_alpha'));
  assert.ok(apps.checkAsset('feature_graphic', { width: 1024, height: 500, mime: 'image/gif' }).some((p) => p.code === 'wrong_type'));
  assert.ok(apps.checkAsset('icon_play', { width: 512, height: 512, mime: 'image/png', bytes: 2 * 1024 * 1024 }).some((p) => p.code === 'too_large'));
});

test('P-56: a listing text over the store\'s limit fails and names the limit; in characters, per store', () => {
  const play = apps.listingProblems('android', { title: 'Mehta Mart', shortDescription: 'x'.repeat(92), fullDescription: 'Shop the range.' });
  assert.equal(play.length, 1);
  assert.deepEqual([play[0].field, play[0].code, play[0].limit, play[0].length], ['shortDescription', 'too_long', 80, 92]);
  assert.match(play[0].message, /Short description is 92 characters\. Google Play allows 80\./);
  assert.deepEqual(apps.listingProblems('android', { title: 'Mehta Mart', shortDescription: 'x'.repeat(80), fullDescription: 'Shop.' }), []);
  assert.deepEqual(apps.listingProblems('android', { title: 'Mehta Mart', shortDescription: 'क'.repeat(80), fullDescription: 'Shop.' }), [], 'Characters, not bytes');
  assert.equal(apps.listingProblems('ios', { title: 'Mehta Mart', shortDescription: 'y'.repeat(31), fullDescription: 'Shop.' })[0].limit, 30);
  assert.ok(apps.listingProblems('android', { title: 'Bhava Shop', shortDescription: 'ok', fullDescription: 'Shop.' }).some((p) => p.code === 'names_platform'));
  assert.ok(apps.listingProblems('android', { title: '', shortDescription: '', fullDescription: '' }).every((p) => p.code === 'required'));
  assert.equal(apps.listingProblems('windows', {})[0].field, 'platform');
});

test('P-57: the app carries a privacy manifest that declares tracking off and every required-reason API it uses, SDKs included', () => {
  const brandFile = path.join(FIXTURES, BRANDS[0], 'brand.json');
  const before = process.env.BRAND_FILE;
  process.env.BRAND_FILE = brandFile;
  try {
    delete require.cache[require.resolve('../../../apps/shopper/app.config.js')];
    const config = require('../../../apps/shopper/app.config.js')();
    const manifest = config.ios.privacyManifests;
    assert.ok(manifest, 'No privacy manifest');
    assert.equal(manifest.NSPrivacyTracking, false);
    assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);
    const types = manifest.NSPrivacyAccessedAPITypes.map((t) => t.NSPrivacyAccessedAPIType);
    for (const type of ['NSPrivacyAccessedAPICategoryUserDefaults', 'NSPrivacyAccessedAPICategoryFileTimestamp', 'NSPrivacyAccessedAPICategorySystemBootTime', 'NSPrivacyAccessedAPICategoryDiskSpace']) assert.ok(types.includes(type), `${type} is not declared`);
    for (const entry of manifest.NSPrivacyAccessedAPITypes) assert.ok(entry.NSPrivacyAccessedAPITypeReasons.length >= 1 && entry.NSPrivacyAccessedAPITypeReasons.every((r) => /^[A-Z0-9]{3,4}\.[0-9]$/.test(r)), 'A required-reason API has no reason code');
    assert.equal(config.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
    assert.ok(config.ios.infoPlist.NSCameraUsageDescription.length > 10 && !apps.namesPlatform(config.ios.infoPlist.NSCameraUsageDescription));
  } finally {
    if (before === undefined) delete process.env.BRAND_FILE;
    else process.env.BRAND_FILE = before;
  }
  // What the app collects, for the Play data safety form and Apple\'s labels: none tracks, payment details are not listed.
  assert.ok(apps.DATA_COLLECTED.every((d) => d.tracking === false));
  assert.ok(!apps.DATA_COLLECTED.some((d) => /card|upi|bank|payment/.test(d.type)));
});

test('P-59: the build side of the gate: the account screen can delete the account, payment is the gateway\'s, no web view, no in-app purchase', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/shopper/package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(!deps.some((d) => /webview/i.test(d)), 'A WebView library is in the build (Apple 4.2)');
  assert.ok(!deps.some((d) => /iap|in-app-purchases|purchases|billing|storekit|revenuecat/i.test(d)), 'An in-app purchase library is in the build (Apple 3.1.3(e))');
  const config = (() => {
    const before = process.env.BRAND_FILE;
    process.env.BRAND_FILE = path.join(FIXTURES, BRANDS[0], 'brand.json');
    try {
      delete require.cache[require.resolve('../../../apps/shopper/app.config.js')];
      return require('../../../apps/shopper/app.config.js')();
    } finally {
      if (before === undefined) delete process.env.BRAND_FILE;
      else process.env.BRAND_FILE = before;
    }
  })();
  assert.ok(config.ios.usesAppleSignIn, 'Sign in with Apple is not offered (4.8)');
  assert.ok(!(config.ios.entitlements && 'com.apple.developer.in-app-payments' in config.ios.entitlements), 'An in-app payment entitlement');
  assert.ok(config.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));
  assert.ok(config.android.permissions.includes('android.permission.POST_NOTIFICATIONS'), 'Push has no Android 13 permission to ask for');
  // The account screen\'s call exists in the store client, and its route is the shopper\'s own.
  const client = fs.readFileSync(path.join(ROOT, 'packages/store-client/src/routes.js'), 'utf8');
  assert.match(client, /appAccountDelete/, 'The store client cannot call account deletion');
  // The presubmit list names 5.1.1(v) for exactly this check.
  const check = apps.PRESUBMIT_CHECKS.find((c) => c.code === 'account_deletion');
  assert.equal(check.guideline, '5.1.1(v)');
  assert.deepEqual(apps.PRESUBMIT_CHECKS.map((c) => c.guideline).filter(Boolean).sort(), ['2.1(a)', '3.1.3(e)', '4.2', '4.5.4', '5.1.1(v)', 'ios:privacy_manifest', 'ios:sdk', 'play:target_api']);
});

test('I-03: a tier 5 seller\'s iOS app needs only the brand kit and Apple account access: no certificate, profile, key or extra file in the brand', async () => {
  // An iOS-only brand file builds ios and asks for nothing Android.
  const file = variant((b) => { b.android = null; b.push = { android: false, ios: false }; });
  const { report } = await run(file, { skipBuild: true });
  assert.equal(report.ok, true, `${report.step}: ${report.message}`);
  const ios = await run(file, { driver: 'eas', easBuild: easDriver().easBuild });
  assert.deepEqual(ios.report.builds.map((b) => b.platform), ['ios']);
  // From the database: the kit and the Apple team ID and bundle ID are all it takes.
  const config = { appName: 'Mehta Mart', shortName: 'Mehta', shopDomain: 'shop.mehta.example', supportEmail: 'help@mehta.example', privacyUrl: 'https://shop.mehta.example/policies/privacy', iconMediaId: 'icon-1', urlScheme: 'mehtamart', iosBundleId: 'in.example.mehtamart', appleTeamId: 'ABCDE12345' };
  assert.deepEqual(apps.brandFileProblems(config, { colors: { primary: '#2E7D5B' } }, { platforms: ['ios'], hosts: ['shop.mehta.example'] }), []);
  // The team ID and bundle ID are named when missing, and nothing about a certificate is ever asked.
  const missing = apps.brandFileProblems({ ...config, appleTeamId: '', iosBundleId: '' }, { colors: { primary: '#2E7D5B' } }, { platforms: ['ios'], hosts: ['shop.mehta.example'] });
  assert.deepEqual(missing.map((p) => p.field).sort(), ['appleTeamId', 'iosBundleId']);
  assert.ok(missing.every((p) => p.platform === 'ios'));
  assert.ok(!JSON.stringify(missing).match(/certificate|provisioning|profile|p12|keystore/i));
  // iPhone only, the SDK minimum is what the gate checks, and the iOS job exists in CI for every brand.
  assert.equal(apps.IOS_XCODE_MIN, 26);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/brand-apps.yml'), 'utf8');
  assert.match(workflow, /runs-on: macos-26/);
  assert.match(workflow, /--platform ios --driver local --profile simulator/);
  const parsed = parseArgs(['tools/build-brand/fixtures/x/brand.json', '--platform', 'ios', '--driver', 'eas', '--profile', 'production', '--submit']);
  assert.deepEqual([parsed.options.platforms, parsed.options.driver, parsed.options.profile, parsed.options.submit], [['ios'], 'eas', 'production', true]);
  assert.throws(() => parseArgs(['x', '--profile', 'gold']), /production, preview or simulator/);
  assert.throws(() => parseArgs(['x', '--bogus']), /Unknown option/);
  assert.throws(() => parseArgs(['x', 'y']), /one business/);
  assert.throws(() => parseArgs(['x', '--platform']), /needs a value/);
});

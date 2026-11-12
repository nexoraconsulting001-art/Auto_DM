// The store listing screenshots (tools/listing-shots, P-55): taken from the real build, fitted to the sizes in ASSET_SPECS,
// checked against the spec, stored as listing assets that come from a build capture, and refused when they do not.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ASSET_SPECS, checkAsset } from '../../../src/contracts/apps.js';
import { MODULES } from '../../../src/modules/index.js';
import { storeListingsFor } from '../../../src/modules/store-listings/index.js';
import { createAppStores } from '../../../src/adapters/appstores/index.js';
import { createEas } from '../../../src/adapters/eas/index.js';
import { createPlatform } from '../../../src/platform/index.js';
import { createRepos } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { DEVICES, SCREENS, checkShot, devicesOf, fitCaptures, fitShot, hasContent, hashFile, stampOf, storeShots } from '../../../tools/listing-shots/index.mjs';
import { pickSimulator } from '../../../tools/listing-shots/pick-simulator.mjs';
import { addAppShop, useP6World } from '../spec-p6/kit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TOOL = path.join(ROOT, 'tools/listing-shots/index.mjs');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `brand-ci-${label}-`));

/** A picture of an app screen: bands of colour with some detail, with a transparent status bar like a phone's raw capture. */
async function screen(width, height, seed) {
  const bands = [];
  for (let i = 0; i < 6; i++) bands.push({ input: { create: { width, height: Math.round(height / 8), channels: 3, background: { r: (seed * 40 + i * 30) % 256, g: (i * 50 + seed * 10) % 256, b: (200 - i * 25 + seed * 15) % 256 } } }, top: i * Math.round(height / 7), left: 0 });
  return sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.5 } } }).composite(bands).png().toBuffer();
}

test('every listing device is sized by ASSET_SPECS, and each size passes its own spec', async () => {
  assert.deepEqual(Object.keys(DEVICES).sort(), ['iphone_6_5', 'iphone_6_9', 'phone']);
  assert.deepEqual(devicesOf('android'), ['phone']);
  assert.deepEqual(devicesOf('ios'), ['iphone_6_9', 'iphone_6_5']);
  assert.ok(ASSET_SPECS.screenshot_iphone_6_9.sizes.some(([w, h]) => w === DEVICES.iphone_6_9.size[0] && h === DEVICES.iphone_6_9.size[1]));
  assert.ok(ASSET_SPECS.screenshot_iphone_6_5.sizes.some(([w, h]) => w === DEVICES.iphone_6_5.size[0] && h === DEVICES.iphone_6_5.size[1]));
  for (const device of Object.keys(DEVICES)) {
    const fitted = await fitShot(await screen(1080, 2400, 1), device);
    assert.deepEqual(await checkShot(fitted, device), [], device);
  }
});

test('an emulator\'s raw capture is not a Play screenshot until it is fitted, and fitting makes it one', async () => {
  const raw = await screen(1080, 2400, 2);
  const info = await sharp(raw).metadata();
  const rawProblems = checkAsset('screenshot_phone', { width: info.width, height: info.height, mime: 'image/png', hasAlpha: true });
  assert.deepEqual(rawProblems.map((p) => p.code).sort(), ['has_alpha', 'wrong_ratio']);
  const fitted = await fitShot(raw, 'phone');
  const meta = await sharp(fitted).metadata();
  assert.deepEqual([meta.width, meta.height, meta.hasAlpha, meta.format], [1080, 2160, false, 'png']);
  // A phone of another shape is cut, not stretched: the top, with the status bar, stays.
  const wide = await fitShot(await screen(1440, 3120, 3), 'iphone_6_5');
  assert.deepEqual([(await sharp(wide).metadata()).width, (await sharp(wide).metadata()).height], DEVICES.iphone_6_5.size);
  await assert.rejects(() => fitShot(raw, 'tv'), /Unknown device/);
});

test('a blank or crashed screen is not a shot', async () => {
  const blank = await sharp({ create: { width: 400, height: 800, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal(await hasContent(blank), false);
  assert.equal(await hasContent(await screen(400, 800, 4)), true);
});

describe('a folder of captures', () => {
  let build;
  let dir;
  const write = async (name, buffer) => fs.writeFileSync(path.join(dir, name), buffer);
  const stamp = (over = {}) => fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ ...stampOf({ platform: 'android', appId: 'app.test', buildFile: build, device: 'phone' }), ...over }));
  before(async () => {
    const root = tmp('build');
    build = path.join(root, 'app.apk');
    fs.writeFileSync(build, 'an apk, as far as the hash is concerned');
  });
  after(() => fs.rmSync(path.dirname(build), { recursive: true, force: true }));
  const fresh = async (skip = []) => {
    dir = tmp('captures');
    for (const [i, name] of SCREENS.entries()) if (!skip.includes(name)) await write(`${name}.png`, await screen(1080, 2400, i + 1));
    stamp();
  };

  test('are fitted, checked and written with a manifest', async () => {
    await fresh();
    const out = tmp('out');
    const result = await fitCaptures({ captures: dir, build, platform: 'android', out });
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
    assert.equal(result.shots.length, SCREENS.length);
    for (const shot of result.shots) {
      assert.equal(shot.specOk, true);
      assert.deepEqual([shot.width, shot.height], DEVICES.phone.size);
      assert.deepEqual(await checkShot(fs.readFileSync(path.join(out, shot.file)), 'phone'), []);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'listing-shots.json'), 'utf8'));
    assert.equal(manifest.ok, true);
    assert.equal(manifest.buildSha256, hashFile(build));
    assert.deepEqual(result.shots.map((s) => s.position), [0, 1, 2, 3]);
  });

  test('P-55: are refused without a stamp, from another build, for another platform, or when a picture is blank, repeated or missing', async () => {
    await fresh();
    fs.rmSync(path.join(dir, 'capture.json'));
    assert.match((await fitCaptures({ captures: dir, build, platform: 'android', out: tmp('o') })).problems[0], /no capture\.json/);

    await fresh();
    const other = path.join(path.dirname(build), 'other.apk');
    fs.writeFileSync(other, 'a different build');
    assert.match((await fitCaptures({ captures: dir, build: other, platform: 'android', out: tmp('o') })).problems[0], /different build/);

    await fresh();
    assert.match((await fitCaptures({ captures: dir, build, platform: 'ios', out: tmp('o') })).problems.join(' '), /captures are for android, not ios/);

    await fresh();
    stamp({ source: 'upload' });
    assert.match((await fitCaptures({ captures: dir, build, platform: 'android', out: tmp('o') })).problems.join(' '), /do(es)? not say/);

    await fresh();
    await write('catalog.png', await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#fff' } }).png().toBuffer());
    assert.match((await fitCaptures({ captures: dir, build, platform: 'android', out: tmp('o') })).problems.join(' '), /catalog capture is blank/);

    await fresh();
    await write('product.png', fs.readFileSync(path.join(dir, 'home.png')));
    assert.match((await fitCaptures({ captures: dir, build, platform: 'android', out: tmp('o') })).problems.join(' '), /same picture/);

    await fresh(['cart', 'product', 'catalog']);
    const few = await fitCaptures({ captures: dir, build, platform: 'android', out: tmp('o') });
    assert.equal(few.ok, false);
    assert.match(few.problems.join(' '), /No capture of the cart screen/);
    assert.match(few.problems.join(' '), /at least 2 screenshots/);
  });

  test('the command line stamps and fits as the capture scripts and the jobs do', async () => {
    await fresh();
    fs.rmSync(path.join(dir, 'capture.json'));
    const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
    assert.equal(run(['stamp', '--platform', 'android', '--app-id', 'app.test', '--build', build, '--device', 'phone', '--out', dir]).status, 0);
    const out = tmp('cli');
    const fitted = run(['fit', '--platform', 'android', '--captures', dir, '--build', build, '--out', out]);
    assert.equal(fitted.status, 0, fitted.stderr);
    assert.match(fitted.stdout, /4 images, all within the store specs/);
    fs.writeFileSync(build, 'changed after the shots were taken');
    const stale = run(['fit', '--platform', 'android', '--captures', dir, '--build', build, '--out', tmp('cli2')]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /different build/);
    assert.equal(run([]).status, 2);
  });
});

describe('the capture scripts, with stand-ins for adb, maestro, xcrun and the plist tool', () => {
  const bash = (script, args, env) => spawnSync('bash', [path.join(ROOT, 'tools/listing-shots', script), ...args], { encoding: 'utf8', env, cwd: ROOT });
  const standIns = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const tool = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    // Each stand-in writes how it was called; maestro puts the pictures where the real one does, in its working folder.
    for (const name of ['adb', 'xcrun']) tool(name, `printf '%s\\n' "$*" >> "$CALLS"`);
    tool('unzip', 'mkdir -p "$4/App.app"; echo plist > "$4/App.app/Info.plist"');
    tool('maestro', `printf 'maestro %s\\n' "$*" >> "$CALLS"; for n in home catalog product cart; do cp "$PICTURES/$n.png" "$n.png"; done`);
    return dir;
  };

  test('android: installs, sets the screen to the Play shape, runs the shots flow from the captures folder, puts the screen back, stamps', async () => {
    const root = tmp('android');
    const bin = standIns(path.join(root, 'bin'));
    const pictures = path.join(root, 'pictures');
    fs.mkdirSync(pictures);
    for (const [i, name] of SCREENS.entries()) fs.writeFileSync(path.join(pictures, `${name}.png`), await screen(1080, 2160, i + 1));
    fs.writeFileSync(path.join(root, 'flows.env'), 'APP_ID=app.test\nPRODUCT_SLUG=flow-test-mug\n');
    fs.writeFileSync(path.join(root, 'app.apk'), 'apk bytes');
    const calls = path.join(root, 'calls.txt');
    const out = path.join(root, 'shots');
    const run = bash('capture-android.sh', [path.join(root, 'flows.env'), path.join(root, 'app.apk'), out], { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CALLS: calls, PICTURES: pictures });
    assert.equal(run.status, 0, run.stderr);
    const log = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.match(log[0], /^install -r .*app\.apk/);
    assert.equal(log[1], 'shell wm size 1080x2160');
    assert.match(log[2], /^maestro test -e APP_ID=app\.test -e PRODUCT_SLUG=flow-test-mug .*apps\/shopper\/\.maestro\/shots\/shots\.yaml$/);
    assert.equal(log.at(-1), 'shell wm size reset');
    const stamped = JSON.parse(fs.readFileSync(path.join(out, 'capture.json'), 'utf8'));
    assert.deepEqual([stamped.platform, stamped.appId, stamped.source], ['android', 'app.test', 'build_capture']);
    assert.equal(stamped.buildSha256, hashFile(path.join(root, 'app.apk')));
    const fitted = await fitCaptures({ captures: out, build: path.join(root, 'app.apk'), platform: 'android', out: path.join(root, 'fitted') });
    assert.deepEqual(fitted.problems, []);
  });

  test('the screen is put back even when the flow fails', () => {
    const root = tmp('android-fail');
    const bin = standIns(path.join(root, 'bin'));
    fs.writeFileSync(path.join(bin, 'maestro'), '#!/usr/bin/env bash\nexit 3\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'flows.env'), 'APP_ID=app.test\n');
    fs.writeFileSync(path.join(root, 'app.apk'), 'apk bytes');
    const calls = path.join(root, 'calls.txt');
    const run = bash('capture-android.sh', [path.join(root, 'flows.env'), path.join(root, 'app.apk'), path.join(root, 'shots')], { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CALLS: calls });
    assert.notEqual(run.status, 0);
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1), 'shell wm size reset');
    assert.equal(fs.existsSync(path.join(root, 'shots', 'capture.json')), false, 'a failed flow is never stamped');
  });

  test('ios: the scripts name the simulator install, the bundle id and the flow, and never the Android id', () => {
    const text = fs.readFileSync(path.join(ROOT, 'tools/listing-shots/capture-ios.sh'), 'utf8');
    assert.match(text, /xcrun simctl install booted/);
    assert.match(text, /PlistBuddy -c 'Print :CFBundleIdentifier'/);
    assert.match(text, /\[ "\$name" != "APP_ID" \]/, 'the Android id is dropped so the bundle id is the only app id');
    assert.match(text, /shots\/shots\.yaml/);
    assert.match(text, /--platform ios .*--device iphone_6_9/);
    assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'tools/listing-shots/capture-ios.sh')]).status, 0);
    assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'tools/listing-shots/capture-android.sh')]).status, 0);
  });

  test('the simulator for the App Store shots is the newest 6.9 inch iPhone', () => {
    const listing = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ name: 'iPhone 16 Pro Max', udid: 'OLD', isAvailable: true }],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ name: 'iPhone 17', udid: 'SMALL', isAvailable: true }, { name: 'iPhone 17 Pro Max', udid: 'NEW', isAvailable: true }, { name: 'iPhone Air', udid: 'AIR', isAvailable: true }],
        'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [{ name: 'Apple Watch', udid: 'WATCH', isAvailable: true }],
      },
    };
    assert.equal(pickSimulator(listing), 'NEW');
    assert.equal(pickSimulator({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ name: 'iPhone 17', udid: 'X' }] } }), null);
  });
});

describe('stored as listing assets', () => {
  const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-ci-listing-'));
  const world = useP6World({ overrides: { storageDriver: 'local', storageDir: STORAGE } });
  let ctx;
  const ctxOf = () => {
    if (!ctx) {
      const platform = createPlatform(world.config, { db: world.db });
      ctx = { db: world.db, config: world.config, platform, repos: createRepos(world.db, { secrets: platform.secrets, storage: platform.storage }), modules: MODULES, eas: createEas(world.config), appStores: createAppStores(world.config) };
    }
    return ctx;
  };

  test('the fitted shots go in as build captures, for both stores, and a shot that fails its spec is not stored', async () => {
    const shop = await addAppShop(world, { platforms: ['android', 'ios'] });
    const listings = storeListingsFor(ctxOf());
    const root = tmp('store');
    const build = path.join(root, 'app.bin');
    fs.writeFileSync(build, 'build');
    for (const platform of ['android', 'ios']) {
      const dir = path.join(root, `captures-${platform}`);
      fs.mkdirSync(dir);
      for (const [i, name] of SCREENS.entries()) fs.writeFileSync(path.join(dir, `${name}.png`), await screen(platform === 'ios' ? 1320 : 1080, platform === 'ios' ? 2868 : 2400, i + 1));
      fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify(stampOf({ platform, appId: 'app.test', buildFile: build, device: platform === 'ios' ? 'iphone_6_9' : 'phone' })));
      const out = path.join(root, `out-${platform}`);
      const fitted = await fitCaptures({ captures: dir, build, platform, out });
      assert.deepEqual(fitted.problems, []);
      const stored = await withTenant(shop.tenantId, () => storeShots({ listings, out, platform }));
      assert.equal(stored.length, platform === 'ios' ? SCREENS.length * 2 : SCREENS.length);
      assert.ok(stored.every((asset) => asset.specOk === true && asset.kind === 'screenshot'), JSON.stringify(stored.map((a) => a.problems)));
    }
    const rows = await shop.sql("SELECT platform, device, position, source, spec_ok, width, height FROM listing_assets WHERE tenant_id = $1 AND kind = 'screenshot' ORDER BY platform, device, position", [shop.tenantId]);
    assert.ok(rows.every((row) => row.source === 'build_capture' && row.spec_ok === true));
    assert.deepEqual([...new Set(rows.map((r) => `${r.platform}:${r.device}:${r.width}x${r.height}`))].sort(), ['android:phone:1080x2160', 'ios:iphone_6_5:1284x2778', 'ios:iphone_6_9:1320x2868']);

    // A manifest that did not pass is not stored, and a picture the store would refuse is not made one by the label.
    const bad = path.join(root, 'bad');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'listing-shots.json'), JSON.stringify({ ok: false, shots: [] }));
    await assert.rejects(() => storeShots({ listings, out: bad, platform: 'android' }), /did not pass their spec/);
    await assert.rejects(() => withTenant(shop.tenantId, async () => listings.putAsset('android', 'screenshot', await screen(1080, 2400, 9), { device: 'phone', source: 'upload' })), /real build/);
  });
});

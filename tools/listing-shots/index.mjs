/**
 * Store listing screenshots (PRD 10.13, P-55): taken from the real build of one brand on an emulator or simulator, with that
 * brand's seeded catalog, then fitted to the stores' sizes and checked against ASSET_SPECS. Never a mock-up: a shot is taken
 * only from a capture folder that the capture script wrote for a build whose file hash it records, and the hash must be the
 * one of the build being listed.
 *
 *   capture      tools/listing-shots/capture-android.sh | capture-ios.sh      run the shots flow, write <dir>/capture.json
 *   fit          node tools/listing-shots/index.mjs fit --platform android|ios --captures <dir> --build <apk|zip> --out <dir>
 *                                                      [--device phone|iphone_6_9|iphone_6_5]...
 *   stamp        node tools/listing-shots/index.mjs stamp --platform p --app-id id --build <file> --device <name> --out <dir>
 *                                                     (written by the capture scripts, after the shots are taken)
 *
 * `fit` writes <platform>-<device>-<position>.png and listing-shots.json, and exits 1 naming any shot that fails its spec.
 * `storeShots` puts the fitted images into a business's listing (listing_assets) as source build_capture.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ASSET_SPECS, assetSpecKey, checkAsset } from '../../src/contracts/apps.js';

/** The screens of the shots flow, in the order the listing shows them (the file name is the position). */
export const SCREENS = Object.freeze(['home', 'catalog', 'product', 'cart']);

/** Each listing device: the store it is for, the ASSET_SPECS key, and the picture size it is made at. */
export const DEVICES = Object.freeze({
  phone: Object.freeze({ platform: 'android', spec: 'screenshot_phone', size: [1080, 2160] }),
  iphone_6_9: Object.freeze({ platform: 'ios', spec: 'screenshot_iphone_6_9', size: ASSET_SPECS.screenshot_iphone_6_9.sizes[0] }),
  iphone_6_5: Object.freeze({ platform: 'ios', spec: 'screenshot_iphone_6_5', size: ASSET_SPECS.screenshot_iphone_6_5.sizes[0] }),
});
export const devicesOf = (platform) => Object.keys(DEVICES).filter((name) => DEVICES[name].platform === platform);

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
export const hashFile = (file) => sha256(fs.readFileSync(file));

/**
 * One capture fitted to one device: flat (no transparency), the device's size (the long side is cut, never stretched, when
 * the shape differs), PNG. Answers the PNG bytes.
 */
export async function fitShot(buffer, device) {
  const spec = DEVICES[device];
  if (!spec) throw new Error(`Unknown device ${device}`);
  const [width, height] = spec.size;
  return sharp(buffer).flatten({ background: '#ffffff' }).resize(width, height, { fit: 'cover', position: 'top' }).png().toBuffer();
}

/** A shot's problems against its spec, as checkAsset words: [{ code, message }]. */
export async function checkShot(buffer, device) {
  const info = await sharp(buffer).metadata();
  const mime = info.format === 'png' ? 'image/png' : info.format === 'jpeg' ? 'image/jpeg' : null;
  return checkAsset(DEVICES[device].spec, { width: info.width, height: info.height, mime, hasAlpha: Boolean(info.hasAlpha), bytes: buffer.length });
}

/** True when a picture has something on it: more than one colour with a spread (a blank or crashed screen is not a shot). */
export async function hasContent(buffer) {
  const { channels } = await sharp(buffer).stats();
  return channels.some((channel) => channel.stdev > 3);
}

/** What a capture script writes beside the captured pictures. */
export function stampOf({ platform, appId, buildFile, device }) {
  return { platform, appId, device, buildSha256: hashFile(buildFile), screens: SCREENS, source: 'build_capture' };
}

/**
 * Fits and checks every capture of a folder. Answers { ok, shots: [{ file, platform, device, position, screen, width, height,
 * bytes, sha256, specOk, problems }], problems: [string] }. Refuses a folder without a stamp for this build and platform.
 */
export async function fitCaptures({ captures, build, platform, out, devices = devicesOf(platform) }) {
  const problems = [];
  let stamp = null;
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(captures, 'capture.json'), 'utf8'));
  } catch {
    problems.push('The capture folder has no capture.json: shots are taken only by the capture script, from a build');
  }
  if (stamp) {
    if (stamp.source !== 'build_capture') problems.push('capture.json does not say the shots are build captures');
    if (stamp.platform !== platform) problems.push(`The captures are for ${stamp.platform}, not ${platform}`);
    if (stamp.buildSha256 !== hashFile(build)) problems.push('The captures were taken from a different build than the one being listed');
  }
  if (problems.length) return { ok: false, shots: [], problems };
  fs.mkdirSync(out, { recursive: true });
  const shots = [];
  const seen = new Set();
  for (const [position, screen] of SCREENS.entries()) {
    const file = path.join(captures, `${screen}.png`);
    if (!fs.existsSync(file)) {
      problems.push(`No capture of the ${screen} screen`);
      continue;
    }
    const raw = fs.readFileSync(file);
    if (!(await hasContent(raw))) problems.push(`The ${screen} capture is blank`);
    if (seen.has(sha256(raw))) problems.push(`The ${screen} capture is the same picture as an earlier one`);
    seen.add(sha256(raw));
    for (const device of devices) {
      const fitted = await fitShot(raw, device);
      const found = await checkShot(fitted, device);
      const name = `${platform}-${device}-${position}.png`;
      fs.writeFileSync(path.join(out, name), fitted);
      const info = await sharp(fitted).metadata();
      shots.push({ file: name, platform, device, position, screen, width: info.width, height: info.height, bytes: fitted.length, sha256: sha256(fitted), specOk: found.length === 0, problems: found });
      for (const problem of found) problems.push(`${name}: ${problem.message}`);
    }
  }
  const floor = platform === 'ios' ? 1 : ASSET_SPECS.screenshot_phone.min;
  if (shots.filter((shot) => shot.device === devices[0]).length < floor) problems.push(`The store needs at least ${floor} screenshots`);
  fs.writeFileSync(path.join(out, 'listing-shots.json'), `${JSON.stringify({ ok: problems.length === 0, platform, buildSha256: stamp.buildSha256, shots }, null, 2)}\n`);
  return { ok: problems.length === 0, shots, problems };
}

/**
 * Puts fitted shots into a business's listing (store-listings' putAsset), as build captures. `listings` is
 * storeListingsFor(ctx); the call runs inside the business (withTenant). Answers the stored assets.
 */
export async function storeShots({ listings, out, platform, buildId = null }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'listing-shots.json'), 'utf8'));
  if (!manifest.ok) throw new Error('These shots did not pass their spec, so they are not stored');
  const stored = [];
  for (const shot of manifest.shots.filter((s) => s.platform === platform)) {
    const key = assetSpecKey(platform, 'screenshot', shot.device);
    if (!key) throw new Error(`No spec for ${shot.device}`);
    stored.push(await listings.putAsset(platform, 'screenshot', fs.readFileSync(path.join(out, shot.file)), { device: shot.device, position: shot.position, source: 'build_capture', buildId }));
  }
  return stored;
}

function main(argv) {
  const [command, ...rest] = argv;
  const all = (name) => rest.flatMap((value, i) => (rest[i - 1] === name ? [value] : []));
  const one = (name) => all(name)[0];
  if (command === 'stamp') {
    const stamp = stampOf({ platform: one('--platform'), appId: one('--app-id'), buildFile: one('--build'), device: one('--device') ?? '' });
    fs.writeFileSync(path.join(one('--out'), 'capture.json'), `${JSON.stringify(stamp, null, 2)}\n`);
    console.log(`listing-shots: stamped ${one('--out')}`);
    return Promise.resolve(0);
  }
  if (command === 'fit') {
    const platform = one('--platform');
    const devices = all('--device');
    return fitCaptures({ captures: one('--captures'), build: one('--build'), platform, out: one('--out'), ...(devices.length ? { devices } : {}) }).then((result) => {
      console.log(`listing-shots: ${result.shots.length} images, ${result.ok ? 'all within the store specs' : 'problems'}`);
      for (const problem of result.problems) console.error(`listing-shots: ${problem}`);
      return result.ok ? 0 : 1;
    });
  }
  console.error('Usage: node tools/listing-shots/index.mjs fit --platform android|ios --captures <dir> --build <file> --out <dir> [--device name]...\n       node tools/listing-shots/index.mjs stamp --platform p --app-id id --build <file> --device name --out <dir>');
  return Promise.resolve(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(`listing-shots: ${error.message}`); process.exitCode = 1; });
}

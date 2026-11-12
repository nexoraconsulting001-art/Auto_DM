/**
 * Step 3, generate assets: every image a build takes, checked against the current store spec (ASSET_SPECS, P-34). A failure
 * stops the run with the spec's own message and the field it belongs to.
 *
 *   from a file         the five images beside the brand file are measured and checked as they are
 *   from the database   the icon and splash sources become the five images. Filled by the pipeline track through
 *                       `options.generateAssets(state)`, which answers { assets: { icon, adaptiveForeground, ... }, fonts } as paths.
 *
 * Fonts: any .ttf or .otf in a `fonts` folder beside the images is built into the app; with none the app uses the system font.
 *
 * In:  state.brand.assets, state.sourceDir
 * Out: { assets: { <key>: absolute path }, fonts: [absolute paths] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkAsset } from '../../../src/contracts/apps.js';
import { BuildBrandError, notBuilt } from '../errors.mjs';

export const name = 'assets';

/** Each image of a brand file, the spec it is held to, and the brand-kit field a failure names. */
export const BRAND_ASSETS = Object.freeze({
  icon: Object.freeze({ spec: 'icon_ios', field: 'icon' }),
  adaptiveForeground: Object.freeze({ spec: 'adaptive_foreground', field: 'icon' }),
  adaptiveBackground: Object.freeze({ spec: 'adaptive_background', field: 'icon' }),
  notificationIcon: Object.freeze({ spec: 'notification_icon', field: 'icon' }),
  splash: Object.freeze({ spec: 'splash', field: 'splash' }),
});

const MIMES = { png: 'image/png', jpeg: 'image/jpeg' };

/** Width, height, type, transparency and whether it is one colour. The image library is loaded here, so reading a brand needs none. */
export async function measure(file) {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(file).metadata();
  const stats = await sharp(file).stats();
  // One colour means every pixel that shows is the same colour; what a transparent pixel holds does not count. Only small
  // images are held to it (the notification icon), so only those are read pixel by pixel.
  let monochrome;
  if (meta.width <= 512 && meta.height <= 512) {
    const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const low = [255, 255, 255];
    const high = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        if (data[i + c] < low[c]) low[c] = data[i + c];
        if (data[i + c] > high[c]) high[c] = data[i + c];
      }
    }
    monochrome = low.every((value, c) => high[c] - value <= 8);
  }
  return {
    width: meta.width,
    height: meta.height,
    mime: MIMES[meta.format] ?? `image/${meta.format}`,
    hasAlpha: Boolean(meta.hasAlpha) && !stats.isOpaque,
    bytes: fs.statSync(file).size,
    monochrome,
  };
}

export async function run(state, { options }) {
  if (!state.brand) {
    if (typeof options.generateAssets !== 'function') throw notBuilt(name, 'Making the app’s images from a brand kit');
    return options.generateAssets(state);
  }
  const assets = {};
  for (const [key, { spec, field }] of Object.entries(BRAND_ASSETS)) {
    const file = path.join(state.sourceDir, state.brand.assets[key]);
    if (!fs.existsSync(file)) throw new BuildBrandError({ step: name, code: 'missing_image', field, message: `The image ${state.brand.assets[key]} is not beside the brand file.` });
    const problems = checkAsset(spec, await measure(file));
    if (problems.length) throw new BuildBrandError({ step: name, code: problems[0].code, field, message: problems[0].message, problems: problems.map((p) => ({ ...p, field, platform: null })) });
    assets[key] = file;
  }
  const fontDir = path.join(state.sourceDir, 'fonts');
  const fonts = fs.existsSync(fontDir) ? fs.readdirSync(fontDir).filter((f) => /\.(ttf|otf)$/i.test(f)).sort().map((f) => path.join(fontDir, f)) : [];
  return { assets, fonts };
}

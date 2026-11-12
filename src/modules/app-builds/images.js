import sharp from 'sharp';
import { checkAsset } from '../../contracts/apps.js';

/**
 * The images of one brand's build, made with sharp from the seller's own icon (and splash, when there is one), each held to
 * the stores' current spec (ASSET_SPECS in src/contracts/apps.js) before a build may use it (P-34, P-55):
 *
 *   icon                1024 x 1024 PNG, no transparency (the App Store icon and the app's own icon): the icon flattened on
 *                       the brand's ground colour
 *   iconPlay            512 x 512 PNG, at most 1 MB (Google Play)
 *   adaptiveForeground  1024 x 1024 PNG, the icon inside the middle 66%, transparent around it
 *   adaptiveBackground  1024 x 1024 PNG, one solid colour
 *   notificationIcon    96 x 96 PNG, one colour on transparent: the icon's own shape in white, or a white disc when it has none
 *   splash              1024 x 1024 PNG, the splash image (or the icon) centred on transparent
 *   featureGraphic      1024 x 500 PNG, no transparency (Google Play): the icon on the brand's colour, no text
 *
 * Inputs are only ever decoded here, never passed on as they came: the output is always a PNG this code encoded.
 */

const LIMIT = { limitInputPixels: 50_000_000, failOn: 'error' };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const MIMES = { png: 'image/png', jpeg: 'image/jpeg' };
/** A white disc on transparent: the notification icon of an icon with no shape of its own. A constant, never seller text. */
const DISC = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="40" fill="#FFFFFF"/></svg>');

/** Each generated image, the ASSET_SPECS key it is held to, and the app-config field a failure names. */
export const GENERATED = Object.freeze({
  icon: Object.freeze({ spec: 'icon_ios', field: 'iconMediaId' }),
  iconPlay: Object.freeze({ spec: 'icon_play', field: 'iconMediaId' }),
  adaptiveForeground: Object.freeze({ spec: 'adaptive_foreground', field: 'iconMediaId' }),
  adaptiveBackground: Object.freeze({ spec: 'adaptive_background', field: 'iconMediaId' }),
  notificationIcon: Object.freeze({ spec: 'notification_icon', field: 'iconMediaId' }),
  splash: Object.freeze({ spec: 'splash', field: 'splashMediaId' }),
  featureGraphic: Object.freeze({ spec: 'feature_graphic', field: 'iconMediaId' }),
});

/** Width, height, type, transparency, size and (for small images) whether every pixel that shows is one colour. */
export async function measureImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('empty image');
  const image = sharp(buffer, LIMIT);
  const meta = await image.metadata();
  const stats = await sharp(buffer, LIMIT).stats();
  let monochrome;
  if (meta.width <= 512 && meta.height <= 512) {
    const { data } = await sharp(buffer, LIMIT).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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
    bytes: buffer.length,
    monochrome,
  };
}

const rgb = (hex, fallback = '#FFFFFF') => {
  const value = /^#[0-9A-Fa-f]{6}$/.test(String(hex)) ? hex : fallback;
  return { r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16), alpha: 1 };
};
const opaque = async (buffer) => sharp(buffer).removeAlpha().png({ compressionLevel: 9 }).toBuffer();

async function notificationIcon(square) {
  const { isOpaque } = await sharp(square).stats();
  if (isOpaque) return sharp(DISC).resize(96, 96).ensureAlpha().png().toBuffer();
  const alpha = await sharp(square).resize(96, 96).ensureAlpha().extractChannel(3).png().toBuffer();
  return sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 255, g: 255, b: 255 } } }).joinChannel(alpha).png().toBuffer();
}

async function centred(source, { width, height, inner }) {
  const fitted = await sharp(source).resize(inner, inner, { fit: 'contain', background: TRANSPARENT }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: TRANSPARENT } }).composite([{ input: fitted, gravity: 'center' }]).png().toBuffer();
}

/**
 * Every image of a build, as PNG buffers. `icon` is the seller's icon (already checked against source_icon), `splash` their
 * splash image or null, `ground` the colour the store icon is flattened on, `background` the adaptive background's and the
 * feature graphic's colour.
 */
export async function generateBrandImages({ icon, splash = null, ground = '#FFFFFF', background = '#FFFFFF' }) {
  const square = await sharp(icon, LIMIT).rotate().resize(1024, 1024, { fit: 'cover' }).ensureAlpha().png().toBuffer();
  const flat = await opaque(await sharp(square).flatten({ background: rgb(ground) }).png().toBuffer());
  const iconPlay = await opaque(await sharp(flat).resize(512, 512).png().toBuffer());
  const inner = await sharp(square).resize(676, 676).png().toBuffer();
  const adaptiveForeground = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: TRANSPARENT } }).composite([{ input: inner, gravity: 'center' }]).png().toBuffer();
  const adaptiveBackground = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: rgb(background) } }).png().toBuffer();
  const splashImage = splash
    ? await centred(await sharp(splash, LIMIT).rotate().png().toBuffer(), { width: 1024, height: 1024, inner: 1024 })
    : await centred(square, { width: 1024, height: 1024, inner: 512 });
  const badge = await sharp(flat).resize(300, 300).png().toBuffer();
  const featureGraphic = await opaque(await sharp({ create: { width: 1024, height: 500, channels: 3, background: rgb(background) } }).composite([{ input: badge, gravity: 'center' }]).png().toBuffer());
  return { icon: flat, iconPlay, adaptiveForeground, adaptiveBackground, notificationIcon: await notificationIcon(square), splash: splashImage, featureGraphic };
}

/** Each generated image's problems against its spec: [{ key, field, spec, code, message }], [] when every one passes. */
export async function checkGenerated(images) {
  const problems = [];
  for (const [key, { spec, field }] of Object.entries(GENERATED)) {
    if (!images[key]) {
      problems.push({ key, field, spec, code: 'missing_image', message: 'An image of the app could not be made.' });
      continue;
    }
    for (const p of checkAsset(spec, await measureImage(images[key]))) problems.push({ key, field, spec, ...p });
  }
  return problems;
}

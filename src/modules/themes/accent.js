import { contrastRatio, isHexColor } from '../brand/theme.js';

/**
 * The accent tuned from a logo (PRD 5.19): the logo's main colour becomes the preset's accent, and one that text can't be read
 * on is darkened until it passes 4.5:1 (F-104). Pure functions over pixels and colours; reading the image is in api.js.
 */

export const MIN_CONTRAST = 4.5;
const WHITE = '#FFFFFF';
const BLACK = '#000000';

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** `amount` of the way from `a` to `b`, 0 to 1. */
export function mix(a, b, amount) {
  const [ca, cb] = [channels(a), channels(b)];
  return toHex(ca.map((c, i) => c + (cb[i] - c) * amount));
}

function saturationAndLightness(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  const spread = max - min;
  const saturation = spread === 0 ? 0 : spread / (1 - Math.abs(2 * lightness - 1));
  return { saturation, lightness };
}

/**
 * The main colour of an image, from raw RGBA pixels: the most common colourful one, as #RRGGBB. Transparent, near-white,
 * near-black and grey pixels are background and ink, not brand, so they are skipped. Null when the image has no colour to speak
 * of (a black and white logo), which leaves the preset's own accent in place.
 */
export function dominantColor(pixels, { channels: perPixel = 4 } = {}) {
  const buckets = new Map();
  let opaque = 0;
  let colourful = 0;
  for (let i = 0; i + perPixel <= pixels.length; i += perPixel) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (perPixel === 4 && pixels[i + 3] < 128) continue;
    opaque++;
    const { saturation, lightness } = saturationAndLightness(r, g, b);
    if (saturation < 0.25 || lightness < 0.12 || lightness > 0.9) continue;
    colourful++;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bucket = buckets.get(key) ?? { weight: 0, r: 0, g: 0, b: 0, n: 0 };
    bucket.weight += 0.5 + saturation;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n++;
    buckets.set(key, bucket);
  }
  if (!opaque || colourful / opaque < 0.03) return null;
  const best = [...buckets.values()].reduce((a, b) => (b.weight > a.weight ? b : a));
  return toHex([best.r / best.n, best.g / best.n, best.b / best.n]);
}

const isDark = (hex) => contrastRatio(hex, BLACK) < 4;

/**
 * The accent pair a preset uses for `color`: { accent, on_accent, changed }. Text on the accent must reach 4.5:1. On a light
 * preset a colour that fails with the preset's own text is darkened, with white text, until it passes. On a dark preset the
 * accent is also what prices and highlights are written in, so it is lightened until it reads on the dark ground, with the
 * preset's dark text on it. `changed` says the logo's colour had to move.
 */
export function tuneAccent(color, preset) {
  if (!isHexColor(color)) return null;
  const start = color.toUpperCase();
  if (isDark(preset.ground)) {
    let accent = start;
    for (let step = 0; step < 40 && contrastRatio(accent, preset.ground) < MIN_CONTRAST; step++) accent = mix(accent, WHITE, 0.08);
    const onAccent = [preset.on_accent, preset.ground, BLACK].find((c) => isHexColor(c) && contrastRatio(accent, c) >= MIN_CONTRAST);
    return onAccent ? { accent, on_accent: onAccent.toUpperCase(), changed: accent !== start } : null;
  }
  if (isHexColor(preset.on_accent) && contrastRatio(start, preset.on_accent) >= MIN_CONTRAST) return { accent: start, on_accent: preset.on_accent.toUpperCase(), changed: false };
  let accent = start;
  for (let step = 0; step < 40 && contrastRatio(accent, WHITE) < MIN_CONTRAST; step++) accent = mix(accent, BLACK, 0.06);
  return { accent, on_accent: WHITE, changed: accent !== start };
}

/** Black or white, whichever reads better on `background`. */
export const readableOn = (background) => (contrastRatio(background, BLACK) >= contrastRatio(background, WHITE) ? BLACK : WHITE);

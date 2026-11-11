/**
 * Draws the owner app's icons from the platform's mark: `node apps/owner/assets/make-icons.mjs`. The PNGs are
 * committed, so a build never needs this; run it again only when the mark changes.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAG = 'M8 12a4 4 0 0 1 4-4h22.3a4 4 0 0 1 2.9 1.2l19.6 19.6a4 4 0 0 1 0 5.7L34.5 56.8a4 4 0 0 1-5.7 0L9.2 37.2A4 4 0 0 1 8 34.3z';
const BUBBLE = 'M18.5 13.5h8.5a5 5 0 0 1 5 5v4.5a5 5 0 0 1-5 5h-5.5l-5 5v-5.1a5 5 0 0 1-3-4.9v-4.5a5 5 0 0 1 5-5z';

/** The mark on a square canvas; `fill` is how much of the canvas it takes. */
function mark({ size, fill, background = null, tag = '#3B2FC9', bubble = '#F5B83D' }) {
  const scale = (size * fill) / 52;
  const offset = (size - 52 * scale) / 2 - 7 * scale;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      (background ? `<rect width="100%" height="100%" fill="${background}"/>` : '') +
      `<g transform="translate(${offset} ${offset}) scale(${scale})"><path fill="${tag}" d="${TAG}"/>${bubble ? `<path fill="${bubble}" d="${BUBBLE}"/>` : ''}</g></svg>`,
  );
}

const out = (name) => path.join(here, name);
await sharp(mark({ size: 1024, fill: 0.56, background: '#F6F5F1' })).flatten({ background: '#F6F5F1' }).png().toFile(out('icon.png'));
await sharp(mark({ size: 1024, fill: 0.42 })).png().toFile(out('adaptive-foreground.png'));
await sharp(mark({ size: 1024, fill: 0.42, tag: '#FFFFFF', bubble: null })).png().toFile(out('adaptive-monochrome.png'));
await sharp(mark({ size: 512, fill: 0.8 })).png().toFile(out('splash.png'));
await sharp(mark({ size: 96, fill: 0.8, tag: '#FFFFFF', bubble: null })).png().toFile(out('notification.png'));
console.log('icons written to', here);

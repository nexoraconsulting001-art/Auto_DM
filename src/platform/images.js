import { sniffImageType } from './safe-fetch.js';

/**
 * Images from outside (imported product photos, logos) and the share previews pages need (PRD 8.3, 8.12). sharp is the library:
 * it ships prebuilt for Linux arm64 (the QA server is an Oracle Arm VM), x64, macOS and Windows, so nothing is compiled.
 *
 * Nothing is stored as it arrived. ingest() decodes, turns the photo upright, drops every bit of metadata (camera, place) and
 * writes a fresh file no larger than it needs to be, so a file that is also a script or a page can't be served back from a
 * seller's address. Store the result with repos.media.save(buffer, contentType), which keeps it in the storage module.
 *
 *   const { buffer, contentType, width, height } = await platform.images.ingest(bytes);
 *   const preview = await platform.images.sharePreview({ image: bytes, background: '#FBF6EE' });
 */

export const IMAGE_LIMITS = Object.freeze({
  /** Accepted input types. SVG is not one: product photos have no business being scripts. */
  types: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  /** Decoding stops past this many pixels, so a small file that unpacks to a huge picture can't exhaust memory. */
  maxInputPixels: 40_000_000,
  /** The long edge of a stored product image. */
  maxEdge: 2000,
  /** A share preview (8.12): 1200 x 630, above the 1080 px Meta wants on the long edge. */
  share: Object.freeze({ width: 1200, height: 630 }),
});

export class ImageError extends Error {
  constructor(message = 'That file isn’t an image we can use') {
    super(message);
    this.name = 'ImageError';
    this.code = 'bad_image';
  }
}

let sharpPromise;
const loadSharp = () => (sharpPromise ??= import('sharp').then((m) => m.default));

const HEX = /^#[0-9a-f]{6}$/i;

export function createImages() {
  async function open(buffer) {
    const type = sniffImageType(buffer);
    if (!type || !IMAGE_LIMITS.types.includes(type)) throw new ImageError();
    const sharp = await loadSharp();
    const image = sharp(buffer, { limitInputPixels: IMAGE_LIMITS.maxInputPixels, failOn: 'error', animated: false });
    let meta;
    try {
      meta = await image.metadata();
    } catch {
      throw new ImageError();
    }
    if (!meta.width || !meta.height) throw new ImageError();
    return { sharp, image, type, meta };
  }

  return {
    driver: 'sharp',

    /** What the bytes are, without changing them: { type, width, height }. Throws ImageError for anything else. */
    async inspect(buffer) {
      const { type, meta } = await open(buffer);
      return { type, width: meta.width, height: meta.height };
    },

    /** A clean copy to store: upright, no metadata, at most maxEdge on its long side, as WebP (or JPEG). */
    async ingest(buffer, { maxEdge = IMAGE_LIMITS.maxEdge, format = 'webp' } = {}) {
      const { image } = await open(buffer);
      let out;
      try {
        const pipeline = image.rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
        out = format === 'jpeg'
          ? await pipeline.flatten({ background: '#FFFFFF' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true })
          : await pipeline.webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
      } catch {
        throw new ImageError();
      }
      return { buffer: out.data, contentType: format === 'jpeg' ? 'image/jpeg' : 'image/webp', width: out.info.width, height: out.info.height };
    },

    /**
     * A share preview: the image centred on the brand's ground colour at 1200 x 630, as JPEG (every crawler reads it). With no
     * image it is the plain ground colour, which still gives the crawler a sized image.
     */
    async sharePreview({ image = null, background = '#FFFFFF', width = IMAGE_LIMITS.share.width, height = IMAGE_LIMITS.share.height } = {}) {
      const sharp = await loadSharp();
      const ground = HEX.test(background) ? background : '#FFFFFF';
      const layers = [];
      if (image) {
        const { image: source } = await open(image);
        const fitted = await source.rotate().resize({ width, height, fit: 'contain', background: ground }).toBuffer();
        layers.push({ input: fitted, gravity: 'centre' });
      }
      const data = await sharp({ create: { width, height, channels: 3, background: ground } })
        .composite(layers)
        .jpeg({ quality: 84, mozjpeg: true })
        .toBuffer();
      return { buffer: data, contentType: 'image/jpeg', width, height };
    },
  };
}

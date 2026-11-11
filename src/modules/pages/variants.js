import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';

/**
 * Sized copies of a business's own images, for buyer pages on a phone (PRD 8.12). A product photo can be 2000 px wide and a
 * card shows it at 96: sending the original would spend the shopper's first seconds on pictures they can't see the detail
 * of. /media/<id>/<variant> answers a WebP no wider than the variant needs, made once and kept in the storage module beside
 * the original. Only the three sizes below exist, so nobody can ask for work by inventing sizes, and an image that can't be
 * resized is sent as it is.
 */
export const IMAGE_VARIANTS = Object.freeze({ hero: 640, card: 240, tile: 160 });

const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_PATH = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const HEADERS = Object.freeze({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });

const variantKey = (id, variant) => `t/${tenantId()}/variants/${id.toLowerCase()}-${variant}`;

/** The address of an image at the size a page shows it: one of this business's uploads gets its variant, anything else is unchanged. */
export function sized(url, variant) {
  const own = MEDIA_PATH.exec(String(url ?? ''));
  return own && Object.hasOwn(IMAGE_VARIANTS, variant) ? `/media/${own[1]}/${variant}` : String(url ?? '');
}

/** Forgets the sized copies of an image that has been deleted. */
export async function removeVariants(storage, id) {
  for (const variant of Object.keys(IMAGE_VARIANTS)) await storage.remove(variantKey(String(id), variant)).catch(() => {});
}

export function mountImageVariants(app, { repos, platform }) {
  const making = new Map();

  app.get('/media/:id/:variant', async (req, res) => {
    const { id, variant } = req.params;
    if (!MEDIA_ID.test(id) || !Object.hasOwn(IMAGE_VARIANTS, variant)) return res.sendStatus(404);
    // The file must still be this business's own: a deleted image's copies are never served.
    if (!(await repos.landingPages.ownMedia(id))) return res.sendStatus(404);
    const key = variantKey(id, variant);
    let data = await platform.storage.get(key);
    if (!data) {
      if (!making.has(key)) {
        making.set(key, (async () => {
          const original = await repos.media.get(id);
          if (!original) return null;
          try {
            const small = await platform.images.ingest(original.data, { maxEdge: IMAGE_VARIANTS[variant] });
            await platform.storage.put(key, small.buffer, small.contentType);
            return { data: small.buffer, type: small.contentType };
          } catch (err) {
            // An image that can't be resized (not a picture after all, or the image library is unavailable) goes out as it is.
            if (err?.code !== 'bad_image') log.warn('page.image_variant_failed', { variant, code: err?.code ?? 'error' });
            return { data: original.data, type: original.mime };
          }
        })().finally(() => making.delete(key)));
      }
      const made = await making.get(key);
      if (!made) return res.sendStatus(404);
      return res.set(HEADERS).type(made.type).send(made.data);
    }
    return res.set(HEADERS).type('image/webp').send(data);
  });
}

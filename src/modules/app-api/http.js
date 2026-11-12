import { ApiError } from '../../contracts/api/errors.js';
import { tenantId } from '../../tenancy.js';
import { LIVE_PRODUCT_SQL, tileImage, tileTitle } from '../categories/repo.js';
import { sendStoreError } from '../storefront/http.js';
import { hidden } from './gate.js';

/**
 * What the app's JSON routes share: the wrapper every one runs in, and the cards they answer with. Everything here is the
 * seller's catalog in the seller's words: no platform name, and every amount is the database's, in paise.
 */

/**
 * A JSON route of the app. handler(req, res) returns { status?, body }. A request that did not come through the gate as the
 * app (no X-App header) is a 404 with no body: these routes are the app's only. Answers are never cached.
 */
export const appCall = (handler) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.appRequest) return hidden(res);
  try {
    const out = await handler(req, res);
    if (out) res.status(out.status ?? 200).json(out.body);
  } catch (err) {
    sendStoreError(err, req, res);
  }
};

export const notFound = (message = 'We couldn’t find that.') => new ApiError('not_found', message);

/** A whole number cursor (a page or an offset), or the default. */
export function cursorNumber(cursor, fallback) {
  if (cursor === undefined || cursor === null || cursor === '') return fallback;
  const n = /^[0-9]{1,9}$/.test(String(cursor)) ? Number(cursor) : NaN;
  if (!Number.isSafeInteger(n)) throw new ApiError('validation_failed', 'Invalid cursor', { fields: { cursor: 'Invalid cursor' } });
  return n;
}

const imageText = (value) => (typeof value === 'string' ? value : typeof value?.url === 'string' ? value.url : '');

/** Approved ratings of these products: Map(id -> { rating, ratingCount }). */
export async function ratingsOf(db, productIds) {
  const ids = [...new Set(productIds)].filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT product_id, round(avg(rating)::numeric, 1)::float AS rating, count(*)::int AS n FROM reviews
     WHERE tenant_id = $1 AND product_id = ANY($2::int[]) AND status = 'approved' GROUP BY product_id`,
    [tenantId(), ids],
  );
  return new Map(rows.map((r) => [r.product_id, { rating: r.rating, ratingCount: r.n }]));
}

/** A product card from a storefront catalog row (storeCatalog in src/modules/storefront/catalog.js). */
export function productCard(row, ratings = new Map()) {
  const price = row.price ?? { pricePaise: Number(row.price_paise), mrpPaise: row.mrp_paise === null ? null : Number(row.mrp_paise), soldOut: !row.in_stock };
  const rating = ratings.get(row.id);
  return {
    id: row.id, slug: row.slug ?? '', name: row.name ?? '', pricePaise: Number(price.pricePaise),
    comparePaise: price.mrpPaise !== null && price.mrpPaise !== undefined && Number(price.mrpPaise) > Number(price.pricePaise) ? Number(price.mrpPaise) : null,
    image: row.image ?? imageText(Array.isArray(row.images) ? row.images[0] : null),
    inStock: !price.soldOut, rating: rating?.rating ?? null, ratingCount: rating?.ratingCount ?? 0,
  };
}

/** Cards for catalog rows, with their ratings. */
export async function productCards(db, rows) {
  const ratings = await ratingsOf(db, rows.map((r) => r.id));
  return rows.map((row) => productCard(row, ratings));
}

/** Live products per reel (by its Instagram media id): Map(media id -> count). */
async function productCounts(db, mediaIds) {
  const ids = [...new Set(mediaIds)].filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT rp.reel_id, count(*)::int AS n FROM reel_products rp JOIN products p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
     WHERE rp.tenant_id = $1 AND rp.reel_id = ANY($2::text[]) AND ${LIVE_PRODUCT_SQL} GROUP BY rp.reel_id`,
    [tenantId(), ids],
  );
  return new Map(rows.map((r) => [r.reel_id, r.n]));
}

/** Reel cards for rows read with PAGE_COLS (src/modules/categories/repo.js). `pinned` is the row's own flag in a category. */
export async function reelCards(db, rows, { now = new Date() } = {}) {
  const counts = await productCounts(db, rows.map((r) => r.ig_media_id));
  return rows.map((row) => {
    const expiredStory = row.kind === 'story' && row.expires_at && new Date(row.expires_at) <= now;
    return {
      slug: row.slug, title: tileTitle(row), image: tileImage(row, now),
      videoUrl: !expiredStory && row.media_type === 'VIDEO' && row.media_url ? row.media_url : null,
      pinned: Boolean(row.pinned), productCount: counts.get(row.ig_media_id) ?? 0,
    };
  });
}

export const categoryCard = (row) => ({ slug: row.slug, name: row.name, image: row.image_url ?? '' });

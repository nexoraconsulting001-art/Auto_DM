import { tenantId } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';

/**
 * Ratings and reviews (PRD 9.19), this business's rows only: reviews, review_photos and product_ratings (migration 412).
 *
 * Who may write one: a signed-in shopper whose order of that product was delivered. The order is theirs when it carries
 * their shopper id, or when it was placed as a guest with the phone number they have proved with a code. One review per
 * product per order: the database's key. The seller approves, hides and replies; nobody can change a shopper's words.
 *
 * product_ratings holds the count and the sum of approved reviews, changed in the same transaction as the review's status,
 * so a product page never counts as it loads and an approval made twice counts once (S-82).
 */
export const REVIEWS_FEATURE = 'store.reviews';
export const OPEN_REVIEW_LIMIT = Object.freeze({ limit: 20, windowMs: 3_600_000 });

/** The digits a phone number is compared by: an Indian mobile with or without +91 is the same number. */
export function phoneDigits(phone) {
  const d = String(phone ?? '').replace(/[^0-9]/g, '');
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d;
}

/** The name shown beside a review: a first name of at most 40 characters, never a number. */
export function firstName(...names) {
  for (const name of names) {
    const first = String(name ?? '').trim().split(/\s+/)[0] ?? '';
    if (first && !/[0-9@]/.test(first)) return first.slice(0, 40);
  }
  return '';
}

const toReview = (row, photos = []) => ({
  id: row.id,
  productId: row.product_id,
  productName: row.product_name ?? '',
  orderId: row.order_id,
  rating: row.rating,
  body: row.body,
  displayName: row.display_name,
  photos,
  status: row.status,
  reply: row.reply,
  repliedAt: row.replied_at,
  createdAt: row.created_at,
});

/** What a shopper may see of a review: no order, no shopper, no status. */
export const toPublicReview = (row, photos = []) => ({
  id: row.id,
  rating: row.rating,
  body: row.body,
  displayName: row.display_name,
  photos,
  reply: row.reply,
  repliedAt: row.replied_at,
  createdAt: row.created_at,
});

export class ReviewRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReviewRefused';
    this.code = code; // 'not_eligible' | 'duplicate'
  }
}

const SELECT_REVIEW = `SELECT r.*, p.name AS product_name FROM reviews r JOIN products p ON p.tenant_id = r.tenant_id AND p.id = r.product_id`;

export function reviewsRepo(db) {
  async function photosOf(q, ids) {
    if (!ids.length) return new Map();
    const rows = await q.query('SELECT review_id, media_id FROM review_photos WHERE tenant_id = $1 AND review_id = ANY($2::int[]) ORDER BY review_id, position', [tenantId(), ids]);
    const out = new Map();
    for (const r of rows) out.set(r.review_id, [...(out.get(r.review_id) ?? []), `/media/${r.media_id}`]);
    return out;
  }
  const withPhotos = async (q, rows, shape) => {
    const photos = await photosOf(q, rows.map((r) => r.id));
    return rows.map((r) => shape(r, photos.get(r.id) ?? []));
  };

  /** The order by its number, if it is this shopper's: their id on it, or a guest order with the phone they proved. */
  async function shoppersOrder(q, shopper, orderNumber) {
    const [order] = await q.query(
      'SELECT id, order_number, shopper_id, phone, customer_name, fulfilment_status FROM orders WHERE tenant_id = $1 AND order_number = $2',
      [tenantId(), String(orderNumber).slice(0, 40)],
    );
    if (!order) return null;
    if (order.shopper_id === shopper.id) return order;
    const mine = order.shopper_id === null && shopper.phoneVerified && shopper.phone && phoneDigits(order.phone) === phoneDigits(shopper.phone);
    return mine ? order : null;
  }

  /** Orders of this product the shopper received and hasn't reviewed yet, newest first: what the review form offers. */
  async function reviewable(shopper, productId) {
    const rows = await db.query(
      `SELECT o.order_number FROM orders o
       WHERE o.tenant_id = $1 AND o.fulfilment_status = 'delivered'
         AND (o.shopper_id = $2 OR (o.shopper_id IS NULL AND $4::boolean AND regexp_replace(o.phone, '[^0-9]', '', 'g') IN ($5, '91' || $5)))
         AND EXISTS (SELECT 1 FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id AND i.product_id = $3)
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.tenant_id = o.tenant_id AND r.order_id = o.id AND r.product_id = $3)
       ORDER BY o.delivered_at DESC NULLS LAST, o.id DESC LIMIT 5`,
      [tenantId(), shopper.id, productId, Boolean(shopper.phoneVerified && shopper.phone), phoneDigits(shopper.phone) || '-'],
    );
    return rows.map((r) => r.order_number);
  }

  /** The delivered order of this product the shopper may review, or null. */
  async function eligibleOrder(q, shopper, { orderNumber, productId }) {
    const order = await shoppersOrder(q, shopper, orderNumber);
    if (!order || order.fulfilment_status !== 'delivered') return null;
    const [line] = await q.query('SELECT 1 FROM order_items WHERE tenant_id = $1 AND order_id = $2 AND product_id = $3 LIMIT 1', [tenantId(), order.id, productId]);
    return line ? order : null;
  }

  /** Whether the shopper may write this review now: 'ok', 'not_eligible' or 'duplicate' (checked again when it is written). */
  async function mayReview(shopper, { orderNumber, productId }) {
    const order = await eligibleOrder(db, shopper, { orderNumber, productId });
    if (!order) return 'not_eligible';
    const [done] = await db.query('SELECT 1 FROM reviews WHERE tenant_id = $1 AND order_id = $2 AND product_id = $3', [tenantId(), order.id, productId]);
    return done ? 'duplicate' : 'ok';
  }

  /**
   * A new review, waiting for the owner, with up to three photos already stored as this business's media.
   * Throws ReviewRefused when the shopper may not write it.
   */
  async function create(shopper, { orderNumber, productId, rating, body }, { mediaIds = [] } = {}) {
    return db.tx(async (t) => {
      const order = await eligibleOrder(t, shopper, { orderNumber, productId });
      if (!order) throw new ReviewRefused('not_eligible', 'You can review a product once it has been delivered to you.');
      const [me] = await t.query('SELECT name FROM shoppers WHERE tenant_id = $1 AND id = $2', [tenantId(), shopper.id]);
      const [row] = await t.query(
        `INSERT INTO reviews (tenant_id, product_id, order_id, shopper_id, rating, body, display_name) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, order_id, product_id) DO NOTHING RETURNING *`,
        [tenantId(), productId, order.id, shopper.id, rating, body, firstName(me?.name, order.customer_name)],
      );
      if (!row) throw new ReviewRefused('duplicate', 'You have already reviewed this product for this order.');
      for (const [position, mediaId] of mediaIds.slice(0, 3).entries()) {
        await t.query('INSERT INTO review_photos (tenant_id, review_id, position, media_id) VALUES ($1, $2, $3, $4)', [tenantId(), row.id, position, mediaId]);
      }
      return toPublicReview(row, mediaIds.slice(0, 3).map((id) => `/media/${id}`));
    });
  }

  async function get(id) {
    const [row] = await db.query(`${SELECT_REVIEW} WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId(), id]);
    return row ? (await withPhotos(db, [row], toReview))[0] : null;
  }

  /**
   * Approves or hides a review, with the product's count and sum in the same transaction. Asking for the status a review
   * already has changes nothing. Null when there is no such review here.
   */
  async function decide(id, status) {
    return db.tx(async (t) => {
      const [row] = await t.query('SELECT id, product_id, rating, status FROM reviews WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
      if (!row) return null;
      if (row.status !== status) {
        await t.query('UPDATE reviews SET status = $3, decided_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), id, status]);
        if (status === 'approved') {
          await t.query(
            `INSERT INTO product_ratings (tenant_id, product_id, review_count, rating_sum) VALUES ($1, $2, 1, $3)
             ON CONFLICT (tenant_id, product_id) DO UPDATE SET review_count = product_ratings.review_count + 1, rating_sum = product_ratings.rating_sum + $3, updated_at = now()`,
            [tenantId(), row.product_id, row.rating],
          );
        } else if (row.status === 'approved') {
          // Taken out: an UPDATE, as the row exists (an upsert's proposed row would be checked, and refused, first).
          await t.query(
            'UPDATE product_ratings SET review_count = review_count - 1, rating_sum = rating_sum - $3, updated_at = now() WHERE tenant_id = $1 AND product_id = $2',
            [tenantId(), row.product_id, row.rating],
          );
        }
      }
      return true;
    }).then((found) => (found ? get(id) : null));
  }

  /** The one public reply, replaced if written again. */
  async function reply(id, text) {
    const [row] = await db.query('UPDATE reviews SET reply = $3, replied_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING id', [tenantId(), id, text]);
    return row ? get(id) : null;
  }

  /** The admin's list, newest first. */
  async function list({ status = 'all', productId, cursor, limit }) {
    const after = cursor ? readCursor(cursor, (k) => k.length === 1 && Number.isSafeInteger(k[0]) && k[0] > 0)[0] : null;
    const rows = await db.query(
      `${SELECT_REVIEW} WHERE r.tenant_id = $1 AND ($2::text = 'all' OR r.status = $2) AND ($3::int IS NULL OR r.product_id = $3) AND ($4::int IS NULL OR r.id < $4)
       ORDER BY r.id DESC LIMIT $5`,
      [tenantId(), status, productId ?? null, after, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (r) => [r.id]);
    return { items: await withPhotos(db, page.items, toReview), nextCursor: page.nextCursor };
  }

  /** The product's average and count, from approved reviews only. */
  async function summary(productId) {
    const [row] = await db.query('SELECT review_count, rating_sum FROM product_ratings WHERE tenant_id = $1 AND product_id = $2', [tenantId(), productId]);
    const count = row?.review_count ?? 0;
    return { count, average: count ? Math.round((row.rating_sum / count) * 10) / 10 : null };
  }

  /** Approved reviews of a product, newest first, as a shopper sees them. */
  async function published(productId, { cursor, limit }) {
    const after = cursor ? readCursor(cursor, (k) => k.length === 1 && Number.isSafeInteger(k[0]) && k[0] > 0)[0] : null;
    const rows = await db.query(
      `SELECT id, rating, body, display_name, reply, replied_at, created_at FROM reviews
       WHERE tenant_id = $1 AND product_id = $2 AND status = 'approved' AND ($3::int IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
      [tenantId(), productId, after, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (r) => [r.id]);
    return { items: await withPhotos(db, page.items, toPublicReview), nextCursor: page.nextCursor };
  }

  /** A product shown on the store, by slug. */
  async function productBySlug(slug) {
    if (!/^[a-z0-9-]{1,80}$/.test(String(slug ?? ''))) return null;
    const [row] = await db.query(`SELECT id, name, slug FROM products WHERE tenant_id = $1 AND slug = $2 AND active`, [tenantId(), slug]);
    return row ?? null;
  }

  return { reviewable, mayReview, create, get, decide, reply, list, summary, published, productBySlug };
}

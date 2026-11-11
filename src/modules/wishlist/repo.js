import { displayPrice } from '../../contracts/catalog.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { tenantId } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';

/**
 * The wishlist's data (PRD 9.20): wishlist_items, one row per shopper and product of one business. A shopper sees only their
 * own rows; the owner sees only how many saved each product, never who (S-86). At most STORE_LIMITS.wishlistItems per
 * shopper, which the database also holds (migration 412).
 *
 *   items(shopperId)                       newest first, each with whether it can be bought now
 *   savedIds(shopperId)                    just the product ids, for the hearts
 *   change(shopperId, { add, remove })     -> { full }: only this business's products; a repeat is no change; past the cap is left out
 *   counts({ cursor, limit })              { items: [{ productId, name, saves }], nextCursor }, most saved first
 */
export const WISHLIST_FEATURE = 'store.wishlist';
const LIVE = `p.active AND p.fetch_status NOT IN ('broken', 'missing')`;
const imageOf = (row) => {
  const first = Array.isArray(row.images) ? row.images[0] : null;
  return typeof first === 'string' ? first : typeof first?.url === 'string' ? first.url : '';
};

/**
 * One saved product as the shopper sees it. `state` is ok, sold_out (it can't go in the bag) or inactive (the owner took it
 * off the store: shown as unavailable, never dropped, S-85). `needsOption` means the bag needs a size or colour first.
 */
export function toItem(row, variants = []) {
  const own = variants.map((v) => ({ ...v, in_stock: v.in_stock && (v.stock === null || Number(v.stock) - Number(v.reserved) > 0) }));
  const counted = row.in_stock && (row.stock === null || Number(row.stock) - Number(row.reserved) > 0);
  const price = displayPrice({ ...row, in_stock: counted }, own);
  // Options typed as plain text in the Phase 0 store have no variant to hold their stock, so checkout can't take them.
  const legacyOptions = !own.length && (row.option_values?.length ?? 0) > 0;
  const state = !row.live || legacyOptions ? 'inactive' : !row.in_stock || price.soldOut ? 'sold_out' : 'ok';
  return {
    productId: row.product_id,
    name: row.name,
    slug: row.slug,
    image: imageOf(row),
    pricePaise: state === 'inactive' ? null : price.pricePaise,
    mrpPaise: state === 'inactive' ? null : price.mrpPaise,
    state,
    available: state === 'ok',
    needsOption: own.length > 0,
    savedAt: row.created_at,
  };
}

export function wishlistRepo(db) {
  async function items(shopperId) {
    const rows = await db.query(
      `SELECT w.product_id, w.created_at, p.name, p.slug, p.images, p.price_paise, p.mrp_paise, p.in_stock, p.stock, p.reserved, p.option_values, (${LIVE}) AS live
       FROM wishlist_items w JOIN products p ON p.tenant_id = w.tenant_id AND p.id = w.product_id
       WHERE w.tenant_id = $1 AND w.shopper_id = $2 ORDER BY w.created_at DESC, w.product_id DESC`,
      [tenantId(), shopperId],
    );
    if (!rows.length) return [];
    const variants = await db.query(
      `SELECT product_id, price_paise, mrp_paise, in_stock, stock, reserved FROM product_variants
       WHERE tenant_id = $1 AND product_id = ANY($2::int[]) AND cardinality(option_values) > 0`,
      [tenantId(), rows.map((r) => r.product_id)],
    );
    const byProduct = new Map();
    for (const v of variants) byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), v]);
    return rows.map((row) => toItem(row, byProduct.get(row.product_id)));
  }

  async function savedIds(shopperId) {
    const rows = await db.query('SELECT product_id FROM wishlist_items WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY product_id', [tenantId(), shopperId]);
    return rows.map((r) => r.product_id);
  }

  async function change(shopperId, { add = [], remove = [] }) {
    const tid = tenantId();
    const dropped = new Set(remove);
    const wanted = [...new Set(add)].filter((id) => !dropped.has(id));
    try {
      return await db.tx(async (t) => {
        // One change at a time per shopper, so two tabs saving at once can't pass the cap between them.
        const [shopper] = await t.query('SELECT id FROM shoppers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, shopperId]);
        if (!shopper) return { full: false };
        if (dropped.size) await t.query('DELETE FROM wishlist_items WHERE tenant_id = $1 AND shopper_id = $2 AND product_id = ANY($3::int[])', [tid, shopperId, [...dropped]]);
        if (!wanted.length) return { full: false };
        const ours = new Set((await t.query('SELECT id FROM products WHERE tenant_id = $1 AND id = ANY($2::int[])', [tid, wanted])).map((r) => r.id));
        const have = new Set((await t.query('SELECT product_id FROM wishlist_items WHERE tenant_id = $1 AND shopper_id = $2', [tid, shopperId])).map((r) => r.product_id));
        const fresh = wanted.filter((id) => ours.has(id) && !have.has(id));
        const room = Math.max(0, STORE_LIMITS.wishlistItems - have.size);
        const take = fresh.slice(0, room);
        if (take.length) {
          await t.query(
            `INSERT INTO wishlist_items (tenant_id, shopper_id, product_id) SELECT $1, $2, x FROM unnest($3::int[]) AS x ON CONFLICT DO NOTHING`,
            [tid, shopperId, take],
          );
        }
        return { full: fresh.length > take.length };
      });
    } catch (err) {
      // The database's own cap (a write that went round this code): the wishlist is full, and nothing was added.
      if (err?.code === '23514' && String(err.constraint ?? err.message).includes('wishlist_items_cap')) return { full: true };
      throw err;
    }
  }

  async function counts({ cursor, limit }) {
    const after = cursor ? readCursor(cursor, (k) => k.length === 2 && k.every((v) => Number.isSafeInteger(v) && v >= 0)) : null;
    const rows = await db.query(
      `SELECT p.id, p.name, count(*)::int AS saves
       FROM wishlist_items w JOIN products p ON p.tenant_id = w.tenant_id AND p.id = w.product_id
       WHERE w.tenant_id = $1
       GROUP BY p.id, p.name
       HAVING $2::int IS NULL OR count(*) < $2 OR (count(*) = $2 AND p.id > $3)
       ORDER BY saves DESC, p.id ASC LIMIT $4`,
      [tenantId(), after?.[0] ?? null, after?.[1] ?? 0, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (r) => [r.saves, r.id]);
    return { items: page.items.map((r) => ({ productId: r.id, name: r.name, saves: r.saves })), nextCursor: page.nextCursor };
  }

  /** Product ids by slug, for the hearts on product cards. Only this business's products. */
  async function idsBySlug(slugs) {
    if (!slugs.length) return new Map();
    const rows = await db.query('SELECT id, slug FROM products WHERE tenant_id = $1 AND slug = ANY($2::text[])', [tenantId(), slugs]);
    return new Map(rows.map((r) => [r.slug, r.id]));
  }

  return { items, savedIds, change, counts, idsBySlug };
}

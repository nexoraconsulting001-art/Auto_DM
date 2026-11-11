import { displayPrice } from '../../contracts/catalog.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { tenantId } from '../../tenancy.js';
import { PRICE_BANDS } from '../../util.js';

/**
 * What the store's pages read from the catalog (PRD 9.1), this business's rows only. A product is shown when it is active,
 * its link isn't broken, and it is in no category or in at least one visible one: a product only in hidden categories is
 * hidden with them. Search matches the name, a tag or a variant's SKU (S-02), every word of it.
 */
export const PAGE_SIZE = 24;
export const MAX_PAGE = 50;

const SHOWN = `p.active AND p.fetch_status NOT IN ('broken', 'missing')
  AND (NOT EXISTS (SELECT 1 FROM product_categories pc WHERE pc.tenant_id = p.tenant_id AND pc.product_id = p.id)
       OR EXISTS (SELECT 1 FROM product_categories pc JOIN categories c ON c.tenant_id = pc.tenant_id AND c.id = pc.category_id
                  WHERE pc.tenant_id = p.tenant_id AND pc.product_id = p.id AND c.visible))`;

export const SORTS = Object.freeze({
  popular: { label: 'Popular', sql: 'p.featured DESC, p.id DESC' },
  newest: { label: 'Newest', sql: 'p.id DESC' },
  'price-asc': { label: 'Price: low to high', sql: 'p.price_paise ASC, p.id DESC' },
  'price-desc': { label: 'Price: high to low', sql: 'p.price_paise DESC, p.id DESC' },
  discount: { label: 'Biggest discount', sql: 'CASE WHEN p.mrp_paise > 0 THEN (p.mrp_paise - p.price_paise)::float / p.mrp_paise ELSE 0 END DESC, p.id DESC' },
});
export const sortOf = (value) => (typeof value === 'string' && Object.hasOwn(SORTS, value) ? value : 'popular');
export const bandOf = (value) => PRICE_BANDS.find((b) => b.key === value) ?? null;

/** At most five words of at most 40 characters, with control characters (a NUL among them) dropped. */
export function searchTerms(q) {
  return String(q ?? '').replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, STORE_LIMITS.searchQueryChars).split(/\s+/).filter(Boolean).slice(0, 5).map((w) => w.slice(0, 40));
}
const likeText = (term) => String(term).replace(/[\\%_]/g, (c) => `\\${c}`);

const COLS = `p.id, p.name, p.slug, p.price_paise, p.mrp_paise, p.in_stock, p.stock, p.reserved, p.images, p.featured, p.description, p.tags`;
const firstImage = (row) => {
  const first = Array.isArray(row.images) ? row.images[0] : null;
  return typeof first === 'string' ? first : '';
};

/** Each product's card price and whether anything of it can be bought, from its variants when it has options. */
async function withPrices(db, rows) {
  if (!rows.length) return [];
  const variants = await db.query(
    `SELECT id, product_id, option_values, price_paise, mrp_paise, in_stock, stock, reserved FROM product_variants
     WHERE tenant_id = $1 AND product_id = ANY($2::int[]) AND cardinality(option_values) > 0 ORDER BY position, id`,
    [tenantId(), rows.map((r) => r.id)],
  );
  const byProduct = new Map();
  for (const v of variants) byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), { ...v, in_stock: v.in_stock && (v.stock === null || v.stock - v.reserved > 0) }]);
  return rows.map((row) => {
    const own = byProduct.get(row.id) ?? [];
    const counted = row.in_stock && (row.stock === null || row.stock - row.reserved > 0);
    const price = displayPrice({ ...row, in_stock: counted }, own);
    return { ...row, image: firstImage(row), variants: own, price: { ...price, soldOut: !row.in_stock || price.soldOut } };
  });
}

function filters({ search = '', band = null, categoryId = null }, params) {
  const where = [SHOWN];
  const terms = searchTerms(search);
  if (terms.length) {
    params.push(terms.map(likeText));
    where.push(`(SELECT bool_and(p.name ILIKE '%' || term || '%' ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM unnest(p.tags) tag WHERE tag ILIKE '%' || term || '%' ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM product_variants v WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id AND v.sku ILIKE '%' || term || '%' ESCAPE '\\'))
      FROM unnest($${params.length}::text[]) term)`);
  }
  if (band?.max) {
    params.push(band.max);
    where.push(`p.price_paise < $${params.length}`);
  }
  if (band?.min) {
    params.push(band.min);
    where.push(`p.price_paise >= $${params.length}`);
  }
  if (categoryId) {
    params.push(categoryId);
    where.push(`EXISTS (SELECT 1 FROM product_categories pc WHERE pc.tenant_id = p.tenant_id AND pc.product_id = p.id AND pc.category_id = $${params.length})`);
  }
  return where.join(' AND ');
}

export function storeCatalog(db) {
  return {
    /** One page of shown products, and how many there are. `page` starts at 1. */
    async list({ search = '', band = null, categoryId = null, sort = 'popular', page = 1, limit = PAGE_SIZE } = {}) {
      const params = [tenantId()];
      const where = filters({ search, band, categoryId }, params);
      const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM products p WHERE p.tenant_id = $1 AND ${where}`, params);
      const at = Math.min(Math.max(1, Number(page) || 1), MAX_PAGE);
      const rows = await db.query(
        `SELECT ${COLS} FROM products p WHERE p.tenant_id = $1 AND ${where} ORDER BY ${SORTS[sortOf(sort)].sql} LIMIT ${Number(limit)} OFFSET ${(at - 1) * Number(limit)}`,
        params,
      );
      return { products: await withPrices(db, rows), total: n, page: at, pages: Math.min(MAX_PAGE, Math.max(1, Math.ceil(n / limit))) };
    },

    async featured(limit = 8) {
      const rows = await db.query(`SELECT ${COLS} FROM products p WHERE p.tenant_id = $1 AND ${SHOWN} ORDER BY p.featured DESC, p.id DESC LIMIT $2`, [tenantId(), limit]);
      return withPrices(db, rows);
    },

    /** A shown product by its slug, with its images, options and variants. Null for anything not shown. */
    async bySlug(slug) {
      const text = String(slug ?? '');
      if (!/^[a-z0-9-]{1,80}$/.test(text)) return null;
      const [row] = await db.query(`SELECT ${COLS}, p.option_values FROM products p WHERE p.tenant_id = $1 AND p.slug = $2 AND ${SHOWN}`, [tenantId(), text]);
      if (!row) return null;
      const [product] = await withPrices(db, [row]);
      const options = await db.query('SELECT name, "values" FROM product_options WHERE tenant_id = $1 AND product_id = $2 ORDER BY position', [tenantId(), row.id]);
      const [plain] = await db.query(`SELECT id, sku FROM product_variants WHERE tenant_id = $1 AND product_id = $2 AND cardinality(option_values) = 0 LIMIT 1`, [tenantId(), row.id]);
      return { ...product, options, plainVariantId: plain?.id ?? null, legacyOptions: product.variants.length === 0 && (row.option_values?.length ?? 0) > 0 };
    },

    /** Products sharing a category with this one, else the latest. */
    async related(product, limit = 4) {
      const rows = await db.query(
        `SELECT ${COLS} FROM products p WHERE p.tenant_id = $1 AND p.id <> $2 AND ${SHOWN}
         ORDER BY EXISTS (SELECT 1 FROM product_categories a JOIN product_categories b ON b.tenant_id = a.tenant_id AND b.category_id = a.category_id
                          WHERE a.tenant_id = p.tenant_id AND a.product_id = $2 AND b.product_id = p.id) DESC, p.featured DESC, p.id DESC LIMIT $3`,
        [tenantId(), product.id, limit],
      );
      return withPrices(db, rows);
    },

    /** For a bag that moved browsers (9.2): every id asked for comes back, an inactive one flagged rather than left out. */
    async lookup(ids) {
      const wanted = [...new Set(ids)].slice(0, STORE_LIMITS.maxCartLines);
      if (!wanted.length) return [];
      const rows = await db.query(`SELECT ${COLS}, (${SHOWN}) AS shown FROM products p WHERE p.tenant_id = $1 AND p.id = ANY($2::int[])`, [tenantId(), wanted]);
      const priced = await withPrices(db, rows.filter((r) => r.shown));
      const byId = new Map(priced.map((p) => [p.id, p]));
      return wanted.map((id) => {
        const p = byId.get(id);
        if (!p) return { id, active: false, name: '', slug: '', image: '', pricePaise: null, mrpPaise: null, soldOut: true, variants: [] };
        return {
          id, active: true, name: p.name, slug: p.slug, image: p.image, pricePaise: p.price.pricePaise, mrpPaise: p.price.mrpPaise, soldOut: p.price.soldOut,
          variants: p.variants.map((v) => ({ id: v.id, option: v.option_values.join(' / '), pricePaise: Number(v.price_paise), soldOut: !v.in_stock })),
        };
      });
    },

    /** Visible categories with at least one shown product, in the owner's order. */
    async categories() {
      return db.query(
        `SELECT c.id, c.name, c.slug, c.image_url FROM categories c WHERE c.tenant_id = $1 AND c.visible
           AND EXISTS (SELECT 1 FROM product_categories pc JOIN products p ON p.tenant_id = pc.tenant_id AND p.id = pc.product_id
                       WHERE pc.tenant_id = c.tenant_id AND pc.category_id = c.id AND ${SHOWN})
         ORDER BY c.position, c.id`,
        [tenantId()],
      );
    },

    /** A visible category by its slug; a hidden one is not found (S-03). */
    async category(slug) {
      const text = String(slug ?? '').toLowerCase();
      if (!/^[a-z0-9-]{1,80}$/.test(text)) return null;
      const [row] = await db.query('SELECT id, name, slug, description, image_url FROM categories WHERE tenant_id = $1 AND slug = $2 AND visible', [tenantId(), text]);
      return row ?? null;
    },
  };
}

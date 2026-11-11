import { CATALOG_LIMITS as L, IMPORT_REASONS, canonicalProductUrl, isProductSource } from '../../contracts/catalog.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError, slugify } from '../../util.js';
import { checkOptionsAndVariants, variantKey } from './rules.js';

/**
 * The catalog's tables (PRD 8.1, migration 300): products with their options, variants and images, and each business's
 * catalog settings. Every query names the current business, and every write to a child table goes through the product it
 * belongs to, so nothing here can reach another business's rows. Money is integer paise.
 *
 * The Phase 0 columns (images, option_label, option_values, stock) are still read by the Phase 0 store, so they are written
 * here alongside the Phase 3 tables: `images` stays the ordered list of links, and product_images mirrors it.
 */

const P_COLS = `p.id, p.name, p.slug, p.description, p.price_paise, p.mrp_paise, p.images, p.option_label, p.option_values, p.stock, p.active, p.featured,
  p.created_at, p.updated_at, p.external_url, p.in_stock, p.source, p.source_ref, p.fetch_status, p.fetched_at, p.next_check_at, p.check_failures,
  p.price_changed, p.previous_price_paise, p.price_manual, p.owner_edited, p.tags, p.whatsapp_order`;

const WRITABLE = Object.freeze([
  'name', 'slug', 'description', 'price_paise', 'mrp_paise', 'images', 'option_label', 'option_values', 'stock', 'active', 'featured', 'external_url',
  'in_stock', 'source', 'source_ref', 'fetch_status', 'fetched_at', 'next_check_at', 'check_failures', 'last_check_error', 'price_changed',
  'previous_price_paise', 'price_manual', 'owner_edited', 'tags', 'whatsapp_order',
]);
const CASTS = Object.freeze({ images: '::jsonb', option_values: '::text[]', owner_edited: '::text[]', tags: '::text[]' });
const dbValue = (column, value) => (column === 'images' ? JSON.stringify(value) : value);

const MEDIA_LINK = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const IMAGE_LINK = /^(https?:\/\/\S+|\/media\/[\w-]+)$/i;
const UNIQUE_VIOLATION = '23505';
const INT32_MAX = 2147483647;

const isMoney = (n) => Number.isSafeInteger(n) && n >= 0 && n <= L.maxPricePaise;
const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const rowId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= INT32_MAX ? n : 0;
};

/** Which constraint a unique violation hit, whichever driver reported it. */
export const violated = (err, name) => err?.code === UNIQUE_VIOLATION && (err.constraint === name || String(err.message ?? '').includes(name));

/** Tags once each (case ignored), trimmed, at most 50 of 40 characters. */
export function cleanTags(tags = []) {
  const out = [];
  for (const raw of tags) {
    const tag = String(raw ?? '').trim().slice(0, 40);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= L.tags) break;
  }
  return out;
}

/** Checks the columns being written against what the product will be after the write. Throws ValidationError. */
function validate(changes, current = {}) {
  const next = { ...current, ...changes };
  if ('name' in changes) {
    if (typeof next.name !== 'string' || !next.name.trim()) throw new ValidationError('Name is required');
    if (next.name.length > L.nameLength) throw new ValidationError(`Name must be ${L.nameLength} characters or fewer`);
  }
  if ('description' in changes && String(next.description).length > L.descriptionLength) throw new ValidationError(`Description must be ${L.descriptionLength} characters or fewer`);
  if ('price_paise' in changes && !isMoney(next.price_paise)) throw new ValidationError(IMPORT_REASONS.bad_price);
  if ('mrp_paise' in changes && next.mrp_paise !== null && !isMoney(next.mrp_paise)) throw new ValidationError(IMPORT_REASONS.bad_price);
  if (('price_paise' in changes || 'mrp_paise' in changes) && next.mrp_paise !== null && next.mrp_paise !== undefined && next.mrp_paise < next.price_paise) {
    throw new ValidationError(IMPORT_REASONS.mrp_below_price);
  }
  if ('images' in changes) {
    if (!Array.isArray(next.images) || next.images.length > L.images) throw new ValidationError(`A product can have at most ${L.images} images`);
    for (const link of next.images) {
      if (typeof link !== 'string' || link.length > 2000 || !IMAGE_LINK.test(link) || !link.isWellFormed()) throw new ValidationError('An image must be an uploaded file or an http(s) link');
    }
  }
  if ('external_url' in changes && next.external_url !== '' && canonicalProductUrl(next.external_url) !== next.external_url) {
    throw new ValidationError('Use the product’s own web link, starting with http:// or https://');
  }
  if ('source' in changes && !isProductSource(next.source)) throw new ValidationError('Unknown product source');
  if ('stock' in changes && next.stock !== null && !(Number.isInteger(next.stock) && next.stock >= 0 && next.stock <= INT32_MAX)) {
    throw new ValidationError('Stock must be a whole number, or empty for unlimited');
  }
  for (const column of ['name', 'description', 'external_url', 'source_ref', 'option_label']) {
    if (column in changes && (String(next[column]).includes('\u0000') || !String(next[column]).isWellFormed())) throw new ValidationError('That text has a character that can’t be saved');
  }
}

export function catalogRepo(db) {
  /** A free slug for this name: one query for every slug that starts the same way, then the first number not taken. */
  async function uniqueSlug(q, name, exceptId = null) {
    const base = slugify(name) || 'product';
    const rows = await q.query(
      `SELECT slug FROM products WHERE tenant_id = $1 AND (slug = $2 OR slug LIKE $2 || '-%') AND ($3::int IS NULL OR id <> $3)`,
      [tenantId(), base, exceptId],
    );
    const taken = new Set(rows.map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  async function setCategories(q, productId, categoryIds) {
    const tid = tenantId();
    await q.query('DELETE FROM product_categories WHERE tenant_id = $1 AND product_id = $2', [tid, productId]);
    const ids = [...new Set(categoryIds.map(rowId).filter(Boolean))];
    if (!ids.length) return;
    // Only this business's categories are linked: an id from elsewhere finds nothing here.
    await q.query(
      `INSERT INTO product_categories (tenant_id, product_id, category_id)
       SELECT $1, $2, c.id FROM categories c WHERE c.tenant_id = $1 AND c.id = ANY($3::int[]) ON CONFLICT DO NOTHING`,
      [tid, productId, ids],
    );
  }

  /**
   * product_images as the mirror of `links`, in order. A link is kept as a row when it is a web address or one of this
   * business's uploaded files. Rows keep their alt text, size and original address across a rewrite, and variants keep the
   * image they showed. `details` adds what an import knows: Map(link -> { sourceUrl, width, height }).
   * Returns the new row id for each place in `links` (null where the link has no row).
   */
  async function writeGallery(q, productId, links, { alts = null, details = new Map() } = {}) {
    const tid = tenantId();
    const before = await q.query('SELECT id, position, media_id, source_url, alt, width, height FROM product_images WHERE tenant_id = $1 AND product_id = $2 ORDER BY position', [tid, productId]);
    const linkOf = (row) => (row.media_id ? `/media/${row.media_id}` : row.source_url);
    const old = new Map(before.map((row) => [linkOf(row), row]));
    const shown = await q.query('SELECT id, image_id FROM product_variants WHERE tenant_id = $1 AND product_id = $2 AND image_id IS NOT NULL', [tid, productId]);
    const variantLink = new Map(shown.map((v) => [v.id, linkOf(before.find((row) => row.id === v.image_id) ?? {})]));

    const uploaded = links.map((link) => MEDIA_LINK.exec(link)?.[1]?.toLowerCase()).filter(Boolean);
    const own = uploaded.length
      ? new Set((await q.query('SELECT id FROM media WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tid, uploaded])).map((m) => String(m.id).toLowerCase()))
      : new Set();

    await q.query('DELETE FROM product_images WHERE tenant_id = $1 AND product_id = $2', [tid, productId]);
    const ids = [];
    const idByLink = new Map();
    let position = 0;
    for (const [index, link] of links.entries()) {
      const mediaId = MEDIA_LINK.exec(link)?.[1]?.toLowerCase() ?? null;
      const isWeb = /^https?:\/\//i.test(link);
      if (idByLink.has(link) || (mediaId ? !own.has(mediaId) : !isWeb)) {
        ids.push(idByLink.get(link) ?? null);
        continue;
      }
      const kept = old.get(link);
      const extra = details.get(link) ?? {};
      const sourceUrl = isWeb ? link : extra.sourceUrl ?? kept?.source_url ?? '';
      const alt = String(alts?.[index] ?? kept?.alt ?? '').slice(0, 200);
      const [row] = await q.query(
        `INSERT INTO product_images (tenant_id, product_id, position, media_id, source_url, alt, width, height) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [tid, productId, position++, mediaId, sourceUrl.slice(0, 2000), alt, extra.width ?? kept?.width ?? null, extra.height ?? kept?.height ?? null],
      );
      ids.push(row.id);
      idByLink.set(link, row.id);
    }
    for (const [variantId, link] of variantLink) {
      if (idByLink.has(link)) await q.query('UPDATE product_variants SET image_id = $3 WHERE tenant_id = $1 AND id = $2', [tid, variantId, idByLink.get(link)]);
    }
    return ids;
  }

  /**
   * Replaces a product's options and variants. A variant that is still there (same SKU, else the same source reference, else
   * the same option values) keeps its row and id; the others are removed and the new ones added. `imageIds` maps a variant's
   * imageIndex to its product_images row.
   */
  async function writeVariants(q, productId, optionsIn, variantsIn, imageIds = []) {
    const tid = tenantId();
    const { options, variants } = checkOptionsAndVariants(optionsIn, variantsIn);
    await q.query('DELETE FROM product_options WHERE tenant_id = $1 AND product_id = $2', [tid, productId]);
    for (const [position, option] of options.entries()) {
      await q.query('INSERT INTO product_options (tenant_id, product_id, position, name, "values") VALUES ($1, $2, $3, $4, $5::text[])', [tid, productId, position, option.name, option.values]);
    }
    const before = await q.query('SELECT id, option_values, sku, source_ref, image_id FROM product_variants WHERE tenant_id = $1 AND product_id = $2 ORDER BY position, id', [tid, productId]);
    const free = new Set(before.map((row) => row.id));
    const take = (test) => {
      const hit = before.find((row) => free.has(row.id) && test(row));
      if (hit) free.delete(hit.id);
      return hit ?? null;
    };
    const matched = variants.map((v) => (v.sku ? take((row) => row.sku === v.sku) : null));
    variants.forEach((v, i) => {
      matched[i] ??= v.sourceRef ? take((row) => row.source_ref === v.sourceRef) : null;
    });
    variants.forEach((v, i) => {
      matched[i] ??= take((row) => variantKey(row.option_values) === variantKey(v.optionValues));
    });
    if (free.size) await q.query('DELETE FROM product_variants WHERE tenant_id = $1 AND product_id = $2 AND id = ANY($3::int[])', [tid, productId, [...free]]);
    for (const [position, v] of variants.entries()) {
      const kept = matched[position];
      const imageId = v.imageIndex === null ? kept?.image_id ?? null : imageIds[v.imageIndex] ?? null;
      const values = [tid, productId, position, v.optionValues, v.sku, v.pricePaise, v.mrpPaise, v.inStock, imageId, v.sourceRef];
      if (kept) {
        await q.query(
          `UPDATE product_variants SET position = $3, option_values = $4::text[], sku = $5, price_paise = $6, mrp_paise = $7, in_stock = $8, image_id = $9,
             source_ref = CASE WHEN $10 = '' THEN source_ref ELSE $10 END, updated_at = now()
           WHERE tenant_id = $1 AND product_id = $2 AND id = $11`,
          [...values, kept.id],
        );
      } else {
        await q.query(
          `INSERT INTO product_variants (tenant_id, product_id, position, option_values, sku, price_paise, mrp_paise, in_stock, image_id, source_ref)
           VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10)`,
          values,
        );
      }
    }
    return { options, variants };
  }

  /** The children of these products: Map(product id -> { options, variants, gallery }). */
  async function children(q, ids) {
    const tid = tenantId();
    const out = new Map(ids.map((id) => [id, { options: [], variants: [], gallery: [] }]));
    if (!ids.length) return out;
    const [options, variants, images] = [
      await q.query('SELECT product_id, name, "values" FROM product_options WHERE tenant_id = $1 AND product_id = ANY($2::int[]) ORDER BY product_id, position', [tid, ids]),
      await q.query(
        `SELECT id, product_id, position, option_values, sku, price_paise, mrp_paise, in_stock, image_id, source_ref
         FROM product_variants WHERE tenant_id = $1 AND product_id = ANY($2::int[]) ORDER BY product_id, position, id`,
        [tid, ids],
      ),
      await q.query('SELECT id, product_id, position, media_id, source_url, alt, width, height FROM product_images WHERE tenant_id = $1 AND product_id = ANY($2::int[]) ORDER BY product_id, position', [tid, ids]),
    ];
    for (const o of options) out.get(o.product_id).options.push({ name: o.name, values: o.values });
    for (const v of variants) out.get(v.product_id).variants.push(v);
    for (const i of images) out.get(i.product_id).gallery.push(i);
    return out;
  }

  async function get(id, q = db) {
    const tid = tenantId();
    const [row] = await q.query(`SELECT ${P_COLS}, p.last_check_error FROM products p WHERE p.tenant_id = $1 AND p.id = $2`, [tid, rowId(id)]);
    if (!row) return null;
    row.category_ids = (await q.query('SELECT category_id FROM product_categories WHERE tenant_id = $1 AND product_id = $2 ORDER BY category_id', [tid, row.id])).map((r) => r.category_id);
    Object.assign(row, (await children(q, [row.id])).get(row.id));
    const [check] = await q.query('SELECT outcome, http_status, checked_at FROM product_checks WHERE tenant_id = $1 AND product_id = $2 ORDER BY checked_at DESC, id DESC LIMIT 1', [tid, row.id]);
    row.last_check = check ?? null;
    return row;
  }

  /** Writes the columns in `changes` and nothing else, so a write never puts back a value another write just changed. */
  async function writeColumns(q, id, changes) {
    const columns = WRITABLE.filter((c) => c in changes);
    if (!columns.length) return;
    const params = [tenantId(), id];
    const sets = columns.map((c) => {
      params.push(dbValue(c, changes[c]));
      return `${c} = $${params.length}${CASTS[c] ?? ''}`;
    });
    await q.query(`UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, params);
  }

  /** Children named in `parts` are replaced; the ones left out stay. Returns nothing. */
  async function writeParts(q, id, links, parts) {
    let imageIds = null;
    if (parts.gallery) imageIds = await writeGallery(q, id, links, parts.gallery);
    if (parts.variantSet) {
      imageIds ??= (await q.query('SELECT id FROM product_images WHERE tenant_id = $1 AND product_id = $2 ORDER BY position', [tenantId(), id])).map((r) => r.id);
      await writeVariants(q, id, parts.variantSet.options, parts.variantSet.variants, imageIds);
    }
    if (parts.categoryIds) await setCategories(q, id, parts.categoryIds);
    if (parts.addCategoryIds?.length) {
      await q.query(
        `INSERT INTO product_categories (tenant_id, product_id, category_id)
         SELECT $1, $2, c.id FROM categories c WHERE c.tenant_id = $1 AND c.id = ANY($3::int[]) ON CONFLICT DO NOTHING`,
        [tenantId(), id, parts.addCategoryIds.map(rowId).filter(Boolean)],
      );
    }
  }

  /** A product with no options keeps one variant for its SKU; that variant always carries the product's own price and stock. */
  async function syncSoleVariant(q, id) {
    await q.query(
      `UPDATE product_variants v SET price_paise = p.price_paise, mrp_paise = p.mrp_paise, in_stock = p.in_stock AND p.stock IS DISTINCT FROM 0, updated_at = now()
       FROM products p
       WHERE v.tenant_id = $1 AND v.product_id = $2 AND p.tenant_id = v.tenant_id AND p.id = v.product_id AND v.option_values = '{}'
         AND (v.price_paise, v.mrp_paise, v.in_stock) IS DISTINCT FROM (p.price_paise, p.mrp_paise, p.in_stock AND p.stock IS DISTINCT FROM 0)`,
      [tenantId(), id],
    );
  }

  return {
    get,

    /**
     * One page of the seller's list, live products first and the latest change first. `cursor` is the key of the last row
     * shown: [0 or 1, microseconds, id]. Returns { rows, more }, each row with reel_count, category_names, variants and at_micros.
     */
    async list({ search = '', status = 'all', category = 0, source = '', cursor = null, limit = 25 } = {}) {
      const tid = tenantId();
      const micros = '(extract(epoch FROM p.updated_at) * 1000000)::bigint';
      const rows = await db.query(
        `SELECT ${P_COLS}, ${micros} AS at_micros,
           (SELECT count(*)::int FROM reel_products rp WHERE rp.tenant_id = p.tenant_id AND rp.product_id = p.id) AS reel_count,
           (SELECT coalesce(array_agg(c.name ORDER BY c.position), '{}') FROM product_categories pc
              JOIN categories c ON c.tenant_id = pc.tenant_id AND c.id = pc.category_id
              WHERE pc.tenant_id = p.tenant_id AND pc.product_id = p.id) AS category_names
         FROM products p
         WHERE p.tenant_id = $1 AND ($2 = '' OR p.name ILIKE '%' || $2 || '%')
           AND CASE $3
                 WHEN 'active' THEN p.active
                 WHEN 'archived' THEN NOT p.active
                 WHEN 'featured' THEN p.featured
                 WHEN 'attention' THEN p.fetch_status IN ('broken', 'missing')
                 WHEN 'price_changed' THEN p.price_changed
                 WHEN 'sold_out' THEN (NOT p.in_stock OR p.stock = 0 OR (
                   EXISTS (SELECT 1 FROM product_variants v WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id)
                   AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id AND v.in_stock)))
                 ELSE true
               END
           AND ($4::int = 0 OR EXISTS (SELECT 1 FROM product_categories pc WHERE pc.tenant_id = p.tenant_id AND pc.product_id = p.id AND pc.category_id = $4))
           AND ($5 = '' OR p.source = $5 OR ($5 = 'adapter' AND p.source LIKE 'adapter:%'))
           AND ($6::int IS NULL OR ((NOT p.active)::int, -${micros}, -p.id) > ($6::int, -($7::bigint), -($8::int)))
         ORDER BY p.active DESC, ${micros} DESC, p.id DESC LIMIT $9`,
        [tid, escapeLike(String(search).trim()), status, rowId(category), String(source ?? ''), cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, limit + 1],
      );
      const shown = rows.slice(0, limit);
      const parts = await children(db, shown.map((r) => r.id));
      for (const row of shown) Object.assign(row, parts.get(row.id));
      return { rows: shown, more: rows.length > limit };
    },

    /**
     * Adds a product. `columns` are products columns (name and price_paise at least); `parts` are its children:
     * { categoryIds, variantSet: { options, variants }, gallery: { alts, details } }. Returns the new id.
     */
    async insert(columns, parts = {}) {
      const state = {
        description: '', mrp_paise: null, images: [], option_label: '', option_values: [], stock: null, active: true, featured: false, external_url: '', in_stock: true,
        source: 'manual', source_ref: '', fetch_status: 'none', fetched_at: null, next_check_at: null, price_changed: false, previous_price_paise: null,
        price_manual: true, owner_edited: [], tags: [], whatsapp_order: null, ...columns,
      };
      state.tags = cleanTags(state.tags);
      validate(state);
      for (let attempt = 0; ; attempt++) {
        try {
          return await db.tx(async (t) => {
            const slug = await uniqueSlug(t, state.name);
            const names = WRITABLE.filter((c) => c in state && c !== 'slug');
            const params = [tenantId(), slug, ...names.map((c) => dbValue(c, state[c]))];
            const [row] = await t.query(
              `INSERT INTO products (tenant_id, slug, ${names.join(', ')}) VALUES ($1, $2, ${names.map((c, i) => `$${i + 3}${CASTS[c] ?? ''}`).join(', ')}) RETURNING id`,
              params,
            );
            await writeParts(t, row.id, state.images, { gallery: {}, ...parts });
            return row.id;
          });
        } catch (err) {
          // Two saves picking the same free slug at once: the second one looks again.
          if (!(violated(err, 'products_tenant_id_slug_key') && attempt < 3)) throw err;
        }
      }
    },

    /**
     * Changes the columns in `changes` and the children in `parts`, in one transaction. `check(current)` may be given to look
     * at the row first, locked, and return the changes to make (or null for none). Returns false when there is no such product.
     */
    async update(id, changes, parts = {}) {
      const productId = rowId(id);
      return db.tx(async (t) => {
        const [current] = await t.query(`SELECT ${P_COLS} FROM products p WHERE p.tenant_id = $1 AND p.id = $2 FOR UPDATE`, [tenantId(), productId]);
        if (!current) return false;
        const next = { ...changes };
        if ('tags' in next) next.tags = cleanTags(next.tags);
        validate(next, current);
        if ('name' in next && next.name !== current.name) next.slug = await uniqueSlug(t, next.name, productId);
        await writeColumns(t, productId, next);
        const links = next.images ?? current.images;
        const gallery = parts.gallery ?? ('images' in next ? {} : null);
        await writeParts(t, productId, links, { ...parts, gallery });
        if (!parts.variantSet) await syncSoleVariant(t, productId);
        return true;
      });
    },

    /** Deletes a product unless it appears in an order; those can only be archived. */
    async remove(id) {
      const tid = tenantId();
      const [used] = await db.query('SELECT 1 FROM order_items WHERE tenant_id = $1 AND product_id = $2 LIMIT 1', [tid, rowId(id)]);
      if (used) throw new ValidationError('This product is part of an order, so it can’t be deleted. Archive it instead.');
      await db.query('DELETE FROM products WHERE tenant_id = $1 AND id = $2', [tid, rowId(id)]);
    },

    // ---- what imports look a product up by (8.3, 8.5, 8.6) ----

    async idByExternalUrl(url) {
      if (!url) return null;
      const [row] = await db.query('SELECT id FROM products WHERE tenant_id = $1 AND external_url = $2', [tenantId(), String(url)]);
      return row?.id ?? null;
    },
    async idBySourceRef(source, sourceRef) {
      if (!sourceRef) return null;
      const [row] = await db.query('SELECT id FROM products WHERE tenant_id = $1 AND source = $2 AND source_ref = $3', [tenantId(), String(source), String(sourceRef)]);
      return row?.id ?? null;
    },
    async idBySku(sku) {
      if (!sku) return null;
      const [row] = await db.query('SELECT product_id FROM product_variants WHERE tenant_id = $1 AND sku = $2', [tenantId(), String(sku)]);
      return row?.product_id ?? null;
    },
    /** Which of these SKUs another product of this business already uses. */
    async skusTakenElsewhere(skus, exceptProductId = null) {
      const list = skus.filter(Boolean);
      if (!list.length) return [];
      const rows = await db.query(
        'SELECT sku FROM product_variants WHERE tenant_id = $1 AND sku = ANY($2::text[]) AND ($3::int IS NULL OR product_id <> $3)',
        [tenantId(), list, exceptProductId],
      );
      return rows.map((r) => r.sku);
    },
    /** Ids and source references of this business's products from one store's feed (source_ref starts with "<host>/"). */
    async fromStore(source, host) {
      return db.query(
        `SELECT id, source_ref, fetch_status, active FROM products WHERE tenant_id = $1 AND source = $2 AND source_ref LIKE $3 || '/%'`,
        [tenantId(), source, escapeLike(host)],
      );
    },
    /** Puts an uploaded copy in place of an image's web address, keeping that address as the original. */
    async useCopiedImage(productId, sourceUrl, { mediaId, width = null, height = null }) {
      const id = rowId(productId);
      const link = `/media/${mediaId}`;
      return db.tx(async (t) => {
        const [current] = await t.query('SELECT images FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
        if (!current || !current.images.includes(sourceUrl)) return false;
        const images = current.images.map((entry) => (entry === sourceUrl ? link : entry));
        await writeColumns(t, id, { images });
        await writeGallery(t, id, images, { details: new Map([[link, { sourceUrl, width, height }]]) });
        return true;
      });
    },

    /**
     * Notes that a product's page or feed was just read, without counting as a change to the product (its place in the
     * seller's list stays). `status` null keeps the fetch status; `nextCheckAt` null means it isn't re-checked.
     */
    async markFetched(productId, { status = null, nextCheckAt = null, failures = 0, error = '', read = true } = {}) {
      await db.query(
        `UPDATE products SET fetch_status = coalesce($3, fetch_status), fetched_at = CASE WHEN $4 THEN now() ELSE fetched_at END,
           next_check_at = $5, check_failures = $6, last_check_error = $7
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), rowId(productId), status, Boolean(read), nextCheckAt, failures, String(error).slice(0, 200)],
      );
    },

    /** Products that left their store's feed (8.5): archived into Needs attention, and no longer re-checked. Returns the ids changed. */
    async archiveMissing(ids) {
      const list = ids.map(rowId).filter(Boolean);
      if (!list.length) return [];
      const rows = await db.query(
        `UPDATE products SET fetch_status = 'missing', active = false, next_check_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = ANY($2::int[]) AND fetch_status <> 'missing' RETURNING id`,
        [tenantId(), list],
      );
      return rows.map((r) => r.id);
    },

    // ---- the re-check (8.8) ----

    async recordCheck({ productId, outcome, httpStatus = null, pricePaise = null }) {
      await db.query('INSERT INTO product_checks (tenant_id, product_id, outcome, http_status, price_paise) VALUES ($1, $2, $3, $4, $5)', [tenantId(), rowId(productId), outcome, httpStatus, pricePaise]);
    },

    // ---- settings ----

    async settings() {
      const tid = tenantId();
      const [row] = await db.query('SELECT recheck_hours FROM catalog_settings WHERE tenant_id = $1', [tid]);
      const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND fetch_status IN ('broken', 'missing')`, [tid]);
      const [last] = await db.query('SELECT max(checked_at) AS at FROM product_checks WHERE tenant_id = $1', [tid]);
      return { recheckHours: row?.recheck_hours ?? L.recheckHours, attentionCount: n, lastRecheckAt: last?.at ?? null };
    },
    async recheckHours() {
      const [row] = await db.query('SELECT recheck_hours FROM catalog_settings WHERE tenant_id = $1', [tenantId()]);
      return row?.recheck_hours ?? L.recheckHours;
    },
    async saveSettings({ recheckHours }) {
      if (recheckHours === undefined) return;
      if (!Number.isInteger(recheckHours) || recheckHours < 1 || recheckHours > 720) throw new ValidationError('Use 1 to 720 hours');
      const tid = tenantId();
      await db.query(
        `INSERT INTO catalog_settings (tenant_id, recheck_hours) VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO UPDATE SET recheck_hours = EXCLUDED.recheck_hours, updated_at = now()`,
        [tid, recheckHours],
      );
      // Products already waiting on the old interval are due no later than the new one allows.
      await db.query(
        `UPDATE products SET next_check_at = least(next_check_at, now() + make_interval(hours => $2))
         WHERE tenant_id = $1 AND next_check_at IS NOT NULL`,
        [tid, recheckHours],
      );
    },
  };
}

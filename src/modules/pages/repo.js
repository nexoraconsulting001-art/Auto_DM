import { tenantId } from '../../tenancy.js';
import { ValidationError, slugify } from '../../util.js';
import { CATALOG_LIMITS as L, displayPrice, paiseFromDb } from '../../contracts/catalog.js';
import { BUYER_BLOCKS, DEFAULT_BLOCKS } from '../../contracts/buyer-pages.js';
import { writeAudit } from '../audit/index.js';
import { removeVariants } from './variants.js';

/**
 * Landing pages (PRD 8.10): one row of `reels` per automated reel, post or story, with its products in the owner's order in
 * reel_products and its categories in category_reels. Every query names tenant_id as well as running inside the fence.
 */

const PAGE_COLS = `r.id, r.ig_media_id, r.slug, r.headline, r.description, r.active, r.kind, r.channel, r.media_type, r.media_url,
  r.permalink, r.thumbnail_url, r.video_url, r.caption, r.posted_at, r.expires_at, r.cover_media_id, r.lead_form,
  r.media_checked_at, r.created_at, r.updated_at`;

/** A product a buyer may see: on, and not broken or gone from its feed (8.8). */
const LIVE_PRODUCT = `p.active AND p.fetch_status NOT IN ('broken', 'missing')`;

/** The first image of a product: the stored copy when there is one, the original address otherwise, then the Phase 0 list. */
const FIRST_IMAGE = `COALESCE(
  (SELECT COALESCE('/media/' || i.media_id::text, NULLIF(i.source_url, '')) FROM product_images i
     WHERE i.tenant_id = p.tenant_id AND i.product_id = p.id ORDER BY i.position LIMIT 1),
  p.images->>0, '')`;

const PRODUCT_COLS = `p.id, p.name, p.slug, p.price_paise, p.mrp_paise, p.in_stock, p.stock, p.active, p.external_url, p.whatsapp_order,
  p.fetch_status, ${FIRST_IMAGE} AS image_url`;

/** Live pages only: switched on, and a story only while its page can still be shown in a strip (before it expires). */
const LIVE_PAGE = `r.active AND (r.kind <> 'story' OR r.expires_at IS NULL OR r.expires_at > now())`;

const HAS_LIVE_PRODUCT = `EXISTS (SELECT 1 FROM reel_products rp JOIN products p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
  WHERE rp.tenant_id = r.tenant_id AND rp.reel_id = r.ig_media_id AND ${LIVE_PRODUCT})`;

const TILE_IMAGE = `COALESCE(NULLIF(CASE WHEN r.kind = 'story' THEN '' ELSE r.thumbnail_url END, ''),
  CASE WHEN r.cover_media_id IS NULL THEN NULL ELSE '/media/' || r.cover_media_id::text END,
  (SELECT ${FIRST_IMAGE} FROM reel_products rp JOIN products p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
     WHERE rp.tenant_id = r.tenant_id AND rp.reel_id = r.ig_media_id AND ${LIVE_PRODUCT} ORDER BY rp.position LIMIT 1), '')`;

function soldOut(p) {
  return p.in_stock === false || (p.stock !== null && p.stock !== undefined && Number(p.stock) <= 0);
}

/** Retries a write that lost a race for a unique position or slug. */
async function retrying(fn, times = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err?.code !== '23505' || attempt >= times) throw err;
    }
  }
}

export function landingPagesRepo(db) {
  const platform = db.platform ?? db;

  async function productsOf(t, mediaId, { liveOnly = false } = {}) {
    const rows = await t.query(
      `SELECT ${PRODUCT_COLS}, rp.position FROM reel_products rp JOIN products p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
       WHERE rp.tenant_id = $1 AND rp.reel_id = $2 AND (NOT $3 OR (${LIVE_PRODUCT})) ORDER BY rp.position`,
      [tenantId(), mediaId, liveOnly],
    );
    if (!rows.length) return rows;
    const variants = await t.query(
      'SELECT product_id, price_paise, mrp_paise, in_stock FROM product_variants WHERE tenant_id = $1 AND product_id = ANY($2::int[]) ORDER BY product_id, position',
      [tenantId(), rows.map((r) => r.id)],
    );
    const byProduct = new Map();
    for (const v of variants) byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), v]);
    return rows.map((p) => {
      const shown = displayPrice({ ...p, in_stock: !soldOut(p) }, byProduct.get(p.id) ?? []);
      return { ...p, price_paise: paiseFromDb(p.price_paise), mrp_paise: paiseFromDb(p.mrp_paise), shown };
    });
  }

  async function categoryIdsOf(t, pageId) {
    const rows = await t.query(
      `SELECT cr.category_id FROM category_reels cr JOIN categories c ON c.tenant_id = cr.tenant_id AND c.id = cr.category_id
       WHERE cr.tenant_id = $1 AND cr.page_id = $2 ORDER BY c.position, c.name, c.id`,
      [tenantId(), pageId],
    );
    return rows.map((r) => r.category_id);
  }

  async function withChildren(t, row, { liveOnly = false } = {}) {
    if (!row) return null;
    return { ...row, products: await productsOf(t, row.ig_media_id, { liveOnly }), category_ids: await categoryIdsOf(t, row.id) };
  }

  /** The page's categories become exactly `ids`: new ones join at the bottom; a removed one is remembered so no rule adds it back. */
  async function setCategories(t, pageId, ids) {
    const tid = tenantId();
    const wanted = [...new Set(ids)];
    const current = (await t.query('SELECT category_id FROM category_reels WHERE tenant_id = $1 AND page_id = $2', [tid, pageId])).map((r) => r.category_id);
    for (const id of current.filter((c) => !wanted.includes(c))) {
      await t.query('DELETE FROM category_reels WHERE tenant_id = $1 AND category_id = $2 AND page_id = $3', [tid, id, pageId]);
      await t.query('INSERT INTO category_reel_removals (tenant_id, category_id, page_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [tid, id, pageId]);
    }
    for (const id of wanted.filter((c) => !current.includes(c))) {
      await t.query('DELETE FROM category_reel_removals WHERE tenant_id = $1 AND category_id = $2 AND page_id = $3', [tid, id, pageId]);
      await t.query(
        `INSERT INTO category_reels (tenant_id, category_id, page_id, position)
         SELECT $1, $2, $3, COALESCE(MAX(position) + 1, 0) FROM category_reels WHERE tenant_id = $1 AND category_id = $2`,
        [tid, id, pageId],
      );
    }
  }

  async function setProducts(t, mediaId, productIds) {
    const tid = tenantId();
    await t.query('DELETE FROM reel_products WHERE tenant_id = $1 AND reel_id = $2', [tid, mediaId]);
    for (const [position, productId] of productIds.entries()) {
      await t.query('INSERT INTO reel_products (tenant_id, reel_id, product_id, position) VALUES ($1, $2, $3, $4)', [tid, mediaId, productId, position]);
    }
  }

  async function freeSlug(t, wanted, exceptId = null) {
    const base = slugify(wanted).slice(0, 52).replace(/-+$/, '') || 'shop';
    for (let n = 1; n <= 100; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const [taken] = await t.query('SELECT id FROM reels WHERE tenant_id = $1 AND slug = $2', [tenantId(), slug]);
      if (!taken || taken.id === exceptId) return slug;
    }
    throw new ValidationError('Choose another link name for this page');
  }

  return {
    /**
     * One page of the seller's list, newest page first, each with its product count and Phase 0 visit count. `beforeId` is the
     * last id already shown; one row more than `limit` comes back when there are more, so the counts are only ever worked out
     * for the rows on screen, however long the business's history is.
     */
    async list({ kind = 'all', status = 'all', search = '', beforeId = null, limit = 25 } = {}) {
      const pattern = search ? `%${search.replace(/[\%_]/g, (c) => `\${c}`)}%` : '';
      return db.query(
        `SELECT ${PAGE_COLS},
           (SELECT count(*)::int FROM reel_products rp WHERE rp.tenant_id = r.tenant_id AND rp.reel_id = r.ig_media_id) AS product_count,
           (SELECT count(*)::int FROM visits v WHERE v.tenant_id = r.tenant_id AND v.reel_id = r.ig_media_id) AS visit_count,
           COALESCE((SELECT array_agg(cr.category_id ORDER BY cr.category_id) FROM category_reels cr WHERE cr.tenant_id = r.tenant_id AND cr.page_id = r.id), '{}') AS category_ids
         FROM reels r
         WHERE r.tenant_id = $1 AND ($2 = 'all' OR r.kind = $2) AND ($3 = 'all' OR r.active = ($3 = 'active'))
           AND ($4 = '' OR r.headline ILIKE $4 OR r.slug ILIKE $4 OR r.caption ILIKE $4)
           AND ($5::integer IS NULL OR r.id < $5)
         ORDER BY r.id DESC LIMIT $6`,
        [tenantId(), kind, status, pattern, beforeId, limit + 1],
      );
    },

    async get(id) {
      const [row] = await db.query(`SELECT ${PAGE_COLS} FROM reels r WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId(), Number(id)]);
      return withChildren(db, row);
    },

    /** The buyer's page: its live products only. Null when there is no such page. */
    async getBySlug(slug) {
      const [row] = await db.query(`SELECT ${PAGE_COLS} FROM reels r WHERE r.tenant_id = $1 AND r.slug = $2`, [tenantId(), String(slug)]);
      return withChildren(db, row, { liveOnly: true });
    },

    async idsByMedia(mediaIds) {
      if (!mediaIds.length) return new Map();
      const rows = await db.query('SELECT id, ig_media_id FROM reels WHERE tenant_id = $1 AND ig_media_id = ANY($2::text[])', [tenantId(), mediaIds.map(String)]);
      return new Map(rows.map((r) => [r.ig_media_id, r.id]));
    },

    /** Media ids are unique across Instagram, so whether another business holds one has to look across businesses. */
    async heldElsewhere(mediaId) {
      const [row] = await platform.query('SELECT tenant_id FROM reels WHERE ig_media_id = $1', [String(mediaId)]);
      return Boolean(row && row.tenant_id !== tenantId());
    },

    /** Which of `ids` are this business's products. */
    async ownProducts(ids) {
      if (!ids.length) return [];
      const rows = await db.query('SELECT id FROM products WHERE tenant_id = $1 AND id = ANY($2::int[])', [tenantId(), ids]);
      return rows.map((r) => r.id);
    },

    async ownCategories(ids) {
      if (!ids.length) return [];
      const rows = await db.query('SELECT id FROM categories WHERE tenant_id = $1 AND id = ANY($2::int[])', [tenantId(), ids]);
      return rows.map((r) => r.id);
    },

    async ownMedia(id) {
      const [row] = await db.query('SELECT id FROM media WHERE tenant_id = $1 AND id = $2', [tenantId(), String(id)]);
      return Boolean(row);
    },

    /** Whether a link name is in use, by a page other than `exceptId`. */
    async slugTaken(slug, exceptId = null) {
      const [row] = await db.query('SELECT id FROM reels WHERE tenant_id = $1 AND slug = $2', [tenantId(), slugify(slug)]);
      return Boolean(row) && row.id !== exceptId;
    },

    /** A new page. `fields` uses column names; `productIds` and `categoryIds` are already checked to be this business's. */
    async create(fields, { productIds, categoryIds = [], actor }) {
      return retrying(() => db.tx(async (t) => {
        const slug = await freeSlug(t, fields.slug);
        const [row] = await t.query(
          `INSERT INTO reels (tenant_id, ig_media_id, slug, headline, description, active, kind, channel, media_type, media_url, permalink,
             thumbnail_url, video_url, caption, posted_at, expires_at, cover_media_id, lead_form, media_checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
           RETURNING id`,
          [tenantId(), fields.ig_media_id, slug, fields.headline ?? '', fields.description ?? '', fields.active ?? true, fields.kind, fields.channel,
            fields.media_type ?? '', fields.media_url ?? '', fields.permalink ?? '', fields.thumbnail_url ?? '', fields.video_url ?? '',
            String(fields.caption ?? '').slice(0, 500), fields.posted_at ?? null, fields.expires_at ?? null, fields.cover_media_id ?? null, fields.lead_form ?? null],
        );
        await setProducts(t, fields.ig_media_id, productIds);
        await setCategories(t, row.id, categoryIds);
        await writeAudit(t, { actor, action: 'page.created', target: `page:${row.id}`, details: { kind: fields.kind, products: productIds.length } });
        const [saved] = await t.query(`SELECT ${PAGE_COLS} FROM reels r WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId(), row.id]);
        return withChildren(t, saved);
      }));
    },

    /** Changes the fields given; `productIds` and `categoryIds` replace the lists when present. */
    async update(id, fields, { productIds, categoryIds, actor }) {
      return retrying(() => db.tx(async (t) => {
        const [current] = await t.query(`SELECT ${PAGE_COLS} FROM reels r WHERE r.tenant_id = $1 AND r.id = $2 FOR UPDATE`, [tenantId(), Number(id)]);
        if (!current) return null;
        const next = { ...current, ...fields };
        if (fields.slug !== undefined && fields.slug !== current.slug) {
          const [taken] = await t.query('SELECT id FROM reels WHERE tenant_id = $1 AND slug = $2 AND id <> $3', [tenantId(), fields.slug, current.id]);
          if (taken) throw new ValidationError(`The link “${fields.slug}” is already used by another page`);
        }
        await t.query(
          `UPDATE reels SET slug = $3, headline = $4, description = $5, active = $6, cover_media_id = $7, lead_form = $8, updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId(), current.id, next.slug, next.headline, next.description, next.active, next.cover_media_id, next.lead_form],
        );
        if (productIds) await setProducts(t, current.ig_media_id, productIds);
        if (categoryIds) await setCategories(t, current.id, categoryIds);
        const changed = [...Object.keys(fields), ...(productIds ? ['products'] : []), ...(categoryIds ? ['categories'] : [])];
        await writeAudit(t, { actor, action: 'page.updated', target: `page:${current.id}`, details: { fields: changed } });
        const [saved] = await t.query(`SELECT ${PAGE_COLS} FROM reels r WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId(), current.id]);
        return withChildren(t, saved);
      }));
    },

    async remove(id, { actor }) {
      return db.tx(async (t) => {
        const rows = await t.query('DELETE FROM reels WHERE tenant_id = $1 AND id = $2 RETURNING id', [tenantId(), Number(id)]);
        if (!rows.length) return null;
        const previews = await t.query('DELETE FROM share_previews WHERE tenant_id = $1 AND target = $2 RETURNING media_id', [tenantId(), `page:${Number(id)}`]);
        await writeAudit(t, { actor, action: 'page.removed', target: `page:${Number(id)}` });
        return { previewMediaId: previews[0]?.media_id ?? null };
      });
    },

    /**
     * "More reels" (8.10): other live pages from this page's first category, in that category's set order (pinned first, then
     * position, each inside its window), or newest first when the page has no category. Up to CATALOG_LIMITS.moreReels.
     */
    async moreReels(page, limit = L.moreReels) {
      const tid = tenantId();
      const [first] = await db.query(
        `SELECT c.id, c.name FROM category_reels cr JOIN categories c ON c.tenant_id = cr.tenant_id AND c.id = cr.category_id
         WHERE cr.tenant_id = $1 AND cr.page_id = $2 AND c.visible ORDER BY c.position, c.name, c.id LIMIT 1`,
        [tid, page.id],
      );
      if (first) {
        const items = await db.query(
          `SELECT r.id, r.slug, r.headline, r.kind, ${TILE_IMAGE} AS tile_image
           FROM category_reels cr JOIN reels r ON r.tenant_id = cr.tenant_id AND r.id = cr.page_id
           WHERE cr.tenant_id = $1 AND cr.category_id = $2 AND r.id <> $3 AND ${LIVE_PAGE} AND ${HAS_LIVE_PRODUCT}
             AND (cr.starts_at IS NULL OR cr.starts_at <= now()) AND (cr.ends_at IS NULL OR cr.ends_at > now())
           ORDER BY cr.pinned DESC, cr.pin_position NULLS LAST, cr.position, r.id
           LIMIT $4`,
          [tid, first.id, page.id, limit],
        );
        return { categoryName: first.name, items };
      }
      const newest = await db.query(
        `SELECT r.id, r.slug, r.headline, r.kind, ${TILE_IMAGE} AS tile_image FROM reels r
         WHERE r.tenant_id = $1 AND r.id <> $2 AND ${LIVE_PAGE} AND ${HAS_LIVE_PRODUCT}
         ORDER BY COALESCE(r.posted_at, r.created_at) DESC, r.id DESC LIMIT $3`,
        [tid, page.id, limit],
      );
      return { categoryName: '', items: newest };
    },

    /** Media read again from Instagram (8.10). Only the address fields change, and the time of the check. */
    async updateMedia(id, { mediaUrl, thumbnailUrl, permalink, mediaType }) {
      await db.query(
        `UPDATE reels SET media_url = $3, thumbnail_url = COALESCE(NULLIF($4, ''), thumbnail_url), permalink = COALESCE(NULLIF($5, ''), permalink),
           video_url = CASE WHEN $6 = 'VIDEO' THEN $3 ELSE video_url END, media_type = $6, media_checked_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), Number(id), String(mediaUrl ?? '').slice(0, 2000), String(thumbnailUrl ?? '').slice(0, 2000), String(permalink ?? '').slice(0, 2000), mediaType],
      );
    },

    /** A story that has expired keeps no address of its media (4.14): the page shows the cover or a product photo instead. */
    async clearStoryMedia(id) {
      await db.query(
        `UPDATE reels SET media_url = '', thumbnail_url = '', video_url = '', media_checked_at = now()
         WHERE tenant_id = $1 AND id = $2 AND kind = 'story'`,
        [tenantId(), Number(id)],
      );
    },

    async touchMediaCheck(id) {
      await db.query('UPDATE reels SET media_checked_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(id)]);
    },

    /** A visit in the Phase 0 count, which the seller's lists and dashboard still read. */
    async recordVisit(mediaId, source = '') {
      await db.query('INSERT INTO visits (tenant_id, reel_id, source) VALUES ($1, $2, $3)', [tenantId(), String(mediaId), String(source).slice(0, 20)]);
    },

    /** Whether this business tags links to its own site (6.6: on by default, switchable per business). */
    async utmEnabled() {
      const [row] = await db.query('SELECT utm_enabled FROM compliance_settings WHERE tenant_id = $1', [tenantId()]);
      return row?.utm_enabled ?? true;
    },
  };
}

// ---- page settings (8.11, 8.12) ---------------------------------------------------------------------------------

const SETTINGS_DEFAULTS = Object.freeze({ whatsapp_order: false, whatsapp_template: 'Hi, I would like to order {product} ({price}). {url}', landing_noindex: true, more_reels: true });

export function pageSettingsRepo(db) {
  return {
    async get() {
      const [row] = await db.query('SELECT whatsapp_order, whatsapp_template, landing_noindex, more_reels FROM page_settings WHERE tenant_id = $1', [tenantId()]);
      return { ...SETTINGS_DEFAULTS, ...(row ?? {}) };
    },
    async save(patch, { actor }) {
      return db.tx(async (t) => {
        const [row] = await t.query('SELECT whatsapp_order, whatsapp_template, landing_noindex, more_reels FROM page_settings WHERE tenant_id = $1 FOR UPDATE', [tenantId()]);
        const next = { ...SETTINGS_DEFAULTS, ...(row ?? {}), ...patch };
        await t.query(
          `INSERT INTO page_settings (tenant_id, whatsapp_order, whatsapp_template, landing_noindex, more_reels) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id) DO UPDATE SET whatsapp_order = EXCLUDED.whatsapp_order, whatsapp_template = EXCLUDED.whatsapp_template,
             landing_noindex = EXCLUDED.landing_noindex, more_reels = EXCLUDED.more_reels, updated_at = now()`,
          [tenantId(), next.whatsapp_order, next.whatsapp_template, next.landing_noindex, next.more_reels],
        );
        await writeAudit(t, { actor, action: 'page_settings.updated', details: { fields: Object.keys(patch) } });
        return next;
      });
    },
  };
}

// ---- the block layout (5.18 level 3) -----------------------------------------------------------------------------

export function pageBlocksRepo(db) {
  return {
    /**
     * One surface's blocks in order, as { custom, blocks: [{ block, visible, settings }] }. With none placed it is
     * DEFAULT_BLOCKS for that surface, the same in every preset (F-105). Every buyer surface reads its layout here.
     */
    async layout(surface) {
      const rows = await db.query('SELECT block, visible, settings FROM page_blocks WHERE tenant_id = $1 AND surface = $2 ORDER BY position', [tenantId(), surface]);
      const known = rows.filter((r) => Object.hasOwn(BUYER_BLOCKS, r.block) && BUYER_BLOCKS[r.block].surfaces.includes(surface));
      if (!rows.length) return { surface, custom: false, blocks: (DEFAULT_BLOCKS[surface] ?? []).map((block) => ({ block, visible: true, settings: {} })) };
      return { surface, custom: true, blocks: known.map((r) => ({ block: r.block, visible: r.visible, settings: r.settings ?? {} })) };
    },
    /** Replaces the surface's whole layout. The blocks are already validated. */
    async save(surface, blocks, { actor }) {
      await db.tx(async (t) => {
        await t.query('DELETE FROM page_blocks WHERE tenant_id = $1 AND surface = $2', [tenantId(), surface]);
        for (const [position, b] of blocks.entries()) {
          await t.query('INSERT INTO page_blocks (tenant_id, surface, block, position, visible, settings) VALUES ($1, $2, $3, $4, $5, $6)', [
            tenantId(), surface, b.block, position, b.visible, JSON.stringify(b.settings ?? {}),
          ]);
        }
        await writeAudit(t, { actor, action: 'page_blocks.saved', target: `surface:${surface}`, details: { blocks: blocks.map((b) => b.block) } });
      });
      return this.layout(surface);
    },
  };
}

// ---- share previews (8.12) ---------------------------------------------------------------------------------------

export function sharePreviewsRepo(db, { storage } = {}) {
  return {
    async get(target) {
      const [row] = await db.query('SELECT target, version, media_id, width, height, title, description, updated_at FROM share_previews WHERE tenant_id = $1 AND target = $2', [tenantId(), target]);
      return row ?? null;
    },
    /** Saves a new image for `target`; returns the media id it replaced, for the caller to delete. */
    async put(target, { version, mediaId, width, height, title = '', description = '' }) {
      return db.tx(async (t) => {
        const [old] = await t.query('SELECT media_id FROM share_previews WHERE tenant_id = $1 AND target = $2 FOR UPDATE', [tenantId(), target]);
        await t.query(
          `INSERT INTO share_previews (tenant_id, target, version, media_id, width, height, title, description) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_id, target) DO UPDATE SET version = EXCLUDED.version, media_id = EXCLUDED.media_id, width = EXCLUDED.width,
             height = EXCLUDED.height, title = EXCLUDED.title, description = EXCLUDED.description, updated_at = now()`,
          [tenantId(), target, version, mediaId, width, height, String(title).slice(0, 200), String(description).slice(0, 300)],
        );
        return old?.media_id && old.media_id !== mediaId ? old.media_id : null;
      });
    },
    /** Deletes a preview image that nothing points at any more: the row, then its bytes. */
    async removeMedia(mediaId) {
      const rows = await db.query('DELETE FROM media WHERE tenant_id = $1 AND id = $2 RETURNING storage_key', [tenantId(), mediaId]);
      if (rows[0]?.storage_key && storage) {
        await storage.remove(rows[0].storage_key).catch(() => {});
        await removeVariants(storage, mediaId);
      }
    },
  };
}

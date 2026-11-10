import { ApiError } from '../../contracts/api/index.js';
import { tenantId } from '../../tenancy.js';
import { matchesRule } from './match.js';

/**
 * Each category's ordered reels (PRD 8.13): one stored order per category per business, which every buyer surface reads
 * through here (the category page, the Reels tab, landing pages' "More reels", the creator page, later the store and apps).
 *
 * The order: pinned reels first by pin_position, then the rest by position. `position` is a reel's place among the unpinned
 * ones and is kept while it is pinned, so unpinning returns it there (K-45). A reel is live when it is on, has at least one
 * product a page may show, and is inside its window in that category (K-46). One that isn't keeps its place.
 *
 * A landing page is a row of `reels` (its serial `id` is the page id). Every query names tenant_id; the fence is the second lock.
 */

/** A product a page may show: switched on, and not found gone at the seller's site (8.8). */
export const LIVE_PRODUCT_SQL = `p.active AND p.fetch_status NOT IN ('broken', 'missing')`;
const HAS_LIVE_PRODUCT = `EXISTS (SELECT 1 FROM reel_products rp JOIN products p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
  WHERE rp.tenant_id = r.tenant_id AND rp.reel_id = r.ig_media_id AND ${LIVE_PRODUCT_SQL})`;

/** What a tile or a list item needs about a page. */
export const PAGE_COLS = `r.id AS page_id, r.ig_media_id, r.slug, r.kind, r.headline, r.caption, r.thumbnail_url, r.media_url, r.media_type,
  r.active, r.expires_at, r.cover_media_id, r.posted_at, r.created_at, ${HAS_LIVE_PRODUCT} AS has_products,
  (SELECT p.images->>0 FROM reel_products rp JOIN products p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
    WHERE rp.tenant_id = r.tenant_id AND rp.reel_id = r.ig_media_id AND ${LIVE_PRODUCT_SQL} ORDER BY rp.position LIMIT 1) AS product_image`;

/** A live page, for buyer pages. `$now` is the parameter holding the time. */
const LIVE_PAGE = `r.active AND ${HAS_LIVE_PRODUCT}`;
const IN_WINDOW = (now) => `(cr.starts_at IS NULL OR cr.starts_at <= ${now}) AND (cr.ends_at IS NULL OR cr.ends_at > ${now})`;
const SEQUENCE_ORDER = 'cr.pinned DESC, cr.pin_position ASC NULLS LAST, cr.position ASC, cr.page_id ASC';
const NEWEST_FIRST = 'COALESCE(r.posted_at, r.created_at) DESC, r.id DESC';

/** Why a reel in a sequence shows nowhere right now ('' when it is live). */
export function hiddenReason(row, now = new Date()) {
  if (!row.active) return 'inactive';
  if (!row.has_products) return 'no_active_products';
  if (row.starts_at && new Date(row.starts_at) > now) return 'before_window';
  if (row.ends_at && new Date(row.ends_at) <= now) return 'after_window';
  return '';
}

/**
 * The picture a tile shows: a story's own media never outlives the story (4.14), so an expired story shows its cover or its
 * first product. A video shows its thumbnail, a photo its media, and anything else its first product's picture.
 */
export function tileImage(row, now = new Date()) {
  const expired = row.kind === 'story' && row.expires_at && new Date(row.expires_at) <= now;
  if (expired) return row.cover_media_id ? `/media/${row.cover_media_id}` : (row.product_image ?? '');
  if (row.thumbnail_url) return row.thumbnail_url;
  if (row.media_url && row.media_type !== 'VIDEO') return row.media_url;
  return row.product_image ?? '';
}

/** The words a tile carries: the owner's headline, else the start of the caption. */
export const tileTitle = (row) => String(row.headline || row.caption || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Reel';

const refuse = (code, message, fields) => new ApiError(code, message, fields ? { fields } : undefined);

export function categorySequencesRepo(db) {
  const t0 = () => tenantId();

  /** Locks the category for the rest of the transaction, so two saves of one order never interleave. False when it isn't this business's. */
  async function lockCategory(t, categoryId) {
    const [row] = await t.query('SELECT id FROM categories WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [t0(), categoryId]);
    return Boolean(row);
  }

  async function pageExists(t, pageId) {
    const [row] = await t.query('SELECT id FROM reels WHERE tenant_id = $1 AND id = $2', [t0(), pageId]);
    return Boolean(row);
  }

  async function member(t, categoryId, pageId) {
    const [row] = await t.query('SELECT * FROM category_reels WHERE tenant_id = $1 AND category_id = $2 AND page_id = $3', [t0(), categoryId, pageId]);
    return row ?? null;
  }

  /** Closes up the positions (0, 1, 2, ...) keeping their order; pinned reels keep their place among them. */
  async function renumber(t, categoryId) {
    await t.query(
      `UPDATE category_reels cr SET position = n.rn - 1
       FROM (SELECT page_id, row_number() OVER (ORDER BY position, page_id) AS rn FROM category_reels WHERE tenant_id = $1 AND category_id = $2) n
       WHERE cr.tenant_id = $1 AND cr.category_id = $2 AND cr.page_id = n.page_id AND cr.position <> n.rn - 1`,
      [t0(), categoryId],
    );
  }

  async function renumberPins(t, categoryId) {
    await t.query(
      `UPDATE category_reels cr SET pin_position = n.rn - 1
       FROM (SELECT page_id, row_number() OVER (ORDER BY pin_position, page_id) AS rn FROM category_reels WHERE tenant_id = $1 AND category_id = $2 AND pinned) n
       WHERE cr.tenant_id = $1 AND cr.category_id = $2 AND cr.page_id = n.page_id AND cr.pin_position <> n.rn - 1`,
      [t0(), categoryId],
    );
  }

  /**
   * Puts a page in a category at the top or the bottom. Returns false when it is already there, or when a rule tries to add a
   * page the owner removed from this category (8.13). An owner adding it again clears that removal.
   */
  async function insert(t, categoryId, pageId, { at = 'bottom', joinedBy = 'owner', ruleId = null } = {}) {
    if (await member(t, categoryId, pageId)) return false;
    if (joinedBy === 'rule') {
      const [removed] = await t.query('SELECT 1 FROM category_reel_removals WHERE tenant_id = $1 AND category_id = $2 AND page_id = $3', [t0(), categoryId, pageId]);
      if (removed) return false;
    }
    let position;
    if (at === 'top') {
      await t.query('UPDATE category_reels SET position = position + 1 WHERE tenant_id = $1 AND category_id = $2', [t0(), categoryId]);
      position = 0;
    } else {
      const [{ next }] = await t.query('SELECT COALESCE(max(position) + 1, 0)::int AS next FROM category_reels WHERE tenant_id = $1 AND category_id = $2', [t0(), categoryId]);
      position = next;
    }
    await t.query(
      `INSERT INTO category_reels (tenant_id, category_id, page_id, position, joined_by, rule_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [t0(), categoryId, pageId, position, joinedBy, ruleId],
    );
    if (joinedBy === 'owner') await t.query('DELETE FROM category_reel_removals WHERE tenant_id = $1 AND category_id = $2 AND page_id = $3', [t0(), categoryId, pageId]);
    return true;
  }

  async function takeOut(t, categoryId, pageId) {
    const [gone] = await t.query('DELETE FROM category_reels WHERE tenant_id = $1 AND category_id = $2 AND page_id = $3 RETURNING page_id', [t0(), categoryId, pageId]);
    if (!gone) return false;
    await t.query(
      `INSERT INTO category_reel_removals (tenant_id, category_id, page_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, category_id, page_id) DO UPDATE SET removed_at = now()`,
      [t0(), categoryId, pageId],
    );
    await renumber(t, categoryId);
    await renumberPins(t, categoryId);
    return true;
  }

  /** Runs `change` with the category locked; null when the category isn't this business's. */
  async function withCategory(categoryId, change) {
    return db.tx(async (t) => {
      if (!(await lockCategory(t, categoryId))) return null;
      return change(t);
    });
  }

  async function requirePage(t, categoryId, pageId) {
    if (!(await member(t, categoryId, pageId))) throw refuse('not_found', 'That reel isn’t in this category.');
  }

  // ---- rules ----------------------------------------------------------------------------------------------------------

  /** The pages a set of rules looks at, with what they match on. */
  async function candidatePages(runner, { since = null, pageIds = null } = {}) {
    return runner.query(
      `SELECT r.id AS page_id, r.caption, r.headline, r.created_at,
         ARRAY(SELECT DISTINCT pc.category_id FROM reel_products rp JOIN product_categories pc ON pc.tenant_id = rp.tenant_id AND pc.product_id = rp.product_id
               WHERE rp.tenant_id = r.tenant_id AND rp.reel_id = r.ig_media_id) AS product_category_ids
       FROM reels r
       WHERE r.tenant_id = $1 AND ($2::timestamptz IS NULL OR r.created_at >= $2) AND ($3::int[] IS NULL OR r.id = ANY($3::int[]))
       ORDER BY r.created_at ASC, r.id ASC LIMIT 2000`,
      [t0(), since, pageIds],
    );
  }

  const pageForMatch = (row) => ({ caption: row.caption, headline: row.headline, productCategoryIds: (row.product_category_ids ?? []).map(Number) });

  /**
   * Joins pages to every active rule's category they match. `fresh` limits each rule to pages made since it last changed
   * (new reels only); "Apply to existing reels" passes one rule and every page. Returns how many joins were made.
   */
  async function joinMatching(rules, pages, { fresh = true } = {}) {
    let added = 0;
    for (const page of pages) {
      for (const rule of rules) {
        if (!rule.active) continue;
        if (fresh && new Date(page.created_at) < new Date(rule.applies_from)) continue;
        if (!matchesRule(rule, pageForMatch(page))) continue;
        const joined = await withCategory(rule.category_id, (t) => insert(t, rule.category_id, page.page_id, { at: rule.join_at, joinedBy: 'rule', ruleId: rule.id }));
        if (joined) added++;
      }
    }
    return added;
  }

  const self = {
    hiddenReason,
    tileImage,
    tileTitle,

    /** The seller's view of one category: every reel in it, live or not, in order. Null when the category isn't this business's. */
    async get(categoryId, { now = new Date() } = {}) {
      const [category] = await db.query('SELECT id FROM categories WHERE tenant_id = $1 AND id = $2', [t0(), categoryId]);
      if (!category) return null;
      const rows = await db.query(
        `SELECT cr.category_id, cr.position, cr.pinned, cr.pin_position, cr.starts_at, cr.ends_at, cr.joined_by, cr.rule_id, ${PAGE_COLS}
         FROM category_reels cr JOIN reels r ON r.tenant_id = cr.tenant_id AND r.id = cr.page_id
         WHERE cr.tenant_id = $1 AND cr.category_id = $2 ORDER BY ${SEQUENCE_ORDER}`,
        [t0(), categoryId],
      );
      return { categoryId, rows: rows.map((row) => ({ ...row, hidden_reason: hiddenReason(row, now) })) };
    },

    /**
     * Saves the whole order at once (8.13): `pinned` in their order, then `order`, the rest in theirs. Both together must be
     * exactly the reels in the category now, or nothing changes. A pinned reel keeps its last unpinned place among the rest.
     */
    async save(categoryId, { pinned = [], order = [] }) {
      return withCategory(categoryId, async (t) => {
        const current = await t.query('SELECT page_id, position, pinned FROM category_reels WHERE tenant_id = $1 AND category_id = $2 ORDER BY position, page_id', [t0(), categoryId]);
        const wanted = [...pinned, ...order];
        const known = new Set(current.map((r) => r.page_id));
        if (new Set(wanted).size !== wanted.length) throw refuse('validation_failed', 'A reel is in the list twice.', { order: 'A reel is in the list twice' });
        if (wanted.length !== known.size || wanted.some((id) => !known.has(id))) {
          throw refuse('conflict', 'This category changed while you were arranging it. Reload it and try again.');
        }
        // The pinned reels' last unpinned places, kept among the new order of the rest.
        const rankOf = new Map(current.map((r, i) => [r.page_id, i]));
        const full = [...order];
        for (const id of [...pinned].sort((a, b) => rankOf.get(a) - rankOf.get(b))) full.splice(Math.min(rankOf.get(id), full.length), 0, id);
        const pinAt = new Map(pinned.map((id, i) => [id, i]));
        await t.query(
          `UPDATE category_reels cr SET position = v.position, pinned = v.pinned, pin_position = v.pin_position
           FROM unnest($3::int[], $4::int[], $5::boolean[], $6::int[]) AS v(page_id, position, pinned, pin_position)
           WHERE cr.tenant_id = $1 AND cr.category_id = $2 AND cr.page_id = v.page_id`,
          [t0(), categoryId, full, full.map((_, i) => i), full.map((id) => pinAt.has(id)), full.map((id) => (pinAt.has(id) ? pinAt.get(id) : null))],
        );
        return true;
      });
    },

    /** Adds a page at the top or the bottom (owner). Null when the category isn't this business's; 404 when the page isn't. */
    async add(categoryId, pageId, { at = 'bottom' } = {}) {
      return withCategory(categoryId, async (t) => {
        if (!(await pageExists(t, pageId))) throw refuse('not_found', 'That reel isn’t in your account.');
        await insert(t, categoryId, pageId, { at, joinedBy: 'owner' });
        return true;
      });
    },

    /** Takes a page out; the others close up, and no rule adds it back to this category. */
    async remove(categoryId, pageId) {
      return withCategory(categoryId, async (t) => {
        await requirePage(t, categoryId, pageId);
        await takeOut(t, categoryId, pageId);
        return true;
      });
    },

    /** Pins to the top of the pinned reels. Pinning a pinned reel changes nothing. */
    async pin(categoryId, pageId) {
      return withCategory(categoryId, async (t) => {
        const row = await member(t, categoryId, pageId);
        if (!row) throw refuse('not_found', 'That reel isn’t in this category.');
        if (row.pinned) return true;
        await t.query('UPDATE category_reels SET pin_position = pin_position + 1 WHERE tenant_id = $1 AND category_id = $2 AND pinned', [t0(), categoryId]);
        await t.query('UPDATE category_reels SET pinned = true, pin_position = 0 WHERE tenant_id = $1 AND category_id = $2 AND page_id = $3', [t0(), categoryId, pageId]);
        return true;
      });
    },

    /** Unpins: the reel goes back to its last unpinned place, which it kept all along. */
    async unpin(categoryId, pageId) {
      return withCategory(categoryId, async (t) => {
        await requirePage(t, categoryId, pageId);
        await t.query('UPDATE category_reels SET pinned = false, pin_position = NULL WHERE tenant_id = $1 AND category_id = $2 AND page_id = $3', [t0(), categoryId, pageId]);
        await renumberPins(t, categoryId);
        return true;
      });
    },

    /** A window in this category only (K-46); both null clears it. */
    async schedule(categoryId, pageId, { startsAt = null, endsAt = null }) {
      return withCategory(categoryId, async (t) => {
        await requirePage(t, categoryId, pageId);
        await t.query('UPDATE category_reels SET starts_at = $4, ends_at = $5 WHERE tenant_id = $1 AND category_id = $2 AND page_id = $3', [t0(), categoryId, pageId, startsAt, endsAt]);
        return true;
      });
    },

    /** The category ids a page is in, in category order. For the landing page editor's categoryIds. */
    async categoriesOfPage(pageId) {
      const rows = await db.query(
        `SELECT cr.category_id FROM category_reels cr JOIN categories c ON c.tenant_id = cr.tenant_id AND c.id = cr.category_id
         WHERE cr.tenant_id = $1 AND cr.page_id = $2 ORDER BY c.position, c.name, c.id`,
        [t0(), pageId],
      );
      return rows.map((r) => r.category_id);
    },

    /**
     * Sets which categories a page is in, from the landing page editor (pages module): new ones join at the bottom, ones left out
     * are removed as the owner removing them. Throws a 400 when one isn't this business's.
     */
    async setPageCategories(pageId, categoryIds) {
      const wanted = [...new Set(categoryIds.map(Number))];
      const found = wanted.length ? await db.query('SELECT id FROM categories WHERE tenant_id = $1 AND id = ANY($2::int[])', [t0(), wanted]) : [];
      if (found.length !== wanted.length) throw refuse('validation_failed', 'One of the categories no longer exists.', { categoryIds: 'One of the categories no longer exists' });
      const now = await self.categoriesOfPage(pageId);
      for (const id of now.filter((c) => !wanted.includes(c))) await withCategory(id, (t) => takeOut(t, id, pageId));
      for (const id of wanted.filter((c) => !now.includes(c))) {
        await withCategory(id, async (t) => {
          if (!(await pageExists(t, pageId))) throw refuse('not_found', 'That reel isn’t in your account.');
          return insert(t, id, pageId, { at: 'bottom', joinedBy: 'owner' });
        });
      }
      return self.categoriesOfPage(pageId);
    },

    /** How many reels each category holds, live or not: { categoryId: count }. */
    async reelCounts() {
      const rows = await db.query('SELECT category_id, count(*)::int AS n FROM category_reels WHERE tenant_id = $1 GROUP BY category_id', [t0()]);
      return new Map(rows.map((r) => [r.category_id, r.n]));
    },

    /** The category order for shelves and chips: every category id of the business, in the order wanted. */
    async reorderCategories(ids) {
      return db.tx(async (t) => {
        const all = await t.query('SELECT id FROM categories WHERE tenant_id = $1 FOR UPDATE', [t0()]);
        const known = new Set(all.map((r) => r.id));
        if (new Set(ids).size !== ids.length) throw refuse('validation_failed', 'A category is in the list twice.', { ids: 'A category is in the list twice' });
        if (ids.length !== known.size || ids.some((id) => !known.has(id))) throw refuse('conflict', 'Your categories changed while you were arranging them. Reload and try again.');
        await t.query(
          'UPDATE categories c SET position = v.position FROM unnest($2::int[], $3::int[]) AS v(id, position) WHERE c.tenant_id = $1 AND c.id = v.id',
          [t0(), ids, ids.map((_, i) => i + 1)],
        );
      });
    },

    // ---- what buyer pages read ------------------------------------------------------------------------------------------

    /** One category's live reels in order (the category page, the Reels tab chip, a creator shelf). */
    async live(categoryId, { now = new Date(), limit = 60, offset = 0 } = {}) {
      return db.query(
        `SELECT cr.category_id, cr.pinned, ${PAGE_COLS} FROM category_reels cr JOIN reels r ON r.tenant_id = cr.tenant_id AND r.id = cr.page_id
         WHERE cr.tenant_id = $1 AND cr.category_id = $2 AND ${LIVE_PAGE} AND ${IN_WINDOW('$3')}
         ORDER BY ${SEQUENCE_ORDER} LIMIT $4 OFFSET $5`,
        [t0(), categoryId, now, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)],
      );
    },

    /**
     * Every visible category's live reels, in category order then each sequence's order (K-48, K-49): [{ category, items, total }],
     * at most `perCategory` items each. Categories with no live reel are left out.
     */
    async liveShelves({ now = new Date(), perCategory = 60 } = {}) {
      const categories = await db.query('SELECT id, name, slug, image_url, description, position FROM categories WHERE tenant_id = $1 AND visible ORDER BY position, name, id', [t0()]);
      if (!categories.length) return [];
      const rows = await db.query(
        `SELECT * FROM (
           SELECT cr.category_id, cr.pinned, ${PAGE_COLS},
             row_number() OVER (PARTITION BY cr.category_id ORDER BY ${SEQUENCE_ORDER}) AS rank,
             count(*) OVER (PARTITION BY cr.category_id) AS total
           FROM category_reels cr JOIN reels r ON r.tenant_id = cr.tenant_id AND r.id = cr.page_id
           WHERE cr.tenant_id = $1 AND cr.category_id = ANY($2::int[]) AND ${LIVE_PAGE} AND ${IN_WINDOW('$3')}
         ) s WHERE s.rank <= $4 ORDER BY s.category_id, s.rank`,
        [t0(), categories.map((c) => c.id), now, Math.min(Math.max(perCategory, 1), 500)],
      );
      const byCategory = new Map();
      for (const row of rows) {
        if (!byCategory.has(row.category_id)) byCategory.set(row.category_id, { items: [], total: Number(row.total) });
        byCategory.get(row.category_id).items.push(row);
      }
      return categories.filter((c) => byCategory.has(c.id)).map((c) => ({ category: c, ...byCategory.get(c.id) }));
    },

    /** Live reels in no visible category, newest first: the creator page's "More reels" shelf and the end of the Reels tab's All. */
    async liveUncategorized({ limit = 60, offset = 0 } = {}) {
      return db.query(
        `SELECT ${PAGE_COLS}, count(*) OVER () AS total FROM reels r
         WHERE r.tenant_id = $1 AND ${LIVE_PAGE}
           AND NOT EXISTS (SELECT 1 FROM category_reels cr JOIN categories c ON c.tenant_id = cr.tenant_id AND c.id = cr.category_id
                           WHERE cr.tenant_id = r.tenant_id AND cr.page_id = r.id AND c.visible)
         ORDER BY ${NEWEST_FIRST} LIMIT $2 OFFSET $3`,
        [t0(), Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)],
      );
    },

    /**
     * The "More reels" strip of a landing page (K-42): the live reels of the page's categories, in category order and each
     * sequence's order, without the page itself and without repeats; with no category, the newest live reels.
     */
    async moreReelsFor(pageId, { now = new Date(), limit = 6 } = {}) {
      const ids = await self.categoriesOfPage(pageId);
      const seen = new Set([Number(pageId)]);
      const out = [];
      for (const id of ids) {
        for (const row of await self.live(id, { now, limit: limit + 1 })) {
          if (seen.has(row.page_id)) continue;
          seen.add(row.page_id);
          out.push(row);
          if (out.length >= limit) return out;
        }
      }
      if (!ids.length) {
        const rows = await db.query(`SELECT ${PAGE_COLS} FROM reels r WHERE r.tenant_id = $1 AND ${LIVE_PAGE} AND r.id <> $2 ORDER BY ${NEWEST_FIRST} LIMIT $3`, [t0(), Number(pageId), limit]);
        out.push(...rows);
      }
      return out;
    },

    /**
     * The creator page's search (8.14, K-60): this business's live reels whose caption or title holds every word, and the live
     * reels of the products found. `terms` are already made literal for LIKE (likeText).
     */
    async searchLive(terms, { productIds = [], limit = 24 } = {}) {
      if (!terms.length && !productIds.length) return [];
      return db.query(
        `SELECT ${PAGE_COLS} FROM reels r
         WHERE r.tenant_id = $1 AND ${LIVE_PAGE} AND (
           (cardinality($2::text[]) > 0 AND (SELECT bool_and(r.caption ILIKE '%' || term || '%' ESCAPE '\\' OR r.headline ILIKE '%' || term || '%' ESCAPE '\\') FROM unnest($2::text[]) term))
           OR EXISTS (SELECT 1 FROM reel_products rp WHERE rp.tenant_id = r.tenant_id AND rp.reel_id = r.ig_media_id AND rp.product_id = ANY($3::int[])))
         ORDER BY ${NEWEST_FIRST} LIMIT $4`,
        [t0(), terms, productIds, Math.min(Math.max(limit, 1), 100)],
      );
    },

    // ---- rules --------------------------------------------------------------------------------------------------------

    async rules(categoryId) {
      return db.query('SELECT * FROM category_rules WHERE tenant_id = $1 AND category_id = $2 ORDER BY id', [t0(), categoryId]);
    },

    async getRule(id) {
      const [row] = await db.query('SELECT * FROM category_rules WHERE tenant_id = $1 AND id = $2', [t0(), id]);
      return row ?? null;
    },

    /** Null when the category isn't this business's; a 400 when the product category isn't. */
    async addRule(categoryId, rule) {
      const [category] = await db.query('SELECT id FROM categories WHERE tenant_id = $1 AND id = $2', [t0(), categoryId]);
      if (!category) return null;
      const productCategory = rule.match === 'product_category' ? rule.productCategoryId : null;
      if (productCategory) {
        const [found] = await db.query('SELECT id FROM categories WHERE tenant_id = $1 AND id = $2', [t0(), productCategory]);
        if (!found) throw refuse('validation_failed', 'That product category no longer exists.', { productCategoryId: 'That product category no longer exists' });
      }
      const value = rule.match === 'product_category' ? '' : rule.value;
      const [row] = await db.query(
        `INSERT INTO category_rules (tenant_id, category_id, match, value, product_category_id, join_at, active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [t0(), categoryId, rule.match, value, productCategory, rule.joinAt, rule.active],
      );
      return row;
    },

    /** A changed rule applies to new reels only (8.13): its applies_from moves to now. Saving it unchanged changes nothing. */
    async updateRule(id, patch) {
      const current = await self.getRule(id);
      if (!current) return null;
      const next = {
        value: patch.value ?? current.value,
        join_at: patch.joinAt ?? current.join_at,
        active: patch.active ?? current.active,
      };
      if (current.match !== 'product_category' && next.value === '') throw refuse('validation_failed', 'Say what the rule matches.', { value: 'Say what the rule matches' });
      if (current.match === 'product_category') next.value = '';
      const changed = next.value !== current.value || next.join_at !== current.join_at || next.active !== current.active;
      if (!changed) return current;
      const [row] = await db.query(
        `UPDATE category_rules SET value = $3, join_at = $4, active = $5, applies_from = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [t0(), id, next.value, next.join_at, next.active],
      );
      return row ?? null;
    },

    async removeRule(id) {
      const [row] = await db.query('DELETE FROM category_rules WHERE tenant_id = $1 AND id = $2 RETURNING id', [t0(), id]);
      return Boolean(row);
    },

    /** "Apply to existing reels": every page the rule matches joins now, except ones the owner removed from that category. */
    async applyRule(id) {
      const rule = await self.getRule(id);
      if (!rule) return null;
      if (!rule.active) return 0;
      return joinMatching([rule], await candidatePages(db), { fresh: false });
    },

    /**
     * Rules for new pages: each active rule adds the matching pages made since it last changed. Called by the pages module when
     * a page is made or its caption or products change (`pageIds`), and by the job every minute for pages made in `sinceMs`.
     */
    async joinByRules({ pageIds = null, sinceMs = 3 * 24 * 3_600_000 } = {}) {
      const rules = await db.query('SELECT * FROM category_rules WHERE tenant_id = $1 AND active ORDER BY id', [t0()]);
      if (!rules.length) return 0;
      const oldest = rules.reduce((min, r) => (new Date(r.applies_from) < min ? new Date(r.applies_from) : min), new Date());
      const since = pageIds ? null : new Date(Math.max(oldest.getTime(), Date.now() - sinceMs));
      return joinMatching(rules, await candidatePages(db, { since, pageIds }));
    },
  };
  return self;
}

import { ApiError } from '../../contracts/api/index.js';
import { PLAN_REASON } from '../../contracts/catalog.js';
import { writeAudit } from '../audit/index.js';
import { retryOnRace } from '../admin-api/errors.js';
import { mapPage, pageOf } from '../admin-api/paging.js';

/**
 * The seller API for categories (PRD 8.1, 8.13). The Phase 0 handlers of categories.list, .get, .create and .update are replaced
 * (takesOver) only to add each category's reel count; everything else about a category stays as admin-api had it.
 */

const toCategory = (c, counts) => ({
  id: c.id,
  name: c.name,
  slug: c.slug,
  imageUrl: c.image_url,
  description: c.description,
  position: c.position,
  visible: c.visible,
  productCount: c.product_count,
  reelCount: counts.get(c.id) ?? 0,
});

const categoryInput = (c) => ({ name: c.name, slug: c.slug, image_url: c.imageUrl, description: c.description, position: c.position, visible: c.visible });

export function toSequenceItem(row) {
  return {
    pageId: row.page_id,
    slug: row.slug,
    kind: row.kind,
    headline: row.headline || String(row.caption ?? '').slice(0, 80),
    thumbnailUrl: row.thumbnail_url_for_tile,
    position: row.position,
    pinned: row.pinned,
    pinPosition: row.pin_position,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    joinedBy: row.joined_by,
    live: row.hidden_reason === '',
    hiddenReason: row.hidden_reason,
  };
}

export const toRule = (r) => ({
  id: r.id,
  categoryId: r.category_id,
  match: r.match,
  value: r.value,
  productCategoryId: r.product_category_id,
  joinAt: r.join_at,
  active: r.active,
  appliesFrom: r.applies_from,
  createdAt: r.created_at,
});

export function categoryTakeovers({ repos }) {
  const sequences = () => repos.categorySequences;
  async function nextPosition() {
    const all = await repos.categories.list();
    return all.length ? Math.max(...all.map((c) => c.position)) + 1 : 1;
  }
  async function one(id) {
    const category = await repos.categories.get(id);
    return category ? toCategory(category, await sequences().reelCounts()) : null;
  }
  return {
    'categories.list': async ({ query }) => {
      const [rows, counts] = await Promise.all([repos.categories.list(), sequences().reelCounts()]);
      return mapPage(pageOf(rows, query, (c) => [c.position, c.name.toLowerCase(), c.id]), (c) => toCategory(c, counts));
    },
    'categories.get': ({ params }) => one(params.id),
    'categories.create': async ({ body }) => {
      const position = body.position ?? (await nextPosition());
      const saved = await retryOnRace(() => repos.categories.save(null, categoryInput({ imageUrl: '', description: '', visible: true, ...body, position })));
      return one(saved.id);
    },
    'categories.update': async ({ params, body }) => {
      const current = await one(params.id);
      if (!current) return null;
      await retryOnRace(() => repos.categories.save(current.id, categoryInput({ ...current, ...body })));
      return one(current.id);
    },
  };
}

export function categoriesApi({ db, repos, config }) {
  const sequences = () => repos.categorySequences;
  const now = () => new Date((config?.pagesNow ?? Date.now)());

  /** Ordering, pins, schedules and rules are tier 2 (8.13). Reading the order is never refused. */
  async function needSequences() {
    if (!(await repos.entitlements.can('category_sequences'))) throw new ApiError('forbidden', 'Reel order by category isn’t on your plan.', { reason: PLAN_REASON });
  }

  async function sequence(categoryId) {
    const found = await sequences().get(categoryId, { now: now() });
    if (!found) return null;
    return {
      categoryId,
      items: found.rows.map((row) => toSequenceItem({ ...row, thumbnail_url_for_tile: sequences().tileImage(row, now()) })),
    };
  }

  /** Runs a change to one category's order, writes the audit row, and answers the new order. */
  async function change(categoryId, user, action, details, run) {
    await needSequences();
    const done = await run();
    if (done === null) return null;
    await writeAudit(db, { actor: `user:${user.id}`, action, target: `category:${categoryId}`, details });
    return sequence(categoryId);
  }

  async function ruleOrMissing(id) {
    const rule = await sequences().getRule(id);
    if (!rule) throw new ApiError('not_found');
    return rule;
  }

  return {
    'categories.reorder': async ({ body, user }) => {
      await sequences().reorderCategories(body.ids);
      await writeAudit(db, { actor: `user:${user.id}`, action: 'categories.reordered', target: 'categories', details: { count: body.ids.length } });
    },
    'categories.reels': ({ params }) => sequence(params.id),
    'categories.setReels': ({ params, body, user }) =>
      change(params.id, user, 'category.reels_saved', { pinned: body.pinned.length, count: body.pinned.length + body.order.length }, () => sequences().save(params.id, body)),
    'categories.addReel': ({ params, body, user }) =>
      change(params.id, user, 'category.reel_added', { pageId: body.pageId, at: body.at }, () => sequences().add(params.id, body.pageId, { at: body.at })),
    'categories.removeReel': ({ params, body, user }) =>
      change(params.id, user, 'category.reel_removed', { pageId: body.pageId }, () => sequences().remove(params.id, body.pageId)),
    'categories.pin': ({ params, body, user }) =>
      change(params.id, user, 'category.reel_pinned', { pageId: body.pageId }, () => sequences().pin(params.id, body.pageId)),
    'categories.unpin': ({ params, body, user }) =>
      change(params.id, user, 'category.reel_unpinned', { pageId: body.pageId }, () => sequences().unpin(params.id, body.pageId)),
    'categories.schedule': ({ params, body, user }) =>
      change(params.id, user, 'category.reel_scheduled', { pageId: body.pageId, startsAt: body.startsAt, endsAt: body.endsAt }, () =>
        sequences().schedule(params.id, body.pageId, { startsAt: body.startsAt, endsAt: body.endsAt })),

    'categories.rules': async ({ params }) => {
      if (!(await repos.categories.get(params.id))) return null;
      return { items: (await sequences().rules(params.id)).map(toRule) };
    },
    'categories.addRule': async ({ params, body, user }) => {
      await needSequences();
      const rule = await sequences().addRule(params.id, body);
      if (!rule) return null;
      await writeAudit(db, { actor: `user:${user.id}`, action: 'category.rule_added', target: `category:${params.id}`, details: { ruleId: rule.id, match: rule.match, joinAt: rule.join_at } });
      return toRule(rule);
    },
    'categoryRules.update': async ({ params, body, user }) => {
      await needSequences();
      const rule = await sequences().updateRule(params.id, body);
      if (!rule) return null;
      await writeAudit(db, { actor: `user:${user.id}`, action: 'category.rule_changed', target: `category:${rule.category_id}`, details: { ruleId: rule.id, active: rule.active, joinAt: rule.join_at } });
      return toRule(rule);
    },
    'categoryRules.remove': async ({ params, user }) => {
      const rule = await ruleOrMissing(params.id);
      await sequences().removeRule(params.id);
      await writeAudit(db, { actor: `user:${user.id}`, action: 'category.rule_removed', target: `category:${rule.category_id}`, details: { ruleId: rule.id } });
    },
    'categoryRules.apply': async ({ params, user }) => {
      await needSequences();
      const rule = await ruleOrMissing(params.id);
      const added = await sequences().applyRule(params.id);
      await writeAudit(db, { actor: `user:${user.id}`, action: 'category.rule_applied', target: `category:${rule.category_id}`, details: { ruleId: rule.id, added } });
      return { added };
    },
  };
}

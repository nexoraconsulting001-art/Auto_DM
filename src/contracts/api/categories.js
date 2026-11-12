import { z } from 'zod';
import { staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, MediaLinkOrEmpty, Timestamp, page, required, text } from './common.js';

/**
 * Catalog categories (PRD 8.1) and each one's ordered reels (8.13), answered by src/modules/categories. One stored order per
 * category per business; the category page, the Reels tab, landing pages, the creator page, the store and the apps all read
 * it. A "reel" here is a landing page (pageId), so posts can be in a category too.
 */
const access = staffWith('catalog');

export const Category = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  imageUrl: z.string(),
  description: z.string(),
  position: z.number().int(),
  visible: z.boolean(),
  productCount: Count,
  reelCount: Count.default(0),
});

export const CategoryCreate = z.object({
  name: required(60, 'Name is required'),
  slug: text(60).optional(),
  imageUrl: MediaLinkOrEmpty.optional(),
  description: text(400).optional(),
  position: z.number().int().min(-1000000).max(1000000).optional(),
  visible: z.boolean().optional(),
});
/** Fields left out stay as they are. */
export const CategoryUpdate = CategoryCreate.partial();

/** The category order, for shelves and chips: every category id of the business, in the order wanted. */
export const CategoryOrder = z.object({ ids: z.array(Id).min(1).max(500) });

/** One reel in a category's sequence. `live` is false when it shows nowhere right now, with why (8.13: it keeps its place). */
export const SequenceItem = z.object({
  pageId: Id,
  slug: z.string(),
  kind: z.enum(['reel', 'post', 'story']),
  headline: z.string(),
  thumbnailUrl: z.string(),
  position: Count,
  pinned: z.boolean(),
  pinPosition: Count.nullable(),
  startsAt: Timestamp.nullable(),
  endsAt: Timestamp.nullable(),
  joinedBy: z.enum(['owner', 'rule']),
  live: z.boolean(),
  hiddenReason: z.enum(['', 'inactive', 'no_active_products', 'before_window', 'after_window']),
});
/** Pinned first in their own order, then the rest. */
export const CategorySequence = z.object({ categoryId: Id, items: z.array(SequenceItem) });

/** Saving writes the whole order at once (8.13): the pinned reels in their order, then the rest in theirs. */
export const SequenceSave = z.object({
  pinned: z.array(Id).max(500).default([]),
  order: z.array(Id).max(2000),
});
export const SequenceAdd = z.object({ pageId: Id, at: z.enum(['top', 'bottom']).default('bottom') });
export const SequencePage = z.object({ pageId: Id });
/** A window in this category only (K-46). Both null clears it. */
export const SequenceSchedule = z.object({ pageId: Id, startsAt: z.iso.datetime({ offset: true }).nullable(), endsAt: z.iso.datetime({ offset: true }).nullable() })
  .refine((s) => !s.startsAt || !s.endsAt || Date.parse(s.startsAt) < Date.parse(s.endsAt), { message: 'The end must be after the start', path: ['endsAt'] });

export const RULE_MATCHES = Object.freeze(['caption_keyword', 'hashtag', 'product_category']);
export const CategoryRule = z.object({
  id: Id,
  categoryId: Id,
  match: z.enum(RULE_MATCHES),
  value: z.string(),
  productCategoryId: Id.nullable(),
  joinAt: z.enum(['top', 'bottom']),
  active: z.boolean(),
  appliesFrom: Timestamp,
  createdAt: Timestamp,
});
export const CategoryRuleCreate = z.object({
  match: z.enum(RULE_MATCHES),
  /** A word in the caption, or a hashtag (with or without #). Not used for product_category. */
  value: text(100).default(''),
  productCategoryId: Id.nullable().default(null),
  joinAt: z.enum(['top', 'bottom']).default('bottom'),
  active: z.boolean().default(true),
}).refine((r) => (r.match === 'product_category' ? r.productCategoryId !== null : r.value !== ''), { message: 'Say what the rule matches', path: ['value'] });
export const CategoryRuleUpdate = z.object({ value: text(100), joinAt: z.enum(['top', 'bottom']), active: z.boolean() }).partial();

export const categoryRoutes = {
  'categories.list': { method: 'GET', path: '/categories', access, query: ListQuery, response: page(Category) },
  'categories.create': { method: 'POST', path: '/categories', access, body: CategoryCreate, status: 201, response: Category },
  'categories.reorder': { method: 'PUT', path: '/categories/order', access, body: CategoryOrder, status: 204, response: null },
  'categories.get': { method: 'GET', path: '/categories/:id', access, params: IdParams, response: Category },
  'categories.update': { method: 'PATCH', path: '/categories/:id', access, params: IdParams, body: CategoryUpdate, response: Category },
  'categories.remove': { method: 'DELETE', path: '/categories/:id', access, params: IdParams, status: 204, response: null },
  'categories.reels': { method: 'GET', path: '/categories/:id/reels', access, params: IdParams, response: CategorySequence },
  'categories.setReels': { feature: 'category_sequences', method: 'PUT', path: '/categories/:id/reels', access, params: IdParams, body: SequenceSave, response: CategorySequence },
  'categories.addReel': { feature: 'category_sequences', method: 'POST', path: '/categories/:id/reels', access, params: IdParams, body: SequenceAdd, response: CategorySequence },
  'categories.removeReel': { feature: 'category_sequences', method: 'POST', path: '/categories/:id/reels/remove', access, params: IdParams, body: SequencePage, response: CategorySequence },
  'categories.pin': { feature: 'category_sequences', method: 'POST', path: '/categories/:id/reels/pin', access, params: IdParams, body: SequencePage, response: CategorySequence },
  'categories.unpin': { feature: 'category_sequences', method: 'POST', path: '/categories/:id/reels/unpin', access, params: IdParams, body: SequencePage, response: CategorySequence },
  'categories.schedule': { feature: 'category_sequences', method: 'PUT', path: '/categories/:id/reels/schedule', access, params: IdParams, body: SequenceSchedule, response: CategorySequence },
  'categories.rules': { method: 'GET', path: '/categories/:id/rules', access, params: IdParams, response: z.object({ items: z.array(CategoryRule) }) },
  'categories.addRule': { feature: 'category_sequences', method: 'POST', path: '/categories/:id/rules', access, params: IdParams, body: CategoryRuleCreate, status: 201, response: CategoryRule },
  'categoryRules.update': { feature: 'category_sequences', method: 'PATCH', path: '/category-rules/:id', access, params: IdParams, body: CategoryRuleUpdate, response: CategoryRule },
  'categoryRules.remove': { method: 'DELETE', path: '/category-rules/:id', access, params: IdParams, status: 204, response: null },
  /** "Apply to existing reels": the rule's matches join now, except reels the owner removed from this category. */
  'categoryRules.apply': { feature: 'category_sequences', method: 'POST', path: '/category-rules/:id/apply', access, params: IdParams, response: z.object({ added: Count }) },
};

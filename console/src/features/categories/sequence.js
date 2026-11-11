import { formatDate } from '../../lib/format.js';
import { fromLocalInput } from '../catalog/shared/time.js';

/**
 * A category's reels in their one stored order (PRD 8.13): the pinned ones first in their own order, then the rest. The category
 * page, the Reels tab, landing pages, the creator page and the store all read this order, so it is arranged in one place only.
 */
export const pinnedOf = (items) => items.filter((item) => item.pinned);
export const restOf = (items) => items.filter((item) => !item.pinned);

/** Pinned first, as the screens show them, whatever order the list arrived in. */
export const inShownOrder = (items) => [...pinnedOf(items), ...restOf(items)];

/** A copy with one reel moved a place up (-1) or down (1) among its own kind: a pinned reel never passes an unpinned one. */
export function moveReel(items, pageId, delta) {
  const list = inShownOrder(items);
  const from = list.findIndex((item) => item.pageId === pageId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length || list[from].pinned !== list[to].pinned) return list;
  [list[from], list[to]] = [list[to], list[from]];
  return list;
}

/** Whether a reel can move that way, for switching its arrow off. */
export function canMove(items, pageId, delta) {
  const list = inShownOrder(items);
  const from = list.findIndex((item) => item.pageId === pageId);
  const to = from + delta;
  return from >= 0 && to >= 0 && to < list.length && list[from].pinned === list[to].pinned;
}

/** The whole order as the API takes it (SequenceSave). */
export const sequenceBody = (items) => ({ pinned: pinnedOf(items).map((item) => item.pageId), order: restOf(items).map((item) => item.pageId) });

const ids = (items) => inShownOrder(items).map((item) => item.pageId).join(',');
/** True when the owner has moved something that isn't saved yet. */
export const orderChanged = (saved, arranged) => ids(saved) !== ids(arranged);

const KIND = { reel: 'Reel', post: 'Post', story: 'Story' };
export const reelTitle = (item) => item.headline || `/r/${item.slug}`;
export const reelKind = (item) => KIND[item.kind] ?? 'Reel';

const HIDDEN = {
  inactive: 'Its page is off, so it shows nowhere. It keeps its place.',
  no_active_products: 'All its products are archived, so it shows nowhere. It keeps its place.',
};

/** What to say under a reel: its window, and why it shows nowhere right now when it doesn't (it keeps its place, 8.13). */
export function reelNotes(item) {
  const notes = [];
  if (item.hiddenReason === 'before_window' && item.startsAt) notes.push(`Shows from ${formatDate(item.startsAt)}`);
  else if (item.hiddenReason === 'after_window' && item.endsAt) notes.push(`Stopped showing on ${formatDate(item.endsAt)}`);
  else if (item.startsAt && item.endsAt) notes.push(`Shows ${formatDate(item.startsAt)} to ${formatDate(item.endsAt)}`);
  else if (item.startsAt) notes.push(`Showing since ${formatDate(item.startsAt)}`);
  else if (item.endsAt) notes.push(`Shows until ${formatDate(item.endsAt)}`);
  if (HIDDEN[item.hiddenReason]) notes.push(HIDDEN[item.hiddenReason]);
  if (item.joinedBy === 'rule') notes.push('Added by a rule');
  return notes;
}

/** A window in this category only (K-46), as the API takes it, or why not. Both empty clears it. */
export function windowBody(pageId, startText, endText) {
  const startsAt = fromLocalInput(startText);
  const endsAt = fromLocalInput(endText);
  if (startsAt === undefined) return { errors: { startsAt: 'Pick a date and time' } };
  if (endsAt === undefined) return { errors: { endsAt: 'Pick a date and time' } };
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) return { errors: { endsAt: 'The end must be after the start' } };
  return { body: { pageId, startsAt, endsAt } };
}

// ---- rules that add new reels by themselves ----------------------------------------------------------------------------------

export const MATCH_CHOICES = Object.freeze([['caption_keyword', 'A word in the caption'], ['hashtag', 'A hashtag'], ['product_category', 'A product from a category']]);
export const JOIN_CHOICES = Object.freeze([['top', 'At the top'], ['bottom', 'At the bottom']]);
export const EMPTY_RULE = Object.freeze({ match: 'caption_keyword', value: '', productCategoryId: '', joinAt: 'top' });

/** A new rule as the API takes it (CategoryRuleCreate), or `errors` by field. */
export function ruleBody(form) {
  if (form.match === 'product_category') {
    if (!/^\d+$/.test(String(form.productCategoryId))) return { errors: { productCategoryId: 'Pick a category' } };
    return { body: { match: form.match, value: '', productCategoryId: Number(form.productCategoryId), joinAt: form.joinAt, active: true } };
  }
  const value = form.value.trim().replace(/^#+/, form.match === 'hashtag' ? '' : '$&');
  if (!value) return { errors: { value: form.match === 'hashtag' ? 'Type the hashtag' : 'Type the word' } };
  if (value.length > 100) return { errors: { value: 'Use 100 characters or fewer' } };
  if (form.match === 'hashtag' && /\s/.test(value)) return { errors: { value: 'A hashtag has no spaces' } };
  return { body: { match: form.match, value, productCategoryId: null, joinAt: form.joinAt, active: true } };
}

/** A rule in a sentence, as the mockup words it: "New reels with “diwali” in the caption join at the top". */
export function ruleText(rule, categories = []) {
  const where = rule.joinAt === 'top' ? 'join at the top' : 'join at the bottom';
  if (rule.match === 'hashtag') return `New reels with #${String(rule.value).replace(/^#+/, '')} ${where}`;
  if (rule.match === 'product_category') {
    const name = categories.find((category) => category.id === rule.productCategoryId)?.name;
    return `New reels with a product from ${name ?? 'a category that was deleted'} ${where}`;
  }
  return `New reels with “${rule.value}” in the caption ${where}`;
}

export const ruleState = (rule) => (rule.active ? 'Matched from each new caption' : 'Paused. New reels are not added.');

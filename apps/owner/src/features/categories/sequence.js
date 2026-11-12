/**
 * Pure: a category's reel sequence (PRD 8.13) as the owner app edits it. The server keeps one order per category:
 * the pinned reels first in their own order, then the rest in theirs. A reel keeps its place among the rest while it
 * is pinned, so unpinning puts it back where it was. Saving writes the whole order at once ({ pinned, order }).
 *
 * Every change is shown at once and sent; if the server refuses or can't be reached, the list goes back to what it
 * was before the change (`optimistic`). Nothing is queued for later: a reorder needs a connection.
 */

/** The pinned reels in pin order, and the rest in their order. */
export function splitSequence(items) {
  const list = Array.isArray(items) ? items : [];
  const pinned = list.filter((i) => i.pinned).sort((a, b) => (a.pinPosition ?? 0) - (b.pinPosition ?? 0));
  const rest = list.filter((i) => !i.pinned).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return { pinned, rest };
}

/** The list as shown: pinned first, then the rest, with positions written from where each now stands. */
export function arrange(items) {
  const { pinned, rest } = splitSequence(items);
  return [
    ...pinned.map((item, i) => ({ ...item, pinPosition: i })),
    ...rest.map((item, i) => ({ ...item, position: i })),
  ];
}

/** `list` with the item at `from` moved to `to` (both clamped). A new array; the old one is untouched. */
export function moveItem(list, from, to) {
  const items = [...(Array.isArray(list) ? list : [])];
  if (!items.length) return items;
  const a = Math.max(0, Math.min(items.length - 1, from));
  const b = Math.max(0, Math.min(items.length - 1, to));
  if (a === b) return items;
  const [moved] = items.splice(a, 1);
  items.splice(b, 0, moved);
  return items;
}

/** Where a row dragged by `dy` points from `from` lands, for rows `rowHeight` tall in a list of `count`. */
export function indexAfterDrag(from, dy, rowHeight, count) {
  if (!(rowHeight > 0) || !(count > 0)) return from;
  const steps = Math.round((Number(dy) || 0) / rowHeight);
  return Math.max(0, Math.min(count - 1, from + steps));
}

/**
 * The shown list after moving the row at `from` to `to`. A reel moves within its own group: a pinned reel among the
 * pinned, any other among the rest. Moving across the line is pinning or unpinning, which have their own buttons.
 */
export function reorder(shown, from, to) {
  const { pinned, rest } = splitSequence(shown);
  const inPinned = from < pinned.length;
  if (inPinned) {
    const target = Math.min(to, pinned.length - 1);
    return arrange([...moveItem(pinned, from, target).map((item, i) => ({ ...item, pinPosition: i })), ...rest]);
  }
  const target = Math.max(0, to - pinned.length);
  return arrange([...pinned, ...moveItem(rest, from - pinned.length, target).map((item, i) => ({ ...item, position: i }))]);
}

/** Pin a reel: it goes to the end of the pinned group and keeps its place among the rest for when it is unpinned. */
export function pin(shown, pageId) {
  const { pinned } = splitSequence(shown);
  return arrange(shown.map((item) => (item.pageId === pageId && !item.pinned ? { ...item, pinned: true, pinPosition: pinned.length } : item)));
}

/** Unpin a reel: it goes back to the place it kept among the rest. */
export function unpin(shown, pageId) {
  return arrange(shown.map((item) => (item.pageId === pageId && item.pinned ? { ...item, pinned: false, pinPosition: null } : item)));
}

/** The body of categories.setReels for the shown list: every reel, pinned ones in pin order, the rest in theirs. */
export function saveBody(shown) {
  const { pinned, rest } = splitSequence(shown);
  return { pinned: pinned.map((i) => i.pageId), order: rest.map((i) => i.pageId) };
}

/**
 * Shows `next` at once, then runs `send`. If it fails, puts back what was shown before and rethrows, so the screen
 * can say why. `read` and `write` get and set what is shown (react-query's cache, or state).
 */
export async function optimistic({ read, write, next, send }) {
  const before = read();
  write(next);
  try {
    return await send();
  } catch (error) {
    write(before);
    throw error;
  }
}

/** Why a reel shows nowhere right now, as a string key (it keeps its place either way). */
export const HIDDEN_KEYS = Object.freeze({
  inactive: 'categories.hidden.inactive',
  no_active_products: 'categories.hidden.noProducts',
  before_window: 'categories.hidden.before',
  after_window: 'categories.hidden.after',
});

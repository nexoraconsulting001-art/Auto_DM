/** Pure rules of the "Done by Bhava team" feed (PRD 5.17): words for services and states, and a short summary of what a change touched. */
export const SERVICE_WORDS = Object.freeze({
  reel_management: 'Reel management',
  reel_backlog: 'Reel backlog',
  merchandising: 'Merchandising',
  catalog_management: 'Catalog management',
  performance_report: 'Performance report',
});
export const SERVICE_KEYS = Object.freeze(Object.keys(SERVICE_WORDS));
export const STATE_KEYS = Object.freeze(['applied', 'draft', 'approved', 'rejected', 'undone']);
export const STATE_WORDS = Object.freeze({
  applied: { label: 'Done', tone: 'good' },
  draft: { label: 'Waiting for you', tone: 'warn' },
  approved: { label: 'You approved', tone: 'good' },
  rejected: { label: 'You rejected', tone: 'neutral' },
  undone: { label: 'Undone', tone: 'neutral' },
});

/** "automations.update" as a sentence for a seller. */
export function actionWords(routeId) {
  const [area, verb] = String(routeId).split('.');
  const what = { products: 'a product', categories: 'a category', automations: 'an automation', reels: 'a reel', pages: 'a page', pageBlocks: 'page blocks' }[area] ?? area;
  const did = { create: 'Added', update: 'Changed', remove: 'Removed', save: 'Saved', setState: 'Switched', reorder: 'Reordered', setReels: 'Changed reels in', addReel: 'Added a reel to', removeReel: 'Removed a reel from', pin: 'Pinned in', unpin: 'Unpinned in', schedule: 'Scheduled' }[verb] ?? 'Changed';
  return `${did} ${what}`;
}

const clip = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? '' : text.length > 70 ? `${text.slice(0, 67)}...` : text;
};

/** The fields that differ between before and after, as { field, before, after }, at most `max`. Neither side is shown whole. */
export function summarize(change, max = 6) {
  const before = change.before && typeof change.before === 'object' ? change.before : {};
  const after = change.after && typeof change.after === 'object' ? change.after : {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  return changed.slice(0, max).map((field) => ({ field, before: field in before ? clip(before[field]) : '', after: field in after ? clip(after[field]) : '' }));
}

/** Which buttons a line offers. The server decides again when one is pressed. */
export function actionsFor(change) {
  if (change.state === 'draft') return ['approve', 'reject'];
  if (change.canUndo && (change.state === 'applied' || change.state === 'approved')) return ['undo'];
  return [];
}

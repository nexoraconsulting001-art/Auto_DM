import { plural } from '../../lib/format.js';
import { CATALOG, CSV_TYPES } from '../catalog/shared/limits.js';

/** The four ways in (8.3 to 8.6), in the order a new seller is most likely to want them. */
export const WAYS = Object.freeze([['link', 'One link'], ['bulk', 'Many links'], ['shopify', 'Shopify store'], ['csv', 'CSV file']]);

const hasSpace = (text) => /[\s\0]/.test(text);

/** One pasted link as the API takes it, or why not. A bare "shop.example/p/1" is fine: the server adds https://. */
export function linkBody(text) {
  const url = String(text ?? '').trim();
  if (!url) return { error: 'Paste a link' };
  if (hasSpace(url)) return { error: 'Paste one link without spaces' };
  if (url.length > 2000) return { error: 'That link is too long' };
  if (!url.includes('.')) return { error: 'That doesn’t look like a web address' };
  return { body: { url } };
}

/** Many links, one per line (commas and spaces work too), without repeats. More than 25 is refused before anything is sent. */
export function bulkBody(text) {
  const urls = [...new Set(String(text ?? '').split(/[\s,]+/).map((part) => part.trim()).filter(Boolean))];
  if (!urls.length) return { error: 'Paste at least one link' };
  if (urls.length > CATALOG.bulkLinks) return { error: `Paste up to ${CATALOG.bulkLinks} links at a time. You pasted ${urls.length}.` };
  const bad = urls.find((url) => linkBody(url).error);
  if (bad) return { error: `“${bad.slice(0, 60)}” doesn’t look like a web address` };
  return { body: { urls } };
}

/** A Shopify store's address: "yourstore.com" or its full link. */
export function shopifyBody(text) {
  const storeUrl = String(text ?? '').trim();
  if (!storeUrl) return { error: 'Enter your store’s address' };
  if (hasSpace(storeUrl) || !storeUrl.includes('.')) return { error: 'Enter an address like yourstore.com' };
  if (storeUrl.length > 2000) return { error: 'That address is too long' };
  return { body: { storeUrl } };
}

/** Why this file can't be uploaded, or '' when it can. The server checks again, and reads the rows. */
export function csvProblem(file) {
  if (!file) return 'Choose a file';
  const named = /\.(csv|txt)$/i.test(file.name ?? '');
  if (!named && !CSV_TYPES.includes(file.type)) return 'Choose a CSV file. In a spreadsheet, use “Save as” or “Download” and pick CSV.';
  if (file.size > CATALOG.csvBytes) return 'Upload a file of 2 MB or less.';
  if (file.size === 0) return 'That file is empty.';
  return '';
}

const KIND_TEXT = { link: 'One link', bulk: 'Pasted links', csv: 'CSV file', shopify: 'Shopify store', adapter: 'Your site’s service' };
export const kindText = (kind) => KIND_TEXT[kind] ?? 'Import';

export const isRunning = (job) => job.status === 'queued' || job.status === 'running';

const JOB_STATE = {
  queued: { tone: 'neutral', text: 'Waiting' },
  running: { tone: 'neel', text: 'Working' },
  done: { tone: 'good', text: 'Finished' },
  failed: { tone: 'bad', text: 'Couldn’t finish' },
};
export const jobState = (job) => JOB_STATE[job.status] ?? JOB_STATE.queued;

/** What an import did, as the counts a seller cares about. Zeroes are left out. */
export function jobCounts(job) {
  return [
    [job.created, 'added'],
    [job.updated, 'updated'],
    [job.unchanged, 'unchanged'],
    [job.refused, 'need a look'],
    [job.failed, 'couldn’t be read'],
    [job.archived, 'archived'],
  ].filter(([count]) => count > 0).map(([count, text]) => `${count} ${text}`);
}

/** One line for a job in the list: how many of how many, and what happened. */
export function jobLine(job) {
  const counts = jobCounts(job);
  const handled = job.created + job.updated + job.unchanged + job.refused + job.failed;
  if (isRunning(job)) return job.total > 0 ? `${Math.min(handled, job.total)} of ${plural(job.total, 'product')} so far` : 'Starting';
  if (job.status === 'failed') return job.message || 'We couldn’t finish this import.';
  return counts.length ? counts.join(' · ') : 'Nothing to import';
}

/** The filters on a job's items, with the item statuses each one asks the API for. */
export const ITEM_FILTERS = Object.freeze([['all', 'All'], ['refused', 'Need a look'], ['failed', 'Couldn’t be read'], ['draft', 'To check'], ['created', 'Added'], ['updated', 'Updated'], ['existing', 'Already there'], ['archived', 'Archived']]);

const ITEM_STATE = {
  pending: { tone: 'neutral', text: 'Waiting' },
  draft: { tone: 'neel', text: 'Check and save' },
  created: { tone: 'good', text: 'Added' },
  updated: { tone: 'good', text: 'Updated' },
  unchanged: { tone: 'neutral', text: 'No change' },
  existing: { tone: 'neutral', text: 'Already in your catalog' },
  refused: { tone: 'warn', text: 'Needs a look' },
  failed: { tone: 'bad', text: 'Couldn’t be read' },
  archived: { tone: 'warn', text: 'Archived' },
};

const READ_FROM = { adapter: 'your site’s service', shopify: 'the store’s product data', json_ld: 'the page’s product data', open_graph: 'the page’s share details', title: 'the page title only', csv: 'the file', feed: 'the store’s product list' };

/**
 * One import item as the list shows it: its state, the quality gate's verdict in words (8.7), and what the owner can do. An item
 * the gate refused still carries what was read, so "Add the details" opens the product form filled in with it.
 */
export function itemView(item) {
  const state = ITEM_STATE[item.status] ?? ITEM_STATE.pending;
  const title = item.draft?.name || item.url || item.sku || `Row ${item.line}`;
  const canSave = !item.productId && (item.status === 'draft' || item.status === 'refused');
  return {
    ...state,
    title,
    where: [item.line > 0 && `Row ${item.line}`, item.url && item.draft?.name ? item.url : '', item.readFrom && `Read from ${READ_FROM[item.readFrom] ?? item.readFrom}`].filter(Boolean).join(' · '),
    message: item.message,
    gate: item.gatePassed === null || item.gatePassed === undefined ? '' : item.gatePassed ? 'Passed the quality check' : 'Stopped by the quality check',
    productId: item.productId,
    canSave,
    action: canSave ? (item.status === 'draft' ? 'Check and save' : 'Add the details') : '',
  };
}

/** The answer to one pasted link (8.3), as the screen shows it. */
export function linkResultView(result) {
  if (result.status === 'draft') return { tone: 'good', title: 'We read this product', text: result.message || 'Check the details, then save it to your catalog.', review: true };
  if (result.status === 'existing') return { tone: 'info', title: 'This product is already in your catalog', text: result.message, productId: result.productId };
  if (result.status === 'refused') return { tone: 'warn', title: 'We couldn’t be sure this is a product', text: result.message, review: Boolean(result.itemId && result.draft), manual: true };
  return { tone: 'bad', title: 'We couldn’t read that page', text: result.message || 'Add the product yourself instead.', manual: true };
}

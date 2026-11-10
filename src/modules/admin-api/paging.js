import { ApiError } from '../../contracts/api/index.js';

const INT32_MAX = 2147483647;
const expired = () => new ApiError('validation_failed', 'That page link has expired. Go back to the first page.', { fields: { cursor: 'Invalid cursor' } });

/** A cursor is the sort key of the last row shown, so rows added or removed earlier in the list don't shift the next page. */
export const writeCursor = (key) => Buffer.from(JSON.stringify(key)).toString('base64url');

/** The key inside `cursor`, or a 400 when it is not one this list wrote. */
export function readCursor(cursor, isValid) {
  let key;
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw expired();
  }
  if (!Array.isArray(key) || !isValid(key)) throw expired();
  return key;
}

export const isRowId = (value) => Number.isInteger(value) && value > 0 && value <= INT32_MAX;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    const order = compare(a[i], b[i]);
    if (order) return order;
  }
  return 0;
}

/**
 * One page of a list a repo returns whole. `keyOf(row, index)` gives a unique, ascending sort key; the
 * default keeps the list's own order, which suits short lists that rarely change.
 */
export function pageOf(rows, { cursor, limit }, keyOf = (_row, index) => [index]) {
  const keyed = rows.map((row, index) => ({ row, key: keyOf(row, index) })).sort((a, b) => compareKeys(a.key, b.key));
  let rest = keyed;
  if (cursor) {
    const sample = keyed[0]?.key;
    const after = readCursor(cursor, (key) => !sample || (key.length === sample.length && key.every((v, i) => typeof v === typeof sample[i])));
    rest = keyed.filter(({ key }) => compareKeys(key, after) > 0);
  }
  const shown = rest.slice(0, limit);
  return { items: shown.map(({ row }) => row), nextCursor: rest.length > limit ? writeCursor(shown.at(-1).key) : null };
}

/** Turns the rows of a page into what the API returns. */
export const mapPage = (page, toItem) => ({ items: page.items.map(toItem), nextCursor: page.nextCursor });

/** The page for rows fetched with one more than `limit`, which is how a query learns there is another page. */
export function pageOfFetched(rows, limit, keyOf) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? writeCursor(keyOf(items.at(-1))) : null };
}

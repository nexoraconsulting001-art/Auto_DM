/**
 * A change to one line's stock (9.12) as the API's StockAdjust: set it, move it by an amount, or count it no more (unlimited),
 * with the low-stock alert level beside it. Exactly one of stock and delta goes, or neither when only the alert level
 * changes. Pure, so it is tested in Node.
 */
export const ADJUST_WAYS = Object.freeze([['set', 'Set stock to'], ['move', 'Add or take away'], ['unlimited', 'Don’t count it']]);
export const MOVEMENT_REASONS = Object.freeze({ sale: 'Sold', cancel: 'Order cancelled', rto: 'Returned by the courier', return: 'Returned by the customer', manual: 'Changed by hand', import: 'Imported', shopify: 'From Shopify', correction: 'Correction' });
const LIMIT = 1_000_000;

export function lineToForm(line) {
  return { way: line.stock === null ? 'unlimited' : 'set', amount: line.stock === null ? '' : String(line.stock), lowAt: line.lowStockThreshold === null ? '' : String(line.lowStockThreshold), note: '' };
}

export function formToAdjust(values, line) {
  const errors = {};
  const body = { productId: line.productId, variantId: line.variantId };
  const text = String(values.amount ?? '').trim();
  if (values.way === 'set') {
    if (!/^\d+$/.test(text) || Number(text) > LIMIT) errors.amount = 'Enter how many you have, 0 or more';
    else body.stock = Number(text);
  } else if (values.way === 'move') {
    const signed = text.replace(/^\+/, '');
    if (!/^-?\d+$/.test(signed) || Number(signed) === 0 || Math.abs(Number(signed)) > LIMIT) errors.amount = 'Enter how many to add, or a minus number to take away';
    else if (line.stock === null) errors.amount = 'This item isn’t counted. Set its stock first.';
    else if (line.stock + Number(signed) < 0) errors.amount = `Only ${line.stock} on hand`;
    else body.delta = Number(signed);
  } else {
    body.stock = null;
  }
  const lowAt = String(values.lowAt ?? '').trim();
  if (lowAt === '') {
    if (line.lowStockThreshold !== null) body.lowStockThreshold = null;
  } else if (!/^\d+$/.test(lowAt) || Number(lowAt) > LIMIT) {
    errors.lowAt = 'Enter a number, or leave it empty for your usual level';
  } else if (Number(lowAt) !== line.lowStockThreshold) {
    body.lowStockThreshold = Number(lowAt);
  }
  const note = String(values.note ?? '').trim();
  if (note) body.note = note.slice(0, 200);
  if (Object.keys(errors).length) return { errors };
  return { body };
}

/** "+3" or "−2". */
export const signed = (n) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

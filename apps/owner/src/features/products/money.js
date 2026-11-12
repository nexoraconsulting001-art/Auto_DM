/**
 * Pure: money in the owner app. Amounts are integer paise from the server and are shown with one formatter, the
 * catalog contract's `formatRupees` (src/contracts/catalog.js), so a price reads the same in the app, the console and
 * the buyer pages. The app may not import from src (the rule in HANDOFF: only the access rules), so the two functions
 * it needs are written here and test/p5/app-insights-catalog holds them equal to the contract's, value for value.
 *
 * The app never adds, discounts or totals money: every total and every display price comes from the server. The one
 * amount a person types (a price, an MRP) is read with `parseRupees`, which takes the paise from the digits with no
 * floating point, so "1,299.50" is exactly 129950.
 */

/** CATALOG_LIMITS.maxPricePaise: above ₹100 crore is a misread, refused. */
export const MAX_PRICE_PAISE = 1_000_000_000_000;
/** PaiseInput in src/contracts/api/common.js: a typed amount is at most this many paise. */
export const MAX_INPUT_PAISE = 2147483647;

/** "₹1,299" or "₹1,299.50", with Indian digit grouping. The contract's formatRupees, line for line. */
export function formatRupees(paise) {
  const value = Math.round(Number(paise));
  const rupees = Math.floor(Math.abs(value) / 100);
  const rest = Math.abs(value) % 100;
  const digits = String(rupees);
  const grouped = digits.length > 3 ? `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}` : digits;
  return `${value < 0 ? '-' : ''}₹${grouped}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/** Why parseRupees refused: 'negative_price' or 'bad_price', as the contract's CatalogRuleError codes. */
export class MoneyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MoneyError';
    this.code = code;
  }
}

/**
 * Rupees as people write them, in paise: 1299, "1,299", "₹1,299.00", "Rs. 1,299", "1,29,900.50". Null for blank. The
 * contract's parseRupees, line for line; throws MoneyError('negative_price') or ('bad_price').
 */
export function parseRupees(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError('bad_price');
    if (input < 0) throw new MoneyError('negative_price');
    return parseRupees(input.toFixed(2));
  }
  let text = String(input).trim().replace(/^﻿/, '');
  if (text === '') return null;
  text = text.replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/\s*\/-$/, '').replace(/\s+/g, '');
  if (/^-/.test(text) || /^\(.*\)$/.test(text)) throw new MoneyError('negative_price');
  if (!/^\d{1,3}(,\d{2,3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(text)) throw new MoneyError('bad_price');
  const [whole, fraction = ''] = text.replace(/,/g, '').split('.');
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(paise) || paise > MAX_PRICE_PAISE) throw new MoneyError('bad_price');
  return paise;
}

/** Integer paise as "₹1,299" or "₹1,299.50". Anything that isn't a whole number of paise shows nothing, never a guess. */
export function formatMoney(paise) {
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise)) return '';
  return formatRupees(paise);
}

/** Paise as the text a price field starts with: 129950 as "1299.50", 129900 as "1299". */
export function moneyInput(paise) {
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise) || paise < 0) return '';
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return rest ? `${rupees}.${String(rest).padStart(2, '0')}` : String(rupees);
}

/**
 * What a typed price is: { paise } or { error } (a string key), or { paise: null } for blank when `optional`.
 * Refuses what the server would: not a valid amount, negative, or above what a price field takes.
 */
export function readMoney(text, { optional = false } = {}) {
  let paise;
  try {
    paise = parseRupees(text);
  } catch (error) {
    return { error: error?.code === 'negative_price' ? 'products.money.negative' : 'products.money.invalid' };
  }
  if (paise === null) return optional ? { paise: null } : { error: 'products.money.required' };
  if (paise > MAX_INPUT_PAISE) return { error: 'products.money.tooLarge' };
  return { paise };
}

/** The MRP rule the server holds (K-02), checked before sending so the person sees it at once: none, or not below the price. */
export function mrpProblem(pricePaise, mrpPaise) {
  if (mrpPaise === null || mrpPaise === undefined || pricePaise === null || pricePaise === undefined) return null;
  return mrpPaise < pricePaise ? 'products.money.mrpBelow' : null;
}

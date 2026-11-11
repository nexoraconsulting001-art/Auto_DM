import { CATALOG_LIMITS as L, NEEDS_ATTENTION, discountPercent, displayPrice } from '../../contracts/catalog.js';
import { ValidationError } from '../../util.js';

/**
 * The catalog's own rules that need no database (PRD 8.1, 8.8): what a card shows, whether a buyer may see a product, and
 * whether a set of options and variants fits together. Shared numbers and money rules are in src/contracts/catalog.js.
 */

/** A product a buyer page may show: live, and not one whose page is gone or that left its store's feed (8.5, 8.8). */
export const isBuyerVisible = (product) => Boolean(product.active) && !NEEDS_ATTENTION.includes(product.fetch_status);

/** The same rule in SQL, for a query on `products` under the alias given. */
export const buyerVisibleSql = (alias = 'p') => `(${alias}.active AND ${alias}.fetch_status NOT IN ('broken', 'missing'))`;

/** In stock means the flag is on and the Phase 0 stock count, where one is kept, hasn't reached zero. */
export const isInStock = (product) => product.in_stock !== false && product.stock !== 0;

/** What a card shows (K-03): the lowest in-stock variant's price, its MRP and "-N%", or sold out. */
export function cardPrice(product, variants = []) {
  const shown = displayPrice({ ...product, in_stock: isInStock(product) }, variants);
  const soldOut = shown.soldOut || !isInStock(product);
  const mrpPaise = shown.mrpPaise !== null && shown.mrpPaise > shown.pricePaise ? shown.mrpPaise : null;
  return { pricePaise: shown.pricePaise, mrpPaise, discountPercent: discountPercent(shown.pricePaise, mrpPaise) || null, soldOut };
}

/** Sold-out products move last, keeping the order they had among themselves (8.8). `soldOut(item)` says which they are. */
export function soldOutLast(items, soldOut = (item) => item.display?.soldOut === true) {
  return [...items.filter((item) => !soldOut(item)), ...items.filter((item) => soldOut(item))];
}

const sameText = (a, b) => a.toLowerCase() === b.toLowerCase();
export const variantKey = (optionValues) => optionValues.map((v) => String(v).toLowerCase()).join('\u0001');

/**
 * Options and variants that fit together, or a ValidationError saying what doesn't. Options: up to 3, each named once, each
 * with its values once. Variants: one value per option, each from that option's values, no combination twice, an MRP never
 * below the price. A product may instead keep a single variant with no option values, which holds the product's own SKU.
 */
export function checkOptionsAndVariants(optionsIn = [], variantsIn = []) {
  if (optionsIn.length > L.options) throw new ValidationError(`A product can have at most ${L.options} options`);
  const options = [];
  for (const option of optionsIn) {
    const name = String(option.name ?? '').trim();
    if (!name || name.length > 40) throw new ValidationError('Name each option in 40 characters or fewer, like Size');
    if (options.some((o) => sameText(o.name, name))) throw new ValidationError(`The option “${name}” is listed twice`);
    const values = [];
    for (const raw of option.values ?? []) {
      const value = String(raw ?? '').trim();
      if (!value || value.length > 60) throw new ValidationError('Each option value needs 1 to 60 characters');
      if (!values.some((v) => sameText(v, value))) values.push(value);
    }
    if (!values.length) throw new ValidationError(`Add at least one value for “${name}”`);
    if (values.length > L.optionValues) throw new ValidationError(`An option can have at most ${L.optionValues} values`);
    options.push({ name, values });
  }
  if (variantsIn.length > L.variants) throw new ValidationError(`A product can have at most ${L.variants} variants`);
  const variants = [];
  const seen = new Set();
  const skus = new Set();
  for (const input of variantsIn) {
    const optionValues = (input.optionValues ?? []).map((v) => String(v ?? '').trim());
    // A single variant with no option values is the product itself: it holds the product's SKU, whatever options are listed.
    const whole = variantsIn.length === 1 && optionValues.length === 0;
    if (optionValues.length !== options.length && !whole) {
      throw new ValidationError(options.length ? 'Each variant needs one value for every option' : 'Add the options before variants that use them');
    }
    const fitted = whole ? [] : optionValues.map((value, i) => options[i].values.find((v) => sameText(v, value)));
    if (fitted.some((v) => v === undefined)) throw new ValidationError('A variant uses a value its option doesn’t have');
    const key = variantKey(fitted);
    if (seen.has(key)) throw new ValidationError(options.length ? 'Two variants have the same options' : 'A product with no options has one variant at most');
    seen.add(key);
    const sku = String(input.sku ?? '').trim();
    if (sku.length > 100) throw new ValidationError('A SKU can have at most 100 characters');
    if (sku) {
      if (skus.has(sku)) throw new ValidationError(`The SKU “${sku}” is used twice`);
      skus.add(sku);
    }
    const pricePaise = Number(input.pricePaise);
    const mrpPaise = input.mrpPaise === null || input.mrpPaise === undefined ? null : Number(input.mrpPaise);
    if (!Number.isSafeInteger(pricePaise) || pricePaise < 0 || pricePaise > L.maxPricePaise) throw new ValidationError('A variant’s price isn’t a valid amount');
    if (mrpPaise !== null && (!Number.isSafeInteger(mrpPaise) || mrpPaise > L.maxPricePaise)) throw new ValidationError('A variant’s MRP isn’t a valid amount');
    if (mrpPaise !== null && mrpPaise < pricePaise) throw new ValidationError('MRP can’t be lower than the price');
    variants.push({
      optionValues: fitted,
      sku,
      pricePaise,
      mrpPaise,
      inStock: input.inStock !== false,
      imageIndex: Number.isInteger(input.imageIndex) ? input.imageIndex : null,
      sourceRef: String(input.sourceRef ?? '').slice(0, 200),
    });
  }
  return { options, variants };
}

/**
 * What the Phase 0 store's single option list holds for these options: one option as it is; several as their combinations
 * ("Small / Red"), so the old store still offers a choice until Phase 4 moves it to variants.
 */
export function legacyOption(options, variants) {
  if (!options.length) return { option_label: '', option_values: [] };
  if (options.length === 1) return { option_label: options[0].name, option_values: options[0].values.slice(0, 50) };
  const combos = [];
  for (const v of variants) {
    const text = v.optionValues.join(' / ');
    if (!combos.includes(text)) combos.push(text);
    if (combos.length >= 50) break;
  }
  return { option_label: options.map((o) => o.name).join(' / ').slice(0, 40), option_values: combos };
}

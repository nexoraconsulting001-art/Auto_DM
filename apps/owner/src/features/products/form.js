/**
 * Pure: a product as the owner app's form holds it, and back (PRD 8.1, 8.2): options, variants built from them, photos,
 * prices typed in rupees and read to paise with no floating point. The same rules as the console's form, so a product
 * saved on the phone is the product saved on the web. Errors are string keys; the screen says them.
 *
 * Nothing here works out a price: the app sends what the owner typed and shows what the server answers.
 */
import { CATALOG, NEEDS_ATTENTION } from './limits.js';
import { formatMoney, moneyInput, readMoney } from './money.js';

/** "Same as my other products", "Show the button" or "Hide the button" (8.11). */
export const WHATSAPP_CHOICES = Object.freeze(['follow', 'on', 'off']);
const whatsappToForm = (value) => (value === null || value === undefined ? 'follow' : value ? 'on' : 'off');
const whatsappToApi = (value) => (value === 'follow' ? null : value === 'on');

export const EMPTY_PRODUCT = Object.freeze({
  name: '', description: '', price: '', mrp: '', externalUrl: '', inStock: true, stock: '', tags: '', images: [], options: [], variants: [], sku: '',
  active: true, featured: false, categoryIds: [], whatsappOrder: 'follow',
});

const SEP = '\u0001';
const fold = (text) => String(text).trim().toLowerCase();
/** A variant is known by its option values, compared the way the server compares them. */
export const variantKey = (optionValues) => (optionValues ?? []).map(fold).join(SEP);
export const variantLabel = (variant) => (variant.optionValues ?? []).join(' / ');

/** "S, M, L" as ['S', 'M', 'L']: blanks and repeats (in any case) dropped. */
export function splitList(text) {
  const seen = new Set();
  const out = [];
  for (const piece of String(text ?? '').split(',')) {
    const value = piece.trim();
    if (!value || seen.has(fold(value))) continue;
    seen.add(fold(value));
    out.push(value);
  }
  return out;
}

const variantToForm = (variant, imageIndex = null) => ({
  optionValues: [...(variant.optionValues ?? [])],
  price: moneyInput(variant.pricePaise),
  mrp: variant.mrpPaise === null || variant.mrpPaise === undefined ? '' : moneyInput(variant.mrpPaise),
  sku: variant.sku ?? '',
  inStock: variant.inStock !== false,
  imageIndex,
});

/** A saved product (ProductDetail) as the form holds it. */
export function productToForm(product) {
  const gallery = product.gallery ?? [];
  const variants = product.variants ?? [];
  const options = product.options ?? [];
  // A single variant with no option values is the product itself: it holds the product's SKU.
  const whole = variants.length === 1 && variants[0].optionValues.length === 0 ? variants[0] : null;
  const indexOfImage = (imageId) => {
    const index = gallery.findIndex((image) => image.id === imageId);
    return index < 0 ? null : index;
  };
  return {
    name: product.name ?? '',
    description: product.description ?? '',
    price: moneyInput(product.pricePaise),
    mrp: product.mrpPaise === null || product.mrpPaise === undefined ? '' : moneyInput(product.mrpPaise),
    externalUrl: product.externalUrl ?? '',
    inStock: product.inStock ?? true,
    stock: product.stock === null || product.stock === undefined ? '' : String(product.stock),
    tags: (product.tags ?? []).join(', '),
    images: [...(product.images ?? [])],
    options: options.map((option) => ({ name: option.name, values: option.values.join(', ') })),
    variants: whole ? [] : variants.map((variant) => variantToForm(variant, indexOfImage(variant.imageId))),
    sku: whole?.sku ?? '',
    active: product.active !== false,
    featured: Boolean(product.featured),
    categoryIds: [...(product.categoryIds ?? [])],
    whatsappOrder: whatsappToForm(product.whatsappOrder),
  };
}

/** A draft read from a page, a feed or a CSV row (8.3 to 8.6), ready for the owner to check before it is saved. */
export function draftToForm(draft) {
  const images = [...new Set(draft?.images ?? [])].slice(0, CATALOG.images);
  const options = (draft?.options ?? []).slice(0, CATALOG.options).map((option) => ({ name: option.name, values: option.values.join(', ') }));
  const variants = draft?.variants ?? [];
  const whole = variants.length === 1 && variants[0].optionValues.length === 0 ? variants[0] : null;
  const mrpAbove = (mrp, price) => mrp !== null && mrp !== undefined && mrp > (price ?? 0);
  return {
    ...EMPTY_PRODUCT,
    name: String(draft?.name ?? '').slice(0, CATALOG.nameLength),
    description: String(draft?.description ?? '').slice(0, CATALOG.descriptionLength),
    price: draft?.pricePaise === null || draft?.pricePaise === undefined ? '' : moneyInput(draft.pricePaise),
    mrp: mrpAbove(draft?.mrpPaise, draft?.pricePaise) ? moneyInput(draft.mrpPaise) : '',
    externalUrl: draft?.externalUrl ?? '',
    inStock: draft?.inStock ?? true,
    tags: [...new Set(draft?.tags ?? [])].slice(0, CATALOG.tags).join(', '),
    images,
    options,
    variants: whole || !options.length ? [] : variants.slice(0, CATALOG.variants).map((variant) => variantToForm({ ...variant, mrpPaise: mrpAbove(variant.mrpPaise, variant.pricePaise) ? variant.mrpPaise : null })),
    sku: whole?.sku ?? '',
  };
}

/** The form's options as the API has them: names trimmed, values split. */
const readOptions = (options) => (options ?? []).map((option) => ({ name: String(option.name ?? '').trim(), values: splitList(option.values) }));

/** Every combination of the options' values, in order. Options without a name or values are left out. */
export function combinations(options) {
  const usable = readOptions(options).filter((option) => option.name && option.values.length);
  if (!usable.length) return [];
  return usable.reduce((rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value])), [[]]);
}

/**
 * The variants after the options changed: one per combination, keeping what the owner already typed for a combination
 * that is still there. A new option keeps each old variant's details for the combinations that grew from it; everything
 * else starts from the product's own price as typed.
 */
export function variantsFor(options, current, base = {}) {
  const list = current ?? [];
  const byKey = new Map(list.map((variant) => [variantKey(variant.optionValues), variant]));
  return combinations(options).slice(0, CATALOG.variants).map((optionValues) => {
    const kept = byKey.get(variantKey(optionValues))
      ?? list.find((variant) => variant.optionValues.length > 0 && variant.optionValues.length < optionValues.length && variantKey(variant.optionValues) === variantKey(optionValues.slice(0, variant.optionValues.length)));
    return kept ? { ...kept, optionValues } : { optionValues, price: base.price ?? '', mrp: base.mrp ?? '', sku: '', inStock: true, imageIndex: null };
  });
}

const isWebLink = (text) => /^https?:\/\/[^\s\0]+$/i.test(text);

/** A typed price and MRP: { pricePaise, mrpPaise } or the first error key. An MRP equal to the price is no MRP. */
function readPrices(priceText, mrpText) {
  const price = readMoney(priceText);
  if (price.error) return { error: price.error, field: 'price' };
  const mrp = readMoney(mrpText, { optional: true });
  if (mrp.error) return { error: mrp.error, field: 'mrp' };
  if (mrp.paise !== null && mrp.paise < price.paise) return { error: 'products.money.mrpBelow', field: 'mrp' };
  return { pricePaise: price.paise, mrpPaise: mrp.paise !== null && mrp.paise > price.paise ? mrp.paise : null };
}

/**
 * The form as the API wants it (ProductCreate), or `errors` by field ({ price: 'products.money.required' }) when it isn't
 * ready to send. `variantError` names the variant (its label) whose line is wrong.
 */
export function formToProduct(form) {
  const errors = {};
  const name = String(form.name ?? '').trim();
  if (!name) errors.name = 'products.form.nameRequired';
  else if (name.length > CATALOG.nameLength) errors.name = 'products.form.nameLong';
  const description = String(form.description ?? '').trim();
  if (description.length > CATALOG.descriptionLength) errors.description = 'products.form.descriptionLong';

  const prices = readPrices(form.price, form.mrp);
  if (prices.error) errors[prices.field] = prices.error;

  const externalUrl = String(form.externalUrl ?? '').trim();
  if (externalUrl && !isWebLink(externalUrl)) errors.externalUrl = 'products.form.webLink';

  const stockText = String(form.stock ?? '').trim();
  if (stockText !== '' && !/^\d+$/.test(stockText)) errors.stock = 'products.form.stockWhole';
  else if (stockText !== '' && Number(stockText) > 2147483647) errors.stock = 'products.form.stockLarge';
  else if (form.inStock && stockText !== '' && Number(stockText) === 0) errors.stock = 'products.form.stockZero';

  const images = (form.images ?? []).filter(Boolean);
  if (images.length > CATALOG.images) errors.images = 'products.form.tooManyPhotos';
  const tags = splitList(form.tags);
  if (tags.length > CATALOG.tags) errors.tags = 'products.form.tooManyTags';
  else if (tags.some((tag) => tag.length > 40)) errors.tags = 'products.form.tagLong';

  const options = readOptions(form.options);
  const names = options.map((option) => fold(option.name));
  if (options.length > CATALOG.options) errors.options = 'products.form.tooManyOptions';
  else if (options.some((option) => !option.name)) errors.options = 'products.form.optionName';
  else if (options.some((option) => !option.values.length)) errors.options = 'products.form.optionValues';
  else if (new Set(names).size !== names.length) errors.options = 'products.form.optionTwice';
  else if (combinations(form.options).length > CATALOG.variants) errors.options = 'products.form.tooManyVariants';

  const variants = [];
  let variantLabelText = '';
  if (!errors.options && options.length) {
    const seen = new Set();
    const skus = new Set();
    for (const variant of form.variants ?? []) {
      const key = variantKey(variant.optionValues);
      const sku = String(variant.sku ?? '').trim();
      const read = readPrices(variant.price, variant.mrp);
      const problem = read.error ?? (seen.has(key) ? 'products.form.variantTwice' : null) ?? (sku && skus.has(sku) ? 'products.form.skuTwice' : null) ?? (sku.length > 100 ? 'products.form.skuLong' : null);
      if (problem) {
        errors.variants = problem;
        variantLabelText = variantLabel(variant);
        break;
      }
      seen.add(key);
      if (sku) skus.add(sku);
      variants.push({ optionValues: variant.optionValues, sku, pricePaise: read.pricePaise, mrpPaise: read.mrpPaise, inStock: variant.inStock !== false, imageIndex: Number.isInteger(variant.imageIndex) && variant.imageIndex < images.length ? variant.imageIndex : null });
    }
    if (!errors.variants && !variants.length) errors.variants = 'products.form.keepVariant';
  } else if (!errors.options) {
    const sku = String(form.sku ?? '').trim();
    if (sku.length > 100) errors.sku = 'products.form.skuLong';
    else if (sku && !prices.error) variants.push({ optionValues: [], sku, pricePaise: prices.pricePaise, mrpPaise: prices.mrpPaise, inStock: form.inStock !== false, imageIndex: null });
  }

  if (Object.keys(errors).length) return { errors, variantLabel: variantLabelText };
  return {
    body: {
      name,
      description,
      pricePaise: prices.pricePaise,
      mrpPaise: prices.mrpPaise,
      externalUrl,
      inStock: form.inStock !== false,
      // Sold out with no count is left for the server to record in both of the forms it keeps (the count becomes 0).
      ...(stockText === '' && form.inStock === false ? {} : { stock: stockText === '' ? null : Number(stockText) }),
      tags,
      images,
      options,
      variants,
      active: form.active !== false,
      featured: Boolean(form.featured),
      categoryIds: [...(form.categoryIds ?? [])],
      whatsappOrder: whatsappToApi(form.whatsappOrder),
    },
  };
}

/** Fields the API treats as one thing: sending one of a group sends the rest, so the server never pairs new with old. */
const TOGETHER = [['options', 'variants']];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What to send when saving a product that exists: only what the owner changed. An untouched price isn't sent, so saving
 * a new description doesn't mark an imported price as the owner's own (8.8).
 */
export function changedFields(before, after) {
  const changed = Object.keys(after).filter((key) => !same(before?.[key], after[key]));
  for (const group of TOGETHER) if (group.some((key) => changed.includes(key))) changed.push(...group);
  if (changed.includes('stock')) changed.push('inStock'); // the server reads a new count together with the in-stock switch
  return Object.fromEntries([...new Set(changed)].filter((key) => key in after).map((key) => [key, after[key]]));
}

/** What a row shows for price: the server's display price (lowest in-stock variant, K-03), formatted; never worked out here. */
export function priceLine(product) {
  const display = product?.display;
  const paise = display ? display.pricePaise : product?.pricePaise;
  return {
    price: formatMoney(paise),
    strike: display?.mrpPaise ? formatMoney(display.mrpPaise) : '',
    off: display?.discountPercent ? `-${display.discountPercent}%` : '',
    soldOut: display ? Boolean(display.soldOut) : product?.inStock === false,
  };
}

export const needsAttention = (product) => NEEDS_ATTENTION.includes(product?.fetchStatus);
export const isImported = (product) => Boolean(product) && product.source !== 'manual';

/** The small labels on a product's row, most urgent first: [{ key, tone }]. */
export function productBadges(product) {
  const badges = [];
  if (needsAttention(product)) badges.push({ key: 'products.badge.attention', tone: 'bad' });
  if (product.priceChanged) badges.push({ key: 'products.badge.priceChanged', tone: 'warn' });
  if (priceLine(product).soldOut) badges.push({ key: 'products.badge.soldOut', tone: 'warn' });
  if (!product.active) badges.push({ key: 'products.badge.archived', tone: 'neutral' });
  else if (product.featured) badges.push({ key: 'products.badge.featured', tone: 'primary' });
  return badges;
}

/** Where a product came from, as a string key. */
export function sourceKey(source) {
  if (['manual', 'link', 'shopify', 'csv'].includes(source)) return `products.source.${source}`;
  return String(source ?? '').startsWith('adapter') ? 'products.source.adapter' : 'products.source.link';
}

/** The re-check interval as typed: { body } or { error }. */
export function recheckBody(text) {
  const value = String(text ?? '').trim();
  if (!/^\d+$/.test(value)) return { error: 'products.settings.whole' };
  const hours = Number(value);
  if (hours < 1) return { error: 'products.settings.min' };
  if (hours > 720) return { error: 'products.settings.max' };
  return { body: { recheckHours: hours } };
}

import { formatPaise, paiseToRupees, rupeesToPaise } from '../../lib/format.js';
import { CATALOG, MAX_PAISE, NEEDS_ATTENTION } from './shared/limits.js';

/** API field names that the form calls something else. */
export const RENAME = { pricePaise: 'price', mrpPaise: 'mrp', imageAlts: 'images', optionValues: 'options', optionLabel: 'options' };

/** The pages of the catalog area, for the row of links at the top of each. */
export const CATALOG_TABS = Object.freeze([['/catalog', 'Products'], ['/imports', 'Imports'], ['/catalog/settings', 'Re-checks']]);

export const STATUS_TABS = Object.freeze([
  ['all', 'All'], ['active', 'Active'], ['attention', 'Needs attention'], ['price_changed', 'Price changed'], ['sold_out', 'Sold out'], ['featured', 'Featured'], ['archived', 'Archived'],
]);
export const SOURCE_CHOICES = Object.freeze([['', 'Every source'], ['manual', 'Added by hand'], ['link', 'From a link'], ['shopify', 'From Shopify'], ['csv', 'From a CSV file'], ['adapter', 'From your site’s service']]);

/** Follows the business setting, or this product's own answer (8.11). */
export const WHATSAPP_CHOICES = Object.freeze([['follow', 'Same as my other products'], ['on', 'Show the button'], ['off', 'Hide the button']]);
const whatsappToForm = (value) => (value === null || value === undefined ? 'follow' : value ? 'on' : 'off');
const whatsappToApi = (value) => (value === 'follow' ? null : value === 'on');

export const EMPTY_PRODUCT = Object.freeze({
  name: '', description: '', price: '', mrp: '', externalUrl: '', inStock: true, stock: '', tags: [], images: [], alts: {}, options: [], variants: [], sku: '',
  active: true, featured: false, categoryIds: [], whatsappOrder: 'follow',
});

const SEP = '\u0001';
const fold = (text) => String(text).trim().toLowerCase();
/** A variant is known by its option values, compared the way the server compares them. */
export const variantKey = (optionValues) => optionValues.map(fold).join(SEP);

const variantToForm = (variant, imageIndex = null) => ({
  optionValues: variant.optionValues,
  price: paiseToRupees(variant.pricePaise),
  mrp: paiseToRupees(variant.mrpPaise),
  sku: variant.sku ?? '',
  inStock: variant.inStock,
  imageIndex,
});

/** A product from the API (products.get) as the form holds it: amounts in rupees as typed. */
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
    name: product.name,
    description: product.description,
    price: paiseToRupees(product.pricePaise),
    mrp: paiseToRupees(product.mrpPaise),
    externalUrl: product.externalUrl ?? '',
    inStock: product.inStock ?? true,
    stock: product.stock === null || product.stock === undefined ? '' : String(product.stock),
    tags: [...(product.tags ?? [])],
    images: [...product.images],
    alts: Object.fromEntries(product.images.map((url, index) => [url, gallery[index]?.alt ?? ''])),
    options: options.map((option) => ({ name: option.name, values: [...option.values] })),
    variants: whole ? [] : variants.map((variant) => variantToForm(variant, indexOfImage(variant.imageId))),
    sku: whole?.sku ?? '',
    active: product.active,
    featured: product.featured,
    categoryIds: [...(product.categoryIds ?? [])],
    whatsappOrder: whatsappToForm(product.whatsappOrder),
  };
}

/** A draft read from a page, a feed or a CSV row (8.3 to 8.6), ready for the owner to check before it is saved. */
export function draftToForm(draft) {
  const images = [...new Set(draft.images ?? [])].slice(0, CATALOG.images);
  const options = (draft.options ?? []).slice(0, CATALOG.options).map((option) => ({ name: option.name, values: [...option.values] }));
  const variants = draft.variants ?? [];
  const whole = variants.length === 1 && variants[0].optionValues.length === 0 ? variants[0] : null;
  return {
    ...EMPTY_PRODUCT,
    name: (draft.name ?? '').slice(0, CATALOG.nameLength),
    description: (draft.description ?? '').slice(0, CATALOG.descriptionLength),
    price: paiseToRupees(draft.pricePaise),
    mrp: draft.mrpPaise !== null && draft.mrpPaise !== undefined && draft.mrpPaise > (draft.pricePaise ?? 0) ? paiseToRupees(draft.mrpPaise) : '',
    externalUrl: draft.externalUrl ?? '',
    inStock: draft.inStock ?? true,
    tags: [...new Set(draft.tags ?? [])].slice(0, CATALOG.tags),
    images,
    alts: {},
    options,
    variants: whole || !options.length ? [] : variants.slice(0, CATALOG.variants).map((variant) => variantToForm({ ...variant, mrpPaise: variant.mrpPaise !== null && variant.mrpPaise > variant.pricePaise ? variant.mrpPaise : null })),
    sku: whole?.sku ?? '',
  };
}

/** Every combination of the options' values, in order. Options without a name or values are left out. */
export function combinations(options) {
  const usable = options.filter((option) => option.name.trim() && option.values.length);
  if (!usable.length) return [];
  return usable.reduce((rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value])), [[]]);
}

/**
 * The variants after the options changed: one per combination, keeping what the owner already typed for a combination that is
 * still there. A new option keeps each old variant's details for the combinations that grew from it; everything else starts
 * from the product's own price.
 */
export function variantsFor(options, current, base = {}) {
  const byKey = new Map(current.map((variant) => [variantKey(variant.optionValues), variant]));
  return combinations(options).slice(0, CATALOG.variants).map((optionValues) => {
    const kept = byKey.get(variantKey(optionValues))
      ?? current.find((variant) => variant.optionValues.length > 0 && variant.optionValues.length < optionValues.length && variantKey(variant.optionValues) === variantKey(optionValues.slice(0, variant.optionValues.length)));
    return kept ? { ...kept, optionValues } : { optionValues, price: base.price ?? '', mrp: base.mrp ?? '', sku: '', inStock: true, imageIndex: null };
  });
}

export const variantLabel = (variant) => variant.optionValues.join(' / ');

const priceProblem = (paise, what) => {
  if (paise === null) return `${what} is required`;
  if (Number.isNaN(paise)) return `Enter ${what === 'Price' ? 'a price' : 'an MRP'} like 499 or 499.50`;
  if (paise > MAX_PAISE) return 'That amount is too large';
  return '';
};

const isWebLink = (text) => /^https?:\/\/[^\s\0]+$/i.test(text);

/** The form as the API wants it (ProductCreate), or `errors` by field when it isn't ready to send. */
export function formToProduct(form) {
  const errors = {};
  const name = form.name.trim();
  if (!name) errors.name = 'Name is required';
  else if (name.length > CATALOG.nameLength) errors.name = `Use ${CATALOG.nameLength} characters or fewer`;
  if (form.description.trim().length > CATALOG.descriptionLength) errors.description = `Use ${CATALOG.descriptionLength} characters or fewer`;

  const pricePaise = rupeesToPaise(form.price);
  const priceError = priceProblem(pricePaise, 'Price');
  if (priceError) errors.price = priceError;

  const mrpPaise = rupeesToPaise(form.mrp);
  if (mrpPaise !== null) {
    const mrpError = priceProblem(mrpPaise, 'MRP');
    if (mrpError) errors.mrp = mrpError;
    else if (!priceError && mrpPaise < pricePaise) errors.mrp = 'MRP can’t be lower than the price';
  }

  const externalUrl = form.externalUrl.trim();
  if (externalUrl && !isWebLink(externalUrl)) errors.externalUrl = 'Use a web link starting with http:// or https://';

  const stockText = String(form.stock).trim();
  if (stockText !== '' && !/^\d+$/.test(stockText)) errors.stock = 'Stock must be a whole number, or empty for unlimited';
  else if (stockText !== '' && Number(stockText) > MAX_PAISE) errors.stock = 'That number is too large';
  else if (form.inStock && stockText !== '' && Number(stockText) === 0) errors.stock = 'A count of 0 means sold out. Leave it empty, or switch “In stock” off.';

  if (form.images.length > CATALOG.images) errors.images = `A product can have at most ${CATALOG.images} photos`;
  if (form.tags.length > CATALOG.tags) errors.tags = `Use at most ${CATALOG.tags} tags`;

  const options = form.options.map((option) => ({ name: option.name.trim(), values: option.values.map((value) => value.trim()).filter(Boolean) }));
  const names = options.map((option) => fold(option.name));
  if (options.length > CATALOG.options) errors.options = `A product can have at most ${CATALOG.options} options`;
  else if (options.some((option) => !option.name)) errors.options = 'Name each option, like Size';
  else if (options.some((option) => !option.values.length)) errors.options = 'Add at least one value to each option';
  else if (new Set(names).size !== names.length) errors.options = 'Two options have the same name';
  else if (combinations(options).length > CATALOG.variants) errors.options = `That makes ${combinations(options).length} variants. A product can have at most ${CATALOG.variants}.`;

  const variants = [];
  if (!errors.options && options.length) {
    const seen = new Set();
    const skus = new Set();
    for (const variant of form.variants) {
      const label = variantLabel(variant);
      const key = variantKey(variant.optionValues);
      const price = rupeesToPaise(variant.price);
      const mrp = rupeesToPaise(variant.mrp);
      const sku = variant.sku.trim();
      const problem = priceProblem(price, 'Price') || (mrp !== null && priceProblem(mrp, 'MRP')) || (mrp !== null && mrp < price && 'MRP can’t be lower than the price')
        || (seen.has(key) && 'is listed twice') || (sku && skus.has(sku) && `uses the SKU ${sku}, which another variant has`);
      if (problem) {
        errors.variants = `${label}: ${problem}`;
        break;
      }
      seen.add(key);
      if (sku) skus.add(sku);
      variants.push({ optionValues: variant.optionValues, sku, pricePaise: price, mrpPaise: mrp !== null && mrp > price ? mrp : null, inStock: variant.inStock, imageIndex: variant.imageIndex !== null && variant.imageIndex < form.images.length ? variant.imageIndex : null });
    }
    if (!errors.variants && !form.variants.length) errors.variants = 'Keep at least one variant, or remove the options';
  } else if (!errors.options) {
    const sku = form.sku.trim();
    if (sku.length > 100) errors.sku = 'Use 100 characters or fewer';
    else if (sku && !priceError && !errors.mrp) variants.push({ optionValues: [], sku, pricePaise, mrpPaise: mrpPaise !== null && mrpPaise > pricePaise ? mrpPaise : null, inStock: form.inStock, imageIndex: null });
  }

  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      name,
      description: form.description.trim(),
      pricePaise,
      mrpPaise: mrpPaise !== null && mrpPaise > pricePaise ? mrpPaise : null,
      externalUrl,
      inStock: form.inStock,
      // Sold out with no count is left for the server to record in both of the forms it keeps (the count becomes 0).
      ...(stockText === '' && !form.inStock ? {} : { stock: stockText === '' ? null : Number(stockText) }),
      tags: form.tags,
      images: form.images,
      imageAlts: form.images.map((url) => (form.alts[url] ?? '').trim().slice(0, 200)),
      options,
      variants,
      active: form.active,
      featured: form.featured,
      categoryIds: form.categoryIds,
      whatsappOrder: whatsappToApi(form.whatsappOrder),
    },
  };
}

/** Fields the API treats as one thing: sending one of a group sends the rest, so the server never pairs new with old. */
const TOGETHER = [['images', 'imageAlts'], ['options', 'variants']];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What to send when saving a product that exists: only what the owner changed. An untouched price isn't sent, so saving a new
 * description doesn't mark an imported price as the owner's own (8.8), and an untouched name doesn't stop the next import
 * updating it (8.5).
 */
export function changedFields(before, after) {
  const changed = Object.keys(after).filter((key) => !same(before[key], after[key]));
  for (const group of TOGETHER) if (group.some((key) => changed.includes(key))) changed.push(...group);
  // The server reads a new stock count together with the in-stock switch.
  if (changed.includes('stock')) changed.push('inStock');
  return Object.fromEntries([...new Set(changed)].map((key) => [key, after[key]]));
}

/** What a card shows (K-03): the price, the MRP struck through with its "-N%", or Sold out. */
export function cardPrice(product) {
  const display = product.display ?? { pricePaise: product.pricePaise, mrpPaise: product.mrpPaise > product.pricePaise ? product.mrpPaise : null, discountPercent: null, soldOut: product.inStock === false || product.stock === 0 };
  return {
    price: formatPaise(display.pricePaise),
    strike: display.mrpPaise ? formatPaise(display.mrpPaise) : '',
    off: display.discountPercent ? `-${display.discountPercent}%` : '',
    soldOut: display.soldOut,
  };
}

const SOURCE_TEXT = { manual: 'Added by hand', link: 'From a link', shopify: 'From Shopify', csv: 'From a CSV file' };
export const sourceText = (source) => SOURCE_TEXT[source] ?? (String(source).startsWith('adapter:') ? 'From your site’s service' : 'Imported');
export const isImported = (product) => product.source !== 'manual';

const FETCH_TEXT = {
  broken: 'Its page on your site is gone, so shoppers can’t see it. Fix the link or archive it.',
  missing: 'It is no longer in your store’s product list, so it is hidden from shoppers.',
  retrying: 'Your site didn’t answer the last check. We’ll try again at the next one.',
};
export const fetchNote = (product) => FETCH_TEXT[product.fetchStatus] ?? '';
export const needsAttention = (product) => NEEDS_ATTENTION.includes(product.fetchStatus);

/** The small labels on a product's row, most urgent first. */
export function productBadges(product) {
  const badges = [];
  if (needsAttention(product)) badges.push({ tone: 'bad', text: 'Needs attention' });
  if (product.priceChanged) badges.push({ tone: 'warn', text: 'Price changed' });
  if (cardPrice(product).soldOut) badges.push({ tone: 'warn', text: 'Sold out' });
  if (!product.active) badges.push({ tone: 'neutral', text: 'Archived' });
  else if (product.featured) badges.push({ tone: 'neel', text: 'Featured' });
  else if (!badges.length) badges.push({ tone: 'good', text: 'Active' });
  return badges;
}

/** "Price changed" in the owner's words: what it was, and what the site says now. */
export function priceChangeNote(product) {
  if (!product.priceChanged) return '';
  const was = product.previousPricePaise === null || product.previousPricePaise === undefined ? '' : ` from ${formatPaise(product.previousPricePaise)}`;
  return `The price on your site changed${was} to ${formatPaise(product.pricePaise)}. Check it is right.`;
}

/** The re-check interval, as the settings form holds and sends it. */
export function recheckBody(text) {
  const value = String(text).trim();
  if (!/^\d+$/.test(value)) return { error: 'Use whole hours' };
  const hours = Number(value);
  if (hours < 1) return { error: 'At least 1 hour' };
  if (hours > 720) return { error: 'At most 720 hours' };
  return { body: { recheckHours: hours } };
}

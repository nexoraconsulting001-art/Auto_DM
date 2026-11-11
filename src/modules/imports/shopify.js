import { CATALOG_LIMITS as L, canonicalProductUrl } from '../../contracts/catalog.js';
import { pricePaise } from './extract.js';
import { cleanLine, cleanUrls, htmlToText } from './text.js';

/**
 * A Shopify store's public storefront JSON (PRD 8.3, 8.5): one product at /products/<handle>.json, and the whole catalogue at
 * /products.json page by page. Nothing here needs a key. Prices in this JSON are rupees as text ("1299.00"); compare_at_price is
 * the MRP, kept only above the price; `available` (in the feed) is the stock; tags become suggested categories.
 */

const PRODUCT_PATH = /^(?:\/collections\/[^/]+)?\/products\/([^/?#.]+)\/?$/i;

/** The handle when the address is a storefront product page (/products/<handle>, also under a collection), else null. */
export function shopifyHandle(url) {
  try {
    const match = PRODUCT_PATH.exec(new URL(url).pathname);
    return match ? decodeURIComponent(match[1]).toLowerCase() : null;
  } catch {
    return null;
  }
}

export const productJsonUrl = (origin, handle) => `${origin}/products/${encodeURIComponent(handle)}.json`;
export const productJsUrl = (origin, handle) => `${origin}/products/${encodeURIComponent(handle)}.js`;
export const feedUrl = (origin, page) => `${origin}/products.json?limit=${L.shopifyPageSize}&page=${page}`;
export const productPageUrl = (origin, handle) => canonicalProductUrl(`${origin}/products/${encodeURIComponent(handle)}`);

const isDefaultOption = (option) => /^title$/i.test(option?.name ?? '') && [].concat(option?.values ?? []).every((v) => /^default title$/i.test(String(v)));

function tagsOf(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  const out = [];
  for (const tag of list.slice(0, 200)) {
    const clean = cleanLine(tag, 40);
    if (clean && !out.some((t) => t.toLowerCase() === clean.toLowerCase())) out.push(clean);
    if (out.length >= L.tags) break;
  }
  return out;
}

const mrpAbove = (price, mrp) => (mrp !== null && price !== null && mrp > price ? mrp : null);

/**
 * One storefront product as a draft. `availability` (variant id -> boolean) fills in stock from the .js answer, which the
 * single product .json lacks. Null when it isn't a product (no title or handle).
 */
export function fromShopify(product, origin, { availability = null } = {}) {
  if (!product || typeof product !== 'object' || typeof product.handle !== 'string' || !product.handle) return null;
  const name = cleanLine(product.title, L.nameLength);
  if (!name) return null;
  const handle = product.handle.toLowerCase().slice(0, 200);
  const externalUrl = productPageUrl(origin, handle);
  if (!externalUrl) return null;
  const rawOptions = [].concat(product.options ?? []).filter((o) => o && typeof o === 'object' && !isDefaultOption(o)).slice(0, L.options);
  const options = rawOptions.map((o) => ({ name: cleanLine(o.name, 40) || 'Option', values: [] }));
  const variants = [];
  const seen = new Set();
  for (const v of [].concat(product.variants ?? []).filter((x) => x && typeof x === 'object').slice(0, L.variants)) {
    const price = pricePaise(v.price);
    if (price === null) continue;
    const optionValues = options.map((_o, i) => cleanLine(v[`option${i + 1}`] ?? '', 60) || '-');
    const key = optionValues.join('\u0001').toLowerCase();
    if (options.length && seen.has(key)) continue;
    seen.add(key);
    optionValues.forEach((value, i) => {
      if (!options[i].values.includes(value) && options[i].values.length < L.optionValues) options[i].values.push(value);
    });
    const known = availability && Object.hasOwn(availability, String(v.id)) ? availability[String(v.id)] : undefined;
    const available = typeof v.available === 'boolean' ? v.available : typeof known === 'boolean' ? known : true;
    variants.push({ optionValues, sku: cleanLine(v.sku ?? '', 100), pricePaise: price, mrpPaise: mrpAbove(price, pricePaise(v.compare_at_price)), inStock: available, sourceRef: String(v.id ?? '').slice(0, 200) });
  }
  if (!variants.length) return null;
  const images = cleanUrls([...[].concat(product.images ?? []).map((img) => (typeof img === 'string' ? img : img?.src)), product.image?.src], origin, L.images);
  const tags = tagsOf(product.tags);
  const stocked = variants.filter((v) => v.inStock);
  const lowest = (stocked.length ? stocked : variants).reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a));
  const single = !options.length;
  return {
    name,
    description: htmlToText(product.body_html, L.descriptionLength),
    externalUrl,
    pricePaise: lowest.pricePaise,
    mrpPaise: lowest.mrpPaise,
    inStock: stocked.length > 0,
    images,
    tags,
    suggestedCategories: [...tags, ...(product.product_type ? [cleanLine(product.product_type, 60)] : [])].filter(Boolean).slice(0, 20),
    options,
    // A product with no options of its own is one variant; it is kept only to hold the SKU a CSV may name later.
    variants: single ? variants.slice(0, 1).filter((v) => v.sku).map((v) => ({ ...v, optionValues: [] })) : variants,
    handle,
  };
}

/** variant id -> available, from the .js answer (which has it), or null when it isn't that shape. */
export function availabilityFromJs(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.variants)) return null;
  const out = {};
  for (const v of data.variants.slice(0, L.variants)) if (v && typeof v.available === 'boolean' && v.id !== undefined) out[String(v.id)] = v.available;
  return out;
}

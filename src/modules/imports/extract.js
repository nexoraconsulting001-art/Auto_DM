import { CATALOG_LIMITS as L, parseRupees } from '../../contracts/catalog.js';
import { jsonLdNodes, metaValue, metaValues, parseJsonLd, scanHtml, shortType, typesOf } from './html.js';
import { cleanLine, cleanUrl, cleanUrls, htmlToText } from './text.js';

/**
 * A product read from a page's JSON-LD or Open Graph tags, in the order PRD 8.3 gives: JSON-LD Product or ProductGroup (with
 * @graph and hasVariant), then Open Graph and product:price:*, then the <title> alone. Prices are paise, read from the digits;
 * a price in another currency is no price. Everything else about the site (its name, its logos) comes back for the gate (8.7).
 */

const PRODUCT_TYPES = new Set(['Product', 'ProductGroup', 'IndividualProduct', 'ProductModel', 'SomeProducts', 'Vehicle', 'Book']);
const SITE_TYPES = new Set(['Organization', 'WebSite', 'Store', 'OnlineStore', 'LocalBusiness', 'Corporation', 'Brand']);
const SOLD_OUT = /(outofstock|soldout|discontinued|out of stock|sold out|oos)$/i;
const VARIANT_PROPS = ['size', 'color', 'colour', 'material', 'pattern', 'suggestedGender', 'suggestedAge', 'flavor', 'weight'];

/** Paise for a price as sites write it, or null when it isn't one we can read. */
export function pricePaise(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    return parseRupees(value);
  } catch {
    return null;
  }
}

const isInr = (currency) => !currency || String(currency).trim().toUpperCase() === 'INR';

/** True unless the availability says sold out. Unknown availability is in stock: a page that doesn't say isn't proof. */
export function inStockFrom(value) {
  if (value === null || value === undefined || value === '') return true;
  const text = String(Array.isArray(value) ? value[0] : value).trim().replace(/\s+/g, '');
  return !SOLD_OUT.test(text) && !/^(false|0|no)$/i.test(text);
}

function imageLinks(value, base) {
  const list = [];
  for (const item of [].concat(value ?? []).slice(0, 20)) {
    if (typeof item === 'string') list.push(item);
    else if (item && typeof item === 'object') list.push(item.url ?? item.contentUrl ?? item['@id'] ?? '');
  }
  return cleanUrls(list, base, L.images);
}

/** The lowest INR price among the offers, with whether any of them is in stock. */
function readOffers(offers) {
  const list = [];
  const queue = [].concat(offers ?? []).slice(0, 100);
  for (let i = 0; i < queue.length && i < 200; i++) {
    const offer = queue[i];
    if (!offer || typeof offer !== 'object') continue;
    if (offer.offers) queue.push(...[].concat(offer.offers).slice(0, 50));
    const spec = [].concat(offer.priceSpecification ?? [])[0];
    const currency = offer.priceCurrency ?? spec?.priceCurrency;
    if (!isInr(currency)) continue;
    const price = pricePaise(offer.price ?? offer.lowPrice ?? spec?.price);
    list.push({ price, inStock: inStockFrom(offer.availability) });
  }
  const priced = list.filter((o) => o.price !== null);
  const pool = priced.filter((o) => o.inStock).length ? priced.filter((o) => o.inStock) : priced;
  const best = pool.reduce((a, b) => (b.price < a.price ? b : a), pool[0] ?? null);
  return { pricePaise: best?.price ?? null, inStock: list.length ? list.some((o) => o.inStock) : true };
}

const optionName = (prop) => {
  const short = shortType(prop);
  return short ? short[0].toUpperCase() + short.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : 'Option';
};

/** The value of a variant for one option: its property, or what its name adds to the group's name. */
function variantValue(variant, prop, groupName) {
  const direct = variant[shortType(prop)];
  if (typeof direct === 'string' || typeof direct === 'number') return cleanLine(direct, 60);
  if (direct && typeof direct === 'object' && direct.name) return cleanLine(direct.name, 60);
  const name = cleanLine(variant.name, 120);
  const base = cleanLine(groupName, 120);
  const rest = name.toLowerCase().startsWith(base.toLowerCase()) ? name.slice(base.length).replace(/^[\s,–—|:/-]+/, '') : '';
  return cleanLine(rest || variant.sku || name, 60);
}

/** Options and variants from a ProductGroup's hasVariant (or a Product that lists variants the same way). */
function readVariants(node, base) {
  const raw = [].concat(node.hasVariant ?? []).filter((v) => v && typeof v === 'object').slice(0, L.variants);
  if (!raw.length) return { options: [], variants: [], images: [] };
  let props = [].concat(node.variesBy ?? []).map(shortType).filter(Boolean).slice(0, L.options);
  if (!props.length) props = VARIANT_PROPS.filter((p) => raw.some((v) => v[p] !== undefined)).slice(0, L.options);
  if (!props.length) props = ['option'];
  const options = props.map((prop) => ({ name: optionName(prop), values: [] }));
  const variants = [];
  const seen = new Set();
  const images = [];
  for (const v of raw) {
    const offer = readOffers(v.offers);
    if (offer.pricePaise === null) continue;
    const optionValues = props.map((prop) => variantValue(v, prop, node.name) || '-');
    const key = optionValues.join('\u0001').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    optionValues.forEach((value, i) => {
      if (!options[i].values.includes(value) && options[i].values.length < L.optionValues) options[i].values.push(value);
    });
    images.push(...imageLinks(v.image, base));
    variants.push({ optionValues, sku: cleanLine(v.sku ?? '', 100), pricePaise: offer.pricePaise, mrpPaise: null, inStock: offer.inStock, sourceRef: cleanLine(v.sku ?? v['@id'] ?? '', 200) });
  }
  if (variants.length < 2) return { options: [], variants: [], images };
  return { options, variants, images };
}

/** The best product node of a page: a ProductGroup over a lone Product, the first otherwise. */
function pickProduct(nodes) {
  const products = nodes.filter((n) => typesOf(n).some((t) => PRODUCT_TYPES.has(t)));
  return products.find((n) => typesOf(n).includes('ProductGroup')) ?? products.find((n) => n.hasVariant) ?? products[0] ?? null;
}

/** A draft from one JSON-LD product node. */
function fromJsonLd(node, base) {
  const name = cleanLine(node.name, L.nameLength);
  const { options, variants, images: variantImages } = readVariants(node, base);
  const offer = readOffers(node.offers);
  let price = offer.pricePaise;
  let inStock = offer.inStock;
  if (variants.length) {
    const stocked = variants.filter((v) => v.inStock);
    const pool = stocked.length ? stocked : variants;
    price = pool.reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a)).pricePaise;
    inStock = stocked.length > 0;
  }
  const images = cleanUrls([...imageLinks(node.image, base), ...variantImages], base, L.images);
  return {
    name,
    description: htmlToText(node.description, L.descriptionLength),
    pricePaise: price,
    mrpPaise: null,
    inStock,
    images,
    tags: [],
    suggestedCategories: [cleanLine(typeof node.category === 'string' ? node.category.split('>').pop() : '', 60)].filter(Boolean),
    options,
    variants,
    sku: cleanLine(node.sku ?? '', 100),
  };
}

/** Site name and logos from JSON-LD Organization or WebSite nodes. */
function siteFacts(nodes, base) {
  const names = [];
  const logos = [];
  for (const n of nodes) {
    if (!typesOf(n).some((t) => SITE_TYPES.has(t))) continue;
    const name = cleanLine(n.name, 120);
    if (name) names.push(name);
    logos.push(...imageLinks(n.logo, base));
    if (typesOf(n).includes('Brand') && n.logo) logos.push(...imageLinks(n.logo, base));
  }
  return { names, logos };
}

/**
 * Everything one page says: { readFrom, draft, title, siteName, siteNames, logos, canonical, ogType }. readFrom is json_ld,
 * open_graph or title; draft is null when not even a title was found.
 */
export function readPage(html, pageUrl) {
  const scan = scanHtml(html);
  const nodes = jsonLdNodes(parseJsonLd(scan));
  const site = siteFacts(nodes, pageUrl);
  const ogSite = cleanLine(metaValue(scan, 'og:site_name', 'application-name'), 120);
  const siteNames = [ogSite, ...site.names].filter(Boolean);
  const title = cleanLine(scan.title, 300);
  const canonical = cleanUrl(scan.links.find((l) => l.rel.split(/\s+/).includes('canonical'))?.href ?? '', pageUrl) ?? cleanUrl(metaValue(scan, 'og:url'), pageUrl);
  const ogType = metaValue(scan, 'og:type').toLowerCase();
  const ogImages = cleanUrls(metaValues(scan, 'og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image'), pageUrl, L.images);
  const ogTitle = cleanLine(metaValue(scan, 'og:title', 'twitter:title'), L.nameLength);
  const ogDescription = htmlToText(metaValue(scan, 'og:description', 'description', 'twitter:description'), L.descriptionLength);
  const ogCurrency = metaValue(scan, 'product:price:currency', 'og:price:currency');
  const ogPrice = isInr(ogCurrency) ? pricePaise(metaValue(scan, 'product:price:amount', 'og:price:amount')) : null;
  const ogStock = inStockFrom(metaValue(scan, 'product:availability', 'og:availability'));
  const facts = { title, siteName: siteNames[0] ?? '', siteNames, logos: site.logos, canonical, ogType, ogImages };

  const product = pickProduct(nodes);
  if (product) {
    const draft = fromJsonLd(product, pageUrl);
    if (!draft.name) draft.name = ogTitle;
    if (!draft.images.length) draft.images = ogImages;
    if (!draft.description) draft.description = ogDescription;
    if (draft.pricePaise === null && ogPrice !== null) draft.pricePaise = ogPrice;
    if (draft.name) return { ...facts, readFrom: 'json_ld', draft };
  }
  if (ogTitle) {
    return {
      ...facts,
      readFrom: 'open_graph',
      draft: { name: ogTitle, description: ogDescription, pricePaise: ogPrice, mrpPaise: null, inStock: ogStock, images: ogImages, tags: [], suggestedCategories: [], options: [], variants: [], sku: cleanLine(metaValue(scan, 'product:retailer_item_id'), 100) },
    };
  }
  if (title) {
    return { ...facts, readFrom: 'title', draft: { name: cleanLine(title, L.nameLength), description: '', pricePaise: null, mrpPaise: null, inStock: true, images: [], tags: [], suggestedCategories: [], options: [], variants: [], sku: '' } };
  }
  return { ...facts, readFrom: '', draft: null };
}

/** The title, site name and logo of a site's home page, for the gate's comparisons (8.7). */
export function readHome(html, pageUrl) {
  const page = readPage(html, pageUrl);
  return { title: page.title, siteNames: page.siteNames, logos: [...page.logos, ...page.ogImages] };
}

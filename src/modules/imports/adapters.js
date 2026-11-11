import { CATALOG_LIMITS as L, canonicalProductUrl } from '../../contracts/catalog.js';
import { pricePaise } from './extract.js';
import { cleanLine, cleanUrls, htmlToText } from './text.js';

/**
 * Site adapters (PRD 8.4): for a site with no Open Graph or JSON-LD, a small reader of that site's own product service. An
 * adapter is code every business shares; which business may use one is a row in site_adapters, set by our team in the
 * Platform Console. An adapter is:
 *
 *   { name: 'some-site',                         lower-case letters, digits and hyphens: it becomes the source "adapter:some-site"
 *     label: 'Some Site',
 *     match(url) -> boolean,                     true for a product address this adapter reads
 *     async fetchProduct(url, { fetcher }),      -> the product (see draftFromAdapter). Reads only through fetcher (safeFetch).
 *     async listProducts({ fetcher }) }          optional: every product of the site
 *
 * When an adapter fails, the import fails and says so: there is no falling back to reading the page (K-13).
 *
 * None is built in yet. The first one waits on a confirmed site (8.4's open question). `extra` (config.siteAdapters) is how a
 * test adds one against the site simulator.
 */
const BUILT_IN = Object.freeze([]);

const NAME = /^[a-z0-9-]{1,40}$/;

export class AdapterError extends Error {
  constructor(message = 'The adapter gave no product', { cause } = {}) {
    super(message, { cause });
    this.name = 'AdapterError';
    this.code = 'adapter_error';
  }
}

export function createAdapterRegistry(extra = []) {
  const adapters = [];
  for (const adapter of [...BUILT_IN, ...(extra ?? [])]) {
    if (!adapter || !NAME.test(adapter.name ?? '') || typeof adapter.match !== 'function' || typeof adapter.fetchProduct !== 'function') {
      throw new Error('A site adapter needs a name (a-z, 0-9, hyphens), match(url) and fetchProduct(url)');
    }
    if (adapters.some((a) => a.name === adapter.name)) throw new Error(`Two site adapters are called "${adapter.name}"`);
    adapters.push(adapter);
  }
  return {
    list: () => adapters.map((a) => ({ name: a.name, label: String(a.label ?? a.name) })),
    get: (name) => adapters.find((a) => a.name === name) ?? null,
    /** The adapter for this address among the ones the business may use, or null. A match() that throws matches nothing. */
    find(url, enabled) {
      return adapters.find((a) => {
        if (!enabled.includes(a.name)) return false;
        try {
          return a.match(url) === true;
        } catch {
          return false;
        }
      }) ?? null;
    },
  };
}

/**
 * What an adapter returned, as a draft. The adapter gives { name or title, description, price or pricePaise, mrp or mrpPaise,
 * inStock, images, url, ref, tags, category, sku }: prices as rupees ("1,299.00", 1299) or whole paise in the *Paise fields.
 * Everything is cleaned like any other outside text. Throws AdapterError when it isn't a product.
 */
export function draftFromAdapter(product, url) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) throw new AdapterError();
  const name = cleanLine(product.name ?? product.title, L.nameLength);
  if (!name) throw new AdapterError();
  const paise = (whole, rupees) => (Number.isSafeInteger(whole) && whole >= 0 && whole <= L.maxPricePaise ? whole : pricePaise(rupees));
  const price = paise(product.pricePaise, product.price);
  const mrp = paise(product.mrpPaise, product.mrp);
  const tags = [];
  for (const raw of [].concat(product.tags ?? []).slice(0, 200)) {
    const tag = cleanLine(raw, 40);
    if (tag && !tags.includes(tag) && tags.length < L.tags) tags.push(tag);
  }
  return {
    name,
    description: htmlToText(product.description, L.descriptionLength),
    externalUrl: canonicalProductUrl(typeof product.url === 'string' ? product.url : url) ?? canonicalProductUrl(url) ?? '',
    pricePaise: price,
    mrpPaise: price !== null && mrp !== null && mrp > price ? mrp : null,
    inStock: product.inStock !== false && product.in_stock !== false,
    images: cleanUrls([].concat(product.images ?? product.image ?? []).slice(0, 20), url, L.images),
    tags,
    suggestedCategories: [cleanLine(product.category, 60)].filter(Boolean),
    options: [],
    variants: [],
    sku: cleanLine(product.sku ?? '', 100),
    ref: cleanLine(String(product.ref ?? product.id ?? ''), 200),
  };
}

import { contrastRatio } from '../brand/theme.js';
import { assertFetchable, BlockedAddressError, MAX_PAGE_BYTES, safeFetch } from './safe-fetch.js';

const READ_TIMEOUT_MS = 8000;
const MAX_PRODUCTS = 200;
const MAX_JSON_LD_BLOCKS = 50;
const MAX_TAGS = 300;
const MAX_TAG_LENGTH = 2000;
const MAX_VARIANTS = 50;
const MAX_IMAGES = 6;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;

/** The website as typed, as the https URL we keep. Throws BlockedAddressError if it can't be one. */
export function cleanWebsite(input) {
  const typed = String(input).trim();
  const url = assertFetchable(/^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`);
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/+$/, '');
}

/** Two addresses for one site compare equal: http or https, with or without www, any trailing slash. */
export const websiteKey = (website) => website.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '').toLowerCase();

/**
 * Reads the homepage, within 8 seconds whatever the fetcher does. `config.siteFetcher` replaces safeFetch in tests.
 * Returns { html }, or { failed: true } when it can be tried again; an address that isn't public throws BlockedAddressError.
 */
export async function readSite(website, config) {
  const fetcher = config.siteFetcher ?? safeFetch;
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timed out'));
    }, config.siteReadTimeoutMs ?? READ_TIMEOUT_MS);
  });
  try {
    const page = await Promise.race([fetcher(website, { signal: controller.signal }), timedOut]);
    const type = String(page.headers?.['content-type'] ?? 'text/html');
    if (page.status < 200 || page.status >= 300 || !/html/i.test(type)) return { failed: true };
    return { html: String(page.body ?? '').slice(0, MAX_PAGE_BYTES) };
  } catch (err) {
    if (err instanceof BlockedAddressError) throw err;
    return { failed: true };
  } finally {
    clearTimeout(timer);
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };
const decode = (value) => value.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/gi, (_m, name) => ENTITIES[name.toLowerCase()]);

function attributesOf(tag) {
  const out = {};
  for (const [, name, double, single, bare] of tag.matchAll(/([a-z:-]{1,40})\s{0,8}=\s{0,8}(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    out[name.toLowerCase()] = decode(double ?? single ?? bare ?? '');
  }
  return out;
}

// Pages come from anywhere, so they are scanned with indexOf: a page full of unclosed tags costs one pass, where a regular expression goes quadratic.
// Only ASCII is lowered, because lowering other letters can change the length of the text and every index after them.
const asciiLower = (text) => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

function tagsNamed(html, name) {
  const lower = asciiLower(html);
  const open = `<${name}`;
  const tags = [];
  let at = lower.indexOf(open);
  while (at !== -1 && tags.length < MAX_TAGS) {
    const end = lower.indexOf('>', at);
    if (end === -1) break;
    if (end - at <= MAX_TAG_LENGTH && /[\s/>]/.test(lower[at + open.length])) tags.push(attributesOf(html.slice(at, end + 1)));
    at = lower.indexOf(open, end);
  }
  return tags;
}

function jsonLdBlocks(html) {
  const blocks = [];
  const lower = asciiLower(html);
  let at = lower.indexOf('<script');
  while (at !== -1 && blocks.length < MAX_JSON_LD_BLOCKS) {
    const open = lower.indexOf('>', at);
    if (open === -1) break;
    const close = lower.indexOf('</script', open);
    if (close === -1) break;
    if (/type\s*=\s*["']?application\/ld\+json/i.test(html.slice(at, open))) {
      try {
        blocks.push(JSON.parse(html.slice(open + 1, close)));
      } catch { /* a broken block on someone's site is simply skipped */ }
    }
    at = lower.indexOf('<script', close);
  }
  return blocks;
}

/** Every JSON-LD node on the page, whether listed, nested in @graph, or both. */
function jsonLdNodes(html) {
  const nodes = [];
  const walk = (value, depth) => {
    if (depth > 5 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach((v) => walk(v, depth + 1));
    nodes.push(value);
    if (value['@graph']) walk(value['@graph'], depth + 1);
  };
  jsonLdBlocks(html).forEach((block) => walk(block, 0));
  return nodes;
}

const isType = (node, type) => [].concat(node['@type'] ?? []).includes(type);

function absolute(link, base) {
  try {
    const url = new URL(String(link).trim(), base);
    return ['http:', 'https:'].includes(url.protocol) && url.href.length <= 1000 ? url.href : '';
  } catch {
    return '';
  }
}

const imageLink = (value) => (typeof value === 'string' ? value : value?.url ?? value?.contentUrl ?? '');

function hexColor(value) {
  const color = String(value ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toUpperCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase() : '';
}

/** The look of the site: its theme colour, with black or white text that reads on it, and its logo. Null when the page gives neither. */
export function brandFrom(html, base) {
  const metas = tagsNamed(html, 'meta');
  const links = tagsNamed(html, 'link');
  const metaContent = (test) => metas.find(test)?.content ?? '';
  const linkTo = (rel) => links.find((l) => String(l.rel ?? '').toLowerCase().split(/\s+/).includes(rel))?.href ?? '';

  const organisation = jsonLdNodes(html).find((n) => isType(n, 'Organization') && n.logo);
  const candidates = [imageLink(organisation?.logo), linkTo('apple-touch-icon'), metaContent((m) => m.property === 'og:image'), linkTo('icon')];
  const logoUrl = candidates.map((link) => (link ? absolute(link, base) : '')).find(Boolean) ?? '';

  const primary = hexColor(metaContent((m) => String(m.name ?? '').toLowerCase() === 'theme-color'));
  const colors = primary ? { primary, on_primary: contrastRatio(primary, '#FFFFFF') >= 4.5 ? '#FFFFFF' : '#000000' } : {};
  return primary || logoUrl ? { colors, logoUrl } : null;
}

function offerPrice(offers) {
  for (const offer of [].concat(offers ?? [])) {
    if (offer?.priceCurrency && offer.priceCurrency !== 'INR') continue;
    const price = offer?.price ?? offer?.lowPrice ?? offer?.priceSpecification?.price;
    if (price !== undefined && price !== null && price !== '') return { price: String(price), inStock: !/OutOfStock|SoldOut/i.test(String(offer.availability ?? '')) };
  }
  return null;
}

const plainText = (value) => String(value ?? '').replace(/\0/g, '').replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** The products a page declares in JSON-LD, as draft inputs. A product with no name or price is left out rather than guessed at. */
export function productsFrom(html, base) {
  const found = [];
  const seen = new Set();
  for (const node of jsonLdNodes(html)) {
    if (found.length >= MAX_PRODUCTS || !(isType(node, 'Product') || isType(node, 'ProductGroup'))) continue;
    const name = plainText(node.name).slice(0, MAX_NAME);
    const offer = offerPrice(node.offers) ?? [].concat(node.hasVariant ?? []).slice(0, MAX_VARIANTS).map((v) => offerPrice(v?.offers)).find(Boolean);
    if (name.length < 2 || !offer || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    found.push({
      name,
      price: offer.price,
      description: plainText(node.description).slice(0, MAX_DESCRIPTION),
      images: [].concat(node.image ?? []).slice(0, MAX_IMAGES * 2).map((i) => absolute(imageLink(i), base)).filter(Boolean).slice(0, MAX_IMAGES),
      stock: offer.inStock ? '' : '0',
    });
  }
  return found;
}

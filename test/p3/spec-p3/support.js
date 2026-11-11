// Shared by the Phase 3 spec tests. Written from the PRD (8, 5.3, 5.18, 5.19) and the Phase 3 contract only: everything is
// looked at from the outside, through HTTP on each business's own host, the tables in migrations 300 to 307, the simulators'
// records (tools/sim/sites, tools/sim/shopify, tools/sim/meta) and, in e2e/p3/spec-p3, a real browser.
//
// The world is the Phase 1 spec world (the app, its worker, Postgres or PGlite, the Meta simulator) with the outside web
// behind it: tools/sim/sites serves every fixture shop by host name through safeFetch's test transport, with a Shopify
// storefront mounted at plants.example. Every connection safeFetch makes is recorded with the address it pinned and when.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before } from 'node:test';
import { createSites } from '../../../tools/sim/sites/index.mjs';
import { SITE_ADDRESSES } from '../../../tools/sim/sites/fixtures.mjs';
import { png } from '../../../tools/sim/sites/png.mjs';
import { createShopify } from '../../../tools/sim/shopify/index.mjs';
import { addShop, openWorld, unique } from '../../p1/spec-p1/support.js';
import { hit, multipart, need, noPlatformName, pause, titleOf } from '../../p0/spec-p0/support.js';

export { SITE_ADDRESSES, png };
export { CATALOG_LIMITS, IMPORT_REASONS, PLAN_REASON, formatRupees } from '../../../src/contracts/catalog.js';
export { BIO_UTM, BUYER_BLOCKS, DEFAULT_BLOCKS, RESERVED_PATHS } from '../../../src/contracts/buyer-pages.js';
export { PRESET_SLOTS } from '../../../src/contracts/themes.js';
export { TRAFFIC_PATHS, VISITOR_COOKIE } from '../../../src/contracts/analytics.js';
export { DAY, HOUR, MINUTE, SECOND, unique, captureLogs, consoleUser, onConsole, assertNoPlatformText } from '../../p1/spec-p1/support.js';
export { CONSOLE_HOST, assertBuyerPageClean, hit, multipart, need, nextPhone, noPlatformName, pause, setPlan, signIn, titleOf } from '../../p0/spec-p0/support.js';

export const PRESETS = Object.freeze(['utsav', 'dewdrop', 'tadka', 'gadget-galli', 'mitti']);

export const UA = Object.freeze({
  phone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  instagram: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240305.019; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36 Instagram 320.0.0.42.101 Android (34/14; 420dpi; 1080x2400; Google; Pixel 8; shiba; shiba; en_GB; 567067337)',
  facebookCrawler: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  whatsappCrawler: 'WhatsApp/2.23.20.0 A',
  googleBot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
});

// ---- the world ----------------------------------------------------------------------------------------------------------

/** Private, loopback, link-local, CGNAT, multicast and metadata ranges, IPv4 and IPv6: no connection may ever go to one. */
export function isPrivateAddress(address) {
  const a = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  if (a.includes(':')) {
    if (a === '::' || a === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a);
  }
  const [p, q] = a.split('.').map(Number);
  return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31)
    || (p === 192 && q === 168) || p >= 224;
}

/**
 * The app and its worker with the outside web simulated. `hostGapMs` is safeFetch's per-host gap (0 here unless a test is
 * about it). `world.dials` is every connection safeFetch made: { host, address, at }.
 */
export async function openP3World({ overrides = {}, defaultTenant = '', hostGapMs = 0, worker = true } = {}) {
  const sites = createSites();
  await sites.start();
  const shopify = createShopify();
  await shopify.start();
  sites.mount('plants.example', shopify);
  const inner = sites.transport();
  const dials = [];
  const transport = {
    lookup: inner.lookup,
    dial(url, pinned) {
      dials.push({ host: String(url.hostname).toLowerCase(), port: url.port, address: pinned?.address, at: Date.now() });
      return inner.dial(url, pinned);
    },
  };
  const world = await openWorld({ overrides: { safeFetchTransport: transport, fetchHostGapMs: hostGapMs, ...overrides }, worker, defaultTenant });
  const closeWorld = world.close;
  return Object.assign(world, {
    sites,
    shopify,
    dials,
    /** Connections made since `mark` (an index into dials). */
    dialsSince: (mark) => dials.slice(mark),
    async close() {
      await closeWorld();
      await shopify.close();
      await sites.close();
    },
  });
}

/** One world per test file, opened before its first test. Each test makes its own businesses in it. */
export function useP3World(options) {
  let current;
  before(async () => { current = await openP3World(options); });
  after(async () => { await current?.close(); });
  return new Proxy({}, { get: (_, key) => current?.[key] });
}

// ---- a business -----------------------------------------------------------------------------------------------------------

const json = (res) => {
  try {
    return res.json();
  } catch {
    return null;
  }
};

/** A business with Instagram connected (Phase 1 addShop) and Phase 3 helpers. Plans default to tier 3. */
export async function addP3Shop(world, options = {}) {
  const shop = await addShop(world, options);
  const sql = shop.sql;
  const id = shop.tenantId;
  Object.assign(shop, {
    /** The answer of a call, whatever its status. */
    send: (method, path, body, extra = {}) => shop.api(path, { method, ...(body === undefined ? {} : { body }), ...extra }),
    /** A call that must answer `status`, as JSON (or null for an empty body). */
    async must(method, path, body, status = 200, what = `${method} ${path}`) {
      const res = need(await shop.send(method, path, body), status, what);
      return res.text ? json(res) : null;
    },
    /** A buyer page on this business's own host, as a phone would load it. */
    open: (path, { ua = UA.phone, headers = {}, ...rest } = {}) => hit(world, path, { host: shop.host, headers: { 'user-agent': ua, ...headers }, ...rest }),

    /** An uploaded PNG in this business's media, by its /media/<id> link. */
    async upload(color = '#C8794E', { width = 800, height = 800, filename = 'photo.png' } = {}) {
      const form = multipart('file', filename, 'image/png', png({ width, height, color }));
      const res = need(await hit(world, '/api/v1/media', { host: shop.host, method: 'POST', token: shop.token, headers: form.headers, body: form.body }), 201, 'Uploading an image');
      return res.json().url;
    },
    async product(fields = {}) {
      const n = unique();
      return shop.must('POST', '/products', { name: `Product ${n}`, pricePaise: 49900, active: true, ...fields }, 201, 'Creating a product');
    },
    getProduct: (productId) => shop.must('GET', `/products/${productId}`, undefined, 200, 'Reading a product'),

    /** A post, reel or story on Instagram, then its landing page. `media` goes to the Meta simulator. */
    async page({ kind = 'reel', productIds, caption = 'A reel', media = {}, ...fields } = {}) {
      let ids = productIds;
      if (!ids) ids = [(await shop.product()).id];
      const make = { reel: shop.reel, post: shop.post, story: shop.story }[kind];
      const mediaId = await make({ caption, ...media });
      return shop.must('POST', '/pages', { kind, mediaId, productIds: ids, ...fields }, 201, `Creating a ${kind} landing page`);
    },
    async category(name, fields = {}) {
      return shop.must('POST', '/categories', { name, ...fields }, 201, `Creating the category ${name}`);
    },
    /** The category's sequence as page ids, pinned first. */
    async sequence(categoryId) {
      return (await shop.must('GET', `/categories/${categoryId}/reels`, undefined, 200, 'Reading a category order')).items;
    },
    async addToCategory(categoryId, pageIds, at = 'bottom') {
      let last;
      for (const pageId of [pageIds].flat()) last = await shop.must('POST', `/categories/${categoryId}/reels`, { pageId, at }, 200, 'Adding a reel to a category');
      return last;
    },
    setOrder: (categoryId, order, pinned = []) => shop.must('PUT', `/categories/${categoryId}/reels`, { pinned, order }, 200, 'Saving a category order'),

    async importLink(url, what = `Importing ${url}`) {
      return shop.must('POST', '/imports/link', { url }, 200, what);
    },
    /** Saves an import item's draft as a product, with the draft's own fields unless `changes` say otherwise. */
    async saveDraft(result, changes = {}) {
      assert.ok(result.itemId, `The import has no item to save: ${JSON.stringify(result).slice(0, 300)}`);
      const d = result.draft;
      const body = {
        name: d.name,
        pricePaise: d.pricePaise ?? 0,
        ...(d.mrpPaise !== null && d.mrpPaise !== undefined && d.mrpPaise > (d.pricePaise ?? 0) ? { mrpPaise: d.mrpPaise } : {}),
        description: d.description?.slice(0, 5000) ?? '',
        images: (d.images ?? []).slice(0, 6),
        externalUrl: d.externalUrl,
        inStock: d.inStock,
        tags: (d.tags ?? []).slice(0, 50),
        options: d.options ?? [],
        variants: (d.variants ?? []).map((v) => ({ ...v, mrpPaise: v.mrpPaise !== null && v.mrpPaise >= v.pricePaise ? v.mrpPaise : null })),
        ...changes,
      };
      return (await shop.must('POST', `/import-items/${result.itemId}/save`, body, 201, 'Saving an imported draft')).productId;
    },
    /** Imports one link and saves it: the product's id. */
    async importAndSave(url, changes) {
      const result = await shop.importLink(url);
      assert.equal(result.status, 'draft', `Importing ${url}: ${JSON.stringify(result).slice(0, 400)}`);
      return shop.saveDraft(result, changes);
    },
    /** Waits for an import job (run by the worker) to finish, and returns it. */
    async job(jobId, ms = 90_000) {
      const end = Date.now() + ms;
      let current;
      for (;;) {
        current = await shop.must('GET', `/imports/${jobId}`, undefined, 200, 'Reading an import job');
        if (['done', 'failed'].includes(current.status) || Date.now() > end) return current;
        await shop.settle({ ms: 3000, roundMs: 300 });
      }
    },
    async items(jobId, status = 'all') {
      const out = [];
      let cursor;
      do {
        const pageOf = await shop.must('GET', `/imports/${jobId}/items?status=${status}&limit=100${cursor ? `&cursor=${cursor}` : ''}`, undefined, 200, 'Reading import items');
        out.push(...pageOf.items);
        cursor = pageOf.nextCursor;
      } while (cursor);
      return out;
    },
    /** Every product of the business through the API, following the cursor. */
    async products(query = '') {
      const out = [];
      let cursor;
      do {
        const pageOf = await shop.must('GET', `/products?limit=100${query ? `&${query}` : ''}${cursor ? `&cursor=${cursor}` : ''}`, undefined, 200, 'Listing products');
        out.push(...pageOf.items);
        cursor = pageOf.nextCursor;
      } while (cursor);
      return out;
    },
    productRows: () => sql('SELECT * FROM products WHERE tenant_id = $1 ORDER BY id', [id]),
    mediaRows: () => sql('SELECT id, mime, size, created_at FROM media WHERE tenant_id = $1 ORDER BY created_at', [id]),
    leadRows: () => sql('SELECT * FROM leads WHERE tenant_id = $1 ORDER BY id', [id]),
    trafficEvents: (names) => sql(`SELECT * FROM traffic_events WHERE tenant_id = $1 ${names ? 'AND name = ANY($2)' : ''} ORDER BY id`, names ? [id, names] : [id]),
    sessions: () => sql('SELECT * FROM traffic_sessions WHERE tenant_id = $1', [id]),
    audit: (pattern) => sql('SELECT * FROM audit_log WHERE tenant_id = $1 AND (action ~* $2 OR target ~* $2) ORDER BY id', [id, pattern]),
    ownerAlerts: () => sql(`SELECT * FROM alerts WHERE tenant_id = $1 AND audience = 'owner' ORDER BY id`, [id]),
    /** Sets this business's saved WhatsApp number through the settings API. */
    whatsapp: (number) => shop.must('PATCH', '/settings', { supportWhatsapp: number }, 200, 'Saving the WhatsApp number'),
  });
  return shop;
}

// ---- reading a buyer page -------------------------------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/', nbsp: ' ' };
export const decode = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
  if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
  if (/^#x/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
  if (/^#\d/.test(name)) return String.fromCodePoint(Number(name.slice(1)));
  return whole;
});

/** The attributes of one tag, entities decoded. */
export function attrsOf(tag) {
  const out = {};
  for (const m of String(tag).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  for (const m of String(tag).replace(/=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g, '').matchAll(/\s([\w-]+)(?=[\s/>])/g)) if (!(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = '';
  return out;
}

/** Every <name ...> tag in the page, as its attributes. */
export const tagsOf = (html, name) => [...String(html).matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => ({ ...attrsOf(m[0]), _at: m.index, _tag: m[0] }));

/** The page's <head> meta tags, by property or name. */
export function metaOf(html) {
  const out = {};
  for (const t of tagsOf(html, 'meta')) {
    const key = t.property ?? t.name;
    if (key && !(key in out)) out[key] = t.content ?? '';
  }
  return out;
}

/** Visible text, tags and scripts removed, entities decoded, spaces squeezed. */
export const textOf = (html) => decode(String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Every link: { href, text, product, at }. */
export function linksOf(html) {
  return [...String(html).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => {
    const a = attrsOf(m[0].slice(0, m[0].indexOf('>') + 1));
    return { href: a.href ?? '', text: textOf(m[1]), product: a['data-product'] ? Number(a['data-product']) : null, attrs: a, at: m.index };
  });
}

/** The product ids on the page's cards, in order, each once. */
export function productIdsOf(html) {
  const seen = [];
  for (const m of String(html).matchAll(/data-product="(\d+)"/g)) if (!seen.includes(Number(m[1]))) seen.push(Number(m[1]));
  return seen;
}

/** The landing page slugs a page links to (/r/<slug>, not its products), in order, each once. */
export function reelSlugsOf(html, { exclude = [] } = {}) {
  const seen = [];
  for (const { href } of linksOf(html)) {
    const m = /^(?:https?:\/\/[^/]+)?\/r\/([a-z0-9-]+)\/?(?:[?#]|$)/i.exec(href);
    if (m && !exclude.includes(m[1]) && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/** The page cut into its <section> blocks: { heading, html, slugs }. */
export function sectionsOf(html) {
  const parts = String(html).split(/(?=<section\b)/i).slice(1);
  return parts.map((part) => {
    const end = part.search(/<\/section>/i);
    const body = end === -1 ? part : part.slice(0, end);
    const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(body);
    return { heading: heading ? textOf(heading[1]) : '', html: body, slugs: reelSlugsOf(body) };
  });
}

/** The page's inline stylesheet(s), joined. */
export const cssOf = (html) => [...String(html).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');

/** The page's structure: section-like tags with styles and links removed. Two presets of one page must match (F-105). */
export const skeletonOf = (html) => (String(html).replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<link[^>]+fonts\.googleapis[^>]+>/gi, '')
  .match(/<(header|main|section|footer|article|h1|h2|h3|nav|form)\b[^>]*>/gi) ?? [])
  .map((tag) => tag.replace(/\s(style|content|href|src|srcset|data-[\w-]+|aria-label|alt|title|value)="[^"]*"/gi, '').replace(/\s+/g, ' '));

/** A branded 404: not found, in the business's own name, with no platform name anywhere. */
export function assertBranded404(res, shop, what) {
  assert.equal(res.status, 404, `${what}: expected the branded 404, got ${res.status}: ${res.text.slice(0, 200)}`);
  assert.match(res.headers['content-type'] ?? '', /text\/html/, `${what}: the 404 is a page`);
  assert.ok(res.text.includes(shop.name), `${what}: the 404 doesn't carry the seller's name`);
  noPlatformName(`${what} (404 page)`, res.text);
  noPlatformName(`${what} (404 headers)`, res.headers);
}

/** A page served straight, never a redirect. */
export function assertNoRedirect(res, what) {
  assert.ok(res.status < 300 || res.status >= 400, `${what}: answered ${res.status} to ${res.headers.location}`);
  assert.equal(res.headers.location, undefined, `${what}: sent a Location header`);
  assert.equal(res.headers.refresh, undefined, `${what}: sent a Refresh header`);
  assert.doesNotMatch(res.text, /<meta[^>]+http-equiv=["']?refresh/i, `${what}: carries a meta refresh`);
}

// ---- the lead form --------------------------------------------------------------------------------------------------------

/** The page's form posting to `action`: its fields, as a browser would see them. Null when there is none. */
export function formOf(html, action = '/lead') {
  for (const m of String(html).matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const open = attrsOf(m[0].slice(0, m[0].indexOf('>') + 1));
    const target = (open.action ?? '').replace(/^https?:\/\/[^/]+/, '');
    if (!target.split('?')[0].endsWith(action)) continue;
    const fields = [
      ...tagsOf(m[0], 'input').map((t) => ({ tag: 'input', type: (t.type ?? 'text').toLowerCase(), ...t })),
      ...tagsOf(m[0], 'textarea').map((t) => ({ tag: 'textarea', type: 'textarea', ...t })),
      ...[...m[0].matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)].map((s) => {
        const a = attrsOf(s[0].slice(0, s[0].indexOf('>') + 1));
        const options = tagsOf(s[1], 'option');
        const chosen = options.find((o) => 'selected' in o) ?? options[0];
        return { tag: 'select', type: 'select', ...a, value: chosen?.value ?? '' };
      }),
    ].filter((f) => f.name);
    return { action: target || action, method: (open.method ?? 'get').toLowerCase(), fields, html: m[0], text: textOf(m[0]) };
  }
  return null;
}

const isFirstName = (f) => /first|^name$|fname|given/i.test(f.name) && ['text', 'textarea'].includes(f.type);
const isPhone = (f) => f.type === 'tel' || (/phone|mobile|whats/i.test(f.name) && !['checkbox', 'hidden'].includes(f.type));
const isEmail = (f) => f.type === 'email' || (/e-?mail/i.test(f.name) && !['checkbox', 'hidden'].includes(f.type));

/**
 * The body a shopper's browser would send. Hidden fields keep their values; the honeypot (any other text field) stays empty
 * unless `honeypot` is set; consent boxes are ticked only when `consent` is true (or for the channels it names).
 */
export function fillLead(form, { firstName, phone = '', email = '', consent = true, honeypot = '' } = {}) {
  const body = new URLSearchParams();
  for (const f of form.fields) {
    if (f.type === 'hidden') body.append(f.name, f.value ?? '');
    else if (f.type === 'checkbox') {
      const wanted = consent === true || (Array.isArray(consent) && consent.some((c) => `${f.name} ${f.value ?? ''}`.toLowerCase().includes(c)));
      if (wanted) body.append(f.name, f.value || 'on');
    } else if (f.type === 'submit' || f.type === 'button') continue;
    else if (isFirstName(f)) body.append(f.name, firstName ?? '');
    else if (isPhone(f)) body.append(f.name, phone);
    else if (isEmail(f)) body.append(f.name, email);
    else if (f.type === 'select' || f.type === 'radio') body.append(f.name, f.value ?? '');
    else body.append(f.name, honeypot);
  }
  return body.toString();
}

/** Submits the lead form found on `path`, carrying the page's cookies, and follows one redirect on the same host. */
export async function submitLead(world, shop, path, values = {}, { ip = `198.51.100.${crypto.randomInt(1, 250)}` } = {}) {
  const page = await shop.open(path, { headers: { 'x-forwarded-for': ip } });
  need(page, 200, `The page with the lead form ${path}`);
  const form = formOf(page.text);
  assert.ok(form, `${path} has no lead form posting to /lead`);
  const cookie = [page.headers['set-cookie'] ?? []].flat().map((c) => c.split(';')[0]).join('; ');
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA.phone, 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), referer: `https://${shop.host}${path}` };
  const sent = await hit(world, form.action, { host: shop.host, method: 'POST', headers, body: fillLead(form, values) });
  let landed = sent;
  if (sent.status >= 300 && sent.status < 400 && sent.headers.location) {
    const next = new URL(sent.headers.location, `https://${shop.host}`);
    assert.equal(next.host, shop.host, 'The lead form sends the shopper to another site');
    landed = await hit(world, `${next.pathname}${next.search}`, { host: shop.host, headers: { 'user-agent': UA.phone, ...(cookie ? { cookie } : {}) } });
  }
  return { page, form, sent, landed };
}

// ---- colours --------------------------------------------------------------------------------------------------------------

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Hue in degrees, 0 to 360. */
export function hueOf(hex) {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
export const hueGap = (a, b) => Math.min(Math.abs(hueOf(a) - hueOf(b)), 360 - Math.abs(hueOf(a) - hueOf(b)));
export const isHex = (value) => /^#[0-9a-f]{6}$/i.test(String(value));

// ---- waiting --------------------------------------------------------------------------------------------------------------

/** Runs `check` until it gives something truthy or `ms` pass, running the worker for `shop` between tries. */
export async function eventually(shop, check, { ms = 15_000, every = 500, settle = true } = {}) {
  const end = Date.now() + ms;
  let value;
  for (;;) {
    value = await check();
    if (value || Date.now() > end) return value;
    if (settle) await shop.settle({ ms: Math.min(3000, every * 4), roundMs: 200 });
    else await pause(every);
  }
}

/** Text with curly apostrophes made straight, so the PRD's wording and the contract's compare. */
export const plain = (s) => String(s ?? '').replace(/[’‘]/g, "'");

export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** A product page of a fixture site, made for one test: JSON-LD Product with price and stock. */
export function productPageHtml({ name, price, availability = 'InStock', image } = {}) {
  const offers = { '@type': 'Offer', price, priceCurrency: 'INR', availability: `https://schema.org/${availability}` };
  const data = { '@context': 'https://schema.org', '@type': 'Product', name, ...(image ? { image } : {}), offers };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><script type="application/ld+json">${JSON.stringify(data)}</script></head><body><h1>${name}</h1></body></html>`;
}

export { titleOf as pageTitle };

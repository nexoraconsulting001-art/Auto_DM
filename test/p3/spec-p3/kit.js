// Everything in support.js, plus what the import, page, category, creator, lead and theme specs share. Like support.js, it is
// written from the PRD and the Phase 3 contract only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { consoleUser, hit, multipart, need, onConsole, setPlan } from '../../p0/spec-p0/support.js';
import { unique } from '../../p1/spec-p1/support.js';
import { TRAFFIC_PATHS, VISITOR_COOKIE } from '../../../src/contracts/analytics.js';
import { CSV_COLUMNS, IMPORT_REASONS } from '../../../src/contracts/catalog.js';
import { generateStorefrontProducts } from '../../../tools/sim/shopify/index.mjs';
import { UA, plain } from './support.js';

export * from './support.js';
export { CSV_COLUMNS, generateStorefrontProducts };

/** A whole HTML page of an outside site. */
export const sitePage = (head, body = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

/** An Open Graph product page: a name, a product photo and (unless null) a price. */
export const ogPage = ({ name, price = '499', image = 'https://shop.example/img/any.png', extra = '' }) => sitePage(
  `<title>${name}</title><meta property="og:title" content="${name}">${image ? `<meta property="og:image" content="${image}">` : ''}${price === null ? '' : `<meta property="product:price:amount" content="${price}"><meta property="product:price:currency" content="INR">`}${extra}`,
);

/** A JSON-LD Product page with exactly this `offers.price` value (text or number) and a product photo. */
export function jsonLdPage({ name, price, availability = 'InStock', image = 'https://shop.example/img/any.png', extra = {} }) {
  const data = { '@context': 'https://schema.org', '@type': 'Product', name, image, offers: { '@type': 'Offer', price, priceCurrency: 'INR', availability: `https://schema.org/${availability}` }, ...extra };
  return sitePage(`<title>${String(name).replace(/[<>&]/g, '')}</title><script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`);
}

/** Pasting one link: the result, or the refusal of the address itself (400). Never a server error. */
export async function paste(shop, url) {
  const started = Date.now();
  const res = await shop.send('POST', '/imports/link', { url });
  const took = Date.now() - started;
  assert.ok(res.status < 500, `Pasting ${url} answered ${res.status}: ${res.text.slice(0, 300)}`);
  if (res.status === 200) return { ...res.json(), took, http: 200, raw: res.text };
  assert.equal(res.status, 400, `Pasting ${url} answered ${res.status}: ${res.text.slice(0, 300)}`);
  const body = res.json();
  return { status: 'rejected', reason: body.reason ?? null, message: `${body.error} ${Object.values(body.fields ?? {}).join(' ')}`, draft: null, itemId: null, productId: null, readFrom: '', took, http: 400, raw: res.text };
}

/** The import was turned away with this reason and the contract's wording for it. */
export function assertTurnedAway(result, code, what) {
  assert.ok(!['draft', 'existing'].includes(result.status), `${what}: expected a refusal (${code}), got ${result.status}: ${result.raw.slice(0, 300)}`);
  if (result.http === 200) assert.equal(result.reason, code, `${what}: ${result.raw.slice(0, 300)}`);
  assert.ok(plain(result.message).includes(plain(IMPORT_REASONS[code])), `${what}: the owner is told "${IMPORT_REASONS[code]}", got "${result.message}"`);
}

/** Replaces the Shopify storefront at plants.example: `products` in the simulator's own shape (prices in paise). */
export const setStorefront = (world, products, extra = {}) => world.shopify.post('/storefront', { feedStatus: 200, ...extra, products });

/** Starts a Shopify feed import and waits for the worker to finish it. */
export async function importFeed(shop, storeUrl = 'https://plants.example', ms = 300_000) {
  const job = await shop.must('POST', '/imports/shopify', { storeUrl }, 202, `Importing the feed of ${storeUrl}`);
  return shop.job(job.id, ms);
}

// ---- CSV ------------------------------------------------------------------------------------------------------------------

const csvCell = (value) => {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV text from rows of objects keyed by CSV_COLUMNS. */
export function csvText(rows, { columns = CSV_COLUMNS, eol = '\n', bom = false } = {}) {
  const lines = [columns.join(','), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(','))];
  return `${bom ? '\uFEFF' : ''}${lines.join(eol)}${eol}`;
}

/** Uploads a CSV file the way the console does. The answer, whatever its status. */
export function uploadCsv(world, shop, data, { filename = 'products.csv', mime = 'text/csv' } = {}) {
  const form = multipart('file', filename, mime, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
  return hit(world, '/api/v1/imports/csv', { host: shop.host, method: 'POST', token: shop.token, headers: form.headers, body: form.body });
}

/** Uploads a CSV that must be taken, waits for the worker, and gives the finished job. */
export async function importCsv(world, shop, data, options) {
  const res = need(await uploadCsv(world, shop, data, options), 202, 'Uploading a CSV');
  return shop.job(res.json().id, 240_000);
}

/** Items of a job that were not taken (refused or failed). */
export const turnedAway = async (shop, jobId) => (await shop.items(jobId)).filter((i) => ['refused', 'failed'].includes(i.status));

/**
 * "Reported by line": the contract doesn't say whether `line` counts the header. Either the file's own line numbers (header is
 * line 1) or the data rows' (first row is 1), but one of them, for every row.
 */
export function assertLines(items, dataRows, what) {
  const got = items.map((i) => i.line).sort((a, b) => a - b);
  const asFile = dataRows.map((n) => n + 1);
  const ok = JSON.stringify(got) === JSON.stringify(dataRows) || JSON.stringify(got) === JSON.stringify(asFile);
  assert.ok(ok, `${what}: reported lines ${got.join(', ')}, expected rows ${dataRows.join(', ')} (or file lines ${asFile.join(', ')})`);
}

// ---- files ----------------------------------------------------------------------------------------------------------------

const cellText = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'object') return v;
  if (v.formula !== undefined || v.sharedFormula !== undefined) return { formula: v.formula ?? v.sharedFormula };
  if (v.richText) return v.richText.map((r) => r.text).join('');
  if (v.hyperlink) return { hyperlink: v.hyperlink, text: v.text };
  return v.text ?? v.result ?? String(v);
};

/** The rows of an XLSX file's first sheet. A formula cell comes back as { formula }, a link as { hyperlink }. */
export async function xlsxRows(buffer) {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const out = [];
  book.worksheets[0].eachRow({ includeEmpty: false }, (row) => out.push(row.values.slice(1).map(cellText)));
  return out;
}

/** A small RFC 4180 reader: rows of cells. */
export function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Asks for a leads file, waits for it, and fetches it as the owner. */
export async function leadFile(world, shop, format = 'xlsx') {
  let download = await shop.must('POST', '/lead-downloads', { format }, 201, `Asking for the leads as ${format}`);
  for (let i = 0; i < 40 && !['ready', 'failed', 'expired'].includes(download.status); i++) {
    await shop.settle({ ms: 2500, roundMs: 300 });
    download = await shop.must('GET', `/lead-downloads/${download.id}`, undefined, 200, 'Reading the leads file');
  }
  assert.equal(download.status, 'ready', `The leads file is ${download.status}`);
  assert.ok(download.fileUrl, 'The leads file has no address');
  const url = new URL(download.fileUrl, world.base);
  const path = `${url.pathname}${url.search}`;
  const file = need(await hit(world, path, { host: shop.host, token: shop.token }), 200, 'Fetching the leads file');
  return { download, file, path };
}

// ---- a shopper's browser --------------------------------------------------------------------------------------------------

/** A shopper with a cookie jar on one business's host: opens pages and sends what the page's beacon would. */
export function shopperOf(world, shop, { ua = UA.phone, ip = `198.51.100.${crypto.randomInt(1, 250)}` } = {}) {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const headers = (extra = {}) => ({ 'user-agent': ua, 'x-forwarded-for': ip, ...(cookie() ? { cookie: cookie() } : {}), ...extra });
  const absorb = (res) => {
    for (const line of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      jar[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
    return res;
  };
  const self = {
    jar,
    get visitorId() { return jar[VISITOR_COOKIE]; },
    /** Loads a page; when it carries the traffic script, reports the view as a browser running that script would. */
    async open(path, { referer, report = true } = {}) {
      const res = absorb(await hit(world, path, { host: shop.host, headers: headers(referer ? { referer } : {}) }));
      if (report && res.status === 200 && res.text.includes(TRAFFIC_PATHS.script)) {
        const url = new URL(path, `https://${shop.host}`);
        const utm = Object.fromEntries(['source', 'medium', 'campaign', 'content'].map((k) => [k, url.searchParams.get(`utm_${k}`) ?? '']));
        await self.beacon({ name: 'page_view', path: `${url.pathname}${url.search}`, utm, ...(referer ? { referrer: referer } : {}) });
      }
      return res;
    },
    /** One beacon event, as the page's script sends it when the shopper taps. */
    async beacon(event) {
      return absorb(await hit(world, TRAFFIC_PATHS.event, { host: shop.host, method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: { path: '/', ...event } }));
    },
  };
  return self;
}

// ---- plans, features and the console --------------------------------------------------------------------------------------

/** Moves a business to another plan, the way a billing change lands on its row. */
export const setTier = (world, shop, plan) => setPlan(world, shop, plan);

/** Turns one feature on or off for one business only (tenant_features: 5.18, F-96). */
export const setFeature = (shop, feature, enabled = true, limit = null) => shop.sql(
  `INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, $2, $3, $4)
   ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled, limit_value = EXCLUDED.limit_value`,
  [shop.tenantId, feature, enabled, limit],
);

/** A platform operator and a way to call the Platform Console as them. */
export async function operatorOf(world, role = 'super_admin') {
  const who = await consoleUser(world, role);
  const send = (method, path, body) => onConsole(world, who, path, { method, ...(body === undefined ? {} : { body }) });
  return {
    ...who,
    send,
    async must(method, path, body, status = 200, what = `Console ${method} ${path}`) {
      const res = need(await send(method, path, body), status, what);
      return res.text ? res.json() : null;
    },
  };
}

// ---- the creator page and the lead form -----------------------------------------------------------------------------------

/** Turns the creator page on at /<slug>. */
export async function creatorPage(shop, fields = {}) {
  const slug = fields.slug ?? `c${unique()}`.toLowerCase();
  return shop.must('PATCH', '/creator-page', { slug, enabled: true, displayName: shop.name, ...fields }, 200, 'Saving the creator page');
}

/** Turns the lead form on for a surface, with a consent wording for `channels`. */
export async function leadFormOn(shop, surface = 'landing', { channels = ['whatsapp', 'email'], offerLine } = {}) {
  await shop.must('PUT', '/lead-forms/consent', { channels }, 200, 'Saving the consent wording');
  return shop.must('PATCH', '/lead-forms', { surface, enabled: true, ...(offerLine === undefined ? {} : { offerLine }) }, 200, `Turning the lead form on for ${surface}`);
}

// ---- pages ----------------------------------------------------------------------------------------------------------------

/** The page gzipped, as it travels. */
export const gzipSize = (text) => zlib.gzipSync(Buffer.from(text, 'utf8')).length;

/** Nothing an outside name, caption or page smuggled in is live HTML: the fixtures' own payloads never appear unescaped. */
export function assertNoLiveMarkup(html, what) {
  assert.doesNotMatch(html, /<script>\s*(alert|steal)\(/i, `${what}: a script from outside is live in the page`);
  assert.doesNotMatch(html, /<(img|svg|body|video)\b[^>]*\son\w+\s*=\s*["']?\s*alert/i, `${what}: an event handler from outside is live in the page`);
  assert.doesNotMatch(html, /<iframe\b/i, `${what}: an iframe is live in the page`);
  assert.doesNotMatch(html, /(href|src|action)\s*=\s*["']?\s*(javascript|data|vbscript):/i, `${what}: a javascript: or data: link is live in the page`);
}

/** Names and text that try to break out of HTML, attributes, scripts and styles. */
export const HOSTILE_NAMES = Object.freeze([
  '<script>alert(1)</script>Lamp',
  '"><img src=x onerror=alert(1)>',
  "'-alert(1)-'",
  '</title><script>alert(1)</script>',
  '</style><script>alert(1)</script>',
  '{{7*7}}${7*7}',
]);

/** The seven share tags of 8.12, as { name: content }. Fails naming any that is missing or empty. */
export function shareTags(html, what) {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
  const out = {};
  const missing = [];
  for (const key of ['og:url', 'og:title', 'og:description', 'og:image', 'og:type', 'twitter:card']) {
    const tag = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => new RegExp(`(property|name)=["']${key}["']`, 'i').test(t));
    const content = tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] ?? '' : '';
    if (!content) missing.push(key);
    out[key] = content.replace(/&amp;/g, '&');
  }
  const dims = ['og:image:width', 'og:image:height'].map((key) => {
    const tag = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => t.includes(`"${key}"`));
    return tag ? Number(/content=["'](\d+)["']/i.exec(tag)?.[1] ?? 0) : 0;
  });
  if (!dims[0] || !dims[1]) missing.push('og:image size');
  out['og:image:width'] = dims[0];
  out['og:image:height'] = dims[1];
  assert.deepEqual(missing, [], `${what}: share tags missing from <head>`);
  return out;
}

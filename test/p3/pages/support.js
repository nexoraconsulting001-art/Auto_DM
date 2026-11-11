// Shared by the landing page and theme tests: one app on the site simulator, a signed-in owner, and helpers that put products,
// pages and a second business in place. Nothing here reaches a real service.
import '../../../tools/net-guard.mjs';
import zlib from 'node:zlib';
import { bindTenant } from '../../../src/repos/index.js';
import { createSites } from '../../../tools/sim/sites/index.mjs';
import { png } from '../../../tools/sim/sites/png.mjs';
import { OWNER, fakeIg, startApp } from '../../helpers.js';

export const PHONE_UA = 'Mozilla/5.0 (Linux; Android 13; SM-A346E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 312.0.0.34.111 Android';
export const FACEBOOK_CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
export const HOUR = 3_600_000;

/** An Instagram client whose media a test can set: `media` is id -> the object Instagram would return. */
export function scriptedIg(media = {}, { stories = [] } = {}) {
  const ig = fakeIg();
  const mediaCalls = [];
  return Object.assign(ig, {
    media,
    mediaCalls,
    getMedia: async (_account, id) => {
      mediaCalls.push(String(id));
      if (media[id] === null) throw Object.assign(new Error('Unsupported get request'), { status: 400, kind: 'validation' });
      return { id, caption: 'Brunch look', permalink: `https://www.instagram.com/reel/${id}/`, media_type: 'VIDEO', ...(media[id] ?? {}) };
    },
    listMedia: async () => ({ data: Object.entries(media).filter(([, m]) => m && m.media_product_type !== 'STORY').map(([id, m]) => ({ id, ...m })) }),
    listStories: async () => ({ data: stories }),
  });
}

/** One business on plan `plan`, with the owner's API and the fixture websites. Closed when the test ends. */
export async function shop(t, { plan = 't2', ig = scriptedIg(), overrides = {}, whatsapp = '' } = {}) {
  const sites = createSites();
  await sites.start();
  const app = await startApp({ ig, overrides: { safeFetchTransport: sites.transport(), fetchHostGapMs: 0, ...overrides } });
  t.after(async () => {
    app.close();
    await sites.close();
  });
  await setPlan(app, app.tenant, plan);
  if (whatsapp) await app.repos.settings.update({ support_whatsapp: whatsapp });
  const api = await ownerApi(app);
  return { app, sites, api, ig, repos: app.repos, tenant: app.tenant, host: null };
}

export const setPlan = (app, tenant, plan) => app.db.platform.query('UPDATE tenants SET plan = $2 WHERE id = $1', [tenant.id, plan]);

/** Calls /api/v1 as the default business's owner: api('POST', '/pages', body) -> { status, body }. */
export async function ownerApi(app, { host = null, phone = OWNER.phone, password = OWNER.password } = {}) {
  const headers = host ? { 'x-forwarded-host': host } : {};
  const login = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ phone, password }) });
  if (login.status !== 201) throw new Error(`sign-in failed with ${login.status}`);
  const { token } = await login.json();
  const call = async (method, path, body) => {
    const res = await fetch(`${app.base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };
  /** Uploads an image the way the console does, so the app itself holds the file: returns its /media/<id> path. */
  call.upload = async (buffer, type = 'image/png') => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type }), 'photo.png');
    const res = await fetch(`${app.base}/api/v1/media`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    if (res.status !== 201) throw new Error(`upload failed with ${res.status}: ${await res.text()}`);
    return (await res.json()).url;
  };
  return call;
}

/** A second business on the same app, with its own owner, repos and web address. */
export async function secondShop(app, { slug = 'two', name = 'Second Shop', plan = 't2', domain = 'bhava.test' } = {}) {
  const tenant = await app.platform.tenants.create({ slug, name, plan });
  const repos = bindTenant(app.platform, tenant);
  const owner = { phone: '9000000002', password: 'second-pass' };
  await repos.users.ensureOwner(owner);
  await repos.settings.update({ store_name: name });
  await app.platform.tenants.linkIgAccount(tenant.id, `IG-${slug}`, slug);
  await repos.igAccounts.setToken(`IG-${slug}`, `token-${slug}`);
  const host = `${slug}.${domain}`;
  return { tenant, repos, host, owner, api: await ownerApi(app, { host, ...owner }) };
}

/** A product a page can show. `externalUrl` makes it a link-out product; `image` is a path or address for its first photo. */
export async function addProduct(app, repos, tenant, { name, price = '349', mrp = '', externalUrl = '', image = '', active = 'on', whatsappOrder = null, fetchStatus = 'none', inStock = true } = {}) {
  const product = await repos.products.create({ name, price, mrp, active });
  await app.db.platform.query(
    `UPDATE products SET external_url = $3, images = $4::jsonb, whatsapp_order = $5, fetch_status = $6, in_stock = $7 WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, product.id, externalUrl, JSON.stringify(image ? [image] : []), whatsappOrder, fetchStatus, inStock],
  );
  return { ...product, external_url: externalUrl };
}

export const photo = (color = '#C8794E', width = 640, height = 640) => png({ width, height, color });

/** Stores an image as the business's own media, through the app, and returns its /media/<id> path. `s` is a shop or a second shop. */
export const upload = (s, color, width = 640, height = 640) => s.api.upload(photo(color, width, height));

/** Fetches a buyer page the way a phone would: { status, headers, text }, following nothing. */
export async function open(app, path, { host = null, ua = PHONE_UA, headers = {}, gzip = false } = {}) {
  const res = await fetch(`${app.base}${path}`, {
    redirect: 'manual',
    headers: { 'user-agent': ua, ...(host ? { 'x-forwarded-host': host } : {}), ...(gzip ? {} : { 'accept-encoding': 'identity' }), ...headers },
  });
  return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text(), setCookie: res.headers.getSetCookie?.() ?? [] };
}

/** The same page as raw bytes with gzip asked for, to measure what a phone downloads. */
export async function openCompressed(app, path, { ua = PHONE_UA } = {}) {
  const res = await fetch(`${app.base}${path}`, { headers: { 'user-agent': ua, 'accept-encoding': 'gzip' } });
  const text = await res.text();
  return { status: res.status, encoding: res.headers.get('content-encoding'), text, gzippedBytes: zlib.gzipSync(Buffer.from(text)).length, declaredLength: Number(res.headers.get('content-length')) };
}

export const metaTag = (html, property) => new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(html)?.[1] ?? null;

/** The product cards of a page, in order: [{ name, href, wa }]. */
export function cards(html) {
  return [...html.matchAll(/<article class="card[^"]*">([\s\S]*?)<\/article>/g)].map(([, body]) => ({
    name: /<h3>([^<]*)<\/h3>/.exec(body)?.[1] ?? '',
    number: /<span class="num">([^<]*)<\/span>/.exec(body)?.[1] ?? '',
    price: /<span class="price">([^<]*)<\/span>/.exec(body)?.[1] ?? '',
    href: decode(/<a class="btn" href="([^"]*)"/.exec(body)?.[1] ?? ''),
    wa: decode(/<a class="btn-wa" href="([^"]*)"/.exec(body)?.[1] ?? ''),
    productId: /data-product="(\d+)"/.exec(body)?.[1] ?? '',
  }));
}

export const decode = (text) => String(text).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Section headings of a page, in order, which is the page's structure whatever the look. */
export function sections(html) {
  const body = html.replace(/<style>[\s\S]*?<\/style>/g, '');
  const found = body.matchAll(/<(?:(section|article|footer|header)\b[^>]*?(?: class="([^"]*)")?[^>]*|(div class="ticker")[^>]*)>/g);
  return [...found].map((m) => m[3] ?? `${m[1]}${m[2] ? `.${m[2].split(' ')[0]}` : ''}`);
}

export async function waitFor(check, { tries = 60, everyMs = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return null;
}

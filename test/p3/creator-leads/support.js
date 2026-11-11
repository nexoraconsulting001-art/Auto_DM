// Shared by the creator-leads tests: the real app on a fresh database, a second business on its own host, landing pages to put
// in categories, and requests with a real Host header.
import '../../../tools/net-guard.mjs';
import crypto from 'node:crypto';
import http from 'node:http';
import { bindTenant } from '../../../src/repos/index.js';
import { OWNER, startApp } from '../../helpers.js';

let serial = 17_900_000_000_000_000n;
export const nextMediaId = () => String(++serial);

/** One request with any Host header, cookies and body; redirects are not followed. */
export function raw(port, path, { method = 'GET', host = '127.0.0.1', headers = {}, body, form } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const sent = { host, ...headers };
    if (form !== undefined) {
      payload = new URLSearchParams(form).toString();
      sent['content-type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      sent['content-type'] ??= 'application/json';
    }
    if (payload !== null) sent['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function signIn(port, who, host) {
  const res = await raw(port, '/api/v1/auth/login', { method: 'POST', host, body: who });
  const token = JSON.parse(res.text).token;
  if (!token) throw new Error(`sign-in failed with ${res.status}`);
  return token;
}

export const setPlan = (world, plan, tenant = world.tenant) => world.db.platform.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, tenant.id]);

/** The app with the default business on `plan` (tier 2 unless told), its owner signed in with a bearer token. */
export async function startWorld({ plan = 't2', overrides = {} } = {}) {
  const app = await startApp({ overrides });
  await setPlan(app, plan);
  const token = await signIn(app.port, OWNER, '127.0.0.1');
  const world = { ...app, token, host: '127.0.0.1' };
  world.api = (path, options = {}) => api(world, path, options);
  world.page = (path, options = {}) => raw(world.port, path, { host: world.host, ...options });
  return world;
}

/** A second business on its own address, with its own owner. */
export async function secondBusiness(world, { slug = 'leaf-and-clay', name = 'Leaf and Clay', plan = 't2' } = {}) {
  const tenant = await world.platform.tenants.create({ slug, name });
  await setPlan(world, plan, tenant);
  const repos = bindTenant(world.platform, tenant);
  await repos.users.ensureOwner({ phone: '9000000002', password: 'owner-pass-2' });
  await repos.settings.update({ store_name: name });
  const host = `${slug}.bhava.test`;
  const token = await signIn(world.port, { phone: '9000000002', password: 'owner-pass-2' }, host);
  const other = { tenant, repos, host, token, db: world.db };
  other.api = (path, options = {}) => api(world, path, { token, host, ...options });
  other.page = (path, options = {}) => raw(world.port, path, { host, ...options });
  return other;
}

export async function api(world, path, { method = 'GET', body, token = world.token, host = world.host, headers = {} } = {}) {
  const res = await raw(world.port, `/api/v1${path}`, { method, body, host, headers: { authorization: `Bearer ${token}`, ...headers } });
  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, headers: res.headers, buffer: res.buffer };
}

/**
 * A landing page (a row of reels) with its products. Answers { id, slug, mediaId, products }. `products` are made unless given.
 * `caption` goes on the page for the auto-join rules.
 */
export async function addPage(business, { headline = 'Reel', caption = '', active = true, products = null, productActive = true, thumbnail = '' } = {}) {
  const { repos, db } = business;
  const items = products ?? [await repos.products.create({ name: `${headline} product`, price: '499', active: productActive ? 'on' : '' })];
  const mediaId = nextMediaId();
  await repos.reels.save(mediaId, { headline, keywords: 'LINK', productIds: items.map((p) => p.id), active: active ? 'on' : '', caption, thumbnail_url: thumbnail });
  const [row] = await db.platform.query('SELECT id, slug FROM reels WHERE ig_media_id = $1', [mediaId]);
  return { id: row.id, slug: row.slug, mediaId, products: items };
}

export async function addCategory(business, name, { visible = true } = {}) {
  return business.repos.categories.save(null, { name, visible, position: (await business.repos.categories.list()).length + 1 });
}

/** The page ids of a category's sequence, in order. */
export async function sequenceIds(business, categoryId) {
  const res = await business.api(`/categories/${categoryId}/reels`);
  if (res.status !== 200) throw new Error(`sequence read failed with ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.items.map((item) => item.pageId);
}

/** The landing page slugs a buyer page links to, in the order they appear. */
export const tileSlugs = (htmlText) => [...htmlText.matchAll(/class="reel-tile" href="\/r\/([a-z0-9-]+)/g)].map((m) => m[1]);

let staffSerial = 0;
/** Another person on the business's team, signed in: { id, token, api }. `role` staff takes `permissions`. */
export async function addTeamMember(world, business = world, { role = 'staff', permissions = [] } = {}) {
  const phone = `90000010${String(++staffSerial).padStart(2, '0')}`;
  const password = `team-pass-${staffSerial}`;
  const user = await business.repos.users.create({ name: 'Team member', phone, password, role });
  if (permissions.length) await business.repos.users.setPermissions(user.id, permissions);
  const token = await signIn(world.port, { phone, password }, business.host);
  return { id: user.id, token, api: (path, options = {}) => api(world, path, { token, host: business.host, ...options }) };
}

/** An uploaded file's row, as if the business had uploaded a picture: its id. (Test repos have no file store.) */
export async function addMedia(business) {
  const id = crypto.randomUUID();
  await business.db.platform.query('INSERT INTO media (id, tenant_id, mime, size, storage_key) VALUES ($1, $2, $3, $4, $5)', [id, business.tenant.id, 'image/png', 4, `t/${business.tenant.id}/media/${id}`]);
  return id;
}

/** A browser's User-Agent, for pages that must count as a shopper's visit. */
export const BROWSER = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' };

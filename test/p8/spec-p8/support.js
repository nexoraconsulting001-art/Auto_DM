// Shared by the Phase 8 spec tests (PRD 5.16 and 11, requirements F-68 to F-73 and Q-01 to Q-14). Written from the PRD, the Phase 8
// contract (src/contracts/seed.js, src/contracts/migration.js, the feedback routes, tools/load, tools/drill, tools/sim/activity) and
// the earlier phases' public test worlds only. Nothing here looks inside a module. No sample business is named in this folder: they
// are the manifest's keys.
import '../../../tools/net-guard.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadShowcase } from '../../../scripts/showcase.js';
import { PEOPLE_RULES, SHOWCASE, inventedPerson } from '../../../src/contracts/seed.js';
import { repoRoot } from '../../../tools/gate-lib.mjs';
import { hit } from '../../p0/spec-p0/support.js';

export { hit, repoRoot };
export { addBusiness, addOrder, addProduct, api, captureLogs, consoleUser, need, onConsole, pause, signIn, startWorld, waitFor, CONSOLE_HOST, NEUTRAL } from '../../p0/spec-p0/support.js';

/** The long version of a test runs only when P8_FULL=1 (the load test's full minutes, the full 30 days, the 5,000-row import). */
export const FULL = process.env.P8_FULL === '1';
export const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
export const json = (rel) => JSON.parse(read(rel));
export const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));
/** Every file under a folder of the repository (relative, slash-separated), or [] when there is none. */
export function filesUnder(rel, { ext } = {}) {
  const base = path.join(repoRoot, rel);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && (!ext || ext.some((x) => e.name.endsWith(x))))
    .map((e) => path.relative(repoRoot, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
}

/** The manifest's businesses as loaded by the repository's own reader: [{ key, seed, catalogue, ... }]. */
export const showcase = (options = {}) => loadShowcase(options);
export const keys = () => json(SHOWCASE.manifest).businesses.map((b) => b.key);

// ---- the old app's export ---------------------------------------------------------------------------------------------------

export const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** Strings that must never reach the new business: an old username, an old comment, an old token, an old password hash. */
export const MARKERS = Object.freeze({
  username: (n) => `demo_old_user_${n}`,
  comment: (n) => `zz-old-comment-text-${n}`,
  igToken: 'IGQVJ-old-token-zz9', // secret-scan:allow
  accessToken: 'EAAold-access-zz9', // secret-scan:allow
  passwordHash: '$2b$10$zzoldpasswordhashzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
});

/**
 * An export of an old single-shop app (MigrationSource), made from fixtures. Money is paise. Order numbers run so that the highest
 * is `highestOrder`. Every person is invented. Ids are the old app's own (small numbers), which will collide with other businesses'.
 *   products, categories, orders, reels: how many; `itemsPerOrder`; `activity`: rows of activity and of visits
 */
export function legacyExport({ label = `old-shop-${crypto.randomBytes(3).toString('hex')}`, products = 6, categories = 3, reels = 2, orders = 4, itemsPerOrder = 2, activity = 6, highestOrder = 4210, igUserId = '', slugPrefix = 'old' } = {}) {
  const person = (n) => inventedPerson(n + 40);
  const mediaBase = BigInt(`9000${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}00`);
  const mediaId = (i) => String(mediaBase + BigInt(i * 7));
  const rows = {
    settings: [
      { key: 'store_name', value: 'The Old Shop' },
      { key: 'support_phone', value: person(0).phone },
      { key: 'ig_token', value: MARKERS.igToken },
      { key: 'access_token', value: MARKERS.accessToken },
    ],
    media: [{ id: 'm1', mime: 'image/png', data: TINY_PNG_B64, size: 70 }],
    categories: Array.from({ length: categories }, (_, i) => ({ id: i + 1, name: `Category ${i + 1}`, slug: `${slugPrefix}-cat-${i + 1}`, image_url: '', description: 'A shelf', position: i, visible: true })),
    products: Array.from({ length: products }, (_, i) => ({
      id: i + 1, name: `Old product ${i + 1}`, slug: `${slugPrefix}-product-${i + 1}`, description: 'Made by hand', price_paise: 19900 + i * 100, mrp_paise: 29900, images: [], option_label: '', option_values: [], stock: 10, active: true, featured: i === 0,
    })),
    product_categories: Array.from({ length: products }, (_, i) => ({ product_id: i + 1, category_id: (i % categories) + 1 })),
    reels: Array.from({ length: reels }, (_, i) => ({
      ig_media_id: mediaId(i), slug: `${slugPrefix}-reel-${i + 1}`, headline: `Old reel ${i + 1}`, keywords: ['LINK'], dm_message: '', button_text: 'Shop now', public_reply: '', active: true, permalink: '', thumbnail_url: '', video_url: '', caption: 'Old caption',
    })),
    reel_products: Array.from({ length: reels }, (_, i) => ({ reel_id: mediaId(i), product_id: i + 1, position: 0 })),
    users: Array.from({ length: Math.max(1, orders) }, (_, i) => ({ id: i + 1, name: person(i).name, phone: person(i).phone, email: person(i).email, password_hash: MARKERS.passwordHash, role: 'customer', address: null })),
    orders: [],
    order_items: [],
    activity: Array.from({ length: activity }, (_, i) => ({ id: i + 1, comment_id: `c${mediaBase}-${i + 1}`, reel_id: mediaId(0), user_id: `9000${String(1000000 + i)}`, username: MARKERS.username(i), text: MARKERS.comment(i), comment_text: MARKERS.comment(i), message_text: MARKERS.comment(i), result: 'sent', error: '' })),
    visits: Array.from({ length: activity }, (_, i) => ({ id: i + 1, reel_id: mediaId(0), source: 'bio', username: MARKERS.username(i) })),
  };
  for (let i = 0; i < orders; i++) {
    const number = highestOrder - (orders - 1 - i) * 1;
    const p = person(i);
    rows.orders.push({
      id: i + 1, order_number: String(number), public_token: `tok${label.replace(/\W/g, '')}${i}`.padEnd(24, 'x').slice(0, 40), reel_id: null, user_id: i + 1, source: 'reel', customer_name: p.name, phone: p.phone, email: p.email,
      address: '12 Lake Road', city: 'Pune', state: 'MH', pincode: '411001', subtotal_paise: 19900 * itemsPerOrder, shipping_paise: 0, total_paise: 19900 * itemsPerOrder, status: 'delivered', notes: '',
    });
    for (let k = 0; k < itemsPerOrder; k++) rows.order_items.push({ id: i * itemsPerOrder + k + 1, order_id: i + 1, product_id: (k % products) + 1, name: `Old product ${(k % products) + 1}`, image: '', price_paise: 19900, option_value: '', qty: 1 });
  }
  return { format: 'bhava-legacy-export', version: 1, label, exportedAt: '2026-11-01T00:00:00.000Z', igUserId, tables: rows };
}

/** A copy of an export with `change(tables)` applied. */
export function altered(source, change) {
  const copy = structuredClone(source);
  change(copy.tables, copy);
  return copy;
}

export const TABLES_WRITTEN = ['settings', 'media', 'categories', 'products', 'product_categories', 'reels', 'reel_products', 'users', 'orders', 'order_items', 'activity', 'visits', 'migration_id_map'];

/** A business with nothing in it: no owner, no settings rows. */
export async function emptyBusiness(app, slug, name = `Shop ${slug}`) {
  const tenant = await app.platform.tenants.create({ slug, name, plan: 't3' });
  return { tenant, slug, name, host: `${slug}.shops.example`, id: tenant.id };
}

/** The importer, built as the command line builds it. */
export async function importerOf(app) {
  const { createMigration } = await import('../../../src/modules/migration/index.js');
  return createMigration({ db: app.db, repos: app.platform, config: app.config });
}

const sql = (app, text, params = []) => app.db.platform.query(text, params);
export { sql };

/** Tables of one business that hold its data: every table with a tenant_id column, but the platform's own record keeping. */
export async function tenantTables(app) {
  const rows = await sql(app, `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`);
  return rows.map((r) => r.table_name);
}

/** Row counts and a checksum of every table for one business, from the platform's connection. */
export async function snapshot(app, tenantId, { skip = [] } = {}) {
  const out = {};
  for (const table of await tenantTables(app)) {
    if (skip.includes(table)) continue;
    const [row] = await sql(app, `SELECT count(*)::int AS rows, COALESCE(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS sum FROM "${table}" t WHERE t.tenant_id = $1`, [tenantId]);
    out[table] = `${row.rows}:${row.sum}`;
  }
  const [tenant] = await sql(app, 'SELECT next_order_number FROM tenants WHERE id = $1', [tenantId]);
  out.next_order_number = String(tenant.next_order_number);
  return out;
}
/** What a run may leave behind even when it writes nothing: its own record. */
export const RECORD_KEEPING = ['migration_runs', 'audit_log', 'jobs', 'rate_limit_hits'];

export const countOf = async (app, tenantId, table) => (await sql(app, `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = $1`, [tenantId]))[0].n;

/** Every text column and jsonb of every tenant table of the business, searched for `needle`: which tables hold it. */
export async function whereFound(app, tenantId, needles) {
  const found = [];
  for (const table of await tenantTables(app)) {
    for (const needle of [needles].flat()) {
      const [row] = await sql(app, `SELECT count(*)::int AS n FROM "${table}" t WHERE t.tenant_id = $1 AND t::text LIKE $2`, [tenantId, `%${needle}%`]);
      if (row.n) found.push(`${table}:${needle}`);
    }
  }
  return found;
}

/** A db handle that throws on the `at`th statement matching `pattern` (1 counts first), in or out of a transaction. `state.seen` counts. */
export function faultyDb(db, pattern, state) {
  const guard = (text) => {
    if (!pattern.test(text)) return;
    state.seen = (state.seen ?? 0) + 1;
    if (state.at && state.seen === state.at) throw new Error('disk full (injected)');
  };
  const wrap = (h) => ({
    ...h,
    query: (text, params) => { guard(text); return h.query(text, params); },
    exec: (text) => { guard(text); return h.exec(text); },
    tx: (fn, ...rest) => h.tx((t) => fn(wrap(t)), ...rest),
  });
  return { ...wrap(db), platform: wrap(db.platform) };
}

// ---- a shopper's browser -----------------------------------------------------------------------------------------------------

/** Cookie jar and requests with a business's own Host header. */
export function shopperBrowser(app, host) {
  const jar = new Map();
  async function request(p, { method = 'GET', json: body, headers = {} } = {}) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await hit(app, p, { host, method, body, cookie: cookie || undefined, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36', ...headers } });
    for (const line of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      if (pair.slice(at + 1).trim() === '') jar.delete(pair.slice(0, at).trim());
      else jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    return res;
  }
  return { request, jar };
}

// ---- the invented-people rule, as a scan --------------------------------------------------------------------------------------

const PHONE_LIKE = /(?<![\d])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d])/g;
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IG_ID_LIKE = /(?<![\d.])\d{15,17}(?![\d])/g;
const normalPhone = (raw) => `+91${String(raw).replace(/\D/g, '').slice(-10)}`;

/**
 * Everything in `text` that looks like a person and is not invented: phones outside +91 90000 0xxxx, emails off the example
 * domains, 15 to 17 digit ids that do not start 9000. Names are checked by the callers that know where names are.
 */
export function strangers(text) {
  const bad = [];
  for (const m of text.matchAll(PHONE_LIKE)) {
    const phone = normalPhone(m[0]);
    if (!PEOPLE_RULES.phone.pattern.test(phone)) bad.push(`phone:${m[0]}`);
  }
  for (const m of text.matchAll(EMAIL_LIKE)) {
    const host = m[0].slice(m[0].lastIndexOf('@') + 1).toLowerCase();
    const ok = PEOPLE_RULES.emailDomains.includes(host) || PEOPLE_RULES.emailSuffixes.some((s) => host.endsWith(s));
    if (!ok) bad.push(`email:${m[0]}`);
  }
  for (const m of text.matchAll(IG_ID_LIKE)) if (!PEOPLE_RULES.instagram.id.test(m[0])) bad.push(`id:${m[0]}`);
  return bad;
}

/** The ctx an app was started with, from startApp's result or from a world's server. */
export const ctxOf = (world) => world.ctx ?? world.server?.listeners?.('request')?.[0]?.locals?.ctx;

// ---- one world per file -------------------------------------------------------------------------------------------------------

let counter = 0;
/** A slug nobody else in this process used. */
export const u = (base) => `${base}-${++counter}-${crypto.randomBytes(2).toString('hex')}`;
let shared;
/** One app and database for a whole test file: each test makes businesses of its own, so none leans on another. Closed by closeShared(). */
export async function sharedWorld() {
  if (!shared) {
    const { startWorld } = await import('../../p0/spec-p0/support.js');
    const holder = { after: (fn) => { holder.close = fn; } };
    shared = { app: await startWorld(holder), close: () => holder.close?.() };
  }
  return shared.app;
}
export async function closeShared() {
  if (shared) await shared.close();
  shared = null;
}

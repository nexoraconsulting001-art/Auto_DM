// What the importer's tests share: an export of an old single-shop app built from fixtures, a database with a target
// business and a neighbour, the importer wired to memory storage and the real image pipeline, and a snapshot of everything
// a business holds, to prove a failed import leaves it exactly as it was.
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createImages } from '../../../src/platform/images.js';
import { createStorage } from '../../../src/platform/storage.js';
import { createMigration } from '../../../src/modules/migration/index.js';
import { bindTenant } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { setup } from '../../helpers.js';

export const OLD_ACCOUNT = '17841400000000001';
export const USERNAMES = ['demo_rhea_k', 'demo_kabir_s', 'demo_ira_m'];
export const COMMENT_TEXT = ['LINK please, love the lamp', 'price?? DM me', 'want this in blue'];

let pngCache = null;
/** A small real PNG, as the old app stored product photos. */
export async function png() {
  pngCache ??= await sharp({ create: { width: 12, height: 8, channels: 3, background: '#3B2FC9' } }).png().toBuffer();
  return pngCache;
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const MEDIA_ID = uuid(1);

/**
 * An export of an old shop: every table the importer knows, with ids that clash with the neighbour's on purpose (old ids
 * start at 1, like any fresh app's). `phones` are the customers' numbers (invented, 90000 block).
 */
export async function legacyExport({ label = 'old shop export', igUserId = OLD_ACCOUNT, highest = 4210, phones = ['9000000201', '9000000202'], extra = {} } = {}) {
  const image = (await png()).toString('base64');
  const at = '2025-03-01T10:00:00.000Z';
  const tables = {
    settings: [
      { key: 'store_name', value: 'Old Lamp House' },
      { key: 'upi_id', value: 'oldshop@upi' },
      { key: 'trust_points', value: 'Ships across India\nCash on delivery' },
      { key: 'ig_token', value: 'IGQ-old-secret-token' },
      { key: 'access_token', value: 'EAA-old-secret-token' },
    ],
    media: [{ id: MEDIA_ID, mime: 'image/png', size: 100, name: 'lamp.png', data: image }],
    categories: [
      { id: 1, name: 'Lamps', slug: 'lamps', image_url: `/media/${MEDIA_ID}`, description: 'Brass and clay', position: 1, visible: true, created_at: at },
      { id: 2, name: 'Diyas', slug: 'diyas', image_url: '', description: '', position: 2, visible: true, created_at: at },
    ],
    products: [
      { id: 1, name: 'Brass lamp', slug: 'brass-lamp', description: 'Hand polished', price_paise: 49900, mrp_paise: 59900, images: [`/media/${MEDIA_ID}`, 'https://cdn.example.test/lamp.jpg'], option_label: 'Size', option_values: ['S', 'M'], stock: 5, active: true, featured: true, created_at: at, updated_at: at },
      { id: 2, name: 'Clay diya', slug: 'clay-diya', description: '', price_paise: 9900, mrp_paise: null, images: [], option_label: '', option_values: [], stock: null, active: true, featured: false, created_at: at, updated_at: at },
      { id: 3, name: 'Old stock', slug: 'old-stock', description: '', price_paise: 1000, mrp_paise: null, images: [], option_label: '', option_values: [], stock: 0, active: false, featured: false, created_at: at, updated_at: at },
    ],
    product_categories: [{ product_id: 1, category_id: 1 }, { product_id: 2, category_id: 2 }],
    reels: [
      { ig_media_id: '17900000000000001', slug: 'diwali-edit', headline: 'Diwali edit', keywords: ['LINK', 'PRICE'], dm_message: 'Here you go 👇', button_text: 'Shop now', public_reply: 'Sent!', active: true, permalink: 'https://www.instagram.com/reel/abc/', thumbnail_url: `/media/${MEDIA_ID}`, video_url: '', caption: 'Diwali', created_at: at, updated_at: at },
      { ig_media_id: '17900000000000002', slug: 'clay-corner', headline: 'Clay corner', keywords: ['DIYA'], dm_message: 'Here', button_text: 'Shop now', public_reply: '', active: true, permalink: '', thumbnail_url: '', video_url: '', caption: '', created_at: at, updated_at: at },
    ],
    reel_products: [{ reel_id: '17900000000000001', product_id: 1, position: 0 }, { reel_id: '17900000000000001', product_id: 2, position: 1 }, { reel_id: '17900000000000002', product_id: 2, position: 0 }],
    users: [
      { id: 1, name: 'Rhea Kapoor', phone: phones[0], email: 'rhea@example.test', password_hash: 'scrypt$old$hash1', role: 'customer', created_at: at },
      { id: 2, name: 'Kabir Shah', phone: phones[1], email: '', password_hash: 'scrypt$old$hash2', role: 'customer', created_at: at },
      { id: 3, name: 'Old Owner', phone: '9000000299', email: 'owner@example.test', password_hash: 'scrypt$old$owner', role: 'owner', created_at: at },
    ],
    orders: [
      order(1, 'OLH-4208', 1, { reel_id: '17900000000000001', phone: phones[0] }),
      order(2, `OLH-${highest}`, 1, { status: 'delivered', phone: phones[0] }),
      order(3, 'OLH-4209', 2, { status: 'cancelled', phone: phones[1] }),
      order(4, 'OLH-4100', null, { status: 'payment_submitted', phone: '9000000203' }),
    ],
    order_items: [
      { id: 1, order_id: 1, product_id: 1, name: 'Brass lamp', image: `/media/${MEDIA_ID}`, price_paise: 49900, option_value: 'S', qty: 1 },
      { id: 2, order_id: 2, product_id: 2, name: 'Clay diya', image: '', price_paise: 9900, option_value: '', qty: 2 },
      { id: 3, order_id: 3, product_id: 1, name: 'Brass lamp', image: '', price_paise: 49900, option_value: 'M', qty: 1 },
      { id: 4, order_id: 4, product_id: 2, name: 'Clay diya', image: '', price_paise: 9900, option_value: '', qty: 1 },
    ],
    activity: USERNAMES.map((username, i) => ({ id: i + 1, comment_id: `1800000000000000${i}`, reel_id: '17900000000000001', user_id: `9000${i}`, username, text: COMMENT_TEXT[i], result: 'sent', error: '', created_at: at })),
    visits: [{ id: 1, reel_id: '17900000000000001', source: 'ig', created_at: at }, { id: 2, reel_id: '17900000000000002', source: 'ig', username: USERNAMES[0], created_at: at }],
    sessions: [{ id: 'old-session', user_id: 1 }],
    ...extra,
  };
  return { format: 'bhava-legacy-export', version: 1, label, exportedAt: at, igUserId, tables };
}

export function order(id, number, userId, over = {}) {
  const subtotal = over.subtotal_paise ?? 49900;
  const shipping = over.shipping_paise ?? 0;
  return {
    id, order_number: number, public_token: crypto.createHash('sha256').update(`token-${number}-${id}`).digest('base64url').slice(0, 22), reel_id: null, user_id: userId,
    source: 'reel', customer_name: 'Rhea Kapoor', phone: '9000000201', email: '', address: '12 Lake Road, Kothrud', city: 'Pune', state: 'Maharashtra', pincode: '411038',
    subtotal_paise: subtotal, shipping_paise: shipping, total_paise: subtotal + shipping, status: 'paid', notes: '', created_at: '2025-03-02T10:00:00.000Z', updated_at: '2025-03-02T10:00:00.000Z',
    ...over,
  };
}

/** A database with the target business (empty, as the Platform Console makes it) and a neighbour with its own rows. */
export async function world() {
  const base = await setup();
  const { db, platform } = base;
  const target = await platform.tenants.ensure({ slug: 'importing', name: 'Importing shop' });
  const neighbour = base.tenant;
  const repos = bindTenant(platform, neighbour);
  // The neighbour holds rows with the same small ids and slugs an old app starts with.
  const lamp = await repos.products.create({ name: 'Brass lamp', price: '799', active: 'on' });
  await platform.tenants.linkIgAccount(neighbour.id, 'NEIGHBOUR-IG', 'neighbour');
  const storage = createStorage({ storageDriver: 'memory' });
  const images = createImages();
  const files = new Map();
  const spyStorage = {
    driver: 'memory',
    put: async (key, buffer, type) => { files.set(key, { buffer: Buffer.from(buffer), type }); return storage.put(key, buffer, type); },
    get: (key) => storage.get(key),
    remove: async (key) => { files.delete(key); return storage.remove(key); },
  };
  const ctx = { db, platform: { storage: spyStorage, images } };
  const [user] = await db.platform.query(`INSERT INTO platform_users (email, name, password_hash, role) VALUES ('ops@example.test', 'Ops', 'x', 'super_admin') RETURNING id`);
  return {
    ...base, target, neighbour, neighbourProduct: lamp, ctx, files, operatorId: user.id,
    importer: (over = {}) => createMigration({ ...ctx, ...over }),
    targetRepos: bindTenant(platform, target),
    q: (sql, params = []) => db.platform.query(sql, params),
    inTarget: (fn) => withTenant(target, fn),
  };
}

/** Every business table a run can touch, read for one business as the owner sees it, in a fixed order. */
export const BUSINESS_TABLES = ['settings', 'media', 'categories', 'products', 'product_images', 'product_categories', 'reels', 'reel_products', 'shoppers', 'users', 'orders', 'order_items',
  'order_events', 'order_status_history', 'activity', 'visits'];

export async function snapshot(w, tenantId) {
  const out = {};
  for (const table of BUSINESS_TABLES) {
    const rows = await w.q(`SELECT * FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    out[table] = rows.map((r) => JSON.stringify(r)).sort();
  }
  const [tenant] = await w.q('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  out.tenant = JSON.stringify(tenant);
  out.idMap = (await w.q('SELECT count(*)::int AS n FROM migration_id_map WHERE tenant_id = $1', [tenantId]))[0].n;
  return out;
}

/** Wraps the owner's transactions so a test can watch or break the statements of an import. */
export function wrapDb(db, onQuery) {
  return {
    ...db,
    platform: {
      ...db.platform,
      tx: (fn) => db.platform.tx((t) => fn({ ...t, query: (sql, params) => onQuery(sql, params, t) })),
    },
  };
}

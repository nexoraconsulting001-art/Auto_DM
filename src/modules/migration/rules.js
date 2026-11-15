import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { CATALOG_LIMITS } from '../../contracts/catalog.js';
import { CONFLICT_KINDS, LEGACY_TABLES, MIGRATION_NEVER_COPIED, MIGRATION_STRIPS, nextOrderNumber } from '../../contracts/migration.js';
import { normalizeCategory } from '../../repos/categories.js';
import { MAX_IMAGES, normalizeProduct } from '../../repos/products.js';
import { normalizeReel } from '../../repos/reels.js';
import { SETTING_DEFAULTS } from '../../repos/settings.js';
import { normalizePhone } from '../../util.js';
import { cleanLine, cleanUrl, htmlToText, plainLine } from '../imports/text.js';
import { normalizeCustomer } from '../orders/legacy.js';
import { toE164 } from '../shoppers/keys.js';

/**
 * The importer's rules for one export, with no database: what each old row becomes, what is skipped and why, and the
 * conflicts. Every value goes through the product's own validators (normalizeProduct, normalizeCategory, normalizeReel,
 * normalizeCustomer, normalizePhone) and the imports module's text cleaners, as anything typed into the product does: an
 * export from one of our own old apps is trusted no more than a form. A value they would refuse refuses the whole export
 * (MigrationRefused), naming the table, the old id and the field, never the value.
 *
 * Ids from the export are only ever keys into the id map: no old id becomes a row id here, except a reel's Instagram media
 * id, which is checked against every business first.
 */

export const MIGRATION_LIMITS = Object.freeze({
  rowsPerTable: 500_000,
  /** Any one text value of a row, before cleaning. A product name or a setting is far shorter; this stops a runaway field. */
  valueChars: 100_000,
  /** One media file, decoded. */
  mediaBytes: 10 * 1024 * 1024,
  /** next_order_number is a 32-bit column. */
  orderNumber: 2_000_000_000,
  /** One order's money, in paise. */
  orderPaise: 1_000_000_000_000,
  itemQty: 10_000,
});

/** Tables an export may hold that are known and never copied (MIGRATION_NEVER_COPIED names them). */
const NEVER_COPIED_TABLES = MIGRATION_NEVER_COPIED.filter((entry) => /^[a-z_]+$/.test(entry));
/** Settings carried across: the store's own words and numbers. Tokens, passwords and the old owner are never among them. */
const COPIED_SETTINGS = Object.freeze(Object.keys(SETTING_DEFAULTS).filter((key) => key !== 'checklist_dismissed'));
const NUMERIC_SETTINGS = new Set(['shipping_fee_paise', 'free_shipping_above_paise']);
const LEGACY_ORDER_STATUSES = new Set(['awaiting_payment', 'payment_submitted', 'paid', 'shipped', 'delivered', 'cancelled']);

const OLD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_LINK = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The export holds a row the product would refuse. Nothing is written. `field` is `<table>.<old id>.<field>`. */
export class MigrationRefused extends ApiError {
  constructor(table, ref, field) {
    const key = `${table}.${ref}.${field}`;
    super('validation_failed', 'The export holds a value the product would refuse, so nothing was imported.', { fields: { [key]: 'refused' } });
    this.migrationCode = `refused:${key}`.slice(0, 200);
  }
}

/** Own fields only: a key such as __proto__ in an export never lends a row a value. */
const field = (row, key) => (Object.hasOwn(row, key) ? row[key] : undefined);

export function makeCheck(table, ref) {
  const refuse = (name) => {
    throw new MigrationRefused(table, ref, name);
  };
  const text = (row, name, { required = false } = {}) => {
    const v = field(row, name);
    if (v === undefined || v === null) return required ? refuse(name) : '';
    if (typeof v !== 'string' && typeof v !== 'number') return refuse(name);
    const s = String(v);
    if (s.length > MIGRATION_LIMITS.valueChars) return refuse(name);
    if (required && !s.trim()) return refuse(name);
    return s;
  };
  const int = (row, name, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false, fallback } = {}) => {
    const v = field(row, name);
    if (v === undefined || v === null || v === '') {
      if (nullable) return null;
      if (fallback !== undefined) return fallback;
      return refuse(name);
    }
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d{1,16}$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) return refuse(name);
    return n;
  };
  const bool = (row, name, fallback) => {
    const v = field(row, name);
    if (v === undefined || v === null) return fallback;
    if (v === true || v === 1 || v === 't' || v === 'true') return true;
    if (v === false || v === 0 || v === 'f' || v === 'false') return false;
    return refuse(name);
  };
  const date = (row, name) => {
    const v = field(row, name);
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 40) return refuse(name);
    const at = Date.parse(v);
    if (!Number.isFinite(at) || at < Date.UTC(2000, 0, 1) || at > Date.now() + 86_400_000) return refuse(name);
    return new Date(at).toISOString();
  };
  /** An id of another old row: text or a number, a short safe token, else refused. */
  const ref_ = (row, name, { nullable = false } = {}) => {
    const v = field(row, name);
    if (v === undefined || v === null || v === '') return nullable ? null : refuse(name);
    if (typeof v !== 'string' && typeof v !== 'number') return refuse(name);
    const s = String(v);
    return OLD_ID.test(s) ? s : refuse(name);
  };
  /** A list of short strings, or a comma-separated string. */
  const list = (row, name, { max, each }) => {
    const v = field(row, name);
    if (v === undefined || v === null || v === '') return [];
    const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : refuse(name);
    if (items.length > max) return refuse(name);
    return items.map((item) => {
      if (typeof item !== 'string' && typeof item !== 'number') return refuse(name);
      if (String(item).length > MIGRATION_LIMITS.valueChars) return refuse(name);
      return plainLine(String(item).replace(/,/g, ' '), each);
    }).filter(Boolean);
  };
  /**
   * A picture or link: an old /media/<uuid> (resolved through the id map when written), an http(s) address the product
   * would show, or nothing. A path, a script or a data: address is refused.
   */
  const linkOf = (value, name) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > MIGRATION_LIMITS.valueChars) return refuse(name);
    const s = value.trim();
    if (!s) return null;
    const media = MEDIA_LINK.exec(s);
    if (media) return { media: media[1].toLowerCase() };
    const url = /^https?:\/\//i.test(s) ? cleanUrl(s) : null;
    return url ? { url } : refuse(name);
  };
  const link = (row, name) => linkOf(field(row, name), name);
  /** Multi-line text as the product keeps it: control characters out, each line tidied, a length cap. */
  const lines = (row, name, max) => text(row, name).split(/\r\n?|\n/).map((line) => plainLine(line, max)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  /** A product validator's verdict: its message may hold the value, so only the field is reported. */
  const validate = (name, fn) => {
    try {
      return fn();
    } catch {
      return refuse(name);
    }
  };
  return { refuse, text, int, bool, date, ref: ref_, list, link, linkOf, lines, validate };
}

const slugOf = (check, row, name = 'slug') => {
  const s = check.text(row, name, { required: true }).trim();
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) && s.length <= 60 ? s : check.refuse(name);
};

const rupees = (paise) => (paise === null ? '' : `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`);

/** "MM-4210" -> 4210; the number an old order carried, for the new counter. */
export const orderSerial = (orderNumber) => {
  const m = /(\d{1,12})$/.exec(String(orderNumber));
  return m ? Number(m[1]) : 0;
};

/** What the importer needs to know about the database for one export, before anything is written. See lookups() in index.js. */
export const EMPTY_LOOKUPS = Object.freeze({
  map: new Map(), productSlugs: new Set(), categorySlugs: new Set(), reelSlugs: new Set(), reelOwners: new Map(), accountOwners: new Map(),
  orderNumbers: new Set(), takenTokens: new Set(), takenComments: new Set(), shopperPhones: new Map(), settingKeys: new Set(), nextOrderNumber: 1,
});

/** The keys an export will look up, read leniently: anything malformed is refused later by prepare(). */
export function keysOf(source) {
  const rows = (table) => (Array.isArray(source.tables[table]) ? source.tables[table] : []);
  const strings = (table, name, shape = (v) => v) => rows(table).map((r) => field(r, name)).filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => shape(String(v))).filter(Boolean);
  const accounts = new Set([source.igUserId, ...strings('reels', 'ig_user_id')].filter((v) => v && OLD_ID.test(v)));
  return {
    productSlugs: strings('products', 'slug'),
    categorySlugs: strings('categories', 'slug'),
    reelSlugs: strings('reels', 'slug'),
    reelIds: strings('reels', 'ig_media_id'),
    accounts: [...accounts],
    orderNumbers: strings('orders', 'order_number'),
    tokens: strings('orders', 'public_token'),
    comments: strings('activity', 'comment_id'),
    phones: strings('users', 'phone', (v) => toE164(normalizePhone(v) ?? '') ?? ''),
  };
}

/** A placeholder media id for a reassigned reel: it is no media of Instagram's, so it can never meet a real one. */
export const reassignedReelId = (tenantId, oldId) => `migrated-${tenantId}-${oldId}`;

/**
 * Works out a whole export against `look` (EMPTY_LOOKUPS' shape) for business `tenantId`.
 * Returns { counts, conflicts, rows, aliases, highestSerial, nextOrderNumber } where `rows[table]` is what a real run writes,
 * in order: [{ oldId, data }], and `aliases` maps an old user id that is not written to the shopper it joins.
 * Throws MigrationRefused for a value the product would refuse.
 */
export function prepare(source, look, { tenantId, reels: reelChoice } = {}) {
  const counts = {};
  const conflicts = [];
  const rows = Object.fromEntries(LEGACY_TABLES.map((t) => [t, []]));
  const conflict = (kind, table, oldId, blocking = CONFLICT_KINDS[kind].blocking) => conflicts.push({ kind, table, oldId: String(oldId).slice(0, 200), blocking });
  /** old ids that will exist in the business once this run is written, per table: written now or by an earlier run */
  const present = Object.fromEntries(LEGACY_TABLES.map((t) => [t, new Set()]));
  const mapped = (table, oldId) => look.map.has(`${table}|${oldId}`);
  const has = (table, oldId) => oldId !== null && (present[table].has(oldId) || mapped(table, oldId));
  const dropped = new Set();
  const aliases = new Map();
  /** values met so far in this export that must be unique: a second row with one is a conflict */
  const taken = { products: new Set(), categories: new Set(), reels: new Set(), orders: new Set(), tokens: new Set(), comments: new Set(), phones: new Map() };

  for (const table of Object.keys(source.tables)) {
    const n = source.tables[table].length;
    if (n > MIGRATION_LIMITS.rowsPerTable) throw new MigrationRefused(table, 'rows', 'count');
    if (!LEGACY_TABLES.includes(table)) {
      counts[table] = { source: n, imported: 0, skipped: n };
      if (!NEVER_COPIED_TABLES.includes(table)) conflict('unknown_table', table, '');
    }
  }

  for (const table of LEGACY_TABLES) {
    const list = source.tables[table];
    if (!list) continue;
    const c = (counts[table] = { source: list.length, imported: 0, skipped: 0 });
    const seen = new Set();
    const take = (oldId, data) => {
      rows[table].push({ oldId, data });
      present[table].add(oldId);
      c.imported += 1;
    };
    const skip = () => (c.skipped += 1);
    list.forEach((row, index) => {
      const at = makeCheck(table, `#${index}`);
      if (!row || typeof row !== 'object' || Array.isArray(row)) at.refuse('row');
      const idOf = (name) => at.ref(row, name);
      const oldId = table === 'product_categories' ? `${idOf('product_id')}:${idOf('category_id')}`
        : table === 'reel_products' ? `${idOf('reel_id')}:${idOf('product_id')}`
          : table === 'settings' ? idOf('key')
            : table === 'reels' ? idOf('ig_media_id') : idOf('id');
      if (seen.has(oldId) && !['product_categories', 'reel_products'].includes(table)) at.refuse('id');
      const check = makeCheck(table, oldId);
      if (table === 'media' && !UUID.test(oldId)) check.refuse('id');
      const duplicate = seen.has(oldId);
      seen.add(oldId);
      const handler = HANDLERS[table];
      const verdict = handler({ taken, row, oldId, check, look, tenantId, reelChoice, has, mapped: mapped(table, oldId), duplicate, conflict, dropped, aliases, source });
      if (verdict === SKIP) return skip();
      return take(oldId, verdict);
    });
  }

  // A slug, order number or token met twice in the export, or already in the business, is a conflict on the later row.
  const highestSerial = (source.tables.orders ?? []).reduce((max, o) => Math.max(max, orderSerial(field(o, 'order_number') ?? '')), 0);
  const blocked = conflicts.some((x) => x.blocking);
  return { counts, conflicts, rows, aliases, blocked, highestSerial, nextOrderNumber: nextOrderNumber(highestSerial, look.nextOrderNumber) };
}

const SKIP = Symbol('skip');

/** Tracks a unique value within the export and against the business; true when this row may take it. */
function claim(set, value) {
  if (set.has(value)) return false;
  set.add(value);
  return true;
}

function handlers() {
  return {
    settings({ row, oldId, check, look, mapped }) {
      if (mapped || !COPIED_SETTINGS.includes(oldId) || look.settingKeys.has(oldId)) return SKIP;
      const value = check.lines(row, 'value', 2000);
      if (NUMERIC_SETTINGS.has(oldId) && !/^\d{1,12}$/.test(value)) check.refuse('value');
      return { key: oldId, value };
    },

    media({ row, oldId, check, mapped }) {
      // The bytes only: the old row's name, type and size are never trusted, and a name is never used for anything.
      const data = field(row, 'data');
      if (typeof data !== 'string' || !data || !BASE64.test(data) || data.length > Math.ceil(MIGRATION_LIMITS.mediaBytes / 3) * 4) check.refuse('data');
      if (mapped) return SKIP;
      return { data, oldId };
    },

    categories({ taken, row, oldId, check, look, mapped, conflict }) {
      const slug = slugOf(check, row);
      const image = check.link(row, 'image_url');
      const c = check.validate('name', () => normalizeCategory({
        name: cleanLine(check.text(row, 'name', { required: true }), 500), slug, image_url: '', description: htmlToText(check.text(row, 'description'), 400),
        position: String(check.int(row, 'position', { min: -1_000_000, max: 1_000_000, fallback: 0 })), visible: check.bool(row, 'visible', true),
      }));
      if (c.slug !== slug) check.refuse('slug');
      if (mapped) return SKIP;
      if (look.categorySlugs.has(slug) || !claim(taken.categories, slug)) {
        conflict('slug_taken', 'categories', oldId);
        return SKIP;
      }
      return { ...c, image, created_at: check.date(row, 'created_at') };
    },

    products({ taken, row, oldId, check, look, mapped, conflict }) {
      const slug = slugOf(check, row);
      const price = check.int(row, 'price_paise', { min: 0, max: CATALOG_LIMITS.maxPricePaise });
      const mrp = check.int(row, 'mrp_paise', { min: 0, max: CATALOG_LIMITS.maxPricePaise, nullable: true });
      const rawImages = field(row, 'images');
      const images = rawImages === undefined || rawImages === null ? [] : Array.isArray(rawImages) ? rawImages : check.refuse('images');
      if (images.length > MAX_IMAGES) check.refuse('images');
      const links = images.map((value) => check.linkOf(value, 'images') ?? check.refuse('images'));
      const stock = check.int(row, 'stock', { min: 0, max: 1_000_000_000, nullable: true });
      const options = check.list(row, 'option_values', { max: CATALOG_LIMITS.optionValues, each: 60 });
      const p = check.validate('product', () => normalizeProduct({
        name: cleanLine(check.text(row, 'name', { required: true }), 500),
        description: '', price: rupees(price), mrp: rupees(mrp), images: [], option_values: options.join(','),
        option_label: plainLine(check.text(row, 'option_label'), 40), stock: stock === null ? '' : String(stock),
        active: check.bool(row, 'active', true), featured: check.bool(row, 'featured', false),
      }));
      if (p.price_paise !== price || p.mrp_paise !== mrp) check.refuse('price_paise');
      if (mapped) return SKIP;
      if (look.productSlugs.has(slug) || !claim(taken.products, slug)) {
        conflict('slug_taken', 'products', oldId);
        return SKIP;
      }
      const { categoryIds: _c, images: _i, ...clean } = p;
      return {
        ...clean, slug, description: htmlToText(check.text(row, 'description'), CATALOG_LIMITS.descriptionLength), links,
        created_at: check.date(row, 'created_at'), updated_at: check.date(row, 'updated_at'),
      };
    },

    product_categories({ row, check, has, mapped, duplicate, conflict, oldId }) {
      const product = check.ref(row, 'product_id');
      const category = check.ref(row, 'category_id');
      if (mapped || duplicate) return SKIP;
      if (!has('products', product) || !has('categories', category)) {
        conflict('orphan_row', 'product_categories', oldId);
        return SKIP;
      }
      return { product, category };
    },

    reels({ taken, row, oldId, check, look, tenantId, reelChoice, mapped, conflict, dropped, source }) {
      const slug = slugOf(check, row);
      const account = check.ref(row, 'ig_user_id', { nullable: true }) ?? (source.igUserId && OLD_ID.test(source.igUserId) ? source.igUserId : null);
      const r = check.validate('reel', () => normalizeReel({
        keywords: check.list(row, 'keywords', { max: 50, each: 60 }).join(','), slug,
        headline: cleanLine(check.text(row, 'headline'), 200), dm_message: check.lines(row, 'dm_message', 1000),
        button_text: plainLine(check.text(row, 'button_text'), 40), public_reply: check.lines(row, 'public_reply', 300),
        active: check.bool(row, 'active', true), caption: plainLine(check.text(row, 'caption'), 2200),
        // A reel's products are its reel_products rows, checked there; the validator's own count rule needs one.
        productIds: [1],
      }));
      if (r.slug !== slug) check.refuse('slug');
      const permalink = check.link(row, 'permalink');
      const thumbnail = check.link(row, 'thumbnail_url');
      const video = check.link(row, 'video_url');
      if (mapped) return SKIP;
      const accountOwner = account ? look.accountOwners.get(account) : undefined;
      const reelOwner = look.reelOwners.get(oldId);
      const elsewhere = (accountOwner !== undefined && accountOwner !== tenantId) || (reelOwner !== undefined && reelOwner !== tenantId);
      if (elsewhere) {
        conflict('reel_on_other_account', 'reels', oldId, !reelChoice);
        if (reelChoice !== 'reassign') {
          dropped.add(oldId);
          return SKIP;
        }
      } else if (reelOwner === tenantId) {
        // This business already holds the media: its own reel is never overwritten.
        conflict('slug_taken', 'reels', oldId);
        return SKIP;
      }
      if (look.reelSlugs.has(slug) || !claim(taken.reels, slug)) {
        conflict('slug_taken', 'reels', oldId);
        return SKIP;
      }
      const { productIds: _p, permalink: _l, thumbnail_url: _t, video_url: _v, ...clean } = r;
      // A reassigned reel keeps its page and products but nothing of the other account's media: it stays off until the
      // business links a reel of its own account.
      if (elsewhere) return { ...clean, igMediaId: reassignedReelId(tenantId, oldId), active: false, permalink: null, thumbnail: null, video: null, created_at: check.date(row, 'created_at'), updated_at: check.date(row, 'updated_at') };
      return {
        ...clean, igMediaId: oldId, permalink, thumbnail, video: video?.url?.startsWith('https://') ? video : null,
        created_at: check.date(row, 'created_at'), updated_at: check.date(row, 'updated_at'),
      };
    },

    reel_products({ row, check, has, mapped, duplicate, conflict, dropped, oldId }) {
      const reel = check.ref(row, 'reel_id');
      const product = check.ref(row, 'product_id');
      const position = check.int(row, 'position', { min: 0, max: 1000, fallback: 0 });
      if (mapped || duplicate || dropped.has(reel)) return SKIP;
      if (!has('reels', reel) || !has('products', product)) {
        conflict('orphan_row', 'reel_products', oldId);
        return SKIP;
      }
      return { reel, product, position };
    },

    users({ taken, row, oldId, check, look, mapped, conflict, aliases }) {
      // A shopper of the old shop becomes a shopper here, with no password: they sign in again with a code or Google (F-72).
      // The owner and staff are never copied; owners are re-invited.
      const role = check.text(row, 'role').trim() || 'customer';
      if (mapped || role !== 'customer') return SKIP;
      const local = normalizePhone(check.text(row, 'phone', { required: true }));
      const phone = local ? toE164(local) : null;
      if (!phone) check.refuse('phone');
      const email = check.text(row, 'email').trim().toLowerCase();
      if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) check.refuse('email');
      const existing = look.shopperPhones.get(phone);
      const first = taken.phones.get(phone);
      if (existing !== undefined || first !== undefined) {
        conflict('duplicate_phone', 'users', oldId);
        aliases.set(oldId, existing !== undefined ? { shopperId: existing } : { sameAs: first });
        return SKIP;
      }
      taken.phones.set(phone, oldId);
      return { phone, name: plainLine(check.text(row, 'name'), 80), email, created_at: check.date(row, 'created_at') };
    },

    orders({ taken, row, oldId, check, look, has, mapped, conflict, dropped, aliases }) {
      const number = check.text(row, 'order_number', { required: true }).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(number) || orderSerial(number) > MIGRATION_LIMITS.orderNumber) check.refuse('order_number');
      const token = check.text(row, 'public_token', { required: true }).trim();
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) check.refuse('public_token');
      const status = check.text(row, 'status').trim() || 'awaiting_payment';
      if (!LEGACY_ORDER_STATUSES.has(status)) check.refuse('status');
      const money = (name) => check.int(row, name, { min: 0, max: MIGRATION_LIMITS.orderPaise, fallback: name === 'shipping_paise' ? 0 : undefined });
      const subtotal = money('subtotal_paise');
      const shipping = money('shipping_paise');
      const total = money('total_paise');
      if (total !== subtotal + shipping) check.refuse('total_paise');
      const customer = check.validate('customer', () => normalizeCustomer({
        name: plainLine(check.text(row, 'customer_name'), 200), phone: check.text(row, 'phone'), email: check.text(row, 'email'),
        address: plainLine(check.text(row, 'address'), 1000), city: plainLine(check.text(row, 'city'), 200), state: plainLine(check.text(row, 'state'), 200), pincode: check.text(row, 'pincode'),
      }));
      const reel = check.ref(row, 'reel_id', { nullable: true });
      const user = check.ref(row, 'user_id', { nullable: true });
      const data = {
        number, token, status, subtotal, shipping, total, customer, source: plainLine(check.text(row, 'source'), 20),
        notes: htmlToText(check.text(row, 'notes'), 1000), created_at: check.date(row, 'created_at'), updated_at: check.date(row, 'updated_at'),
      };
      if (mapped) return SKIP;
      let blocked = false;
      if (look.orderNumbers.has(number) || !claim(taken.orders, number)) {
        conflict('order_number_taken', 'orders', oldId);
        blocked = true;
      }
      if (look.takenTokens.has(token) || !claim(taken.tokens, token)) {
        conflict('public_token_taken', 'orders', oldId);
        blocked = true;
      }
      if (blocked) return SKIP;
      data.reel = reel !== null && !dropped.has(reel) && has('reels', reel) ? reel : null;
      if (reel !== null && data.reel === null && !dropped.has(reel)) conflict('orphan_row', 'orders', oldId);
      data.user = user !== null && (has('users', user) || aliases.has(user)) ? user : null;
      return data;
    },

    order_items({ row, oldId, check, has, mapped, conflict }) {
      const order = check.ref(row, 'order_id');
      const product = check.ref(row, 'product_id', { nullable: true });
      const data = {
        name: cleanLine(check.text(row, 'name', { required: true }), 200) || check.refuse('name'),
        image: check.link(row, 'image'), price: check.int(row, 'price_paise', { min: 0, max: CATALOG_LIMITS.maxPricePaise }),
        option: plainLine(check.text(row, 'option_value'), 100), qty: check.int(row, 'qty', { min: 1, max: MIGRATION_LIMITS.itemQty }),
      };
      if (mapped) return SKIP;
      if (!has('orders', order)) {
        conflict('orphan_row', 'order_items', oldId);
        return SKIP;
      }
      data.order = order;
      data.product = product !== null && has('products', product) ? product : null;
      if (product !== null && data.product === null) conflict('orphan_row', 'order_items', oldId);
      return data;
    },

    activity({ taken, row, oldId, check, look, has, mapped, conflict, dropped }) {
      const comment = check.ref(row, 'comment_id', { nullable: true });
      const reel = check.ref(row, 'reel_id', { nullable: true });
      const result = check.text(row, 'result', { required: true }).trim();
      if (!/^[a-z_]{1,40}$/.test(result)) check.refuse('result');
      // F-71: usernames and comment or message text never come across, whatever the old row held.
      for (const name of MIGRATION_STRIPS.activity) check.text(row, name);
      const data = {
        user: plainLine(check.text(row, 'user_id'), 64), result, error: plainLine(check.text(row, 'error'), 200), created_at: check.date(row, 'created_at'),
        // A comment id is unique across the platform: one another business already holds is not carried.
        comment: comment !== null && !look.takenComments.has(comment) && claim(taken.comments, comment) ? comment : null,
      };
      if (mapped || (reel !== null && dropped.has(reel))) return SKIP;
      data.reel = reel !== null && has('reels', reel) ? reel : null;
      if (reel !== null && data.reel === null) conflict('orphan_row', 'activity', oldId);
      return data;
    },

    visits({ row, oldId, check, has, mapped, conflict, dropped }) {
      const reel = check.ref(row, 'reel_id');
      for (const name of MIGRATION_STRIPS.visits) check.text(row, name);
      const data = { reel, source: plainLine(check.text(row, 'source'), 20), created_at: check.date(row, 'created_at') };
      if (mapped || dropped.has(reel)) return SKIP;
      if (!has('reels', reel)) {
        conflict('orphan_row', 'visits', oldId);
        return SKIP;
      }
      return data;
    },
  };
}

const HANDLERS = handlers();

/** sha-256 of the export's contents in a fixed key order, so the same export always hashes the same. */
export function sourceHash(source) {
  const hash = crypto.createHash('sha256');
  const walk = (v) => {
    if (Array.isArray(v)) {
      hash.update('[');
      v.forEach((item, i) => {
        if (i) hash.update(',');
        walk(item);
      });
      hash.update(']');
    } else if (v && typeof v === 'object') {
      hash.update('{');
      Object.keys(v).sort().forEach((key, i) => {
        if (i) hash.update(',');
        hash.update(JSON.stringify(key));
        hash.update(':');
        walk(v[key]);
      });
      hash.update('}');
    } else {
      hash.update(JSON.stringify(v) ?? 'null');
    }
  };
  walk(source);
  return hash.digest('hex');
}

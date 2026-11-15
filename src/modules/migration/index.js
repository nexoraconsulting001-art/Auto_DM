import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { LEGACY_TABLES, MigrationOptions, MigrationReport, MigrationSource, countsBalance } from '../../contracts/migration.js';
import { APP_ROLE } from '../../db/index.js';
import { log } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { plainLine } from '../imports/text.js';
import { MigrationRefused, keysOf, prepare, sourceHash } from './rules.js';

/**
 * Imports an old single-shop app into one business (PRD 5.16, F-68 to F-73). The rules are data in
 * src/contracts/migration.js and code in ./rules.js; the tables are migration 800 (migration_runs, migration_id_map), both
 * the platform's. `npm run migrate-business` (scripts/migrate-business.js) is the command.
 *
 *   const importer = createMigration(ctx);      ctx: { db, platform: { storage, images } }
 *
 *   importer.plan(source, options)            -> MigrationReport with mode 'dry'. Counts per table and every conflict. Writes
 *                                                nothing at all: no business row, no id map, no run row, no file (F-68).
 *   importer.run(source, options, { reason }) -> MigrationReport with mode 'real' and runId. One transaction for the whole
 *                                                import: any error, any blocking conflict, or counts that do not balance
 *                                                rolls every row back (F-69), files stored on the way are removed, and a
 *                                                `failed` run row is written afterwards, outside that transaction. Safe to
 *                                                run again: rows already in migration_id_map are skipped, and a finished
 *                                                run of the same export (source_hash) answers alreadyImported with nothing
 *                                                written. `reason` (why the operator ran it) goes in the audit log with who
 *                                                and when; MigrationOptions has no place for it.
 *
 * How the one transaction keeps the fence on: it runs on the owner's connection (the run row and the id map are the
 * platform's, out of the app role's reach), and every business row is written after `SET LOCAL ROLE bhava_app` with
 * app.tenant_id set to the target, inside withTenant, so row-level security holds each insert to the target business
 * exactly as it holds the product's own code. Only after the last business row does it step back to write the id map,
 * the run row and the order events' delivery mark, each naming the business.
 *
 * Old orders arrive with their numbers, tokens and statuses. Their `order.created` events are marked as handed out in the
 * same transaction, so no listener sends a message to an old shopper about an order they placed long ago.
 */

/** Business tables a run writes, by the export table that fills them, for the count check after the inserts. */
const TARGET_TABLE = Object.freeze({
  settings: 'settings', media: 'media', categories: 'categories', products: 'products', product_categories: 'product_categories', reels: 'reels',
  reel_products: 'reel_products', users: 'shoppers', orders: 'orders', order_items: 'order_items', activity: 'activity', visits: 'visits',
});

export class MigrationAborted extends ApiError {
  constructor(code) {
    super('conflict', 'The import did not add up, so nothing was imported.');
    this.migrationCode = code;
  }
}

const parse = (schema, value, what) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError('validation_failed', `The ${what} does not fit.`, { fields: { [issue.path.join('.') || what]: issue.message } });
  }
  return parsed.data;
};

/** What a failed run row records: a code, never a value from the export. */
export const failureCode = (err) => String(err?.migrationCode ?? (err?.constraint ? `db:${err.constraint}` : err?.code ? `error:${err.code}` : 'error')).replace(/[^A-Za-z0-9_.:#|-]/g, '').slice(0, 500);

const actorOf = (startedBy) => (startedBy ? `platform_user:${startedBy}` : 'operator:cli');

/** Everything prepare() needs from the database, read on `q` (the owner's): ids already imported, and what is taken. */
async function lookups(q, tid, source) {
  const k = keysOf(source);
  const [tenant] = await q('SELECT next_order_number FROM tenants WHERE id = $1', [tid]);
  if (!tenant) throw new ApiError('not_found', 'There is no such business.');
  const set = (rows, key) => new Set(rows.map((r) => String(r[key])));
  const owners = (rows, key) => new Map(rows.map((r) => [String(r[key]), Number(r.tenant_id)]));
  const map = new Map((await q('SELECT table_name, old_id, new_id FROM migration_id_map WHERE tenant_id = $1', [tid])).map((r) => [`${r.table_name}|${r.old_id}`, r.new_id]));
  return {
    map,
    nextOrderNumber: Number(tenant.next_order_number),
    productSlugs: set(await q('SELECT slug FROM products WHERE tenant_id = $1 AND slug = ANY($2::text[])', [tid, k.productSlugs]), 'slug'),
    categorySlugs: set(await q('SELECT slug FROM categories WHERE tenant_id = $1 AND slug = ANY($2::text[])', [tid, k.categorySlugs]), 'slug'),
    reelSlugs: set(await q('SELECT slug FROM reels WHERE tenant_id = $1 AND slug = ANY($2::text[])', [tid, k.reelSlugs]), 'slug'),
    // Across every business, but only whether a value is taken and by which business id: nothing of another business is read.
    reelOwners: owners(await q('SELECT ig_media_id, tenant_id FROM reels WHERE ig_media_id = ANY($1::text[])', [k.reelIds]), 'ig_media_id'),
    accountOwners: owners(await q('SELECT ig_user_id, tenant_id FROM ig_accounts WHERE ig_user_id = ANY($1::text[])', [k.accounts]), 'ig_user_id'),
    orderNumbers: set(await q('SELECT order_number FROM orders WHERE tenant_id = $1 AND order_number = ANY($2::text[])', [tid, k.orderNumbers]), 'order_number'),
    takenTokens: set(await q('SELECT public_token FROM orders WHERE public_token = ANY($1::text[])', [k.tokens]), 'public_token'),
    takenComments: set(await q('SELECT comment_id FROM activity WHERE comment_id = ANY($1::text[])', [k.comments]), 'comment_id'),
    shopperPhones: new Map((await q('SELECT phone, id FROM shoppers WHERE tenant_id = $1 AND phone = ANY($2::text[])', [tid, k.phones])).map((r) => [r.phone, String(r.id)])),
    settingKeys: set(await q('SELECT key FROM settings WHERE tenant_id = $1', [tid]), 'key'),
  };
}

const report = (mode, tid, hash, prepared, extra = {}) => MigrationReport.parse({
  mode, tenantId: tid, sourceHash: hash, counts: prepared.counts, conflicts: prepared.conflicts, blocked: prepared.blocked,
  alreadyImported: false, runId: null, nextOrderNumber: prepared.blocked ? null : prepared.nextOrderNumber, ...extra,
});

export function createMigration(ctx) {
  const { db } = ctx;
  const platform = ctx.platform ?? {};

  /** Every media file must be an image the product can use; plan() checks without storing anything. */
  async function checkMedia(rows) {
    if (!rows.length) return;
    if (!platform.images) throw new Error('The importer needs platform.images to read media');
    for (const { oldId, data } of rows) {
      try {
        await platform.images.inspect(Buffer.from(data.data, 'base64'));
      } catch {
        throw new MigrationRefused('media', oldId, 'data');
      }
    }
  }

  function begin(source, options) {
    const src = parse(MigrationSource, source, 'export');
    const opts = parse(MigrationOptions, options, 'options');
    return { src, opts, hash: sourceHash(src) };
  }

  async function plan(source, options) {
    const { src, opts, hash } = begin(source, options);
    const q = (sql, params) => db.platform.query(sql, params);
    const look = await lookups(q, opts.tenantId, src);
    const prepared = prepare(src, look, opts);
    await checkMedia(prepared.rows.media);
    const [done] = await q(`SELECT id FROM migration_runs WHERE tenant_id = $1 AND source_hash = $2 AND mode = 'real' AND status = 'done'`, [opts.tenantId, hash]);
    return report('dry', opts.tenantId, hash, prepared, { alreadyImported: Boolean(done), runId: null });
  }

  /** Writes every prepared row through the fence. Returns { newIds, orderIds, next }. `t` is the transaction. */
  async function writeRows(t, prepared, opts, stored) {
    const tid = tenantId();
    if (tid !== opts.tenantId) throw new Error('The import is not running for its own business');
    const q = (sql, params) => t.query(sql, params);
    const newIds = Object.fromEntries(LEGACY_TABLES.map((table) => [table, new Map()]));
    const { map } = prepared.look;
    const resolve = (table, oldId) => newIds[table].get(oldId) ?? map.get(`${table}|${oldId}`) ?? null;
    const shopperOf = (oldUser) => {
      if (oldUser === null) return null;
      const alias = prepared.aliases.get(oldUser);
      if (alias?.shopperId) return Number(alias.shopperId);
      const id = resolve('users', alias?.sameAs ?? oldUser);
      return id === null ? null : Number(id);
    };
    const mediaLink = (link) => {
      if (!link) return null;
      if (link.url) return link.url;
      const id = resolve('media', link.media);
      return id ? `/media/${id}` : null;
    };
    const one = async (table, sql, params) => {
      const rows = await q(sql, params);
      if (rows.length !== 1) throw new MigrationAborted(`count_mismatch:${table}`);
      return rows[0];
    };

    const before = {};
    for (const [table, target] of Object.entries(TARGET_TABLE)) {
      if (prepared.counts[table]) [{ n: before[table] }] = await q(`SELECT count(*)::int AS n FROM ${target} WHERE tenant_id = $1`, [tid]);
    }

    for (const { oldId, data } of prepared.rows.settings) {
      await one('settings', 'INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3) RETURNING key', [tid, data.key, data.value]);
      newIds.settings.set(oldId, data.key);
    }
    for (const { oldId, data } of prepared.rows.media) {
      // Through the image pipeline (upright, no metadata, re-encoded) and the storage module: never the old bytes as they were.
      let clean;
      try {
        clean = await platform.images.ingest(Buffer.from(data.data, 'base64'));
      } catch {
        throw new MigrationRefused('media', oldId, 'data');
      }
      const id = crypto.randomUUID();
      const key = `t/${tid}/media/${id}`;
      stored.push(key);
      await platform.storage.put(key, clean.buffer, clean.contentType);
      await one('media', 'INSERT INTO media (id, tenant_id, mime, size, storage_key) VALUES ($1, $2, $3, $4, $5) RETURNING id', [id, tid, clean.contentType, clean.buffer.length, key]);
      newIds.media.set(oldId, id);
    }
    for (const { oldId, data: c } of prepared.rows.categories) {
      const row = await one('categories', `INSERT INTO categories (tenant_id, name, slug, image_url, description, position, visible, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now())) RETURNING id`, [tid, c.name, c.slug, mediaLink(c.image) ?? '', c.description, c.position, c.visible, c.created_at]);
      newIds.categories.set(oldId, String(row.id));
    }
    for (const { oldId, data: p } of prepared.rows.products) {
      const links = [...new Set(p.links.map(mediaLink).filter(Boolean))];
      const row = await one('products', `INSERT INTO products (tenant_id, name, slug, description, price_paise, mrp_paise, images, option_label, option_values, stock, active, featured, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::text[], $10, $11, $12, COALESCE($13::timestamptz, now()), COALESCE($14::timestamptz, $13::timestamptz, now())) RETURNING id`,
      [tid, p.name, p.slug, p.description, p.price_paise, p.mrp_paise, JSON.stringify(links), p.option_label, p.option_values, p.stock, p.active, p.featured, p.created_at, p.updated_at]);
      for (const [position, link] of links.entries()) {
        const media = /^\/media\/(.+)$/.exec(link)?.[1] ?? null;
        await q('INSERT INTO product_images (tenant_id, product_id, position, media_id, source_url) VALUES ($1, $2, $3, $4, $5)', [tid, row.id, position, media, media ? '' : link]);
      }
      newIds.products.set(oldId, String(row.id));
    }
    for (const { oldId, data } of prepared.rows.product_categories) {
      const [product, category] = [resolve('products', data.product), resolve('categories', data.category)];
      await one('product_categories', 'INSERT INTO product_categories (tenant_id, product_id, category_id) VALUES ($1, $2, $3) RETURNING product_id', [tid, product, category]);
      newIds.product_categories.set(oldId, `${product}:${category}`);
    }
    for (const { oldId, data: r } of prepared.rows.reels) {
      await one('reels', `INSERT INTO reels (ig_media_id, tenant_id, slug, headline, keywords, dm_message, button_text, public_reply, active, permalink, thumbnail_url, video_url, caption, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::timestamptz, now()), COALESCE($15::timestamptz, $14::timestamptz, now())) RETURNING ig_media_id`,
      [r.igMediaId, tid, r.slug, r.headline, r.keywords, r.dm_message, r.button_text, r.public_reply, r.active, mediaLink(r.permalink) ?? '', mediaLink(r.thumbnail) ?? '', mediaLink(r.video) ?? '', r.caption, r.created_at, r.updated_at]);
      newIds.reels.set(oldId, r.igMediaId);
    }
    for (const { oldId, data } of prepared.rows.reel_products) {
      const [reel, product] = [resolve('reels', data.reel), resolve('products', data.product)];
      await one('reel_products', 'INSERT INTO reel_products (tenant_id, reel_id, product_id, position) VALUES ($1, $2, $3, $4) RETURNING reel_id', [tid, reel, product, data.position]);
      newIds.reel_products.set(oldId, `${reel}:${product}`);
    }
    for (const { oldId, data: s } of prepared.rows.users) {
      const row = await one('users', `INSERT INTO shoppers (tenant_id, phone, name, email, created_at) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now())) RETURNING id`, [tid, s.phone, s.name, s.email, s.created_at]);
      newIds.users.set(oldId, String(row.id));
    }
    const orderIds = [];
    for (const { oldId, data: o } of prepared.rows.orders) {
      const c = o.customer;
      const row = await one('orders', `INSERT INTO orders (tenant_id, order_number, public_token, reel_id, shopper_id, source, customer_name, phone, email, address, city, state, pincode,
          subtotal_paise, shipping_paise, total_paise, status, notes, flow, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'manual', COALESCE($19::timestamptz, now()), COALESCE($20::timestamptz, $19::timestamptz, now())) RETURNING id`,
      [tid, o.number, o.token, o.reel === null ? null : resolve('reels', o.reel), shopperOf(o.user), o.source, c.name, c.phone, c.email, c.address, c.city, c.state, c.pincode,
        o.subtotal, o.shipping, o.total, o.status, o.notes, o.created_at, o.updated_at]);
      newIds.orders.set(oldId, String(row.id));
      orderIds.push(row.id);
    }
    for (const { oldId, data: i } of prepared.rows.order_items) {
      const row = await one('order_items', `INSERT INTO order_items (tenant_id, order_id, product_id, name, image, price_paise, option_value, qty) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [tid, resolve('orders', i.order), i.product === null ? null : resolve('products', i.product), i.name, mediaLink(i.image) ?? '', i.price, i.option, i.qty]);
      newIds.order_items.set(oldId, String(row.id));
    }
    for (const { oldId, data: a } of prepared.rows.activity) {
      // username and text are written empty, whatever the export held (F-71).
      const row = await one('activity', `INSERT INTO activity (tenant_id, comment_id, reel_id, user_id, username, text, result, error, created_at) VALUES ($1, $2, $3, $4, '', '', $5, $6, COALESCE($7::timestamptz, now())) RETURNING id`,
        [tid, a.comment, a.reel === null ? null : resolve('reels', a.reel), a.user, a.result, a.error, a.created_at]);
      newIds.activity.set(oldId, String(row.id));
    }
    for (const { oldId, data: v } of prepared.rows.visits) {
      const row = await one('visits', 'INSERT INTO visits (tenant_id, reel_id, source, created_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now())) RETURNING id', [tid, resolve('reels', v.reel), v.source, v.created_at]);
      newIds.visits.set(oldId, String(row.id));
    }

    // The count check (PRD 5.16): what the business holds now is what it held plus what this run says it wrote.
    for (const [table, target] of Object.entries(TARGET_TABLE)) {
      if (!prepared.counts[table]) continue;
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${target} WHERE tenant_id = $1`, [tid]);
      if (n - before[table] !== prepared.counts[table].imported || newIds[table].size !== prepared.counts[table].imported) throw new MigrationAborted(`count_mismatch:${table}`);
    }
    if (!countsBalance(prepared.counts)) throw new MigrationAborted('count_mismatch:balance');

    const [{ next_order_number: next }] = await q('UPDATE tenants SET next_order_number = GREATEST(next_order_number, $2) WHERE id = $1 RETURNING next_order_number', [tid, prepared.nextOrderNumber]);
    return { newIds, orderIds, next: Number(next) };
  }

  async function recordFailure({ src, opts, hash }, prepared, err, meta) {
    const code = err ? failureCode(err) : 'blocked';
    try {
      const [row] = await db.platform.query(
        `INSERT INTO migration_runs (tenant_id, source, source_hash, mode, status, counts, conflicts, error, started_by, finished_at)
         VALUES ($1, $2, $3, 'real', 'failed', $4::jsonb, $5::jsonb, $6, $7, now()) RETURNING id`,
        [opts.tenantId, src.label, hash, JSON.stringify(prepared?.counts ?? {}), JSON.stringify(prepared?.conflicts ?? []), code, opts.startedBy],
      );
      await withTenant(opts.tenantId, () => db.tx((t) => writeAudit(t, {
        actor: actorOf(opts.startedBy), action: 'business.import_failed', target: `migration_run:${row.id}`,
        details: { runId: Number(row.id), sourceHash: hash, error: code, reason: meta.reason },
      })));
      return Number(row.id);
    } catch (recordErr) {
      log.error('migration.failure_not_recorded', { tenantId: opts.tenantId, code: failureCode(recordErr) });
      return null;
    }
  }

  async function removeStored(keys) {
    for (const key of keys) await platform.storage.remove(key).catch(() => {});
  }

  async function run(source, options, { reason = '' } = {}) {
    const begun = begin(source, options);
    const { src, opts, hash } = begun;
    const meta = { reason: plainLine(String(reason ?? ''), 200) };
    const tid = opts.tenantId;
    const stored = [];
    let prepared = null;
    let outcome;
    try {
      outcome = await withTenant(tid, () => db.platform.tx(async (t) => {
        const q = (sql, params) => t.query(sql, params);
        // One import into a business at a time; a second waits, then finds the first one's work.
        await q('SELECT pg_advisory_xact_lock($1, $2)', [0x6d696772, tid]);
        const look = await lookups(q, tid, src);
        prepared = { ...prepare(src, look, opts), look };
        const [done] = await q(`SELECT id FROM migration_runs WHERE tenant_id = $1 AND source_hash = $2 AND mode = 'real' AND status = 'done'`, [tid, hash]);
        if (done) return { kind: 'already', runId: Number(done.id) };
        if (prepared.blocked) return { kind: 'blocked' };
        const [runRow] = await q(`INSERT INTO migration_runs (tenant_id, source, source_hash, mode, started_by) VALUES ($1, $2, $3, 'real', $4) RETURNING id`, [tid, src.label, hash, opts.startedBy]);
        const runId = Number(runRow.id);

        // The fence goes on for every business row: the app role, held to this business by row-level security.
        await q(`SET LOCAL ROLE ${APP_ROLE}`);
        await q(`SELECT set_config('app.tenant_id', $1, true), set_config('app.order_actor', 'migration', true), set_config('app.order_reason', 'import', true)`, [String(tid)]);
        const written = await writeRows(t, prepared, opts, stored);
        await writeAudit(t, {
          actor: actorOf(opts.startedBy), action: 'business.imported', target: `migration_run:${runId}`,
          details: { runId, sourceHash: hash, source: src.label, reason: meta.reason, reels: opts.reels ?? null, counts: prepared.counts, nextOrderNumber: written.next },
        });
        await q('RESET ROLE');

        // The platform's part, each naming this business: the id map, the run, and old orders' events marked as handed out.
        const entries = Object.entries(written.newIds).flatMap(([table, ids]) => [...ids].map(([oldId, newId]) => [table, oldId, String(newId)]));
        for (const [oldUser, alias] of prepared.aliases) {
          const target = alias.shopperId ?? written.newIds.users.get(alias.sameAs) ?? prepared.look.map.get(`users|${alias.sameAs}`);
          if (target) entries.push(['users', oldUser, String(target)]);
        }
        for (let i = 0; i < entries.length; i += 5000) {
          const part = entries.slice(i, i + 5000);
          await q(`INSERT INTO migration_id_map (tenant_id, run_id, table_name, old_id, new_id) SELECT $1, $2, x.t, x.o, x.n
                   FROM unnest($3::text[], $4::text[], $5::text[]) AS x(t, o, n)`, [tid, runId, part.map((e) => e[0]), part.map((e) => e[1]), part.map((e) => e[2])]);
        }
        if (written.orderIds.length) {
          await q('UPDATE order_events SET fanned_out_at = now() WHERE tenant_id = $1 AND order_id = ANY($2::int[]) AND fanned_out_at IS NULL', [tid, written.orderIds]);
        }
        await q(`UPDATE migration_runs SET status = 'done', counts = $3::jsonb, conflicts = $4::jsonb, finished_at = now() WHERE tenant_id = $1 AND id = $2`,
          [tid, runId, JSON.stringify(prepared.counts), JSON.stringify(prepared.conflicts)]);
        return { kind: 'done', runId, next: written.next };
      }));
    } catch (err) {
      await removeStored(stored);
      await recordFailure(begun, prepared, err, meta);
      throw err;
    }

    if (outcome.kind === 'already') return report('real', tid, hash, prepared, { alreadyImported: true, runId: outcome.runId, nextOrderNumber: null });
    if (outcome.kind === 'blocked') {
      const runId = await recordFailure(begun, prepared, null, meta);
      return report('real', tid, hash, prepared, { runId });
    }
    log.info('migration.done', { tenantId: tid, runId: outcome.runId, rows: Object.values(prepared.counts).reduce((n, c) => n + c.imported, 0) });
    return report('real', tid, hash, prepared, { runId: outcome.runId, nextOrderNumber: outcome.next });
  }

  return { plan, run };
}

export const migration = {
  name: 'migration',
  owns: { migrations: ['800_migration.sql'], tables: ['migration_runs', 'migration_id_map'], api: [], store: [], platform: [], jobs: [] },
};

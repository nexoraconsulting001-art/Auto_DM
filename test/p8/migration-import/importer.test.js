// The importer of an old single-shop app (PRD 5.16): dry run, one transaction, remapped ids, kept slugs, numbers, tokens and
// media, the order counter, stripped activity, never-copied secrets, reels on another business's account, and what must
// hold when the export or the database misbehaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MigrationReport, countsBalance } from '../../../src/contracts/migration.js';
import { COMMENT_TEXT, MEDIA_ID, USERNAMES, legacyExport, order, snapshot, world, wrapDb } from './support.js';

const reason = 'Moving the old shop onto the platform';

test('F-68: a dry run shows counts per table and every conflict, and writes nothing at all', async () => {
  const w = await world();
  const before = await snapshot(w, w.target.id);
  const runsBefore = await w.q('SELECT count(*)::int AS n FROM migration_runs');
  const report = await w.importer().plan(await legacyExport(), { tenantId: w.target.id });
  assert.equal(MigrationReport.safeParse(report).success, true);
  assert.equal(report.mode, 'dry');
  assert.equal(report.blocked, false);
  assert.equal(report.runId, null);
  assert.deepEqual(report.counts.products, { source: 3, imported: 3, skipped: 0 });
  assert.deepEqual(report.counts.users, { source: 3, imported: 2, skipped: 1 }, 'the old owner is never copied');
  assert.deepEqual(report.counts.settings, { source: 5, imported: 3, skipped: 2 }, 'Instagram tokens are never copied');
  assert.deepEqual(report.counts.sessions, { source: 1, imported: 0, skipped: 1 }, 'sessions are known and never copied');
  assert.deepEqual(report.counts.orders, { source: 4, imported: 4, skipped: 0 });
  assert.equal(report.nextOrderNumber, 4211);
  assert.ok(countsBalance(report.counts));
  assert.deepEqual(await snapshot(w, w.target.id), before, 'no business row');
  assert.deepEqual(await w.q('SELECT count(*)::int AS n FROM migration_runs'), runsBefore, 'no run row');
  assert.equal(w.files.size, 0, 'no file stored');
});

test('a real run imports everything in one go: ids remapped, slugs, order numbers, tokens and media kept, every row the target’s', async () => {
  const w = await world();
  const source = await legacyExport();
  const neighbourBefore = await snapshot(w, w.neighbour.id);
  const report = await w.importer().run(source, { tenantId: w.target.id, startedBy: w.operatorId }, { reason });
  assert.equal(report.mode, 'real');
  assert.equal(report.blocked, false);
  assert.ok(report.runId > 0);
  assert.ok(countsBalance(report.counts));
  assert.deepEqual(await snapshot(w, w.neighbour.id), neighbourBefore, 'the neighbour, whose ids and slugs clash, is untouched');

  const t = w.target.id;
  const products = await w.q('SELECT id, slug, name, images, price_paise, mrp_paise, option_values, tenant_id FROM products WHERE tenant_id = $1 ORDER BY slug', [t]);
  assert.deepEqual(products.map((p) => p.slug), ['brass-lamp', 'clay-diya', 'old-stock'], 'slugs kept');
  assert.ok(!products.some((p) => p.id === w.neighbourProduct.id), 'the old id 1 became a new row, never the neighbour’s product 1');
  const lamp = products[0];
  assert.equal(lamp.price_paise, 49900);
  assert.deepEqual(lamp.option_values, ['S', 'M']);
  const [media] = await w.q('SELECT id, mime, storage_key FROM media WHERE tenant_id = $1', [t]);
  assert.notEqual(media.id, MEDIA_ID, 'media ids are remapped');
  assert.equal(media.storage_key, `t/${t}/media/${media.id}`, 'stored through the storage module under the business');
  assert.equal(media.mime, 'image/webp', 'through the image pipeline: re-encoded, never the old bytes');
  const file = w.files.get(media.storage_key);
  assert.ok(file && !file.buffer.equals(Buffer.from(source.tables.media[0].data, 'base64')));
  assert.deepEqual(lamp.images, [`/media/${media.id}`, 'https://cdn.example.test/lamp.jpg'], 'product pictures point at the new media');
  const gallery = await w.q('SELECT position, media_id, source_url FROM product_images WHERE tenant_id = $1 AND product_id = $2 ORDER BY position', [t, lamp.id]);
  assert.deepEqual(gallery.map((g) => [g.position, g.media_id, g.source_url]), [[0, media.id, ''], [1, null, 'https://cdn.example.test/lamp.jpg']]);
  const [category] = await w.q(`SELECT image_url FROM categories WHERE tenant_id = $1 AND slug = 'lamps'`, [t]);
  assert.equal(category.image_url, `/media/${media.id}`);

  const orders = await w.q('SELECT order_number, public_token, status, reel_id, shopper_id FROM orders WHERE tenant_id = $1 ORDER BY order_number', [t]);
  assert.deepEqual(orders.map((o) => o.order_number), ['OLH-4100', 'OLH-4208', 'OLH-4209', 'OLH-4210']);
  assert.deepEqual(orders.map((o) => o.public_token).sort(), source.tables.orders.map((o) => o.public_token).sort(), 'public tokens kept, so old order links still open');
  assert.equal(orders.find((o) => o.order_number === 'OLH-4210').status, 'delivered');
  assert.equal(orders.find((o) => o.order_number === 'OLH-4208').reel_id, '17900000000000001');
  const reels = await w.q('SELECT ig_media_id, slug FROM reels WHERE tenant_id = $1 ORDER BY slug', [t]);
  assert.deepEqual(reels.map((r) => r.slug), ['clay-corner', 'diwali-edit']);
  const links = await w.q('SELECT count(*)::int AS n FROM reel_products WHERE tenant_id = $1', [t]);
  assert.equal(links[0].n, 3);

  // Nothing secret came across: no password hash anywhere, no Instagram token, no old owner.
  const settings = Object.fromEntries((await w.q('SELECT key, value FROM settings WHERE tenant_id = $1', [t])).map((s) => [s.key, s.value]));
  assert.equal(settings.store_name, 'Old Lamp House');
  assert.equal(settings.trust_points, 'Ships across India\nCash on delivery');
  assert.ok(!('ig_token' in settings) && !('access_token' in settings));
  assert.equal((await w.q('SELECT count(*)::int AS n FROM users WHERE tenant_id = $1', [t]))[0].n, 0, 'no login made: shoppers sign in with a code, the owner is re-invited');
  const shoppers = await w.q('SELECT phone, phone_verified_at FROM shoppers WHERE tenant_id = $1 ORDER BY phone', [t]);
  assert.deepEqual(shoppers.map((s) => s.phone), ['+919000000201', '+919000000202']);
  assert.ok(shoppers.every((s) => s.phone_verified_at === null), 'a number is proved again at the first sign-in');
  const everything = JSON.stringify(await Promise.all(['settings', 'shoppers', 'orders', 'ig_accounts'].map((table) => w.q(`SELECT * FROM ${table} WHERE tenant_id = $1`, [t]))));
  for (const secret of ['scrypt$old', 'IGQ-old-secret-token', 'EAA-old-secret-token', '9000000299']) assert.ok(!everything.includes(secret), 'never copied');

  // Every row written carries the target business, and the id map knows each one.
  for (const table of ['settings', 'media', 'categories', 'products', 'product_images', 'product_categories', 'reels', 'reel_products', 'shoppers', 'orders', 'order_items', 'activity', 'visits']) {
    const rows = await w.q(`SELECT tenant_id FROM ${table} WHERE tenant_id <> $1 AND tenant_id <> $2`, [t, w.neighbour.id]);
    assert.equal(rows.length, 0, table);
  }
  const map = await w.q('SELECT table_name, count(*)::int AS n FROM migration_id_map WHERE tenant_id = $1 GROUP BY table_name ORDER BY table_name', [t]);
  assert.deepEqual(Object.fromEntries(map.map((m) => [m.table_name, m.n])), { activity: 3, categories: 2, media: 1, order_items: 4, orders: 4, product_categories: 2, products: 3, reel_products: 3, reels: 2, settings: 3, users: 2, visits: 2 });
  const [run] = await w.q('SELECT status, mode, started_by, finished_at FROM migration_runs WHERE id = $1', [report.runId]);
  assert.deepEqual([run.status, run.mode, run.started_by], ['done', 'real', w.operatorId]);

  // Old orders tell no listener anything: no message goes to an old shopper about an order long past.
  const pending = await w.q('SELECT count(*)::int AS n FROM order_events WHERE tenant_id = $1 AND fanned_out_at IS NULL', [t]);
  assert.equal(pending[0].n, 0);
});

test('every business row of the import is written as the app role, fenced to the target business', async () => {
  const w = await world();
  const seen = [];
  const db = wrapDb(w.db, async (sql, params, t) => {
    const insert = /^\s*INSERT INTO (\w+)/.exec(sql)?.[1];
    if (insert && !insert.startsWith('migration_')) {
      const [who] = await t.query(`SELECT current_user AS u, current_setting('app.tenant_id', true) AS tid`);
      seen.push(`${insert}:${who.u}:${who.tid}`);
    }
    return t.query(sql, params);
  });
  await w.importer({ db }).run(await legacyExport(), { tenantId: w.target.id }, { reason });
  assert.ok(seen.length > 20);
  for (const entry of seen) assert.match(entry, new RegExp(`:bhava_app:${w.target.id}$`), entry);
});

test('F-70: the first new order after an import whose highest number is 4210 is numbered 4211; the counter never moves back', async () => {
  const w = await world();
  const report = await w.importer().run(await legacyExport({ highest: 4210 }), { tenantId: w.target.id }, { reason });
  assert.equal(report.nextOrderNumber, 4211);
  const [{ next_order_number: next }] = await w.q('SELECT next_order_number FROM tenants WHERE id = $1', [w.target.id]);
  assert.equal(next, 4211);
  const settings = await w.inTarget(() => w.targetRepos.settings.getAll());
  const [product] = await w.q(`SELECT id FROM products WHERE tenant_id = $1 AND slug = 'clay-diya'`, [w.target.id]);
  const placed = await w.inTarget(() => w.targetRepos.orders.create({ items: [{ productId: product.id, qty: 1 }], customer: { name: 'Ira Mehra', phone: '9000000210', address: '4 Hill Road, Aundh', city: 'Pune', state: 'Maharashtra', pincode: '411007' } }, settings));
  assert.match(placed.order_number, /-4211$/);

  const w2 = await world();
  await w2.q('UPDATE tenants SET next_order_number = 9000 WHERE id = $1', [w2.target.id]);
  const second = await w2.importer().run(await legacyExport({ highest: 4210 }), { tenantId: w2.target.id }, { reason });
  assert.equal(second.nextOrderNumber, 9000);
});

test('F-71: migrated activity holds no usernames and no comment text, and neither does anything else the run wrote', async () => {
  const w = await world();
  const report = await w.importer().run(await legacyExport(), { tenantId: w.target.id }, { reason });
  const activity = await w.q('SELECT username, text, result, comment_id, reel_id FROM activity WHERE tenant_id = $1', [w.target.id]);
  assert.equal(activity.length, 3);
  assert.ok(activity.every((a) => a.username === '' && a.text === '' && a.result === 'sent'));
  assert.ok(activity.every((a) => a.reel_id === '17900000000000001'), 'still counted against its reel');
  const written = JSON.stringify([
    ...(await Promise.all(['activity', 'visits', 'orders', 'shoppers', 'settings', 'audit_log'].map((table) => w.q(`SELECT * FROM ${table} WHERE tenant_id = $1`, [w.target.id])))),
    await w.q('SELECT * FROM migration_runs WHERE id = $1', [report.runId]),
    await w.q('SELECT * FROM migration_id_map WHERE tenant_id = $1', [w.target.id]),
  ]);
  for (const value of [...USERNAMES, ...COMMENT_TEXT]) assert.ok(!written.includes(value), 'stripped everywhere');
});

test('F-73: reels of the old shop on another business’s Instagram account block until the operator chooses drop or reassign', async () => {
  const w = await world();
  const source = await legacyExport({ igUserId: 'NEIGHBOUR-IG' });
  const before = await snapshot(w, w.target.id);

  const dry = await w.importer().plan(source, { tenantId: w.target.id });
  assert.equal(dry.blocked, true);
  assert.deepEqual(dry.conflicts.filter((c) => c.kind === 'reel_on_other_account').map((c) => [c.oldId, c.blocking]), [['17900000000000001', true], ['17900000000000002', true]]);
  assert.equal(dry.nextOrderNumber, null);

  const blocked = await w.importer().run(source, { tenantId: w.target.id }, { reason });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(await snapshot(w, w.target.id), before, 'nothing written while blocked');
  const [failed] = await w.q('SELECT status, error, conflicts FROM migration_runs WHERE id = $1', [blocked.runId]);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'blocked');

  const dropped = await w.importer().run(source, { tenantId: w.target.id, reels: 'drop' }, { reason });
  assert.equal(dropped.blocked, false);
  assert.ok(dropped.conflicts.filter((c) => c.kind === 'reel_on_other_account').every((c) => !c.blocking), 'settled by the choice');
  assert.deepEqual(dropped.counts.reels, { source: 2, imported: 0, skipped: 2 });
  assert.deepEqual(dropped.counts.reel_products, { source: 3, imported: 0, skipped: 3 });
  assert.deepEqual(dropped.counts.visits, { source: 2, imported: 0, skipped: 2 });
  assert.equal((await w.q('SELECT count(*)::int AS n FROM reels WHERE tenant_id = $1', [w.target.id]))[0].n, 0);
  const [placed] = await w.q(`SELECT reel_id FROM orders WHERE tenant_id = $1 AND order_number = 'OLH-4208'`, [w.target.id]);
  assert.equal(placed.reel_id, null, 'the order stays, without the dropped reel');

  const w2 = await world();
  const reassigned = await w2.importer().run(source, { tenantId: w2.target.id, reels: 'reassign' }, { reason });
  assert.deepEqual(reassigned.counts.reels, { source: 2, imported: 2, skipped: 0 });
  const reels = await w2.q('SELECT ig_media_id, slug, active, permalink, thumbnail_url FROM reels WHERE tenant_id = $1 ORDER BY slug', [w2.target.id]);
  assert.deepEqual(reels.map((r) => r.slug), ['clay-corner', 'diwali-edit'], 'the pages and their links are kept');
  assert.ok(reels.every((r) => !r.active && r.permalink === '' && r.thumbnail_url === ''), 'off, and showing nothing of the other account');
  assert.ok(reels.every((r) => r.ig_media_id.startsWith(`migrated-${w2.target.id}-`)), 'never the other account’s media id');
  assert.equal((await w2.q('SELECT count(*)::int AS n FROM reel_products WHERE tenant_id = $1', [w2.target.id]))[0].n, 3);
});

test('a reel whose media another business already holds is a conflict, never moved or overwritten', async () => {
  const w = await world();
  await w.q(`INSERT INTO reels (ig_media_id, tenant_id, slug, headline) VALUES ('17900000000000002', $1, 'neighbour-reel', 'Theirs')`, [w.neighbour.id]);
  const report = await w.importer().plan(await legacyExport(), { tenantId: w.target.id });
  assert.deepEqual(report.conflicts.filter((c) => c.blocking).map((c) => [c.kind, c.oldId]), [['reel_on_other_account', '17900000000000002']]);
  const [theirs] = await w.q(`SELECT tenant_id, slug FROM reels WHERE ig_media_id = '17900000000000002'`);
  assert.deepEqual([theirs.tenant_id, theirs.slug], [w.neighbour.id, 'neighbour-reel']);
});

test('running the same export twice imports once; a later export with one more row adds only that row', async () => {
  const w = await world();
  const source = await legacyExport();
  const first = await w.importer().run(source, { tenantId: w.target.id }, { reason });
  const after = await snapshot(w, w.target.id);
  const again = await w.importer().run(source, { tenantId: w.target.id }, { reason });
  assert.equal(again.alreadyImported, true);
  assert.equal(again.runId, first.runId);
  assert.deepEqual(await snapshot(w, w.target.id), after, 'nothing written twice');
  assert.equal((await w.importer().plan(source, { tenantId: w.target.id })).alreadyImported, true);

  const more = await legacyExport();
  more.tables.products.push({ id: 4, name: 'Copper bell', slug: 'copper-bell', price_paise: 25000, images: [], active: true });
  more.tables.orders.push(order(5, 'OLH-4300', 1, { phone: '9000000201' }));
  more.tables.order_items.push({ id: 5, order_id: 5, product_id: 4, name: 'Copper bell', price_paise: 49900, qty: 1 });
  const second = await w.importer().run(more, { tenantId: w.target.id }, { reason });
  assert.equal(second.alreadyImported, false);
  assert.deepEqual(second.counts.products, { source: 4, imported: 1, skipped: 3 });
  assert.deepEqual(second.counts.orders, { source: 5, imported: 1, skipped: 4 });
  assert.deepEqual(second.counts.media, { source: 1, imported: 0, skipped: 1 });
  assert.equal(second.nextOrderNumber, 4301);
  assert.equal((await w.q('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [w.target.id]))[0].n, 4);
  const [{ shopper_id: shopper }] = await w.q(`SELECT shopper_id FROM orders WHERE tenant_id = $1 AND order_number = 'OLH-4300'`, [w.target.id]);
  const [{ shopper_id: earlier }] = await w.q(`SELECT shopper_id FROM orders WHERE tenant_id = $1 AND order_number = 'OLH-4210'`, [w.target.id]);
  assert.equal(shopper, earlier, 'the same old shopper, found through the id map');
});

test('F-69: a failure at row 5,000 rolls everything back: the business is exactly as it was and no file is left', async () => {
  const w = await world();
  const source = await legacyExport();
  source.tables.activity = Array.from({ length: 6000 }, (_, i) => ({ id: i + 1, comment_id: null, reel_id: '17900000000000001', user_id: `9${i}`, username: 'demo_x', text: 'LINK', result: 'sent', created_at: '2025-03-01T10:00:00.000Z' }));
  const before = await snapshot(w, w.target.id);
  let n = 0;
  const db = wrapDb(w.db, (sql, params, t) => {
    if (/^\s*INSERT INTO activity/.test(sql) && ++n === 5000) throw new Error('could not extend file: no space left on device');
    return t.query(sql, params);
  });
  await assert.rejects(w.importer({ db }).run(source, { tenantId: w.target.id }, { reason }), /no space left/);
  assert.equal(n, 5000);
  assert.deepEqual(await snapshot(w, w.target.id), before);
  assert.equal(w.files.size, 0, 'the stored media is removed again');
  const runs = await w.q('SELECT status, mode, error FROM migration_runs WHERE tenant_id = $1', [w.target.id]);
  assert.deepEqual(runs.map((r) => [r.mode, r.status]), [['real', 'failed']], 'the failure is on record, outside the rolled-back transaction');
  assert.doesNotMatch(runs[0].error, /demo_x|LINK/);
  const [audit] = await w.q(`SELECT actor, action FROM audit_log WHERE tenant_id = $1 AND action = 'business.import_failed'`, [w.target.id]);
  assert.equal(audit.actor, 'operator:cli');

  // Fixed, the same export then imports whole.
  const fixed = await w.importer().run(source, { tenantId: w.target.id }, { reason });
  assert.deepEqual(fixed.counts.activity, { source: 6000, imported: 6000, skipped: 0 });
});

test('a count that does not add up aborts the run and rolls it back', async () => {
  const w = await world();
  const before = await snapshot(w, w.target.id);
  let counts = 0;
  const db = wrapDb(w.db, async (sql, params, t) => {
    const rows = await t.query(sql, params);
    // The second count of products, after the inserts, comes back one short: as if a row went missing.
    if (/^SELECT count\(\*\)::int AS n FROM products/.test(sql) && ++counts === 2) return [{ n: rows[0].n - 1 }];
    return rows;
  });
  await assert.rejects(w.importer({ db }).run(await legacyExport(), { tenantId: w.target.id }, { reason }), (err) => err.migrationCode === 'count_mismatch:products');
  assert.deepEqual(await snapshot(w, w.target.id), before);
  const [run] = await w.q('SELECT status, error FROM migration_runs WHERE tenant_id = $1', [w.target.id]);
  assert.deepEqual([run.status, run.error], ['failed', 'count_mismatch:products']);
});

test('an insert that comes back without its row aborts the run', async () => {
  const w = await world();
  const before = await snapshot(w, w.target.id);
  const db = wrapDb(w.db, async (sql, params, t) => {
    const rows = await t.query(sql, params);
    return /^\s*INSERT INTO order_items/.test(sql) ? [] : rows;
  });
  await assert.rejects(w.importer({ db }).run(await legacyExport(), { tenantId: w.target.id }, { reason }), (err) => err.migrationCode === 'count_mismatch:order_items');
  assert.deepEqual(await snapshot(w, w.target.id), before);
});

test('the import is audited with who, when and why', async () => {
  const w = await world();
  const report = await w.importer().run(await legacyExport(), { tenantId: w.target.id, startedBy: w.operatorId }, { reason });
  const [row] = await w.q(`SELECT actor, action, target, details, created_at FROM audit_log WHERE tenant_id = $1 AND action = 'business.imported'`, [w.target.id]);
  assert.equal(row.actor, `platform_user:${w.operatorId}`);
  assert.equal(row.target, `migration_run:${report.runId}`);
  assert.equal(row.details.reason, reason);
  assert.equal(row.details.sourceHash, report.sourceHash);
  assert.equal(row.details.counts.orders.imported, 4);
  assert.ok(row.created_at);
});

// F-68 to F-73 (PRD 5.16): importing an old single-shop app into one business. Through the importer's own interface
// (createMigration(...).plan / .run), the database and, for F-72, the shopper's sign-in on the store. The old app's export is
// built here from fixtures (legacyExport). Attack cases: a failure at the first, a middle and the last write; the same export
// twice and twice at once; hostile content; ids and tokens that belong to another business; usernames and comment text hunted
// through every table; the first order number after the import.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTenant } from '../../../src/repos/index.js';
import { MigrationReport, countsBalance } from '../../../src/contracts/migration.js';
import { world as shopperWorld } from '../../p4/shoppers/support.js';
import { browser } from '../../p4/shoppers/support.js';
import {
  FULL, MARKERS, RECORD_KEEPING, addBusiness, addOrder, addProduct, altered, api, captureLogs, countOf, emptyBusiness, faultyDb, hit, importerOf, legacyExport, need, signIn, snapshot,
  closeShared, importerPlatform, sharedWorld, sql, u, whereFound,
} from './support.js';

after(closeShared);

const IMPORTED_TABLES = ['products', 'categories', 'orders', 'order_items', 'activity', 'visits'];
const unchanged = (before, after) => assert.deepEqual(after, before);
const snap = (app, id) => snapshot(app, id, { skip: RECORD_KEEPING });
const outcome = (promise) => promise.then((report) => ({ report }), (error) => ({ error }));

async function twoShops(t) {
  const app = await sharedWorld();
  const a = await emptyBusiness(app, u('incoming'));
  const b = await addBusiness(app, { slug: u('neighbour'), name: 'Neighbour' });
  const importer = await importerOf(app);
  return { app, a, b, importer };
}

// ---- F-68 ----------------------------------------------------------------------------------------------------------------------

test('F-68: a dry run shows counts per table and conflicts, and writes nothing', async (t) => {
  const { app, a, importer } = await twoShops(t);
  const source = legacyExport({ products: 7, categories: 3, orders: 4, itemsPerOrder: 3, activity: 5 });
  const before = await snap(app, a.id);
  const report = await importer.plan(source, { tenantId: a.id });
  assert.equal(MigrationReport.safeParse(report).success, true, 'the report has the contract shape');
  assert.equal(report.mode, 'dry');
  assert.equal(report.tenantId, a.id);
  assert.equal(report.runId === null || Number.isInteger(report.runId), true);
  for (const [table, rows] of Object.entries(source.tables)) {
    assert.equal(report.counts[table]?.source, rows.length, `${table}: the source count`);
    assert.equal(report.counts[table].imported + report.counts[table].skipped, rows.length, `${table}: nothing unaccounted for`);
  }
  assert.equal(report.counts.products.imported, 7, 'a dry run says what a real run would write');
  assert.equal(report.counts.order_items.imported, 12);
  assert.ok(countsBalance(report.counts));
  assert.equal(report.blocked, false);
  assert.equal(report.alreadyImported, false);
  unchanged(before, await snap(app, a.id));
  for (const table of IMPORTED_TABLES) assert.equal(await countOf(app, a.id, table), 0, `${table} stays empty`);
  assert.equal((await sql(app, 'SELECT count(*)::int AS n FROM migration_id_map WHERE tenant_id = $1', [a.id]))[0].n, 0, 'a dry run maps no ids');
  const again = await importer.plan(source, { tenantId: a.id });
  assert.deepEqual(again.counts, report.counts, 'the same answer the second time');
  assert.equal(again.sourceHash, report.sourceHash, 'the hash is of the contents');
  assert.notEqual((await importer.plan(altered(source, (tables) => tables.products.pop()), { tenantId: a.id })).sourceHash, report.sourceHash);
  assert.equal(JSON.stringify(report).includes(MARKERS.username(0)), false, 'the report holds no username');
});

test('F-68: a dry run lists every conflict as ids and codes, blocks, and still writes nothing', async (t) => {
  const { app, a, b, importer } = await twoShops(t);
  const source = legacyExport({ products: 4, orders: 3 });
  const mine = bindTenant(app.platform, a.tenant);
  await mine.products.create({ name: 'Already here', slug: 'old-product-2', price: '100', active: 'on' });
  const before = await snap(app, a.id);
  const report = await importer.plan(source, { tenantId: a.id });
  assert.equal(report.blocked, true);
  const slugClash = report.conflicts.find((c) => c.kind === 'slug_taken' && c.table === 'products');
  assert.ok(slugClash, JSON.stringify(report.conflicts));
  assert.equal(slugClash.blocking, true);
  assert.equal(slugClash.oldId, '2');
  assert.ok(report.conflicts.every((c) => Object.keys(c).sort().join() === 'blocking,kind,oldId,table'), 'ids and codes only');
  unchanged(before, await snap(app, a.id));
});

test('F-68: a table the importer does not know is a blocking conflict, never dropped', async (t) => {
  const { app, a, importer } = await twoShops(t);
  const source = altered(legacyExport(), (tables) => { tables.loyalty_points = [{ id: 1, points: 5 }]; });
  const before = await snap(app, a.id);
  const dry = await importer.plan(source, { tenantId: a.id });
  assert.ok(dry.conflicts.some((c) => c.kind === 'unknown_table' && c.table === 'loyalty_points' && c.blocking));
  assert.equal(dry.blocked, true);
  const real = await outcome(importer.run(source, { tenantId: a.id }));
  assert.ok(real.error || real.report.blocked, 'a real run does not go ahead');
  unchanged(before, await snap(app, a.id));
});

// ---- F-69 ----------------------------------------------------------------------------------------------------------------------

const WRITES = /INSERT\s+INTO\s+"?(products|orders|order_items|categories|activity|visits|reels)"?\b/i;

async function failAt(t, which, source) {
  const app = await sharedWorld();
  const counting = { at: 0, seen: 0 };
  const measureShop = await emptyBusiness(app, u('measure'));
  const measured = await (await import('../../../src/modules/migration/index.js')).createMigration({ db: faultyDb(app.db, WRITES, counting), platform: importerPlatform(app), repos: app.platform, config: app.config });
  const ok = await measured.run(source, { tenantId: measureShop.id });
  assert.equal(ok.blocked, false, 'the measuring run goes through');
  const writes = counting.seen;
  assert.ok(writes >= 3, `the import makes at least three writes of its own to count (saw ${writes})`);
  const at = { first: 1, middle: Math.ceil(writes / 2), last: writes }[which];
  const target = await emptyBusiness(app, u(`fails-${which}`));
  const fault = { at, seen: 0 };
  const importer = (await import('../../../src/modules/migration/index.js')).createMigration({ db: faultyDb(app.db, WRITES, fault), platform: importerPlatform(app), repos: app.platform, config: app.config });
  const before = await snap(app, target.id);
  const result = await outcome(importer.run(source, { tenantId: target.id }));
  assert.ok(result.error, `write ${at} of ${writes} failed and the run must not report success`);
  assert.equal(fault.seen >= at, true, 'the fault was reached');
  return { app, target, before, source };
}

for (const which of ['first', 'middle', 'last']) {
  test(`F-69: a failure at the ${which} write rolls everything back and leaves the business exactly as it was`, async (t) => {
    const source = legacyExport({ products: 40, categories: 4, orders: 15, itemsPerOrder: 2, activity: 20, reels: 3 });
    const { app, target, before } = await failAt(t, which, source);
    unchanged(before, await snap(app, target.id));
    for (const table of IMPORTED_TABLES) assert.equal(await countOf(app, target.id, table), 0, `${table} is empty`);
    assert.equal((await sql(app, 'SELECT count(*)::int AS n FROM migration_id_map WHERE tenant_id = $1', [target.id]))[0].n, 0, 'no id was mapped');
    assert.equal((await sql(app, `SELECT count(*)::int AS n FROM migration_runs WHERE tenant_id = $1 AND mode = 'real' AND status = 'done'`, [target.id]))[0].n, 0, 'no finished run is recorded');
    assert.equal((await sql(app, 'SELECT next_order_number FROM tenants WHERE id = $1', [target.id]))[0].next_order_number, 1001, 'the order counter did not move');
    // The same export imports cleanly afterwards: a failed run poisons nothing.
    const importer = await importerOf(app);
    const retry = await importer.run(source, { tenantId: target.id });
    assert.equal(retry.blocked, false);
    assert.equal(await countOf(app, target.id, 'products'), 40);
    assert.ok(countsBalance(retry.counts));
  });
}

test('F-69: a failure at row 5,000 of an import rolls everything back', { skip: FULL ? false : 'full version: P8_FULL=1 (5,200 products)' }, async (t) => {
  const source = legacyExport({ products: 5200, categories: 5, orders: 20, activity: 50 });
  const app = await sharedWorld();
  const target = await emptyBusiness(app, u('row-5000'));
  const fault = { at: 5000, seen: 0 };
  const importer = (await import('../../../src/modules/migration/index.js')).createMigration({ db: faultyDb(app.db, /INSERT\s+INTO\s+"?products"?\b/i, fault), platform: importerPlatform(app), repos: app.platform, config: app.config });
  const before = await snap(app, target.id);
  const result = await outcome(importer.run(source, { tenantId: target.id }));
  if (fault.seen < 5000) assert.ok(fault.seen > 0, 'the importer batches its product writes: the fault is at its last batch'); // a batch holds many rows
  assert.ok(result.error || fault.seen < 5000, 'the run failed');
  if (result.error) unchanged(before, await snap(app, target.id));
});

test('F-69: hostile rows are refused or cleaned by the product\'s own rules, and a refusal leaves nothing behind', async (t) => {
  const { app, importer } = await twoShops(t);
  const hostile = {
    script: (tables) => { tables.products[1].name = '<script>alert(1)</script>Lamp'; tables.products[1].description = '<img src=x onerror=alert(1)> hello'; },
    oversized: (tables) => { tables.products[2].description = 'x'.repeat(2_000_000); tables.products[2].name = 'n'.repeat(5000); },
    negativePrice: (tables) => { tables.products[3].price_paise = -500; },
    hugePrice: (tables) => { tables.products[3].price_paise = 2 ** 40; },
    mediaPath: (tables) => { tables.media[0].id = '../../etc/passwd'; tables.products[0].images = ['../../etc/passwd', 'file:///etc/passwd', 'javascript:alert(1)']; },
    duplicateSlugs: (tables) => { tables.products[2].slug = tables.products[1].slug; },
    badReferences: (tables) => { tables.order_items[0].order_id = 99999; tables.product_categories[0].category_id = 77777; tables.reel_products[0].product_id = 88888; },
    wrongTypes: (tables) => { tables.products[1].price_paise = 'free'; tables.orders[0].total_paise = null; },
  };
  let n = 0;
  for (const [name, change] of Object.entries(hostile)) {
    const target = await emptyBusiness(app, u(`hostile-${n++}`));
    const before = await snap(app, target.id);
    const result = await outcome(importer.run(altered(legacyExport({ products: 6, orders: 3, reels: 1 }), change), { tenantId: target.id }));
    const refused = Boolean(result.error) || result.report.blocked;
    if (refused) {
      unchanged(before, await snap(app, target.id));
      continue;
    }
    // Cleaned: whatever was written is within the product's own limits.
    const rows = await sql(app, 'SELECT name, description, price_paise, images::text AS images FROM products WHERE tenant_id = $1', [target.id]);
    for (const row of rows) {
      assert.doesNotMatch(`${row.name} ${row.description}`, /<script|onerror=/i, `${name}: no live markup`);
      assert.ok(row.name.length <= 200, `${name}: name length ${row.name.length}`);
      assert.ok(row.description.length <= 20_000, `${name}: description length ${row.description.length}`);
      assert.ok(row.price_paise >= 0 && row.price_paise < 2 ** 31, `${name}: price`);
      assert.doesNotMatch(row.images, /\.\.\/|file:|javascript:/i, `${name}: no path or script in an image`);
    }
    const strays = await sql(app, `SELECT count(*)::int AS n FROM order_items oi LEFT JOIN orders o ON o.tenant_id = oi.tenant_id AND o.id = oi.order_id WHERE oi.tenant_id = $1 AND o.id IS NULL`, [target.id]);
    assert.equal(strays[0].n, 0, `${name}: an item with no order of this business`);
  }
});

// ---- running twice, and at once ------------------------------------------------------------------------------------------------

test('F-69: the same export run twice imports once; the second run writes nothing and says so', async (t) => {
  const { app, a, importer } = await twoShops(t);
  const source = legacyExport({ products: 8, orders: 5 });
  const first = await importer.run(source, { tenantId: a.id });
  assert.equal(first.blocked, false);
  assert.equal(first.alreadyImported, false);
  assert.ok(Number.isInteger(first.runId));
  assert.ok(countsBalance(first.counts));
  const after = await snap(app, a.id);
  const second = await importer.run(source, { tenantId: a.id });
  assert.equal(second.alreadyImported, true);
  unchanged(after, await snap(app, a.id));
  assert.equal((await sql(app, `SELECT count(*)::int AS n FROM migration_runs WHERE tenant_id = $1 AND mode = 'real' AND status = 'done'`, [a.id]))[0].n, 1, 'one finished real run');
  const third = await importer.plan(source, { tenantId: a.id });
  assert.equal(third.alreadyImported, true);
  assert.ok(Object.values(third.counts).every((c) => c.imported === 0), 'a dry run after the import has nothing to write');
});

test('F-69: two imports of the same export at once leave one copy, never two and never a mixture', async (t) => {
  const { app, a, importer } = await twoShops(t);
  const source = legacyExport({ products: 25, orders: 8, activity: 10 });
  const results = await Promise.all([outcome(importer.run(source, { tenantId: a.id })), outcome(importer.run(source, { tenantId: a.id }))]);
  assert.ok(results.some((r) => r.report && !r.report.alreadyImported && !r.report.blocked), 'one of them imported');
  assert.equal(await countOf(app, a.id, 'products'), 25);
  assert.equal(await countOf(app, a.id, 'orders'), 8);
  assert.equal(await countOf(app, a.id, 'order_items'), 16);
  assert.equal((await sql(app, `SELECT count(*)::int AS n FROM migration_runs WHERE tenant_id = $1 AND mode = 'real' AND status = 'done'`, [a.id]))[0].n, 1);
  const map = await sql(app, `SELECT table_name, old_id, count(*)::int AS n FROM migration_id_map WHERE tenant_id = $1 GROUP BY 1, 2 HAVING count(*) > 1`, [a.id]);
  assert.deepEqual(map, [], 'one new id per old id');
});

test('F-69: a part-imported business takes the rest of a bigger export, and what is there is not written twice', async (t) => {
  const { app, a, importer } = await twoShops(t);
  const small = legacyExport({ label: 'part-one', products: 4, orders: 2, categories: 2, reels: 1, activity: 2 });
  await importer.run(small, { tenantId: a.id });
  const bigger = structuredClone(small);
  bigger.label = 'part-two';
  const extra = legacyExport({ products: 9, orders: 2, categories: 2, reels: 1, activity: 2 });
  bigger.tables.products = extra.tables.products;
  bigger.tables.product_categories = extra.tables.product_categories;
  bigger.tables.reel_products = extra.tables.reel_products;
  const report = await importer.run(bigger, { tenantId: a.id });
  assert.equal(report.blocked, false, JSON.stringify(report.conflicts));
  assert.equal(report.counts.products.skipped, 4, 'the four already imported are skipped');
  assert.equal(report.counts.products.imported, 5);
  assert.equal(await countOf(app, a.id, 'products'), 9);
  assert.ok(countsBalance(report.counts));
});

// ---- other businesses ----------------------------------------------------------------------------------------------------------

test('F-69: source ids that equal another business\'s ids overwrite nothing of theirs, and every new row carries the target\'s id', async (t) => {
  const { app, a, b, importer } = await twoShops(t);
  const theirs = bindTenant(app.platform, b.tenant);
  for (let i = 1; i <= 6; i++) await theirs.products.create({ name: `Neighbour product ${i}`, slug: `neighbour-${i}`, price: '100', active: 'on' });
  await theirs.categories?.create?.({ name: 'Neighbour category', slug: 'neighbour-cat' }).catch?.(() => {});
  const mine = await snap(app, b.tenant.id);
  const source = legacyExport({ products: 6, orders: 4, categories: 3 });
  const report = await importer.run(source, { tenantId: a.id });
  assert.equal(report.blocked, false);
  unchanged(mine, await snap(app, b.tenant.id));
  for (const table of IMPORTED_TABLES) {
    const stray = await sql(app, `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id NOT IN ($1, $2)`, [a.id, b.tenant.id]);
    assert.equal(stray[0].n, 0, `${table}: no row for a third business`);
  }
  const names = await sql(app, `SELECT name FROM products WHERE tenant_id = $1 AND name LIKE 'Neighbour%'`, [a.id]);
  assert.deepEqual(names, [], 'nothing of the neighbour was copied');
  const crossed = await sql(app, `SELECT count(*)::int AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.tenant_id <> o.tenant_id`);
  assert.equal(crossed[0].n, 0, 'no item points at another business\'s order');
});

test('F-69: a public token or an order number that is already taken blocks the import and writes nothing', async (t) => {
  const { app, a, b, importer } = await twoShops(t);
  const theirs = bindTenant(app.platform, b.tenant);
  const product = await theirs.products.create({ name: 'Theirs', price: '100', active: 'on' });
  const order = await addOrder({ ...b, repos: theirs }, product);
  const [row] = await sql(app, 'SELECT public_token FROM orders WHERE id = $1', [order.id]);
  const source = legacyExport({ orders: 3 });
  source.tables.orders[1].public_token = row.public_token;
  const before = await snap(app, a.id);
  const theirsBefore = await snap(app, b.tenant.id);
  const dry = await importer.plan(source, { tenantId: a.id });
  assert.ok(dry.conflicts.some((c) => c.kind === 'public_token_taken' && c.blocking && c.table === 'orders'), JSON.stringify(dry.conflicts));
  const real = await outcome(importer.run(source, { tenantId: a.id }));
  assert.ok(real.error || real.report.blocked);
  unchanged(before, await snap(app, a.id));
  unchanged(theirsBefore, await snap(app, b.tenant.id));

  // An order number the target already uses.
  const mine = bindTenant(app.platform, a.tenant);
  const own = await addOrder({ ...a, repos: mine }, await mine.products.create({ name: 'Mine', price: '100', active: 'on' }));
  const [{ order_number: taken }] = await sql(app, 'SELECT order_number FROM orders WHERE id = $1', [own.id]);
  const clash = legacyExport({ orders: 2 });
  clash.tables.orders[0].order_number = String(taken);
  const report = await importer.plan(clash, { tenantId: a.id });
  assert.ok(report.conflicts.some((c) => c.kind === 'order_number_taken' && c.blocking), JSON.stringify(report.conflicts));
});

test('F-69: the importer refuses a business that does not exist, and never writes into the business named by a row', async (t) => {
  const { app, importer } = await twoShops(t);
  const ghost = await outcome(importer.run(legacyExport(), { tenantId: 987654 }));
  assert.ok(ghost.error || ghost.report.blocked, 'no such business');
  const tricky = altered(legacyExport({ products: 3 }), (tables) => { for (const row of tables.products) row.tenant_id = 1; tables.users[0].tenant_id = 1; });
  const target = await emptyBusiness(app, u('tricky'));
  const other = await snap(app, 1);
  await outcome(importer.run(tricky, { tenantId: target.id }));
  unchanged(other, await snap(app, 1));
});

// ---- F-70 ----------------------------------------------------------------------------------------------------------------------

test('F-70: the first new order after an import whose highest order number is 4210 is numbered 4211', async (t) => {
  const { app, a, b, importer } = await twoShops(t);
  const source = legacyExport({ orders: 5, highestOrder: 4210 });
  // The highest number is not the last row and not the first.
  const [x, y, z] = [source.tables.orders[2], source.tables.orders[4], source.tables.orders[0]];
  source.tables.orders[2] = y; source.tables.orders[4] = x; source.tables.orders[0] = z;
  const dry = await importer.plan(source, { tenantId: a.id });
  assert.equal(dry.nextOrderNumber, 4211, 'the dry run already says it');
  const report = await importer.run(source, { tenantId: a.id });
  assert.equal(report.nextOrderNumber, 4211);
  assert.equal((await sql(app, 'SELECT next_order_number FROM tenants WHERE id = $1', [a.id]))[0].next_order_number, 4211);
  const owner = { phone: '9000000099', password: 'owner-pass-1' };
  const mine = bindTenant(app.platform, a.tenant);
  await mine.users.ensureOwner(owner);
  const host = `${a.slug}.shops.example`;
  const business = { ...a, repos: mine, host, owner };
  const product = await addProduct(business, 'First after the import');
  const first = await addOrder(business, product);
  const second = await addOrder(business, product);
  const token = await signIn(app, business, owner);
  const number = async (order) => need(await api(app, business, token, `/orders/${order.id}`), 200, 'Read an order').json().orderNumber;
  assert.match(String(await number(first)), /(^|\D)4211$/);
  assert.match(String(await number(second)), /(^|\D)4212$/);
  // The neighbour is untouched: its own count starts where it always starts.
  const theirs = bindTenant(app.platform, b.tenant);
  const theirOrder = await addOrder({ ...b, repos: theirs }, await addProduct({ ...b, repos: theirs }, 'Neighbour item'));
  const [{ order_number: neighbours }] = await sql(app, 'SELECT order_number FROM orders WHERE id = $1', [theirOrder.id]);
  assert.match(String(neighbours), /(^|\D)1001$/);
});

test('F-70: the counter never moves back, and an export with no orders leaves it where it is', async (t) => {
  const { app, a, importer } = await twoShops(t);
  await sql(app, 'UPDATE tenants SET next_order_number = 9000 WHERE id = $1', [a.id]);
  const report = await importer.run(legacyExport({ orders: 3, highestOrder: 4210 }), { tenantId: a.id });
  assert.equal((await sql(app, 'SELECT next_order_number FROM tenants WHERE id = $1', [a.id]))[0].next_order_number, 9000);
  assert.ok(report.nextOrderNumber === null || report.nextOrderNumber >= 4211);
  const none = await emptyBusiness(app, u('no-orders'));
  const empty = altered(legacyExport({ orders: 1 }), (tables) => { tables.orders = []; tables.order_items = []; });
  await importer.run(empty, { tenantId: none.id });
  assert.equal((await sql(app, 'SELECT next_order_number FROM tenants WHERE id = $1', [none.id]))[0].next_order_number, 1001);
});

// ---- F-71 ----------------------------------------------------------------------------------------------------------------------

test('F-71: migrated activity holds no usernames and no comment text, anywhere in the business, its run record or the logs', async (t) => {
  const { app, a, importer } = await twoShops(t);
  const logs = captureLogs(t);
  const source = legacyExport({ activity: 12, orders: 3 });
  await importer.plan(source, { tenantId: a.id });
  const report = await importer.run(source, { tenantId: a.id });
  assert.equal(report.blocked, false);
  assert.equal(await countOf(app, a.id, 'activity'), 12, 'the rows are kept: only the words are stripped');
  assert.equal(await countOf(app, a.id, 'visits'), 12);
  const needles = [...Array.from({ length: 12 }, (_, i) => MARKERS.username(i)), ...Array.from({ length: 12 }, (_, i) => MARKERS.comment(i)), 'demo_old_user', 'zz-old-comment'];
  assert.deepEqual(await whereFound(app, a.id, needles), [], 'no username or comment text in any table of the business');
  const runs = await sql(app, 'SELECT source, counts::text AS counts, conflicts::text AS conflicts, error FROM migration_runs WHERE tenant_id = $1', [a.id]);
  const map = await sql(app, 'SELECT old_id, new_id FROM migration_id_map WHERE tenant_id = $1', [a.id]);
  const everything = JSON.stringify([runs, map, report]) + logs.text();
  for (const needle of needles) assert.equal(everything.includes(needle), false, `${needle} leaked into a run record, the id map, the report or a log`);
  const audit = await sql(app, `SELECT (a::text) AS t FROM audit_log a WHERE tenant_id = $1`, [a.id]);
  assert.equal(JSON.stringify(audit).includes('zz-old-comment'), false);
});

test('F-71: a failed import leaves no username or comment in its error, its record or the logs either', async (t) => {
  const app = await sharedWorld();
  const logs = captureLogs(t);
  const source = legacyExport({ activity: 6 });
  const fault = { at: 2, seen: 0 };
  const target = await emptyBusiness(app, u('leaky'));
  const importer = (await import('../../../src/modules/migration/index.js')).createMigration({ db: faultyDb(app.db, /INSERT\s+INTO\s+"?(activity|visits)"?\b/i, fault), repos: app.platform, config: app.config });
  const result = await outcome(importer.run(source, { tenantId: target.id }));
  const record = await sql(app, 'SELECT error, conflicts::text AS c FROM migration_runs WHERE tenant_id = $1', [target.id]);
  const text = JSON.stringify([record, String(result.error?.message ?? ''), logs.text()]);
  assert.doesNotMatch(text, /demo_old_user|zz-old-comment/);
});

test('F-71: shopper password hashes, Instagram tokens and the old owner are not copied', async (t) => {
  const { app, a, importer } = await twoShops(t);
  await importer.run(legacyExport({ orders: 3 }), { tenantId: a.id });
  assert.deepEqual(await whereFound(app, a.id, [MARKERS.igToken, MARKERS.accessToken, MARKERS.passwordHash, 'zzoldpasswordhash']), []);
  const keys = await sql(app, `SELECT key FROM settings WHERE tenant_id = $1 AND key IN ('ig_token', 'access_token')`, [a.id]);
  assert.deepEqual(keys, [], 'the settings of the old app that hold tokens');
  const admins = await sql(app, `SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND role IN ('admin', 'owner')`, [a.id]);
  assert.equal(admins[0].n, 0, 'the old owner is re-invited, not copied');
  const hashes = await sql(app, `SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND password_hash <> '' AND password_hash IS NOT NULL`, [a.id]).catch(() => [{ n: 0 }]);
  assert.equal(hashes[0].n, 0);
});

test('F-71: slugs, order numbers, public tokens and media are kept; ids are remapped', async (t) => {
  const { app, a, importer } = await twoShops(t);
  const source = legacyExport({ products: 5, orders: 3, categories: 2 });
  await importer.run(source, { tenantId: a.id });
  const slugs = (await sql(app, 'SELECT slug FROM products WHERE tenant_id = $1 ORDER BY slug', [a.id])).map((r) => r.slug);
  assert.deepEqual(slugs, source.tables.products.map((p) => p.slug).sort());
  const tokens = (await sql(app, 'SELECT public_token FROM orders WHERE tenant_id = $1 ORDER BY 1', [a.id])).map((r) => r.public_token);
  assert.deepEqual(tokens, source.tables.orders.map((o) => o.public_token).sort());
  const numbers = (await sql(app, 'SELECT order_number FROM orders WHERE tenant_id = $1 ORDER BY 1', [a.id])).map((r) => String(r.order_number).replace(/\D/g, ''));
  assert.deepEqual(numbers, source.tables.orders.map((o) => o.order_number).sort());
  assert.ok((await countOf(app, a.id, 'media')) >= 1, 'media carried across');
  const ids = await sql(app, `SELECT old_id, new_id FROM migration_id_map WHERE tenant_id = $1 AND table_name = 'products'`, [a.id]);
  assert.equal(ids.length, 5, 'every product is in the id map');
  const reachable = await sql(app, 'SELECT count(*)::int AS n FROM order_items oi JOIN products p ON p.tenant_id = oi.tenant_id AND p.id = oi.product_id WHERE oi.tenant_id = $1', [a.id]);
  assert.ok(reachable[0].n > 0, 'items point at the remapped products');
});

// ---- F-73 ----------------------------------------------------------------------------------------------------------------------

async function reelWorld(t) {
  const app = await sharedWorld();
  const importer = await importerOf(app);
  const holder = await addBusiness(app, { slug: u('holder'), name: 'Holder' });
  const igId = `9000${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
  await app.platform.tenants.linkIgAccount(holder.tenant.id, igId, `demo_holder_${igId.slice(-4)}`);
  const holderRepos = bindTenant(app.platform, holder.tenant);
  await holderRepos.reels.save(`9000${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`, { headline: 'Theirs', keywords: 'LINK', productIds: [], active: 'on' });
  const incoming = await emptyBusiness(app, u('incoming-reels'));
  const source = legacyExport({ products: 4, reels: 3, orders: 2, igUserId: igId });
  return { app, importer, holder, incoming, source };
}

test('F-73: reels of the old shop posted on another business\'s Instagram account block the import until the operator chooses', async (t) => {
  const { app, importer, holder, incoming, source } = await reelWorld(t);
  const before = await snap(app, incoming.id);
  const holderBefore = await snap(app, holder.tenant.id);
  const dry = await importer.plan(source, { tenantId: incoming.id });
  const clashes = dry.conflicts.filter((c) => c.kind === 'reel_on_other_account');
  assert.equal(clashes.length, 3, 'one conflict per reel');
  assert.ok(clashes.every((c) => c.blocking && c.table === 'reels'));
  assert.equal(dry.blocked, true);
  const real = await outcome(importer.run(source, { tenantId: incoming.id }));
  assert.ok(real.error || real.report.blocked, 'blocked until the operator chooses');
  unchanged(before, await snap(app, incoming.id));
  unchanged(holderBefore, await snap(app, holder.tenant.id));
  for (const table of ['products', 'orders']) assert.equal(await countOf(app, incoming.id, table), 0, `${table}: nothing written while blocked`);
});

test('F-73: choosing drop imports everything but those reels; choosing reassign brings them in under the new business', async (t) => {
  const { app, importer, holder, incoming, source } = await reelWorld(t);
  const holderBefore = await snap(app, holder.tenant.id);
  const dropped = await importer.run(source, { tenantId: incoming.id, reels: 'drop' });
  assert.equal(dropped.blocked, false, JSON.stringify(dropped.conflicts));
  assert.equal(dropped.counts.reels.imported, 0);
  assert.equal(dropped.counts.reels.skipped, 3);
  assert.equal(await countOf(app, incoming.id, 'reels'), 0);
  assert.equal(await countOf(app, incoming.id, 'products'), 4, 'the rest came across');
  assert.ok(countsBalance(dropped.counts));
  unchanged(holderBefore, await snap(app, holder.tenant.id));

  const second = await emptyBusiness(app, u('incoming-reassign'));
  const reassigned = await importer.run(altered(source, () => {}), { tenantId: second.id, reels: 'reassign' });
  assert.equal(reassigned.blocked, false, JSON.stringify(reassigned.conflicts));
  assert.equal(await countOf(app, second.id, 'reels'), 3);
  const owned = await sql(app, `SELECT count(*)::int AS n FROM reels WHERE tenant_id = $1`, [second.id]);
  assert.equal(owned[0].n, 3);
  unchanged(holderBefore, await snap(app, holder.tenant.id));
  const theirs = await sql(app, `SELECT headline FROM reels WHERE tenant_id = $1`, [holder.tenant.id]);
  assert.deepEqual(theirs.map((r) => r.headline), ['Theirs'], 'the holder keeps exactly its own reel');
});

test('F-73: a choice that is not drop or reassign is refused, and reels that are not on another account never block', async (t) => {
  const { app, importer, incoming, source } = await reelWorld(t);
  const bad = await outcome(importer.run(source, { tenantId: incoming.id, reels: 'keep' }));
  assert.ok(bad.error || bad.report.blocked);
  assert.equal(await countOf(app, incoming.id, 'products'), 0);
  const quiet = await emptyBusiness(app, u('quiet'));
  const own = legacyExport({ products: 3, reels: 2, igUserId: `9000${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}` });
  const report = await importer.plan(own, { tenantId: quiet.id });
  assert.equal(report.conflicts.filter((c) => c.kind === 'reel_on_other_account').length, 0);
  assert.equal(report.blocked, false);
});

// ---- F-72 ----------------------------------------------------------------------------------------------------------------------

test('F-72: a migrated shopper signs in with a code on the same phone and sees their old orders, and nobody else\'s', async (t) => {
  const w = await shopperWorld({ google: false });
  t.after(() => w.close());
  const shop = await w.addStore('migrated', 'Migrated Shop');
  const other = await w.addStore('elsewhere', 'Elsewhere Shop');
  const importer = await importerOf(w.app);
  const source = legacyExport({ orders: 3, highestOrder: 4210 });
  // Two shoppers; the old app held one phone with the country code and one without.
  source.tables.orders[0].phone = '+919000000041';
  source.tables.orders[1].phone = '+919000000041';
  source.tables.orders[2].phone = '9000000042';
  source.tables.users[0].phone = '+919000000041';
  source.tables.users[2].phone = '9000000042';
  const report = await importer.run(source, { tenantId: shop.tenant.id });
  assert.equal(report.blocked, false);
  const mine = source.tables.orders.slice(0, 2).map((o) => o.order_number);
  const hers = source.tables.orders[2].order_number;

  const signedIn = async (host, phone) => {
    const b = browser(w.app, { host });
    await b.request('/api/store/otp/send', { method: 'POST', json: { phone, purpose: 'sign_in' } });
    const code = await w.lastCode(phone);
    const res = await b.request('/api/store/otp/verify', { method: 'POST', json: { phone, purpose: 'sign_in', code } });
    assert.equal(res.status, 200, `sign-in at ${host}`);
    return b;
  };
  const pageOf = async (b) => {
    const res = await b.request('/account/orders');
    assert.equal(res.status, 200);
    return res.text();
  };
  const first = await pageOf(await signedIn(`${shop.tenant.slug}.bhava.test`, '9000000041'));
  for (const number of mine) assert.ok(first.includes(number), `order ${number} is listed`);
  assert.equal(first.includes(hers), false, 'another shopper\'s order is not listed');
  const second = await pageOf(await signedIn(`${shop.tenant.slug}.bhava.test`, '9000000042'));
  assert.ok(second.includes(hers));
  for (const number of mine) assert.equal(second.includes(number), false);

  // The same phone at another business sees none of it.
  const elsewhere = await pageOf(await signedIn(`${other.tenant.slug}.bhava.test`, '9000000041'));
  for (const number of [...mine, hers]) assert.equal(elsewhere.includes(number), false, 'orders do not cross to another business');

  // A number that never ordered sees nothing, and the old password does not work.
  const stranger = await pageOf(await signedIn(`${shop.tenant.slug}.bhava.test`, '9000000077'));
  for (const number of [...mine, hers]) assert.equal(stranger.includes(number), false);
  const b = browser(w.app, { host: `${shop.tenant.slug}.bhava.test` });
  const tried = await b.request('/login', { method: 'POST', form: { phone: '9000000041', password: MARKERS.passwordHash } });
  assert.ok(tried.status >= 400 || !b.cookies().get('_sid'), 'the old password hash is no way in');
});

test('F-72: an order the shopper opens by its old public token still works on the same address', async (t) => {
  const { app, a, b, importer } = await twoShops(t);
  const source = legacyExport({ orders: 2 });
  await importer.run(source, { tenantId: a.id });
  const token = source.tables.orders[0].public_token;
  const host = `${a.slug}.shops.example`;
  const res = await hit(app, `/order/${token}`, { host });
  assert.ok(res.status === 200 || res.status === 302 || res.status === 303, `the old order link answers ${res.status}`);
  const wrongHost = await hit(app, `/order/${token}`, { host: `${b.slug}.shops.example` });
  assert.ok(wrongHost.status === 404 || wrongHost.status === 410, `another business's address does not open it (${wrongHost.status})`);
});

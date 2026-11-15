// An export of one of our own old apps is trusted no more than a form: hostile or broken content is refused or cleaned by
// the product's own validators, and a refusal names the table, the old id and the field, never the value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_ID, legacyExport, order, snapshot, world } from './support.js';

const reason = 'Moving the old shop onto the platform';

/** Runs a real import of `source` and expects a refusal naming `field`; the target is left exactly as it was. */
async function refused(w, source, field) {
  const before = await snapshot(w, w.target.id);
  await assert.rejects(w.importer().plan(source, { tenantId: w.target.id }), (err) => err.code === 'validation_failed' && field in err.fields, `plan refuses ${field}`);
  await assert.rejects(w.importer().run(source, { tenantId: w.target.id }, { reason }), (err) => {
    assert.equal(err.code, 'validation_failed');
    assert.deepEqual(Object.keys(err.fields), [field]);
    return true;
  });
  assert.deepEqual(await snapshot(w, w.target.id), before);
  assert.equal(w.files.size, 0);
  const [run] = await w.q('SELECT status, error FROM migration_runs WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [w.target.id]);
  assert.deepEqual([run.status, run.error], ['failed', `refused:${field}`]);
}

const withProduct = async (over) => {
  const source = await legacyExport();
  Object.assign(source.tables.products[1], over);
  return source;
};

test('script in product text is cleaned the way the product cleans imported text; nothing of it is stored', async () => {
  const w = await world();
  const source = await withProduct({ name: '<script>alert(1)</script>Clay <b>diya</b>', description: '<img src=x onerror=alert(1)>Fired by hand<script>steal()</script>' });
  source.tables.categories[1].name = '<b onclick="steal()">Diyas</b>';
  await w.importer().run(source, { tenantId: w.target.id }, { reason });
  const [p] = await w.q(`SELECT name, description FROM products WHERE tenant_id = $1 AND slug = 'clay-diya'`, [w.target.id]);
  assert.equal(p.name, 'Clay diya');
  assert.equal(p.description, 'Fired by hand');
  const [c] = await w.q(`SELECT name FROM categories WHERE tenant_id = $1 AND slug = 'diyas'`, [w.target.id]);
  assert.equal(c.name, 'Diyas');

  // A name that is nothing but markup cleans to nothing, which the category's own rule refuses.
  const empty = await legacyExport();
  empty.tables.categories[1].name = '<svg onload=alert(1)>Diyas';
  await refused(await world(), empty, 'categories.2.name');
});

test('oversized fields are refused: a name past the product’s limit, and any value past the export’s', async () => {
  await refused(await world(), await withProduct({ name: 'Lamp '.repeat(400) }), 'products.2.product');
  await refused(await world(), await withProduct({ description: 'x'.repeat(100_001) }), 'products.2.description');
  const w = await world();
  const source = await legacyExport();
  source.tables.reels[0].button_text = 'Tap here to see every single product';
  await refused(w, source, 'reels.17900000000000001.reel');
});

test('negative, fractional and huge prices are refused, and an order whose total does not add up', async () => {
  await refused(await world(), await withProduct({ price_paise: -100 }), 'products.2.price_paise');
  await refused(await world(), await withProduct({ price_paise: 12.5 }), 'products.2.price_paise');
  await refused(await world(), await withProduct({ price_paise: 1e15 }), 'products.2.price_paise');
  await refused(await world(), await withProduct({ price_paise: 5000, mrp_paise: 4000 }), 'products.2.product');
  const source = await legacyExport();
  source.tables.orders[0].total_paise = 1;
  await refused(await world(), source, 'orders.1.total_paise');
  const qty = await legacyExport();
  qty.tables.order_items[0].qty = -3;
  await refused(await world(), qty, 'order_items.1.qty');
});

test('a path in a media id or a picture link is refused; a media name is never used for anything', async () => {
  const badId = await legacyExport();
  badId.tables.media[0].id = '../../etc/passwd';
  await refused(await world(), badId, 'media.#0.id');
  const badLink = await withProduct({ images: ['/media/../../secret'] });
  await refused(await world(), badLink, 'products.2.images');
  const script = await withProduct({ images: ['javascript:alert(1)'] });
  await refused(await world(), script, 'products.2.images');

  const w = await world();
  const named = await legacyExport();
  named.tables.media[0].name = '../../../../app/.env';
  named.tables.media[0].storage_key = '../t/1/media/evil';
  await w.importer().run(named, { tenantId: w.target.id }, { reason });
  const [media] = await w.q('SELECT id, storage_key FROM media WHERE tenant_id = $1', [w.target.id]);
  assert.equal(media.storage_key, `t/${w.target.id}/media/${media.id}`);
  assert.deepEqual([...w.files.keys()], [media.storage_key]);
});

test('media that is not an image the product can use is refused, whatever type the old row claims', async () => {
  const svg = await legacyExport();
  svg.tables.media[0].mime = 'image/png';
  svg.tables.media[0].data = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
  await refused(await world(), svg, `media.${MEDIA_ID}.data`);
  const junk = await legacyExport();
  junk.tables.media[0].data = 'not base64 at all!';
  await refused(await world(), junk, `media.${MEDIA_ID}.data`);
});

test('broken foreign keys are skipped as orphan rows, or the link is dropped; nothing points outside the business', async () => {
  const w = await world();
  const source = await legacyExport();
  source.tables.order_items.push({ id: 9, order_id: 999, product_id: 1, name: 'Ghost', price_paise: 100, qty: 1 });
  source.tables.product_categories.push({ product_id: 1, category_id: 77 });
  source.tables.reel_products.push({ reel_id: '17999999999999999', product_id: 1, position: 2 });
  source.tables.visits.push({ id: 9, reel_id: '17999999999999999', source: 'ig' });
  // An order of an old product that no longer exists keeps its line, without the product.
  source.tables.order_items[1].product_id = w.neighbourProduct.id + 500;
  const report = await w.importer().run(source, { tenantId: w.target.id }, { reason });
  const orphans = report.conflicts.filter((c) => c.kind === 'orphan_row').map((c) => `${c.table}:${c.oldId}`).sort();
  assert.deepEqual(orphans, ['order_items:2', 'order_items:9', 'product_categories:1:77', 'reel_products:17999999999999999:1', 'visits:9']);
  assert.ok(report.conflicts.every((c) => !c.blocking));
  assert.deepEqual(report.counts.order_items, { source: 5, imported: 4, skipped: 1 });
  const [line] = await w.q(`SELECT product_id FROM order_items WHERE tenant_id = $1 AND name = 'Clay diya' AND qty = 2`, [w.target.id]);
  assert.equal(line.product_id, null);
});

test('duplicate slugs, order numbers and tokens are blocking conflicts; nothing is written until they are settled', async () => {
  const w = await world();
  const before = await snapshot(w, w.target.id);
  const source = await legacyExport();
  source.tables.products[2].slug = 'brass-lamp';
  source.tables.orders[3].order_number = 'OLH-4208';
  source.tables.orders[2].public_token = source.tables.orders[1].public_token;
  const report = await w.importer().run(source, { tenantId: w.target.id }, { reason });
  assert.equal(report.blocked, true);
  assert.deepEqual(report.conflicts.filter((c) => c.blocking).map((c) => `${c.kind}:${c.table}:${c.oldId}`).sort(), ['order_number_taken:orders:4', 'public_token_taken:orders:3', 'slug_taken:products:3']);
  assert.deepEqual(await snapshot(w, w.target.id), before);

  // A slug the business already uses, and a token another business's order holds.
  const w2 = await world();
  await w2.inTarget(() => w2.targetRepos.products.create({ name: 'Brass lamp', price: '100', active: 'on' }));
  const clash = await legacyExport();
  const [theirs] = await w2.q(`INSERT INTO orders (tenant_id, order_number, public_token, customer_name, phone, address, city, state, pincode, subtotal_paise, shipping_paise, total_paise)
    VALUES ($1, 'N-1', $2, 'Ira Mehra', '9000000210', '4 Hill Road', 'Pune', 'Maharashtra', '411007', 100, 0, 100) RETURNING public_token`, [w2.neighbour.id, clash.tables.orders[0].public_token]);
  const second = await w2.importer().plan(clash, { tenantId: w2.target.id });
  assert.deepEqual(second.conflicts.filter((c) => c.blocking).map((c) => `${c.kind}:${c.oldId}`).sort(), ['public_token_taken:1', 'slug_taken:1']);
  assert.ok(theirs.public_token);
});

test('an unknown table blocks; a row cannot bring its own business id or prototype', async () => {
  const w = await world();
  const unknown = await legacyExport({ extra: { payouts: [{ id: 1, account: '0001' }] } });
  const report = await w.importer().plan(unknown, { tenantId: w.target.id });
  assert.deepEqual(report.conflicts.filter((c) => c.blocking).map((c) => [c.kind, c.table]), [['unknown_table', 'payouts']]);
  assert.deepEqual(report.counts.payouts, { source: 1, imported: 0, skipped: 1 });

  const sneaky = await legacyExport();
  sneaky.tables.products[0].tenant_id = w.neighbour.id;
  sneaky.tables.orders[0].tenant_id = w.neighbour.id;
  sneaky.tables.products.push(JSON.parse(`{"id": 4, "__proto__": {"slug": "x", "name": "Inherited", "price_paise": 1}, "name": "Copper bell", "slug": "copper-bell", "price_paise": 100}`));
  const neighbourBefore = await snapshot(w, w.neighbour.id);
  await w.importer().run(sneaky, { tenantId: w.target.id }, { reason });
  assert.deepEqual(await snapshot(w, w.neighbour.id), neighbourBefore);
  const [bell] = await w.q(`SELECT tenant_id, name FROM products WHERE slug = 'copper-bell'`);
  assert.deepEqual([bell.tenant_id, bell.name], [w.target.id, 'Copper bell']);
});

test('a customer number that is no mobile number is refused; two old accounts on one number become one shopper', async () => {
  const bad = await legacyExport();
  bad.tables.users[0].phone = '12345';
  await refused(await world(), bad, 'users.1.phone');

  const w = await world();
  const twice = await legacyExport({ phones: ['9000000201', '+91 90000 00201'] });
  const report = await w.importer().run(twice, { tenantId: w.target.id }, { reason });
  assert.deepEqual(report.conflicts.filter((c) => c.kind === 'duplicate_phone').map((c) => c.oldId), ['2']);
  assert.deepEqual(report.counts.users, { source: 3, imported: 1, skipped: 2 });
  const shoppers = await w.q('SELECT id FROM shoppers WHERE tenant_id = $1', [w.target.id]);
  assert.equal(shoppers.length, 1);
  const linked = await w.q('SELECT DISTINCT shopper_id FROM orders WHERE tenant_id = $1 AND shopper_id IS NOT NULL', [w.target.id]);
  assert.deepEqual(linked.map((o) => o.shopper_id), [shoppers[0].id]);
  void order;
});

// The Shopify public feed import (PRD 8.5): a store's whole catalogue with no keys, re-imports that update instead of
// duplicating and leave the owner's edits alone, and products that left the store archived into Needs attention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE, RUN } from '../../../src/modules/imports/index.js';
import { STORE, fillStore, openWorld } from './support.js';

const change = (shopify, method, body) => fetch(`${shopify.url}/__sim/storefront/products`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const feedOf = async (shopify) => (await (await fetch(`${shopify.url}/products.json?limit=250`)).json()).products;
const paise = (rupees) => Math.round(Number(rupees) * 100);
const importStore = (shop, storeUrl = STORE) => shop.importAndRun('/imports/shopify', { storeUrl });

test('K-15: a store of 312 products imports as 312 products with variants and MRP', { timeout: 420_000 }, async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  await fillStore(world.shopify, 312);
  const queued = await shop.post('/imports/shopify', { storeUrl: `https://${STORE}/collections/all` }, 202);
  assert.deepEqual([queued.kind, queued.status, queued.source], ['shopify', 'queued', STORE]);
  await world.runJobs({ only: [RUN] });
  const job = await shop.job(queued.id);
  assert.deepEqual([job.status, job.total, job.created, job.updated, job.refused, job.failed, job.archived, job.errorCode], ['done', 312, 312, 0, 0, 0, 0, null]);

  const [counts] = await shop.sql(
    `SELECT count(*)::int AS products, count(*) FILTER (WHERE mrp_paise > price_paise)::int AS with_mrp, count(DISTINCT external_url)::int AS urls,
       (SELECT count(*)::int FROM product_variants v WHERE v.tenant_id = $1) AS variants, (SELECT count(*)::int FROM product_options o WHERE o.tenant_id = $1) AS options
     FROM products WHERE tenant_id = $1 AND source = 'shopify'`,
    [shop.tenantId],
  );
  assert.deepEqual(counts, { products: 312, with_mrp: 312, urls: 312, variants: 624, options: 312 });
  const feedPages = (await world.shopify.get('/calls', { path: '/products.json' })).calls ?? [];
  assert.ok(world.sites.dials.filter((d) => d.host === STORE).length <= 4, 'the feed is read page by page, not product by product');
  assert.ok(feedPages.length <= 4);

  // One of them, in full.
  const source = (await feedOf(world.shopify))[10];
  const [row] = await shop.sql('SELECT id FROM products WHERE tenant_id = $1 AND external_url = $2', [shop.tenantId, `https://${STORE}/products/${source.handle}`]);
  const product = await shop.json(`/products/${row.id}`);
  assert.equal(product.name, source.title);
  assert.equal(product.sourceRef, `${STORE}/${source.handle}`);
  assert.deepEqual(product.variants.map((v) => [v.optionValues[0], v.sku, v.pricePaise, v.mrpPaise, v.inStock]), source.variants.map((v) => [v.option1, v.sku, paise(v.price), paise(v.compare_at_price), v.available]));
  const stocked = source.variants.filter((v) => v.available);
  assert.equal(product.display.pricePaise, paise((stocked.length ? stocked : source.variants)[0].price), 'the card shows the lowest in-stock variant');
  assert.deepEqual(product.tags, source.tags, 'tags come along; no category is made from them');
  assert.deepEqual((await shop.json('/categories')).items, []);
  assert.equal(product.description, `${source.title}. Healthy and potted.`, 'the description is text, not markup');
  const [{ n: imageJobs }] = await shop.sql('SELECT count(*)::int AS n FROM jobs WHERE queue = $1 AND tenant_id = $2', [IMAGE, shop.tenantId]);
  assert.equal(imageJobs, 312, 'each first image is copied by its own small job');
});

test('K-16: a re-import keeps the owner’s title, refreshes prices and stock, and makes no duplicates', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  await fillStore(world.shopify, 6);
  const first = await importStore(shop);
  assert.deepEqual([first.status, first.created], ['done', 6]);
  const before = await shop.products();
  const feed = await feedOf(world.shopify);
  const renamed = before.find((p) => p.name === feed[0].title);
  const typed = before.find((p) => p.name === feed[1].title);
  assert.match((await shop.json(`/products/${renamed.id}`)).images[0], /^\/media\//, 'the first image was copied into the business’s media');

  await shop.patch(`/products/${renamed.id}`, { name: 'My own name for it', description: 'My own words' });
  await shop.patch(`/products/${typed.id}`, { pricePaise: 12300 });
  for (const index of [0, 1, 2]) {
    await change(world.shopify, 'PATCH', { handle: feed[index].handle, title: `${feed[index].title} (new)`, variants: [{ price: 11100, compare_at_price: 22200, available: true }, { price: 33300, compare_at_price: null, available: true }] });
  }

  const second = await importStore(shop);
  assert.deepEqual([second.status, second.created, second.updated, second.unchanged, second.archived], ['done', 0, 3, 3, 0]);
  const after = await shop.products();
  assert.equal(after.length, 6, 'no duplicates');

  const kept = await shop.json(`/products/${renamed.id}`);
  assert.deepEqual([kept.name, kept.description], ['My own name for it', 'My own words'], 'the owner’s text is never overwritten');
  assert.deepEqual([kept.pricePaise, kept.mrpPaise, kept.priceChanged, kept.previousPricePaise], [11100, 22200, true, renamed.pricePaise], 'the price is refreshed and flagged');
  assert.deepEqual(kept.variants.map((v) => [v.pricePaise, v.mrpPaise, v.inStock]), [[11100, 22200, true], [33300, null, true]]);
  assert.match(kept.images[0], /^\/media\//, 'and the copied image stays');

  const manual = await shop.json(`/products/${typed.id}`);
  assert.deepEqual([manual.pricePaise, manual.priceManual, manual.priceChanged], [12300, true, false], 'a price the owner typed is never changed by an import');
  assert.equal(manual.name, `${feed[1].title} (new)`, 'text the owner didn’t touch follows the store');
  assert.equal((await shop.json(`/products/${before.find((p) => p.name === feed[2].title).id}`)).name, `${feed[2].title} (new)`);
});

test('a product that left the store is archived into Needs attention, and comes back when the store has it again', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  await fillStore(world.shopify, 4);
  await importStore(shop);
  const feed = await feedOf(world.shopify);
  const gone = feed[3];
  await change(world.shopify, 'DELETE', { handle: gone.handle });

  const second = await importStore(shop);
  assert.deepEqual([second.status, second.unchanged, second.archived], ['done', 3, 1]);
  const attention = await shop.products('status=attention');
  assert.deepEqual(attention.map((p) => [p.name, p.fetchStatus, p.active]), [[gone.title, 'missing', false]]);
  assert.equal((await shop.json('/catalog/settings')).attentionCount, 1);
  const archived = (await shop.items(second.id, 'status=archived'))[0];
  assert.deepEqual([archived.productId, archived.message], [attention[0].id, 'No longer in the store’s product list.']);
  const alerts = await shop.sql(`SELECT kind, message FROM alerts WHERE tenant_id = $1 AND kind = 'catalog.products_missing'`, [shop.tenantId]);
  assert.equal(alerts.length, 1, 'the owner is told once');
  assert.match(alerts[0].message, /^1 product is no longer in your store’s list/);
  const [{ next_check_at: due }] = await shop.sql('SELECT next_check_at FROM products WHERE id = $1', [attention[0].id]);
  assert.equal(due, null, 'an archived product isn’t re-checked');

  await world.shopify.post('/storefront/generate', { count: 4 });
  const third = await importStore(shop);
  assert.deepEqual([third.updated, third.archived], [1, 0]);
  const back = await shop.json(`/products/${attention[0].id}`);
  assert.deepEqual([back.fetchStatus, back.active], ['ok', true]);
  assert.deepEqual(await shop.products('status=attention'), []);
});

test('K-17: when the product list answers 404 or 401, the import fails with what to do instead, and nothing already imported is touched', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  await fillStore(world.shopify, 3);
  await importStore(shop);
  for (const feedStatus of [404, 401]) {
    await world.shopify.post('/storefront', { feedStatus });
    const job = await importStore(shop);
    assert.deepEqual([job.status, job.errorCode, job.total, job.archived], ['failed', 'feed_unavailable', 0, 0], String(feedStatus));
    assert.equal(job.message, 'We couldn’t read this store’s product list. Paste product links or upload a CSV instead.');
  }
  const products = await shop.products();
  assert.deepEqual(products.map((p) => [p.fetchStatus, p.active]), [['ok', true], ['ok', true], ['ok', true]], 'a feed that can’t be read archives nothing');

  for (const storeUrl of ['wrongtype.example', 'https://internal.example', 'gone.example', 'https://shop.example:8080']) {
    const job = await importStore(shop, storeUrl);
    assert.deepEqual([job.status, job.errorCode], ['failed', 'feed_unavailable'], storeUrl);
  }
  for (const storeUrl of ['localhost', 'javascript:alert(1)', 'https://user:pw@plants.example']) {
    assert.equal((await shop.call('/imports/shopify', { method: 'POST', body: { storeUrl } })).status, 400, storeUrl);
  }
  // An empty store is not a reason to archive everything either.
  await world.shopify.post('/storefront', { feedStatus: 200 });
  await world.shopify.post('/storefront/generate', { count: 0 });
  const empty = await importStore(shop);
  assert.deepEqual([empty.status, empty.errorCode, empty.archived], ['failed', 'feed_unavailable', 0]);
  assert.equal((await shop.products('status=attention')).length, 0);
});

test('a product first added by its link is taken over by the feed, not duplicated; two businesses importing one store each get their own', async (t) => {
  const world = await openWorld(t);
  const [a, b] = [await world.addShop(), await world.addShop()];
  await fillStore(world.shopify, 3);
  const feed = await feedOf(world.shopify);
  const pasted = await a.post('/imports/link', { url: `https://${STORE}/products/${feed[0].handle}` }, 200);
  const { productId } = await a.post(`/import-items/${pasted.itemId}/save`, { name: pasted.draft.name, pricePaise: pasted.draft.pricePaise });

  const job = await importStore(a);
  assert.deepEqual([job.created, job.updated + job.unchanged], [2, 1]);
  assert.equal((await a.products()).length, 3);
  const claimed = await a.json(`/products/${productId}`);
  assert.deepEqual([claimed.source, claimed.sourceRef], ['shopify', `${STORE}/${feed[0].handle}`]);

  const theirs = await importStore(b);
  assert.equal(theirs.created, 3);
  await change(world.shopify, 'DELETE', { handle: feed[2].handle });
  await importStore(a);
  assert.equal((await a.products('status=attention')).length, 1);
  assert.equal((await b.products('status=attention')).length, 0, 'A’s re-import archives nothing of B’s');
  const perBusiness = await a.sql(`SELECT tenant_id, count(*)::int AS n FROM products WHERE source = 'shopify' GROUP BY tenant_id ORDER BY tenant_id`);
  assert.deepEqual(perBusiness, [{ tenant_id: a.tenantId, n: 3 }, { tenant_id: b.tenantId, n: 3 }]);
});

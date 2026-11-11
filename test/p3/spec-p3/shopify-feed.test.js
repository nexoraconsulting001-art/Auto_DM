// PRD 8.5: importing a Shopify store's public feed, with no keys. The store is tools/sim/shopify mounted at plants.example;
// its feed is /products.json, page by page until an empty page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_LIMITS, IMPORT_REASONS, addP3Shop, assertNoLiveMarkup, generateStorefrontProducts, importFeed, need, plain, setStorefront, textOf, useP3World } from './kit.js';

const world = useP3World();

const store = (count, options = {}) => generateStorefrontProducts({ count, variants: 2, withMrp: true, ...options });
const count = async (shop, table, where = 'true') => (await shop.sql(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND (${where})`, [shop.tenantId]))[0].n;
const byUrl = async (shop, handle) => (await shop.sql('SELECT * FROM products WHERE tenant_id = $1 AND external_url = $2', [shop.tenantId, `https://plants.example/products/${handle}`]))[0];
const variantsOf = (shop, productId) => shop.sql('SELECT * FROM product_variants WHERE tenant_id = $1 AND product_id = $2 ORDER BY position, id', [shop.tenantId, productId]);

// ---- K-15 ------------------------------------------------------------------------------------------------------------------

test('K-15: importing a store of 312 products gives 312 products with their variants and MRP', { timeout: 600_000 }, async () => {
  const shop = await addP3Shop(world);
  const products = store(312);
  await setStorefront(world, products);
  await world.shopify.delete('/calls');
  const job = await importFeed(shop);
  assert.equal(job.status, 'done', `The import ended ${job.status}: ${job.message}`);
  assert.equal(job.kind, 'shopify');
  assert.equal(job.total, 312);
  assert.equal(job.created, 312);
  assert.equal(job.refused + job.failed, 0);
  assert.equal(await count(shop, 'products'), 312, '312 products');
  assert.equal(await count(shop, 'product_variants'), 624, 'Two variants each');
  assert.equal(await count(shop, 'product_variants', 'mrp_paise IS NOT NULL AND mrp_paise > price_paise'), 624, 'Every variant has its MRP');
  assert.equal(await count(shop, 'products', `source = 'shopify'`), 312);
  assert.equal((await shop.sql('SELECT count(DISTINCT external_url)::int AS n FROM products WHERE tenant_id = $1', [shop.tenantId]))[0].n, 312, 'Each has its own address');

  for (const p of [products[0], products[156], products[311]]) {
    const row = await byUrl(shop, p.handle);
    assert.ok(row, `${p.handle} was imported`);
    assert.equal(row.name, p.title);
    assert.equal(row.source_ref, p.handle, 'The handle is the source reference');
    assert.equal(row.in_stock, p.variants.some((v) => v.available), 'available maps to in_stock');
    const variants = await variantsOf(shop, row.id);
    assert.deepEqual(variants.map((v) => [Number(v.price_paise), Number(v.mrp_paise), v.in_stock, v.sku]), p.variants.map((v) => [v.price, v.compare_at_price, v.available, v.sku]));
    const detail = await shop.getProduct(row.id);
    assert.deepEqual(detail.options, [{ name: 'Size', values: ['Small', 'Medium'] }]);
    const inStock = p.variants.filter((v) => v.available);
    const best = (inStock.length ? inStock : p.variants).reduce((a, b) => (b.price < a.price ? b : a));
    assert.equal(detail.display.pricePaise, best.price);
  }

  const feed = (await world.shopify.calls()).filter((c) => c.path === '/products.json');
  const pages = feed.map((c) => Number(c.query.page ?? 1));
  assert.ok(feed.length >= 2, `The feed was read page by page: ${feed.length} request(s)`);
  assert.ok(feed.every((c) => Number(c.query.limit ?? 30) <= CATALOG_LIMITS.shopifyPageSize), 'No page asks for more than 250');
  const perPage = Number(feed[0].query.limit ?? 30);
  assert.ok(Math.max(...pages) <= Math.ceil(312 / perPage) + 1, `Pages read: ${pages.join(', ')}`);
  const items = await shop.items(job.id);
  assert.equal(items.length, 312, 'One report line per product');
  assert.ok(items.some((i) => i.draft?.suggestedCategories?.includes('indoor')), 'Tags are suggested as categories');
  assert.equal(await count(shop, 'categories'), 0, 'A suggestion creates no category on its own');
});

test('K-15: the same store imported twice at the same moment, and by two businesses, makes no duplicates and no shared rows', async () => {
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  await setStorefront(world, store(20));
  const started = await Promise.all([
    a.send('POST', '/imports/shopify', { storeUrl: 'https://plants.example' }),
    a.send('POST', '/imports/shopify', { storeUrl: 'https://plants.example/' }),
    b.send('POST', '/imports/shopify', { storeUrl: 'https://www.plants.example' }),
  ]);
  for (const res of started) assert.ok([202, 409].includes(res.status), `Starting an import answered ${res.status}: ${res.text.slice(0, 200)}`);
  for (const [shop, res] of [[a, started[0]], [a, started[1]], [b, started[2]]]) if (res.status === 202) assert.ok(['done', 'failed'].includes((await shop.job(res.json().id)).status));
  assert.equal(await count(a, 'products'), 20, 'A has each product once');
  assert.equal(await count(a, 'product_variants'), 40);
  assert.equal(await count(b, 'products'), 20, 'B has its own 20');
  const shared = await a.sql('SELECT count(*)::int AS n FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.tenant_id <> p.tenant_id');
  assert.equal(shared[0].n, 0, 'No variant belongs to another business\'s product');
});

test('K-15: script in a store\'s titles, formula-like text and odd prices are stored as text and whole paise', async () => {
  const shop = await addP3Shop(world);
  const products = store(6);
  products[0].title = '<script>alert(1)</script>Fern';
  products[1].title = '=HYPERLINK("http://evil.example","Click")';
  products[2].title = 'Rose & Thorn #1 "quoted" <b>bold</b>';
  products[3].variants[0].price = 129999; // ₹1,299.99
  products[3].variants[0].compare_at_price = 129999; // equal to the price: no MRP
  products[4].variants.forEach((v) => { v.compare_at_price = v.price - 100; }); // MRP below the price
  products[5].body_html = '<img src=x onerror=alert(2)><iframe src="javascript:alert(3)"></iframe>';
  await setStorefront(world, products);
  const job = await importFeed(shop);
  assert.ok(['done'].includes(job.status), `${job.status}: ${job.message}`);
  assert.equal(job.total, 6);
  const fern = await byUrl(shop, products[0].handle);
  assert.ok(fern, 'A product with script in its title is still imported, as text');
  const exact = await byUrl(shop, products[3].handle);
  const [first] = await variantsOf(shop, exact.id);
  assert.equal(Number(first.price_paise), 129999, '"1299.99" is 129999 paise');
  assert.equal(first.mrp_paise, null, 'An MRP equal to the price is not kept');
  const low = await byUrl(shop, products[4].handle);
  if (low) for (const v of await variantsOf(shop, low.id)) assert.ok(v.mrp_paise === null || Number(v.mrp_paise) > Number(v.price_paise), 'An MRP below the price is never stored');
  assert.equal(await count(shop, 'product_variants', 'mrp_paise IS NOT NULL AND mrp_paise <= price_paise'), 0);
  const ids = (await shop.productRows()).map((r) => r.id);
  await shop.sql('UPDATE products SET active = true WHERE tenant_id = $1', [shop.tenantId]);
  const landing = await shop.page({ productIds: ids });
  const html = need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text;
  assertNoLiveMarkup(html, 'The landing page');
  assert.ok(textOf(html).includes('Rose & Thorn #1 "quoted"'), 'Ampersand, hash and quotes show as written');
  assert.doesNotMatch(html, /<b>bold<\/b>/, 'Markup in a title is not live');
});

test('K-15: a store address that is private, or redirects somewhere private, is never fetched', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  for (const storeUrl of ['http://10.0.0.5', 'https://internal.example', 'http://169.254.169.254', 'http://localhost:8080', 'https://toprivate.example', 'ftp://plants.example', 'javascript:alert(1)']) {
    const res = await shop.send('POST', '/imports/shopify', { storeUrl });
    assert.ok(res.status < 500, `${storeUrl} answered ${res.status}`);
    if (res.status === 202) {
      const job = await shop.job(res.json().id);
      assert.equal(job.status, 'failed', `${storeUrl}: the import ended ${job.status}`);
      assert.equal(job.created, 0);
    } else assert.equal(res.status, 400, `${storeUrl}: ${res.text.slice(0, 200)}`);
  }
  assert.ok(world.dialsSince(mark).every((d) => d.address === '93.184.216.34' && d.host === 'toprivate.example'), `Connected to: ${JSON.stringify(world.dialsSince(mark))}`);
  assert.equal(await count(shop, 'products'), 0);
});

// ---- K-16 ------------------------------------------------------------------------------------------------------------------

test('K-16: a re-import after the owner renamed a product keeps the title, refreshes prices, and makes no duplicates', async () => {
  const shop = await addP3Shop(world);
  const products = store(5);
  await setStorefront(world, products);
  const first = await importFeed(shop);
  assert.equal(first.created, 5, `${first.status}: ${first.message}`);
  const renamed = await byUrl(shop, products[0].handle);
  await shop.must('PATCH', `/products/${renamed.id}`, { name: 'My own name for it', description: 'Written by the owner' });

  products[0].title = 'The store renamed it too';
  products[0].body_html = '<p>The store rewrote this.</p>';
  products[0].variants[0].price = 9900;
  products[0].variants[0].compare_at_price = 19900;
  products[0].variants[0].available = false;
  products[1].title = 'A new store title';
  products[1].variants[1].price = 77700;
  await setStorefront(world, products);
  const second = await importFeed(shop);
  assert.equal(second.status, 'done', second.message);
  assert.equal(second.created, 0, 'Nothing new');
  assert.ok(second.updated >= 2, `Updated ${second.updated}`);
  assert.equal(second.updated + second.unchanged, 5);
  assert.equal(await count(shop, 'products'), 5, 'No duplicates');
  assert.equal(await count(shop, 'product_variants'), 10, 'No duplicate variants');

  const kept = await shop.getProduct(renamed.id);
  assert.equal(kept.name, 'My own name for it', 'The owner\'s title is kept');
  assert.equal(kept.description, 'Written by the owner', 'The owner\'s text is kept');
  assert.ok(kept.ownerEdited.includes('name'), `The product remembers the owner edited the name: ${kept.ownerEdited}`);
  assert.deepEqual(kept.variants.map((v) => [v.pricePaise, v.mrpPaise, v.inStock])[0], [9900, 19900, false], 'Price, MRP and stock are refreshed');
  const other = await shop.getProduct((await byUrl(shop, products[1].handle)).id);
  assert.equal(other.name, 'A new store title', 'A title the owner never touched follows the store');
  assert.equal(other.variants[1].pricePaise, 77700);
});

test('K-16: a product gone from the store is archived to Needs attention, not deleted, and comes back when the store lists it again', async () => {
  const shop = await addP3Shop(world);
  const products = store(4);
  await setStorefront(world, products);
  await importFeed(shop);
  await shop.sql('UPDATE products SET active = true WHERE tenant_id = $1', [shop.tenantId]);
  const gone = await byUrl(shop, products[3].handle);
  const stays = await byUrl(shop, products[0].handle);
  const landing = await shop.page({ productIds: [stays.id, gone.id] });

  await setStorefront(world, products.slice(0, 3));
  const second = await importFeed(shop);
  assert.equal(second.archived, 1, `Archived: ${second.archived}`);
  assert.equal(await count(shop, 'products'), 4, 'The product is kept');
  const after = await shop.getProduct(gone.id);
  assert.equal(after.fetchStatus, 'missing');
  const attention = await shop.products('status=attention');
  assert.deepEqual(attention.map((p) => p.id), [gone.id], 'It is in Needs attention');
  assert.equal((await shop.must('GET', '/catalog/settings')).attentionCount, 1);
  const html = need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text;
  assert.ok(!textOf(html).includes(products[3].title), 'A product gone from the store is not shown to shoppers');
  assert.ok(textOf(html).includes(products[0].title));

  await setStorefront(world, products);
  await importFeed(shop);
  assert.equal((await shop.getProduct(gone.id)).fetchStatus, 'ok', 'Listed again, it is fine again');
  assert.equal(await count(shop, 'products'), 4);
});

test('K-16: a feed that fails half-way archives nothing', async () => {
  const shop = await addP3Shop(world);
  const products = store(40);
  await setStorefront(world, products);
  await importFeed(shop);
  await world.shopify.fault({ kind: 'server_error', status: 500, times: 'forever', after: 1, match: { path: '/products.json' } });
  try {
    const job = await importFeed(shop);
    assert.ok(['done', 'failed'].includes(job.status));
    assert.equal(job.archived, 0, 'Products on the pages that failed are not treated as gone');
    assert.equal(await count(shop, 'products', `fetch_status = 'missing'`), 0);
  } finally {
    await world.shopify.delete('/faults');
  }
  await world.shopify.fault({ kind: 'malformed', mode: 'wrong_shape', times: 'forever', match: { path: '/products.json' } });
  try {
    const job = await importFeed(shop);
    assert.equal(job.archived, 0, 'A junk answer is not an empty store');
    assert.equal(await count(shop, 'products', `fetch_status = 'missing'`), 0);
  } finally {
    await world.shopify.delete('/faults');
  }
  assert.equal(await count(shop, 'products'), 40);
});

// ---- K-17 ------------------------------------------------------------------------------------------------------------------

test('K-17: when /products.json answers 404 or 401 the owner gets a clear error: paste links or upload a CSV', async () => {
  const shop = await addP3Shop(world);
  for (const feedStatus of [404, 401, 403]) {
    await setStorefront(world, store(3), { feedStatus });
    const job = await importFeed(shop);
    assert.equal(job.status, 'failed', `Feed ${feedStatus}: the import ended ${job.status}`);
    assert.equal(job.errorCode, 'feed_unavailable');
    assert.ok(plain(job.message).includes(plain(IMPORT_REASONS.feed_unavailable)), `Feed ${feedStatus}: "${job.message}"`);
    assert.match(job.message, /paste product links/i);
    assert.match(job.message, /CSV/);
    assert.equal(job.created, 0);
  }
  await setStorefront(world, store(3), { feedStatus: 200 });
  assert.equal(await count(shop, 'products'), 0, 'Nothing was imported');
});

test('K-17: a site that isn\'t a Shopify store, a feed of the wrong type, junk, and a store that never answers all end with that error', async () => {
  const shop = await addP3Shop(world);
  for (const storeUrl of ['https://shop.example', 'https://wrongtype.example', 'https://malformed.example', 'https://huge.example']) {
    const job = await importFeed(shop, storeUrl);
    assert.equal(job.status, 'failed', `${storeUrl}: ${job.status}`);
    assert.equal(job.created, 0);
    assert.ok(job.message.length > 0, `${storeUrl}: the owner is told something`);
  }
  await setStorefront(world, store(3));
  for (const fault of [{ kind: 'malformed', mode: 'garbage' }, { kind: 'malformed', mode: 'html' }, { kind: 'malformed', mode: 'truncated' }, { kind: 'timeout' }, { kind: 'drop' }]) {
    await world.shopify.fault({ ...fault, times: 'forever', match: { path: '/products.json' } });
    try {
      const job = await importFeed(shop, 'https://plants.example', 120_000);
      assert.equal(job.status, 'failed', `${JSON.stringify(fault)}: the import ended ${job.status}`);
      assert.equal(job.created, 0);
    } finally {
      await world.shopify.delete('/faults');
    }
  }
  assert.equal(await count(shop, 'products'), 0);
  const res = await shop.send('GET', '/products?limit=1');
  assert.equal(res.status, 200, 'The app still answers');
});

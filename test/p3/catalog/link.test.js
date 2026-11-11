// Import by pasting a link (PRD 8.3), with the quality gate (8.7) and safeFetch's refusals as the owner meets them (8.2).
// Every site is the simulator's; nothing reaches a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_REASONS } from '../../../src/contracts/catalog.js';
import { STORE, captureLogs, fillStore, openWorld } from './support.js';

const link = (shop, url, status = 200) => shop.post('/imports/link', { url }, status);

test('K-09: a Shopify product link gives title, image, price and MRP from the store’s JSON, and saving puts the image in the business’s media', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  await fillStore(world.shopify, 3);
  const feed = await (await fetch(`${world.shopify.url}/products.json`)).json();
  const product = feed.products[1];
  product.images[0].src = product.images[0].src.replace('127.0.0.1', STORE); // asked directly here; the import asks by the store's name
  const url = `https://${STORE}/products/${product.handle}`;

  const result = await link(shop, `${url}?variant=${product.variants[0].id}&utm_source=ig`);
  assert.equal(result.status, 'draft');
  assert.equal(result.readFrom, 'shopify');
  assert.equal(result.productId, null, 'nothing is saved until the owner saves it');
  const { draft } = result;
  assert.equal(draft.name, product.title);
  assert.equal(draft.externalUrl, url);
  assert.deepEqual(draft.images, [product.images[0].src]);
  assert.deepEqual(draft.options, [{ name: 'Size', values: ['Small', 'Medium'] }]);
  const available = product.variants.filter((v) => v.available);
  const cheapest = (available.length ? available : product.variants).reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
  assert.equal(draft.pricePaise, Math.round(Number(cheapest.price) * 100));
  assert.equal(draft.mrpPaise, Math.round(Number(cheapest.compare_at_price) * 100));
  assert.deepEqual(draft.variants.map((v) => v.inStock), product.variants.map((v) => v.available), 'stock comes from the store’s own answer');
  assert.deepEqual(await shop.products(), []);

  const saved = await shop.post(`/import-items/${result.itemId}/save`, { name: draft.name, pricePaise: draft.pricePaise });
  const detail = await shop.json(`/products/${saved.productId}`);
  assert.deepEqual([detail.name, detail.pricePaise, detail.mrpPaise, detail.externalUrl, detail.source, detail.fetchStatus, detail.priceManual, detail.active], [draft.name, draft.pricePaise, draft.mrpPaise, url, 'link', 'ok', false, true]);
  assert.equal(detail.variants.length, 2);
  assert.match(detail.images[0], /^\/media\/[0-9a-f-]{36}$/, 'the first image is a copy in the business’s media');
  assert.deepEqual([detail.gallery[0].url, detail.gallery[0].sourceUrl], [detail.images[0], product.images[0].src], 'and its original address is kept');
  assert.ok(detail.gallery[0].width > 0);
  const [media] = await shop.sql('SELECT tenant_id, mime FROM media WHERE id = $1', [detail.images[0].slice(7)]);
  assert.deepEqual(media, { tenant_id: shop.tenantId, mime: 'image/webp' }, 'stored as a fresh file, never the bytes as they came');
  const [due] = await shop.sql('SELECT next_check_at > now() AS later FROM products WHERE id = $1', [saved.productId]);
  assert.equal(due.later, true, 'an imported product is due a re-check');

  assert.deepEqual(await shop.post(`/import-items/${result.itemId}/save`, { name: 'Again', pricePaise: 1 }), saved, 'saving the same item twice opens the same product');
  assert.equal((await shop.products()).length, 1);
});

test('K-10: JSON-LD price "1,299.00" with OutOfStock is ₹1,299 and not in stock; the owner’s corrections are kept as theirs', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const result = await link(shop, 'https://shop.example/products/brass-planter');
  assert.deepEqual([result.status, result.readFrom, result.reason], ['draft', 'json_ld', null]);
  assert.deepEqual([result.draft.name, result.draft.pricePaise, result.draft.inStock, result.draft.description], ['Brass planter', 129900, false, 'Hand-beaten brass, 6 inch.']);

  const saved = await shop.post(`/import-items/${result.itemId}/save`, { name: 'Brass planter, 6 inch', pricePaise: 119900, categoryIds: [] });
  const detail = await shop.json(`/products/${saved.productId}`);
  assert.deepEqual([detail.name, detail.pricePaise, detail.inStock, detail.stock, detail.display.soldOut], ['Brass planter, 6 inch', 119900, false, 0, true]);
  assert.deepEqual(detail.ownerEdited, ['name'], 'a later import leaves the name alone');
  assert.equal(detail.priceManual, true, 'a price the owner typed is theirs');
  assert.deepEqual(detail.variants.map((v) => v.sku), ['BR-6'], 'the page’s SKU is kept for a later CSV');
  const [item] = await shop.items((await shop.json('/imports')).items[0].id);
  assert.deepEqual([item.status, item.productId, item.gatePassed], ['created', saved.productId, true]);
});

test('K-11: pasting an address the business already has opens that product; another business is not affected', async (t) => {
  const world = await openWorld(t);
  const [shop, other] = [await world.addShop(), await world.addShop()];
  const first = await link(shop, 'https://shop.example/products/brass-planter');
  const { productId } = await shop.post(`/import-items/${first.itemId}/save`, { name: 'Brass planter', pricePaise: 129900 });
  const dialsBefore = world.sites.dials.length;

  for (const again of ['https://shop.example/products/brass-planter', 'https://WWW.shop.example/products/brass-planter/?utm_campaign=x#top']) {
    const result = await link(shop, again);
    assert.deepEqual([result.status, result.productId, result.itemId, result.draft, result.message], ['existing', productId, null, null, 'This product is already in your catalog.'], again);
  }
  assert.equal(world.sites.dials.length, dialsBefore, 'the page isn’t read again');
  assert.equal((await shop.products()).length, 1, 'no duplicate');

  const theirs = await link(other, 'https://shop.example/products/brass-planter');
  assert.equal(theirs.status, 'draft', 'the other business has no such product');
  assert.deepEqual(await other.products(), []);
  assert.equal((await other.call(`/import-items/${first.itemId}/save`, { method: 'POST', body: { name: 'Stolen', pricePaise: 1 } })).status, 404, 'one business can’t save another’s draft');
  assert.equal((await other.call(`/imports/${(await shop.json('/imports')).items[0].id}`)).status, 404);
});

test('K-21, K-22, K-23: a homepage and a title-only page are refused with the draft to prefill the form; a name and a photo are enough', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const home = await link(shop, 'https://shop.example/');
  assert.deepEqual([home.status, home.reason, home.message], ['refused', 'homepage', 'This looks like the homepage, not a product.']);
  const titleOnly = await link(shop, 'https://shop.example/products/title-only');
  assert.deepEqual([titleOnly.status, titleOnly.reason, titleOnly.readFrom, titleOnly.draft.name], ['refused', 'title_only', 'title', 'Steel bottle']);
  const siteName = await link(shop, 'https://shop.example/products/site-name');
  assert.deepEqual([siteName.status, siteName.reason], ['refused', 'site_name']);
  const ogOnly = await link(shop, 'https://shop.example/products/og-only');
  assert.deepEqual([ogOnly.status, ogOnly.reason, ogOnly.readFrom, ogOnly.draft.name, ogOnly.draft.pricePaise], ['draft', null, 'open_graph', 'Jute basket', null], 'K-23: accepted, with no price');
  const ogPrice = await link(shop, 'https://shop.example/products/og-price');
  assert.deepEqual([ogPrice.status, ogPrice.draft.pricePaise], ['draft', 79900]);
  assert.deepEqual(await shop.products(), [], 'nothing is a product yet');

  // A manual save skips the gate (8.7): the refused draft prefills the form and the owner completes it.
  const saved = await shop.post(`/import-items/${titleOnly.itemId}/save`, { name: 'Steel bottle 1 L', pricePaise: 59900 });
  assert.equal((await shop.json(`/products/${saved.productId}`)).externalUrl, 'https://shop.example/products/title-only');
  const noPrice = await shop.call(`/import-items/${ogOnly.itemId}/save`, { method: 'POST', body: { name: 'Jute basket' } });
  assert.equal(noPrice.status, 400, 'a product needs a price to be saved');
});

test('script in a product’s text never reaches the catalog as markup', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  // The fixture's JSON-LD holds a raw </script>, which ends the block early, as it would in a browser: only the title is left.
  const broken = await link(shop, 'https://shop.example/products/script-in-text');
  assert.deepEqual([broken.status, broken.reason, broken.draft.name], ['refused', 'title_only', 'Clay lamp']);
  assert.doesNotMatch(JSON.stringify(broken), /<script|onerror|<img|alert/i);

  // The same text escaped the way a careful site writes it, so the JSON is whole and the markup arrives inside the strings.
  const data = { '@type': 'Product', name: 'Clay lamp <script>alert(1)</script>', description: '<img src=x onerror=alert(2)>Warm light</p><script>steal()</script>', image: 'https://shop.example/img/lamp.png', offers: { price: '250', priceCurrency: 'INR' } };
  world.sites.page('shop.example', '/products/escaped', { body: `<!doctype html><title>Clay lamp</title><script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>` });
  const result = await link(shop, 'https://shop.example/products/escaped');
  assert.deepEqual([result.status, result.readFrom, result.draft.name, result.draft.description, result.draft.pricePaise], ['draft', 'json_ld', 'Clay lamp', 'Warm light', 25000]);
  assert.doesNotMatch(JSON.stringify(result), /<script|onerror|<img|alert/i);
  const saved = await shop.post(`/import-items/${result.itemId}/save`, { name: result.draft.name, pricePaise: 25000 });
  const detail = await shop.json(`/products/${saved.productId}`);
  assert.deepEqual([detail.name, detail.description], ['Clay lamp', 'Warm light']);
});

test('K-04 to K-08: private addresses, long redirect chains, slow and huge pages and odd ports are refused, and nothing is stored', async (t) => {
  const world = await openWorld(t, { overrides: {} });
  const shop = await world.addShop();
  const refusals = [
    ['http://127.0.0.1/admin', 'blocked'],
    ['https://toprivate.example/', 'blocked'],
    ['https://internal.example/', 'blocked'],
    ['https://shop.example:8080/products/brass-planter', 'blocked'],
    ['ftp://shop.example/file', 'blocked'],
    ['not-a-link', 'blocked'],
    ['https://loop.example/hops/4', 'too_many_redirects'],
    ['https://huge.example/', 'too_large'],
    ['https://gone.example/products/missing', 'http_status'],
    ['https://wrongtype.example/product', 'wrong_type'],
    ['https://nowhere.example/p/1', 'network'],
  ];
  for (const [url, reason] of refusals) {
    const result = await link(shop, url);
    assert.deepEqual([result.status, result.reason, result.draft, result.itemId, result.productId], ['failed', reason, null, null, null], url);
    assert.equal(result.message, IMPORT_REASONS[reason], url);
  }
  assert.equal((await link(shop, 'http://127.0.0.1/admin')).message, 'That address isn’t a public website', 'K-04');
  assert.equal((await link(shop, 'https://loop.example/hops/4')).message, 'Too many redirects', 'K-06');
  assert.deepEqual(world.sites.dials.filter((d) => !['93.184.216.34', '93.184.216.35'].includes(d.address)), [], 'no connection ever went to a private address');
  assert.deepEqual(await shop.products(), []);
  assert.deepEqual((await shop.json('/imports')).items, [], 'a link that couldn’t be read leaves no job behind');
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM media WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(n, 0);
});

test('K-05: a name whose DNS answer flips to the metadata address is only ever reached at the address that was checked', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const result = await link(shop, 'https://rebind.example/p/lamp');
  assert.notEqual(result.status, 'draft', 'whatever the page says, the metadata address is never read');
  assert.deepEqual(world.sites.dials.filter((d) => d.address === '169.254.169.254'), []);
});

test('K-07: a page that takes 12 s is given up on at 8 s, and the owner gets the manual form', { timeout: 30_000 }, async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const started = Date.now();
  const result = await link(shop, 'https://slow.example/');
  const took = Date.now() - started;
  assert.deepEqual([result.status, result.reason, result.draft], ['failed', 'timeout', null]);
  assert.match(result.message, /took too long.*Add the details yourself/);
  assert.ok(took >= 7500 && took < 11_000, `stopped at about 8 s (took ${took} ms)`);
});

test('importing is part of the plan: a business without it is refused, and nothing is fetched', async (t) => {
  const world = await openWorld(t);
  const [free, paid] = [await world.addShop({ plan: 'free' }), await world.addShop({ plan: 't2' })];
  for (const [path, body] of [['/imports/link', { url: 'https://shop.example/products/brass-planter' }], ['/imports/bulk', { urls: ['https://shop.example/products/brass-planter'] }], ['/imports/shopify', { storeUrl: STORE }]]) {
    const res = await free.call(path, { method: 'POST', body });
    assert.equal(res.status, 403, path);
    assert.equal(res.json().reason, 'plan.not_included', path);
  }
  assert.equal((await free.uploadCsv('title,price\nPot,5')).status, 403);
  assert.deepEqual(world.sites.dials, []);
  assert.equal((await link(paid, 'https://shop.example/products/brass-planter')).status, 'draft');
  // F-96: switched on for one business, it appears for no other.
  await free.inside(() => free.repos.entitlements.setOverride('catalog.import', { enabled: true }));
  assert.equal((await link(free, 'https://shop.example/products/brass-planter')).status, 'draft');
  const third = await world.addShop({ plan: 'free' });
  assert.equal((await third.call('/imports/link', { method: 'POST', body: { url: 'https://shop.example/products/brass-planter' } })).status, 403);
});

test('logs of an import carry ids and codes, never the page’s text', async (t) => {
  const logs = captureLogs(t);
  const world = await openWorld(t);
  const shop = await world.addShop();
  const result = await link(shop, 'https://shop.example/products/brass-planter');
  await shop.post(`/import-items/${result.itemId}/save`, { name: 'Brass planter', pricePaise: 129900 });
  assert.doesNotMatch(logs.text(), /Brass planter|Hand-beaten/);
});

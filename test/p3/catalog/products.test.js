// The catalog through the seller API (PRD 8.1): options, variants and images on a product, what a card shows, the list's
// filters, and the wall between businesses. The Phase 0 behaviour of these routes is covered by test/p0/admin-api.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorld } from './support.js';

const pot = { name: 'Clay pot', pricePaise: 19900 };

test('K-01: two businesses save the same external URL; each sees only its own product', async (t) => {
  const world = await openWorld(t);
  const [a, b] = [await world.addShop(), await world.addShop()];
  const url = 'https://x.example/p/1';
  const mine = await a.post('/products', { ...pot, externalUrl: url });
  const theirs = await b.post('/products', { name: 'Their pot', pricePaise: 5000, externalUrl: `${url}?utm_source=ig` });
  assert.equal(mine.externalUrl, url);
  assert.equal(theirs.externalUrl, url, 'tracking parameters are dropped, so two pastes of one page are one address');
  assert.deepEqual((await a.products()).map((p) => p.name), ['Clay pot']);
  assert.deepEqual((await b.products()).map((p) => p.name), ['Their pot']);
  assert.equal((await a.call(`/products/${theirs.id}`)).status, 404);
  assert.equal((await a.call(`/products/${theirs.id}`, { method: 'PATCH', body: { name: 'Taken' } })).status, 404);
  assert.equal((await a.call(`/products/${theirs.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await b.json(`/products/${theirs.id}`)).name, 'Their pot');

  const again = await a.call('/products', { method: 'POST', body: { name: 'Second', pricePaise: 100, externalUrl: 'https://www.x.example/p/1/' } });
  assert.equal(again.status, 400, 'the same address twice in one business is refused');
  assert.equal(again.json().fields.externalUrl, 'This product is already in your catalog.');
});

test('K-02: an MRP below the price is refused, on the product and on a variant; an MRP above it shows with its discount', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const refused = await shop.call('/products', { method: 'POST', body: { name: 'Pot', pricePaise: 129900, mrpPaise: 99900 } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().fields.mrpPaise, 'MRP can’t be lower than the price');
  const variant = await shop.call('/products', { method: 'POST', body: { ...pot, options: [{ name: 'Size', values: ['S'] }], variants: [{ optionValues: ['S'], pricePaise: 500, mrpPaise: 400 }] } });
  assert.equal(variant.status, 400);
  assert.deepEqual(await shop.products(), [], 'nothing was saved');
  const ok = await shop.post('/products', { name: 'Pot', pricePaise: 99900, mrpPaise: 129900 });
  assert.deepEqual(ok.display, { pricePaise: 99900, mrpPaise: 129900, discountPercent: 23, soldOut: false });
});

test('K-03: variants at ₹499 (sold out) and ₹599 (in stock): the card shows ₹599', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const created = await shop.post('/products', {
    ...pot, pricePaise: 49900, images: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'], imageAlts: ['Front', 'Back'],
    options: [{ name: 'Size', values: ['Small', 'Medium'] }],
    variants: [
      { optionValues: ['Small'], sku: 'CP-S', pricePaise: 49900, inStock: false, imageIndex: 0 },
      { optionValues: ['Medium'], sku: 'CP-M', pricePaise: 59900, mrpPaise: 79900, imageIndex: 1 },
    ],
  });
  assert.deepEqual(created.display, { pricePaise: 59900, mrpPaise: 79900, discountPercent: 25, soldOut: false });
  assert.deepEqual(created.options, [{ name: 'Size', values: ['Small', 'Medium'] }]);
  assert.deepEqual(created.variants.map((v) => [v.optionValues, v.sku, v.pricePaise, v.mrpPaise, v.inStock, v.position]), [[['Small'], 'CP-S', 49900, null, false, 0], [['Medium'], 'CP-M', 59900, 79900, true, 1]]);
  assert.deepEqual(created.gallery.map((g) => [g.url, g.alt, g.position]), [['https://cdn.example/a.jpg', 'Front', 0], ['https://cdn.example/b.jpg', 'Back', 1]]);
  assert.deepEqual(created.variants.map((v) => v.imageId), created.gallery.map((g) => g.id), 'each variant shows its own image');
  assert.deepEqual([created.optionLabel, created.optionValues], ['Size', ['Small', 'Medium']], 'the Phase 0 option list is kept in step');
  assert.equal((await shop.products())[0].display.pricePaise, 59900, 'the list shows the same card price');

  const soldOut = await shop.patch(`/products/${created.id}`, { variants: [{ optionValues: ['Small'], sku: 'CP-S', pricePaise: 49900, inStock: false }, { optionValues: ['Medium'], sku: 'CP-M', pricePaise: 59900, inStock: false }] });
  assert.deepEqual([soldOut.display.pricePaise, soldOut.display.soldOut], [49900, true], 'with nothing in stock: the lowest price, and Sold out');
  assert.deepEqual(soldOut.variants.map((v) => v.id), created.variants.map((v) => v.id), 'a variant that is still there keeps its id');
  assert.deepEqual(soldOut.variants.map((v) => v.imageId), created.variants.map((v) => v.imageId), 'and its image');
  assert.deepEqual((await shop.products('status=sold_out')).map((p) => p.id), [created.id]);
});

test('options and variants that don’t fit are refused by name, and a SKU is one variant in a business', async (t) => {
  const world = await openWorld(t);
  const [shop, other] = [await world.addShop(), await world.addShop()];
  const post = (body) => shop.call('/products', { method: 'POST', body: { ...pot, ...body } });
  const size = [{ name: 'Size', values: ['S', 'M'] }];
  const wrongValue = await post({ options: size, variants: [{ optionValues: ['XL'], pricePaise: 100 }] });
  assert.equal(wrongValue.status, 400);
  assert.match(wrongValue.json().fields.variants, /doesn’t have/);
  assert.equal((await post({ options: size, variants: [{ optionValues: ['S'], pricePaise: 1 }, { optionValues: ['S'], pricePaise: 2 }] })).status, 400);
  assert.equal((await post({ variants: [{ optionValues: ['S'], pricePaise: 1 }] })).status, 400, 'a variant with no option to belong to');
  assert.equal((await post({ options: [{ name: 'A', values: ['1'] }, { name: 'B', values: ['1'] }, { name: 'C', values: ['1'] }, { name: 'D', values: ['1'] }] })).status, 400, 'four options');

  const first = await shop.post('/products', { ...pot, options: size, variants: [{ optionValues: ['S'], sku: 'SKU-1', pricePaise: 100 }] });
  const clash = await post({ name: 'Other pot', options: size, variants: [{ optionValues: ['M'], sku: 'SKU-1', pricePaise: 100 }] });
  assert.equal(clash.status, 400);
  assert.match(clash.json().fields.variants, /SKU is already used/);
  assert.deepEqual((await shop.products()).map((p) => p.id), [first.id], 'the refused product left nothing behind');
  await other.post('/products', { ...pot, options: size, variants: [{ optionValues: ['S'], sku: 'SKU-1', pricePaise: 100 }] });
});

test('a product’s images: six at most, alt text kept, and only this business’s uploads become its files', async (t) => {
  const world = await openWorld(t);
  const [shop, other] = [await world.addShop(), await world.addShop()];
  const theirFile = await other.inside(() => other.repos.media.save(Buffer.from('x'), 'image/png'));
  const myFile = await shop.inside(() => shop.repos.media.save(Buffer.from('y'), 'image/png'));
  const created = await shop.post('/products', { ...pot, images: [`/media/${myFile}`, `/media/${theirFile}`, 'https://cdn.example/c.jpg'], imageAlts: ['Mine', 'Theirs', 'Web'] });
  assert.deepEqual(created.gallery.map((g) => [g.url, g.alt, g.position]), [[`/media/${myFile}`, 'Mine', 0], ['https://cdn.example/c.jpg', 'Web', 1]], 'another business’s file is not linked');
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM product_images WHERE media_id = $1', [theirFile]);
  assert.equal(n, 0);

  const reordered = await shop.patch(`/products/${created.id}`, { images: ['https://cdn.example/c.jpg', `/media/${myFile}`] });
  assert.deepEqual(reordered.gallery.map((g) => [g.url, g.alt, g.position]), [['https://cdn.example/c.jpg', 'Web', 0], [`/media/${myFile}`, 'Mine', 1]], 'alt text follows its image');
  const seven = await shop.call(`/products/${created.id}`, { method: 'PATCH', body: { images: Array.from({ length: 7 }, (_, i) => `https://cdn.example/${i}.jpg`) } });
  assert.equal(seven.status, 400);
  const script = await shop.call(`/products/${created.id}`, { method: 'PATCH', body: { images: ['javascript:alert(1)'] } });
  assert.equal(script.status, 400);
});

test('stock is kept in both forms: the count the Phase 0 store reads and the in-stock flag', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const product = await shop.post('/products', pot);
  assert.deepEqual([product.inStock, product.stock], [true, null]);
  const out = await shop.patch(`/products/${product.id}`, { inStock: false });
  assert.deepEqual([out.inStock, out.stock, out.display.soldOut], [false, 0, true], 'the old store must not sell what is sold out');
  const back = await shop.patch(`/products/${product.id}`, { inStock: true });
  assert.deepEqual([back.inStock, back.stock], [true, null]);
  const counted = await shop.patch(`/products/${product.id}`, { stock: 3 });
  assert.deepEqual([counted.inStock, counted.stock], [true, 3]);
  const zero = await shop.patch(`/products/${product.id}`, { stock: 0 });
  assert.deepEqual([zero.inStock, zero.display.soldOut], [false, true]);
  await shop.sql('UPDATE products SET stock = 0, in_stock = true WHERE id = $1', [product.id]);
  assert.equal((await shop.json(`/products/${product.id}`)).inStock, false, 'an order that takes the last one makes it sold out, whatever the flag says');
});

test('the list filters by what needs attention, price changes, sold out and source, and pages in the database', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const ids = {};
  for (const name of ['Manual', 'Broken', 'Missing', 'Changed', 'Adapter', 'Sold']) ids[name] = (await shop.post('/products', { name, pricePaise: 100 })).id;
  await shop.sql(`UPDATE products SET source = 'link', fetch_status = 'broken' WHERE id = $1`, [ids.Broken]);
  await shop.sql(`UPDATE products SET source = 'shopify', fetch_status = 'missing', active = false WHERE id = $1`, [ids.Missing]);
  await shop.sql(`UPDATE products SET source = 'csv', price_changed = true, previous_price_paise = 50 WHERE id = $1`, [ids.Changed]);
  await shop.sql(`UPDATE products SET source = 'adapter:some-site' WHERE id = $1`, [ids.Adapter]);
  await shop.patch(`/products/${ids.Sold}`, { inStock: false });
  const names = async (query) => (await shop.products(query)).map((p) => p.name).sort();
  assert.deepEqual(await names('status=attention'), ['Broken', 'Missing']);
  assert.deepEqual(await names('status=price_changed'), ['Changed']);
  assert.deepEqual(await names('status=sold_out'), ['Sold']);
  assert.deepEqual(await names('source=adapter'), ['Adapter']);
  assert.deepEqual(await names('source=manual'), ['Manual', 'Sold']);
  assert.deepEqual(await names('source=shopify'), ['Missing']);
  assert.deepEqual(await names('search=%25'), [], 'a % in the search is a character, not a wildcard');
  assert.equal((await shop.call('/products?source=everything')).status, 400);

  const changed = await shop.json(`/products/${ids.Changed}`);
  assert.deepEqual([changed.priceChanged, changed.previousPricePaise, changed.source], [true, 50, 'csv']);
  const settings = await shop.json('/catalog/settings');
  assert.deepEqual(settings, { recheckHours: 24, attentionCount: 2, lastRecheckAt: null });

  const seen = [];
  let cursor = '';
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await shop.json(`/products?limit=4${cursor}`);
    seen.push(...page.items.map((p) => p.id));
    if (!page.nextCursor) break;
    cursor = `&cursor=${page.nextCursor}`;
  }
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6, 'no product twice');
  assert.equal(seen.at(-1), ids.Missing, 'archived products come last');
});

test('catalog settings: the re-check interval is per business, within 1 to 720 hours', async (t) => {
  const world = await openWorld(t);
  const [shop, other] = [await world.addShop(), await world.addShop()];
  assert.equal((await shop.patch('/catalog/settings', { recheckHours: 6 })).recheckHours, 6);
  assert.equal((await other.json('/catalog/settings')).recheckHours, 24);
  for (const recheckHours of [0, 721, 1.5, '6']) assert.equal((await shop.call('/catalog/settings', { method: 'PATCH', body: { recheckHours } })).status, 400, String(recheckHours));
  assert.equal((await shop.json('/catalog/settings')).recheckHours, 6);
});

test('text with markup is stored as the text it is, and a price past the limit is refused, not a server error', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const name = '<script>alert(1)</script> & "quotes"';
  const created = await shop.post('/products', { name, pricePaise: 100, description: '<img src=x onerror=alert(2)>', tags: ['<b>', 'sale', 'Sale'] });
  assert.equal(created.name, name);
  assert.equal(created.description, '<img src=x onerror=alert(2)>');
  assert.deepEqual(created.tags, ['<b>', 'sale'], 'a tag once, whatever its case');
  assert.equal((await shop.call('/products', { method: 'POST', body: { name: 'Huge', pricePaise: 2 ** 40 } })).status, 400);
  assert.equal((await shop.call('/products', { method: 'POST', body: { name: 'Nul\u0000', pricePaise: 100 } })).status, 400);
  assert.equal((await shop.call('/products', { method: 'POST', body: { name: 'Link', pricePaise: 100, externalUrl: 'javascript:alert(1)' } })).status, 400);
});

test('staff reach the catalog only with the catalog permission', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const add = async (permissions) => {
    const who = { phone: `93${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, password: 'staff-pass-123' };
    const user = await shop.repos.users.create({ name: 'Staff', role: 'staff', ...who });
    if (permissions.length) await shop.repos.users.setPermissions(user.id, permissions);
    const res = await shop.call('/auth/login', { method: 'POST', body: who }, null);
    return res.json().token;
  };
  const without = await add(['orders']);
  const withIt = await add(['catalog']);
  for (const path of ['/products', '/catalog/settings', '/imports']) {
    assert.equal((await shop.call(path, {}, without)).status, 403, path);
    assert.equal((await shop.call(path, {}, withIt)).status, 200, path);
  }
  assert.equal((await shop.call('/products', {}, null)).status, 401);
});

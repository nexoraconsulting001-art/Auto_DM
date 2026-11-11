// PRD 8.3 and 8.7: pasting a product link. What is read, in which order, what the quality gate turns away, and that a link the
// business already has opens that product. The outside web is tools/sim/sites; the Shopify store is at plants.example.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOSTILE_NAMES, addP3Shop, assertNoLiveMarkup, assertTurnedAway, generateStorefrontProducts, hit, jsonLdPage, need, ogPage, paste, plain, png,
  productIdsOf, setStorefront, sitePage, textOf, unique, useP3World,
} from './kit.js';

const world = useP3World();

const store = (count = 3, options = {}) => generateStorefrontProducts({ count, variants: 2, withMrp: true, ...options });

// ---- K-09 ------------------------------------------------------------------------------------------------------------------

test('K-09: a Shopify /products/<handle> link gives title, image, price and MRP from the store\'s JSON; the image lands in the business\'s media', async () => {
  const shop = await addP3Shop(world);
  const products = store();
  await setStorefront(world, products);
  const p = products[1]; // its first variant is in stock
  await world.shopify.delete('/calls');
  const url = `https://plants.example/products/${p.handle}`;
  const result = await paste(shop, url);
  assert.equal(result.status, 'draft', result.raw.slice(0, 400));
  assert.equal(result.readFrom, 'shopify', 'Read from the Shopify JSON, not the HTML');
  assert.equal(result.draft.name, p.title);
  assert.equal(result.draft.pricePaise, p.variants[0].price, 'The price in paise, from "224.00"');
  assert.equal(result.draft.mrpPaise, p.variants[0].compare_at_price, 'compare_at_price is the MRP');
  assert.equal(result.draft.externalUrl, url);
  assert.ok(result.draft.images[0]?.includes(`/cdn/${p.handle}.png`), `The image: ${JSON.stringify(result.draft.images)}`);
  assert.equal(result.draft.variants.length, 2, 'Both variants are read');
  assert.doesNotMatch(result.draft.description, /<p>|<\/p>/, 'body_html is not kept as markup');
  const calls = await world.shopify.calls();
  assert.ok(calls.some((c) => new RegExp(`^/products/${p.handle}\\.js(on)?$`).test(c.path)), `The store's product JSON was read: ${calls.map((c) => c.path).join(', ')}`);
  assert.equal((await shop.productRows()).length, 0, 'A draft is not a product until the owner saves it');

  const mediaBefore = (await shop.mediaRows()).length;
  const productId = await shop.saveDraft(result);
  const saved = await shop.getProduct(productId);
  assert.equal(saved.pricePaise, p.variants[0].price);
  assert.equal(saved.mrpPaise, p.variants[0].compare_at_price);
  assert.match(saved.gallery[0]?.url ?? '', /^\/media\/[\w-]+$/, `The first image is copied into the business's media: ${JSON.stringify(saved.gallery[0])}`);
  assert.ok(saved.gallery[0].sourceUrl.includes(`/cdn/${p.handle}.png`), 'The original address is kept beside it');
  assert.equal((await shop.mediaRows()).length, mediaBefore + 1, 'One file was stored');
  const file = need(await hit(world, saved.gallery[0].url, { host: shop.host }), 200, 'The stored image');
  assert.match(file.headers['content-type'], /^image\//);
  const other = await addP3Shop(world);
  assert.equal((await hit(world, saved.gallery[0].url, { host: other.host })).status, 404, 'Another business can\'t open the file');
});

test('K-09: a variant link, a tracking link and the same link twice open the one product', async () => {
  const shop = await addP3Shop(world);
  const products = store();
  await setStorefront(world, products);
  const base = `https://plants.example/products/${products[2].handle}`;
  const productId = await shop.importAndSave(base);
  for (const url of [`${base}?variant=${products[2].variants[1].id}`, `${base}?utm_source=instagram&fbclid=abc`, `${base}/`, `https://www.plants.example/products/${products[2].handle}#reviews`, base.replace('plants.example', 'PLANTS.example')]) {
    const again = await paste(shop, url);
    assert.equal(again.status, 'existing', `${url}: ${again.raw.slice(0, 300)}`);
    assert.equal(again.productId, productId, url);
  }
  assert.equal((await shop.productRows()).length, 1);
});

test('K-09: markup and script in a store\'s product title and description never run on a buyer page', async () => {
  const shop = await addP3Shop(world);
  const products = store(HOSTILE_NAMES.length);
  products.forEach((p, i) => {
    p.title = HOSTILE_NAMES[i];
    p.body_html = '<p onclick="alert(1)">Nice</p><script>steal()</script><img src=x onerror=alert(2)><iframe src="javascript:alert(3)"></iframe>';
  });
  await setStorefront(world, products);
  const ids = [];
  for (const p of products) {
    const result = await paste(shop, `https://plants.example/products/${p.handle}`);
    assert.ok(result.http === 200, `${p.title}: ${result.raw.slice(0, 200)}`);
    if (result.status === 'draft') ids.push(await shop.saveDraft(result));
  }
  assert.ok(ids.length >= 1, 'At least one of the hostile names was imported, to be shown');
  const landing = await shop.page({ productIds: ids });
  const html = need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text;
  assertNoLiveMarkup(html, 'The landing page');
  assert.doesNotMatch(html, /onclick="alert/i);
  for (const id of ids) {
    const saved = await shop.getProduct(id);
    assert.doesNotMatch(saved.description, /<script|<iframe|onerror=/i, 'The description is stored as text');
  }
});

test('K-09: when the store\'s JSON is junk the import falls back to the page, and never crashes or stores junk', async () => {
  const shop = await addP3Shop(world);
  const products = store();
  await setStorefront(world, products);
  const p = products[1];
  for (const mode of ['garbage', 'truncated', 'html', 'empty', 'wrong_shape']) {
    await world.shopify.delete('/faults');
    await world.shopify.fault({ kind: 'malformed', mode, times: 'forever', match: { path: '/products/*.json' } });
    await world.shopify.fault({ kind: 'malformed', mode, times: 'forever', match: { path: '/products/*.js' } });
    const result = await paste(shop, `https://plants.example/products/${p.handle}?try=${mode}`);
    assert.equal(result.http, 200, `${mode}: ${result.raw.slice(0, 200)}`);
    if (result.status === 'draft') {
      assert.notEqual(result.readFrom, 'shopify', `${mode}: junk was read as the store's JSON`);
      assert.equal(result.draft.name, p.title, `${mode}: the page's own data is used`);
      assert.ok(Number.isInteger(result.draft.pricePaise ?? 0) && (result.draft.pricePaise ?? 0) >= 0);
    }
  }
  await world.shopify.delete('/faults');
  await world.shopify.fault({ kind: 'server_error', status: 503, times: 'forever', match: { path: '/products/*' } });
  const down = await paste(shop, `https://plants.example/products/${p.handle}?try=down`);
  assert.ok(!['draft', 'existing'].includes(down.status), `A store answering 503 gave ${down.status}`);
  await world.shopify.delete('/faults');
  assert.equal((await shop.productRows()).length, 0);
});

test('K-09: a store that never answers stops at 8 s with the manual form, not a hung request', async () => {
  const shop = await addP3Shop(world);
  await setStorefront(world, store());
  await world.shopify.fault({ kind: 'timeout', times: 'forever', match: { path: '/products/*' } });
  try {
    const result = await paste(shop, `https://plants.example/products/${store()[0].handle}`);
    assertTurnedAway(result, 'timeout', 'A store that never answers');
    assert.ok(result.took < 12_000, `It took ${result.took} ms`);
  } finally {
    await world.shopify.delete('/faults');
  }
});

// ---- K-10 ------------------------------------------------------------------------------------------------------------------

test('K-10: JSON-LD offers.price "1,299.00" with OutOfStock is ₹1,299 (129900 paise) and not in stock', async () => {
  const shop = await addP3Shop(world);
  const result = await paste(shop, 'https://shop.example/products/brass-planter');
  assert.equal(result.status, 'draft', result.raw.slice(0, 400));
  assert.equal(result.readFrom, 'json_ld');
  assert.equal(result.draft.name, 'Brass planter');
  assert.equal(result.draft.pricePaise, 129900);
  assert.equal(result.draft.inStock, false);
  const productId = await shop.saveDraft(result);
  const [row] = await shop.productRows();
  assert.equal(Number(row.price_paise), 129900, 'Stored as whole paise');
  assert.equal(row.in_stock, false);
  const saved = await shop.getProduct(productId);
  assert.equal(saved.display?.soldOut, true);
  const landing = await shop.page({ productIds: [productId] });
  const text = textOf(need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text);
  assert.ok(text.includes('₹1,299'), 'The page shows ₹1,299');
  assert.ok(!text.includes('₹1,299.00') && !text.includes('₹129900') && !text.includes('₹1299'), 'Formatted with Indian grouping and no .00');
  assert.match(text, /sold out/i);
});

test('K-10: a ProductGroup with hasVariant and a Product inside @graph are read, with stock per variant', async () => {
  const shop = await addP3Shop(world);
  const group = await paste(shop, 'https://shop.example/products/terracotta-pot');
  assert.equal(group.status, 'draft', group.raw.slice(0, 400));
  assert.equal(group.draft.name, 'Terracotta pot');
  assert.deepEqual(group.draft.variants.map((v) => [v.pricePaise, v.inStock]), [[49900, false], [59900, true]]);
  assert.equal(group.draft.inStock, true, 'One variant is in stock');
  const saved = await shop.getProduct(await shop.saveDraft(group));
  assert.equal(saved.display?.pricePaise, 59900, 'The card price is the lowest in-stock variant (K-03)');

  const graph = await paste(shop, 'https://shop.example/products/macrame');
  assert.equal(graph.status, 'draft', graph.raw.slice(0, 400));
  assert.equal(graph.draft.name, 'Hanging macrame', 'The Product, not the Organization beside it');
  assert.equal(graph.draft.pricePaise, 34900, 'A numeric price 349 is 34900 paise');
  assert.equal(graph.draft.inStock, true);
});

test('K-10: prices are read digit by digit: no rounding, no float drift, nothing negative or absurd stored', async () => {
  const shop = await addP3Shop(world);
  const exact = [
    ['1299.99', 129999], ['0.07', 7], [19.99, 1999], ['1,29,900.50', 12990050], ['₹ 1,299', 129900], ['Rs. 2,499/-', 249900], ['INR 1299', 129900],
    [1.1, 110], ['4.35', 435], [0.29, 29], ['1299', 129900], ['1299.5', 129950], [8.2, 820], ['33.33', 3333], ['1,00,000', 10000000],
  ];
  for (const [price, paise] of exact) {
    const path = `/products/exact-${unique()}`;
    world.sites.page('shop.example', path, { body: jsonLdPage({ name: `Exact ${price}`, price }) });
    const result = await paste(shop, `https://shop.example${path}`);
    assert.equal(result.status, 'draft', `${price}: ${result.raw.slice(0, 300)}`);
    assert.equal(result.draft.pricePaise, paise, `offers.price ${JSON.stringify(price)} is ${paise} paise`);
  }
  const never = ['-100', '1299.995', '1e3', 'NaN', 'Infinity', '99999999999999999999', '1.299,00', 'free', '0x10', '१२९९', '1299 <script>alert(1)</script>', { '@value': '100' }, [], true];
  for (const price of never) {
    const path = `/products/odd-${unique()}`;
    world.sites.page('shop.example', path, { body: jsonLdPage({ name: 'Odd price vase', price }) });
    const result = await paste(shop, `https://shop.example${path}`);
    assert.equal(result.http, 200, `${JSON.stringify(price)}: ${result.raw.slice(0, 200)}`);
    const got = result.draft?.pricePaise ?? null;
    assert.equal(got, null, `offers.price ${JSON.stringify(price)} is not a price, but was read as ${got} paise`);
  }
  assert.equal((await shop.productRows()).length, 0);
});

test('K-10: availability in every spelling sets in_stock; anything unknown leaves the product in stock', async () => {
  const shop = await addP3Shop(world);
  const cases = [['OutOfStock', false], ['SoldOut', false], ['InStock', true], ['SomethingNew', true]];
  for (const [availability, inStock] of cases) {
    for (const spell of [(a) => `https://schema.org/${a}`, (a) => `http://schema.org/${a}`, (a) => a]) {
      const path = `/products/stock-${unique()}`;
      const data = { '@context': 'https://schema.org', '@type': 'Product', name: `Stock ${availability}`, image: 'https://shop.example/img/s.png', offers: { '@type': 'Offer', price: '100', priceCurrency: 'INR', availability: spell(availability) } };
      world.sites.page('shop.example', path, { body: sitePage(`<title>Stock</title><script type="application/ld+json">${JSON.stringify(data)}</script>`) });
      const result = await paste(shop, `https://shop.example${path}`);
      assert.equal(result.status, 'draft', result.raw.slice(0, 300));
      assert.equal(result.draft.inStock, inStock, `${spell(availability)} means inStock ${inStock}`);
    }
  }
});

test('K-10: script and markup in JSON-LD text, and a javascript: image, never reach a buyer page', async () => {
  const shop = await addP3Shop(world);
  const lamp = await paste(shop, 'https://shop.example/products/script-in-text');
  assert.equal(lamp.status, 'draft', lamp.raw.slice(0, 300));
  const evil = await paste(shop, 'https://inject.example/products/evil');
  assert.equal(evil.http, 200);
  for (const result of [lamp, evil]) for (const image of result.draft?.images ?? []) assert.match(image, /^https?:\/\//, `An image that isn't a web address was kept: ${image}`);
  const ids = [await shop.saveDraft(lamp)];
  if (evil.status === 'draft') ids.push(await shop.saveDraft(evil));
  const landing = await shop.page({ productIds: ids });
  const html = need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text;
  assertNoLiveMarkup(html, 'The landing page');
  assert.ok(textOf(html).includes('Clay lamp'), 'The name still shows, as text');
});

test('K-10: broken HTML, broken JSON-LD, NUL bytes, deep nesting and a flood of tags answer quickly with no draft and no crash', async () => {
  const shop = await addP3Shop(world);
  for (const path of ['/products/broken', '/deep', '/flood', '/unclosed']) {
    if (path === '/products/broken') world.sites.page('malformed.example', path, { body: `<html><head><title>Broken<title><meta property="og:title" content="Half <meta content='x><script type="application/ld+json">{"@type":"Product","name":</script><body><div><p>\u0000NUL\u0000<img src=` });
    const result = await paste(shop, `https://malformed.example${path}`);
    assert.equal(result.http, 200, `${path}: ${result.raw.slice(0, 200)}`);
    assert.ok(!['existing'].includes(result.status));
    if (result.status === 'draft') assert.ok(result.draft.name.length >= 2 && !result.draft.name.includes('\u0000'), `${path}: a junk draft: ${JSON.stringify(result.draft).slice(0, 200)}`);
    assert.ok(result.took < 8_000, `${path} took ${result.took} ms to parse`);
    assert.ok(!result.raw.includes('\\u0000'), `${path}: a NUL byte came back`);
  }
  const health = await hit(world, '/api/v1/products?limit=1', { host: shop.host, token: shop.token });
  assert.equal(health.status, 200, 'The app still answers');
});

// ---- K-11 ------------------------------------------------------------------------------------------------------------------

test('K-11: pasting a link the business already has opens that product; no duplicate is made', async () => {
  const shop = await addP3Shop(world);
  const url = 'https://shop.example/products/og-price';
  const productId = await shop.importAndSave(url);
  await world.sites.delete('/calls');
  const again = await paste(shop, url);
  assert.equal(again.status, 'existing', again.raw.slice(0, 300));
  assert.equal(again.productId, productId);
  assert.equal((await shop.productRows()).length, 1);
  const manual = await shop.product({ name: 'Typed by hand', externalUrl: 'https://shop.example/products/macrame' });
  const hand = await paste(shop, 'https://www.shop.example/products/macrame/?utm_campaign=x#top');
  assert.equal(hand.status, 'existing', 'A product typed by hand with that address counts too');
  assert.equal(hand.productId, manual.id);
});

test('K-11: the same new link pasted three times at the same moment, then saved three times, is one product', async () => {
  const shop = await addP3Shop(world);
  const path = `/products/race-${unique()}`;
  world.sites.page('shop.example', path, { body: ogPage({ name: 'Race kettle', price: '899' }) });
  const url = `https://shop.example${path}`;
  const results = await Promise.all([1, 2, 3].map(() => paste(shop, url)));
  for (const r of results) assert.ok(['draft', 'existing'].includes(r.status), r.raw.slice(0, 300));
  const drafts = results.filter((r) => r.status === 'draft');
  assert.ok(drafts.length >= 1);
  const saves = await Promise.all(drafts.map((r) => shop.send('POST', `/import-items/${r.itemId}/save`, { name: r.draft.name, pricePaise: r.draft.pricePaise, externalUrl: url, active: true })));
  for (const res of saves) assert.ok(res.status < 500, `A concurrent save crashed: ${res.status} ${res.text.slice(0, 200)}`);
  const ok = saves.filter((s) => [200, 201].includes(s.status));
  assert.ok(ok.length >= 1, `Saves answered ${saves.map((s) => s.status).join(', ')}`);
  assert.equal(new Set(ok.map((s) => s.json().productId)).size, 1, 'Every save answers the one product');
  for (const res of saves.filter((s) => ![200, 201].includes(s.status))) assert.ok([400, 409].includes(res.status), `A duplicate save answered ${res.status}`);
  assert.equal((await shop.productRows()).length, 1, 'One product');
  const twice = await shop.send('POST', `/import-items/${drafts[0].itemId}/save`, { name: 'Race kettle again', pricePaise: 100, externalUrl: url, active: true });
  assert.ok(twice.status < 500);
  assert.equal((await shop.productRows()).length, 1, 'Saving the same draft again makes nothing new');
});

test('K-11: "already in your catalog" never leaks across businesses, and one business can\'t save another\'s draft', async () => {
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  const url = 'https://shop.example/products/og-price';
  await a.importAndSave(url);
  const theirs = await paste(b, url);
  assert.equal(theirs.status, 'draft', `B has never saved this link: ${theirs.raw.slice(0, 300)}`);
  assert.equal(theirs.productId, null);
  const steal = await a.send('POST', `/import-items/${theirs.itemId}/save`, { name: 'Stolen', pricePaise: 100, active: true });
  assert.equal(steal.status, 404, `Saving another business's draft answered ${steal.status}`);
  assert.equal((await b.productRows()).length, 0);
  assert.equal((await a.productRows()).length, 1);
  const jobs = await a.must('GET', '/imports?limit=100');
  const bJobs = await b.sql('SELECT id FROM import_jobs WHERE tenant_id = $1', [b.tenantId]);
  for (const j of bJobs) assert.ok(!jobs.items.some((x) => x.id === j.id), 'A lists another business\'s import');
  for (const j of bJobs) assert.equal((await a.send('GET', `/imports/${j.id}`)).status, 404);
  for (const j of bJobs) assert.equal((await a.send('GET', `/imports/${j.id}/items`)).status, 404);
});

// ---- K-21 ------------------------------------------------------------------------------------------------------------------

test('K-21: a site\'s homepage is refused: "This looks like the homepage, not a product."', async () => {
  const shop = await addP3Shop(world);
  for (const url of ['https://shop.example/', 'https://shop.example', 'https://www.shop.example/#top', 'https://plants.example/']) {
    if (url.includes('plants')) await setStorefront(world, store());
    const result = await paste(shop, url);
    assertTurnedAway(result, 'homepage', url);
    assert.ok(plain(result.message).includes('This looks like the homepage, not a product.'));
    assert.equal(result.productId, null);
  }
  assert.equal((await shop.productRows()).length, 0);
});

test('K-21: a product page whose title is just the shop\'s name is refused, and the refusal opens the manual form with the link filled in', async () => {
  const shop = await addP3Shop(world);
  const url = 'https://shop.example/products/site-name';
  const result = await paste(shop, url);
  assertTurnedAway(result, 'site_name', 'A title equal to the site name');
  assert.equal(result.draft?.externalUrl, url, `The manual form is prefilled: ${result.raw.slice(0, 300)}`);
  const byHand = await shop.must('POST', '/products', { name: 'Leafy Corner', pricePaise: 10000, externalUrl: url, active: true }, 201, 'A manual save skips the gate');
  assert.equal(byHand.externalUrl, url);
});

// ---- K-22 ------------------------------------------------------------------------------------------------------------------

test('K-22: a page with only a <title> is refused as title-only, with nothing stored', async () => {
  const shop = await addP3Shop(world);
  const mediaBefore = (await shop.mediaRows()).length;
  const result = await paste(shop, 'https://shop.example/products/title-only');
  assertTurnedAway(result, 'title_only', 'Title only');
  assert.equal(result.draft?.pricePaise ?? null, null);
  assert.equal((await shop.productRows()).length, 0);
  assert.equal((await shop.mediaRows()).length, mediaBefore);
  const [item] = await shop.sql('SELECT status, gate_passed, reason FROM import_items WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]);
  if (item) assert.deepEqual([item.status, item.gate_passed, item.reason], ['refused', false, 'title_only'], 'The gate\'s verdict is recorded');
});

test('K-22: a one-letter title, a logo as the only image, and a blank title are all refused', async () => {
  const shop = await addP3Shop(world);
  world.sites.page('shop.example', '/products/short', { body: ogPage({ name: 'X', price: '100' }) });
  world.sites.page('shop.example', '/products/logo-only', { body: ogPage({ name: 'Cane chair', price: null, image: 'https://shop.example/logo.png' }) });
  world.sites.page('shop.example', '/products/blank', { body: sitePage('<title>   </title><meta property="og:image" content="https://shop.example/img/b.png"><meta property="product:price:amount" content="100">') });
  world.sites.page('shop.example', '/products/empty', { body: '' });
  for (const [path, reasons] of [['/products/short', ['no_title']], ['/products/logo-only', ['no_price_or_image']], ['/products/blank', ['no_title']], ['/products/empty', ['no_title', 'title_only', 'wrong_type']]]) {
    const result = await paste(shop, `https://shop.example${path}`);
    assert.ok(!['draft', 'existing'].includes(result.status), `${path} gave ${result.status}: ${result.raw.slice(0, 300)}`);
    assert.ok(reasons.includes(result.reason), `${path}: refused as ${result.reason}, expected ${reasons.join(' or ')}`);
  }
  assert.equal((await shop.productRows()).length, 0);
});

// ---- K-23 ------------------------------------------------------------------------------------------------------------------

test('K-23: og:title and og:image with no price is accepted, and the page shows no price for it', async () => {
  const shop = await addP3Shop(world);
  const result = await paste(shop, 'https://shop.example/products/og-only');
  assert.equal(result.status, 'draft', result.raw.slice(0, 300));
  assert.equal(result.readFrom, 'open_graph');
  assert.equal(result.draft.name, 'Jute basket');
  assert.equal(result.draft.pricePaise, null, 'No price was read');
  assert.equal(result.draft.images[0], 'https://shop.example/img/jute.png');
  const productId = await shop.saveDraft(result);
  const priced = await shop.product({ name: 'Priced mug', pricePaise: 45000 });
  const landing = await shop.page({ productIds: [productId, priced.id] });
  const html = need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text;
  assert.deepEqual(productIdsOf(html), [productId, priced.id]);
  const text = textOf(html);
  assert.ok(text.includes('Jute basket'));
  assert.ok(text.includes('₹450'), 'The priced product shows its price');
  assert.ok(!/₹\s?0(\D|$)/.test(text), 'A product with no price shows no "₹0"');
  assert.ok(!/free|null|undefined|NaN/i.test(text), `No stand-in for the missing price: ${text.slice(0, 300)}`);
});

test('K-23: og price tags are read when present, and og text carrying markup stays text', async () => {
  const shop = await addP3Shop(world);
  const priced = await paste(shop, 'https://shop.example/products/og-price');
  assert.equal(priced.status, 'draft');
  assert.deepEqual([priced.draft.name, priced.draft.pricePaise], ['Cane tray', 79900]);
  world.sites.page('shop.example', '/products/og-evil', { body: sitePage('<title>x</title><meta property="og:title" content="Tray &lt;script&gt;alert(1)&lt;/script&gt;"><meta property="og:image" content="https://shop.example/img/t.png"><meta property="og:description" content="&lt;img src=x onerror=alert(1)&gt;">') });
  world.sites.page('shop.example', '/img/t.png', { type: 'image/png', body: png({ width: 600, height: 600 }) });
  const evil = await paste(shop, 'https://shop.example/products/og-evil');
  assert.equal(evil.http, 200);
  if (evil.status === 'draft') {
    const landing = await shop.page({ productIds: [await shop.saveDraft(evil)] });
    assertNoLiveMarkup(need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text, 'The landing page');
  }
});

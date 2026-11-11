// The pure parts of the catalog and imports (PRD 8.1, 8.3, 8.5 to 8.7): reading pages, feeds and CSV into plain text and paise,
// the quality gate, and what a card shows. No database and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_LIMITS, CatalogRuleError } from '../../../src/contracts/catalog.js';
import { cardPrice, checkOptionsAndVariants, isBuyerVisible, legacyOption, soldOutLast } from '../../../src/modules/catalog/rules.js';
import { createAdapterRegistry, draftFromAdapter } from '../../../src/modules/imports/adapters.js';
import { csvCell, decodeCsv, importReportCsv, parseCsv, readCsvFile, rowToProduct, toCsv } from '../../../src/modules/imports/csv.js';
import { inStockFrom, pricePaise, readPage } from '../../../src/modules/imports/extract.js';
import { isLogo, qualityGate } from '../../../src/modules/imports/gate.js';
import { scanHtml } from '../../../src/modules/imports/html.js';
import { fromShopify, shopifyHandle } from '../../../src/modules/imports/shopify.js';
import { storeOrigin, toApiDraft } from '../../../src/modules/imports/service.js';
import { cleanLine, cleanUrl, htmlToText, plainLine } from '../../../src/modules/imports/text.js';
import { ValidationError } from '../../../src/util.js';

const page = (head, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const ld = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const rule = (code) => (err) => err instanceof CatalogRuleError && err.code === code;

// ---- text from outside is text ----

test('markup in imported text is dropped, script and all, and what is left is plain text', () => {
  assert.equal(cleanLine('Clay lamp <script>alert(1)</script>'), 'Clay lamp');
  assert.equal(htmlToText('<img src=x onerror=alert(2)>Warm light</p><script>steal()</script>'), 'Warm light');
  assert.equal(htmlToText('<p>One</p><p>Two &amp; three</p><style>p{color:red}</style>'), 'One\n\nTwo & three');
  assert.equal(cleanLine('Pack of <3 &lt;b&gt;bold&lt;/b&gt;'), 'Pack of <3 <b>bold</b>', 'entities are decoded once: the result is text, to be escaped where it is shown');
  assert.equal(cleanLine('A\u0000B\u0007C'), 'ABC');
  assert.equal(htmlToText('<script>never closed'), '');
  assert.equal(htmlToText('before <!-- a comment never closed'), 'before');
  assert.equal(plainLine('  =SUM(A1)\t\nnext '), '=SUM(A1) next', 'a CSV cell stays as its author wrote it, minus control characters');
});

test('text is cut to its limit without splitting a character, and never holds NUL or a lone surrogate', () => {
  const long = cleanLine('😀'.repeat(500), 120);
  assert.equal(Array.from(long).length, 120);
  assert.ok(long.isWellFormed());
  assert.equal(cleanLine('ab\ud800cd').includes('\ud800'), false);
  assert.equal(htmlToText(`x${'\u0000'.repeat(10)}y`), 'xy');
});

test('only http and https addresses become links: no javascript:, data:, credentials or spaces', () => {
  assert.equal(cleanUrl('/img/a.png', 'https://shop.example/p/1'), 'https://shop.example/img/a.png');
  assert.equal(cleanUrl('//cdn.example/a.png', 'https://shop.example/'), 'https://cdn.example/a.png');
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://user:pw@shop.example/a.png', 'https://shop.example/a b.png', 'ftp://shop.example/a.png', '', null, 42]) {
    assert.equal(cleanUrl(bad, 'https://shop.example/'), null, String(bad));
  }
});

test('a hostile page is read in one pass: unclosed tags, a flood of metas and deep JSON-LD end, and quickly', () => {
  const flood = page('<title>Flood</title>' + '<meta property="og:image" content="https://x.example/a.png">'.repeat(60_000));
  const deep = page(`<title>Deep</title><script type="application/ld+json">${'{"mainEntity":'.repeat(5000)}{}${'}'.repeat(5000)}</script>`);
  const unclosed = `<title>Open${'<div '.repeat(100_000)}`;
  const started = Date.now();
  assert.equal(scanHtml(flood).meta.get('og:image').length, 10);
  assert.equal(readPage(deep, 'https://x.example/p').readFrom, 'title');
  assert.deepEqual([readPage(unclosed, 'https://x.example/p').readFrom, readPage(unclosed, 'https://x.example/p').draft.name], ['title', 'Open']);
  assert.equal(readPage('<title>T</title><script type="application/ld+json">{"@type":"Product","name":"Half', 'https://x.example/p').readFrom, 'title');
  assert.ok(Date.now() - started < 3000, 'none of these may take long');
});

// ---- 8.3: what a page says ----

test('K-10: JSON-LD offers.price "1,299.00" with OutOfStock is 129900 paise and not in stock', () => {
  const html = page('<title>Brass planter | Leafy</title>' + ld({ '@type': 'Product', name: 'Brass planter', image: ['https://shop.example/img/brass.png'], offers: { '@type': 'Offer', price: '1,299.00', priceCurrency: 'INR', availability: 'https://schema.org/OutOfStock' } }));
  const { readFrom, draft } = readPage(html, 'https://shop.example/products/brass-planter');
  assert.equal(readFrom, 'json_ld');
  assert.equal(draft.pricePaise, 129900);
  assert.equal(draft.inStock, false);
  assert.deepEqual(draft.images, ['https://shop.example/img/brass.png']);
});

test('a ProductGroup becomes options and variants, priced at the lowest variant in stock (K-03)', () => {
  const group = {
    '@type': 'ProductGroup', name: 'Terracotta pot', variesBy: ['size'], image: 'https://shop.example/img/t.png',
    hasVariant: [
      { '@type': 'Product', name: 'Terracotta pot, small', sku: 'TP-S', size: 'Small', offers: { price: '499', priceCurrency: 'INR', availability: 'https://schema.org/OutOfStock' } },
      { '@type': 'Product', name: 'Terracotta pot, medium', sku: 'TP-M', size: 'Medium', offers: { price: '599', priceCurrency: 'INR', availability: 'https://schema.org/InStock' } },
    ],
  };
  const { draft } = readPage(page(ld({ '@graph': [{ '@type': 'Organization', name: 'Leafy' }, group] })), 'https://shop.example/products/terracotta-pot');
  assert.deepEqual(draft.options, [{ name: 'Size', values: ['Small', 'Medium'] }]);
  assert.deepEqual(draft.variants.map((v) => [v.optionValues[0], v.sku, v.pricePaise, v.inStock]), [['Small', 'TP-S', 49900, false], ['Medium', 'TP-M', 59900, true]]);
  assert.equal(draft.pricePaise, 59900);
  assert.equal(draft.inStock, true);
});

test('prices are read from the digits with no floating point, and a price in another currency is no price', () => {
  assert.equal(pricePaise('0.07'), 7);
  assert.equal(pricePaise('1,29,900.50'), 12990050);
  assert.equal(pricePaise(1299.1), 129910);
  assert.equal(pricePaise('19.999'), null);
  assert.equal(pricePaise('free'), null);
  assert.equal(pricePaise({ amount: 5 }), null);
  const usd = readPage(page(ld({ '@type': 'Product', name: 'Mug', offers: { price: '12.00', priceCurrency: 'USD' } })), 'https://x.example/p/mug');
  assert.equal(usd.draft.pricePaise, null);
  assert.equal(inStockFrom('https://schema.org/SoldOut'), false);
  assert.equal(inStockFrom(undefined), true, 'a page that doesn’t say isn’t proof of sold out');
});

test('Open Graph and product:price tags are read when there is no JSON-LD product, then the title alone', () => {
  const og = readPage(page('<title>Cane tray | Leafy</title><meta property="og:title" content="Cane tray"><meta property="og:image" content="/img/cane.png"><meta property="product:price:amount" content="799.00"><meta property="product:price:currency" content="INR">'), 'https://shop.example/products/cane');
  assert.equal(og.readFrom, 'open_graph');
  assert.deepEqual([og.draft.name, og.draft.pricePaise, og.draft.images[0]], ['Cane tray', 79900, 'https://shop.example/img/cane.png']);
  const title = readPage(page('<title>Steel bottle</title>'), 'https://shop.example/products/bottle');
  assert.equal(title.readFrom, 'title');
  assert.equal(title.draft.pricePaise, null);
});

// ---- 8.5: a Shopify product ----

test('a Shopify product maps handle, compare_at_price, available and tags; a default-only option is no option', () => {
  const draft = fromShopify({
    title: 'Monstera <b>big</b>', handle: 'Monstera-Big', body_html: '<p>Leafy.</p><script>x()</script>', tags: ['indoor', 'Indoor', 'easy-care'], product_type: 'Plants',
    options: [{ name: 'Size', values: ['S', 'L'] }],
    variants: [
      { id: 1, option1: 'S', sku: 'M-S', price: '499.00', compare_at_price: '599.00', available: false },
      { id: 2, option1: 'L', sku: 'M-L', price: '799.00', compare_at_price: '799.00', available: true },
    ],
    images: [{ src: 'https://cdn.example/m.png' }, { src: 'javascript:alert(1)' }],
  }, 'https://plants.example');
  assert.equal(draft.name, 'Monstera big');
  assert.equal(draft.description, 'Leafy.');
  assert.equal(draft.externalUrl, 'https://plants.example/products/monstera-big');
  assert.deepEqual(draft.tags, ['indoor', 'easy-care']);
  assert.deepEqual(draft.suggestedCategories, ['indoor', 'easy-care', 'Plants']);
  assert.deepEqual(draft.variants.map((v) => [v.pricePaise, v.mrpPaise, v.inStock]), [[49900, 59900, false], [79900, null, true]], 'an MRP equal to the price is no MRP');
  assert.deepEqual([draft.pricePaise, draft.mrpPaise, draft.inStock], [79900, null, true], 'the lowest in-stock variant');
  assert.deepEqual(draft.images, ['https://cdn.example/m.png']);

  const single = fromShopify({ title: 'Pot', handle: 'pot', options: [{ name: 'Title', values: ['Default Title'] }], variants: [{ id: 9, option1: 'Default Title', sku: 'POT-1', price: '120.00', compare_at_price: null }] }, 'https://plants.example');
  assert.deepEqual(single.options, []);
  assert.deepEqual(single.variants.map((v) => [v.optionValues, v.sku]), [[[], 'POT-1']]);
  assert.equal(fromShopify({ title: 'No price', handle: 'x', variants: [{ price: 'call us' }] }, 'https://plants.example'), null);
  assert.equal(fromShopify({ title: 'No handle' }, 'https://plants.example'), null);
});

test('a storefront product address gives its handle; anything else does not', () => {
  assert.equal(shopifyHandle('https://plants.example/products/snake-plant'), 'snake-plant');
  assert.equal(shopifyHandle('https://plants.example/collections/all/products/Snake-Plant/'), 'snake-plant');
  assert.equal(shopifyHandle('https://plants.example/products/snake-plant.json'), null);
  assert.equal(shopifyHandle('https://plants.example/pages/about'), null);
  assert.equal(storeOrigin('plants.example/collections/all?x=1'), 'https://plants.example');
  assert.equal(storeOrigin('http://plants.example'), 'http://plants.example');
  for (const bad of ['localhost', 'javascript:alert(1)', 'https://u:p@plants.example', '']) assert.equal(storeOrigin(bad), null, bad);
});

// ---- 8.7: the gate ----

test('the gate takes a name with a price or a real photo, and refuses the rest with its reason', () => {
  const draft = (over = {}) => ({ name: 'Jute basket', pricePaise: null, images: ['https://shop.example/img/jute.png'], ...over });
  const judge = (input) => qualityGate({ url: 'https://shop.example/products/x', readFrom: 'open_graph', ...input });
  assert.deepEqual(judge({ draft: draft() }), { passed: true, reason: null }, 'K-23: og:title and og:image, no price');
  assert.deepEqual(judge({ draft: draft({ images: [], pricePaise: 100 }) }), { passed: true, reason: null });
  assert.equal(judge({ draft: draft({ images: [] }) }).reason, 'no_price_or_image');
  assert.equal(judge({ draft: draft({ images: ['https://shop.example/logo.png'] }) }).reason, 'no_price_or_image', 'a logo is not a product photo');
  assert.equal(judge({ draft: draft({ images: ['https://shop.example/a.png'] }), home: { title: 'Shop', siteNames: [], logos: ['https://www.shop.example/a.png'] } }).reason, 'no_price_or_image');
  assert.equal(judge({ draft: draft({ name: 'J' }) }).reason, 'no_title');
  assert.equal(judge({ draft: null }).reason, 'no_title');
  assert.equal(judge({ draft: draft(), readFrom: 'title' }).reason, 'title_only', 'K-22');
  assert.equal(judge({ draft: draft({ name: 'Leafy Corner' }), page: { siteNames: ['Leafy  corner'], logos: [] } }).reason, 'site_name');
  assert.equal(judge({ draft: draft({ name: 'Welcome to Leafy' }), home: { title: 'welcome to leafy!', siteNames: [], logos: [] } }).reason, 'homepage');
  assert.equal(qualityGate({ url: 'https://shop.example/', readFrom: 'json_ld', draft: draft({ pricePaise: 100 }) }).reason, 'homepage', 'K-21');
  assert.equal(qualityGate({ url: 'https://shop.example/go', finalUrl: 'https://shop.example/', readFrom: 'json_ld', draft: draft({ pricePaise: 100 }) }).reason, 'homepage', 'a link that lands on the homepage');
  assert.equal(isLogo('https://shop.example/assets/site-logo.svg'), true);
  assert.equal(isLogo('https://shop.example/img/logistics-box.png'), false);
});

// ---- 8.1: what a card shows ----

test('K-03: the card shows the lowest in-stock variant, its MRP struck through with -N%, or Sold out', () => {
  const product = { price_paise: 49900, mrp_paise: null, in_stock: true, stock: null };
  const variants = [{ price_paise: 49900, mrp_paise: 69900, in_stock: false }, { price_paise: 59900, mrp_paise: 79900, in_stock: true }];
  assert.deepEqual(cardPrice(product, variants), { pricePaise: 59900, mrpPaise: 79900, discountPercent: 25, soldOut: false });
  assert.deepEqual(cardPrice(product, variants.map((v) => ({ ...v, in_stock: false }))), { pricePaise: 49900, mrpPaise: 69900, discountPercent: 29, soldOut: true });
  assert.deepEqual(cardPrice({ ...product, mrp_paise: 49900 }), { pricePaise: 49900, mrpPaise: null, discountPercent: null, soldOut: false }, 'an MRP equal to the price isn’t shown');
  assert.equal(cardPrice({ ...product, stock: 0 }).soldOut, true, 'the Phase 0 stock count at zero is sold out too');
  assert.equal(cardPrice({ price_paise: 9999, mrp_paise: 10000, in_stock: true, stock: null }).discountPercent, null, 'a discount under 1% shows no "-0%"');
  assert.deepEqual(soldOutLast([{ n: 1, display: { soldOut: true } }, { n: 2, display: { soldOut: false } }, { n: 3, display: { soldOut: true } }, { n: 4, display: { soldOut: false } }]).map((p) => p.n), [2, 4, 1, 3]);
  assert.equal(isBuyerVisible({ active: true, fetch_status: 'ok' }), true);
  for (const status of ['broken', 'missing']) assert.equal(isBuyerVisible({ active: true, fetch_status: status }), false, status);
  assert.equal(isBuyerVisible({ active: false, fetch_status: 'ok' }), false);
});

test('options and variants must fit together', () => {
  const options = [{ name: 'Size', values: ['S', 'M', 's'] }, { name: 'Colour', values: ['Red'] }];
  const ok = checkOptionsAndVariants(options, [{ optionValues: ['s', 'red'], sku: 'A', pricePaise: 100, mrpPaise: 150 }, { optionValues: ['M', 'Red'], sku: '', pricePaise: 200 }]);
  assert.deepEqual(ok.options, [{ name: 'Size', values: ['S', 'M'] }, { name: 'Colour', values: ['Red'] }], 'a value listed twice is one value');
  assert.deepEqual(ok.variants.map((v) => v.optionValues), [['S', 'Red'], ['M', 'Red']], 'a variant takes the option’s own spelling');
  const bad = (o, v, pattern) => assert.throws(() => checkOptionsAndVariants(o, v), (err) => err instanceof ValidationError && pattern.test(err.message));
  bad(options, [{ optionValues: ['S'], pricePaise: 1 }], /one value for every option/);
  bad(options, [{ optionValues: ['XL', 'Red'], pricePaise: 1 }], /doesn’t have/);
  bad(options, [{ optionValues: ['S', 'Red'], pricePaise: 1 }, { optionValues: ['s', 'RED'], pricePaise: 2 }], /same options/);
  bad(options, [{ optionValues: ['S', 'Red'], pricePaise: 500, mrpPaise: 499 }], /MRP can’t be lower/);
  bad(options, [{ optionValues: ['S', 'Red'], sku: 'X', pricePaise: 1 }, { optionValues: ['M', 'Red'], sku: 'X', pricePaise: 1 }], /used twice/);
  bad(options, [{ optionValues: ['S', 'Red'], pricePaise: -1 }], /price/);
  bad([{ name: 'Size', values: ['S'] }, { name: 'size', values: ['M'] }], [], /listed twice/);
  bad([1, 2, 3, 4].map((n) => ({ name: `O${n}`, values: ['a'] })), [], /at most 3/);
  bad([], [{ optionValues: [], pricePaise: 1 }, { optionValues: [], pricePaise: 2 }], /one variant at most/);
  assert.deepEqual(legacyOption(ok.options, ok.variants), { option_label: 'Size / Colour', option_values: ['S / Red', 'M / Red'] });
  assert.deepEqual(legacyOption([{ name: 'Size', values: ['S', 'M'] }], []), { option_label: 'Size', option_values: ['S', 'M'] });
});

// ---- 8.6: CSV ----

test('CSV is read with or without a byte order mark, with quotes, commas and line breaks inside cells, and by line number', () => {
  const text = '﻿title,url,price\r\n"Pot, big","https://a.example/p/1","₹1,299"\n\n"Two\nlines",,5\r\nLast,https://a.example/p/3,7';
  const { columns, rows } = readCsvFile(Buffer.from(text, 'utf8'));
  assert.deepEqual(columns, ['title', 'url', 'price']);
  assert.deepEqual(rows.map((r) => [r.line, r.cells.title, r.cells.price]), [[2, 'Pot, big', '₹1,299'], [4, 'Two\nlines', '5'], [6, 'Last', '7']]);
  assert.equal(rowToProduct(rows[0].cells).pricePaise, 129900, 'K-19: "₹1,299" is 129900 paise');
  assert.deepEqual(parseCsv('a;b;c\n1;"x;y";3').map((r) => r.cells), [['a', 'b', 'c'], ['1', 'x;y', '3']], 'a spreadsheet that separates with semicolons');
  assert.deepEqual(parseCsv('a,b\n"he said ""hi""",2').at(1).cells, ['he said "hi"', '2']);
  assert.deepEqual(readCsvFile(Buffer.from('Name,Link,Price,In Stock\nPot,https://a.example/p,10,no')).columns, ['title', 'url', 'price', 'in_stock'], 'common header names are understood');
});

test('a file that is not UTF-8, too long, or has no usable header is refused whole', () => {
  assert.throws(() => decodeCsv(Buffer.from([0xff, 0xfe, 0x74, 0x00])), rule('not_utf8'));
  assert.throws(() => decodeCsv(Buffer.from([0x74, 0x69, 0xe9, 0x74])), rule('not_utf8'), 'Latin-1 bytes');
  assert.throws(() => decodeCsv(Buffer.alloc(CATALOG_LIMITS.csvBytes + 1, 0x61)), rule('file_too_large'));
  assert.throws(() => readCsvFile(Buffer.from('colour,weight\nred,5')), rule('bad_row'));
  assert.throws(() => readCsvFile(Buffer.from('')), rule('bad_row'));
  const many = `title,price\n${'Pot,5\n'.repeat(CATALOG_LIMITS.csvRows + 1)}`;
  assert.throws(() => readCsvFile(Buffer.from(many)), rule('too_many_rows'));
  assert.equal(readCsvFile(Buffer.from(`title,price\n${'Pot,5\n'.repeat(CATALOG_LIMITS.csvRows)}`)).rows.length, CATALOG_LIMITS.csvRows);
});

test('a row says what it says and nothing more; a bad cell names its reason', () => {
  const row = rowToProduct({ title: ' Brass  pot ', url: 'https://WWW.a.example/p/1/?utm_source=x', price: 'Rs. 1,299.50', mrp: '1500', images: 'https://a.example/1.png | javascript:alert(1) | /relative.png', category: 'Garden|Home', sku: ' BR-1 ', in_stock: 'No', options: 'Size: S|M; Colour = Red' });
  assert.deepEqual(row, {
    name: 'Brass pot', externalUrl: 'https://a.example/p/1', pricePaise: 129950, mrpPaise: 150000, images: ['https://a.example/1.png'], categories: ['Garden', 'Home'], sku: 'BR-1', inStock: false,
    options: [{ name: 'Size', values: ['S', 'M'] }, { name: 'Colour', values: ['Red'] }],
  });
  const blank = rowToProduct({ title: '', url: '', price: '', sku: 'BR-1' });
  assert.deepEqual([blank.name, blank.pricePaise, blank.mrpPaise, blank.inStock, blank.images], [undefined, undefined, undefined, undefined, undefined], 'a blank cell changes nothing');
  assert.equal(rowToProduct({ title: 'x', price: '100', mrp: '100' }).mrpPaise, null, 'an MRP equal to the price is no MRP');
  assert.throws(() => rowToProduct({ title: 'x', price: '-5' }), rule('negative_price'));
  assert.throws(() => rowToProduct({ title: 'x', price: '(5)' }), rule('negative_price'));
  assert.throws(() => rowToProduct({ title: 'x', price: 'five' }), rule('bad_price'));
  assert.throws(() => rowToProduct({ title: 'x', price: '1e3' }), rule('bad_price'));
  assert.throws(() => rowToProduct({ title: 'x', price: '99999999999' }), rule('bad_price'), 'above ₹100 crore is a misread');
  assert.throws(() => rowToProduct({ title: 'x', price: '1299', mrp: '999' }), rule('mrp_below_price'));
  assert.throws(() => rowToProduct({ title: 'x', url: 'not a link', price: '5' }), rule('bad_row'));
  assert.throws(() => rowToProduct({ title: 'x', price: '5', in_stock: 'maybe' }), rule('bad_row'));
  assert.throws(() => rowToProduct({ title: 'x', price: '5', options: 'just words' }), rule('bad_row'));
  assert.throws(() => rowToProduct({ title: '', url: '', sku: '' }), rule('bad_row'));
});

test('a cell that a spreadsheet would run as a formula is made plain text on the way out', () => {
  for (const [value, cell] of [['=1+1', "'=1+1"], ['+91 98', "'+91 98"], ['-5', "'-5"], ['@SUM(A1)', "'@SUM(A1)"], ['  =HYPERLINK("x")', '"\'  =HYPERLINK(""x"")"'], ['\t=1', '"\'\t=1"'], ['\r=1', '"\'\r=1"']]) {
    assert.equal(csvCell(value), cell, JSON.stringify(value));
  }
  assert.equal(csvCell('Brass pot'), 'Brass pot');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(1299), '1299');
  assert.equal(toCsv([['name', 'note'], ['=cmd|\' /C calc\'!A0', 'ok']]), 'name,note\r\n\'=cmd|\' /C calc\'!A0,ok\r\n');
  const report = importReportCsv([{ line: 3, url: 'https://a.example/p', sku: '=SKU', status: 'refused', message: 'The price can’t be negative.', draft: { cells: { title: '@evil' } } }]);
  assert.equal(report.split('\r\n')[1], "3,https://a.example/p,'=SKU,'@evil,refused,The price can’t be negative.");
});

// ---- 8.4: adapters ----

test('an adapter’s product is cleaned like any other outside text, and a non-product is an error', () => {
  const draft = draftFromAdapter({ id: 7, title: 'Steel <i>bottle</i>', price: 349, mrp: 499, inStock: false, url: 'https://api.example/p/steel-bottle?utm_source=x', images: ['https://api.example/img/1.png', 'data:x'], description: '<p>Keeps cold.</p>' }, 'https://api.example/p/steel-bottle');
  assert.deepEqual([draft.name, draft.pricePaise, draft.mrpPaise, draft.inStock, draft.externalUrl, draft.ref, draft.description], ['Steel bottle', 34900, 49900, false, 'https://api.example/p/steel-bottle', '7', 'Keeps cold.']);
  assert.deepEqual(draft.images, ['https://api.example/img/1.png']);
  assert.equal(draftFromAdapter({ name: 'In paise', pricePaise: 12345 }, 'https://api.example/p/x').pricePaise, 12345);
  for (const bad of [null, 'text', [], {}, { title: '' }]) assert.throws(() => draftFromAdapter(bad, 'https://api.example/p/x'), /adapter/i);
  const registry = createAdapterRegistry([{ name: 'api-site', label: 'API site', match: (url) => url.startsWith('https://api.example/p/'), fetchProduct: async () => ({}) }, { name: 'thrower', match: () => { throw new Error('boom'); }, fetchProduct: async () => ({}) }]);
  assert.equal(registry.find('https://api.example/p/1', ['api-site', 'thrower']).name, 'api-site');
  assert.equal(registry.find('https://api.example/p/1', []), null, 'an adapter the business may not use matches nothing');
  assert.equal(registry.find('https://other.example/p/1', ['thrower']), null, 'a match() that throws matches nothing');
  assert.throws(() => createAdapterRegistry([{ name: 'Bad Name', match() {}, fetchProduct() {} }]), /name/);
  assert.throws(() => createAdapterRegistry([{ name: 'a', match() {}, fetchProduct() {} }, { name: 'a', match() {}, fetchProduct() {} }]), /Two site adapters/);
});

test('a stored draft leaves the server only in the contract’s shape', () => {
  assert.equal(toApiDraft({ cells: { title: 'x' } }), null, 'a CSV row is not a draft');
  assert.equal(toApiDraft(null), null);
  const draft = toApiDraft({ name: 'Pot', pricePaise: -5, mrpPaise: 'x', images: ['https://a.example/1.png', 7], variants: [{ optionValues: ['S'], pricePaise: 100 }, { pricePaise: 'bad' }], handle: 'secret-field', mrpKnown: true });
  assert.deepEqual(draft, { name: 'Pot', description: '', externalUrl: '', pricePaise: null, mrpPaise: null, inStock: true, images: ['https://a.example/1.png'], tags: [], suggestedCategories: [], options: [], variants: [{ optionValues: ['S'], sku: '', pricePaise: 100, mrpPaise: null, inStock: true }], source: 'link', sourceRef: '' });
});

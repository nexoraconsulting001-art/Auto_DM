// PRD 8.6: CSV upload and bulk paste. A bad row never blocks good rows; rows are matched on sku, then url; money is whole paise
// however the cell is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_LIMITS, IMPORT_REASONS, addP3Shop, assertLines, assertNoLiveMarkup, csvText, importCsv, need, plain, png, textOf, turnedAway, unique,
  uploadCsv, useP3World,
} from './kit.js';

const world = useP3World();

const count = async (shop, table, where = 'true') => (await shop.sql(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND (${where})`, [shop.tenantId]))[0].n;
const NEGATIVE_ROWS = [7, 250, 499];

/** 500 rows; rows 7, 250 and 499 (counting the first data row as 1) have negative prices. */
function fiveHundred({ price = (n) => String(100 + n), tag = unique() } = {}) {
  return Array.from({ length: 500 }, (_, i) => {
    const n = i + 1;
    return { title: `Row product ${n}`, url: `https://csv-${tag}.example/p/${n}`, price: NEGATIVE_ROWS.includes(n) ? '-50' : price(n), mrp: '', images: '', category: n % 2 ? 'Kitchen' : 'Garden', sku: `SKU-${tag}-${n}`, in_stock: n % 5 ? 'yes' : 'no', options: '' };
  });
}

// ---- K-18 ------------------------------------------------------------------------------------------------------------------

test('K-18: a CSV of 500 rows with 3 negative prices imports 497 and reports the 3 by line', { timeout: 420_000 }, async () => {
  const shop = await addP3Shop(world);
  const rows = fiveHundred();
  const job = await importCsv(world, shop, csvText(rows));
  assert.equal(job.status, 'done', `${job.status}: ${job.message}`);
  assert.equal(job.kind, 'csv');
  assert.equal(job.total, 500);
  assert.equal(job.created, 497);
  assert.equal(job.refused + job.failed, 3);
  assert.equal(await count(shop, 'products'), 497);
  const bad = await turnedAway(shop, job.id);
  assert.equal(bad.length, 3);
  assertLines(bad, NEGATIVE_ROWS, 'The negative prices');
  for (const item of bad) {
    assert.equal(item.reason, 'negative_price');
    assert.ok(plain(item.message).includes(plain(IMPORT_REASONS.negative_price)), item.message);
    assert.equal(item.productId, null);
  }
  assert.equal(await count(shop, 'products', 'price_paise < 0'), 0);
  const [sample] = await shop.sql('SELECT * FROM products WHERE tenant_id = $1 AND external_url = $2', [shop.tenantId, rows[41].url]);
  assert.equal(sample.name, 'Row product 42');
  assert.equal(Number(sample.price_paise), 14200, '"142" rupees is 14200 paise');
  assert.equal(sample.source, 'csv');
  assert.equal(sample.in_stock, true);
  const [soldOut] = await shop.sql('SELECT in_stock FROM products WHERE tenant_id = $1 AND external_url = $2', [shop.tenantId, rows[44].url]);
  assert.equal(soldOut.in_stock, false, 'in_stock "no" is read');
});

test('K-18: every kind of bad row is reported by line with its reason, and the good rows around it still import', async () => {
  const shop = await addP3Shop(world);
  const tag = unique();
  const good = (n, extra = {}) => ({ title: `Good ${n}`, url: `https://rows-${tag}.example/p/${n}`, price: '100', mrp: '', images: '', category: '', sku: `G-${tag}-${n}`, in_stock: 'yes', options: '', ...extra });
  const rows = [
    good(1),
    good(2, { price: 'abc' }), // bad_price
    good(3, { price: '1299.999' }), // bad_price: never rounded
    good(4, { price: '1299', mrp: '999' }), // mrp_below_price
    good(5, { title: '' }), // bad_row
    good(6, { price: '-0.01' }), // negative_price
    good(7, { price: '(100)' }), // negative_price, accountant's style
    good(8, { url: 'javascript:alert(1)' }), // bad_row
    good(9, { url: 'http://10.0.0.5/admin', sku: '' }), // not a product address
    good(10, { price: '1e5' }), // bad_price
    good(11, { price: '99999999999999' }), // bad_price: above the cap
    good(12, { price: '0.1' }), // fine: 10 paise
    good(13, { price: '₹1,29,900.50', mrp: 'Rs. 1,50,000/-' }), // fine
    good(14, { price: '1,299', mrp: '1,299' }), // fine: MRP equal to the price is no MRP
  ];
  const job = await importCsv(world, shop, csvText(rows));
  assert.equal(job.status, 'done', job.message);
  const bad = await turnedAway(shop, job.id);
  const reasonOf = (n) => bad.find((i) => i.url === rows[n - 1].url || i.sku === rows[n - 1].sku)?.reason;
  assert.equal(reasonOf(2), 'bad_price');
  assert.equal(reasonOf(3), 'bad_price', '1299.999 is refused, not rounded to 1300');
  assert.equal(reasonOf(4), 'mrp_below_price');
  assert.equal(reasonOf(6), 'negative_price');
  assert.equal(reasonOf(7), 'negative_price');
  assert.equal(reasonOf(10), 'bad_price');
  assert.equal(reasonOf(11), 'bad_price');
  assert.ok(reasonOf(5), 'A row with no title is reported');
  assert.ok(reasonOf(8), 'A javascript: address is reported');
  assert.equal(await count(shop, 'products', `external_url ~ '^javascript'`), 0);
  const names = (await shop.productRows()).map((r) => r.name).sort();
  for (const n of [1, 12, 13, 14]) assert.ok(names.includes(`Good ${n}`), `Good row ${n} imported; have ${names.join(', ')}`);
  for (const n of [2, 3, 4, 6, 7, 10, 11]) assert.ok(!names.includes(`Good ${n}`), `Bad row ${n} was imported`);
  const row = async (n) => (await shop.sql('SELECT price_paise, mrp_paise FROM products WHERE tenant_id = $1 AND name = $2', [shop.tenantId, `Good ${n}`]))[0];
  assert.equal(Number((await row(12)).price_paise), 10);
  assert.deepEqual([Number((await row(13)).price_paise), Number((await row(13)).mrp_paise)], [12990050, 15000000]);
  assert.deepEqual([Number((await row(14)).price_paise), (await row(14)).mrp_paise], [129900, null]);
});

test('K-18: formula cells, markup and quoted commas and newlines are stored as plain text and never run', async () => {
  const shop = await addP3Shop(world);
  const tag = unique();
  const titles = ['=HYPERLINK("http://evil.example","Click")', '+cmd|\' /C calc\'!A0', '@SUM(1+1)*cmd', '-2+3+cmd|\' /C calc\'!A0', '<script>alert(1)</script>Lamp', 'Mug, large "blue"\nsecond line', '\t=1+1', 'Tray & Bowl #2'];
  const rows = titles.map((title, i) => ({ title, url: `https://formula-${tag}.example/p/${i}`, price: '100', mrp: '', images: '', category: '=cmd', sku: `F-${tag}-${i}`, in_stock: '', options: 'Size=S|M' }));
  const job = await importCsv(world, shop, csvText(rows, { eol: '\r\n' }));
  assert.equal(job.status, 'done', job.message);
  assert.equal(job.total, titles.length, 'A quoted newline is one row, not two');
  const stored = await shop.productRows();
  assert.equal(stored.length + (job.refused + job.failed), titles.length);
  const norm = (text) => text.replace(/^'/, '').replace(/\s+/g, ' ').trim();
  for (const r of stored) {
    assert.ok(titles.some((t) => norm(t) === norm(r.name)), `A title was changed into something else: ${JSON.stringify(r.name)}`);
    assert.equal(Number(r.price_paise), 10000);
  }
  await shop.sql('UPDATE products SET active = true WHERE tenant_id = $1', [shop.tenantId]);
  const landing = await shop.page({ productIds: stored.map((r) => r.id) });
  const html = need(await shop.open(`/r/${landing.slug}`), 200, 'The landing page').text;
  assertNoLiveMarkup(html, 'The landing page');
  assert.ok(textOf(html).includes('Tray & Bowl #2'));
  const items = await shop.items(job.id);
  assert.ok(items.every((i) => !/^[=+@]/.test(i.message)), 'A report line never starts with a formula');
});

test('K-18: rows are matched on sku, then url, inside the one business only', async () => {
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  const tag = unique();
  const url = `https://match-${tag}.example/p/1`;
  const theirs = await b.product({ name: 'Theirs', pricePaise: 55500, externalUrl: url });
  const rows = [
    { title: 'First', url, price: '100', sku: `M-${tag}`, mrp: '', images: '', category: '', in_stock: '', options: '' },
    { title: 'Same sku, new address', url: `https://match-${tag}.example/p/2`, price: '200', sku: `M-${tag}`, mrp: '', images: '', category: '', in_stock: '', options: '' },
    { title: 'No sku, first address', url: `https://match-${tag}.example/p/3`, price: '300', sku: '', mrp: '', images: '', category: '', in_stock: '', options: '' },
    { title: 'No sku, same address again', url: `https://www.match-${tag}.example/p/3/?utm_source=x`, price: '400', sku: '', mrp: '', images: '', category: '', in_stock: '', options: '' },
  ];
  const job = await importCsv(world, a, csvText(rows));
  assert.equal(job.status, 'done', job.message);
  assert.equal(await count(a, 'products'), 2, 'Four rows are two products: one per sku, one per address');
  assert.equal(job.created, 2);
  assert.equal(job.updated, 2);
  const still = await b.getProduct(theirs.id);
  assert.deepEqual([still.name, still.pricePaise], ['Theirs', 55500], 'Another business\'s product with the same address is untouched');
  assert.equal(await count(b, 'products'), 1);
  const prices = (await a.productRows()).map((r) => Number(r.price_paise)).sort((x, y) => x - y);
  assert.deepEqual(prices, [20000, 40000], 'The later row wins');
});

test('K-18: files that are too big, too long, not UTF-8, empty or not CSV at all are refused whole, with nothing imported', async () => {
  const shop = await addP3Shop(world);
  const row = (n) => ({ title: `Bulk ${n}`, url: `https://big.example/p/${n}`, price: '100', mrp: '', images: '', category: '', sku: '', in_stock: '', options: '' });
  const tooLong = csvText(Array.from({ length: CATALOG_LIMITS.csvRows + 1 }, (_, i) => row(i)));
  const tooBig = Buffer.concat([Buffer.from(csvText([row(1)])), Buffer.alloc(CATALOG_LIMITS.csvBytes + 1024, 0x20)]);
  const latin1 = Buffer.concat([Buffer.from('title,url,price\n'), Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x6d, 0x75, 0x67]), Buffer.from(',https://big.example/p/cafe,100\n')]);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('title,url,price\nMug,https://big.example/p/m,100\n', 'utf16le')]);
  const cases = [
    ['more than 2,000 rows', tooLong, {}, 'too_many_rows'],
    ['more than 2 MB', tooBig, {}, 'file_too_large'],
    ['Latin-1', latin1, {}, 'not_utf8'],
    ['UTF-16', utf16, {}, 'not_utf8'],
    ['a PNG named .csv', png({ width: 64, height: 64 }), {}, null],
    ['an empty file', Buffer.alloc(0), {}, null],
    ['only a header', 'title,url,price\n', {}, null],
    ['no title column', 'name,link\nMug,https://big.example/p/1\n', {}, null],
    ['an executable type', csvText([row(1)]), { filename: 'products.exe', mime: 'application/x-msdownload' }, null],
  ];
  for (const [what, data, options, code] of cases) {
    const res = await uploadCsv(world, shop, data, options);
    assert.ok(res.status < 500, `${what}: answered ${res.status} ${res.text.slice(0, 200)}`);
    if (res.status === 202) {
      const job = await shop.job(res.json().id);
      assert.equal(job.created, 0, `${what}: imported ${job.created}`);
      if (code) assert.deepEqual([job.status, job.errorCode], ['failed', code], `${what}: ${job.message}`);
    } else {
      assert.ok([400, 413, 415].includes(res.status), `${what}: answered ${res.status}`);
      if (code) assert.ok(plain(res.text).includes(plain(IMPORT_REASONS[code])), `${what}: the owner is told "${IMPORT_REASONS[code]}": ${res.text.slice(0, 200)}`);
    }
  }
  assert.equal(await count(shop, 'products'), 0);
});

test('K-18: the same CSV uploaded twice at the same moment imports each row once', async () => {
  const shop = await addP3Shop(world);
  const tag = unique();
  const rows = Array.from({ length: 20 }, (_, i) => ({ title: `Twin ${i}`, url: `https://twin-${tag}.example/p/${i}`, price: '250', mrp: '300', images: '', category: '', sku: `T-${tag}-${i}`, in_stock: 'yes', options: '' }));
  const sent = await Promise.all([uploadCsv(world, shop, csvText(rows)), uploadCsv(world, shop, csvText(rows))]);
  for (const res of sent) assert.ok([202, 409].includes(res.status), `An upload answered ${res.status}: ${res.text.slice(0, 200)}`);
  for (const res of sent.filter((r) => r.status === 202)) assert.ok(['done', 'failed'].includes((await shop.job(res.json().id)).status));
  assert.equal(await count(shop, 'products'), 20);
  assert.equal((await shop.sql('SELECT count(DISTINCT external_url)::int AS n FROM products WHERE tenant_id = $1', [shop.tenantId]))[0].n, 20);
});

// ---- K-19 ------------------------------------------------------------------------------------------------------------------

test('K-19: the same CSV again, with a BOM and "₹1,299", makes 0 new and updates 497 to 129900 paise', { timeout: 600_000 }, async () => {
  const shop = await addP3Shop(world);
  const tag = unique();
  const first = await importCsv(world, shop, csvText(fiveHundred({ tag })));
  assert.equal(first.created, 497, `${first.status}: ${first.message}`);
  const again = csvText(fiveHundred({ tag, price: () => '₹1,299' }), { bom: true });
  assert.ok(again.startsWith('﻿'));
  const job = await importCsv(world, shop, again);
  assert.equal(job.status, 'done', job.message);
  assert.equal(job.created, 0, '0 new');
  assert.equal(job.updated, 497, '497 updated');
  assert.equal(job.refused + job.failed, 3, 'The same 3 rows are still reported');
  assert.equal(await count(shop, 'products'), 497, 'No duplicates');
  assert.equal(await count(shop, 'products', 'price_paise = 129900'), 497, 'Every price is 129900 paise');
  assert.equal(await count(shop, 'products', `name LIKE '%' || chr(65279) || '%'`), 0, 'The BOM is not part of any text');
  assertLines(await turnedAway(shop, job.id), NEGATIVE_ROWS, 'The negative prices');
});

test('K-19: a BOM never hides the first column, and an upload never overwrites what the owner typed', async () => {
  const shop = await addP3Shop(world);
  const tag = unique();
  const rows = [{ title: 'Copper jug', url: `https://bom-${tag}.example/p/1`, price: '₹1,299', mrp: '₹1,499.00', images: '', category: 'Kitchen', sku: `B-${tag}`, in_stock: 'yes', options: '' }];
  const first = await importCsv(world, shop, csvText(rows, { bom: true, eol: '\r\n' }));
  assert.equal(first.created, 1, `With a BOM the title column is still found: ${first.message}`);
  const [row] = await shop.productRows();
  assert.equal(row.name, 'Copper jug');
  assert.deepEqual([Number(row.price_paise), Number(row.mrp_paise)], [129900, 149900]);
  await shop.must('PATCH', `/products/${row.id}`, { name: 'Jug the owner renamed' });
  const second = await importCsv(world, shop, csvText([{ ...rows[0], title: 'Copper jug v2', price: '1,399' }]));
  assert.deepEqual([second.created, second.updated], [0, 1]);
  const after = await shop.getProduct(row.id);
  assert.equal(after.pricePaise, 139900, 'The price follows the file');
  assert.equal(await count(shop, 'products'), 1);
});

// ---- K-20 ------------------------------------------------------------------------------------------------------------------

test('K-20: pasting 26 links is refused with the limit message, and none is fetched', async () => {
  const shop = await addP3Shop(world);
  const mark = world.dials.length;
  const urls = Array.from({ length: 26 }, (_, i) => `https://shop.example/products/bulk-${i}`);
  const res = await shop.send('POST', '/imports/bulk', { urls });
  assert.equal(res.status, 400, `26 links answered ${res.status}: ${res.text.slice(0, 200)}`);
  assert.ok(plain(res.text).includes('Paste up to 25 links at a time.'), `The limit message: ${res.text.slice(0, 300)}`);
  assert.equal(await count(shop, 'import_jobs'), 0, 'No job was made');
  assert.deepEqual(world.dialsSince(mark), [], 'Nothing was fetched');
  for (const body of [{ urls: [] }, { urls: 'https://shop.example/products/macrame' }, {}, { urls: [null] }, { urls: ['two links https://a.example https://b.example'] }, { urls: Array.from({ length: 5000 }, () => 'https://shop.example/products/macrame') }]) {
    const bad = await shop.send('POST', '/imports/bulk', body);
    assert.equal(bad.status, 400, `${JSON.stringify(body).slice(0, 60)} answered ${bad.status}`);
  }
  assert.equal(await count(shop, 'import_jobs'), 0);
});

test('K-20: 25 links are taken, each through the import and the gate, with a report per link', { timeout: 300_000 }, async () => {
  const shop = await addP3Shop(world);
  const good = ['brass-planter', 'terracotta-pot', 'macrame', 'og-only', 'og-price'].map((p) => `https://shop.example/products/${p}`);
  const refused = { 'https://shop.example/': 'homepage', 'https://shop.example/products/title-only': 'title_only', 'https://shop.example/products/site-name': 'site_name' };
  const failed = ['http://127.0.0.1/admin', 'https://toprivate.example/', 'https://gone.example/products/missing', 'https://loop.example/r/0', 'https://internal.example/x'];
  const filler = Array.from({ length: 25 - good.length - Object.keys(refused).length - failed.length }, (_, i) => {
    const path = `/products/filler-${unique()}`;
    world.sites.page('shop.example', path, { body: `<!doctype html><html><head><title>Filler ${i}</title><meta property="og:title" content="Filler ${i}"><meta property="product:price:amount" content="${100 + i}"></head></html>` });
    return `https://shop.example${path}`;
  });
  const urls = [...good, ...Object.keys(refused), ...failed, ...filler];
  assert.equal(urls.length, 25);
  const mark = world.dials.length;
  const job = need(await shop.send('POST', '/imports/bulk', { urls }), 202, 'Pasting 25 links').json();
  const done = await shop.job(job.id, 240_000);
  assert.equal(done.status, 'done', `${done.status}: ${done.message}`);
  assert.equal(done.total, 25);
  const items = await shop.items(job.id);
  assert.equal(items.length, 25, 'One report line per link');
  const of = (url) => items.find((i) => i.url === url);
  for (const url of [...good, ...filler]) assert.ok(['draft', 'created'].includes(of(url)?.status), `${url}: ${JSON.stringify(of(url))}`);
  for (const [url, reason] of Object.entries(refused)) assert.deepEqual([of(url)?.status, of(url)?.reason], ['refused', reason], url);
  for (const url of failed) assert.ok(['refused', 'failed'].includes(of(url)?.status), `${url}: ${of(url)?.status}`);
  assert.equal(of('http://127.0.0.1/admin').reason, 'blocked');
  assert.equal(of('https://toprivate.example/').reason, 'blocked');
  assert.equal(of('https://loop.example/r/0').reason, 'too_many_redirects');
  assert.equal(of('https://gone.example/products/missing').reason, 'http_status');
  assert.ok(world.dialsSince(mark).every((d) => d.address === '93.184.216.34'), 'No private address was connected');
  assert.equal(done.refused + done.failed, Object.keys(refused).length + failed.length);
  assert.equal(of(good[0]).draft?.pricePaise ?? null, 129900);
});

test('K-20: the same link several times in one paste, or already in the catalog, is one product', async () => {
  const shop = await addP3Shop(world);
  const url = 'https://shop.example/products/og-price';
  const have = await shop.importAndSave('https://shop.example/products/macrame');
  const job = need(await shop.send('POST', '/imports/bulk', { urls: [url, `${url}?utm_source=ig`, `${url}/`, 'https://shop.example/products/macrame'] }), 202, 'Pasting').json();
  const done = await shop.job(job.id);
  assert.equal(done.status, 'done', done.message);
  const items = await shop.items(job.id);
  assert.equal(items.find((i) => i.url.includes('macrame'))?.status, 'existing');
  assert.equal(items.find((i) => i.url.includes('macrame'))?.productId, have);
  for (const item of items.filter((i) => i.status === 'draft')) {
    const res = await shop.send('POST', `/import-items/${item.id}/save`, { name: item.draft.name, pricePaise: item.draft.pricePaise ?? 0, externalUrl: item.draft.externalUrl, active: true });
    assert.ok(res.status < 500, `Saving a repeated link crashed: ${res.status}`);
  }
  assert.equal(await count(shop, 'products', `external_url LIKE '%og-price%'`), 1, 'The repeated link is one product');
  assert.equal(await count(shop, 'products'), 2);
});

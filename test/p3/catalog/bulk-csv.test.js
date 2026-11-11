// Bulk paste and CSV upload (PRD 8.6): many products at once, a report per link or line, and a bad one never blocking a good
// one. The worker's jobs are run by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importReportCsv } from '../../../src/modules/imports/csv.js';
import { RUN } from '../../../src/modules/imports/index.js';
import { csvText, openWorld } from './support.js';

const SHOP = 'https://shop.example/products';

test('K-20: pasting 26 links is refused with the limit message, and 25 are taken', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const urls = Array.from({ length: 26 }, (_, i) => `${SHOP}/p-${i}`);
  const refused = await shop.call('/imports/bulk', { method: 'POST', body: { urls } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().fields.urls, 'Paste up to 25 links at a time.');
  assert.deepEqual((await shop.json('/imports')).items, []);
  const taken = await shop.post('/imports/bulk', { urls: urls.slice(0, 25) }, 202);
  assert.deepEqual([taken.kind, taken.status, taken.total], ['bulk', 'queued', 25]);
  assert.equal((await shop.call('/imports/bulk', { method: 'POST', body: { urls: [] } })).status, 400);
});

test('each pasted link goes through the reader and the gate, and the report says what became of each', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const urls = [
    `${SHOP}/brass-planter`, `${SHOP}/og-only`, `${SHOP}/title-only`, 'https://shop.example/', 'https://gone.example/products/missing',
    `${SHOP}/terracotta-pot`, `${SHOP}/brass-planter?utm_source=ig`, 'http://127.0.0.1/admin', `${SHOP}/macrame`,
  ];
  const job = await shop.importAndRun('/imports/bulk', { urls });
  assert.deepEqual([job.status, job.total, job.created, job.refused, job.failed], ['done', 9, 3, 2, 2]);
  assert.ok(job.finishedAt);
  const items = await shop.items(job.id);
  assert.deepEqual(items.map((i) => [i.line, i.status, i.reason]), [
    [1, 'created', null], [2, 'draft', null], [3, 'refused', 'title_only'], [4, 'refused', 'homepage'], [5, 'failed', 'http_status'],
    [6, 'created', null], [7, 'existing', 'duplicate'], [8, 'failed', 'blocked'], [9, 'created', null],
  ]);
  assert.equal(items[1].message, 'No price was found. Add one to save this product.', 'K-23: accepted by the gate, waiting for a price');
  assert.equal(items[3].message, 'This looks like the homepage, not a product.');
  assert.equal(items[7].message, 'That address isn’t a public website');
  assert.equal(items[6].productId, items[0].productId, 'the same page pasted twice is one product');
  assert.deepEqual((await shop.items(job.id, 'status=refused')).map((i) => i.line), [3, 4]);

  const products = await shop.products();
  assert.deepEqual(products.map((p) => p.name).sort(), ['Brass planter', 'Hanging macrame', 'Terracotta pot']);
  const pot = products.find((p) => p.name === 'Terracotta pot');
  assert.deepEqual([pot.display.pricePaise, pot.display.soldOut, pot.source, pot.priceManual], [59900, false, 'link', false], 'K-03: the lowest in-stock variant');
  const brass = await shop.json(`/products/${items[0].productId}`);
  assert.deepEqual([brass.pricePaise, brass.inStock, brass.fetchStatus], [129900, false, 'ok']);
  assert.match(brass.images[0], /^\/media\//, 'the image job copied the first image into the business’s media');
  assert.equal(brass.gallery[0].sourceUrl, 'https://shop.example/img/brass.png');

  // The draft that waited for a price is saved by the owner.
  const saved = await shop.post(`/import-items/${items[1].id}/save`, { name: 'Jute basket', pricePaise: 45000 });
  assert.equal((await shop.json(`/products/${saved.productId}`)).priceManual, true);
  assert.equal((await shop.job(job.id)).created, 4);
});

test('a job runs only as its own business: a job id from another business does nothing', async (t) => {
  const world = await openWorld(t);
  const [a, b] = [await world.addShop(), await world.addShop()];
  const queued = await a.post('/imports/bulk', { urls: [`${SHOP}/brass-planter`] }, 202);
  // Someone gets a step of A's job queued under B's name.
  await world.drivers.queue.enqueue(RUN, { jobId: queued.id }, { tenantId: b.tenantId });
  await world.app.db.platform.query(`DELETE FROM jobs WHERE queue = $1 AND tenant_id = $2`, [RUN, a.tenantId]);
  await world.runJobs();
  assert.deepEqual(await b.products(), [], 'nothing was written into B');
  assert.deepEqual(await a.products(), [], 'and A’s job was not run by B');
  assert.equal((await a.job(queued.id)).status, 'queued');
  assert.equal((await b.call(`/imports/${queued.id}`)).status, 404);
  assert.equal((await b.call(`/imports/${queued.id}/items`)).status, 404);
});

test('K-18 and K-19: 500 rows with 3 negative prices import 497 and report 3 by line; the same file again, with a BOM and "₹1,299", makes 0 new and 497 updates', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const bad = new Set([7, 250, 499]); // 1-based data rows
  const rows = (price) => Array.from({ length: 500 }, (_, i) => [`Product ${i + 1}`, `https://x.example/p/${i + 1}`, bad.has(i + 1) ? '-5' : price(i), `SKU-${i + 1}`]);
  const header = ['title', 'url', 'price', 'sku'];

  const first = await shop.uploadCsv(csvText([header, ...rows((i) => String(100 + i))]));
  assert.equal(first.status, 202);
  assert.deepEqual([first.body.kind, first.body.status, first.body.total, first.body.source], ['csv', 'queued', 500, 'products.csv'], 'a file this size is for the worker');
  await world.runJobs();
  const job = await shop.job(first.body.id);
  assert.deepEqual([job.status, job.total, job.created, job.updated, job.refused, job.failed], ['done', 500, 497, 0, 3, 0]);
  const refused = await shop.items(job.id, 'status=refused');
  assert.deepEqual(refused.map((i) => [i.line, i.reason, i.message]), [...bad].map((n) => [n + 1, 'negative_price', 'The price can’t be negative.']), 'by line: the header is line 1');
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(n, 497);

  const second = await shop.uploadCsv(`﻿${csvText([header, ...rows(() => '₹1,299')])}`);
  await world.runJobs();
  const again = await shop.job(second.body.id);
  assert.deepEqual([again.status, again.created, again.updated, again.refused], ['done', 0, 497, 3]);
  const prices = await shop.sql('SELECT DISTINCT price_paise FROM products WHERE tenant_id = $1', [shop.tenantId]);
  assert.deepEqual(prices, [{ price_paise: 129900 }], '"₹1,299" is 129900 paise');
  const [{ n: after }] = await shop.sql('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(after, 497, 'no duplicates');
});

test('a small CSV is imported at once: upsert on SKU, then on the address; categories, options, stock and images follow the row', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const header = ['title', 'url', 'price', 'mrp', 'images', 'category', 'sku', 'in_stock', 'options'];
  const first = await shop.uploadCsv(csvText([
    header,
    ['Brass pot', 'https://x.example/p/brass', '1,299', '1,599', 'https://shop.example/img/a.png|https://shop.example/img/b.png', 'Garden', 'BR-1', 'yes', 'Size: S|M'],
    ['Clay lamp', 'https://x.example/p/lamp', '250', '', '', 'Garden|Lighting', '', 'no', ''],
    ['No price', 'https://x.example/p/none', '', '', '', '', '', '', ''],
    ['Cheap MRP', 'https://x.example/p/mrp', '1299', '999', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['Bad link', 'javascript:alert(1)', '5', '', '', '', '', '', ''],
  ]));
  assert.equal(first.status, 202);
  assert.deepEqual([first.body.status, first.body.total, first.body.created, first.body.refused], ['done', 5, 2, 3], 'a blank line is no row');
  const items = await shop.items(first.body.id);
  assert.deepEqual(items.map((i) => [i.line, i.status, i.reason]), [[2, 'created', null], [3, 'created', null], [4, 'refused', 'bad_price'], [5, 'refused', 'mrp_below_price'], [7, 'refused', 'bad_row']]);
  assert.equal(items[3].message, 'MRP can’t be lower than the price');

  const brass = await shop.json(`/products/${items[0].productId}`);
  assert.deepEqual([brass.name, brass.pricePaise, brass.mrpPaise, brass.source, brass.priceManual, brass.inStock, brass.externalUrl], ['Brass pot', 129900, 159900, 'csv', true, true, 'https://x.example/p/brass']);
  assert.deepEqual(brass.options, [{ name: 'Size', values: ['S', 'M'] }]);
  assert.equal(brass.images.length, 2);
  const lamp = await shop.json(`/products/${items[1].productId}`);
  assert.deepEqual([lamp.inStock, lamp.stock, lamp.display.soldOut], [false, 0, true]);
  const categories = (await shop.json('/categories')).items;
  assert.deepEqual(categories.map((c) => c.name).sort(), ['Garden', 'Lighting'], 'a category the file names is made once');
  assert.deepEqual(lamp.categoryIds.length, 2);

  // Again: the lamp by its address, a SKU added to it; the pot by its SKU with a new address and price; one new row.
  const second = await shop.uploadCsv(csvText([
    ['sku', 'url', 'price', 'title', 'in_stock'],
    ['BR-1', 'https://x.example/p/brass-v2', '1,199', '', ''],
    ['LAMP-1', 'https://x.example/p/lamp', '', 'Clay lamp, large', 'yes'],
    ['NEW-1', '', '75', 'Wick', ''],
    ['BR-1', 'https://x.example/p/lamp', '5', '', ''],
  ]));
  assert.deepEqual([second.body.created, second.body.updated, second.body.refused], [1, 2, 1]);
  const report = await shop.items(second.body.id);
  assert.deepEqual(report.map((i) => [i.status, i.reason, i.productId]), [['updated', null, brass.id], ['updated', null, lamp.id], ['created', null, report[2].productId], ['refused', 'duplicate', null]]);
  assert.equal(report[3].message, 'This product is already in your catalog.', 'a SKU and an address that belong to two products');
  const brass2 = await shop.json(`/products/${brass.id}`);
  assert.deepEqual([brass2.pricePaise, brass2.mrpPaise, brass2.externalUrl, brass2.name], [119900, 159900, 'https://x.example/p/brass-v2', 'Brass pot'], 'a blank cell changes nothing');
  const lamp2 = await shop.json(`/products/${lamp.id}`);
  assert.deepEqual([lamp2.name, lamp2.pricePaise, lamp2.inStock, lamp2.stock, lamp2.variants.map((v) => v.sku)], ['Clay lamp, large', 25000, true, null, ['LAMP-1']]);
  assert.equal((await shop.products()).length, 3);
});

test('a formula in a cell is stored as the text it is, and is made safe when a report is written out', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const res = await shop.uploadCsv(csvText([['title', 'price', 'sku'], ['=HYPERLINK("https://evil.example","Click")', '10', '=1+1'], ['@SUM(A1:A9)', '20', '+SKU'], ['<script>alert(1)</script>', '30', 'S3']]));
  assert.deepEqual([res.body.created, res.body.refused], [3, 0]);
  const names = (await shop.products()).map((p) => p.name).sort();
  assert.deepEqual(names, ['<script>alert(1)</script>', '=HYPERLINK("https://evil.example","Click")', '@SUM(A1:A9)'], 'text is kept as text, to be escaped where it is shown');
  const items = await shop.items(res.body.id);
  const lines = importReportCsv(items.map((i) => ({ ...i, draft: { name: names.find((n) => n.startsWith('=')) } }))).split('\r\n');
  assert.match(lines[1], /^2,,'=1\+1,"'=HYPERLINK\(""https:\/\/evil\.example"",""Click""\)",created,/);
  assert.match(lines[2], /^3,,'\+SKU,/);
});

test('a file that isn’t a usable CSV is refused whole, with what to do', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const utf16 = await shop.uploadCsv(Buffer.from('﻿title,price\nPot,5', 'utf16le'));
  assert.equal(utf16.status, 400);
  assert.equal(utf16.body.fields.file, 'Save the file as UTF-8 and upload it again.');
  const noHeader = await shop.uploadCsv('colour,weight\nred,5');
  assert.equal(noHeader.status, 400);
  assert.match(noHeader.body.fields.file, /column names/);
  const tooMany = await shop.uploadCsv(`title,price\n${'Pot,5\n'.repeat(2001)}`);
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.fields.file, 'Upload up to 2000 rows at a time.');
  const tooBig = await shop.uploadCsv(`title,price\n${'x'.repeat(2_100_000)},5`);
  assert.ok([400, 413].includes(tooBig.status), `over 2 MB is refused (${tooBig.status})`);
  const exe = await shop.uploadCsv('MZ', { filename: 'run.exe', type: 'application/x-msdownload' });
  assert.ok([400, 415].includes(exe.status), `not a CSV type (${exe.status})`);
  assert.deepEqual((await shop.json('/imports')).items, []);
  assert.deepEqual(await shop.products(), []);
});

test('one business’s CSV never touches another’s products, even with the same SKU and address', async (t) => {
  const world = await openWorld(t);
  const [a, b] = [await world.addShop(), await world.addShop()];
  const file = (price) => csvText([['title', 'url', 'price', 'sku'], ['Shared pot', 'https://x.example/p/shared', price, 'SHARED-1']]);
  const mine = await a.uploadCsv(file('100'));
  const theirs = await b.uploadCsv(file('900'));
  assert.deepEqual([mine.body.created, theirs.body.created], [1, 1], 'each business gets its own product');
  const again = await a.uploadCsv(file('150'));
  assert.deepEqual([again.body.created, again.body.updated], [0, 1]);
  assert.deepEqual((await a.products()).map((p) => p.pricePaise), [15000]);
  assert.deepEqual((await b.products()).map((p) => p.pricePaise), [90000], 'B’s price is as B set it');
  const rows = await a.sql('SELECT tenant_id, count(*)::int AS n FROM import_items GROUP BY tenant_id ORDER BY tenant_id');
  assert.deepEqual(rows, [{ tenant_id: a.tenantId, n: 2 }, { tenant_id: b.tenantId, n: 1 }]);
});

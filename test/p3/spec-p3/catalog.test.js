// PRD 8.1: one catalog per business, money in integer paise, MRP only above the price, the card price from the variants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addP3Shop, hit, need, plain, productIdsOf, textOf, useP3World } from './support.js';

const world = useP3World();

const MRP_MESSAGE = "MRP can't be lower than the price";

function assertMrpRefused(res, what) {
  assert.equal(res.status, 400, `${what}: expected 400, got ${res.status}: ${res.text.slice(0, 300)}`);
  const body = res.json();
  assert.ok(plain(JSON.stringify(body)).includes(MRP_MESSAGE), `${what}: the refusal doesn't say "${MRP_MESSAGE}": ${res.text.slice(0, 300)}`);
  return body;
}

// ---- K-01 ------------------------------------------------------------------------------------------------------------------

test('K-01: two businesses both save https://x.example/p/1; both succeed and each sees only its own row', async () => {
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  const url = 'https://x.example/p/1';
  const mine = await a.product({ name: 'Brass lamp A', externalUrl: url });
  const theirs = await b.product({ name: 'Brass lamp B', externalUrl: url });
  assert.equal(mine.externalUrl, url);
  assert.equal(theirs.externalUrl, url);

  const listA = await a.products();
  const listB = await b.products();
  assert.deepEqual(listA.map((p) => p.id), [mine.id], 'A lists its own product only');
  assert.deepEqual(listB.map((p) => p.id), [theirs.id], 'B lists its own product only');
  assert.deepEqual((await a.products('search=Brass')).map((p) => p.name), ['Brass lamp A'], 'A search never finds B');

  const rows = await a.sql('SELECT tenant_id FROM products WHERE external_url = $1 ORDER BY tenant_id', [url]);
  assert.deepEqual(rows.map((r) => Number(r.tenant_id)), [a.tenantId, b.tenantId].sort((x, y) => x - y));
});

test('K-01: one business can\'t read, change or delete another\'s product by its id', async () => {
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  const theirs = await b.product({ name: 'Copper bottle', externalUrl: 'https://copper.example/p/9', pricePaise: 89900 });
  for (const [method, body] of [['GET'], ['PATCH', { name: 'Hijacked', pricePaise: 100 }], ['DELETE'], ['POST', {}]]) {
    const path = method === 'POST' ? `/products/${theirs.id}/recheck` : `/products/${theirs.id}`;
    const res = await a.send(method, path, body);
    assert.equal(res.status, 404, `${method} ${path} from another business answered ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const still = await b.getProduct(theirs.id);
  assert.equal(still.name, 'Copper bottle');
  assert.equal(still.pricePaise, 89900);
});

test('K-01: the same external URL twice in one business, even at the same moment, is one product and never a server error', async () => {
  const a = await addP3Shop(world);
  const url = `https://dupe.example/p/${Date.now()}`;
  const answers = await Promise.all([1, 2, 3].map((n) => a.send('POST', '/products', { name: `Mug ${n}`, pricePaise: 29900, active: true, externalUrl: url })));
  for (const res of answers) assert.ok(res.status < 500, `A duplicate save crashed: ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(answers.filter((r) => r.status === 201).length, 1, `Saves answered ${answers.map((r) => r.status).join(', ')}`);
  for (const res of answers.filter((r) => r.status !== 201)) assert.ok([400, 409].includes(res.status), `A duplicate answered ${res.status}`);
  assert.equal((await a.sql('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND external_url = $2', [a.tenantId, url]))[0].n, 1);
});

test('K-01: a product can\'t point at another business\'s category or uploaded image', async () => {
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  const theirCategory = await b.category('Their kitchen');
  const theirImage = await b.upload('#AA3355');
  const res = await a.send('POST', '/products', { name: 'Steel tiffin', pricePaise: 45000, active: true, categoryIds: [theirCategory.id] });
  assert.ok([400, 404].includes(res.status), `Linking another business's category answered ${res.status}: ${res.text.slice(0, 200)}`);
  const withImage = await a.send('POST', '/products', { name: 'Steel tiffin', pricePaise: 45000, active: true, images: [theirImage] });
  assert.ok(withImage.status < 500, `Another business's image crashed the save: ${withImage.status}`);
  if (withImage.status === 201) {
    const saved = await a.getProduct(withImage.json().id);
    assert.ok(!JSON.stringify(saved.images).includes(theirImage.split('/').pop()), 'The product shows another business\'s file');
    assert.ok(!JSON.stringify(saved.gallery).includes(theirImage.split('/').pop()), 'The gallery shows another business\'s file');
  }
  const leak = await hit(world, theirImage, { host: a.host });
  assert.equal(leak.status, 404, `Another business's file answered ${leak.status} on this business's host`);
  const own = await hit(world, theirImage, { host: b.host });
  assert.equal(own.status, 200, 'The file still serves on its own business\'s host');
});

// ---- K-02 ------------------------------------------------------------------------------------------------------------------

test('K-02: MRP ₹999 with price ₹1,299 is refused: "MRP can\'t be lower than the price", and nothing is saved', async () => {
  const a = await addP3Shop(world);
  const body = assertMrpRefused(await a.send('POST', '/products', { name: 'Silk stole', pricePaise: 129900, mrpPaise: 99900, active: true }), 'Saving');
  assert.equal(body.code, 'validation_failed');
  assert.ok(body.fields?.mrpPaise, `The refusal names the MRP field: ${JSON.stringify(body)}`);
  assert.equal((await a.productRows()).length, 0);
});

test('K-02: lowering the MRP below the price, or raising the price above the MRP, is refused later too', async () => {
  const a = await addP3Shop(world);
  const p = await a.product({ name: 'Silk stole', pricePaise: 99900, mrpPaise: 129900 });
  assertMrpRefused(await a.send('PATCH', `/products/${p.id}`, { mrpPaise: 50000 }), 'Lowering the MRP');
  assertMrpRefused(await a.send('PATCH', `/products/${p.id}`, { pricePaise: 150000 }), 'Raising the price alone past the stored MRP');
  const kept = await a.getProduct(p.id);
  assert.deepEqual([kept.pricePaise, kept.mrpPaise], [99900, 129900], 'A refused change changes nothing');
  const [row] = await a.productRows();
  assert.deepEqual([Number(row.price_paise), Number(row.mrp_paise)], [99900, 129900]);
});

test('K-02: a variant whose MRP is below its price is refused', async () => {
  const a = await addP3Shop(world);
  const res = await a.send('POST', '/products', {
    name: 'Kurta', pricePaise: 59900, active: true, options: [{ name: 'Size', values: ['S', 'M'] }],
    variants: [{ optionValues: ['S'], pricePaise: 59900, mrpPaise: 79900 }, { optionValues: ['M'], pricePaise: 69900, mrpPaise: 49900 }],
  });
  assertMrpRefused(res, 'Saving a variant');
  assert.equal((await a.productRows()).length, 0);
});

test('K-02: an MRP equal to the price is stored as none; one above it shows struck through with "-N%"', async () => {
  const a = await addP3Shop(world);
  const same = await a.product({ name: 'Plain mug', pricePaise: 99900, mrpPaise: 99900 });
  assert.equal(same.mrpPaise, null, 'An MRP equal to the price is not kept');
  const off = await a.product({ name: 'Glazed mug', pricePaise: 75000, mrpPaise: 100000 });
  assert.equal(off.display?.discountPercent, 25, `The display shows 25% off: ${JSON.stringify(off.display)}`);
  assert.equal(off.display?.mrpPaise, 100000);
  const page = await a.page({ productIds: [same.id, off.id] });
  const html = need(await a.open(`/r/${page.slug}`), 200, 'The landing page').text;
  const text = textOf(html);
  assert.ok(text.includes('₹750'), 'The price shows');
  assert.ok(text.includes('₹1,000'), 'The MRP shows');
  assert.ok(text.includes('-25%'), 'The discount shows as -25%');
  const struck = [...html.matchAll(/<(s|del)\b[^>]*>([\s\S]*?)<\/\1>|<[a-z]+\b[^>]*class="[^"]*\b(was|mrp|strike)[^"]*"[^>]*>([^<]*)</gi)].map((m) => textOf(m[2] ?? m[4] ?? ''));
  assert.ok(struck.some((s) => s.includes('₹1,000')), `The MRP is struck through: ${JSON.stringify(struck)}`);
  assert.ok(!struck.some((s) => s.includes('₹999')), 'An MRP equal to the price is never shown struck through');
});

test('K-02: money is whole paise: fractions, negatives, text and numbers past 32 bits are refused, never rounded', async () => {
  const a = await addP3Shop(world);
  for (const pricePaise of [1299.5, -1, '129900', 2 ** 31, Number.MAX_SAFE_INTEGER, 1e21, null]) {
    const res = await a.send('POST', '/products', { name: 'Odd price', pricePaise, active: true });
    assert.equal(res.status, 400, `Price ${pricePaise} answered ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const res = await a.send('POST', '/products', { name: 'Odd MRP', pricePaise: 100, mrpPaise: 100.01, active: true });
  assert.equal(res.status, 400, `MRP 100.01 answered ${res.status}`);
  assert.equal((await a.productRows()).length, 0, 'Nothing was saved');
  const tiny = await a.product({ name: 'One paisa', pricePaise: 1 });
  assert.equal(tiny.pricePaise, 1);
  const big = await a.product({ name: 'Big ticket', pricePaise: 2147483647 });
  assert.equal(big.pricePaise, 2147483647, 'The largest input amount is kept exactly');
});

// ---- K-03 ------------------------------------------------------------------------------------------------------------------

const sizes = (variants) => ({ options: [{ name: 'Size', values: variants.map((v) => v.optionValues[0]) }], variants });

test('K-03: variants ₹499 (sold out) and ₹599 (in stock): the card shows ₹599', async () => {
  const a = await addP3Shop(world);
  const p = await a.product({
    name: 'Terracotta pot', pricePaise: 49900,
    ...sizes([{ optionValues: ['Small'], pricePaise: 49900, inStock: false }, { optionValues: ['Medium'], pricePaise: 59900, inStock: true }]),
  });
  const detail = await a.getProduct(p.id);
  assert.equal(detail.variants.length, 2, 'Both variants are stored');
  assert.deepEqual(detail.variants.map((v) => [v.pricePaise, v.inStock]), [[49900, false], [59900, true]]);
  assert.equal(detail.display?.pricePaise, 59900, `The card price: ${JSON.stringify(detail.display)}`);
  assert.equal(detail.display?.soldOut, false);
  const listed = (await a.products()).find((x) => x.id === p.id);
  assert.equal(listed.display?.pricePaise, 59900, 'The list shows the same card price');

  const page = await a.page({ productIds: [p.id] });
  const text = textOf(need(await a.open(`/r/${page.slug}`), 200, 'The landing page').text);
  assert.ok(text.includes('₹599'), 'The landing card shows ₹599');
  assert.ok(!text.includes('₹499'), 'The sold-out variant\'s price is not the card price');
  assert.ok(!/sold out/i.test(text), 'A product with a variant in stock is not sold out');
});

test('K-03: a cheaper variant in stock wins, with its own MRP and -N%', async () => {
  const a = await addP3Shop(world);
  const p = await a.product({
    name: 'Cotton saree', pricePaise: 89900,
    ...sizes([
      { optionValues: ['Red'], pricePaise: 89900, mrpPaise: 99900, inStock: true },
      { optionValues: ['Blue'], pricePaise: 59900, mrpPaise: 79900, inStock: true },
      { optionValues: ['Green'], pricePaise: 39900, mrpPaise: 99900, inStock: false },
    ]),
  });
  const { display } = await a.getProduct(p.id);
  assert.deepEqual(display, { pricePaise: 59900, mrpPaise: 79900, discountPercent: 25, soldOut: false });
});

test('K-03: every variant sold out shows the lowest price as Sold out, and the card moves last', async () => {
  const a = await addP3Shop(world);
  const gone = await a.product({
    name: 'Brass bell', pricePaise: 49900,
    ...sizes([{ optionValues: ['Small'], pricePaise: 49900, inStock: false }, { optionValues: ['Large'], pricePaise: 69900, inStock: false }]),
  });
  const there = await a.product({ name: 'Brass diya', pricePaise: 25000 });
  const { display } = await a.getProduct(gone.id);
  assert.deepEqual([display?.pricePaise, display?.soldOut], [49900, true]);
  const page = await a.page({ productIds: [gone.id, there.id] });
  const html = need(await a.open(`/r/${page.slug}`), 200, 'The landing page').text;
  assert.match(textOf(html), /sold out/i, 'The card says Sold out');
  assert.deepEqual(productIdsOf(html), [there.id, gone.id], 'Sold-out products move last (8.8)');
});

test('K-03: more than 3 options, 100 variants or 6 images are refused', async () => {
  const a = await addP3Shop(world);
  const image = await a.upload();
  const tooMany = [
    { options: ['A', 'B', 'C', 'D'].map((name) => ({ name, values: ['x'] })) },
    { options: [{ name: 'Size', values: ['x'] }], variants: Array.from({ length: 101 }, (_, i) => ({ optionValues: ['x'], sku: `V-${i}`, pricePaise: 100 })) },
    { images: Array.from({ length: 7 }, () => image) },
  ];
  for (const extra of tooMany) {
    const res = await a.send('POST', '/products', { name: 'Too much', pricePaise: 100, active: true, ...extra });
    assert.equal(res.status, 400, `${Object.keys(extra)} answered ${res.status}`);
  }
  assert.equal((await a.productRows()).length, 0);
});

test('K-03: one SKU names one variant in a business, but two businesses may share a SKU', async () => {
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  const variant = (sku) => sizes([{ optionValues: ['One'], sku, pricePaise: 10000 }]);
  await a.product({ name: 'First', ...variant('SKU-1') });
  const again = await a.send('POST', '/products', { name: 'Second', pricePaise: 10000, active: true, ...variant('SKU-1') });
  assert.ok([400, 409].includes(again.status), `A repeated SKU answered ${again.status}: ${again.text.slice(0, 200)}`);
  await b.product({ name: 'Theirs', ...variant('SKU-1') });
});

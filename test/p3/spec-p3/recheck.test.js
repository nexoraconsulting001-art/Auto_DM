// PRD 8.8: the scheduled re-check of imported products: dead links are hidden and flagged, changed prices follow the site unless
// the owner set the price by hand, sold-out products say so and move last.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addP3Shop, eventually, jsonLdPage, need, productIdsOf, sitePage, textOf, unique, useP3World } from './kit.js';

const world = useP3World();

/** A product page on gone.example made for one test, imported and saved. */
async function imported(shop, { name = `Bottle ${unique()}`, price = '999', availability = 'InStock' } = {}) {
  const path = `/products/item-${unique()}`;
  world.sites.page('gone.example', path, { body: jsonLdPage({ name, price, availability, image: 'https://gone.example/img/bottle.png' }) });
  const url = `https://gone.example${path}`;
  const productId = await shop.importAndSave(url, { active: true });
  return { productId, path, url, name, set: (page) => world.sites.page('gone.example', path, page) };
}

/** Asks for a re-check now and waits until the product's last check is newer than before. */
async function recheck(shop, productId) {
  const before = (await shop.getProduct(productId)).lastCheck?.at ?? '';
  const res = await shop.send('POST', `/products/${productId}/recheck`);
  need(res, 202, 'Asking for a re-check');
  const product = await eventually(shop, async () => {
    const p = await shop.getProduct(productId);
    return p.lastCheck && p.lastCheck.at !== before ? p : null;
  }, { ms: 30_000 });
  assert.ok(product, 'The re-check never ran');
  return product;
}

const checks = (shop, productId) => shop.sql('SELECT outcome, http_status, price_paise FROM product_checks WHERE tenant_id = $1 AND product_id = $2 ORDER BY id', [shop.tenantId, productId]);

// ---- K-24 ------------------------------------------------------------------------------------------------------------------

test('K-24: a product page that now answers 404 is broken, hidden from pages, and in Needs attention', async () => {
  const shop = await addP3Shop(world);
  const dead = await imported(shop, { name: 'Dead link bottle' });
  const alive = await imported(shop, { name: 'Live bottle' });
  const landing = await shop.page({ productIds: [dead.productId, alive.productId] });
  assert.deepEqual(productIdsOf(need(await shop.open(`/r/${landing.slug}`), 200, 'Before').text), [dead.productId, alive.productId]);
  const alertsBefore = (await shop.ownerAlerts()).length;

  dead.set({ status: 404, body: sitePage('<title>Not found</title>') });
  const product = await recheck(shop, dead.productId);
  assert.equal(product.fetchStatus, 'broken');
  assert.equal(product.lastCheck.httpStatus, 404);
  assert.equal(product.lastCheck.outcome, 'broken');
  assert.deepEqual((await checks(shop, dead.productId)).at(-1), { outcome: 'broken', http_status: 404, price_paise: null });

  const html = need(await shop.open(`/r/${landing.slug}`), 200, 'After').text;
  assert.deepEqual(productIdsOf(html), [alive.productId], 'The broken product is hidden from the page');
  assert.ok(!textOf(html).includes('Dead link bottle'));
  assert.ok(!html.includes(dead.url), 'No link to the dead address is left on the page');
  const attention = await shop.products('status=attention');
  assert.deepEqual(attention.map((p) => p.id), [dead.productId], 'It is listed under Needs attention');
  assert.equal((await shop.must('GET', '/catalog/settings')).attentionCount, 1);
  const alerts = await shop.ownerAlerts();
  assert.ok(alerts.length > alertsBefore, 'The owner is alerted');
  assert.equal((await shop.getProduct(alive.productId)).fetchStatus, 'ok');
  assert.equal((await shop.productRows()).length, 2, 'A broken product is kept, not deleted');
});

test('K-24: 410 is broken too; a 500 or a slow site is retried next run and stays on the page', async () => {
  const shop = await addP3Shop(world);
  const gone = await imported(shop, { name: 'Gone jar' });
  const flaky = await imported(shop, { name: 'Flaky jar' });
  const landing = await shop.page({ productIds: [gone.productId, flaky.productId] });
  gone.set({ status: 410, body: sitePage('<title>Gone</title>') });
  flaky.set({ status: 500, body: sitePage('<title>Error</title>') });
  assert.equal((await recheck(shop, gone.productId)).fetchStatus, 'broken');
  const retry = await recheck(shop, flaky.productId);
  assert.equal(retry.fetchStatus, 'retrying');
  assert.equal(retry.pricePaise, 99900, 'A failing site changes nothing');
  assert.deepEqual(productIdsOf(need(await shop.open(`/r/${landing.slug}`), 200, 'The page').text), [flaky.productId], 'A product being retried is still shown');
  assert.ok(!(await shop.products('status=attention')).some((p) => p.id === flaky.productId), 'A retry is not Needs attention');

  flaky.set({ body: jsonLdPage({ name: 'Flaky jar', price: '999', image: 'https://gone.example/img/bottle.png' }) });
  assert.equal((await recheck(shop, flaky.productId)).fetchStatus, 'ok', 'It recovers on the next run');
  gone.set({ body: jsonLdPage({ name: 'Gone jar', price: '999', image: 'https://gone.example/img/bottle.png' }) });
  assert.equal((await recheck(shop, gone.productId)).fetchStatus, 'ok', 'A page that comes back is shown again');
  assert.deepEqual(productIdsOf(need(await shop.open(`/r/${landing.slug}`), 200, 'The page').text), [gone.productId, flaky.productId]);
});

test('K-24: a page that now redirects to a private address, or turns into junk, never becomes the product', async () => {
  const shop = await addP3Shop(world);
  const moved = await imported(shop, { name: 'Moved jar' });
  const junk = await imported(shop, { name: 'Junk jar' });
  const mark = world.dials.length;
  moved.set({ redirect: 'http://169.254.169.254/latest/meta-data/' });
  junk.set({ body: '<html><head><title>Junk<title><script type="application/ld+json">{"@type":"Product","name":</script>' });
  const a = await recheck(shop, moved.productId);
  const b = await recheck(shop, junk.productId);
  assert.ok(world.dialsSince(mark).every((d) => d.address === '93.184.216.34'), 'The re-check never connected to a private address');
  for (const p of [a, b]) {
    assert.equal(p.pricePaise, 99900, 'The price is untouched');
    assert.ok(['Moved jar', 'Junk jar'].includes(p.name), 'The name is untouched');
    assert.notEqual(p.fetchStatus, 'ok');
  }
});

test('K-24: a product typed by hand has nothing to re-check, and one business can\'t re-check another\'s', async () => {
  const a = await addP3Shop(world);
  const b = await addP3Shop(world);
  const manual = await a.product({ name: 'By hand', externalUrl: 'https://gone.example/products/price' });
  assert.equal((await a.send('POST', `/products/${manual.id}/recheck`)).status, 409);
  const theirs = await imported(b);
  assert.equal((await a.send('POST', `/products/${theirs.productId}/recheck`)).status, 404);
  assert.equal((await checks(b, theirs.productId)).length, 0);
});

// ---- K-25 ------------------------------------------------------------------------------------------------------------------

test('K-25: the site\'s price drops from ₹999 to ₹799: the product follows with price_changed; a price set by hand does not move', async () => {
  const shop = await addP3Shop(world);
  const follows = await imported(shop, { name: 'Steel bottle', price: '999' });
  const byHand = await imported(shop, { name: 'Copper bottle', price: '999' });
  await shop.must('PATCH', `/products/${byHand.productId}`, { pricePaise: 85000 });
  assert.equal((await shop.getProduct(byHand.productId)).priceManual, true, 'A price the owner typed is marked manual');
  assert.equal((await shop.getProduct(follows.productId)).priceManual, false, 'An imported price is not');

  follows.set({ body: jsonLdPage({ name: 'Steel bottle', price: '799', image: 'https://gone.example/img/bottle.png' }) });
  byHand.set({ body: jsonLdPage({ name: 'Copper bottle', price: '799', image: 'https://gone.example/img/bottle.png' }) });
  const a = await recheck(shop, follows.productId);
  const b = await recheck(shop, byHand.productId);
  assert.equal(a.pricePaise, 79900, '₹799');
  assert.equal(a.priceChanged, true);
  assert.equal(a.previousPricePaise, 99900);
  assert.equal(a.lastCheck.outcome, 'price_changed');
  assert.equal(b.pricePaise, 85000, 'The manual price is unchanged');
  assert.equal(b.priceChanged, false);
  const rows = await shop.productRows();
  assert.deepEqual(rows.map((r) => [Number(r.price_paise), r.price_changed]).sort(), [[79900, true], [85000, false]].sort());
  assert.deepEqual((await shop.products('status=price_changed')).map((p) => p.id), [follows.productId]);
  const landing = await shop.page({ productIds: [follows.productId, byHand.productId] });
  const text = textOf(need(await shop.open(`/r/${landing.slug}`), 200, 'The page').text);
  assert.ok(text.includes('₹799') && text.includes('₹850'), 'Shoppers see ₹799 and ₹850');
  assert.ok(!text.includes('₹999'), 'The old price is not shown as a price or an MRP');
});

test('K-25: a price the site now writes as junk, negative, zero or absurd never replaces a good price', async () => {
  const shop = await addP3Shop(world);
  const item = await imported(shop, { name: 'Careful jar', price: '999' });
  for (const price of ['-799', 'abc', '799.999', '99999999999999', '', '1e9', null]) {
    item.set({ body: jsonLdPage({ name: 'Careful jar', price, image: 'https://gone.example/img/bottle.png' }) });
    const p = await recheck(shop, item.productId);
    assert.equal(p.pricePaise, 99900, `A site price of ${JSON.stringify(price)} was stored as ${p.pricePaise}`);
    assert.equal(p.priceChanged, false);
  }
  item.set({ body: jsonLdPage({ name: 'Careful jar', price: '799.99', image: 'https://gone.example/img/bottle.png' }) });
  assert.equal((await recheck(shop, item.productId)).pricePaise, 79999, '₹799.99 is 79999 paise, not 80000');
  item.set({ body: jsonLdPage({ name: 'A new name from the site <script>alert(1)</script>', price: '799.99', image: 'https://gone.example/img/bottle.png' }) });
  assert.equal((await recheck(shop, item.productId)).name, 'Careful jar', 'A re-check never rewrites the name');
});

test('K-25: a product that sells out on the site says Sold out and moves last; back in stock, it returns to its place', async () => {
  const shop = await addP3Shop(world);
  const first = await imported(shop, { name: 'First pot' });
  const second = await imported(shop, { name: 'Second pot' });
  const landing = await shop.page({ productIds: [first.productId, second.productId] });
  first.set({ body: jsonLdPage({ name: 'First pot', price: '999', availability: 'OutOfStock', image: 'https://gone.example/img/bottle.png' }) });
  const sold = await recheck(shop, first.productId);
  assert.equal(sold.inStock, false);
  assert.equal(sold.fetchStatus, 'ok', 'Sold out is not broken');
  let html = need(await shop.open(`/r/${landing.slug}`), 200, 'The page').text;
  assert.deepEqual(productIdsOf(html), [second.productId, first.productId], 'The sold-out product moves last');
  assert.match(textOf(html), /sold out/i);
  first.set({ body: jsonLdPage({ name: 'First pot', price: '999', image: 'https://gone.example/img/bottle.png' }) });
  assert.equal((await recheck(shop, first.productId)).inStock, true);
  html = need(await shop.open(`/r/${landing.slug}`), 200, 'The page').text;
  assert.deepEqual(productIdsOf(html), [first.productId, second.productId], 'Back in stock, it is first again');
  assert.doesNotMatch(textOf(html), /sold out/i);
});

test('K-25: the worker re-checks imported products older than the business\'s hours on its own, and leaves fresh ones alone', async () => {
  const shop = await addP3Shop(world);
  const settings = await shop.must('GET', '/catalog/settings');
  assert.equal(settings.recheckHours, 24, 'The default is 24 hours');
  const due = await imported(shop, { name: 'Due jar', price: '999' });
  const fresh = await imported(shop, { name: 'Fresh jar', price: '999' });
  for (const item of [due, fresh]) item.set({ body: jsonLdPage({ name: 'x', price: '799', image: 'https://gone.example/img/bottle.png' }) });
  await shop.sql(`UPDATE products SET fetched_at = now() - interval '25 hours', next_check_at = now() - interval '1 hour' WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, due.productId]);
  await shop.sql(`UPDATE products SET fetched_at = now() - interval '2 hours', next_check_at = now() + interval '22 hours' WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, fresh.productId]);
  const changed = await eventually(shop, async () => ((await shop.getProduct(due.productId)).pricePaise === 79900), { ms: 45_000 });
  assert.ok(changed, 'The scheduled run re-checked the product that was due');
  assert.equal((await shop.getProduct(fresh.productId)).pricePaise, 99900, 'A product checked 2 hours ago is left alone');
  for (const bad of [0, 721, 1.5, -1, '24']) assert.equal((await shop.send('PATCH', '/catalog/settings', { recheckHours: bad })).status, 400, `recheckHours ${bad}`);
  assert.equal((await shop.must('PATCH', '/catalog/settings', { recheckHours: 6 })).recheckHours, 6);
  const other = await addP3Shop(world);
  assert.equal((await other.must('GET', '/catalog/settings')).recheckHours, 24, 'The setting is per business');
});

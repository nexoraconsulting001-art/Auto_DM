// The scheduled re-check (PRD 8.8): price, stock and dead links of imported products, for every business in one run, with a
// claim so two workers never take the same product and a fair share for each business.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerVisibleSql, isBuyerVisible } from '../../../src/modules/catalog/index.js';
import { RECHECK_SWEEP } from '../../../src/modules/imports/index.js';
import { openWorld } from './support.js';

const SITE = 'gone.example';
const productPage = ({ name = 'Steel bottle', price = '999', availability = 'InStock' } = {}) => ({
  body: `<!doctype html><title>${name}</title><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name, image: `https://${SITE}/img/bottle.png`, offers: { price, priceCurrency: 'INR', availability } })}</script>`,
});

/** Imports one page by its link and saves it at the price read, so it is an imported product with a site price. */
async function imported(shop, path, body = {}) {
  const result = await shop.post('/imports/link', { url: `https://${SITE}${path}` }, 200);
  assert.equal(result.status, 'draft', path);
  const { productId } = await shop.post(`/import-items/${result.itemId}/save`, { name: result.draft.name, pricePaise: result.draft.pricePaise, ...body });
  return productId;
}
const makeDue = (shop) => shop.sql(`UPDATE products SET next_check_at = now() - interval '1 minute' WHERE tenant_id = $1 AND next_check_at IS NOT NULL`, [shop.tenantId]);
const sweep = (world) => world.handlers[RECHECK_SWEEP]();
const row = async (shop, id) => (await shop.sql('SELECT fetch_status, check_failures, last_check_error, next_check_at, next_check_at <= now() AS due, active FROM products WHERE id = $1', [id]))[0];

test('K-24: a product whose page answers 404 becomes broken, is hidden from buyer pages, and is in Needs attention; it returns when the page does', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const id = await imported(shop, '/products/price');
  const removed = await imported(shop, '/products/price-b').catch(() => null);
  assert.equal(removed, null, 'a page that isn’t there can’t be imported at all');
  assert.equal((await sweep(world)).checked, 0, 'nothing is due yet');

  world.sites.page(SITE, '/products/price', { status: 404, body: '<!doctype html><title>Not found</title>' });
  await makeDue(shop);
  const run = await sweep(world);
  assert.deepEqual([run.checked, run.broken], [1, 1]);
  const product = await shop.json(`/products/${id}`);
  assert.deepEqual([product.fetchStatus, product.active, product.lastCheck.outcome, product.lastCheck.httpStatus], ['broken', true, 'broken', 404]);
  assert.deepEqual((await shop.products('status=attention')).map((p) => p.id), [id]);
  assert.equal((await shop.json('/catalog/settings')).attentionCount, 1);
  assert.ok((await shop.json('/catalog/settings')).lastRecheckAt);
  const [stored] = await shop.sql('SELECT active, fetch_status FROM products WHERE id = $1', [id]);
  assert.equal(isBuyerVisible(stored), false, 'hidden from buyer pages');
  assert.deepEqual(await shop.sql(`SELECT p.id FROM products p WHERE p.tenant_id = $1 AND ${buyerVisibleSql('p')}`, [shop.tenantId]), []);
  const alerts = await shop.sql(`SELECT message, target FROM alerts WHERE tenant_id = $1 AND kind = 'catalog.product_broken'`, [shop.tenantId]);
  assert.equal(alerts.length, 1, 'the owner is told');
  assert.equal(alerts[0].target, `product:${id}`);

  // 410 is the same; and being told once is enough.
  world.sites.page(SITE, '/products/price', { status: 410, body: '<!doctype html><title>Gone</title>' });
  await makeDue(shop);
  await sweep(world);
  assert.equal((await row(shop, id)).fetch_status, 'broken');
  assert.equal((await shop.sql(`SELECT count(*)::int AS n FROM alerts WHERE tenant_id = $1 AND kind = 'catalog.product_broken'`, [shop.tenantId]))[0].n, 1);

  world.sites.page(SITE, '/products/price', productPage());
  await makeDue(shop);
  assert.equal((await sweep(world)).ok, 1);
  const back = await row(shop, id);
  assert.deepEqual([back.fetch_status, back.check_failures, back.due], ['ok', 0, false]);
  assert.equal(isBuyerVisible(back), true);
});

test('K-25: a site price that drops from ₹999 to ₹799 is updated and flagged; a price the owner typed never changes', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  world.sites.page(SITE, '/products/typed', productPage({ name: 'Typed bottle' }));
  const auto = await imported(shop, '/products/price');
  const typed = await imported(shop, '/products/typed', { pricePaise: 94900 });
  await shop.patch('/catalog/settings', { recheckHours: 6 });

  world.sites.page(SITE, '/products/price', productPage({ price: '799' }));
  world.sites.page(SITE, '/products/typed', productPage({ name: 'Typed bottle', price: '799' }));
  await makeDue(shop);
  const run = await sweep(world);
  assert.deepEqual([run.checked, run.price_changed, run.ok], [2, 1, 1]);

  const changed = await shop.json(`/products/${auto}`);
  assert.deepEqual([changed.pricePaise, changed.priceChanged, changed.previousPricePaise, changed.priceManual, changed.lastCheck.outcome], [79900, true, 99900, false, 'price_changed']);
  assert.deepEqual((await shop.products('status=price_changed')).map((p) => p.id), [auto]);
  const manual = await shop.json(`/products/${typed}`);
  assert.deepEqual([manual.pricePaise, manual.priceChanged, manual.priceManual, manual.lastCheck.outcome], [94900, false, true, 'ok'], 'the manual price is unchanged');
  assert.equal(changed.name, 'Steel bottle', 'a re-check never renames anything');

  const [next] = await shop.sql(`SELECT next_check_at > now() + interval '5 hours 50 minutes' AS after, next_check_at < now() + interval '6 hours 10 minutes' AS before FROM products WHERE id = $1`, [auto]);
  assert.deepEqual(next, { after: true, before: true }, 'due again after this business’s own interval');

  // The owner looks and keeps the new price: the flag goes.
  const seen = await shop.patch(`/products/${auto}`, { pricePaise: 79900 });
  assert.deepEqual([seen.priceChanged, seen.previousPricePaise, seen.priceManual], [false, null, false]);
});

test('sold out on the site shows Sold out here and moves back when it returns; a timeout or a 5xx is tried again next run', async (t) => {
  const world = await openWorld(t);
  const shop = await world.addShop();
  const id = await imported(shop, '/products/price');
  world.sites.page(SITE, '/products/price', productPage({ availability: 'https://schema.org/OutOfStock' }));
  await makeDue(shop);
  assert.equal((await sweep(world)).sold_out, 1);
  let product = await shop.json(`/products/${id}`);
  assert.deepEqual([product.inStock, product.stock, product.display.soldOut, product.fetchStatus], [false, 0, true, 'ok']);
  assert.deepEqual((await shop.products('status=sold_out')).map((p) => p.id), [id]);

  world.sites.page(SITE, '/products/price', productPage());
  await makeDue(shop);
  assert.equal((await sweep(world)).back_in_stock, 1);
  product = await shop.json(`/products/${id}`);
  assert.deepEqual([product.inStock, product.stock, product.display.soldOut], [true, null, false]);

  world.sites.page(SITE, '/products/price', { status: 500, body: '<!doctype html><title>Error</title>' });
  await makeDue(shop);
  for (const failures of [1, 2]) {
    assert.equal((await sweep(world)).retry, 1);
    const state = await row(shop, id);
    assert.deepEqual([state.fetch_status, state.check_failures, state.last_check_error, state.due], ['retrying', failures, 'http_status', true], 'still due: tried again next run');
  }
  await sweep(world);
  const waiting = await row(shop, id);
  assert.deepEqual([waiting.check_failures, waiting.due], [3, false], 'after three tries in a row it waits for the usual interval');
  assert.equal(isBuyerVisible(waiting), true, 'a site having a bad hour doesn’t hide the product');
  assert.equal((await shop.json(`/products/${id}`)).pricePaise, 99900, 'and nothing about it changed');
  assert.deepEqual(await shop.sql(`SELECT 1 FROM alerts WHERE tenant_id = $1 AND kind = 'catalog.product_broken'`, [shop.tenantId]), []);
});

test('K-26: 200 products due on one host: the per-host limit is held, every business gets its turn, and no product is taken twice', { timeout: 120_000 }, async (t) => {
  const world = await openWorld(t, { overrides: { fetchHostGapMs: 30, recheckPerRun: 20 } });
  const [big, small] = [await world.addShop(), await world.addShop()];
  const seed = (shop, count, name) => shop.sql(
    `INSERT INTO products (tenant_id, name, slug, price_paise, external_url, source, fetch_status, price_manual, next_check_at)
     SELECT $1, $3 || ' ' || n, lower($3) || '-' || n, 99900, 'https://${SITE}/products/price?n=' || $3 || n, 'link', 'ok', false, now() - make_interval(mins => 300 - n)
     FROM generate_series(1, $2::int) AS n`,
    [shop.tenantId, count, name],
  );
  await seed(big, 200, 'Big');
  await seed(small, 3, 'Small');

  const started = Date.now();
  const first = await sweep(world);
  const took = Date.now() - started;
  assert.equal(first.checked, 20, '20 a run here (50 by default)');
  assert.equal(first.ok, 20);
  assert.ok(took >= 19 * 30 * 0.9, `one request per interval to the host: 20 requests took ${took} ms`);
  const checked = (shop) => shop.sql('SELECT count(*)::int AS n, count(DISTINCT product_id)::int AS products FROM product_checks WHERE tenant_id = $1', [shop.tenantId]).then((r) => r[0]);
  assert.deepEqual(await checked(small), { n: 3, products: 3 }, 'the business with 3 due is not kept waiting behind the one with 200');
  assert.deepEqual(await checked(big), { n: 17, products: 17 });

  // Two workers at once: each takes its own products.
  const both = await Promise.all([sweep(world), sweep(world)]);
  assert.deepEqual(both.map((r) => r.checked).sort(), [20, 20]);
  assert.deepEqual(await checked(big), { n: 57, products: 57 }, 'no product was checked twice');
  const [{ n: stillDue }] = await big.sql('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND next_check_at <= now()', [big.tenantId]);
  assert.equal(stillDue, 143, 'the rest wait for the next run');
});

test('"Re-check now" queues one product; a hand-made product has nothing to re-check; another business’s product is not found', async (t) => {
  const world = await openWorld(t);
  const [shop, other] = [await world.addShop(), await world.addShop()];
  const id = await imported(shop, '/products/price');
  const manual = await shop.post('/products', { name: 'Hand made', pricePaise: 100, externalUrl: 'https://gone.example/products/hand' });
  const [handMade] = await shop.sql('SELECT next_check_at, source FROM products WHERE id = $1', [manual.id]);
  assert.deepEqual(handMade, { next_check_at: null, source: 'manual' }, 'a hand-made product is never fetched');

  world.sites.page(SITE, '/products/price', productPage({ price: '899' }));
  assert.deepEqual(await shop.post(`/products/${id}/recheck`, undefined, 202), { queued: true });
  assert.deepEqual(await shop.post(`/products/${id}/recheck`, undefined, 202), { queued: false }, 'asked twice in a minute, queued once');
  assert.equal((await shop.call(`/products/${manual.id}/recheck`, { method: 'POST' })).status, 409);
  assert.equal((await other.call(`/products/${id}/recheck`, { method: 'POST' })).status, 404);
  assert.equal((await shop.json(`/products/${id}`)).pricePaise, 99900, 'nothing is read while the seller waits');
  await world.runJobs();
  const product = await shop.json(`/products/${id}`);
  assert.deepEqual([product.pricePaise, product.priceChanged, product.lastCheck.outcome], [89900, true, 'price_changed']);
});

test('a business whose plan no longer includes imports is skipped, and a paused business’s products are left alone', async (t) => {
  const world = await openWorld(t);
  const [lapsed, closed] = [await world.addShop(), await world.addShop()];
  const a = await imported(lapsed, '/products/price');
  world.sites.page(SITE, '/products/other', productPage({ name: 'Other bottle' }));
  const b = await imported(closed, '/products/other');
  await lapsed.sql(`UPDATE tenants SET plan = 'free' WHERE id = $1`, [lapsed.tenantId]);
  await closed.sql(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [closed.tenantId]);
  world.sites.page(SITE, '/products/price', productPage({ price: '1' }));
  world.sites.page(SITE, '/products/other', productPage({ name: 'Other bottle', price: '1' }));
  await makeDue(lapsed);
  await makeDue(closed);
  const dials = world.sites.dials.length;
  const run = await sweep(world);
  assert.deepEqual([run.checked, run.skipped], [1, 1]);
  assert.equal(world.sites.dials.length, dials, 'no site was read for either');
  const prices = await lapsed.sql('SELECT id, price_paise FROM products WHERE id = ANY($1::int[]) ORDER BY id', [[a, b]]);
  assert.deepEqual(prices.map((p) => p.price_paise), [99900, 99900]);
  assert.equal((await row(closed, b)).due, true, 'still due, for when the business is back');
});

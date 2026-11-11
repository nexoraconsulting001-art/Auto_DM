// The storefront (PRD 9.1): each business's own brand and products only, search by name, tag and SKU, hidden categories
// as the store's 404, sizes sold out on their own, the home-screen app per business, and the Phase 0 store kept for others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../../src/tenancy.js';
import { hit, inTenant, otherStore, product, q, storeApp, withSizes } from './support.js';

// The test businesses live at <slug>.bhava.test, the platform's own test domain, so the page's own address is left out first.
const noPlatformName = (res) => {
  const text = `${res.text}${JSON.stringify(res.headers)}`.replace(/[a-z0-9-]+\.bhava\.test/gi, 'SHOP-ADDRESS');
  return !/bhava/i.test(text);
};

test('S-01 each store shows only its own brand and products, and neither names the platform', async () => {
  const app = await storeApp();
  try {
    const other = await otherStore(app, { name: 'Haldi House' });
    await product(app, { name: 'Neel lamp' });
    await product(app, { name: 'Haldi pot', tenant: other.tenant });
    for (const path of ['/', '/shop', '/search?q=lamp', '/about']) {
      const mine = await hit(app, path);
      const theirs = await hit(app, path.replace('lamp', 'pot'), { host: other.host });
      assert.equal(mine.status, 200, path);
      assert.equal(theirs.status, 200, path);
      assert.match(mine.text, /Neel Studio/);
      assert.doesNotMatch(mine.text, /Haldi/);
      assert.match(theirs.text, /Haldi House/);
      assert.doesNotMatch(theirs.text, /Neel/);
      assert.ok(noPlatformName(mine) && noPlatformName(theirs), path);
    }
    assert.match((await hit(app, '/shop')).text, /Neel lamp/);
    assert.match((await hit(app, '/shop', { host: other.host })).text, /Haldi pot/);
    const missing = await hit(app, '/no-such-page');
    assert.equal(missing.status, 404);
    assert.match(missing.text, /doesn’t exist/);
    assert.match(missing.text, /Neel Studio/);
    assert.ok(noPlatformName(missing));
  } finally {
    app.close();
  }
});

test('S-02 searching "kurti" finds the product whose SKU is KURTI-12, and nothing of another business', async () => {
  const app = await storeApp();
  try {
    const other = await otherStore(app);
    const blouse = await product(app, { name: 'Cotton blouse', stock: null });
    await withSizes(app, blouse.id, [{ value: 'M', sku: 'KURTI-12', stock: 3 }]);
    await product(app, { name: 'Kurti from elsewhere', tenant: other.tenant });
    const tagged = await product(app, { name: 'Silk scarf' });
    await q(app, `UPDATE products SET tags = ARRAY['festive'] WHERE tenant_id = $1 AND id = $2`, [app.tenant.id, tagged.id]);
    const res = await hit(app, '/search?q=kurti');
    assert.equal(res.status, 200);
    assert.match(res.text, /Cotton blouse/);
    assert.doesNotMatch(res.text, /elsewhere/);
    assert.match((await hit(app, '/search?q=FESTIVE')).text, /Silk scarf/);
    const long = await hit(app, `/search?q=${'k'.repeat(500)}`);
    assert.equal(long.status, 200);
    assert.ok(!long.text.includes('k'.repeat(81)), 'the query is cut to 80 characters');
    assert.equal((await hit(app, '/search?q=%00kurti%25')).status, 200, 'a NUL byte or a % is text, never a server error');
  } finally {
    app.close();
  }
});

test('S-03 a category the owner hid answers the store\'s 404, and its products leave the shop', async () => {
  const app = await storeApp();
  try {
    const lamp = await product(app, { name: 'Hidden lamp' });
    await product(app, { name: 'Open pot' });
    const [category] = await q(app, `INSERT INTO categories (tenant_id, name, slug, visible) VALUES ($1, 'Lamps', 'lamps', false) RETURNING id`, [app.tenant.id]);
    await q(app, 'INSERT INTO product_categories (tenant_id, product_id, category_id) VALUES ($1, $2, $3)', [app.tenant.id, lamp.id, category.id]);
    const res = await hit(app, '/c/lamps');
    assert.equal(res.status, 404);
    assert.match(res.text, /Neel Studio/);
    const shop = await hit(app, '/shop');
    assert.doesNotMatch(shop.text, /Hidden lamp/);
    assert.match(shop.text, /Open pot/);
    assert.equal((await hit(app, `/p/${lamp.slug}`)).status, 404);
    await q(app, 'UPDATE categories SET visible = true WHERE tenant_id = $1 AND id = $2', [app.tenant.id, category.id]);
    assert.equal((await hit(app, `/p/${lamp.slug}`)).status, 200);
  } finally {
    app.close();
  }
});

test('S-40 on the product page size M shows sold out and size L can be chosen', async () => {
  const app = await storeApp();
  try {
    const kurti = await product(app, { name: 'Block print kurti', stock: null });
    const sizes = await withSizes(app, kurti.id, [{ value: 'M', stock: 0 }, { value: 'L', stock: 3 }]);
    const page = await hit(app, `/p/${kurti.slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`value="${sizes.M}" disabled`));
    assert.match(page.text, /M · Sold out/);
    assert.match(page.text, new RegExp(`value="${sizes.L}">`));
    assert.match(page.text, /Add to bag/);
    const lookup = await hit(app, `/api/store/products?ids=${kurti.id},999999`);
    assert.deepEqual(lookup.json.products.map((p) => [p.id, p.active]), [[kurti.id, true], [999999, false]]);
    assert.deepEqual(lookup.json.products[0].variants.map((v) => [v.option, v.soldOut]), [['M', true], ['L', false]]);
    // All sizes gone: the whole product is sold out and can't be added.
    await q(app, 'UPDATE product_variants SET stock = 0 WHERE tenant_id = $1 AND product_id = $2', [app.tenant.id, kurti.id]);
    assert.match((await hit(app, `/p/${kurti.slug}`)).text, /disabled>Sold out</);
  } finally {
    app.close();
  }
});

test('S-67 the home-screen app carries the seller\'s name and colours, per business, with no platform name', async () => {
  const app = await storeApp();
  try {
    const other = await otherStore(app, { name: 'Haldi House' });
    await inTenant(app, () => app.platform.brandKit.save({ colors: { primary: '#3B2FC9', on_primary: '#FFFFFF' } }));
    const mine = await hit(app, '/manifest.webmanifest');
    const theirs = await hit(app, '/manifest.webmanifest', { host: other.host });
    assert.equal(mine.status, 200);
    assert.match(mine.headers['content-type'], /manifest\+json/);
    assert.deepEqual([mine.json.name, mine.json.theme_color, mine.json.display, mine.json.scope], ['Neel Studio', '#3B2FC9', 'standalone', '/']);
    assert.equal(theirs.json.name, 'Haldi House');
    assert.ok(noPlatformName(mine) && noPlatformName(theirs));
    const worker = await hit(app, '/sw.js');
    assert.equal(worker.status, 200);
    assert.match(worker.headers['content-type'], /javascript/);
    assert.equal(worker.headers['service-worker-allowed'], '/');
    const offline = await hit(app, '/offline');
    assert.equal(offline.status, 200);
    assert.match(offline.text, /offline/i);
    assert.match((await hit(app, '/')).text, /<link rel="manifest" href="\/manifest.webmanifest">/);
  } finally {
    app.close();
  }
});

test('the shop filters by price, sorts, and pages; a business without the store keeps its Phase 0 pages', async () => {
  const app = await storeApp();
  try {
    for (let i = 1; i <= 30; i += 1) await product(app, { name: `Item ${String(i).padStart(2, '0')}`, pricePaise: i * 5000, stock: null });
    const cheap = await hit(app, '/shop?price=under-99&sort=price-asc');
    assert.equal(cheap.status, 200);
    assert.deepEqual([...cheap.text.matchAll(/<b>(Item \d+)<\/b>/g)].map((m) => m[1]), ['Item 01']);
    const first = await hit(app, '/shop?sort=price-asc');
    const names = [...first.text.matchAll(/<b>(Item \d+)<\/b>/g)].map((m) => m[1]);
    assert.equal(names.length, 24);
    assert.equal(names[0], 'Item 01');
    assert.match(first.text, /Page 1 of 2/);
    const second = await hit(app, '/shop?sort=price-asc&page=2');
    assert.deepEqual([...second.text.matchAll(/<b>(Item \d+)<\/b>/g)].map((m) => m[1]), ['Item 25', 'Item 26', 'Item 27', 'Item 28', 'Item 29', 'Item 30']);
    assert.equal((await hit(app, '/shop?sort=constructor&page=-4&price=__proto__')).status, 200);

    const basic = await otherStore(app, { slug: 'basic', name: 'Basic Shop', plan: 'free' });
    await withTenant(basic.tenant, () => app.platform.products.create({ name: 'Old style', price: '100', active: 'on' }));
    const home = await hit(app, '/', { host: basic.host });
    assert.equal(home.status, 200);
    assert.match(home.text, /\/static\/cart\.js/, 'the Phase 0 store still answers a business without the store');
    assert.equal((await hit(app, '/manifest.webmanifest', { host: basic.host })).status, 404);
  } finally {
    app.close();
  }
});

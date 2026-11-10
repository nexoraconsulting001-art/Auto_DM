import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REEL_ID, login, startApp } from './helpers.js';
import { withConsoleApi } from './p0/console-port/support/console-api.js';

async function catalog(repos) {
  const kitchen = await repos.categories.save(null, { name: 'Kitchen', visible: 'on', position: 1 });
  const toys = await repos.categories.save(null, { name: 'Toys', visible: 'on', position: 2 });
  const hidden = await repos.categories.save(null, { name: 'Secret', visible: '' });
  const make = (name, price, mrp, cats, extra = {}) =>
    repos.products.create({ name, price: String(price), mrp: mrp ? String(mrp) : '', active: 'on', categoryIds: cats, ...extra });
  const pan = await make('Pan', 80, 200, [kitchen.id], { featured: 'on' });
  const knife = await make('Knife', 250, 300, [kitchen.id]);
  const car = await make('Toy car', 1200, 0, [toys.id]);
  const box = await make('Box', 150, 0, [hidden.id]);
  return { kitchen, toys, hidden, pan, knife, car, box };
}

const names = (page) => [...page.matchAll(/class="card-name"[^>]*>([^<]+)</g)].map((m) => m[1]);

test('shop filters: category, price band, search and sort', async () => {
  const app = await startApp();
  try {
    await catalog(app.repos);
    const get = async (path) => (await fetch(`${app.base}${path}`)).text();
    assert.deepEqual(names(await get('/c/kitchen')).sort(), ['Knife', 'Pan']);
    assert.deepEqual(names(await get('/shop?price=under-99')), ['Pan']);
    assert.deepEqual(names(await get('/shop?price=1000-plus')), ['Toy car']);
    assert.deepEqual(names(await get('/shop?sort=price-desc')), ['Toy car', 'Knife', 'Box', 'Pan']);
    assert.deepEqual(names(await get('/shop?sort=discount')).slice(0, 2), ['Pan', 'Knife']);
    assert.deepEqual(names(await get('/shop?q=knife')), ['Knife']);
    // Hidden categories have no page and no chip.
    assert.equal((await fetch(`${app.base}/c/secret`)).status, 404);
    assert.doesNotMatch(await get('/shop'), />Secret</);
  } finally {
    app.close();
  }
});

test('home shows categories, featured deals and price chips; product pages show related items', async () => {
  const app = await startApp();
  try {
    const { pan, knife } = await catalog(app.repos);
    const home = await (await fetch(`${app.base}/`)).text();
    assert.match(home, /href="\/c\/kitchen"/);
    assert.match(home, /href="\/shop\?price=under-99"/);
    assert.match(home, /Today's best deals/);
    const pdp = await (await fetch(`${app.base}/p/${pan.slug}`)).text();
    assert.match(pdp, /You may also like/);
    assert.match(pdp, new RegExp(knife.name));
    assert.match(pdp, /60% off/);
  } finally {
    app.close();
  }
});

test('/api/reels pages through live reels, newest first', async () => {
  const app = await startApp();
  try {
    const p = await app.repos.products.create({ name: 'Mug', price: '99', active: 'on' });
    const ids = Array.from({ length: 11 }, (_, i) => String(18000000000000000n + BigInt(i)));
    for (const id of ids) await app.repos.reels.save(id, { headline: `Reel ${id.slice(-2)}`, keywords: 'LINK', productIds: [p.id], active: 'on' });
    await app.repos.reels.save(REEL_ID, { headline: 'Paused', keywords: 'LINK', productIds: [p.id], active: '' });

    const first = await (await fetch(`${app.base}/api/reels`)).json();
    assert.equal(first.reels.length, 8);
    assert.equal(first.reels[0].id, ids[10]);
    assert.equal(first.reels[0].products[0].name, 'Mug');
    const second = await (await fetch(`${app.base}/api/reels?cursor=${first.nextCursor}`)).json();
    assert.deepEqual(second.reels.map((r) => r.id), [ids[2], ids[1], ids[0]]);
    assert.equal(second.nextCursor, null);

    const feed = await (await fetch(`${app.base}/reels`)).text();
    assert.match(feed, /"nextCursor":"\d+"/);
    assert.doesNotMatch(feed, /Paused/);
  } finally {
    app.close();
  }
});

test('the setup checklist ticks steps off and can be hidden', async () => {
  const app = await startApp({ modules: withConsoleApi() });
  try {
    const { cookie, csrf } = await login(app.base);
    const checklist = async () => (await (await fetch(`${app.base}/api/v1/settings/setup`, { headers: { cookie } })).json()).checklist;
    const done = (list) => list.steps.filter((step) => step.done).length;
    let list = await checklist();
    assert.equal(list.dismissed, false);
    assert.equal(list.steps.length, 6);
    assert.equal(done(list), 1); // Instagram connected (fake client)
    await app.repos.products.create({ name: 'Mug', price: '99', active: 'on' });
    list = await checklist();
    assert.equal(done(list), 2);
    const hide = await fetch(`${app.base}/api/v1/settings`, { method: 'PATCH', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ checklistDismissed: true }) });
    assert.equal(hide.status, 200);
    list = await checklist();
    assert.equal(list.dismissed, true);
  } finally {
    app.close();
  }
});

test('admin categories and product category checkboxes', async () => {
  const app = await startApp({ modules: withConsoleApi() });
  try {
    const { cookie, csrf } = await login(app.base);
    const send = (method, path, body) => fetch(`${app.base}/api/v1${path}`, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
    const res = await send('POST', '/categories', { name: 'Kitchen Creations', visible: true, position: 1 });
    assert.equal(res.status, 201);
    const cat = await app.repos.categories.getBySlug('kitchen-creations');
    assert.ok(cat);

    const created = await send('POST', '/products', { name: 'Pan', pricePaise: 9900, active: true, featured: true, categoryIds: [cat.id] });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const product = await app.repos.products.get(id);
    assert.deepEqual(product.category_ids, [cat.id]);
    assert.equal(product.featured, true);

    // Saving with no categories picked removes it from all of them.
    await send('PATCH', `/products/${id}`, { categoryIds: [] });
    assert.deepEqual((await app.repos.products.get(id)).category_ids, []);
  } finally {
    app.close();
  }
});

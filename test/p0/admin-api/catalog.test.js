// Products and categories through /api/v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../../src/contracts/api/index.js';
import { retryOnRace } from '../../../src/modules/admin-api/errors.js';
import { ok, placeOrder, refused, secondBusiness, walk, withApp } from './support.js';

const pot = { name: 'Clay pot', pricePaise: 19950 };

test('a write the database refuses after a race is a conflict, and any other failure stays what it was', async () => {
  for (const code of ['23505', '23503']) {
    await assert.rejects(() => retryOnRace(() => Promise.reject(Object.assign(new Error('duplicate key'), { code }))), (err) => err instanceof ApiError && err.code === 'conflict' && !/duplicate/.test(err.message));
  }
  const other = Object.assign(new Error('connection lost'), { code: '08006' });
  await assert.rejects(() => retryOnRace(() => Promise.reject(other)), (err) => err === other);
  assert.equal(await retryOnRace(async () => 'saved'), 'saved');
});

test('a product goes through create, read, list, change and delete', withApp(async ({ api }) => {
  const created = await ok(await api('POST', '/products', {
    ...pot, mrpPaise: 29900, description: 'Hand made', images: ['https://cdn.example/a.jpg', '/media/abc-1'], optionLabel: 'Size', optionValues: ['S', 'M'], stock: 7, featured: true,
  }), 201);
  assert.equal(created.slug, 'clay-pot');
  assert.equal(created.pricePaise, 19950);
  assert.equal(created.mrpPaise, 29900);
  assert.deepEqual(created.images, ['https://cdn.example/a.jpg', '/media/abc-1']);
  assert.equal(created.optionLabel, 'Size');
  assert.deepEqual(created.optionValues, ['S', 'M']);
  assert.equal(created.stock, 7);
  assert.equal(created.featured, true);
  assert.deepEqual(created.categoryIds, []);
  assert.match(created.createdAt, /^\d{4}-\d\d-\d\dT/);

  assert.deepEqual(await ok(await api('GET', `/products/${created.id}`)), created);

  const list = await ok(await api('GET', '/products'));
  assert.equal(list.nextCursor, null);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].reelCount, 0);
  assert.deepEqual(list.items[0].categoryNames, []);

  const changed = await ok(await api('PATCH', `/products/${created.id}`, { pricePaise: 25000 }));
  assert.equal(changed.pricePaise, 25000);
  for (const kept of ['name', 'slug', 'description', 'mrpPaise', 'images', 'optionLabel', 'optionValues', 'stock', 'active', 'featured']) {
    assert.deepEqual(changed[kept], created[kept], kept);
  }

  assert.equal((await api('DELETE', `/products/${created.id}`)).status, 204);
  await refused(await api('GET', `/products/${created.id}`), 404, 'not_found');
  await refused(await api('DELETE', `/products/${created.id}`), 404, 'not_found');
  await refused(await api('PATCH', `/products/${created.id}`, { name: 'x' }), 404, 'not_found');
}));

test('money stays exact to the paisa at every size, through create and update', withApp(async ({ api }) => {
  const { id } = await ok(await api('POST', '/products', { name: 'Paise', pricePaise: 1 }), 201);
  for (const pricePaise of [0, 1, 5, 10, 99, 100, 101, 1999, 12345, 1999999, 2147483647]) {
    const saved = await ok(await api('PATCH', `/products/${id}`, { pricePaise, mrpPaise: pricePaise }));
    assert.equal(saved.pricePaise, pricePaise);
    assert.equal(saved.mrpPaise, pricePaise);
  }
}));

test('a new product is live unless asked otherwise, and archiving moves it between the filters', withApp(async ({ api }) => {
  const live = await ok(await api('POST', '/products', pot), 201);
  assert.equal(live.active, true);
  assert.equal(live.featured, false);
  const draft = await ok(await api('POST', '/products', { name: 'Draft', pricePaise: 100, active: false }), 201);
  assert.equal(draft.active, false);

  const names = async (query) => (await ok(await api('GET', `/products?${query}`))).items.map((p) => p.name).sort();
  assert.deepEqual(await names('status=active'), ['Clay pot']);
  assert.deepEqual(await names('status=archived'), ['Draft']);
  assert.deepEqual(await names('status=all'), ['Clay pot', 'Draft']);
  assert.deepEqual(await names('status=featured'), []);
  assert.deepEqual(await names('search=dra'), ['Draft']);

  await ok(await api('PATCH', `/products/${draft.id}`, { active: true, featured: true }));
  assert.deepEqual(await names('status=featured'), ['Draft']);
}));

test('null clears the MRP and makes stock unlimited; leaving them out does not', withApp(async ({ api }) => {
  const { id } = await ok(await api('POST', '/products', { ...pot, mrpPaise: 30000, stock: 3 }), 201);
  const kept = await ok(await api('PATCH', `/products/${id}`, { name: 'Renamed pot' }));
  assert.equal(kept.mrpPaise, 30000);
  assert.equal(kept.stock, 3);
  assert.equal(kept.slug, 'renamed-pot');
  const cleared = await ok(await api('PATCH', `/products/${id}`, { mrpPaise: null, stock: null }));
  assert.equal(cleared.mrpPaise, null);
  assert.equal(cleared.stock, null);
  const zero = await ok(await api('PATCH', `/products/${id}`, { stock: 0 }));
  assert.equal(zero.stock, 0);
}));

test('the repo\'s rules still apply: an MRP under the price is refused, on create and on update', withApp(async ({ api }) => {
  await refused(await api('POST', '/products', { name: 'x', pricePaise: 500, mrpPaise: 499 }), 400, 'validation_failed');
  const { id } = await ok(await api('POST', '/products', { name: 'x', pricePaise: 500, mrpPaise: 600 }), 201);
  const error = await refused(await api('PATCH', `/products/${id}`, { pricePaise: 700 }), 400, 'validation_failed');
  assert.match(error.error, /MRP/);
  assert.equal((await ok(await api('GET', `/products/${id}`))).pricePaise, 500);
}));

test('an option value with a comma is refused instead of quietly becoming two options', withApp(async ({ api }) => {
  const error = await refused(await api('POST', '/products', { ...pot, optionValues: ['Red, Blue', 'Green'] }), 400, 'validation_failed');
  assert.ok(error.fields.optionValues);
  const { id } = await ok(await api('POST', '/products', { ...pot, optionValues: ['Red'] }), 201);
  await refused(await api('PATCH', `/products/${id}`, { optionValues: ['a,b'] }), 400, 'validation_failed');
  assert.deepEqual((await ok(await api('GET', `/products/${id}`))).optionValues, ['Red']);
}));

test('categories attach on create, survive updates that leave them out, and filter the list', withApp(async ({ api }) => {
  const garden = await ok(await api('POST', '/categories', { name: 'Garden' }), 201);
  const kitchen = await ok(await api('POST', '/categories', { name: 'Kitchen' }), 201);
  const product = await ok(await api('POST', '/products', { ...pot, categoryIds: [garden.id] }), 201);
  assert.deepEqual(product.categoryIds, [garden.id]);

  const renamed = await ok(await api('PATCH', `/products/${product.id}`, { name: 'Terracotta pot' }));
  assert.deepEqual(renamed.categoryIds, [garden.id]);

  const inGarden = await ok(await api('GET', `/products?category=${garden.id}`));
  assert.deepEqual(inGarden.items.map((p) => p.name), ['Terracotta pot']);
  assert.deepEqual(inGarden.items[0].categoryNames, ['Garden']);
  assert.deepEqual((await ok(await api('GET', `/products?category=${kitchen.id}`))).items, []);

  const moved = await ok(await api('PATCH', `/products/${product.id}`, { categoryIds: [kitchen.id] }));
  assert.deepEqual(moved.categoryIds, [kitchen.id]);
  const cleared = await ok(await api('PATCH', `/products/${product.id}`, { categoryIds: [] }));
  assert.deepEqual(cleared.categoryIds, []);
}));

test('a product that is part of an order can only be archived', withApp(async ({ api, repos }) => {
  const product = await ok(await api('POST', '/products', pot), 201);
  await placeOrder(repos, product);
  const error = await refused(await api('DELETE', `/products/${product.id}`), 409, 'conflict');
  assert.match(error.error, /Archive/);
  assert.equal((await ok(await api('PATCH', `/products/${product.id}`, { active: false }))).active, false);
  assert.equal((await ok(await api('GET', `/products/${product.id}`))).id, product.id);
}));

test('the product list pages without repeats or gaps, and refuses a made-up cursor', withApp(async ({ api }) => {
  const made = [];
  for (let i = 1; i <= 5; i++) made.push((await ok(await api('POST', '/products', { name: `Item ${i}`, pricePaise: 100 }), 201)).id);
  const { items, sizes } = await walk(api, '/products', 2);
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.deepEqual(items.map((p) => p.id), [...made].reverse());

  const first = await ok(await api('GET', '/products?limit=2'));
  await ok(await api('POST', '/products', { name: 'Added while paging', pricePaise: 100 }), 201);
  const next = await ok(await api('GET', `/products?limit=2&cursor=${first.nextCursor}`));
  assert.deepEqual(next.items.map((p) => p.id), [made[2], made[1]]);

  const notJson = await refused(await api('GET', '/products?cursor=bm90anNvbg'), 400, 'validation_failed');
  assert.ok(notJson.fields.cursor);
  await refused(await api('GET', `/products?cursor=${Buffer.from('{"a":1}').toString('base64url')}`), 400, 'validation_failed');
  await refused(await api('GET', `/products?cursor=${Buffer.from('["x"]').toString('base64url')}`), 400, 'validation_failed');
}));

test('F-01: two businesses can each have the same product slug and see only their own', withApp(async (app) => {
  const leaf = await secondBusiness(app);
  const mine = await ok(await app.api('POST', '/products', { name: 'Kids toy', pricePaise: 100 }), 201);
  const theirs = await ok(await leaf.api('POST', '/products', { name: 'Kids toy', pricePaise: 200 }), 201);
  assert.equal(mine.slug, 'kids-toy');
  assert.equal(theirs.slug, 'kids-toy');
  assert.deepEqual((await ok(await app.api('GET', '/products'))).items.map((p) => p.pricePaise), [100]);
  assert.deepEqual((await ok(await leaf.api('GET', '/products'))).items.map((p) => p.pricePaise), [200]);
}));

test('another business\'s category cannot be attached to a product', withApp(async (app) => {
  const leaf = await secondBusiness(app);
  const theirs = await ok(await leaf.api('POST', '/categories', { name: 'Theirs' }), 201);
  const product = await ok(await app.api('POST', '/products', { ...pot, categoryIds: [theirs.id] }), 201);
  assert.deepEqual(product.categoryIds, []);
  assert.equal((await ok(await leaf.api('GET', `/categories/${theirs.id}`))).productCount, 0);
}));

test('a new category is visible and goes last unless told otherwise', withApp(async ({ api }) => {
  const first = await ok(await api('POST', '/categories', { name: 'First' }), 201);
  assert.equal(first.position, 1);
  assert.equal(first.visible, true);
  assert.equal(first.slug, 'first');
  assert.equal(first.productCount, 0);
  assert.equal((await ok(await api('POST', '/categories', { name: 'Second' }), 201)).position, 2);
  const placed = await ok(await api('POST', '/categories', { name: 'Top', position: -1, visible: false, description: 'x', imageUrl: 'https://cdn.example/c.jpg', slug: 'the-top' }), 201);
  assert.equal(placed.position, -1);
  assert.equal(placed.visible, false);
  assert.equal(placed.slug, 'the-top');
  assert.equal(placed.imageUrl, 'https://cdn.example/c.jpg');
  assert.deepEqual((await ok(await api('GET', '/categories'))).items.map((c) => c.name), ['Top', 'First', 'Second']);
  const { items, sizes } = await walk(api, '/categories', 2);
  assert.deepEqual(sizes, [2, 1]);
  assert.deepEqual(items.map((c) => c.name), ['Top', 'First', 'Second']);
}));

test('updating a category keeps what was left out, including its link', withApp(async ({ api }) => {
  const category = await ok(await api('POST', '/categories', { name: 'Pots', description: 'Clay', position: 4, visible: false }), 201);
  const renamed = await ok(await api('PATCH', `/categories/${category.id}`, { name: 'Planters' }));
  assert.equal(renamed.name, 'Planters');
  assert.equal(renamed.slug, 'pots');
  assert.equal(renamed.description, 'Clay');
  assert.equal(renamed.position, 4);
  assert.equal(renamed.visible, false);
  assert.equal((await ok(await api('PATCH', `/categories/${category.id}`, { slug: '' }))).slug, 'planters');
  await refused(await api('PATCH', '/categories/999999', { name: 'x' }), 404, 'not_found');
}));

test('a taken category link is refused by name, and deleting a category keeps its products', withApp(async ({ api }) => {
  const category = await ok(await api('POST', '/categories', { name: 'Pots' }), 201);
  const error = await refused(await api('POST', '/categories', { name: 'Other', slug: 'pots' }), 400, 'validation_failed');
  assert.match(error.error, /pots/);
  const product = await ok(await api('POST', '/products', { ...pot, categoryIds: [category.id] }), 201);
  assert.equal((await ok(await api('GET', `/categories/${category.id}`))).productCount, 1);
  assert.equal((await api('DELETE', `/categories/${category.id}`)).status, 204);
  await refused(await api('GET', `/categories/${category.id}`), 404, 'not_found');
  await refused(await api('DELETE', `/categories/${category.id}`), 404, 'not_found');
  assert.deepEqual((await ok(await api('GET', `/products/${product.id}`))).categoryIds, []);
}));

test('saves racing for the same link never end in a 500', withApp(async ({ api }) => {
  for (const [path, body] of [['/categories', { name: 'Same' }], ['/products', { name: 'Same', pricePaise: 100 }]]) {
    const results = await Promise.all(Array.from({ length: 6 }, () => api('POST', path, body)));
    const statuses = results.map((r) => r.status);
    assert.ok(statuses.includes(201), `${path}: ${statuses}`);
    assert.ok(statuses.every((s) => [201, 400, 409].includes(s)), `${path}: ${statuses}`);
  }
}));

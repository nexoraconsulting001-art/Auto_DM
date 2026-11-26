// seller-ui-4: staff with automations open Reels, so they can pick a reel's products and create its store, without reading the
// catalog itself (products.list is staff with catalog). reels.products is the picker's read: automations access, tenant scoped,
// and only what the picker shows. Runs the real app on its test database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REEL_ID } from '../../helpers.js';
import { addBusiness, addProduct, addStaff, api, connectInstagram, need, startWorld } from '../../p0/spec-p0/support.js';

const PICKER_FIELDS = ['active', 'id', 'images', 'name', 'pricePaise'];

test('seller-ui-4: staff with automations but not catalog list their business’s products for a reel and create its store', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const other = await addBusiness(app, { slug: 'leaf-clay', name: 'Leaf and Clay' });
  const lamp = await addProduct(shop, 'Brass lamp');
  const rug = await addProduct(shop, 'Jute rug', { active: '' });
  await addProduct(other, 'Not theirs');
  await connectInstagram(app, shop, '17841400000000777'); // a reel store is for a post on the business's own account
  const staff = await addStaff(app, shop, { permissions: ['automations'] });

  need(await api(app, shop, staff.token, '/products'), 403, 'the catalog itself stays catalog staff only');
  const res = need(await api(app, shop, staff.token, '/reel-products?limit=50'), 200, 'the reel product picker');
  const { items, nextCursor } = res.json();
  assert.equal(nextCursor, null);
  assert.deepEqual(items.map((p) => p.name).sort(), ['Brass lamp', 'Jute rug'], 'this business’s products only, archived ones too');
  for (const item of items) assert.deepEqual(Object.keys(item).sort(), PICKER_FIELDS, 'only what the picker shows');
  assert.equal(items.find((p) => p.id === rug.id).active, false);
  const found = need(await api(app, shop, staff.token, '/reel-products?search=lamp'), 200, 'search').json();
  assert.deepEqual(found.items.map((p) => p.id), [lamp.id]);

  // A reel is its landing page; its comment DM is an automation's, so the keyword fields are not sent (D-11, src/contracts/api/reels.js).
  const saved = need(await api(app, shop, staff.token, `/reels/${REEL_ID}`, { method: 'PUT', body: { productIds: [lamp.id], headline: 'Lamp edit' } }), 200, 'creating the reel store').json();
  assert.deepEqual(saved.products.map((p) => p.id), [lamp.id]);
});

test('seller-ui-4: the picker is refused to staff without automations, and to nobody signed in', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  await addProduct(shop, 'Brass lamp');
  const orders = await addStaff(app, shop, { permissions: ['orders'] });
  const catalog = await addStaff(app, shop, { permissions: ['catalog'] });
  need(await api(app, shop, orders.token, '/reel-products'), 403, 'orders-only staff');
  need(await api(app, shop, catalog.token, '/reel-products'), 403, 'catalog staff without automations do not open Reels either');
  need(await api(app, shop, null, '/reel-products'), 401, 'nobody signed in');
});

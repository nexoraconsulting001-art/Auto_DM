import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REEL_ID, seedReel, setup } from './helpers.js';
import { SETTING_DEFAULTS } from '../src/repos/settings.js';

const customer = { name: 'Asha Kapoor', phone: '+91 98765 43210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' };

test('a reel needs 1 to 20 products', async () => {
  const { repos } = await setup();
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push((await repos.products.create({ name: `P${i}`, price: '10', active: 'on' })).id);
  const save = (productIds) => repos.reels.save(REEL_ID, { headline: 'Edit', keywords: 'LINK', productIds, active: 'on' });
  await assert.rejects(save([]), /at least 1 product/);
  await assert.rejects(save(ids), /at most 20/);
  assert.equal((await save(ids.slice(0, 1))).products.length, 1);
  assert.equal((await save(ids.slice(0, 20))).products.length, 20);
});

test('order totals come from the database, not the browser', async () => {
  const { repos } = await setup();
  const { products } = await seedReel(repos); // ₹100 and ₹200
  const settings = { ...SETTING_DEFAULTS, shipping_fee_paise: '4900', free_shipping_above_paise: '99900' };
  const order = await repos.orders.create(
    { items: [{ productId: products[0].id, qty: 2, price: 1 }, { productId: products[1].id, qty: 1, price: 1 }], customer, reelId: REEL_ID },
    settings,
  );
  assert.equal(order.subtotal_paise, 40000);
  assert.equal(order.shipping_paise, 4900);
  assert.equal(order.total_paise, 44900);
  assert.equal(order.phone, '9876543210');
  assert.equal(order.reel_id, REEL_ID);
  assert.match(order.order_number, /^MS-\d+$/);
});

test('stock is reserved on order and restored on cancel', async () => {
  const { repos } = await setup();
  const { products } = await seedReel(repos, { n: 1, stock: '2' });
  const settings = { ...SETTING_DEFAULTS };
  const order = await repos.orders.create({ items: [{ productId: products[0].id, qty: 2 }], customer }, settings);
  assert.equal((await repos.products.get(products[0].id)).stock, 0);
  await assert.rejects(repos.orders.create({ items: [{ productId: products[0].id, qty: 1 }], customer }, settings), /sold out/);
  await repos.orders.setStatus(order.id, 'cancelled');
  assert.equal((await repos.products.get(products[0].id)).stock, 2);
  await assert.rejects(repos.orders.setStatus(order.id, 'paid'), /can’t be reopened/);
});

test('products with options require a choice, and checkout validates the address', async () => {
  const { repos } = await setup();
  const p = await repos.products.create({ name: 'Kurta', price: '999', option_label: 'Size', option_values: 'S, M', active: 'on' });
  const settings = { ...SETTING_DEFAULTS };
  await assert.rejects(repos.orders.create({ items: [{ productId: p.id, qty: 1, option: 'XL' }], customer }, settings), /Choose a size/);
  await assert.rejects(repos.orders.create({ items: [{ productId: p.id, qty: 1, option: 'M' }], customer: { ...customer, pincode: '12' } }, settings), /PIN code/);
  const ok = await repos.orders.create({ items: [{ productId: p.id, qty: 1, option: 'M' }], customer }, settings);
  assert.equal((await repos.orders.get(ok.id)).items[0].option_value, 'M');
});

test('products in an order can be archived but not deleted', async () => {
  const { repos } = await setup();
  const { products } = await seedReel(repos, { n: 1 });
  await repos.orders.create({ items: [{ productId: products[0].id, qty: 1 }], customer }, { ...SETTING_DEFAULTS });
  await assert.rejects(repos.products.remove(products[0].id), /Archive it instead/);
});

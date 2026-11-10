// Orders through /api/v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REEL_ID, seedReel } from '../../helpers.js';
import { SHOPPER, ok, placeOrder, refused, secondBusiness, walk, withApp } from './support.js';

async function product(api, fields = {}) {
  return ok(await api('POST', '/products', { name: 'Clay pot', pricePaise: 19950, ...fields }), 201);
}

test('an order reads back in paise with its items', withApp(async ({ api, repos }) => {
  const pot = await product(api, { optionValues: ['S', 'M'], optionLabel: 'Size', images: ['https://cdn.example/p.jpg'] });
  const placed = await repos.orders.create({ items: [{ productId: pot.id, qty: 2, option: 'M' }], customer: SHOPPER, source: 'dm' }, await repos.settings.getAll());

  const { items, nextCursor } = await ok(await api('GET', '/orders'));
  assert.equal(nextCursor, null);
  assert.equal(items[0].id, placed.id);
  assert.equal(items[0].itemCount, 2);
  assert.equal(items[0].customerName, SHOPPER.name);
  assert.equal(items[0].subtotalPaise, 39900);
  assert.equal(items[0].shippingPaise, 4900);
  assert.equal(items[0].totalPaise, 44800);
  assert.equal(items[0].status, 'awaiting_payment');
  assert.equal(items[0].reelId, null);
  assert.equal(items[0].source, 'dm');
  assert.equal('public_token' in items[0], false);
  assert.equal('publicToken' in items[0], false);

  const detail = await ok(await api('GET', `/orders/${placed.id}`));
  assert.equal(detail.orderNumber, placed.order_number);
  assert.deepEqual(detail.items.map(({ id: _id, ...rest }) => rest), [{ productId: pot.id, name: 'Clay pot', image: 'https://cdn.example/p.jpg', pricePaise: 19950, option: 'M', qty: 2 }]);
  await refused(await api('GET', '/orders/999999'), 404, 'not_found');
}));

test('orders filter by status and search by number, name or phone', withApp(async ({ api, repos }) => {
  const pot = await product(api);
  const a = await placeOrder(repos, pot);
  const b = await repos.orders.create({ items: [{ productId: pot.id, qty: 1 }], customer: { ...SHOPPER, name: 'Ravi Shah', phone: '9123456780' } }, await repos.settings.getAll());
  await ok(await api('POST', `/orders/${b.id}/status`, { status: 'paid' }));
  const ids = async (query) => (await ok(await api('GET', `/orders?${query}`))).items.map((o) => o.id);
  assert.deepEqual(await ids('status=paid'), [b.id]);
  assert.deepEqual(await ids('status=awaiting_payment'), [a.id]);
  assert.deepEqual(await ids('search=ravi'), [b.id]);
  assert.deepEqual(await ids('search=9123456'), [b.id]);
  assert.deepEqual(await ids(`search=${encodeURIComponent(a.order_number)}`), [a.id]);
  assert.deepEqual(await ids('search=nobody'), []);
  await refused(await api('GET', '/orders?status=nope'), 400, 'validation_failed');
}));

test('paging reaches every order, past the 200 the core repo stops at, newest first', withApp(async ({ api, db, tenant }) => {
  await db.query(
    `INSERT INTO orders (tenant_id, order_number, public_token, customer_name, phone, address, city, state, pincode, subtotal_paise, shipping_paise, total_paise)
     SELECT $1, 'ORD-' || n, 'token-' || n, 'Buyer', '9876543210', 'Addr', 'City', 'State', '411001', 100, 0, 100 FROM generate_series(1, 205) n`,
    [tenant.id],
  );
  const { items, sizes } = await walk(api, '/orders', 100);
  assert.deepEqual(sizes, [100, 100, 5]);
  assert.equal(new Set(items.map((o) => o.id)).size, 205);
  assert.deepEqual(items.map((o) => o.id), items.map((o) => o.id).sort((x, y) => y - x));
  assert.equal(items[0].orderNumber, 'ORD-205');
  assert.equal(items[0].itemCount, 0);
  for (const cursor of ['WzBd', 'WyJ4Il0', 'WzEsMl0', 'bm90anNvbg']) await refused(await api('GET', `/orders?cursor=${cursor}`), 400, 'validation_failed');
}));

test('a status change saves notes, leaves them alone when none are sent, and is refused for a missing order', withApp(async ({ api, repos }) => {
  const placed = await placeOrder(repos, await product(api));
  const paid = await ok(await api('POST', `/orders/${placed.id}/status`, { status: 'paid', notes: 'UTR 123' }));
  assert.equal(paid.status, 'paid');
  assert.equal(paid.notes, 'UTR 123');
  assert.equal(paid.items.length, 1);
  const shipped = await ok(await api('POST', `/orders/${placed.id}/status`, { status: 'shipped' }));
  assert.equal(shipped.status, 'shipped');
  assert.equal(shipped.notes, 'UTR 123');
  await refused(await api('POST', '/orders/999999/status', { status: 'paid' }), 404, 'not_found');
  await refused(await api('POST', `/orders/${placed.id}/status`, { status: 'unknown' }), 400, 'validation_failed');
}));

test('cancelling returns the stock once, and a cancelled order cannot be reopened', withApp(async ({ api, repos }) => {
  const pot = await product(api, { stock: 5 });
  const placed = await placeOrder(repos, pot, { qty: 3 });
  assert.equal((await ok(await api('GET', `/products/${pot.id}`))).stock, 2);
  await ok(await api('POST', `/orders/${placed.id}/status`, { status: 'cancelled' }));
  assert.equal((await ok(await api('GET', `/products/${pot.id}`))).stock, 5);
  await ok(await api('POST', `/orders/${placed.id}/status`, { status: 'cancelled' }));
  assert.equal((await ok(await api('GET', `/products/${pot.id}`))).stock, 5);
  const error = await refused(await api('POST', `/orders/${placed.id}/status`, { status: 'paid' }), 409, 'conflict');
  assert.match(error.error, /reopened/);
}));

test('an order from a reel names the reel', withApp(async ({ api, repos }) => {
  const { products } = await seedReel(repos);
  const placed = await placeOrder(repos, products[0], { reelId: REEL_ID, source: 'reel' });
  const detail = await ok(await api('GET', `/orders/${placed.id}`));
  assert.equal(detail.reelId, REEL_ID);
  assert.equal(detail.source, 'reel');
}));

test('F-04: each business\'s order list holds only its own orders', withApp(async (app) => {
  const leaf = await secondBusiness(app);
  const mine = await placeOrder(app.repos, await product(app.api));
  const theirs = await placeOrder(leaf.repos, await product(leaf.api));
  assert.deepEqual((await ok(await app.api('GET', '/orders'))).items.map((o) => o.id), [mine.id]);
  assert.deepEqual((await ok(await leaf.api('GET', '/orders'))).items.map((o) => o.id), [theirs.id]);
}));

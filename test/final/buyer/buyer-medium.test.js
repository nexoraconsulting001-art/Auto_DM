// Final review, medium buyer findings buyer-3, buyer-4, buyer-6 and buyer-8, driven through the real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorld } from '../../p4/invoices-returns/support.js';

/** A shop with returns on and a shopper whose order was delivered. */
async function delivered(world, settings = {}) {
  const { shop } = world;
  await shop.returnsOn(settings);
  await shop.shippingReady();
  const product = await shop.product({ pricePaise: 99900, stock: 5 });
  const shopper = await shop.shopper();
  const order = await shop.placeOrder({ lines: [{ product, qty: 1 }], mode: 'cod', shopperId: shopper.id });
  await shop.pay(order);
  return { shopper, order: await shop.deliver(order) };
}
const daysAgo = (world, order, days) => world.db.platform.tx(async (tx) => {
  await tx.exec('ALTER TABLE orders DISABLE TRIGGER USER');
  await tx.query(`UPDATE orders SET delivered_at = now() - make_interval(days => $2) WHERE id = $1`, [order.id, days]);
  await tx.exec('ALTER TABLE orders ENABLE TRIGGER USER');
});

test('buyer-6 (S-57): "Return an item" shows inside the return window and not after it', async (t) => {
  const world = await openWorld(t);
  const { shopper, order } = await delivered(world, { windowDays: 7 });
  const url = `/account/orders/${order.order_number}`;
  assert.match((await shopper.page(url)).text, /Return an item/);
  await daysAgo(world, order, 10);
  const late = await shopper.page(url);
  assert.equal(late.status, 200);
  assert.doesNotMatch(late.text, /Return an item/, 'The return link shows after the window has passed');
});

test('buyer-3: pages with a person’s details are no-store, not just no-cache', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { order } = await delivered(world);
  const checkout = await shop.page('/checkout');
  assert.match(String(checkout.headers['cache-control']), /no-store/, 'The checkout page can be kept by the browser');
  const tracked = await shop.page(`/order/${order.public_token}`);
  assert.equal(tracked.status, 200);
  assert.match(String(tracked.headers['cache-control']), /no-store/, 'The order page can be kept by the browser');
});

test('buyer-8 (8.12): store pages are gzipped', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.product({ pricePaise: 50000, stock: 3 });
  for (const path of ['/shop', '/checkout']) {
    const res = await shop.page(path, { 'accept-encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], 'gzip', `${path} is sent uncompressed`);
  }
});

test('buyer-4: the store header has a sign-in chip, and the account and sign-in pages carry the store header and policy links', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const shopPage = await shop.page('/shop');
  assert.match(shopPage.text, /href="\/account"/, 'No sign-in or account link in the store header');
  const { shopper } = await delivered(world);
  for (const res of [await shop.page('/login'), await shopper.page('/account'), await shopper.page('/account/orders')]) {
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/cart"/, 'No bag link on the page');
    assert.match(res.text, /href="\/policies\/privacy"/, 'No policy links on the page');
  }
});

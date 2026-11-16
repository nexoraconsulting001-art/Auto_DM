// Final review, medium buyer findings buyer-3, buyer-4, buyer-5, buyer-6 and buyer-8, driven through the real app.
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

/**
 * A shopper's prepaid order, paid, with its forward shipment as "Ready to ship" leaves it once the courier assigns an AWB
 * (9.10). The row is written directly, as test/p4/contract/events.test.js does: booking is shipping's own test's business.
 */
async function shipped(world) {
  const { shop } = world;
  const product = await shop.product({ pricePaise: 99900, stock: 5 });
  const shopper = await shop.shopper();
  const order = await shop.pay(await shop.placeOrder({ lines: [{ product, qty: 1 }], mode: 'prepaid', shopperId: shopper.id }));
  await world.db.platform.query(
    `INSERT INTO shipments (tenant_id, order_id, mode, kind, status, awb, courier_name, weight_grams, length_cm, breadth_cm, height_cm)
     VALUES ($1, $2, 'managed', 'forward', 'awb_assigned', $3, 'Blue Dart', 400, 20, 20, 20)`,
    [order.tenant_id, order.id, `SIM${order.id}${Date.now() % 1e6}`],
  );
  return { shopper, order };
}

const daysAgo = (world, order, days) => world.db.platform.tx(async (tx) => {
  await tx.exec('ALTER TABLE orders DISABLE TRIGGER USER');
  await tx.query(`UPDATE orders SET delivered_at = now() - make_interval(days => $2) WHERE id = $1`, [order.id, days]);
  await tx.exec('ALTER TABLE orders ENABLE TRIGGER USER');
});
const trackHrefIn = (text) => /href="(\/track\/[0-9a-z]+\.[A-Za-z0-9_-]{22})"/.exec(text)?.[1] ?? null;

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

test('buyer-3: every page with a person’s details is no-store, not just no-cache', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order } = await delivered(world);
  const pages = [
    ['checkout', await shop.page('/checkout')],
    ['order page', await shop.page(`/order/${order.public_token}`)],
    ['return page', await shopper.page(`/account/orders/${order.order_number}/return`)],
    ['account', await shopper.page('/account')],
    ['account order', await shopper.page(`/account/orders/${order.order_number}`)],
  ];
  for (const [name, res] of pages) {
    assert.equal(res.status, 200, `${name} answered ${res.status}`);
    assert.match(String(res.headers['cache-control']), /no-store/, `The ${name} can be kept by the browser`);
  }
});

test('buyer-8 (8.12): store pages and the shopper’s own pages are gzipped', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper } = await delivered(world);
  const gzip = { 'accept-encoding': 'gzip' };
  for (const [path, res] of [
    ['/shop', await shop.page('/shop', gzip)],
    ['/checkout', await shop.page('/checkout', gzip)],
    ['/login', await shop.page('/login', gzip)],
    ['/account', await shop.page('/account', { ...gzip, cookie: shopper.cookie })],
    ['/account/orders', await shop.page('/account/orders', { ...gzip, cookie: shopper.cookie })],
  ]) {
    assert.equal(res.status, 200, `${path} answered ${res.status}`);
    assert.equal(res.headers['content-encoding'], 'gzip', `${path} is sent uncompressed`);
  }
});

test('buyer-4: sign-in is reachable from every store page and returns to it; the shopper’s pages carry the store frame', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const shopPage = await shop.page('/shop');
  assert.match(shopPage.text, /href="\/login\?next=%2Fshop"/, 'No sign-in link in the store header');
  const checkout = await shop.page('/checkout');
  assert.ok((checkout.text.match(/href="\/login\?next=%2Fcheckout"/g) ?? []).length >= 2, 'A guest at checkout has no sign-in link that returns to checkout (S-07)');
  const { shopper } = await delivered(world);
  const signedInShop = await shopper.page('/shop');
  assert.match(signedInShop.text, /href="\/account"[^>]*>Account</, 'A signed-in shopper has no account link');
  assert.doesNotMatch(signedInShop.text, /href="\/login/);
  for (const res of [await shop.page('/login'), await shopper.page('/account'), await shopper.page('/account/orders')]) {
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/cart"/, 'No bag link on the page');
    assert.match(res.text, /href="\/policies\/privacy"/, 'No policy links on the page');
    assert.match(res.text, /<script src="\/store\/bag\.js\?v=[^"]+" defer><\/script>/, 'The bag chip has no count script');
  }
  const login = await shop.page('/login');
  assert.match(login.text, /href="\/login"[^>]*>Sign in</, 'Sign-in links to itself, never back to sign-in');
});

test('buyer-5 (S-78, F-89): the order page and the account link to the seller’s own tracking page once a parcel is on its way', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const { shopper, order } = await shipped(world);
  const fromOrder = trackHrefIn((await shop.page(`/order/${order.public_token}`)).text);
  assert.ok(fromOrder, 'The order page has no tracking link');
  const fromAccount = trackHrefIn((await shopper.page(`/account/orders/${order.order_number}`)).text);
  assert.equal(fromAccount, fromOrder, 'The account’s "Track this order" is not the tracking page');
  const tracking = await shop.page(fromOrder);
  assert.equal(tracking.status, 200);
  assert.match(tracking.text, new RegExp(`Order ${order.order_number}`));
  assert.match(String(tracking.headers['cache-control']), /no-store/, 'The tracking page can be kept by the browser');
  assert.doesNotMatch(tracking.text, /bhava/i);

  // Before anything is booked there is no parcel to follow.
  const product = await shop.product({ pricePaise: 50000, stock: 5 });
  const waiting = await shop.pay(await shop.placeOrder({ lines: [{ product, qty: 1 }], mode: 'prepaid', shopperId: shopper.id }));
  assert.equal(trackHrefIn((await shop.page(`/order/${waiting.public_token}`)).text), null);
  assert.equal(trackHrefIn((await shopper.page(`/account/orders/${waiting.order_number}`)).text), null);
});

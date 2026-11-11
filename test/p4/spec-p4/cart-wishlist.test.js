// PRD 9.2 (the bag and the server cart) and 9.20 (the wishlist). S-04 to S-06, S-84 to S-86.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_LIMITS, addP4Shop, addStaff, buyer, digits, need, newPhone, noCrash, ok, refused, textOf, useP4World } from './kit.js';

const world = useP4World();
const line = (product, qty = 1, variantId = null) => ({ productId: product.id, variantId, qty });
const savedIds = (data) => (data?.items ?? data?.products ?? data?.lines ?? []).map((i) => i.productId ?? i.id).sort((x, y) => x - y);

test('S-04: twelve of one item becomes ten, with a notice', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ name: 'Brass diya', pricePaise: 12000 });
  const b = buyer(world, shop);
  const quote = ok(await b.quote({ lines: [line(product, 12)] }), 'Quoting 12 of one item');
  assert.equal(quote.data.lines.length, 1);
  assert.equal(quote.data.lines[0].qty, STORE_LIMITS.maxQtyPerLine);
  assert.equal(quote.data.lines[0].state, 'capped');
  assert.equal(quote.data.lines[0].linePaise, 12000 * 10);
  assert.equal(quote.data.subtotalPaise, 120000);
  assert.ok(quote.data.notices.some((n) => /10/.test(n)), `No notice about the cap: ${JSON.stringify(quote.data.notices)}`);
  await b.signIn();
  const cart = ok(await b.putCart([line(product, 12)]), 'Saving a cart of 12');
  assert.equal(cart.data.lines[0].qty, 10);
  const [row] = await shop.sql('SELECT qty FROM cart_lines WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(row.qty, 10);
});

test('S-04: the same product twice merges into one line, still capped at ten', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 10000 });
  const b = buyer(world, shop);
  const quote = ok(await b.quote({ lines: [line(product, 7), line(product, 6)] }), 'Quoting 7 + 6 of one item');
  assert.equal(quote.data.lines.length, 1, 'Lines of one product did not merge');
  assert.equal(quote.data.lines[0].qty, 10);
  assert.equal(quote.data.subtotalPaise, 100000);
  const placed = await b.place(b.checkoutBody({ lines: [line(product, 7), line(product, 6)] }));
  noCrash(placed, 'Placing 7 + 6 of one item');
  const items = await shop.sql('SELECT qty FROM order_items WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(items.reduce((n, i) => n + i.qty, 0) <= 10, `An order holds ${items.reduce((n, i) => n + i.qty, 0)} of one item`);
});

test('S-04: zero, negative, fractional, text and huge quantities are refused, and so are more than 50 lines', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 10000 });
  const b = buyer(world, shop);
  for (const qty of [0, -1, -10, 1.5, '2', null, 1001, 2 ** 31, Number.MAX_SAFE_INTEGER, 1e21]) {
    refused(await b.quote({ lines: [{ productId: product.id, qty }] }), `Quoting qty ${qty}`, 400);
    refused(await b.place(b.checkoutBody({ lines: [{ productId: product.id, qty }] })), `Ordering qty ${qty}`, 400);
  }
  const many = [];
  for (let i = 0; i < 51; i++) many.push(line(await shop.item({ pricePaise: 1000 })));
  refused(await b.place(b.checkoutBody({ lines: many })), 'Ordering 51 lines', 400);
  assert.equal((await shop.orders()).length, 0);
  await b.signIn();
  const cart = noCrash(await b.putCart(many), 'Saving a cart of 51 lines');
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM cart_lines WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(n <= STORE_LIMITS.maxCartLines, `The server cart holds ${n} lines (answer ${cart.status})`);
});

test('S-05: a price, total, discount or shipping fee sent by the browser is refused, never used', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ name: 'Silk saree', pricePaise: 250000 });
  const b = buyer(world, shop);
  const clean = b.checkoutBody({ lines: [line(product)] });
  const tampered = [
    { ...clean, lines: [{ ...line(product), pricePaise: 100 }] },
    { ...clean, lines: [{ ...line(product), unitPaise: 100 }] },
    { ...clean, lines: [{ ...line(product), price: 1 }] },
    { ...clean, totalPaise: 100 },
    { ...clean, subtotalPaise: 100 },
    { ...clean, discountPaise: 249900 },
    { ...clean, shippingPaise: -1000 },
    { ...clean, amountPaise: 100 },
    { ...clean, advancePaise: 1 },
    { ...clean, codFeePaise: 0 },
  ];
  for (const body of tampered) {
    refused(await b.place({ ...body, idempotencyKey: `tamper-${Math.random().toString(36).slice(2)}xx` }), `Checkout carrying ${JSON.stringify(body).slice(0, 80)}`, 400);
    const { idempotencyKey: _k, acceptTerms: _a, consent: _c, ...quoteBody } = body;
    refused(await b.quote(quoteBody), 'A quote carrying an amount', 400);
  }
  assert.equal((await shop.orders()).length, 0, 'A tampered checkout made an order');
  const placed = ok(await b.place(clean), 'The clean checkout');
  const order = await shop.order(placed.data.orderNumber);
  assert.equal(Number(order.subtotal_paise), 250000);
  assert.equal(placed.data.gateway.amountPaise, Number(order.total_paise));
  const [gatewayOrder] = (await world.rzp.get('/state')).orders.filter((o) => o.id === placed.data.gateway.gatewayOrderId);
  assert.equal(gatewayOrder.amount, Number(order.total_paise), 'The gateway order is not for the order’s total');
  assert.ok(Number(order.total_paise) >= 250000);
});

test('S-05: the order is priced from the database at the moment it is placed, whatever the bag or an old quote said', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ name: 'Silk saree', pricePaise: 250000 });
  const b = buyer(world, shop);
  const before = ok(await b.quote({ lines: [line(product, 2)] }), 'First quote');
  assert.equal(before.data.subtotalPaise, 500000);
  await shop.must('PATCH', `/products/${product.id}`, { pricePaise: 300000 });
  const placed = await b.order({ lines: [line(product, 2)] });
  const order = await shop.order(placed.orderNumber);
  assert.equal(Number(order.subtotal_paise), 600000);
  const [item] = await shop.orderItems(order.id);
  assert.equal(Number(item.price_paise), 300000);
  await shop.must('PATCH', `/products/${product.id}`, { pricePaise: 100 });
  const after = await shop.order(placed.orderNumber);
  assert.equal(Number(after.subtotal_paise), 600000, 'A later price change rewrote a placed order');
});

test('S-05: a variant is priced as that variant, and a variant of another product is refused', async () => {
  const shop = await addP4Shop(world);
  const tee = await shop.item({ name: 'Tee', pricePaise: 50000, options: [{ name: 'Size', values: ['M', 'XL'] }], variants: [{ optionValues: ['M'], pricePaise: 50000 }, { optionValues: ['XL'], pricePaise: 65000 }] });
  const cheap = await shop.item({ name: 'Sticker', pricePaise: 1000, options: [{ name: 'Kind', values: ['One'] }], variants: [{ optionValues: ['One'], pricePaise: 1000 }] });
  const b = buyer(world, shop);
  const xl = tee.variants.find((v) => v.pricePaise === 65000);
  const quote = ok(await b.quote({ lines: [line(tee, 1, xl.id)] }), 'Quoting the XL');
  assert.equal(quote.data.subtotalPaise, 65000);
  const crossed = await b.place(b.checkoutBody({ lines: [line(tee, 1, cheap.variants[0].id)] }));
  refused(crossed, 'Ordering a product with another product’s variant');
  const noVariant = noCrash(await b.place(b.checkoutBody({ lines: [line(tee, 1, null)] })), 'Ordering a product that has variants without choosing one');
  if (noVariant.status < 300) assert.ok(Number((await shop.order(noVariant.data.orderNumber)).subtotal_paise) >= 50000, 'A product with variants was sold below its cheapest variant');
});

test('S-06: the server cart follows the shopper to a second device', async () => {
  const shop = await addP4Shop(world);
  const a = await shop.item({ name: 'Brass diya', pricePaise: 12000 });
  const c = await shop.item({ name: 'Cotton runner', pricePaise: 45000 });
  const phone = newPhone();
  const first = buyer(world, shop);
  await first.signIn(phone);
  ok(await first.putCart([line(a, 2), line(c, 1)]), 'Saving the cart on the first device');
  const second = buyer(world, shop, { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36' });
  await second.signIn(phone);
  const cart = ok(await second.getCart(), 'Reading the cart on the second device');
  assert.deepEqual(cart.data.lines.map((l) => [l.productId, l.qty]).sort(), [[a.id, 2], [c.id, 1]].sort());
  assert.equal(cart.data.lines.find((l) => l.productId === a.id).unitPaise, 12000);
  ok(await second.putCart([line(a, 3)]), 'Changing the cart on the second device');
  const back = ok(await first.getCart(), 'Reading it again on the first');
  assert.deepEqual(back.data.lines.map((l) => [l.productId, l.qty]), [[a.id, 3]]);
});

test('S-06: a cart belongs to one shopper at one business: nobody else can read or fill it', async () => {
  const shop = await addP4Shop(world);
  const other = await addP4Shop(world);
  const product = await shop.item({ name: 'Brass diya' });
  const elsewhere = await other.item({ name: 'Bell at the other store' });
  const phone = newPhone();
  const mine = buyer(world, shop);
  await mine.signIn(phone);
  ok(await mine.putCart([line(product, 2)]), 'Saving my cart');
  const stranger = buyer(world, shop);
  await stranger.signIn();
  assert.deepEqual(ok(await stranger.getCart(), 'A stranger’s cart').data.lines, []);
  const samePhoneOtherStore = buyer(world, other);
  await samePhoneOtherStore.signIn(phone);
  assert.deepEqual(ok(await samePhoneOtherStore.getCart(), 'The same phone at another store').data.lines, []);
  const guest = await buyer(world, shop).getCart();
  assert.ok(guest.status === 401 || (guest.status === 200 && guest.data.lines.length === 0), `A guest read a cart: ${guest.status} ${guest.text.slice(0, 100)}`);
  const foreign = noCrash(await mine.putCart([line(elsewhere, 1)]), 'Putting another business’s product in my cart');
  const rows = await shop.sql('SELECT product_id FROM cart_lines WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(!rows.some((r) => r.product_id === elsewhere.id), `Another business’s product is in the cart (answer ${foreign.status})`);
  // The session cookie of one store is nothing at another.
  const carried = buyer(world, other);
  Object.assign(carried.jar, mine.jar);
  const res = await carried.getCart();
  assert.ok(res.status === 401 || res.data.lines.length === 0, 'A session of store A opened a cart at store B');
});

test('S-06: a cart refilled on another browser comes back repriced, with inactive items flagged', async () => {
  const shop = await addP4Shop(world);
  const kept = await shop.item({ name: 'Brass diya', pricePaise: 12000 });
  const dropped = await shop.item({ name: 'Old runner', pricePaise: 45000 });
  const phone = newPhone();
  const first = buyer(world, shop);
  await first.signIn(phone);
  ok(await first.putCart([line(kept), line(dropped)]), 'Saving the cart');
  await shop.must('PATCH', `/products/${kept.id}`, { pricePaise: 15000 });
  await shop.must('PATCH', `/products/${dropped.id}`, { active: false });
  const second = buyer(world, shop);
  await second.signIn(phone);
  const cart = ok(await second.getCart(), 'The cart on the second browser');
  assert.equal(cart.data.lines.find((l) => l.productId === kept.id).unitPaise, 15000, 'The cart shows a stale price');
  assert.equal(cart.data.lines.find((l) => l.productId === dropped.id)?.state, 'inactive');
  const lookup = ok(await buyer(world, shop).api('GET', `/api/store/products?ids=${kept.id},${dropped.id}`), 'The product lookup for a moved bag');
  assert.ok(lookup.text.includes('15000') && !lookup.text.includes('"pricePaise":12000'), 'The lookup shows a stale price');
});

// ---- wishlist ----

test('S-84: three items saved while logged out are in the account wishlist after sign-in', async () => {
  const shop = await addP4Shop(world);
  const items = [await shop.item({ name: 'One' }), await shop.item({ name: 'Two' }), await shop.item({ name: 'Three' })];
  const b = buyer(world, shop);
  const guest = await b.api('PUT', '/api/store/wishlist', { add: items.map((p) => p.id) });
  refused(guest, 'Saving to an account wishlist while logged out', [401, 403]);
  const page = need(await b.open('/wishlist'), 200, 'The wishlist page logged out');
  assert.match(page.text, /<script\b/i, 'The logged-out wishlist page has no script to keep saves in the browser');
  await b.signIn();
  const merged = ok(await b.api('PUT', '/api/store/wishlist', { add: items.map((p) => p.id) }), 'Merging the browser’s saves');
  assert.deepEqual(savedIds(merged.data), items.map((p) => p.id).sort((x, y) => x - y));
  ok(await b.api('PUT', '/api/store/wishlist', { add: [items[0].id, items[0].id, items[1].id] }), 'Merging again');
  assert.deepEqual(savedIds(ok(await b.api('GET', '/api/store/wishlist'), 'Reading the wishlist').data), items.map((p) => p.id).sort((x, y) => x - y), 'A repeated merge doubled or lost items');
  ok(await b.api('PUT', '/api/store/wishlist', { remove: [items[2].id] }), 'Removing one');
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM wishlist_items WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(n, 2);
});

test('S-84: a wishlist holds at most 200 items, only this business’s products, and only its own shopper’s', async () => {
  const shop = await addP4Shop(world);
  const other = await addP4Shop(world);
  const mine = await shop.item({ name: 'Mine' });
  const foreign = await other.item({ name: 'Foreign' });
  const b = buyer(world, shop);
  await b.signIn();
  noCrash(await b.api('PUT', '/api/store/wishlist', { add: [foreign.id, mine.id, 2147483647] }), 'Saving another business’s product');
  const rows = await shop.sql('SELECT product_id FROM wishlist_items WHERE tenant_id = $1', [shop.tenantId]);
  assert.deepEqual(rows.map((r) => r.product_id), [mine.id]);
  refused(await b.api('PUT', '/api/store/wishlist', { add: Array.from({ length: 201 }, (_, i) => i + 1) }), 'Adding 201 at once', 400);
  for (const bad of [{ add: [-1] }, { add: ['1'] }, { add: [1.5] }, { add: [mine.id], shopperId: 1 }, { add: null }]) refused(await b.api('PUT', '/api/store/wishlist', bad), `Wishlist body ${JSON.stringify(bad)}`, 400);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await shop.item({ name: `Bulk ${i}` })).id);
  await shop.sql(`INSERT INTO wishlist_items (tenant_id, shopper_id, product_id) SELECT $1, $2, p.id FROM products p WHERE p.tenant_id = $1 AND p.id <> ALL($3) ON CONFLICT DO NOTHING`, [shop.tenantId, (await b.me()).id, [...ids, mine.id]]);
  const fill = Math.max(0, 199 - (await shop.sql('SELECT count(*)::int AS n FROM wishlist_items WHERE tenant_id = $1', [shop.tenantId]))[0].n);
  for (let i = 0; i < fill; i++) {
    const p = await shop.repos.products.create({ name: `Filler ${i}`, price: '10', active: 'on' });
    await shop.sql('INSERT INTO wishlist_items (tenant_id, shopper_id, product_id) VALUES ($1, $2, $3)', [shop.tenantId, (await b.me()).id, p.id]);
  }
  noCrash(await b.api('PUT', '/api/store/wishlist', { add: ids }), 'Going past 200');
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM wishlist_items WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, (await b.me()).id]);
  assert.ok(n <= STORE_LIMITS.wishlistItems, `A wishlist holds ${n} items`);
  const stranger = buyer(world, shop);
  await stranger.signIn();
  assert.deepEqual(savedIds(ok(await stranger.api('GET', '/api/store/wishlist'), 'A stranger’s wishlist').data), []);
});

test('S-85: a saved product set inactive shows as unavailable and cannot go in the bag', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ name: 'Walnut tray' });
  const soldOut = await shop.item({ name: 'Last candle', stock: 0 });
  const b = buyer(world, shop);
  await b.signIn();
  ok(await b.api('PUT', '/api/store/wishlist', { add: [product.id, soldOut.id] }), 'Saving two');
  await shop.must('PATCH', `/products/${product.id}`, { active: false });
  const list = ok(await b.api('GET', '/api/store/wishlist'), 'Reading the wishlist');
  const item = (list.data.items ?? []).find((i) => (i.productId ?? i.id) === product.id);
  assert.ok(item, 'The inactive item vanished instead of showing as unavailable');
  assert.ok(item.available === false || item.state === 'inactive' || item.unavailable === true, `The item is not marked unavailable: ${JSON.stringify(item)}`);
  const page = need(await b.open('/wishlist'), 200, 'The wishlist page');
  assert.match(textOf(page.text), /unavailable/i);
  const quote = ok(await b.quote({ lines: [line(product), line(soldOut)] }), 'Quoting both');
  assert.equal(quote.data.lines.find((l) => l.productId === product.id).state, 'inactive');
  assert.equal(quote.data.lines.find((l) => l.productId === soldOut.id).state, 'sold_out');
  refused(await b.place(b.checkoutBody({ lines: [line(product)] })), 'Ordering an inactive saved product');
  refused(await b.place(b.checkoutBody({ lines: [line(soldOut)] })), 'Ordering a sold-out saved product');
  assert.equal((await shop.orders()).length, 0);
});

test('S-86: the owner sees how many saved each product, never who', async () => {
  const shop = await addP4Shop(world);
  const other = await addP4Shop(world);
  const tray = await shop.item({ name: 'Walnut tray' });
  const cup = await shop.item({ name: 'Clay cup' });
  const theirs = await other.item({ name: 'Other store item' });
  const phones = [];
  for (let i = 0; i < 2; i++) {
    const b = buyer(world, shop);
    phones.push(await b.signIn());
    ok(await b.api('PUT', '/api/store/wishlist', { add: i === 0 ? [tray.id, cup.id] : [tray.id] }), 'Saving');
  }
  const elsewhere = buyer(world, other);
  phones.push(await elsewhere.signIn());
  ok(await elsewhere.api('PUT', '/api/store/wishlist', { add: [theirs.id] }), 'Saving at the other store');
  const res = need(await shop.send('GET', '/wishlist/counts'), 200, 'Save counts');
  const counts = Object.fromEntries(res.json().items.map((i) => [i.productId, i.saves]));
  assert.equal(counts[tray.id], 2);
  assert.equal(counts[cup.id], 1);
  assert.equal(counts[theirs.id], undefined, 'Another business’s saves are counted here');
  for (const item of res.json().items) assert.deepEqual(Object.keys(item).sort(), ['name', 'productId', 'saves'], 'The answer carries more than a count');
  for (const phone of phones) assert.ok(!res.text.includes(digits(phone).slice(-10)), 'A shopper’s number is in the save counts');
  assert.doesNotMatch(res.text, /shopperId|shopper_id|phone/i);
  const staff = await addStaff(world, shop, { permissions: ['catalog'] });
  need(await shop.as(staff.token)('GET', '/wishlist/counts'), 403, 'Staff without the analytics permission');
  const shopper = buyer(world, shop);
  await shopper.signIn();
  const asShopper = await shopper.api('GET', '/api/v1/wishlist/counts');
  assert.ok([401, 403].includes(asShopper.status), `A shopper read the save counts: ${asShopper.status}`);
});

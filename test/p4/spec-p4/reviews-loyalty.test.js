// PRD 9.19 (ratings and reviews) and 9.21 (loyalty points and referrals). S-81 to S-83, S-87 to S-91.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, address, addP4Shop, addStaff, assertNoLiveMarkup, assertSellerBrandOnly, buyer, need, noCrash, ok, refused, textOf, together, unique, useP4World } from './kit.js';

const world = useP4World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });

async function deliveredBuyer(shop, product) {
  const b = buyer(world, shop);
  await b.signIn();
  const row = await b.delivered({ lines: [line(product)] });
  return { b, row };
}
const rating = (shop, productId) => shop.one('SELECT review_count, rating_sum FROM product_ratings WHERE tenant_id = $1 AND product_id = $2', [shop.tenantId, productId]);
const reviewForm = (html) => /\/api\/store\/reviews|data-review-form|name=["']rating["']/i.test(html);

// ---- reviews ----

test('S-81: only a shopper with a delivered order of the product can review it; everyone else gets 403 and no button', async () => {
  const shop = await addP4Shop(world);
  const lamp = await shop.item({ name: 'Brass lamp', pricePaise: 49900, stock: 10 });
  const bell = await shop.item({ name: 'Brass bell', pricePaise: 29900, stock: 10 });
  const nobody = buyer(world, shop);
  await nobody.signIn();
  refused(await nobody.review({ orderNumber: 'X-1', productId: lamp.id, rating: 5 }), 'Reviewing with no order', [403, 404]);
  assert.ok(!reviewForm((await nobody.open(`/p/${lamp.slug}`)).text), 'The product page offers a review to a shopper with no order');
  const waiting = buyer(world, shop);
  await waiting.signIn();
  const paid = await waiting.buy({ lines: [line(lamp)] });
  refused(await waiting.review({ orderNumber: paid.order_number, productId: lamp.id, rating: 5 }), 'Reviewing before delivery', 403);
  const { b, row } = await deliveredBuyer(shop, lamp);
  refused(await b.review({ orderNumber: row.order_number, productId: bell.id, rating: 5 }), 'Reviewing a product the order did not have', 403);
  refused(await nobody.review({ orderNumber: row.order_number, productId: lamp.id, rating: 5 }), 'Reviewing on another shopper’s order', [403, 404]);
  refused(await buyer(world, shop).review({ orderNumber: row.order_number, productId: lamp.id, rating: 5 }), 'A guest reviewing', [401, 403]);
  for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 4.5 }, { rating: '5' }, { body: 'x'.repeat(1001) }, { rating: 5, status: 'approved' }, { rating: 5, displayName: 'Admin' }]) {
    refused(await b.review({ orderNumber: row.order_number, productId: lamp.id, rating: 4, ...bad }), `Review ${JSON.stringify(bad).slice(0, 50)}`, 400);
  }
  assert.ok(reviewForm((await b.open(`/p/${lamp.slug}`)).text), 'The shopper who received it is not offered a review');
  need(await b.review({ orderNumber: row.order_number, productId: lamp.id, rating: 4, body: 'Lovely glow' }), 201, 'The real review');
  refused(await b.review({ orderNumber: row.order_number, productId: lamp.id, rating: 1 }), 'A second review of the same product on the same order', [400, 409]);
  const [r] = await shop.sql('SELECT * FROM reviews WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(r.status, 'pending', 'A new review is published before the owner sees it');
  const other = await addP4Shop(world);
  const elsewhere = buyer(world, other);
  await elsewhere.signIn(b.phone);
  refused(await elsewhere.review({ orderNumber: row.order_number, productId: lamp.id, rating: 5 }), 'The same phone reviewing at another store', [403, 404]);
});

test('S-82: approving a 4-star review updates the product page average and count', async () => {
  const shop = await addP4Shop(world);
  const lamp = await shop.item({ name: 'Brass lamp', pricePaise: 49900, stock: 10 });
  const one = await deliveredBuyer(shop, lamp);
  need(await one.b.review({ orderNumber: one.row.order_number, productId: lamp.id, rating: 4, body: 'Warm light <b>bold</b><script>alert(1)</script>' }), 201, 'A 4-star review');
  const before = need(await shop.open(`/p/${lamp.slug}`), 200, 'The product page before approval');
  assert.ok(!textOf(before.text).includes('Warm light'), 'A pending review is on the store');
  const [r] = await shop.sql('SELECT id FROM reviews WHERE tenant_id = $1', [shop.tenantId]);
  const approved = need(await shop.send('POST', `/reviews/${r.id}/approve`), 200, 'Approving').json();
  assert.equal(approved.status, 'approved');
  assert.deepEqual(await rating(shop, lamp.id), { review_count: 1, rating_sum: 4 });
  const page = need(await shop.open(`/p/${lamp.slug}`), 200, 'The product page after approval');
  assert.match(textOf(page.text), /4(\.0)?\b/, 'The average does not show');
  assert.match(textOf(page.text), /\b1\s*(review|rating)/i, 'The count does not show');
  assert.ok(textOf(page.text).includes('Warm light'));
  assertNoLiveMarkup(page.text, 'A review on the product page');
  assertSellerBrandOnly(page, 'The product page with reviews');
  const two = await deliveredBuyer(shop, lamp);
  need(await two.b.review({ orderNumber: two.row.order_number, productId: lamp.id, rating: 5 }), 201, 'A 5-star review');
  const [r2] = await shop.sql('SELECT id FROM reviews WHERE tenant_id = $1 AND rating = 5', [shop.tenantId]);
  need(await shop.send('POST', `/reviews/${r2.id}/approve`), 200, 'Approving the second');
  noCrash(await shop.send('POST', `/reviews/${r2.id}/approve`), 'Approving it twice');
  assert.deepEqual(await rating(shop, lamp.id), { review_count: 2, rating_sum: 9 }, 'Approving twice counted twice');
  const list = ok(await buyer(world, shop).api('GET', `/api/store/products/${lamp.id}/reviews`), 'The reviews call').data;
  assert.equal((list.items ?? list.reviews ?? []).length, 2);
  assert.doesNotMatch(JSON.stringify(list), /\+91|phone|shopperId/i, 'The public reviews carry who wrote them beyond a first name');
  assert.match(textOf((await shop.open(`/p/${lamp.slug}`)).text), /4\.5/);
});

test('S-83: a hidden review leaves the store and the average; the admin lists it as hidden; words are never the seller’s to edit', async () => {
  const shop = await addP4Shop(world);
  const lamp = await shop.item({ name: 'Brass lamp', pricePaise: 49900, stock: 10 });
  const one = await deliveredBuyer(shop, lamp);
  need(await one.b.review({ orderNumber: one.row.order_number, productId: lamp.id, rating: 1, body: 'Arrived dented' }), 201, 'A 1-star review');
  const two = await deliveredBuyer(shop, lamp);
  need(await two.b.review({ orderNumber: two.row.order_number, productId: lamp.id, rating: 5, body: 'Beautiful' }), 201, 'A 5-star review');
  const rows = await shop.sql('SELECT id, rating FROM reviews WHERE tenant_id = $1', [shop.tenantId]);
  for (const r of rows) need(await shop.send('POST', `/reviews/${r.id}/approve`), 200, 'Approving');
  const low = rows.find((r) => r.rating === 1);
  need(await shop.send('POST', `/reviews/${low.id}/hide`), 200, 'Hiding the 1-star review');
  assert.deepEqual(await rating(shop, lamp.id), { review_count: 1, rating_sum: 5 }, 'The hidden review still counts');
  const page = textOf(need(await shop.open(`/p/${lamp.slug}`), 200, 'The product page').text);
  assert.ok(!page.includes('Arrived dented'), 'The hidden review is still on the store');
  const store = ok(await buyer(world, shop).api('GET', `/api/store/products/${lamp.id}/reviews`), 'The reviews call').data;
  assert.ok(!JSON.stringify(store).includes('Arrived dented'));
  const hidden = need(await shop.send('GET', '/reviews?status=hidden'), 200, 'The hidden reviews in the admin').json().items;
  assert.deepEqual(hidden.map((r) => r.id), [low.id]);
  assert.equal(hidden[0].body, 'Arrived dented');
  for (const [method, path] of [['PATCH', `/reviews/${low.id}`], ['PUT', `/reviews/${low.id}`]]) {
    const res = await shop.send(method, path, { body: 'Great product!', rating: 5 });
    assert.ok([400, 404, 405].includes(res.status), `${method} ${path} answered ${res.status}`);
  }
  assert.equal((await shop.one('SELECT body, rating FROM reviews WHERE tenant_id = $1 AND id = $2', [shop.tenantId, low.id])).body, 'Arrived dented');
  need(await shop.send('PUT', `/reviews/${low.id}/reply`, { reply: 'Sorry, a new one is on its way.' }), 200, 'One public reply');
  const staff = await addStaff(world, shop, { permissions: ['orders'] });
  need(await shop.as(staff.token)('POST', `/reviews/${low.id}/approve`), 403, 'Staff without catalog approving');
  const other = await addP4Shop(world);
  need(await other.send('POST', `/reviews/${low.id}/approve`), 404, 'Another business approving this review');
  const theirs = ok(await buyer(world, other).api('GET', `/api/store/products/${lamp.id}/reviews`), 'This product’s reviews on another store');
  assert.ok(!theirs.text.includes('Beautiful'), 'One business’s reviews show on another');
});

// ---- loyalty ----

test('S-87: a Rs 1,000 paid order at 1 point per Rs 100 earns 10 pending points that post when the return window closes', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  await shop.returnsOn({ windowDays: 7 });
  await shop.loyaltyOn({ earnPoints: 1, earnPerPaise: 10000 });
  const product = await shop.item({ pricePaise: 100000, stock: 5 });
  const b = buyer(world, shop);
  await b.signIn();
  const row = await b.buy({ lines: [line(product)] });
  const me = await b.me();
  const earned = await world.until(async () => (await shop.ledger(me.id)).find((e) => e.kind === 'earn'), 9000);
  assert.ok(earned, 'No points were earned on a paid order');
  assert.equal(earned.points, 10);
  assert.equal(earned.status, 'pending');
  const account = await shop.one('SELECT balance, pending FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id]);
  assert.deepEqual(account, { balance: 0, pending: 10 });
  const points = need(await b.open('/account/points'), 200, 'The points page');
  assertSellerBrandOnly(points, 'The points page');
  assert.match(textOf(points.text), /10/);
  await world.age(8 * DAY);
  await world.quiet(1500);
  assert.equal((await shop.ledger(me.id)).find((e) => e.kind === 'earn').status, 'pending', 'Points posted before the order was even delivered');
  await shop.handDeliver(row);
  await world.age(6 * DAY);
  await world.quiet(1500);
  assert.equal((await shop.ledger(me.id)).find((e) => e.kind === 'earn').status, 'pending', 'Points posted inside the return window');
  await world.age(2 * DAY);
  const posted = await world.until(async () => (await shop.ledger(me.id)).find((e) => e.kind === 'earn' && e.status === 'posted'), 12_000);
  assert.ok(posted, 'Points did not post when the return window closed');
  assert.deepEqual(await shop.one('SELECT balance, pending FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id]), { balance: 10, pending: 0 });
  assert.equal((await shop.ledger(me.id)).filter((e) => e.kind === 'earn').length, 1, 'The order earned twice');
});

test('S-87: points are earned on the amount after discount and before shipping, and an unpaid order earns none', async () => {
  const shop = await addP4Shop(world);
  await shop.loyaltyOn({ earnPoints: 1, earnPerPaise: 10000 });
  await shop.coupon({ code: 'HALF', kind: 'percent', percentBp: 5000 });
  const product = await shop.item({ pricePaise: 100000, stock: 5 });
  const b = buyer(world, shop);
  await b.signIn();
  await b.order({ lines: [line(product)] });
  await world.quiet(1000);
  assert.equal((await shop.ledger((await b.me()).id)).length, 0, 'An unpaid order earned points');
  await b.buy({ lines: [line(product)], couponCode: 'HALF' });
  const earned = await world.until(async () => (await shop.ledger((await b.me()).id)).find((e) => e.kind === 'earn'), 9000);
  assert.equal(earned.points, 5, 'Points were not worked out on the discounted amount');
});

test('S-88: redeeming above the per-order cap applies only the cap, with a notice', async () => {
  const shop = await addP4Shop(world);
  await shop.loyaltyOn({ maxRedeemPoints: 50, pointValuePaise: 100 });
  const product = await shop.item({ pricePaise: 100000, stock: 10 });
  const b = buyer(world, shop);
  await b.signIn();
  const me = await b.me();
  need(await shop.send('POST', `/loyalty/members/${me.id}/adjust`, { points: 200, note: 'Welcome gift' }), 200, 'The owner giving points');
  const q = ok(await b.quote({ lines: [line(product)], redeemPoints: 120 }), 'Quoting 120 points').data;
  assert.equal(q.pointsUsed, 50);
  assert.equal(q.loyaltyPaise, 5000);
  assert.ok(q.notices.some((n) => /50/.test(n)), `No notice about the cap: ${JSON.stringify(q.notices)}`);
  const placed = await b.order({ lines: [line(product)], redeemPoints: 120 });
  const order = await shop.order(placed.orderNumber);
  assert.equal(order.loyalty_points, 50);
  assert.equal(Number(order.loyalty_paise), 5000);
  assert.equal(Number(order.total_paise), Number(order.subtotal_paise) - 5000 + Number(order.shipping_paise) + Number(order.cod_fee_paise));
  assert.equal((await shop.one('SELECT balance FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id])).balance, 150);
  refused(await b.quote({ lines: [line(product)], redeemPoints: -10 }), 'Negative points', 400);
  refused(await b.quote({ lines: [line(product)], redeemPoints: 1.5 }), 'Half a point', 400);
  const guest = buyer(world, shop);
  const gq = noCrash(await guest.quote({ lines: [line(product)], redeemPoints: 50 }), 'A guest redeeming');
  if (gq.status === 200) assert.equal(gq.data.pointsUsed, 0, 'A guest spent points');
});

test('S-88: two checkouts at once cannot spend the same points, and points never take more than the balance', async () => {
  const shop = await addP4Shop(world);
  await shop.loyaltyOn({ maxRedeemPoints: 1000, pointValuePaise: 100 });
  const product = await shop.item({ pricePaise: 100000, stock: 10 });
  const b = buyer(world, shop);
  await b.signIn();
  const me = await b.me();
  need(await shop.send('POST', `/loyalty/members/${me.id}/adjust`, { points: 200, note: 'Gift' }), 200, 'Giving 200 points');
  const q = ok(await b.quote({ lines: [line(product)], redeemPoints: 500 }), 'Asking for more than the balance').data;
  assert.equal(q.pointsUsed, 200);
  const answers = await together(3, () => b.place(b.checkoutBody({ lines: [line(product)], redeemPoints: 150 })));
  answers.forEach((r) => noCrash(r, 'A racing redemption'));
  const spent = (await shop.orders()).reduce((n, o) => n + o.loyalty_points, 0);
  assert.ok(spent <= 200, `${spent} points spent from a balance of 200`);
  const account = await shop.one('SELECT balance FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id]);
  assert.equal(account.balance, 200 - spent);
  const other = await addP4Shop(world);
  need(await other.send('POST', `/loyalty/members/${me.id}/adjust`, { points: 1000, note: 'x' }), [403, 404], 'Another business giving this shopper points');
  const manager = await shop.manager();
  need(await manager.send('POST', `/loyalty/members/${me.id}/adjust`, { points: 1000, note: 'x' }), 403, 'A manager giving points');
});

test('S-89: a refund takes back the points the order earned, and a cancelled order gives back the points spent', async () => {
  const shop = await addP4Shop(world);
  await shop.loyaltyOn({ earnPoints: 1, earnPerPaise: 10000, maxRedeemPoints: 100 });
  const product = await shop.item({ pricePaise: 100000, stock: 10 });
  const b = buyer(world, shop);
  await b.signIn();
  const me = await b.me();
  const row = await b.buy({ lines: [line(product)] });
  await world.until(async () => (await shop.ledger(me.id)).some((e) => e.kind === 'earn'), 9000);
  need(await shop.refund(row.id, { amountPaise: Number(row.total_paise) }), 201, 'Refunding the whole order');
  await world.until(async () => (await shop.ledger(me.id)).some((e) => e.kind === 'reverse' || (e.kind === 'earn' && e.status === 'void')), 9000);
  const acc = await shop.one('SELECT balance, pending FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id]);
  assert.deepEqual(acc, { balance: 0, pending: 0 }, 'The refunded order’s points are still there');
  need(await shop.send('POST', `/loyalty/members/${me.id}/adjust`, { points: 40, note: 'Gift' }), 200, 'Giving 40 points');
  const placed = await b.order({ lines: [line(product)], redeemPoints: 40 });
  assert.equal((await shop.one('SELECT balance FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id])).balance, 0);
  const spentOn = await shop.order(placed.orderNumber);
  noCrash(await shop.cancel(spentOn.id), 'Cancelling the order that spent points');
  await world.until(async () => (await shop.ledger(me.id)).some((e) => e.kind === 'restore'), 9000);
  assert.equal((await shop.one('SELECT balance FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id])).balance, 40, 'Points spent on a cancelled order were not given back');
  noCrash(await shop.cancel(spentOn.id), 'Cancelling again');
  await world.quiet(1000);
  assert.equal((await shop.one('SELECT balance FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id])).balance, 40, 'Points were given back twice');
});

test('S-90: a friend at the referrer’s own address gets no referral reward, and neither does the referrer', async () => {
  const shop = await addP4Shop(world);
  await shop.returnsOn({ windowDays: 1 });
  await shop.loyaltyOn({ referralEnabled: true, friendRewardPaise: 10000, referrerPoints: 100 });
  const product = await shop.item({ pricePaise: 100000, stock: 10 });
  const referrer = buyer(world, shop);
  await referrer.signIn();
  const home = { line1: '12 Lake Road', line2: 'Flat 3', city: 'Pune', stateCode: '27', pincode: '411001' };
  ok(await referrer.addAddress({ ...home, isDefault: true }), 'The referrer’s address');
  const points = need(await referrer.open('/account/points'), 200, 'The referrer’s points page');
  const code = /\/refer\/([A-Z0-9]{6,12})/.exec(points.text)?.[1] ?? (await shop.one('SELECT code FROM referral_codes WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, (await referrer.me()).id]))?.code;
  assert.ok(code, 'The referrer has no referral link');
  const friend = buyer(world, shop);
  need(await friend.open(`/refer/${code}`), [200, 302, 303], 'The friend opening the link');
  await friend.signIn();
  const q = ok(await friend.quote({ lines: [line(product)], referralCode: code, address: address({ ...home, line1: '12, Lake Road' }) }), 'The friend’s quote at the same address').data;
  assert.equal(q.discountPaise + q.loyaltyPaise, 0, 'The friend got a reward at the referrer’s address');
  const row = await friend.delivered({ lines: [line(product)], referralCode: code, address: address({ ...home, line1: '12, Lake Road', name: 'Another Name' }) });
  await world.age(2 * DAY);
  await world.quiet(2000);
  const [ref] = await shop.sql('SELECT * FROM referrals WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(ref, 'The referral was not recorded');
  assert.equal(ref.status, 'blocked');
  assert.equal(ref.block_reason, 'same_address');
  assert.equal(Number(ref.friend_reward_paise), 0);
  assert.equal(Number(row.discount_paise) + Number(row.loyalty_paise), 0);
  const referrerPoints = await shop.ledger((await referrer.me()).id);
  assert.equal(referrerPoints.filter((e) => e.kind === 'referral').length, 0, 'The referrer was rewarded for a self-referral');
  const own = buyer(world, shop);
  await own.signIn(referrer.phone);
  const self = ok(await own.quote({ lines: [line(product)], referralCode: code }), 'Using one’s own code').data;
  assert.equal(self.discountPaise + self.loyaltyPaise, 0, 'A shopper rewarded themselves with their own code');
  void unique;
});

test('S-91: without the add-on, loyalty is hidden and its API answers 403', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 100000 });
  for (const [method, path, body] of [['GET', '/loyalty/settings'], ['PATCH', '/loyalty/settings', { enabled: true }], ['GET', '/loyalty/members'], ['GET', '/loyalty/referrals'], ['POST', '/loyalty/members/1/adjust', { points: 10, note: 'x' }]]) {
    need(await shop.send(method, path, body), 403, `${method} ${path} without the add-on`);
  }
  const b = buyer(world, shop);
  await b.signIn();
  need(await b.open('/account/points'), 404, 'The points page without the add-on');
  assert.doesNotMatch(textOf((await b.open('/account')).text), /\bpoints\b|refer a friend/i, 'The account shows loyalty without the add-on');
  const q = ok(await b.quote({ lines: [line(product)], redeemPoints: 50 }), 'Redeeming without the add-on').data;
  assert.equal(q.pointsUsed, 0);
  await b.buy({ lines: [line(product)] });
  await world.quiet(1000);
  assert.equal((await shop.ledger((await b.me()).id)).length, 0, 'Points were earned without the add-on');
  const t4 = await addP4Shop(world, { plan: 't4' });
  const settings = need(await t4.send('GET', '/loyalty/settings'), 200, 'Loyalty on tier 4').json();
  assert.equal(settings.available, true);
});

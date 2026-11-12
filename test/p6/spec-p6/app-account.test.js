// PRD 10.7 (the shopper app's account side): deleting the account (Apple 5.1.1(v)), app-only coupons, one-tap reorder, a category's
// pinned-first sequence, Rewards in the seller's brand, and a shared-profile shopper at a second brand. P-30, P-63, P-64, P-65,
// P-66, P-70.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accepted, addAppShop, assertNoPlatformName, buyer, digits, line, namesPlatform, newPhone, refusedStatus, stockedProducts, useP6World } from './kit.js';

const world = useP6World();

async function appStore(options = {}) {
  const shop = await addAppShop(world, options);
  const products = await stockedProducts(shop, 3);
  return { shop, products };
}

test('P-30: deleting the account in the app erases personal data, masks the tax records and ends every session', async () => {
  const { shop, products } = await appStore();
  await shop.invoiceReady();
  const app = shop.app();
  const phone = await app.signIn();
  accepted(await app.post('/api/store/addresses', { name: 'Asha Rao', phone, line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001', kind: 'home', isDefault: true }), 'A saved address');
  accepted(await app.put('/api/store/wishlist', { add: [products[0].id], remove: [] }), 'A saved item');
  const row = await app.buy({ lines: [line(products[0])], email: 'asha.rao@mail.example', address: { name: 'Asha Rao', phone, line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' } });
  await app.registerDevice();
  const me = await shop.sql('SELECT * FROM shoppers WHERE tenant_id = $1 AND phone = $2', [shop.tenantId, phone]);
  assert.equal(me.length, 1);
  // Apple requires the account to be deletable from inside the app: a bare call without the confirmation is refused.
  refusedStatus(await app.post('/api/store/app/account/delete', {}), 'Deleting with no confirmation', [400, 422]);
  refusedStatus(await app.post('/api/store/app/account/delete', { confirm: false }), 'Deleting with confirm false', [400, 422]);
  refusedStatus(await shop.app().post('/api/store/app/account/delete', { confirm: true }), 'Deleting with no session', [401]);
  const guest = shop.app();
  await guest.start('guest');
  refusedStatus(await guest.post('/api/store/app/account/delete', { confirm: true }), 'A guest deleting', [401, 403]);
  assert.equal((await shop.sql('SELECT * FROM shoppers WHERE tenant_id = $1 AND phone = $2 AND erased_at IS NULL', [shop.tenantId, phone])).length, 1, 'Nothing was erased by the refused calls');
  // The real deletion.
  const old = app.tokens.accessToken;
  const res = accepted(await app.post('/api/store/app/account/delete', { confirm: true }), 'Deleting the account');
  assert.ok(['completed', 'waiting'].includes(res.data.status));
  assert.equal(res.data.signedOut, true, 'The app is signed out');
  assertNoPlatformName(res, 'The deletion answer');
  const done = await world.until(async () => (await shop.sql(`SELECT * FROM data_requests WHERE tenant_id = $1 AND status = 'completed'`, [shop.tenantId]))[0], 15_000);
  assert.ok(done, 'The deletion never completed');
  assert.ok(Object.values(done.summary).every((v) => typeof v === 'number'), 'The request summary holds more than counts');
  const [shopper] = await shop.sql('SELECT * FROM shoppers WHERE tenant_id = $1 AND id = $2', [shop.tenantId, me[0].id]);
  assert.ok(!shopper || (shopper.erased_at && shopper.phone === null && shopper.name === '' && shopper.email === ''), 'Personal data is still there');
  assert.equal((await shop.sql('SELECT * FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me[0].id])).length, 0);
  assert.equal((await shop.sql('SELECT * FROM wishlist_items WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me[0].id])).length, 0);
  assert.equal((await shop.pushDevices()).filter((d) => d.shopper_id === me[0].id).length, 0, 'The shopper\'s push device was kept');
  const order = await shop.order(row.order_number);
  assert.ok(order && order.erased_at, 'The order, a tax record, was deleted or not masked');
  const flat = JSON.stringify(order);
  for (const pii of ['Asha Rao', digits(phone).slice(-10), 'asha.rao@mail.example', '12 Lake Road']) assert.ok(!flat.includes(pii), `The kept order still shows ${pii}`);
  assert.equal(Number(order.total_paise), Number(row.total_paise), 'Masking changed the amounts');
  const [invoice] = await shop.invoices(row.id);
  if (invoice) assert.ok(invoice.buyer_masked_at, 'The invoice\'s buyer was not masked');
  // Every session of the shopper is over: the old token and the refresh token.
  const after = await shop.app().get('/api/store/app/orders', { authorization: `Shopper ${old}` });
  assert.equal(after.status, 401, 'The deleted shopper\'s token still works');
  assert.equal((await app.refresh()).status, 401, 'The deleted shopper\'s refresh token still works');
  // The number is free again: signing in with it makes a new, empty shopper.
  const again = shop.app();
  await again.signIn(phone);
  assert.deepEqual((await again.get('/api/store/app/orders')).data.items, [], 'The new shopper sees the old orders');
});

test('P-63: an app-only coupon is rejected on the web store, with a forged app header, and applies in the app', async () => {
  const { shop, products } = await appStore();
  await shop.coupon({ code: 'APPTEN', kind: 'percent', percentBp: 1000, appOnly: true });
  await shop.coupon({ code: 'ALLTEN', kind: 'percent', percentBp: 1000 });
  const lines = [line(products[0])];
  const price = Number(products[0].pricePaise);
  // On the web store.
  const web = buyer(world, shop);
  const q = accepted(await web.quote({ lines, couponCode: 'APPTEN' }), 'A web quote with the app-only code');
  assert.equal(q.data.coupon?.applied, false, 'The web store applied an app-only coupon');
  assert.match(q.data.coupon?.message ?? '', /works only in the app/i);
  assert.equal(q.data.discountPaise, 0);
  const placed = await web.api('POST', '/api/store/checkout', web.checkoutBody({ lines, couponCode: 'APPTEN' }));
  if (placed.status < 300) {
    const order = await shop.order(placed.data.orderNumber);
    assert.equal(Number(order.discount_paise ?? 0), 0, 'The web order got the app-only discount');
    assert.ok(!order.coupon_code, 'The web order carries the app-only code');
  } else assert.ok(placed.status >= 400 && placed.status < 500, `Web checkout answered ${placed.status}`);
  assert.equal(accepted(await web.quote({ lines, couponCode: 'ALLTEN' })).data.coupon.applied, true, 'An ordinary coupon still works on the web');
  // A forged header on the web: the app's four headers with no app session, then with a guest session of another business.
  const forged = { 'x-app': 'shopper', 'x-app-tenant': String(shop.tenantId), 'x-app-version': '1.0.0', 'x-app-platform': 'android', 'x-app-channel': 'app' };
  const fq = await web.api('POST', '/api/store/checkout/quote', { lines, couponCode: 'APPTEN' }, forged);
  if (fq.status < 300) assert.equal(fq.data.coupon?.applied, false, 'App headers on the web store unlocked the app-only coupon');
  // A channel or app flag in the body is refused or ignored; either way the coupon stays off.
  for (const extra of [{ channel: 'app' }, { appOnly: true }, { source: 'app' }]) {
    const r = await web.api('POST', '/api/store/checkout/quote', { lines, couponCode: 'APPTEN', ...extra });
    if (r.status < 300) assert.equal(r.data.coupon?.applied, false, `${Object.keys(extra)[0]} in the body unlocked the coupon`);
    else assert.ok(r.status === 400 || r.status === 422);
  }
  // Another business's app session on this host does not count either.
  const other = await appStore();
  const otherApp = other.shop.app();
  await otherApp.start('guest');
  const crossed = await web.api('POST', '/api/store/checkout/quote', { lines, couponCode: 'APPTEN' }, { 'x-app': 'shopper', 'x-app-tenant': String(other.shop.tenantId), authorization: `Shopper ${otherApp.tokens.accessToken}` });
  if (crossed.status < 300) assert.equal(crossed.data.coupon?.applied, false);
  // In the app it applies, and the order records the discount from the server's own arithmetic.
  const app = shop.app();
  await app.start('guest');
  const aq = accepted(await app.post('/api/store/checkout/quote', { lines, couponCode: 'APPTEN' }), 'An app quote').data;
  assert.equal(aq.coupon.applied, true);
  assert.equal(aq.discountPaise, Math.round(price * 0.1));
  const order = await app.order({ lines, couponCode: 'APPTEN' });
  const row = await shop.order(order.orderNumber);
  assert.equal(row.channel, 'app');
  assert.equal(row.coupon_code, 'APPTEN');
  // The seller's coupon list says which are app-only.
  const listed = (await shop.must('GET', '/coupons')).items.find((c) => c.code === 'APPTEN');
  assert.equal(listed.appOnly, true);
});

test('P-64: Reorder fills the cart at today\'s price, names what is missing, caps what is short, and preselects the saved address', async () => {
  const { shop, products } = await appStore();
  const [kettle, mug, tray] = products;
  const app = shop.app();
  const phone = await app.signIn();
  const saved = accepted(await app.post('/api/store/addresses', { name: 'Asha Rao', phone, line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001', kind: 'home', isDefault: true })).data;
  const row = await app.buy({ lines: [line(kettle, 2), line(mug, 1), line(tray, 1)], addressId: saved.id });
  await shop.handDeliver(row);
  // Today: the mug is out of stock, the tray is off sale, the kettle costs more and only one is left.
  await shop.sql('UPDATE products SET stock = 0 WHERE tenant_id = $1 AND id = $2', [shop.tenantId, mug.id]);
  await shop.sql('UPDATE products SET active = false WHERE tenant_id = $1 AND id = $2', [shop.tenantId, tray.id]);
  await shop.sql('UPDATE products SET stock = 1 WHERE tenant_id = $1 AND id = $2', [shop.tenantId, kettle.id]);
  await shop.must('PATCH', `/products/${kettle.id}`, { pricePaise: Number(kettle.pricePaise) + 5000 }, 200, 'Repricing the kettle');
  const res = accepted(await app.post(`/api/store/app/orders/${row.order_number}/reorder`), 'Reorder');
  const out = res.data;
  assert.equal(out.added, 1, 'Only the kettle can be bought');
  assert.deepEqual(out.missing.map((m) => m.name).sort(), [mug.name, tray.name].sort(), 'The missing items are named');
  assert.equal(out.missing.find((m) => m.name === mug.name).reason, 'sold_out');
  assert.equal(out.missing.find((m) => m.name === tray.name).reason, 'inactive');
  const kettleLine = out.lines.find((l) => l.productId === kettle.id);
  assert.equal(kettleLine.unitPaise, Number(kettle.pricePaise) + 5000, 'Today\'s price, not the old one');
  assert.equal(kettleLine.qty, 1, 'Cut to what is left');
  assert.ok(out.capped.some((c) => c.name === kettle.name), 'The cut is reported');
  assert.equal(out.addressId, saved.id, 'The saved address is preselected');
  assertNoPlatformName(res, 'Reorder');
  // The cart really holds it, and nothing was ordered or paid.
  const cart = accepted(await app.getCart()).data;
  assert.deepEqual(cart.lines.map((l) => l.productId), [kettle.id]);
  assert.equal((await shop.orders()).length, 1, 'Reorder placed an order');
  // The client cannot name a price or a quantity: the call takes no body.
  const forged = await app.post(`/api/store/app/orders/${row.order_number}/reorder`, { lines: [{ productId: kettle.id, qty: 99, pricePaise: 1 }] });
  if (forged.status < 300) assert.ok(!forged.data.lines.some((l) => l.unitPaise === 1 || l.qty === 99));
  // Reorder twice: the cart is the same, not doubled.
  accepted(await app.post(`/api/store/app/orders/${row.order_number}/reorder`));
  assert.equal(accepted(await app.getCart()).data.lines.reduce((n, l) => n + l.qty, 0), 1);
  // Another shopper's order, a guest, and an order that is not there.
  const stranger = shop.app();
  await stranger.signIn(newPhone());
  assert.equal((await stranger.post(`/api/store/app/orders/${row.order_number}/reorder`)).status, 404, 'Another shopper\'s order');
  assert.equal((await stranger.get(`/api/store/app/orders/${row.order_number}`)).status, 404);
  refusedStatus(await shop.app().post(`/api/store/app/orders/${row.order_number}/reorder`), 'A guest', [401]);
  assert.equal((await app.post('/api/store/app/orders/NOPE-1/reorder')).status, 404);
  // Another business's order number on this business's app.
  const other = await appStore();
  const otherApp = other.shop.app();
  await otherApp.signIn(newPhone());
  const otherRow = await otherApp.buy({ lines: [line(other.products[0])] });
  assert.equal((await app.post(`/api/store/app/orders/${otherRow.order_number}/reorder`)).status, 404, 'Another business\'s order');
});

test('P-64: when nothing of an old order can be bought again, the cart stays empty and every item is named', async () => {
  const { shop, products } = await appStore();
  const app = shop.app();
  await app.signIn();
  const row = await app.buy({ lines: [line(products[0]), line(products[1])] });
  await shop.sql('UPDATE products SET active = false WHERE tenant_id = $1 AND id = ANY($2)', [shop.tenantId, [products[0].id, products[1].id]]);
  const out = accepted(await app.post(`/api/store/app/orders/${row.order_number}/reorder`)).data;
  assert.equal(out.added, 0);
  assert.equal(out.missing.length, 2);
  assert.equal(accepted(await app.getCart()).data.lines.length, 0);
});

test('P-65: the app\'s category screen shows the pinned reel first, then the set order', async () => {
  const { shop, products } = await appStore();
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await shop.page({ productIds: [products[i % 3].id], caption: `Reel ${i}` }));
  const category = await shop.category(`Tea ${shop.tenantId}`);
  await shop.addToCategory(category.id, pages.map((p) => p.id));
  const app = shop.app();
  await app.start('guest');
  const read = async () => accepted(await app.get(`/api/store/app/categories/${category.slug}`), 'The category screen').data.reels.map((r) => r.slug);
  assert.deepEqual(await read(), pages.map((p) => p.slug), 'The set sequence');
  // Reorder and pin the third reel.
  const set = [pages[3], pages[1], pages[0], pages[2]];
  await shop.setOrder(category.id, set.map((p) => p.id), [pages[2].id]);
  const slugs = await read();
  assert.equal(slugs[0], pages[2].slug, 'The pinned reel is first');
  assert.deepEqual(slugs.slice(1), [pages[3], pages[1], pages[0]].map((p) => p.slug), 'Then the set order');
  const card = accepted(await app.get(`/api/store/app/categories/${category.slug}`)).data.reels;
  assert.equal(card[0].pinned, true);
  assert.ok(card.slice(1).every((r) => r.pinned === false));
  // The Reels tab filtered by the category agrees.
  const tab = accepted(await app.get(`/api/store/app/reels?category=${category.slug}`)).data.items.map((r) => r.slug);
  assert.deepEqual(tab, slugs, 'The Reels tab and the category screen agree');
  // A pinned reel moved in the category's sequence later does not lose its place.
  await shop.addToCategory(category.id, (await shop.page({ productIds: [products[0].id] })).id);
  assert.equal((await read())[0], pages[2].slug);
  // Another business's category slug is nothing here.
  const other = await appStore();
  const otherCategory = await other.shop.category(`Tea ${other.shop.tenantId}`);
  assert.equal((await app.get(`/api/store/app/categories/${otherCategory.slug}`)).status, 404);
});

test('P-66: after an order, Rewards shows the points balance and a referral link on the seller\'s own host, in the seller\'s brand', async () => {
  const { shop, products } = await appStore({ name: 'Kesar Kitchen' });
  await shop.loyaltyOn({ referralEnabled: true, friendRewardPaise: 10000, referrerPoints: 100 });
  const app = shop.app();
  await app.signIn();
  const before = accepted(await app.get('/api/store/app/rewards')).data;
  assert.equal(before.enabled, true);
  assert.equal(before.pointsBalance, 0);
  const row = await app.buy({ lines: [line(products[0], 3)] });
  await shop.handDeliver(row);
  const rewards = await world.until(async () => {
    const r = (await app.get('/api/store/app/rewards')).data;
    return r.pointsBalance > 0 ? r : null;
  }, 15_000);
  assert.ok(rewards, 'No points were earned');
  assert.equal(rewards.pointsBalance, Math.floor((Number(row.total_paise) / 10000) * 1));
  assert.ok(rewards.valuePaise > 0 && Number.isInteger(rewards.valuePaise));
  assert.ok(rewards.history.length >= 1 && rewards.history[0].orderNumber === row.order_number);
  assert.ok(rewards.referral, 'No referral link');
  assert.match(rewards.referral.url, new RegExp(`^https://${shop.host.replace(/\./g, '\\.')}/refer/[A-Z0-9]{6,12}$`), 'The link is on the seller\'s own host');
  assert.ok(rewards.referral.text.includes(shop.name.slice(0, 30)) || rewards.referral.text.length > 0);
  assertNoPlatformName({ text: JSON.stringify(rewards), headers: {} }, 'Rewards');
  // The link is one the app opens (it is in the open list), and the code is this shopper's own.
  assert.ok(new URL(rewards.referral.url).pathname.startsWith('/refer/'));
  // Another shopper has their own balance and code.
  const other = shop.app();
  await other.signIn(newPhone());
  const theirs = accepted(await other.get('/api/store/app/rewards')).data;
  assert.equal(theirs.pointsBalance, 0);
  assert.notEqual(theirs.referral?.code, rewards.referral.code);
  // Loyalty off for the business: Rewards says so and shows no balance or link.
  const bare = await appStore();
  const bareApp = bare.shop.app();
  await bareApp.signIn();
  const off = accepted(await bareApp.get('/api/store/app/rewards')).data;
  assert.equal(off.enabled, false);
  assert.equal(off.referral, null);
});

test('P-70: a shared-profile shopper signs in at a second brand\'s app with the same verified phone, sees saved addresses and none of the first brand\'s orders', async () => {
  const a = await appStore({ name: 'Leafy Corner' });
  const b = await appStore({ name: 'Brass Bazaar' });
  const phone = newPhone();
  const atA = a.shop.app();
  await atA.signIn(phone);
  accepted(await atA.post('/api/store/addresses', { name: 'Asha Rao', phone, line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001', kind: 'home', isDefault: true }));
  const orderA = await atA.buy({ lines: [line(a.products[0])] });
  // The shared-profile consent, given in the app on the one screen that names the platform.
  await world.sql(`INSERT INTO shared_consent_notices (version, body_en, body_hi) VALUES (1, 'Shared profile notice', 'साझा प्रोफ़ाइल सूचना') ON CONFLICT DO NOTHING`);
  const [{ v }] = await world.sql('SELECT max(version)::int AS v FROM shared_consent_notices');
  let consented;
  for (const body of [{ noticeVersion: v }, { noticeVersion: v, agree: true }, { noticeVersion: v, granted: true }]) {
    consented = await atA.post('/api/store/shared-profile', body);
    if (consented.status < 300) break;
  }
  accepted(consented, 'Giving the shared-profile consent in the app');
  // At B: the same phone, verified again by WhatsApp. The app learns it is a shared profile.
  const atB = b.shop.app();
  await atB.signIn(phone);
  const me = accepted(await atB.get('/api/store/app/me')).data;
  assert.equal(me.sharedProfile.available, true);
  const addresses = accepted(await atB.get('/api/store/addresses')).data;
  assert.ok(JSON.stringify(addresses).includes('12 Lake Road'), 'B does not offer the address saved at A');
  assert.deepEqual(accepted(await atB.get('/api/store/app/orders')).data.items, [], 'B shows orders of A');
  assert.equal((await atB.get(`/api/store/app/orders/${orderA.order_number}`)).status, 404);
  assert.equal((await atB.post(`/api/store/app/orders/${orderA.order_number}/reorder`)).status, 404);
  // B checks out and the order is B's alone.
  const orderB = await atB.buy({ lines: [line(b.products[0])] });
  assert.equal((await a.shop.orders()).length, 1);
  assert.equal((await b.shop.orders()).length, 1);
  assert.equal(orderB.tenant_id, b.shop.tenantId);
  assert.equal((await atA.get('/api/store/app/orders')).data.items.length, 1);
  // A session of A's app is not a session at B.
  const sneaky = b.shop.app();
  sneaky.tokens.accessToken = atA.tokens.accessToken;
  assert.equal((await sneaky.get('/api/store/app/orders')).status, 401);
  // Without the consent a shopper at C with only the same phone typed in gets none of A's addresses.
  const c = await appStore({ name: 'Cedar Corner' });
  const atC = c.shop.app();
  await atC.signIn(newPhone());
  assert.ok(!JSON.stringify((await atC.get('/api/store/addresses')).data).includes('12 Lake Road'));
  // Withdrawing the consent: B asks for nothing of A any more.
  accepted(await atA.call('DELETE', '/api/store/shared-profile'), 'Withdrawing consent');
  const fresh = b.shop.app();
  await fresh.signIn(phone);
  assert.deepEqual((await fresh.get('/api/store/app/orders')).data.items.map((o) => o.orderNumber), [orderB.order_number], 'Only B\'s own order remains');
  assert.ok(!namesPlatform(JSON.stringify((await fresh.get('/api/store/app/me')).data)), 'The profile answer names the platform');
});

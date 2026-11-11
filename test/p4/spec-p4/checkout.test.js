// PRD 9.4 (addresses) and 9.5 (checkout and order creation). S-12 to S-18, S-21, S-22, S-33, S-68, S-69, S-93 to S-95.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, PINCODE_MESSAGE, STORE_LIMITS, address, addP4Shop, attrsOf, buyer, idemKey, need, newPhone, noCrash, ok, refused, sum, textOf, together, useP4World } from './kit.js';

const world = useP4World();
const line = (product, qty = 1, variantId = null) => ({ productId: product.id, variantId, qty });
const mode = (quote, m) => quote.paymentModes.find((p) => p.mode === m);

// ---- addresses ----

test('S-12: a PIN starting with 0 is refused with "Enter a 6-digit PIN code", wherever it is typed', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item();
  const b = buyer(world, shop);
  await b.signIn();
  for (const pincode of ['012345', '000000', '12345', '1234567', 'abcdef', '41100l', ' 411001', '411 001', '４１１００１']) {
    const saved = refused(await b.addAddress({ pincode }), `Saving the PIN ${JSON.stringify(pincode)}`, 400);
    if (pincode === '012345') assert.ok(saved.text.includes(PINCODE_MESSAGE), `The message is not "${PINCODE_MESSAGE}": ${saved.text.slice(0, 200)}`);
    const placed = refused(await b.place(b.checkoutBody({ lines: [line(product)], address: address({ pincode }) })), `Checkout with the PIN ${JSON.stringify(pincode)}`, 400);
    if (pincode === '012345') assert.ok(placed.text.includes(PINCODE_MESSAGE));
  }
  refused(await b.api('GET', '/api/store/serviceability?pincode=012345'), 'Serviceability of 012345', 400);
  assert.equal((await shop.orders()).length, 0);
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM shopper_addresses WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(n, 0);
  ok(await b.addAddress({ pincode: '110001' }), 'A good PIN');
});

test('S-12: every address field is held to its limits, and an unknown field is refused', async () => {
  const shop = await addP4Shop(world);
  const b = buyer(world, shop);
  await b.signIn();
  for (const bad of [{ name: 'A' }, { name: 'x'.repeat(81) }, { line1: 'ab' }, { line1: 'x'.repeat(201) }, { city: '' }, { stateCode: 'MH' }, { stateCode: '99x' }, { kind: 'castle' }, { phone: '12' }, { name: 'Asha\u0000Rao' }, { shopperId: 1 }, { tenantId: 1 }]) {
    refused(await b.addAddress(bad), `Address with ${JSON.stringify(bad).slice(0, 60)}`, 400);
  }
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM shopper_addresses WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(n, 0);
});

/** The element of `html` that names this address id, and whether it is the chosen one. */
function choice(html, id) {
  const tags = [...String(html).matchAll(/<(input|option|label|div|li|button|article)\b[^>]*>/gi)].map((m) => m[0]).filter((tag) => new RegExp(`(?:value|data-address-id|data-id|id)=["'](?:address-?)?${id}["']`).test(tag));
  return { found: tags.length > 0, chosen: tags.some((tag) => /\b(checked|selected)\b|aria-(checked|selected)=["']true/i.test(tag) || attrsOf(tag)['data-default'] === 'true') };
}

test('S-13: the second address marked default is the one checkout preselects, and only one is ever default', async () => {
  const shop = await addP4Shop(world);
  await shop.item();
  const b = buyer(world, shop);
  await b.signIn();
  const first = ok(await b.addAddress({ line1: '1 First Street', isDefault: true }), 'The first address').data;
  const second = ok(await b.addAddress({ line1: '2 Second Street' }), 'The second address').data;
  ok(await b.updateAddress(second.id, { ...address({ line1: '2 Second Street' }), isDefault: true }), 'Marking the second as default');
  const list = ok(await b.addresses(), 'The saved addresses').data;
  const items = list.items ?? list;
  assert.deepEqual(items.filter((a) => a.isDefault).map((a) => a.id), [second.id], 'Not exactly the second address is default');
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM shopper_addresses WHERE tenant_id = $1 AND is_default', [shop.tenantId]);
  assert.equal(n, 1);
  const page = need(await b.open('/checkout'), 200, 'The checkout page');
  assert.ok(page.text.includes('2 Second Street'), 'Checkout does not show the default address');
  const two = choice(page.text, second.id);
  const one = choice(page.text, first.id);
  assert.ok(two.found && two.chosen, 'Checkout does not preselect the default address');
  assert.ok(!one.chosen, 'Checkout preselects the old default');
});

test('S-13: another shopper’s or another business’s address id is nobody’s to read, change or ship to', async () => {
  const shop = await addP4Shop(world);
  const other = await addP4Shop(world);
  const product = await shop.item();
  const owner = buyer(world, shop);
  await owner.signIn();
  const mine = ok(await owner.addAddress({ line1: '7 Private Lane' }), 'An address').data;
  const thief = buyer(world, shop);
  await thief.signIn();
  refused(await thief.updateAddress(mine.id, address({ line1: 'Taken over' })), 'Changing another shopper’s address', [403, 404]);
  refused(await thief.removeAddress(mine.id), 'Removing another shopper’s address', [403, 404]);
  assert.ok(!ok(await thief.addresses(), 'The thief’s addresses').text.includes('Private Lane'));
  refused(await thief.place(thief.checkoutBody({ lines: [line(product)], addressId: mine.id })), 'Shipping to another shopper’s saved address', [400, 403, 404, 409, 422]);
  refused(await buyer(world, shop).place(buyer(world, shop).checkoutBody({ lines: [line(product)], addressId: mine.id })), 'A guest shipping to a saved address', [400, 401, 403, 404, 422]);
  const elsewhere = buyer(world, other);
  await elsewhere.signIn(owner.phone);
  refused(await elsewhere.updateAddress(mine.id, address()), 'The same phone at another business changing it', [403, 404]);
  const [row] = await shop.sql('SELECT line1 FROM shopper_addresses WHERE tenant_id = $1 AND id = $2', [shop.tenantId, mine.id]);
  assert.equal(row.line1, '7 Private Lane');
  assert.equal((await shop.orders()).length, 0);
});

test('S-14: a past order keeps the address it was placed with, whatever is edited or removed later', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item();
  const b = buyer(world, shop);
  await b.signIn();
  const saved = ok(await b.addAddress({ name: 'Asha Rao', line1: '12 Lake Road', city: 'Pune', pincode: '411001' }), 'An address').data;
  const placed = await b.order({ lines: [line(product)], addressId: saved.id });
  ok(await b.updateAddress(saved.id, address({ name: 'Someone Else', line1: '99 New Road', city: 'Mumbai', pincode: '400001', stateCode: '27' })), 'Editing the address');
  const order = await shop.order(placed.orderNumber);
  assert.equal(order.shipping_address.line1, '12 Lake Road');
  assert.equal(order.shipping_address.pincode, '411001');
  assert.equal(order.shipping_address.name, 'Asha Rao');
  const detail = await shop.orderApi(order.id);
  assert.match(detail.address, /12 Lake Road/);
  assert.equal(detail.pincode, '411001');
  const page = need(await b.open(`/account/orders/${encodeURIComponent(placed.orderNumber)}`), 200, 'The order in the account');
  assert.ok(textOf(page.text).includes('12 Lake Road') && !textOf(page.text).includes('99 New Road'), 'The account shows the edited address on the old order');
  noCrash(await b.removeAddress(saved.id), 'Removing the address');
  assert.equal((await shop.order(placed.orderNumber)).shipping_address.line1, '12 Lake Road');
});

// ---- placing an order ----

test('S-15: a double tap, or ten, places exactly one order and one gateway order', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 49900, stock: 5 });
  const b = buyer(world, shop);
  const body = b.checkoutBody({ lines: [line(product)] });
  const answers = await together(10, () => b.place(body));
  for (const res of answers) noCrash(res, 'A repeated tap');
  const taken = answers.filter((r) => r.status < 300);
  assert.ok(taken.length >= 1, 'No tap placed the order');
  assert.equal(new Set(taken.map((r) => r.data.orderNumber)).size, 1, 'Two taps answered with different orders');
  assert.equal((await shop.orders()).length, 1);
  assert.equal(new Set(taken.map((r) => r.data.gateway?.gatewayOrderId)).size, 1, 'Two gateway orders for one checkout');
  const later = ok(await b.place(body), 'The same tap a minute later');
  assert.equal(later.data.orderNumber, taken[0].data.orderNumber);
  const created = await world.rzp.calls({ method: 'POST', path: '/v1/orders' });
  assert.equal(created.filter((c) => c.body?.receipt === taken[0].data.orderNumber).length, 1, 'The gateway order was created more than once');
  const stock = await shop.stockOf(product.id);
  assert.equal(stock.reserved, 1, 'A double tap held two units');
});

test('S-15: the same key with a different bag is never a second order', async () => {
  const shop = await addP4Shop(world);
  const cheap = await shop.item({ pricePaise: 10000 });
  const dear = await shop.item({ pricePaise: 900000 });
  const b = buyer(world, shop);
  const body = b.checkoutBody({ lines: [line(cheap)] });
  const first = ok(await b.place(body), 'The first tap');
  const changed = noCrash(await b.place({ ...body, lines: [line(dear, 3)] }), 'The same key with other lines');
  assert.equal((await shop.orders()).length, 1, 'The same key made a second order');
  if (changed.status < 300) assert.equal(changed.data.orderNumber, first.data.orderNumber);
  const order = await shop.order(first.data.orderNumber);
  assert.equal(Number(order.subtotal_paise), 10000, 'The order was rewritten by a later tap');
  for (const key of ['short', 'x'.repeat(81), 'has space here', 'semi;colon1', '']) refused(await b.place({ ...body, idempotencyKey: key }), `Key ${JSON.stringify(key)}`, 400);
});

test('S-16: two shoppers tapping for the last unit at once: one order, the other told it is sold out', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ name: 'Last lamp', pricePaise: 120000, stock: 1 });
  const [x, y] = [buyer(world, shop), buyer(world, shop)];
  const answers = await Promise.all([x.place(x.checkoutBody({ lines: [line(product)] })), y.place(y.checkoutBody({ lines: [line(product)] }))]);
  for (const res of answers) noCrash(res, 'A shopper racing for the last unit');
  const won = answers.filter((r) => r.status < 300);
  const lost = answers.filter((r) => r.status >= 400);
  assert.equal(won.length, 1, `${won.length} shoppers got the last unit`);
  assert.equal(lost.length, 1);
  assert.match(lost[0].text, /sold out/i, `The other shopper is not told it is sold out: ${lost[0].text.slice(0, 200)}`);
  assert.equal((await shop.orders()).length, 1);
  const stock = await shop.stockOf(product.id);
  assert.ok(stock.stock >= 0 && stock.reserved <= stock.stock, `Stock ${stock.stock}, held ${stock.reserved}`);
  assert.equal(Number(stock.stock) - Number(stock.reserved), 0);
});

test('S-16: eight shoppers for three units, and one asking for more than is left', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 50000, stock: 3 });
  const answers = await together(8, () => {
    const b = buyer(world, shop);
    return b.place(b.checkoutBody({ lines: [line(product)] }));
  });
  answers.forEach((r) => noCrash(r, 'A racing shopper'));
  assert.equal(answers.filter((r) => r.status < 300).length, 3);
  const greedy = buyer(world, shop);
  const product2 = await shop.item({ pricePaise: 50000, stock: 2 });
  const res = refused(await greedy.place(greedy.checkoutBody({ lines: [line(product2, 3)] })), 'Three of something with two left');
  assert.match(res.text, /sold out|only \d|left/i);
  const stock = await shop.stockOf(product.id);
  assert.equal(stock.reserved, 3);
  assert.equal((await shop.orders()).length, 3);
});

test('S-17: an order after a DM link for reel X has reel X as its source, and a claimed source is checked', async () => {
  const shop = await addP4Shop(world);
  const other = await addP4Shop(world);
  const product = await shop.item({ name: 'Kurta from reel X' });
  const reelX = await shop.page({ productIds: [product.id], caption: 'Reel X' });
  const reelY = await shop.page({ productIds: [product.id], caption: 'Reel Y' });
  const theirs = await other.page({ caption: 'Another business reel' });
  const b = buyer(world, shop);
  need(await b.open(`/r/${reelX.slug}?utm_source=instagram&utm_medium=dm&utm_campaign=reel-x`), 200, 'The landing page from the DM link');
  const placed = await b.order({ lines: [line(product)], pageSlug: reelX.slug, utm: { utm_source: 'instagram', utm_medium: 'dm', utm_campaign: 'reel-x' } });
  const order = await shop.order(placed.orderNumber);
  assert.equal(order.page_id, reelX.id, 'The order’s source is not the reel of the DM link');
  assert.equal(order.utm.utm_source ?? order.utm.source, 'instagram');
  assert.ok(order.visitor_id, 'The order is not tied to the visit');

  const claim = buyer(world, shop);
  need(await claim.open(`/r/${reelX.slug}`), 200, 'Visiting reel X');
  const claimed = await claim.order({ lines: [line(product)], pageSlug: reelY.slug });
  assert.notEqual((await shop.order(claimed.orderNumber)).page_id, reelY.id, 'A reel the shopper never opened was taken as the source on the page’s word');
  const foreign = buyer(world, shop);
  const f = await foreign.order({ lines: [line(product)], pageSlug: theirs.slug });
  assert.equal((await shop.order(f.orderNumber)).page_id, null, 'Another business’s reel became this order’s source');
  const ghost = await buyer(world, shop).order({ lines: [line(product)], pageSlug: 'no-such-reel' });
  assert.equal((await shop.order(ghost.orderNumber)).page_id, null);
  refused(await b.place(b.checkoutBody({ lines: [line(product)], utm: { utm_source: 'x'.repeat(201) } })), 'A UTM value over 200 characters', 400);
});

test('S-18: twenty order attempts from one address in ten minutes across two instances, then 429', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 10000 });
  const second = await world.secondInstance();
  const ip = '198.51.100.201';
  const { limit } = STORE_LIMITS.orderAttempts;
  for (let i = 0; i < limit; i++) {
    const b = buyer(world, shop, { ip, app: i % 2 ? second : world });
    ok(await b.place(b.checkoutBody({ lines: [line(product)] })), `Order attempt ${i + 1}`);
  }
  for (const app of [world, second]) {
    const b = buyer(world, shop, { ip, app });
    const res = refused(await b.place(b.checkoutBody({ lines: [line(product)] })), 'Attempt 21', 429);
    assert.ok(res.headers['retry-after'] === undefined || Number(res.headers['retry-after']) > 0);
  }
  assert.equal((await shop.orders()).length, limit);
  const elsewhere = buyer(world, shop, { ip: '198.51.100.202' });
  ok(await elsewhere.place(elsewhere.checkoutBody({ lines: [line(product)] })), 'Another address');
  await world.age(STORE_LIMITS.orderAttempts.windowMs + MINUTE);
  const again = buyer(world, shop, { ip });
  ok(await again.place(again.checkoutBody({ lines: [line(product)] })), 'The same address after ten minutes');
});

test('S-93: a guest pays by UPI with no sign-in, no code and no account made', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 49900 });
  const b = buyer(world, shop);
  const placed = await b.order({ lines: [line(product)], paymentMode: 'prepaid' });
  assert.equal(placed.next, 'pay');
  assert.ok(placed.gateway?.gatewayOrderId);
  assert.ok(!b.signedIn, 'Placing the order signed the guest in');
  const [{ n: codes }] = await shop.sql('SELECT count(*)::int AS n FROM shopper_otps WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(codes, 0, 'A code was made for a prepaid order');
  const paid = await b.pay(placed, { method: 'upi' });
  ok(paid.res, 'Coming back from the gateway');
  const order = await shop.orderWhen(placed.orderNumber, (o) => o.payment_status === 'paid');
  assert.equal(order.payment_status, 'paid');
  assert.equal(order.fulfilment_status, 'new');
  assert.equal(order.shopper_id, null);
  assert.equal((await shop.shopperRows()).length, 0, 'A guest order made an account');
  need(await b.open(`/order/${placed.token}`), 200, 'The guest’s order page');
});

test('S-94: a guest choosing cash on delivery gets a code first, and the order exists only after the right one', async () => {
  const shop = await addP4Shop(world);
  await shop.codOn();
  const product = await shop.item({ pricePaise: 79900, stock: 4 });
  const b = buyer(world, shop);
  const phone = newPhone();
  const body = b.checkoutBody({ lines: [line(product)], paymentMode: 'cod', address: address({ phone }) });
  const first = ok(await b.place(body), 'Placing a COD order as a guest');
  assert.equal(first.data.next, 'verify_phone');
  assert.equal((await shop.orders()).length, 0, 'The order exists before the phone is verified');
  assert.equal((await shop.stockOf(product.id)).reserved, 0, 'Stock is held before the phone is verified');
  ok(await b.sendCode(phone, 'cod', { checkoutKey: body.idempotencyKey }), 'Asking for the COD code');
  const code = await world.codeFor(phone);
  ok(await b.verifyCode(phone, code, 'cod', { checkoutKey: body.idempotencyKey }), 'The right code');
  const placed = ok(await b.place(body), 'Placing it again after the code');
  assert.equal(placed.data.next, 'done');
  const order = await shop.order(placed.data.orderNumber);
  assert.equal(order.payment_mode, 'cod');
  assert.equal(order.payment_status, 'cod_due');
  assert.equal(order.fulfilment_status, 'new');
  assert.equal(Number(order.balance_paise), Number(order.total_paise));
  assert.equal(Number(order.advance_paise), 0);
  const stock = await shop.stockOf(product.id);
  assert.equal(Number(stock.stock), 3, 'Cash on delivery does not take the stock when the order is made');
  // The code unlocked that checkout only.
  const other = b.checkoutBody({ lines: [line(product)], paymentMode: 'cod', address: address({ phone: newPhone() }) });
  assert.equal(ok(await b.place(other), 'Another COD checkout to another phone').data.next, 'verify_phone');
  assert.equal((await shop.orders()).length, 1);
});

test('S-95: three wrong COD codes make no order; the shopper can ask again or pay online', async () => {
  const shop = await addP4Shop(world);
  await shop.codOn();
  const product = await shop.item({ pricePaise: 79900 });
  const b = buyer(world, shop);
  const phone = newPhone();
  const body = b.checkoutBody({ lines: [line(product)], paymentMode: 'cod', address: address({ phone }) });
  assert.equal(ok(await b.place(body), 'COD as a guest').data.next, 'verify_phone');
  ok(await b.sendCode(phone, 'cod', { checkoutKey: body.idempotencyKey }), 'The code');
  const code = await world.codeFor(phone);
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 3; i++) refused(await b.verifyCode(phone, wrong, 'cod', { checkoutKey: body.idempotencyKey }), `Wrong COD code ${i + 1}`);
  refused(await b.verifyCode(phone, code, 'cod', { checkoutKey: body.idempotencyKey }), 'The right code after three wrong ones');
  const after = noCrash(await b.place(body), 'Placing the COD order after three wrong codes');
  assert.ok(after.status >= 400 || after.data.next === 'verify_phone', 'Three wrong codes still placed the order');
  assert.equal((await shop.orders()).length, 0);
  ok(await b.sendCode(phone, 'cod', { checkoutKey: body.idempotencyKey }), 'Asking for a new code');
  const online = ok(await b.place({ ...body, paymentMode: 'prepaid', idempotencyKey: idemKey() }), 'Paying online instead');
  assert.equal(online.data.next, 'pay');
  assert.equal((await shop.orders()).length, 1);
});

test('S-94: a verified COD checkout cannot be stretched to another bag, another phone or another store', async () => {
  const shop = await addP4Shop(world);
  const other = await addP4Shop(world);
  await shop.codOn();
  await other.codOn();
  const cheap = await shop.item({ pricePaise: 10000 });
  const b = buyer(world, shop);
  const phone = newPhone();
  const body = b.checkoutBody({ lines: [line(cheap)], paymentMode: 'cod', address: address({ phone }) });
  ok(await b.place(body), 'COD');
  ok(await b.sendCode(phone, 'cod', { checkoutKey: body.idempotencyKey }), 'The code');
  ok(await b.verifyCode(phone, await world.codeFor(phone), 'cod', { checkoutKey: body.idempotencyKey }), 'The right code');
  const swapped = noCrash(await b.place({ ...body, address: address({ phone: newPhone() }) }), 'The same key with another phone');
  assert.ok(swapped.status >= 400 || swapped.data.next === 'verify_phone', 'A code that proved one phone placed a COD order to another');
  assert.equal((await shop.orders()).length, 0);
  const theirItem = await other.item({ pricePaise: 10000 });
  const elsewhere = buyer(world, other);
  elsewhere.jar._vid = b.jar._vid;
  const res = ok(await elsewhere.place(elsewhere.checkoutBody({ lines: [line(theirItem)], paymentMode: 'cod', address: address({ phone }), idempotencyKey: body.idempotencyKey })), 'The same phone and key at another store');
  assert.equal(res.data.next, 'verify_phone', 'A COD code verified at one store placed an order at another');
  assert.equal((await other.orders()).length, 0);
});

// ---- cash on delivery rules ----

test('S-22: above the COD cap, cash on delivery is hidden with the reason, and refused if sent anyway', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 500000 });
  await shop.codOn({ codMaxOrderPaise: 400000 });
  const b = buyer(world, shop);
  const quote = ok(await b.quote({ lines: [line(product)], address: address() }), 'Quoting above the cap').data;
  const cod = mode(quote, 'cod');
  assert.ok(cod && cod.available === false, 'COD is offered above the cap');
  assert.ok(cod.reason.length > 0, 'No reason is given');
  assert.match(cod.reason, /4,?000|cap|above|up to|limit/i, `The reason does not explain the cap: ${cod.reason}`);
  assert.ok(quote.notices.some((n) => n === cod.reason || /cash on delivery|COD/i.test(n)), 'The shopper is not told why');
  refused(await b.place(b.checkoutBody({ lines: [line(product)], paymentMode: 'cod' })), 'COD above the cap sent anyway');
  assert.equal((await shop.orders()).length, 0);
  // Exactly at the cap is allowed; a paisa under the subtotal is not.
  const at = ok(await b.quote({ lines: [line(product)], address: address() }), 'A quote').data;
  await shop.codOn({ codMaxOrderPaise: at.totalPaise });
  assert.equal(mode(ok(await b.quote({ lines: [line(product)], address: address() }), 'At the cap').data, 'cod').available, true, 'COD is hidden for an order exactly at the cap');
  await shop.codOn({ codMaxOrderPaise: at.subtotalPaise - 1 });
  assert.equal(mode(ok(await b.quote({ lines: [line(product)], address: address() }), 'Just above the cap').data, 'cod').available, false);
});

test('S-22: cash on delivery is hidden, with a reason, where it is off, outside its PINs or not offered by the courier', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 50000 });
  const b = buyer(world, shop);
  const off = mode(ok(await b.quote({ lines: [line(product)], address: address() }), 'COD off').data, 'cod');
  assert.ok(!off || off.available === false);
  await shop.codOn({ codPincodes: ['411001'] });
  const outside = mode(ok(await b.quote({ lines: [line(product)], address: address({ pincode: '560001', stateCode: '29' }) }), 'Outside the COD PINs').data, 'cod');
  assert.equal(outside.available, false);
  assert.ok(outside.reason);
  await shop.codOn({ codPincodes: [] });
  await world.ship.post('/serviceability', { pincode: '560002', serviceable: true, cod: false });
  const noCourier = mode(ok(await b.quote({ lines: [line(product)], address: address({ pincode: '560002', stateCode: '29' }) }), 'A PIN with no courier COD').data, 'cod');
  assert.equal(noCourier.available, false);
  assert.ok(noCourier.reason);
  refused(await b.place(b.checkoutBody({ lines: [line(product)], paymentMode: 'cod', address: address({ pincode: '560002', stateCode: '29' }) })), 'COD where the courier has none');
});

test('S-33: a PIN no courier serves blocks the order with a message, before any payment', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 50000 });
  await world.ship.post('/serviceability', { pincode: '799001', serviceable: false });
  const b = buyer(world, shop);
  const where = ok(await b.api('GET', '/api/store/serviceability?pincode=799001'), 'Serviceability of an unserved PIN').data;
  assert.equal(where.serviceable, false);
  assert.ok(where.message.length > 0);
  const quote = ok(await b.quote({ lines: [line(product)], address: address({ pincode: '799001', stateCode: '16' }) }), 'Quoting to an unserved PIN').data;
  assert.equal(quote.serviceable, false);
  const res = refused(await b.place(b.checkoutBody({ lines: [line(product)], address: address({ pincode: '799001', stateCode: '16' }) })), 'Ordering to an unserved PIN');
  assert.ok((res.data?.error ?? '').length > 0, 'No message for the shopper');
  assert.equal((await shop.orders()).length, 0);
  assert.equal((await world.rzp.calls({ method: 'POST', path: '/v1/orders' })).length, 0, 'A gateway order was made for an unserved PIN');
});

test('S-33: a courier that hangs or answers junk never breaks checkout or lets a bad PIN through unseen', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 50000 });
  const b = buyer(world, shop);
  for (const fault of [{ kind: 'timeout' }, { kind: 'malformed', mode: 'garbage' }, { kind: 'malformed', mode: 'html' }, { kind: 'server_error', status: 503 }, { kind: 'malformed', mode: 'wrong_shape' }]) {
    await world.ship.fault({ ...fault, times: 'forever', match: { path: '/v1/external/courier/serviceability' } });
    const pin = String(560100 + Math.floor(Math.random() * 800));
    const startedAt = Date.now();
    const quote = noCrash(await b.quote({ lines: [line(product)], address: address({ pincode: pin, stateCode: '29' }) }), `A quote while the courier ${fault.kind}`);
    assert.ok(Date.now() - startedAt < 10_000, `The quote waited ${Date.now() - startedAt} ms on the courier`);
    assert.ok(quote.data && quote.status !== 404, `The quote is not an answer of the checkout: ${quote.status}`);
    if (quote.status === 200) assert.equal(typeof quote.data.serviceable, 'boolean');
    else assert.ok(quote.data.error, 'A refused quote says nothing to the shopper');
    noCrash(await b.api('GET', `/api/store/serviceability?pincode=${pin}`), `Serviceability while the courier ${fault.kind}`);
    await world.ship.delete('/faults');
  }
});

// ---- part-advance ----

test('S-21: a Rs 100 advance on Rs 999 charges Rs 100 online, and the label collects the balance', async () => {
  const shop = await addP4Shop(world);
  await shop.payOptions({ partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
  const product = await shop.item({ pricePaise: 99900, weightGrams: 400 });
  const b = buyer(world, shop);
  const quote = ok(await b.quote({ lines: [line(product)], paymentMode: 'part_advance', address: address() }), 'Quoting part-advance').data;
  assert.equal(quote.advancePaise, 10000);
  assert.equal(quote.balancePaise, quote.totalPaise - 10000);
  const placed = await b.order({ lines: [line(product)], paymentMode: 'part_advance' });
  assert.equal(placed.gateway.amountPaise, 10000, 'The gateway is asked for more than the advance');
  const [gw] = (await world.rzp.get('/state')).orders.filter((o) => o.id === placed.gateway.gatewayOrderId);
  assert.equal(gw.amount, 10000);
  let order = await shop.order(placed.orderNumber);
  assert.equal(order.payment_mode, 'part_advance');
  assert.equal(Number(order.advance_paise), 10000);
  assert.equal(Number(order.balance_paise), Number(order.total_paise) - 10000);
  assert.equal(order.fulfilment_status, 'pending', 'A part-advance order is confirmed before the advance is paid');
  await b.pay(placed);
  order = await shop.orderWhen(placed.orderNumber, (o) => o.payment_status === 'advance_paid');
  assert.equal(order.payment_status, 'advance_paid');
  assert.equal(order.fulfilment_status, 'new');
  assert.equal(Number(order.paid_paise), 10000);
  const shipment = await shop.ship(order);
  assert.equal(shipment.codPaise, Number(order.balance_paise), 'The label’s COD amount is not the balance');
  const label = (await world.ship.get('/state')).shipments.find((s) => s.awb_code === shipment.awb);
  assert.equal(String(label.payment_method).toUpperCase(), 'COD');
  assert.equal(Math.round(Number(label.cod_amount) * 100), Number(order.balance_paise), 'The courier collects something other than the balance');
});

test('S-21: a percentage advance rounds to whole paise, and an advance that covers the order is not part-advance', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 99900 });
  const b = buyer(world, shop);
  await shop.payOptions({ partAdvance: true, advanceKind: 'percent', advanceValue: 3333 });
  const q = ok(await b.quote({ lines: [line(product)], paymentMode: 'part_advance', address: address() }), 'A 33.33% advance').data;
  assert.ok(Number.isInteger(q.advancePaise) && Number.isInteger(q.balancePaise));
  assert.equal(q.advancePaise + q.balancePaise, q.totalPaise);
  assert.ok(Math.abs(q.advancePaise - (q.totalPaise * 3333) / 10000) <= 1, `A 33.33% advance of ${q.totalPaise} is ${q.advancePaise}`);
  await shop.payOptions({ partAdvance: true, advanceKind: 'fixed', advanceValue: 200000 });
  const whole = ok(await b.quote({ lines: [line(product)], paymentMode: 'part_advance', address: address() }), 'An advance bigger than the order').data;
  const pa = mode(whole, 'part_advance');
  assert.ok(pa && pa.available === false && pa.reason, 'Part-advance is offered when the advance covers the whole order');
  refused(await b.place(b.checkoutBody({ lines: [line(product)], paymentMode: 'part_advance' })), 'Part-advance with nothing left to collect');
  await shop.payOptions({ partAdvance: false });
  refused(await b.place(b.checkoutBody({ lines: [line(product)], paymentMode: 'part_advance' })), 'Part-advance when the owner turned it off');
  assert.equal((await shop.orders()).length, 0);
});

test('S-68: a failed advance leaves the order pending, makes no label, and the hold cancels it', async () => {
  const shop = await addP4Shop(world);
  await shop.payOptions({ partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
  const product = await shop.item({ pricePaise: 99900, stock: 2 });
  const b = buyer(world, shop);
  const placed = await b.order({ lines: [line(product)], paymentMode: 'part_advance' });
  const failed = await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, outcome: 'failed', webhook: true });
  noCrash(await b.paymentReturn(placed, failed), 'Coming back from a failed payment');
  await world.quiet(1200);
  let order = await shop.order(placed.orderNumber);
  assert.equal(order.fulfilment_status, 'pending');
  assert.equal(order.payment_status, 'unpaid');
  refused(await shop.send('POST', `/orders/${order.id}/shipments`, {}), 'A label for an order whose advance failed');
  assert.equal((await shop.shipments(order.id)).length, 0);
  assert.equal((await world.ship.calls({ method: 'POST', path: '/v1/external/orders/create/adhoc' })).length, 0);
  await world.age((STORE_LIMITS.holdMinutes + 1) * MINUTE);
  order = await shop.orderWhen(placed.orderNumber, (o) => o.fulfilment_status === 'cancelled');
  assert.equal(order.fulfilment_status, 'cancelled');
  assert.equal(order.cancel_reason, 'hold_expired');
  assert.equal((await shop.stockOf(product.id)).reserved, 0);
});

test('S-69: a shopper cancelling a part-advance order before shipment gets the advance back and owes nothing', async () => {
  const shop = await addP4Shop(world);
  await shop.payOptions({ partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
  const product = await shop.item({ pricePaise: 99900, stock: 3 });
  const b = buyer(world, shop);
  await b.signIn();
  const order = await b.buy({ lines: [line(product)], paymentMode: 'part_advance' });
  assert.equal(order.payment_status, 'advance_paid');
  ok(await b.cancelOrder(order.order_number), 'The shopper cancelling');
  const done = await shop.orderWhen(order.order_number, (o) => o.payment_status === 'refunded');
  assert.equal(done.fulfilment_status, 'cancelled');
  assert.equal(done.cancel_reason, 'shopper');
  assert.equal(done.payment_status, 'refunded', 'The advance was not refunded');
  const refunds = await shop.refunds(order.id);
  assert.equal(sum(refunds.filter((r) => r.status !== 'failed'), (r) => r.amount_paise), 10000, 'Refunded something other than the advance');
  const gw = (await world.rzp.get('/state')).refunds.filter((r) => r.payment_id === order.paid.payment.id);
  assert.equal(sum(gw, (r) => r.amount), 10000);
  assert.equal((await shop.stockOf(product.id)).stock, 3, 'Stock was not given back');
  assert.ok(!['cod_due'].includes(done.payment_status));
  refused(await shop.send('POST', `/orders/${order.id}/shipments`, {}), 'Shipping a cancelled order');
});

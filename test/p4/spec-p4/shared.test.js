// PRD 9.22 (shared shopper sign-in across stores) with 9.18's shared-profile notice. S-97 to S-104.
// Two businesses can never see each other's orders or customers; the shared profile holds only a verified identity,
// addresses and an anonymous COD risk label, and the consent screen is the one buyer page that names the platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, address, addP4Shop, assertBuyerPageClean, assertSellerBrandOnly, buyer, digits, hit, need, newPhone, noPlatformName, ok, onLocalDomain, refused, textOf, unique, useP4World } from './kit.js';

const world = useP4World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });
const sharedRows = async (table) => world.sql(`SELECT * FROM ${table}`);
const ORDER_KEYS = new Set(['id', 'orderNumber', 'status', 'customerName', 'phone', 'email', 'address', 'city', 'state', 'pincode', 'subtotalPaise', 'shippingPaise', 'totalPaise', 'reelId', 'source', 'notes', 'createdAt', 'updatedAt', 'flow', 'fulfilmentStatus', 'paymentStatus', 'paymentMode', 'holdReason', 'cancelReason', 'discountPaise', 'loyaltyPaise', 'codFeePaise', 'taxPaise', 'advancePaise', 'balancePaise', 'paidPaise', 'refundedPaise', 'couponCode', 'codRisk', 'gatewayMode', 'nextFulfilment', 'canCancel', 'refundDuePaise', 'confirmedAt', 'shippedAt', 'deliveredAt', 'cancelledAt', 'items', 'itemCount']);

/** Two stores on .localhost domains (so Google can send the shopper back), and one Google account that signs in at A and shares. */
async function sharedAtA({ name = 'Asha Rao' } = {}) {
  const a = await onLocalDomain(world, await addP4Shop(world, { name: 'Leafy Corner' }));
  const b = await onLocalDomain(world, await addP4Shop(world, { name: 'Brass Bazaar' }));
  const sub = `g-shared-${unique()}`;
  const atA = buyer(world, a);
  await atA.googleSignIn({ sub, name, email: `${sub}@mail.example` });
  assert.ok(atA.signedIn, 'Google sign-in at A failed');
  ok(await atA.addAddress({ name, line1: '12 Lake Road', city: 'Pune', pincode: '411001', isDefault: true }), 'An address at A');
  const shared = await atA.shareProfile();
  need(shared, [200, 201, 204], 'Giving shared-profile consent');
  return { a, b, sub, atA, name };
}

test('S-97: the shared-profile consent screen names the platform as data fiduciary, with its grievance contact and a way to withdraw', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const b = buyer(world, shop);
  await b.signIn();
  const res = need(await b.open('/account/shared-profile'), 200, 'The shared-profile consent screen');
  const text = textOf(res.text);
  assert.match(text, /bhava/i, 'The screen does not name the platform');
  assert.match(text, /data fiduciary/i, 'The screen does not say who the data fiduciary is');
  assert.match(text, /grievance/i, 'No grievance contact');
  assert.match(text, /[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s-]{7,}/, 'The grievance contact has no email or phone');
  assert.match(text, /withdraw|remove|revoke|stop sharing/i, 'No way to withdraw');
  assert.match(text, /phone|google/i);
  assert.match(text, /address/i, 'The screen does not list the data held');
  const boxes = [...res.text.matchAll(/<input\b[^>]*type=["']checkbox["'][^>]*>/gi)].map((m) => m[0]);
  assert.ok(boxes.length >= 1, 'No box to tick');
  assert.ok(boxes.every((box) => !/\bchecked\b/i.test(box)), 'The shared-profile box is ticked by default');
  assert.ok(!text.includes('Brass Bazaar'), 'The screen names another store');
  const out = await buyer(world, shop).open('/account/shared-profile');
  assert.ok(out.status < 500, `The screen logged out answered ${out.status}`);
});

test('S-98: a shopper verified at A who shared their profile checks out by UPI at B with no new sign-up and no code', async () => {
  const { a, b, sub } = await sharedAtA();
  const before = (await world.wa.get('/sent')).sent.length;
  const atB = buyer(world, b);
  await atB.googleSignIn({ sub, email: `${sub}@mail.example` });
  assert.ok(atB.signedIn, 'The verified shopper could not sign in at B');
  const offered = ok(await atB.addresses(), 'B offering saved addresses').data;
  const list = offered.items ?? offered;
  assert.ok(JSON.stringify(list).includes('12 Lake Road'), 'B does not offer the address saved at A');
  const page = need(await atB.open('/checkout'), 200, 'B’s checkout');
  assert.ok(textOf(page.text).includes('12 Lake Road'), 'B’s checkout does not show the saved address');
  assertSellerBrandOnly(page, 'B’s checkout');
  const product = await b.item({ pricePaise: 49900 });
  const row = await atB.buy({ lines: [line(product)], address: address({ line1: '12 Lake Road', city: 'Pune', pincode: '411001' }) });
  assert.equal(row.payment_status, 'paid');
  assert.equal((await world.wa.get('/sent')).sent.length, before, 'A code was sent to a shopper already verified');
  const [{ n }] = await b.sql('SELECT count(*)::int AS n FROM shopper_otps WHERE tenant_id = $1', [b.tenantId]);
  assert.equal(n, 0);
  assert.equal((await a.orders()).length, 0, 'B’s order landed at A');
});

test('S-98: without shared consent, or with only a phone typed in, B learns nothing from A', async () => {
  const a = await addP4Shop(world);
  const b = await addP4Shop(world);
  const phone = newPhone();
  const atA = buyer(world, a);
  await atA.signIn(phone);
  ok(await atA.addAddress({ line1: '9 Secret Street' }), 'An address at A, not shared');
  const stranger = buyer(world, b);
  const q = ok(await stranger.quote({ lines: [line(await b.item())], address: address({ phone }) }), 'A guest quote at B with that phone');
  assert.ok(!q.text.includes('Secret Street'));
  const page = await stranger.open(`/checkout?phone=${digits(phone)}`);
  assert.ok(!page.text.includes('Secret Street'), 'Typing a phone at B shows an address saved at A');
  const atB = buyer(world, b);
  await atB.signIn(phone);
  const res = ok(await atB.addresses(), 'B’s addresses for the same phone').data;
  assert.ok(!JSON.stringify(res).includes('Secret Street'), 'An address crossed stores without shared consent');
  assert.equal((await sharedRows('shared_profiles')).filter((p) => p.phone_hash && JSON.stringify(p).includes(digits(phone))).length, 0, 'The shared profile holds a phone in the clear');
});

test('S-99: B’s owner finds nothing of A’s orders in any screen, download, report or API call', async () => {
  const a = await addP4Shop(world, { name: 'Leafy Corner' });
  const b = await addP4Shop(world, { name: 'Brass Bazaar' });
  await a.invoiceReady();
  await a.returnsOn();
  const phone = newPhone();
  const atA = buyer(world, a);
  await atA.signIn(phone);
  const product = await a.item({ name: 'Monstera only at A', pricePaise: 100000, stock: 5 });
  const row = await atA.delivered({ lines: [line(product)], email: 'only-at-a@mail.example' });
  need(await a.refund(row.id, { amountPaise: 10000 }), 201, 'A refund at A');
  const [shipment] = await a.shipments(row.id);
  await world.until(async () => (await a.invoices(row.id)).length, 9000);
  const [invoice] = await a.invoices(row.id);
  const [refund] = await a.refunds(row.id);
  const me = await atA.me();
  const atB = buyer(world, b);
  await atB.signIn(phone);
  await atB.buy({ lines: [line(await b.item({ pricePaise: 20000 }))] });
  const id = row.id;
  const probes = [
    ['GET', `/orders/${id}`], ['GET', `/orders/${id}/timeline`], ['GET', `/orders/${id}/payments`], ['GET', `/orders/${id}/refunds`], ['GET', `/orders/${id}/shipments`],
    ['POST', `/orders/${id}/advance`, { to: 'packed' }], ['POST', `/orders/${id}/cancel`, {}], ['POST', `/orders/${id}/notes`, { note: 'mine now' }], ['POST', `/orders/${id}/release-hold`, {}], ['POST', `/orders/${id}/reinstate`],
    ['POST', `/orders/${id}/status`, { status: 'cancelled' }], ['POST', `/orders/${id}/shipments`, {}],
    ...(refund ? [['GET', `/refunds/${refund.id}`], ['POST', `/refunds/${refund.id}/retry`]] : []),
    ...(shipment ? [['GET', `/shipments/${shipment.id}`], ['GET', `/shipments/${shipment.id}/label`], ['POST', `/shipments/${shipment.id}/cancel`]] : []),
    ...(invoice ? [['GET', `/invoices/${invoice.id}`]] : []),
    ['GET', `/shoppers/${me.id}`], ['GET', `/loyalty/members/${me.id}/ledger`],
  ];
  for (const [method, path, body] of probes) {
    const res = await b.send(method, path, body);
    assert.ok([403, 404].includes(res.status), `${method} ${path} for A’s order answered ${res.status} at B`);
    if (method === 'GET') assert.equal(res.status, 404, `${method} ${path} did not answer 404`);
    assert.ok(!res.text.includes('Monstera only at A') && !res.text.includes(row.order_number), `${method} ${path} leaked A’s order`);
  }
  const lists = ['/orders?limit=100', `/orders?search=${encodeURIComponent(row.order_number)}`, `/orders?search=${digits(phone).slice(-10)}`, '/shoppers?limit=100', `/shoppers?search=${digits(phone).slice(-10)}`, `/invoices?orderId=${id}`, `/settlements?orderId=${id}`, '/settlements/summary', '/returns', '/reviews', '/order-alerts', `/order-alerts?orderId=${id}`, '/wishlist/counts', '/customers', '/inventory/movements', '/coupons'];
  for (const path of lists) {
    const res = await b.send('GET', path);
    assert.ok(res.status < 500, `${path} answered ${res.status}`);
    for (const leak of [row.order_number, 'Monstera only at A', 'only-at-a@mail.example', 'Leafy Corner']) assert.ok(!res.text.includes(leak), `${path} at B shows ${leak}`);
  }
  const download = await b.send('POST', '/order-downloads', {});
  if (download.status === 201) {
    const job = await world.until(async () => {
      const r = await b.send('GET', `/order-downloads/${download.json().id}`);
      return r.status === 200 && r.json().status === 'ready' ? r.json() : null;
    }, 15_000);
    if (job?.fileUrl) {
      const file = await hit(world, new URL(job.fileUrl, `https://${b.host}`).pathname + new URL(job.fileUrl, `https://${b.host}`).search, { host: b.host, token: b.token });
      assert.ok(!file.text.includes(row.order_number) && !file.text.includes('Monstera only at A'), 'B’s order download holds A’s order');
    }
  }
  const reports = await b.send('GET', '/reports/sales');
  if (reports.status === 200) assert.ok(!reports.text.includes(row.order_number));
  const buyerSide = await atB.open(`/account/orders/${encodeURIComponent(row.order_number)}`);
  assert.equal(buyerSide.status, 404, 'A’s order opens in B’s shopper account');
  assert.equal((await atB.open(`/order/${row.placed.token}`)).status, 404, 'A’s order page opens on B’s domain');
  assert.equal((await atB.open(`/order/${row.placed.token}/invoice/${encodeURIComponent(invoice?.number ?? 'x')}`)).status, 404);
});

test('S-100: B’s customer list after the shopper’s first order at B shows B’s order only', async () => {
  const a = await addP4Shop(world);
  const b = await addP4Shop(world);
  const phone = newPhone();
  const atA = buyer(world, a);
  await atA.signIn(phone);
  await atA.buy({ lines: [line(await a.item({ pricePaise: 300000 }))] });
  await atA.buy({ lines: [line(await a.item({ pricePaise: 400000 }))] });
  const before = need(await b.send('GET', `/shoppers?search=${digits(phone).slice(-10)}`), 200, 'B’s customers before').json().items;
  assert.equal(before.length, 0, 'B lists a shopper who never ordered there');
  const atB = buyer(world, b);
  await atB.signIn(phone);
  const rowB = await atB.buy({ lines: [line(await b.item({ pricePaise: 25000 }))] });
  const list = need(await b.send('GET', `/shoppers?search=${digits(phone).slice(-10)}`), 200, 'B’s customers after').json().items;
  assert.equal(list.length, 1);
  assert.equal(list[0].orders, 1, `B shows ${list[0].orders} orders for this shopper`);
  assert.equal(list[0].spentPaise, Number(rowB.total_paise), 'B shows spend from another store');
  const one = need(await b.send('GET', `/shoppers/${list[0].id}`), 200, 'The shopper at B').json();
  assert.equal(one.orders, 1);
  const legacy = await b.send('GET', '/customers?limit=100');
  if (legacy.status === 200) for (const c of legacy.json().items) assert.ok(c.spentPaise <= Number(rowB.total_paise) || c.role !== 'customer');
  const aList = need(await a.send('GET', `/shoppers?search=${digits(phone).slice(-10)}`), 200, 'A’s customers').json().items;
  assert.equal(aList[0].orders, 2);
});

test('S-101: the platform’s name appears only on the shared consent screen, across every buyer page and message', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  await shop.returnsOn();
  await shop.invoiceReady();
  const product = await shop.item({ name: 'Monstera', pricePaise: 49900, stock: 5 });
  const b = buyer(world, shop);
  const phone = await b.signIn();
  const email = `asha${unique()}@mail.example`;
  const row = await b.buy({ lines: [line(product)], email, address: address({ phone }) });
  const shipment = await shop.ship(row);
  await shop.track(shipment.awb, 'PICKED UP');
  await shop.orderWhen(row.order_number, (o) => o.fulfilment_status === 'shipped');
  const track = new URL(shipment.trackingUrl).pathname;
  const pages = ['/', '/shop', `/p/${product.slug}`, '/search?q=monstera', '/reels', '/about', '/cart', '/checkout', '/login', '/account', '/account/orders', `/account/orders/${encodeURIComponent(row.order_number)}`, `/order/${row.placed.token}`, track, '/wishlist', '/offline', '/policies/privacy', '/policies/terms', '/policies/refund', '/policies/shipping'];
  for (const path of pages) {
    const res = await b.open(path);
    assert.equal(res.status, 200, `${path} answered ${res.status}`);
    assertSellerBrandOnly(res, path);
    await assertBuyerPageClean(world, shop, path, { headers: { cookie: b.cookie } });
  }
  for (const path of ['/manifest.webmanifest', '/sw.js', '/no-such-page']) assertSellerBrandOnly(await b.open(path), path);
  for (const call of [await b.getCart(), await b.consent(), await b.addresses(), await b.quote({ lines: [line(product)] })]) assertSellerBrandOnly(call, 'A buyer JSON call');
  await world.quiet(2000);
  for (const m of await world.whatsappTo(phone)) noPlatformName('A WhatsApp message to the shopper', m.body);
  for (const m of await world.emailsTo(email)) noPlatformName('An email to the shopper', { from: m.from, subject: m.subject, html: m.html, text: m.text, headers: m.headers, replyTo: m.replyTo });
  const consent = need(await b.open('/account/shared-profile'), 200, 'The shared consent screen');
  assert.match(textOf(consent.text), /bhava/i, 'The one page allowed to name the platform does not');
});

test('S-102: withdrawing shared consent removes the shared profile; B asks for sign-in again; each keeps its own orders', async () => {
  const { a, b, sub, atA } = await sharedAtA();
  const productA = await a.item({ pricePaise: 30000 });
  const productB = await b.item({ pricePaise: 20000 });
  const rowA = await atA.buy({ lines: [line(productA)] });
  const atB = buyer(world, b);
  await atB.googleSignIn({ sub });
  const rowB = await atB.buy({ lines: [line(productB)], address: address() });
  const profiles = await sharedRows('shared_profiles');
  assert.ok(profiles.length >= 1, 'No shared profile was made');
  ok(await atB.revokeShared(), 'Withdrawing from B’s account page');
  await world.quiet(1500);
  const left = (await sharedRows('shared_profiles')).filter((p) => profiles.some((q) => q.id === p.id));
  assert.equal(left.length, 0, 'The shared profile is still there');
  assert.equal((await world.sql('SELECT * FROM shared_profile_links WHERE profile_id = ANY($1)', [profiles.map((p) => p.id)])).length, 0);
  assert.equal((await world.sql('SELECT * FROM shared_addresses WHERE profile_id = ANY($1)', [profiles.map((p) => p.id)])).length, 0);
  assert.ok((await world.sql('SELECT * FROM shared_consent_log WHERE NOT granted')).length >= 1, 'Taking consent back was not logged');
  const again = await atB.addresses();
  assert.ok(again.status === 401 || !again.text.includes('12 Lake Road'), 'B still offers the shared address');
  const fresh = buyer(world, b);
  const page = await fresh.open('/checkout');
  assert.ok(!page.text.includes('12 Lake Road'));
  assert.ok(await a.order(rowA.order_number), 'A lost its own order');
  assert.ok(await b.order(rowB.order_number), 'B lost its own order');
  assert.equal((await a.order(rowA.order_number)).payment_status, 'paid');
});

test('S-103: three COD refusals at A show at B as "high refusal risk" only: no stores, products or counts', async () => {
  const { a, b, sub } = await sharedAtA();
  await a.codOn();
  await b.codOn();
  const phone = newPhone();
  const product = await a.item({ name: 'Monstera only at A', pricePaise: 49900, stock: 10 });
  const atA = buyer(world, a);
  await atA.googleSignIn({ sub });
  for (let i = 0; i < 3; i++) {
    const placed = await atA.orderCod({ lines: [line(product)], address: address({ phone }) });
    const order = await a.order(placed.orderNumber);
    const s = await a.ship(order);
    await a.track(s.awb, 'PICKED UP');
    await a.track(s.awb, 'RTO INITIATED');
    await a.track(s.awb, 'RTO DELIVERED');
    await a.orderWhen(order.order_number, (o) => o.fulfilment_status === 'rto_delivered');
  }
  const signals = await sharedRows('shared_cod_signals');
  assert.ok(signals.some((s) => s.refused >= 3), 'The refusals were not counted for the shared profile');
  assert.ok(signals.every((s) => !('tenant_id' in s)));
  const atB = buyer(world, b);
  await atB.googleSignIn({ sub });
  const placed = await atB.orderCod({ lines: [line(await b.item({ pricePaise: 29900 }))], address: address({ phone }) });
  const order = await b.order(placed.orderNumber);
  assert.equal(order.cod_risk, 'high', 'B does not see the risk label');
  const detail = need(await b.send('GET', `/orders/${order.id}`), 200, 'B’s order').json();
  assert.equal(detail.codRisk, 'high');
  for (const key of Object.keys(detail)) assert.ok(ORDER_KEYS.has(key), `B’s order carries an extra field: ${key}`);
  const text = JSON.stringify(detail) + JSON.stringify(await b.send('GET', `/orders/${order.id}/timeline`).then((r) => r.json()));
  for (const leak of ['Leafy Corner', 'Monstera only at A', a.slug ?? 'leafy', 'rto', 'refused']) assert.ok(!text.toLowerCase().includes(String(leak).toLowerCase()), `B’s order shows ${leak}`);
  const listed = need(await b.send('GET', '/orders?limit=50'), 200, 'B’s order list').json();
  assert.ok(!JSON.stringify(listed).includes('Leafy Corner'));
  const page = await atB.open(`/order/${placed.token}`);
  assert.doesNotMatch(textOf(page.text), /risk/i, 'The shopper is shown their own risk label');
});

test('S-104: a marketing yes at A does not carry to B', async () => {
  const a = await addP4Shop(world);
  const b = await addP4Shop(world);
  await b.remindersOn();
  const phone = newPhone();
  const atA = buyer(world, a);
  await atA.signIn(phone);
  ok(await atA.saveConsent({ orderUpdates: { whatsapp: true, email: true }, marketing: { whatsapp: true, email: true } }), 'Marketing yes at A');
  const shared = await atA.shareProfile();
  assert.ok(shared.status < 500);
  const atB = buyer(world, b);
  await atB.signIn(phone);
  const state = ok(await atB.consent(), 'Consent at B').data;
  assert.doesNotMatch(JSON.stringify(state.marketing ?? state), /true/, 'B shows A’s marketing yes');
  ok(await atB.putCart([line(await b.item({ pricePaise: 12000 }))]), 'A cart left at B');
  await world.age(2 * DAY);
  await world.quiet(2500);
  const reminder = await b.one(`SELECT name FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = 'cart_reminder'`, [b.tenantId]);
  assert.equal((await world.whatsappTo(phone)).filter((m) => m.phoneId === b.waPhoneId && m.body?.template?.name === reminder?.name).length, 0, 'B sent marketing on A’s consent');
  await atB.buy({ lines: [line(await b.item({ pricePaise: 10000 }))] });
  const list = need(await b.send('GET', `/shoppers?search=${digits(phone).slice(-10)}`), 200, 'B’s customers').json().items;
  assert.deepEqual(list[0].marketing, { whatsapp: false, email: false });
  assert.equal((await b.consent(`purpose = 'marketing' AND granted`)).length, 0, 'A marketing yes was written at B');
});

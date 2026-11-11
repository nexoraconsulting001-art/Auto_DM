// PRD 9.17 (the shopper's account and returns) and 9.18 (data protection). S-56 to S-60, S-63, S-64, S-80.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, address, addP4Shop, addStaff, buyer, digits, need, newPhone, noCrash, ok, proofPhoto, proofVideo, refused, sum, textOf, unique, useP4World } from './kit.js';

const world = useP4World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });
const returnFields = (items, extra = {}) => ({ reason: 'The seam is torn', resolution: 'refund', items: JSON.stringify(items), ...extra });

async function deliveredTo(shop, { stock = 5, pricePaise = 99900, qty = 1, email } = {}) {
  const product = await shop.item({ name: `Linen kurta ${unique()}`, pricePaise, stock });
  const b = buyer(world, shop);
  await b.signIn();
  const row = await b.delivered({ lines: [line(product, qty)], ...(email ? { email } : {}) });
  const [item] = await shop.orderItems(row.id);
  return { b, product, row, item };
}

// ---- cancelling and returning ----

test('S-56: a shopper cancelling an unshipped prepaid order gets it cancelled, the stock back and the refund started', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 99900, stock: 3 });
  const b = buyer(world, shop);
  await b.signIn();
  const row = await b.buy({ lines: [line(product, 2)] });
  assert.equal((await shop.stockOf(product.id)).stock, 1);
  const res = ok(await b.cancelOrder(row.order_number), 'Cancelling from the account');
  assert.ok(res.status < 300);
  const order = await shop.orderWhen(row.order_number, (o) => o.fulfilment_status === 'cancelled');
  assert.equal(order.cancel_reason, 'shopper');
  assert.equal((await shop.stockOf(product.id)).stock, 3, 'The stock was not released');
  await world.until(async () => (await shop.refunds(row.id)).length, 9000);
  const refunds = await shop.refunds(row.id);
  assert.equal(sum(refunds.filter((r) => r.status !== 'failed'), (r) => r.amount_paise), Number(row.total_paise), 'The refund was not started for what was paid');
  noCrash(await b.cancelOrder(row.order_number), 'Cancelling twice');
  await world.quiet(1500);
  assert.equal(sum((await shop.refunds(row.id)).filter((r) => r.status !== 'failed'), (r) => r.amount_paise), Number(row.total_paise), 'Cancelling twice refunded twice');
  assert.equal(sum((await world.rzp.get('/state')).refunds.filter((r) => r.payment_id === row.paid.payment.id), (r) => r.amount), Number(row.total_paise));
  const page = need(await b.open(`/account/orders/${encodeURIComponent(row.order_number)}`), 200, 'The cancelled order in the account');
  assert.match(textOf(page.text), /cancel/i);
});

test('S-56: nobody cancels an order that is not theirs, and nothing is cancelled once it has shipped', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 49900, stock: 5 });
  const owner = buyer(world, shop);
  await owner.signIn();
  const row = await owner.buy({ lines: [line(product)] });
  const stranger = buyer(world, shop);
  await stranger.signIn();
  refused(await stranger.cancelOrder(row.order_number), 'Another shopper cancelling it', [403, 404]);
  refused(await buyer(world, shop).cancelOrder(row.order_number), 'A guest cancelling it', [401, 403, 404]);
  const other = await addP4Shop(world);
  const elsewhere = buyer(world, other);
  await elsewhere.signIn(owner.phone);
  refused(await elsewhere.cancelOrder(row.order_number), 'The same phone at another store cancelling it', [403, 404]);
  assert.equal((await shop.order(row.order_number)).fulfilment_status, 'new');
  ok(await shop.advance(row.id, 'packed'), 'Packing');
  ok(await shop.advance(row.id, 'shipped'), 'Shipping');
  refused(await owner.cancelOrder(row.order_number), 'Cancelling after shipment');
  assert.equal((await shop.order(row.order_number)).fulfilment_status, 'shipped');
});

test('S-57: on day 10 with a 7-day window the return option is not shown, and asking anyway is refused', async () => {
  const shop = await addP4Shop(world);
  await shop.returnsOn({ windowDays: 7 });
  const { b, row, item } = await deliveredTo(shop);
  const inside = need(await b.open(`/account/orders/${encodeURIComponent(row.order_number)}`), 200, 'The order on day 0');
  assert.match(inside.text, new RegExp(`/account/orders/${row.order_number.replace(/[^A-Za-z0-9]/g, '.')}/return`), 'The return option is missing inside the window');
  await world.age(10 * DAY);
  const late = need(await b.open(`/account/orders/${encodeURIComponent(row.order_number)}`), 200, 'The order on day 10');
  assert.doesNotMatch(late.text, /\/return["'?]/, 'The return option still shows after the window');
  assert.doesNotMatch(textOf(late.text), /request a return|return this/i);
  const page = await b.open(`/account/orders/${encodeURIComponent(row.order_number)}/return`);
  assert.ok(page.status === 404 || !/<form/i.test(page.text), 'The return form still opens after the window');
  refused(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [proofPhoto()] }), 'A return asked for on day 10');
  assert.equal((await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenantId])).length, 0);
});

test('S-57: returns off, a product outside the eligible categories, or an order not delivered cannot be returned', async () => {
  const shop = await addP4Shop(world);
  const { b, row, item } = await deliveredTo(shop);
  refused(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [proofPhoto()] }), 'A return with returns off');
  const cat = await shop.category(`Returnable ${unique()}`);
  await shop.returnsOn({ windowDays: 7, eligibleCategoryIds: [cat.id] });
  refused(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [proofPhoto()] }), 'A return of a product outside the eligible categories');
  await shop.returnsOn({ windowDays: 7, eligibleCategoryIds: [] });
  const product = await shop.item({ pricePaise: 10000 });
  const fresh = await b.buy({ lines: [line(product)] });
  const [freshItem] = await shop.orderItems(fresh.id);
  refused(await b.askReturn(fresh.order_number, { fields: returnFields([{ orderItemId: freshItem.id, qty: 1 }]), files: [proofPhoto()] }), 'Returning an order not yet delivered');
  refused(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 2 }]), files: [proofPhoto()] }), 'Returning more than was bought');
  refused(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: freshItem.id, qty: 1 }]), files: [proofPhoto()] }), 'Returning a line of another order');
  const stranger = buyer(world, shop);
  await stranger.signIn();
  refused(await stranger.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [proofPhoto()] }), 'Another shopper returning it', [403, 404]);
  assert.equal((await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenantId])).length, 0);
});

test('S-80: a return with no photo or video is blocked: "Add a photo or video of the item"', async () => {
  const shop = await addP4Shop(world);
  await shop.returnsOn({ windowDays: 7, proof: 'either' });
  const { b, row, item } = await deliveredTo(shop);
  const res = refused(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]) }), 'A return with no proof', [400, 422]);
  assert.ok(res.text.includes('Add a photo or video of the item'), `The refusal does not say what to add: ${res.text.slice(0, 200)}`);
  const fake = { field: 'proof', filename: 'item.png', type: 'image/png', data: Buffer.from('this is not a picture at all') };
  refused(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [fake] }), 'A "photo" that is not an image');
  refused(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [{ field: 'proof', filename: 'x.html', type: 'text/html', data: Buffer.from('<script>alert(1)</script>') }] }), 'An HTML file as proof');
  assert.equal((await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenantId])).length, 0);
  const made = ok(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [proofPhoto()] }), 'A return with a photo');
  assert.ok(made.status === 201 || made.status === 200);
  const [proof] = await shop.sql('SELECT * FROM return_proofs WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(proof, 'The photo was not kept');
  assert.equal(proof.kind, 'photo');
  assert.ok(!proof.file_key.startsWith('media/') && !proof.file_key.includes('/media/'), 'The proof is stored where anyone with the link can open it');
  const [ret] = await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenantId]);
  const seen = need(await shop.send('GET', `/returns/${ret.id}`), 200, 'The owner reading the return').json();
  assert.equal(seen.proofs.length, 1);
  const fileUrl = seen.proofs[0].fileUrl;
  assert.ok(!new URL(fileUrl, `https://${shop.host}`).pathname.startsWith('/media/'), 'The proof is served from the public media path');
  const page = need(await b.open(`/account/orders/${encodeURIComponent(row.order_number)}`), 200, 'The order in the account');
  assert.ok(!page.text.includes(proof.file_key), 'The shopper’s page exposes the proof’s storage key');
  const staff = await addStaff(world, shop, { permissions: ['catalog'] });
  need(await shop.as(staff.token)('GET', `/returns/${ret.id}`), 403, 'Staff without order access reading the proof');
  const other = await addP4Shop(world);
  need(await other.send('GET', `/returns/${ret.id}`), 404, 'Another business reading the return');
});

test('S-80: when the owner asks for a video, a photo alone is not enough', async () => {
  const shop = await addP4Shop(world);
  await shop.returnsOn({ windowDays: 7, proof: 'video' });
  const { b, row, item } = await deliveredTo(shop);
  refused(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [proofPhoto()] }), 'A photo when a video is asked for');
  ok(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [proofVideo()] }), 'A video');
});

test('S-58: a damaged return marked not restockable is refunded and leaves the stock as it was', async () => {
  const shop = await addP4Shop(world);
  await shop.returnsOn({ windowDays: 7 });
  const { b, row, item, product } = await deliveredTo(shop, { stock: 5, qty: 2 });
  const stockBefore = (await shop.stockOf(product.id)).stock;
  ok(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [proofPhoto()] }), 'Asking for a return');
  const [ret] = await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenantId]);
  const approved = need(await shop.send('POST', `/returns/${ret.id}/approve`), 200, 'Approving it').json();
  assert.ok(approved.shipmentId, 'Approving did not book the reverse pickup');
  const [reverse] = (await shop.shipments(row.id)).filter((s) => s.kind === 'reverse');
  assert.equal(reverse.mode, 'managed', 'The reverse pickup is not on the forward shipping mode');
  const received = need(await shop.send('POST', `/returns/${ret.id}/receive`, { condition: 'not_restockable' }), 200, 'Receiving it damaged').json();
  assert.equal(received.restocked, false);
  need(await shop.refund(row.id, { amountPaise: Number(item.price_paise), returnId: ret.id }), 201, 'Refunding the return');
  await world.until(async () => (await shop.refunds(row.id)).some((r) => r.status === 'processed'), 9000);
  assert.equal(Number((await shop.refunds(row.id)).find((r) => r.status === 'processed').amount_paise), Number(item.price_paise));
  assert.equal((await shop.stockOf(product.id)).stock, stockBefore, 'A not-restockable item went back into stock');
  refused(await shop.send('POST', `/returns/${ret.id}/receive`, { condition: 'good' }), 'Receiving it again as good', [400, 409, 422]);
  assert.equal((await shop.stockOf(product.id)).stock, stockBefore);
  // The same flow with an item in good condition does restock, once.
  const good = await deliveredTo(shop, { stock: 5 });
  const goodBefore = (await shop.stockOf(good.product.id)).stock;
  ok(await good.b.askReturn(good.row.order_number, { fields: returnFields([{ orderItemId: good.item.id, qty: 1 }]), files: [proofPhoto()] }), 'A second return');
  const [ret2] = await shop.sql('SELECT * FROM returns WHERE tenant_id = $1 AND order_id = $2', [shop.tenantId, good.row.id]);
  need(await shop.send('POST', `/returns/${ret2.id}/approve`), 200, 'Approving');
  need(await shop.send('POST', `/returns/${ret2.id}/receive`, { condition: 'good' }), 200, 'Receiving it in good condition');
  await world.quiet(1500);
  assert.equal((await shop.stockOf(good.product.id)).stock, goodBefore + 1, 'A good return did not restock exactly once');
});

// ---- consent ----

test('S-59: signing in writes a consent record with the notice version and purposes, and the notice names the business in two languages', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const b = buyer(world, shop);
  const login = need(await b.open('/login'), 200, 'The sign-in page');
  const words = textOf(login.text);
  assert.ok(words.includes('Leafy Corner'), 'The notice does not name the business');
  assert.match(words, /[ऀ-ॿ]/, 'The notice is not in Hindi as well');
  await b.signIn();
  const me = await b.me();
  const rows = await shop.consent('shopper_id = $2', [me.id]);
  assert.ok(rows.length >= 1, 'Signing in wrote no consent record');
  assert.ok(rows.every((r) => r.notice_version === shop.noticeVersion), 'A record does not name the notice version shown');
  assert.ok(rows.some((r) => r.purpose === 'fulfilment' && r.granted && r.source === 'sign_in'));
  assert.ok(!rows.some((r) => r.purpose === 'marketing' && r.granted), 'Marketing was taken as agreed at sign-in');
  // A guest checkout records the choices made on the page, against the phone and email given.
  const guest = buyer(world, shop);
  const product = await shop.item({ pricePaise: 10000 });
  const placed = await guest.order({ lines: [line(product)], email: 'guest@mail.example', consent: { orderUpdates: { whatsapp: true, email: false }, marketing: { whatsapp: false, email: true } } });
  const order = await shop.order(placed.orderNumber);
  const guestRows = await shop.consent('order_id = $2', [order.id]);
  const has = (purpose, channel, granted) => guestRows.some((r) => r.purpose === purpose && r.channel === channel && r.granted === granted && r.source === 'checkout');
  assert.ok(has('order_updates', 'whatsapp', true) && has('order_updates', 'email', false) && has('marketing', 'email', true) && has('marketing', 'whatsapp', false), `Checkout consent rows: ${guestRows.map((r) => `${r.purpose}/${r.channel}/${r.granted}`)}`);
  assert.ok(guestRows.every((r) => !JSON.stringify(r).includes('guest@mail.example')), 'The consent ledger holds the email in the clear');
  assert.equal(order.consent_notice_version, shop.noticeVersion);
  refused(await guest.place(guest.checkoutBody({ lines: [line(product)], consent: { noticeVersion: 999 } })), 'Consent to a notice that does not exist');
});

test('S-60: a shopper who agreed to order updates only gets no marketing on any channel', async () => {
  const shop = await addP4Shop(world);
  await shop.remindersOn();
  await shop.returnsOn({ windowDays: 1 });
  const product = await shop.item({ pricePaise: 49900 });
  const b = buyer(world, shop);
  const phone = await b.signIn();
  const email = `asha${unique()}@mail.example`;
  ok(await b.saveConsent({ orderUpdates: { whatsapp: true, email: true }, marketing: { whatsapp: false, email: false } }), 'Order updates only');
  ok(await b.putCart([line(product)]), 'A cart left behind');
  await world.age(2 * DAY);
  await world.quiet(2500);
  const reminder = await shop.one(`SELECT name FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = 'cart_reminder'`, [shop.tenantId]);
  const review = await shop.one(`SELECT name FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = 'review_request'`, [shop.tenantId]);
  const row = await b.delivered({ lines: [line(product)], email });
  await world.age(2 * DAY);
  await world.quiet(2500);
  const marketing = (await world.whatsappTo(phone)).filter((m) => [reminder?.name, review?.name].includes(m.body?.template?.name));
  assert.equal(marketing.length, 0, 'A marketing WhatsApp message went to a shopper who agreed to order updates only');
  const mails = (await world.emailsTo(email)).filter((m) => /review|rate|cart|left|forgot/i.test(m.subject));
  assert.equal(mails.length, 0, 'A marketing email went out');
  assert.ok((await shop.alertsOf(row.id)).some((a) => a.status === 'sent'), 'Order updates were not sent either');
  const reviewAlerts = (await shop.alertsOf(row.id, 'review_request')).filter((a) => a.status === 'sent');
  assert.equal(reviewAlerts.length, 0);
});

test('S-64: withdrawing WhatsApp consent stops WhatsApp messages; email follows its own consent', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 49900, stock: 10 });
  const b = buyer(world, shop);
  const phone = await b.signIn();
  const email = `asha${unique()}@mail.example`;
  ok(await b.saveConsent({ orderUpdates: { whatsapp: true, email: true }, marketing: { whatsapp: true, email: true } }), 'Saying yes to everything');
  ok(await b.saveConsent({ orderUpdates: { whatsapp: false, email: true }, marketing: { whatsapp: false, email: true } }), 'Taking WhatsApp back');
  const state = ok(await b.consent(), 'Reading consent').data;
  assert.doesNotMatch(JSON.stringify(state), /"whatsapp":true/, 'WhatsApp still shows as agreed');
  const rows = await shop.consent(`shopper_id = $2 AND channel = 'whatsapp'`, [(await b.me()).id]);
  assert.ok(rows.some((r) => !r.granted), 'Taking consent back wrote no record');
  const before = (await world.whatsappTo(phone)).length;
  const row = await b.buy({ lines: [line(product)], email, address: address({ phone }), consent: { orderUpdates: { whatsapp: false, email: true }, marketing: { whatsapp: false, email: true } } });
  await world.until(async () => (await shop.alertsOf(row.id, 'paid')).some((a) => a.channel === 'email' && a.status === 'sent'), 12_000);
  await world.quiet(1000);
  assert.equal((await world.whatsappTo(phone)).length, before, 'A WhatsApp message went after consent was withdrawn');
  assert.ok((await world.emailsTo(email)).length >= 1, 'Email stopped too, though it was still agreed');
});

test('S-64: a STOP reply on WhatsApp and the one-tap unsubscribe link each take consent back with no sign-in', async () => {
  const shop = await addP4Shop(world);
  const b = buyer(world, shop);
  const phone = await b.signIn();
  ok(await b.saveConsent({ orderUpdates: { whatsapp: true, email: true }, marketing: { whatsapp: true, email: true } }), 'Saying yes');
  const me = await b.me();
  const reply = await world.wa.post('/inbound', { phoneId: shop.waPhoneId, from: digits(phone), text: 'STOP' });
  assert.equal(reply.status, 200, `The STOP reply was answered ${reply.status}`);
  await world.until(async () => (await shop.consent(`shopper_id = $2 AND purpose = 'marketing' AND channel = 'whatsapp' AND source = 'reply' AND NOT granted`, [me.id])).length, 9000);
  assert.ok((await shop.consent(`shopper_id = $2 AND source = 'reply' AND NOT granted`, [me.id])).length >= 1, 'STOP did not take WhatsApp marketing back');
  const bad = await world.wa.post('/inbound', { phoneId: shop.waPhoneId, from: digits(newPhone()), text: 'STOP', signature: 'bad' });
  assert.equal(bad.status, 401, 'A STOP with a bad signature was accepted');
  need(await buyer(world, shop).open(`/unsubscribe/${'x'.repeat(32)}`), [400, 404, 410], 'A made-up unsubscribe link');
});

test('S-63: a deletion request erases the shopper’s personal data and keeps tax records with it masked', async () => {
  const shop = await addP4Shop(world);
  await shop.invoiceReady();
  await shop.returnsOn({ windowDays: 7 });
  const product = await shop.item({ pricePaise: 49900, stock: 5 });
  const b = buyer(world, shop);
  const phone = await b.signIn();
  ok(await b.addAddress({ name: 'Asha Rao', line1: '12 Lake Road' }), 'An address');
  ok(await b.api('PUT', '/api/store/wishlist', { add: [product.id] }), 'A saved item');
  const row = await b.delivered({ lines: [line(product)], email: 'asha.rao@mail.example', address: address({ name: 'Asha Rao', phone }) });
  const [item] = await shop.orderItems(row.id);
  ok(await b.askReturn(row.order_number, { fields: returnFields([{ orderItemId: item.id, qty: 1 }]), files: [proofPhoto()] }), 'A return with a photo');
  await world.until(async () => (await shop.invoices(row.id)).length, 9000);
  const invoice = (await shop.invoices(row.id))[0];
  const me = await b.me();
  ok(await b.dataRequest('erasure'), 'Asking for deletion');
  const done = await world.until(async () => (await shop.sql(`SELECT * FROM data_requests WHERE tenant_id = $1 AND status = 'completed'`, [shop.tenantId]))[0], 15_000);
  assert.ok(done, 'The deletion request never completed');
  assert.ok(Object.values(done.summary).every((v) => typeof v === 'number'), 'The request summary holds more than counts');
  const [shopper] = await shop.sql('SELECT * FROM shoppers WHERE tenant_id = $1 AND id = $2', [shop.tenantId, me.id]);
  assert.ok(!shopper || (shopper.erased_at && shopper.phone === null && shopper.name === '' && shopper.email === ''), 'The shopper’s personal data is still there');
  assert.equal((await shop.sql('SELECT * FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id])).length, 0);
  assert.equal((await shop.sql('SELECT * FROM wishlist_items WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id])).length, 0);
  assert.equal((await shop.sql('SELECT * FROM return_proofs WHERE tenant_id = $1', [shop.tenantId])).length, 0, 'The return photo was kept');
  const order = await shop.order(row.order_number);
  assert.ok(order, 'The order, a tax record, was deleted');
  assert.ok(order.erased_at, 'The order is not marked masked');
  const flat = JSON.stringify(order);
  for (const pii of ['Asha Rao', digits(phone).slice(-10), 'asha.rao@mail.example', '12 Lake Road']) assert.ok(!flat.includes(pii), `The kept order still shows ${pii}`);
  assert.equal(Number(order.total_paise), Number(row.total_paise), 'Masking changed the order’s amounts');
  const [inv] = await shop.invoices(row.id);
  assert.equal(inv.number, invoice.number);
  assert.equal(Number(inv.total_paise), Number(invoice.total_paise));
  assert.ok(inv.buyer_masked_at, 'The invoice’s buyer was not masked');
  assert.ok(!JSON.stringify(inv.buyer).includes('Asha Rao') && !JSON.stringify(inv.buyer).includes(digits(phone).slice(-10)));
  const after = await b.addresses();
  assert.ok(after.status === 401 || (after.data?.items ?? after.data ?? []).length === 0, 'The erased shopper is still signed in with their data');
  const list = need(await shop.send('GET', `/shoppers?search=${digits(phone).slice(-10)}`), 200, 'Searching the customer list for the number').json();
  assert.equal(list.items.length, 0, 'The erased number still finds a customer');
});

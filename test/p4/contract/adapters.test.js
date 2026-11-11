// The store's adapters against their simulators: one interface per provider, a timeout on every call, a base URL that a
// simulator may stand behind anywhere but production, and webhooks that are signed, repeated and out of order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { ProviderError, ProviderHostBlockedError } from '../../../src/adapters/http.js';
import { createEmail } from '../../../src/adapters/email/index.js';
import { createRazorpay, verifyCheckout, verifyWebhook } from '../../../src/adapters/razorpay/index.js';
import { createShiprocket, mapStatus } from '../../../src/adapters/shiprocket/index.js';
import { createShopify, verifyWebhook as verifyShopify } from '../../../src/adapters/shopify/index.js';
import { createStoreAdapters } from '../../../src/adapters/store.js';
import { createWhatsApp, parseInbound, parseStatuses, verifyWebhook as verifyWhatsApp } from '../../../src/adapters/whatsapp/index.js';
import { SHIPMENT_STATUSES } from '../../../src/contracts/orders.js';
import { SIGNATURE_HEADERS } from '../../../src/contracts/store-routes.js';
import { createEmail as createEmailSim } from '../../../tools/sim/email/index.mjs';
import { createRazorpay as createRazorpaySim } from '../../../tools/sim/razorpay/index.mjs';
import { createShiprocket as createShiprocketSim } from '../../../tools/sim/shiprocket/index.mjs';
import { createShopify as createShopifySim } from '../../../tools/sim/shopify/index.mjs';
import { createWhatsApp as createWhatsAppSim } from '../../../tools/sim/whatsapp/index.mjs';

async function start(t, sim) {
  await sim.start();
  t.after(() => sim.close());
  return sim;
}

/** A stand-in for the app's webhook route: keeps the exact bytes and headers of what arrived. */
async function receiver(t, answer = () => 200) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      got.push({ raw, headers: req.headers, body: JSON.parse(raw.toString() || 'null') });
      res.statusCode = answer(got.length);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { got, url: `http://127.0.0.1:${server.address().port}/webhooks/in` };
}

const razorpayConfig = (sim, extra = {}) => ({ razorpayBaseUrl: sim.url, razorpayKeyId: sim.keyId, razorpayKeySecret: sim.keySecret, razorpayPartnerClientId: sim.partner.clientId, razorpayPartnerClientSecret: sim.partner.clientSecret, ...extra });

test('a simulator is refused in production, and a host that is not the provider’s is refused always', () => {
  const production = { env: { NODE_ENV: 'production' } };
  for (const config of [{ razorpayBaseUrl: 'http://127.0.0.1:9103' }, { shiprocketBaseUrl: 'http://localhost:9104' }, { shopifyBaseUrl: 'http://127.0.0.1:9105' }, { whatsappBaseUrl: 'http://127.0.0.1:9102' }, { emailDriver: 'http', emailBaseUrl: 'http://127.0.0.1:9107' }]) {
    assert.throws(() => createStoreAdapters(config, production), /simulator.*refused/i, JSON.stringify(config));
    assert.doesNotThrow(() => createStoreAdapters(config, { env: {} }));
  }
  for (const config of [{ razorpayBaseUrl: 'https://api.razorpay.com.evil.example' }, { shiprocketBaseUrl: 'https://evil.example' }, { shopifyBaseUrl: 'https://evil.example' }, { whatsappBaseUrl: 'https://graph.facebook.com@evil.example' }, { emailDriver: 'http', emailBaseUrl: 'https://evil.example' }]) {
    assert.throws(() => createStoreAdapters(config, { env: {} }), ProviderHostBlockedError, JSON.stringify(config));
  }
  // With nothing set, each is the provider itself, and email is off until a provider is chosen.
  const real = createStoreAdapters({}, production);
  assert.equal(real.email.driver, 'none');
  assert.equal(real.razorpay.default.kind, 'route');
  assert.equal(createRazorpay({ paymentMode: 'own' }, { env: {} }).default.kind, 'partner');
  assert.throws(() => real.shopify.forShop({ shopDomain: 'evil.example', accessToken: 'x' }), ProviderHostBlockedError);
  assert.doesNotThrow(() => createStoreAdapters({ emailDriver: 'http', emailBaseUrl: 'https://api.mail.example', emailHosts: 'https://api.mail.example' }, production));
});

test('razorpay route: an order with its transfer, the checkout signature, a refund that reverses, and no double refund', async (t) => {
  const sim = await start(t, createRazorpaySim());
  const razorpay = createRazorpay(razorpayConfig(sim), { env: {} });
  const { route } = razorpay;
  assert.equal(razorpay.forMode('managed'), route);
  assert.equal(razorpay.forMode(undefined), route);

  const account = await route.createLinkedAccount({ email: 'seller@example.test', phone: '9000000001', legalName: 'Mehta Mart', businessType: 'proprietorship', contactName: 'Asha', reference: 'tenant-1' });
  assert.equal(account.status, 'created');
  // Until KYC passes, the gateway refuses to route money there.
  await assert.rejects(() => route.createOrder({ linkedAccountId: account.id }, { amountPaise: 100000, receipt: 'MM-1001' }), (err) => err instanceof ProviderError && err.kind === 'rejected' && err.delivery === 'none');
  await sim.post('/accounts/kyc', { id: account.id, status: 'activated' });
  assert.equal((await route.fetchLinkedAccount(account.id)).status, 'activated');

  const linked = { linkedAccountId: account.id };
  const order = await route.createOrder(linked, { amountPaise: 100000, receipt: 'MM-1001', notes: { order: 'MM-1001' } });
  assert.deepEqual([order.amountPaise, order.status, order.receipt, order.keyId], [100000, 'created', 'MM-1001', sim.keyId]);
  assert.deepEqual(route.checkoutOptions(linked, { gatewayOrderId: order.id, amountPaise: 100000, display: { name: 'Mehta Mart', image: 'https://cdn.example/logo.png', color: '#234D33' } }),
    { key: sim.keyId, order_id: order.id, amount: 100000, currency: 'INR', name: 'Mehta Mart', image: 'https://cdn.example/logo.png', theme: { color: '#234D33' } }, 'S-71: the seller’s name, logo and colour');

  const { payment, signature } = await sim.post('/pay', { orderId: order.id });
  const returned = { gatewayOrderId: order.id, gatewayPaymentId: payment.id, signature };
  assert.equal(verifyCheckout(returned, sim.keySecret), true, 'S-19');
  assert.equal(verifyCheckout({ ...returned, signature: 'f'.repeat(64) }, sim.keySecret), false, 'S-20: a forged callback');
  assert.equal(verifyCheckout({ ...returned, gatewayPaymentId: 'pay_other' }, sim.keySecret), false);
  assert.equal(verifyCheckout(returned, ''), false);
  assert.equal(verifyCheckout({}, sim.keySecret), false);

  const fetched = await route.fetchPayment(linked, payment.id);
  assert.deepEqual([fetched.status, fetched.amountPaise, fetched.orderId, fetched.method], ['captured', 100000, order.id, 'upi']);
  assert.ok(fetched.feePaise > 0 && fetched.taxPaise > 0, 'the gateway fee and its GST, at cost');
  assert.deepEqual((await route.orderPayments(linked, order.id)).map((p) => p.id), [payment.id], 'S-26: what reconciliation asks');
  assert.equal((await route.fetchOrder(linked, order.id)).status, 'paid');
  const [transfer] = (await sim.get('/state')).transfers;
  assert.deepEqual([transfer.recipient, transfer.amount], [account.id, 100000], 'S-70: the whole amount goes to the seller; no commission');

  const refund = await route.refund(linked, payment.id, { amountPaise: 20000, idempotencyKey: 'refund-key-1' });
  assert.deepEqual([refund.status, refund.amountPaise, refund.reversal.amountPaise], ['processed', 20000, 20000], 'S-75: the transfer is taken back by the same amount');
  assert.equal((await route.fetchTransfer(transfer.id)).amountReversedPaise, 20000);
  // The answer to a refund is lost: the call is repeated with the same key and is the same refund.
  await sim.fault({ kind: 'partial', match: { path: '/v1/payments/*/refund' } });
  const repeated = await route.refund(linked, payment.id, { amountPaise: 30000, idempotencyKey: 'refund-key-2' });
  assert.equal(repeated.amountPaise, 30000);
  assert.equal((await route.fetchPayment(linked, payment.id)).amountRefundedPaise, 50000, 'refunded once, not twice');
  assert.equal((await route.fetchRefund(linked, payment.id, repeated.id)).status, 'processed');
  await assert.rejects(() => route.refund(linked, payment.id, { amountPaise: 50001, idempotencyKey: 'refund-key-3' }), (err) => err.kind === 'rejected', 'S-28 at the gateway too');
  await assert.rejects(() => route.refund(linked, payment.id, { amountPaise: 1 }), /idempotency key/);
});

test('razorpay partner: the seller’s own account by OAuth, with no Route and no reversal', async (t) => {
  const sim = await start(t, createRazorpaySim());
  const razorpay = createRazorpay(razorpayConfig(sim), { env: {} });
  const { partner } = razorpay;
  assert.equal(razorpay.forMode('own'), partner);
  const url = new URL(partner.authorizeUrl({ state: 'state-1', redirectUri: 'https://app.example/oauth/razorpay/callback' }));
  assert.deepEqual([url.searchParams.get('client_id'), url.searchParams.get('state')], [sim.partner.clientId, 'state-1']);

  const { code, accountId, keySecret } = await sim.post('/oauth/code', {});
  const tokens = await partner.exchangeCode({ code, redirectUri: 'https://app.example/oauth/razorpay/callback' });
  assert.equal(tokens.accountId, accountId);
  assert.ok(tokens.accessToken && tokens.refreshToken && tokens.expiresAt > new Date());
  await assert.rejects(() => partner.exchangeCode({ code, redirectUri: 'x' }), (err) => err.kind === 'rejected', 'a code works once');
  assert.ok((await partner.refreshToken(tokens.refreshToken)).accessToken);

  const own = { accessToken: tokens.accessToken, publicToken: tokens.publicToken };
  const order = await partner.createOrder(own, { amountPaise: 99900, receipt: 'MM-1002' });
  const { payment, signature } = await sim.post('/pay', { orderId: order.id });
  assert.equal(verifyCheckout({ gatewayOrderId: order.id, gatewayPaymentId: payment.id, signature }, keySecret), true, 'checked with the seller’s own secret');
  assert.equal(verifyCheckout({ gatewayOrderId: order.id, gatewayPaymentId: payment.id, signature }, sim.keySecret), false, 'and not with the platform’s');
  const refund = await partner.refund(own, payment.id, { amountPaise: 20000, idempotencyKey: 'refund-key-9' });
  assert.deepEqual([refund.amountPaise, refund.reversal], [20000, null], 'S-76');
  assert.deepEqual((await sim.get('/state')).transfers, []);
  // The platform's own keys cannot see the seller's order, and the seller's token cannot use Route.
  await assert.rejects(() => razorpay.route.fetchOrder({ linkedAccountId: 'x' }, order.id), (err) => err.kind === 'rejected');
  await assert.rejects(() => partner.createOrder({}, { amountPaise: 100, receipt: 'x' }), /seller’s own account/);
});

test('every call has a timeout, and a failure says whether the provider may have acted', async (t) => {
  const sim = await start(t, createRazorpaySim());
  const { route } = createRazorpay(razorpayConfig(sim, { providerTimeoutMs: 150 }), { env: {} });
  const account = await route.createLinkedAccount({ email: 'a@example.test', phone: '9', legalName: 'A', businessType: 'other', contactName: 'A', reference: 't' });
  await sim.post('/accounts/kyc', { id: account.id, status: 'activated' });
  const linked = { linkedAccountId: account.id };

  await sim.fault({ kind: 'timeout', match: { path: '/v1/orders' } });
  const started = Date.now();
  await assert.rejects(() => route.createOrder(linked, { amountPaise: 100, receipt: 'r' }), (err) => err instanceof ProviderError && err.kind === 'timeout' && err.retryable && err.delivery === 'unknown');
  assert.ok(Date.now() - started < 3000, 'it gave up at the timeout');

  // The order was made, and then the answer failed: the caller is told it does not know.
  await sim.fault({ kind: 'partial', match: { path: '/v1/orders' } });
  await assert.rejects(() => route.createOrder(linked, { amountPaise: 100, receipt: 'r2' }), (err) => err.kind === 'server' && err.delivery === 'unknown');
  assert.equal((await sim.get('/state')).orders.filter((o) => o.receipt === 'r2').length, 1, 'and it was not blindly repeated');

  await sim.fault({ kind: 'rate_limit', match: { path: '/v1/orders/*' }, times: 1 });
  const order = await route.createOrder(linked, { amountPaise: 100, receipt: 'r3' });
  assert.equal((await route.fetchOrder(linked, order.id)).id, order.id, 'a read is retried past a throttle');
  await sim.fault({ kind: 'malformed', mode: 'html', match: { path: '/v1/orders' } });
  await assert.rejects(() => route.createOrder(linked, { amountPaise: 100, receipt: 'r4' }), (err) => err.kind === 'malformed');
  const failure = await route.createOrder(linked, { amountPaise: 50, receipt: 'r5' }).catch((err) => err);
  assert.equal(failure.message.includes(sim.keySecret), false);
  assert.deepEqual([failure.kind, failure.status, failure.code, failure.delivery], ['rejected', 400, 'BAD_REQUEST_ERROR', 'none']);
});

test('razorpay webhooks: signed over the exact bytes, repeated with the same event id, and out of order', async (t) => {
  const hook = await receiver(t);
  const sim = await start(t, createRazorpaySim({ webhookUrl: hook.url }));
  const { route } = createRazorpay(razorpayConfig(sim), { env: {} });
  const account = await route.createLinkedAccount({ email: 'a@example.test', phone: '9', legalName: 'A', businessType: 'other', contactName: 'A', reference: 't' });
  await sim.post('/accounts/kyc', { id: account.id, status: 'activated', signature: 'none' });
  hook.got.length = 0;
  const order = await route.createOrder({ linkedAccountId: account.id }, { amountPaise: 100000, receipt: 'MM-1' });

  await sim.post('/pay', { orderId: order.id, duplicates: 3 });
  const captured = hook.got.filter((g) => g.body.event === 'payment.captured');
  assert.equal(captured.length, 3, 'S-23: the same event three times');
  assert.equal(new Set(captured.map((g) => g.headers[SIGNATURE_HEADERS.razorpayEventId])).size, 1, 'with one event id to dedupe on');
  for (const g of captured) assert.equal(verifyWebhook(g.raw, g.headers[SIGNATURE_HEADERS.razorpay], sim.webhookSecret), true);
  assert.equal(verifyWebhook(captured[0].raw, captured[0].headers[SIGNATURE_HEADERS.razorpay], 'another-secret'), false, 'S-25');
  assert.equal(verifyWebhook(Buffer.from(`${captured[0].raw} `), captured[0].headers[SIGNATURE_HEADERS.razorpay], sim.webhookSecret), false, 'one byte more is another body');
  assert.equal(verifyWebhook(captured[0].raw, undefined, sim.webhookSecret), false);
  assert.equal(verifyWebhook(captured[0].raw.toString(), captured[0].headers[SIGNATURE_HEADERS.razorpay], sim.webhookSecret), false, 'the bytes, not a re-serialised copy');
  assert.deepEqual(captured[0].body.payload.payment.entity.order_id, order.id);
  assert.ok(hook.got.some((g) => g.body.event === 'order.paid'));

  // Out of order: a "failed" attempt and then the capture, delivered the other way round (S-24).
  hook.got.length = 0;
  const second = await route.createOrder({ linkedAccountId: account.id }, { amountPaise: 5000, receipt: 'MM-2' });
  await sim.post('/pay', { orderId: second.id, outcome: 'failed', hold: true });
  await sim.post('/pay', { orderId: second.id, hold: true });
  assert.equal(hook.got.length, 0, 'held back');
  await sim.post('/webhooks/flush', { order: 'reverse' });
  assert.deepEqual(hook.got.map((g) => g.body.event), ['order.paid', 'payment.captured', 'payment.failed'], 'failed arrives after captured');

  hook.got.length = 0;
  const bad = await sim.post('/webhooks/send', { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_forged', order_id: order.id } } }, signature: 'bad' });
  assert.equal(verifyWebhook(hook.got[0].raw, hook.got[0].headers[SIGNATURE_HEADERS.razorpay], sim.webhookSecret), false, 'a forged event does not verify');
  assert.ok(bad.eventId);
  const [transfer] = (await sim.get('/state')).transfers;
  await sim.post('/transfers/fail', { id: transfer.id });
  assert.equal(hook.got.at(-1).body.event, 'transfer.failed', 'a failed transfer is told too (9.7)');
  // The clock is the test's: an event made after it is moved carries the new time.
  await sim.post('/clock', { now: Date.parse('2027-04-01T00:00:00+05:30'), freeze: true });
  await sim.post('/webhooks/send', { event: 'payment.authorized', payload: {} });
  assert.equal(hook.got.at(-1).body.created_at, Math.floor(Date.parse('2027-04-01T00:00:00+05:30') / 1000));
  // A webhook the app does not answer is recorded, and can be sent again as the provider would.
  assert.equal((await sim.get('/webhooks')).deliveries.every((d) => d.ok), true);
  const redelivered = await sim.post('/webhooks/redeliver', { id: bad.id, times: 2 });
  assert.equal(redelivered.attempts, 3);
});

test('a seller’s own gateway has its own webhook address and secret', async (t) => {
  const platformHook = await receiver(t);
  const ownHook = await receiver(t);
  const sim = await start(t, createRazorpaySim({ webhookUrl: platformHook.url }));
  const { partner } = createRazorpay(razorpayConfig(sim), { env: {} });
  const { code, accountId } = await sim.post('/oauth/code', {});
  const tokens = await partner.exchangeCode({ code, redirectUri: 'x' });
  const { secret } = await sim.post('/webhooks/url', { url: ownHook.url, accountId });
  const order = await partner.createOrder({ accessToken: tokens.accessToken }, { amountPaise: 99900, receipt: 'B-1' });
  await sim.post('/pay', { orderId: order.id });
  assert.equal(platformHook.got.length, 0, 'the platform’s address hears nothing of it');
  const [event] = ownHook.got;
  assert.equal(event.body.account_id, accountId);
  assert.equal(verifyWebhook(event.raw, event.headers[SIGNATURE_HEADERS.razorpay], secret), true);
  assert.equal(verifyWebhook(event.raw, event.headers[SIGNATURE_HEADERS.razorpay], sim.webhookSecret), false, 'verified with that business’s secret only');
});

test('shiprocket: the seller as shipper, the balance as the COD amount, tracking, and a session that renews itself', async (t) => {
  const hook = await receiver(t);
  const sim = await start(t, createShiprocketSim({ webhookUrl: hook.url, users: [{ email: 'own@seller.test', password: 'own-password' }] }));
  const config = { shiprocketBaseUrl: sim.url, shiprocketEmail: 'sim@bhava.test', shiprocketPassword: 'sim-shiprocket-password' };
  const courier = createShiprocket(config, { env: {} });

  await sim.post('/serviceability', { pincode: '999999', serviceable: false });
  await sim.post('/serviceability', { pincode: '560001', cod: false });
  assert.deepEqual(await courier.serviceability({ pickupPincode: '411001', deliveryPincode: '999999' }), { serviceable: false, cod: false, couriers: [] }, 'S-33');
  const served = await courier.serviceability({ pickupPincode: '411001', deliveryPincode: '110001', cod: true });
  assert.deepEqual([served.serviceable, served.cod, served.couriers[0].ratePaise], [true, true, 4900], 'rupees on the wire, paise in the app');
  assert.equal((await courier.serviceability({ pickupPincode: '411001', deliveryPincode: '560001' })).cod, false);

  await courier.addPickupLocation({ code: 'seller-1', name: 'Mehta Mart', phone: '9000000001', email: 's@example.test', line1: '4 Mill Lane', city: 'Pune', state: 'Maharashtra', pincode: '411001' });
  const shipTo = { name: 'Asha Rao', phone: '9876543210', line1: '12 Lake Road', city: 'Delhi', state: 'Delhi', pincode: '110001' };
  const input = { orderNumber: 'MM-1001', pickupLocation: 'seller-1', shipTo, items: [{ id: 1, name: 'Brass lamp', sku: 'LAMP', qty: 1, pricePaise: 99900 }], weightGrams: 500, lengthCm: 10, breadthCm: 10, heightCm: 10, codPaise: 89900, subTotalPaise: 99900 };
  await assert.rejects(() => courier.createOrder({ ...input, pickupLocation: 'nobody' }), (err) => err instanceof ProviderError && err.kind === 'rejected');
  const made = await courier.createOrder(input);
  const { awb, courierName, chargePaise } = await courier.assignAwb({ providerShipmentId: made.providerShipmentId });
  assert.ok(awb && courierName);
  assert.equal(chargePaise, 4900, 'S-77: what the courier charged, at cost');
  assert.equal((await courier.requestPickup({ providerShipmentId: made.providerShipmentId })).scheduled, true);
  const label = await courier.label({ providerShipmentId: made.providerShipmentId });
  const printed = await (await fetch(label.url)).json();
  assert.deepEqual([printed.shipper.name, printed.shipper.address, printed.cod_amount, printed.payment_method], ['Mehta Mart', '4 Mill Lane', 899, 'COD'], 'S-77, S-21: the seller is the shipper and the COD amount is the balance');

  // The session is thrown away on the courier's side: the next call logs in again by itself.
  await sim.post('/sessions/expire', {});
  await sim.post('/track', { awb, status: 'IN TRANSIT', location: 'Pune hub', webhook: false });
  const tracked = await courier.track({ awb });
  assert.deepEqual([tracked.status, tracked.events[0].status, tracked.events[0].location], ['in_transit', 'in_transit', 'Pune hub']);

  // Tracking webhooks: the token, a duplicate, and events out of order.
  await sim.post('/track', { awb, status: 'DELIVERED', duplicates: 2 });
  assert.equal(hook.got.length, 2, 'S-35: delivered twice');
  assert.equal(hook.got[0].raw.equals(hook.got[1].raw), true, 'the same AWB, status and time');
  assert.deepEqual([hook.got[0].body.awb, mapStatus(hook.got[0].body.current_status), hook.got[0].body.pickup_location], [awb, 'delivered', 'seller-1']);
  assert.equal(courier.verifyWebhook(hook.got[0].headers[SIGNATURE_HEADERS.courier], sim.webhookToken), true);
  assert.equal(courier.verifyWebhook('wrong', sim.webhookToken), false);
  assert.equal(courier.verifyWebhook(undefined, sim.webhookToken), false);
  assert.equal(courier.verifyWebhook(sim.webhookToken, ''), false);
  hook.got.length = 0;
  await sim.post('/track', { awb, status: 'OUT FOR DELIVERY', hold: true });
  await sim.post('/track', { awb, status: 'DELIVERED', hold: true });
  await sim.post('/webhooks/flush', { order: 'reverse' });
  assert.deepEqual(hook.got.map((g) => mapStatus(g.body.current_status)), ['delivered', 'out_for_delivery'], 'the older event arrives last');
  await sim.post('/track', { awb, status: 'DELIVERED', signature: 'bad' });
  assert.equal(courier.verifyWebhook(hook.got.at(-1).headers[SIGNATURE_HEADERS.courier], sim.webhookToken), false);

  for (const text of ['Picked Up', 'IN TRANSIT', 'RTO Delivered', 'Canceled', 'LOST']) assert.ok(SHIPMENT_STATUSES.includes(mapStatus(text)), text);
  assert.equal(mapStatus('SOMETHING NEW'), '', 'an unknown scan changes nothing');

  // The seller's own API user is a different account: it does not see the managed account's shipment or pickup location.
  const own = courier.forAccount({ email: 'own@seller.test', password: 'own-password' });
  await assert.rejects(() => own.assignAwb({ providerShipmentId: made.providerShipmentId }), (err) => err.status === 404);
  await assert.rejects(() => own.createOrder(input), (err) => err.kind === 'rejected', 'its own pickup location is needed');
  await assert.rejects(() => courier.forAccount({ email: 'own@seller.test', password: 'wrong' }).track({ awb }), (err) => err.kind === 'auth');
  await sim.fault({ kind: 'timeout', match: { path: '/v1/external/courier/assign/awb' } });
  const slow = createShiprocket({ ...config, providerTimeoutMs: 150 }, { env: {} });
  await assert.rejects(() => slow.assignAwb({ providerShipmentId: made.providerShipmentId }), (err) => err.kind === 'timeout' && err.delivery === 'unknown');
});

test('shopify: paging, an order that takes stock down once, its limit, and webhooks signed and deduped by id', async (t) => {
  const hook = await receiver(t);
  const sim = await start(t, createShopifySim({ webhookUrl: hook.url }));
  for (let i = 1; i <= 5; i++) await sim.post('/products', { id: 100 + i, title: `Plant ${i}`, variants: [{ id: 200 + i, inventory_item_id: 300 + i, price: '499.00', inventory_quantity: 5 }] });
  const shopify = createShopify({ shopifyBaseUrl: sim.url }, { env: {} });
  const shop = shopify.forShop({ shopDomain: sim.shopDomain, accessToken: 'sim-shopify-token' });
  assert.equal((await shop.shop()).currency, 'INR');

  const first = await shop.products({ limit: 2 });
  assert.equal(first.items.length, 2);
  const titles = first.items.map((p) => p.title);
  for (let page = first; page.nextPageInfo;) {
    page = await shop.products({ pageInfo: page.nextPageInfo, limit: 2 });
    titles.push(...page.items.map((p) => p.title));
  }
  assert.deepEqual(titles, ['Plant 1', 'Plant 2', 'Plant 3', 'Plant 4', 'Plant 5']);
  assert.equal((await shop.product(101)).title, 'Plant 1');
  assert.equal(await shop.product(999), null);

  const order = { orderNumber: 'MM-1001', lines: [{ variantId: 201, qty: 2, pricePaise: 49900 }], totalPaise: 99800, paid: true, idempotencyKey: 'MM-1001' };
  const pushed = await shop.createOrder(order);
  const again = await shop.createOrder(order);
  assert.equal(again.id, pushed.id, 'pushed twice is one order');
  assert.deepEqual(await shop.inventoryLevels({ inventoryItemIds: [301] }), [{ inventoryItemId: '301', locationId: '1', available: 3 }], 'S-37: stock went down once');
  await shop.setInventory({ inventoryItemId: 301, locationId: 1, available: 9 });
  await shop.updateVariant(201, { pricePaise: 54900 });
  assert.equal((await shop.product(101)).variants[0].price, '549.00');
  assert.deepEqual(await shop.registerWebhooks({ address: 'https://app.example/webhooks/shopify', topics: ['products/update'] }).then((w) => w.map((x) => x.topic)), ['products/update']);

  const sent = await sim.post('/admin/products/update', { id: 101, variants: [{ id: 201, price: '599.00' }], duplicates: 2 });
  assert.equal(hook.got.length, 2);
  assert.equal(new Set(hook.got.map((g) => g.headers[SIGNATURE_HEADERS.shopifyWebhookId])).size, 1, 'one webhook id to dedupe on');
  assert.deepEqual([hook.got[0].headers[SIGNATURE_HEADERS.shopifyTopic], hook.got[0].headers[SIGNATURE_HEADERS.shopifyShop], hook.got[0].body.variants[0].price], ['products/update', sim.shopDomain, '599.00'], 'S-36');
  assert.equal(verifyShopify(hook.got[0].raw, hook.got[0].headers[SIGNATURE_HEADERS.shopify], sim.clientSecret), true);
  assert.equal(verifyShopify(hook.got[0].raw, hook.got[0].headers[SIGNATURE_HEADERS.shopify], 'another-secret'), false, 'S-38');
  assert.equal(verifyShopify(hook.got[0].raw, '', sim.clientSecret), false);
  assert.ok(sent.webhook.webhookId);
  await sim.post('/admin/inventory', { inventoryItemId: 301, available: 1, signature: 'bad' });
  assert.equal(verifyShopify(hook.got.at(-1).raw, hook.got.at(-1).headers[SIGNATURE_HEADERS.shopify], sim.clientSecret), false);

  // Two calls a second: the third is throttled, and lifts when the clock moves.
  await sim.post('/clock', { freeze: true });
  await sim.post('/admin/limit', { on: true });
  await shop.inventoryLevels({ inventoryItemIds: [301] });
  await shop.inventoryLevels({ inventoryItemIds: [301] });
  await assert.rejects(() => shop.createOrder({ ...order, idempotencyKey: 'MM-1002' }), (err) => err instanceof ProviderError && err.kind === 'throttled' && err.retryable && err.delivery === 'none');
  await sim.post('/clock', { advanceMs: 1500 });
  assert.ok((await shop.createOrder({ ...order, idempotencyKey: 'MM-1002' })).id);
  assert.throws(() => shopify.forShop({ shopDomain: sim.shopDomain, accessToken: '' }), /access token/);
  await assert.rejects(() => shopify.forShop({ shopDomain: sim.shopDomain, accessToken: 'wrong' }).shop(), (err) => err.kind === 'auth');
});

test('whatsapp: templates and their review, delivery reports with their cost category, and replies', async (t) => {
  const hook = await receiver(t);
  const sim = await start(t, createWhatsAppSim({ webhookUrl: hook.url }));
  const whatsapp = createWhatsApp({ whatsappBaseUrl: sim.url }, { env: {} });
  const account = { phoneNumberId: '5550001', wabaId: '7770001', accessToken: 'sim-whatsapp-token' };
  assert.equal((await whatsapp.phoneNumber(account)).quality, 'GREEN');

  const made = await whatsapp.createTemplate(account, { name: 'order_paid', category: 'utility', components: [{ type: 'BODY', text: 'Your order {{1}} is paid.' }] });
  assert.equal(made.status, 'pending');
  await sim.post('/templates/enforce', { on: true });
  await assert.rejects(() => whatsapp.sendTemplate(account, { to: '919876543210', name: 'order_paid' }), (err) => err instanceof ProviderError && err.kind === 'rejected' && err.delivery === 'none', 'S-53: a template still in review cannot be sent');
  await sim.post('/templates', { name: 'order_paid', status: 'approved' });
  assert.deepEqual((await whatsapp.templates(account)).map((x) => [x.name, x.category, x.status]), [['order_paid', 'utility', 'approved']]);
  const { messageId } = await whatsapp.sendTemplate(account, { to: '919876543210', name: 'order_paid', components: [{ type: 'body', parameters: [{ type: 'text', text: 'MM-1001' }] }] });
  assert.ok(messageId);
  await assert.rejects(() => whatsapp.sendTemplate(account, { to: '+91 98765 43210', name: 'order_paid' }), /digits only/);
  await assert.rejects(() => whatsapp.sendTemplate({ ...account, accessToken: '' }, { to: '919876543210', name: 'order_paid' }), /own account/);

  // A send whose answer is lost may have gone out: it is reported as unknown, and nothing sent it twice.
  await sim.fault({ kind: 'partial', match: { path: '/*/5550001/messages' } });
  await assert.rejects(() => whatsapp.sendTemplate(account, { to: '919876543210', name: 'order_paid' }), (err) => err.delivery === 'unknown');
  assert.equal((await sim.get('/sent')).sent.length, 2);

  await sim.post('/status', { messageId, status: 'delivered', category: 'utility', hold: true });
  await sim.post('/status', { messageId, status: 'sent', hold: true, duplicates: 2 });
  await sim.post('/webhooks/flush', {});
  assert.equal(hook.got.length, 3, '"delivered" before "sent", and "sent" twice');
  for (const g of hook.got) assert.equal(verifyWhatsApp(g.raw, g.headers[SIGNATURE_HEADERS.whatsapp], sim.appSecret), true);
  assert.equal(verifyWhatsApp(hook.got[0].raw, hook.got[0].headers[SIGNATURE_HEADERS.whatsapp], 'another'), false);
  assert.deepEqual(hook.got.map((g) => parseStatuses(g.body)[0].status), ['delivered', 'sent', 'sent']);
  assert.deepEqual([parseStatuses(hook.got[0].body)[0].messageId, parseStatuses(hook.got[0].body)[0].costCategory, parseStatuses(hook.got[0].body)[0].phoneNumberId], [messageId, 'utility', '5550001']);
  await sim.post('/inbound', { phoneId: '5550001', from: '919876543210', text: 'STOP' });
  assert.deepEqual(parseInbound(hook.got.at(-1).body), [{ phoneNumberId: '5550001', from: '919876543210', text: 'STOP' }], 'S-64: a STOP reply reaches the app');
  assert.deepEqual(parseStatuses({ entry: 'nonsense' }), []);
  assert.deepEqual(parseInbound(null), []);
});

test('email: off until a provider is chosen; over HTTP it is sent once per key, from a domain that passes DKIM', async (t) => {
  await assert.rejects(() => createEmail({}).send({ from: 'a@b.test', to: 'c@d.test', subject: 's', text: 't' }), (err) => err instanceof ProviderError && err.code === 'not_configured' && err.delivery === 'none');
  assert.throws(() => createEmail({ emailDriver: 'carrier-pigeon' }), /Unknown EMAIL_DRIVER/);
  const sim = await start(t, createEmailSim());
  const email = createEmail({ emailDriver: 'http', emailBaseUrl: sim.url, emailApiKey: 'sim-email-key' }, { env: {} });
  const message = { from: 'orders@mehtamart.example', fromName: 'Mehta Mart', to: 'asha@example.test', subject: 'Your order MM-1001 is paid', html: '<p>Thank you.</p>', text: 'Thank you.', headers: { 'List-Unsubscribe': '<https://mehtamart.example/unsubscribe/abc>' }, idempotencyKey: 'order-1-paid-email' };
  await sim.post('/dkim', { domain: 'mehtamart.example', pass: true });
  const first = await email.send(message);
  await sim.fault({ kind: 'partial', match: { path: '/messages' } });
  const second = await email.send(message);
  assert.equal(second.messageId, first.messageId, 'the answer was lost, the send was repeated with its key, and it is one email');
  const { sent } = await sim.get('/sent');
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].fromDomain, sent[0].dkim, sent[0].headers['List-Unsubscribe']], ['mehtamart.example', 'pass', '<https://mehtamart.example/unsubscribe/abc>'], 'S-55');
  await sim.post('/dkim', { domain: 'unverified.example', pass: false });
  await assert.rejects(() => email.send({ ...message, from: 'orders@unverified.example', idempotencyKey: 'k2' }), (err) => err.kind === 'auth');
  await assert.rejects(() => createEmail({ emailDriver: 'http', emailBaseUrl: sim.url, emailApiKey: 'wrong' }, { env: {} }).send(message), (err) => err.kind === 'auth');
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(sent)).digest('hex').length, 64);
});

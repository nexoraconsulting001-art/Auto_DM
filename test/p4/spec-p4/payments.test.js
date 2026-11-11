// PRD 9.6 (payments) and 9.7 (webhooks and reconciliation). S-19, S-20, S-23 to S-26, S-70 to S-74.
// Bhava-managed mode runs on the platform's Razorpay account with Route; the simulator plays the shopper paying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MINUTE, STORE_LIMITS, STORE_PROVIDER_PATHS, addP4Shop, assertSellerBrandOnly, buyer, need, noCrash, noPlatformName, ok, refused, sum, textOf, together, unique, useP4World } from './kit.js';

const world = useP4World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });
const paymentMoves = async (shop, order) => (await shop.history(order.id)).filter((h) => h.machine === 'payment');
const deliveries = async (event) => (await world.rzp.get('/webhooks')).deliveries.filter((d) => !event || d.body?.event === event);
const webhookCount = async () => (await world.sql(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'razorpay'`))[0].n;

async function placed(shop, fields = {}) {
  const product = fields.product ?? await shop.item({ pricePaise: fields.pricePaise ?? 99900, stock: 5 });
  const b = buyer(world, shop);
  const p = await b.order({ lines: [line(product)], ...fields.order });
  return { b, p, product, order: await shop.order(p.orderNumber) };
}

test('S-19: a UPI payment marks the order paid only once the server has checked the signature', async () => {
  const shop = await addP4Shop(world);
  const { b, p, order } = await placed(shop);
  assert.equal(order.payment_status, 'unpaid');
  const [gwCall] = (await world.rzp.calls({ method: 'POST', path: '/v1/orders' })).filter((c) => c.body?.receipt === p.orderNumber);
  assert.ok(gwCall, 'No gateway order with the order number as its receipt');
  assert.equal(gwCall.body.amount, Number(order.total_paise), 'The gateway order is not for the exact total');
  assert.equal(p.gateway.amountPaise, Number(order.total_paise));
  const paid = await b.pay(p, { method: 'upi', back: false });
  await world.quiet(1000);
  assert.equal((await shop.order(p.orderNumber)).payment_status, 'unpaid', 'Paid with no signature checked and no webhook');
  ok(await b.paymentReturn(p, paid), 'Coming back with the signature');
  const row = await shop.orderWhen(p.orderNumber, (o) => o.payment_status === 'paid');
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.fulfilment_status, 'new');
  assert.equal(Number(row.paid_paise), Number(row.total_paise));
  const [payment] = await shop.payments(order.id);
  assert.equal(payment.status, 'captured');
  assert.equal(payment.method, 'upi');
  assert.equal(payment.gateway_payment_id, paid.payment.id);
  assert.equal((await paymentMoves(shop, order)).filter((h) => h.to_status === 'paid').length, 1);
});

test('S-20: a forged success callback leaves the order pending and is logged as a security event', async () => {
  const shop = await addP4Shop(world);
  const { b, p, order } = await placed(shop);
  const other = await placed(shop);
  const otherPaid = await other.b.pay(other.p, { back: false });
  const failed = await world.rzp.post('/pay', { orderId: p.gateway.gatewayOrderId, outcome: 'failed', webhook: false });
  const before = (await shop.securityEvents()).length;
  const forgeries = {
    'a made-up signature': { gatewayPaymentId: 'pay_forged000001', signature: 'f'.repeat(64) },
    'a signature made with the wrong secret': { gatewayPaymentId: 'pay_forged000002', signature: crypto.createHmac('sha256', 'not-the-secret').update(`${p.gateway.gatewayOrderId}|pay_forged000002`).digest('hex') },
    'another order’s real payment and signature': { gatewayOrderId: other.p.gateway.gatewayOrderId, gatewayPaymentId: otherPaid.payment.id, signature: otherPaid.signature },
    'another order’s payment against this gateway order': { gatewayPaymentId: otherPaid.payment.id, signature: otherPaid.signature },
    'a failed payment with its genuine signature': { gatewayPaymentId: failed.payment.id, signature: failed.signature },
    'an empty signature': { gatewayPaymentId: failed.payment.id, signature: '' },
  };
  for (const [what, change] of Object.entries(forgeries)) {
    const res = noCrash(await b.api('POST', '/api/store/payments/return', { orderToken: p.token, gatewayOrderId: p.gateway.gatewayOrderId, ...change }), what);
    noPlatformName(`The answer to ${what}`, res.text);
  }
  await world.quiet(1000);
  const row = await shop.order(p.orderNumber);
  assert.equal(row.payment_status, 'unpaid', 'A forged callback marked the order paid');
  assert.equal(row.fulfilment_status, 'pending');
  assert.equal((await shop.order(other.p.orderNumber)).payment_status, 'unpaid', 'Another order was paid by a callback about it on this order');
  assert.ok((await shop.payments(order.id)).every((x) => x.status !== 'captured'));
  assert.ok((await shop.securityEvents()).length > before, 'No security event for a forged callback');
  noCrash(await b.api('POST', '/api/store/payments/return', { orderToken: 'x'.repeat(100), gatewayOrderId: 'order_x', gatewayPaymentId: 'pay_x', signature: 'x' }), 'An unknown order token');
  refused(await b.api('POST', '/api/store/payments/return', { orderToken: p.token, gatewayOrderId: p.gateway.gatewayOrderId, gatewayPaymentId: otherPaid.payment.id, signature: otherPaid.signature, amountPaise: 1 }), 'A callback carrying an amount', 400);
});

test('S-20: another business’s order cannot be paid or read with this business’s callback', async () => {
  const a = await addP4Shop(world);
  const b = await addP4Shop(world);
  const atA = await placed(a);
  const atB = await placed(b);
  const paidB = await atB.b.pay(atB.p, { back: false });
  const cross = buyer(world, a);
  noCrash(await cross.api('POST', '/api/store/payments/return', { orderToken: atB.p.token, gatewayOrderId: atB.p.gateway.gatewayOrderId, gatewayPaymentId: paidB.payment.id, signature: paidB.signature }), 'B’s order paid on A’s host');
  noCrash(await cross.api('POST', '/api/store/payments/return', { orderToken: atA.p.token, gatewayOrderId: atB.p.gateway.gatewayOrderId, gatewayPaymentId: paidB.payment.id, signature: paidB.signature }), 'B’s real payment against A’s order');
  await world.quiet(1000);
  assert.equal((await a.order(atA.p.orderNumber)).payment_status, 'unpaid', 'A’s order was paid with B’s payment');
  const bRow = await b.order(atB.p.orderNumber);
  assert.ok(['unpaid', 'paid'].includes(bRow.payment_status));
  refused(await cross.open(`/order/${atB.p.token}`), 'B’s order page on A’s host', 404);
});

test('S-23: the same captured event three times, or five at once, changes the status once', async () => {
  const shop = await addP4Shop(world);
  const { b, p, order } = await placed(shop);
  const paid = await b.pay(p, { back: false, webhook: true, duplicates: 3 });
  const row = await shop.orderWhen(p.orderNumber, (o) => o.payment_status === 'paid');
  assert.equal(row.payment_status, 'paid');
  const captured = (await deliveries('payment.captured')).filter((d) => d.body.payload.payment.entity.id === paid.payment.id);
  assert.equal(captured.length, 1);
  assert.ok(captured[0].attempts >= 3);
  const [stored] = await world.sql(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'razorpay' AND payload->'payload'->'payment'->'entity'->>'id' = $1 AND event_type = 'payment.captured'`, [paid.payment.id]);
  assert.equal(stored.n, 1, 'The repeated event was stored more than once');
  const raw = captured[0].body;
  const eventId = (await world.sql(`SELECT event_id FROM provider_webhook_events WHERE payload->'payload'->'payment'->'entity'->>'id' = $1 AND event_type = 'payment.captured'`, [paid.payment.id]))[0].event_id;
  const again = await together(5, () => world.razorpayHook(raw, { eventId }));
  again.forEach((r) => assert.ok(r.status >= 200 && r.status < 300, `A repeated delivery answered ${r.status}`));
  ok(await b.paymentReturn(p, paid), 'The browser coming back too');
  await world.quiet(1500);
  assert.equal((await paymentMoves(shop, order)).filter((h) => h.to_status === 'paid').length, 1, 'More than one move to paid');
  assert.equal((await shop.orderEventRows(order.id, 'order.paid')).length, 1, 'order.paid was written more than once');
  assert.equal((await shop.payments(order.id)).filter((x) => x.status === 'captured').length, 1);
  assert.equal(Number((await shop.order(p.orderNumber)).paid_paise), Number(order.total_paise), 'The paid total counted a payment twice');
  const sale = (await shop.settlement(order.id)).filter((l) => l.kind === 'sale');
  assert.equal(sale.length, 1, 'The sale is on the statement more than once');
});

test('S-24: a "failed" arriving after "captured" leaves the order paid', async () => {
  const shop = await addP4Shop(world);
  const { b, p, order } = await placed(shop);
  await world.rzp.post('/pay', { orderId: p.gateway.gatewayOrderId, outcome: 'failed', webhook: true, hold: true });
  const good = await b.pay(p, { back: false, webhook: true });
  await shop.orderWhen(p.orderNumber, (o) => o.payment_status === 'paid');
  await world.rzp.post('/webhooks/flush', {});
  // And a failure for the very payment that was captured, and an "authorized" after both.
  await world.rzp.post('/webhooks/send', { event: 'payment.failed', payload: { payment: { entity: { ...good.payment, status: 'failed', error_code: 'BAD_REQUEST_ERROR' } } } });
  await world.rzp.post('/webhooks/send', { event: 'payment.authorized', payload: { payment: { entity: { ...good.payment, status: 'authorized', captured: false } } } });
  await world.quiet(2000);
  const row = await shop.order(p.orderNumber);
  assert.equal(row.payment_status, 'paid', 'A late failure moved a paid order');
  assert.equal(row.fulfilment_status, 'new');
  const pays = await shop.payments(order.id);
  assert.equal(pays.find((x) => x.gateway_payment_id === good.payment.id).status, 'captured', 'The captured payment went backwards');
  const stale = await world.sql(`SELECT status, outcome FROM provider_webhook_events WHERE provider = 'razorpay' AND event_type IN ('payment.failed', 'payment.authorized') AND payload->'payload'->'payment'->'entity'->>'id' = $1`, [good.payment.id]);
  assert.ok(stale.length >= 1 && stale.every((e) => e.status !== 'failed'), `Late events were not set aside cleanly: ${JSON.stringify(stale)}`);
});

test('S-25: a bad, missing or replayed-onto-other-bytes signature gets 401 and nothing is stored or changed', async () => {
  const shop = await addP4Shop(world);
  const { b, p } = await placed(shop);
  const paid = await b.pay(p, { back: false, webhook: false });
  const body = { entity: 'event', account_id: 'acc_platform', event: 'payment.captured', contains: ['payment'], payload: { payment: { entity: { ...paid.payment } } }, created_at: Math.floor(Date.now() / 1000) };
  const before = await webhookCount();
  const raw = JSON.stringify(body);
  const goodSig = crypto.createHmac('sha256', world.rzp.webhookSecret).update(raw).digest('hex');
  const attempts = {
    'a wrong secret': world.razorpayHook(body, { secret: 'wrong-secret' }),
    'no signature': world.razorpayHook(body, { signature: null }),
    'an empty signature': world.razorpayHook(body, { signature: '' }),
    'the signature of other bytes': world.razorpayHook({ ...body, created_at: 1 }, { signature: goodSig }),
    'a changed amount under the old signature': world.razorpayHook(raw.replace(`"amount":${paid.payment.amount}`, '"amount":100'), { signature: goodSig }),
    'the right signature with one character changed': world.razorpayHook(body, { signature: goodSig.replace(/^./, (c) => (c === '0' ? '1' : '0')) }),
    'the simulator’s bad signature': world.rzp.post('/webhooks/send', { event: 'payment.captured', payload: body.payload, signature: 'bad' }),
    'the simulator with none': world.rzp.post('/webhooks/send', { event: 'payment.captured', payload: body.payload, signature: 'none' }),
  };
  for (const [what, pending] of Object.entries(attempts)) {
    const res = await pending;
    assert.equal(res.status, 401, `${what}: answered ${res.status}`);
  }
  const ownUnknown = await world.razorpayHook(body, { path: '/webhooks/razorpay/NoSuchKeyAtAll1234567' });
  assert.ok([401, 404].includes(ownUnknown.status), `An own-gateway URL with an unknown key answered ${ownUnknown.status}`);
  await world.quiet(800);
  assert.equal(await webhookCount(), before, 'A webhook with a bad signature was stored');
  assert.equal((await shop.order(p.orderNumber)).payment_status, 'unpaid');
  const junk = await world.razorpayHook('{"not json', {});
  assert.ok(junk.status < 500, `A signed but unreadable body crashed the app: ${junk.status}`);
});

test('S-26: when no webhook arrives and the browser never comes back, reconciliation marks the order paid within 20 minutes', async () => {
  const shop = await addP4Shop(world);
  const { b, p, order } = await placed(shop);
  await b.pay(p, { back: false, webhook: false });
  await world.quiet(800);
  assert.equal((await shop.order(p.orderNumber)).payment_status, 'unpaid');
  await world.age((STORE_LIMITS.pendingCheckAfterMinutes + 1) * MINUTE);
  const row = await shop.orderWhen(p.orderNumber, (o) => o.payment_status === 'paid', 12_000);
  assert.equal(row.payment_status, 'paid', 'The pending check never found the captured payment');
  assert.ok(new Date(row.paid_at) - new Date(order.created_at) < 20 * MINUTE + 5000, 'Paid more than 20 minutes after it was placed');
  const asked = await world.rzp.calls({ method: 'GET', path: `/v1/orders/${p.gateway.gatewayOrderId}*` });
  assert.ok(asked.length >= 1, 'The gateway was never asked about the order');
});

test('S-26: a gateway that hangs or answers junk during the check changes nothing, and the next check still finds it', async () => {
  const shop = await addP4Shop(world);
  const { b, p } = await placed(shop);
  await b.pay(p, { back: false, webhook: false });
  await world.rzp.fault({ kind: 'timeout', times: 2, match: { method: 'GET', path: '/v1/orders/*' } });
  await world.rzp.fault({ kind: 'malformed', mode: 'wrong_shape', times: 2, match: { method: 'GET', path: '/v1/orders/*' } });
  await world.age((STORE_LIMITS.pendingCheckAfterMinutes + 1) * MINUTE);
  await world.quiet(2500);
  const mid = await shop.order(p.orderNumber);
  assert.ok(['unpaid', 'paid'].includes(mid.payment_status));
  assert.notEqual(mid.fulfilment_status, 'cancelled', 'A check that could not reach the gateway cancelled a paid order');
  await world.rzp.delete('/faults');
  const row = await shop.orderWhen(p.orderNumber, (o) => o.payment_status === 'paid', 15_000);
  assert.equal(row.payment_status, 'paid');
});

test('S-26: a payment for the wrong amount is held for review, never simply marked paid and shipped', async () => {
  const shop = await addP4Shop(world);
  const { b, p, order } = await placed(shop);
  for (const amount of [Number(order.total_paise) - 100]) {
    await world.rzp.post('/pay', { orderId: p.gateway.gatewayOrderId, amount, webhook: true });
  }
  const row = await shop.orderWhen(p.orderNumber, (o) => o.hold_reason === 'payment_mismatch');
  assert.equal(row.hold_reason, 'payment_mismatch', 'An underpaid order is not held');
  refused(await shop.send('POST', `/orders/${order.id}/shipments`, {}), 'Shipping a held order');
  refused(await shop.advance(order.id, 'packed'), 'Packing a held order');
  noCrash(await b.open(`/order/${p.token}`), 'The shopper’s page of a held order');
});

test('S-70: a Rs 1,000 managed capture sends Rs 1,000 minus the gateway fee to the seller, and the statement shows each part', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 100000, stock: 3 });
  const b = buyer(world, shop);
  const row = await b.buy({ lines: [line(product)] });
  const amount = Number(row.total_paise);
  assert.equal(Number(row.subtotal_paise), 100000);
  const payment = row.paid.payment;
  const [gwCall] = (await world.rzp.calls({ method: 'POST', path: '/v1/orders' })).filter((c) => c.body?.receipt === row.order_number);
  assert.ok(Array.isArray(gwCall.body.transfers) && gwCall.body.transfers.length === 1, 'The gateway order carries no Route transfer');
  assert.equal(gwCall.body.transfers[0].account, shop.linkedAccount, 'The transfer is not to the seller’s linked account');
  const state = await world.rzp.get('/state');
  const gwPayment = state.payments.find((x) => x.id === payment.id);
  const transfer = state.transfers.find((t) => t.source === payment.id);
  assert.ok(transfer, 'No transfer was made for the captured payment');
  assert.equal(transfer.recipient, shop.linkedAccount);
  assert.equal(transfer.amount, amount - gwPayment.fee, `The seller got ${transfer.amount} of ${amount} with a gateway fee of ${gwPayment.fee}: a commission was taken`);
  const [mine] = await shop.payments(row.id);
  assert.equal(Number(mine.fee_paise) + Number(mine.fee_tax_paise), gwPayment.fee, 'The fee on the payment is not the gateway’s, at cost');
  assert.equal(Number(mine.fee_tax_paise), gwPayment.tax);
  assert.equal(Number(mine.transfer_paise), transfer.amount);
  const lines = await shop.settlement(row.id);
  const kinds = Object.fromEntries(lines.map((l) => [l.kind, Number(l.amount_paise)]));
  assert.equal(kinds.sale, amount);
  assert.equal(Math.abs(kinds.gateway_fee ?? 0) + Math.abs(kinds.gateway_fee_tax ?? 0), gwPayment.fee, 'The statement’s fees are not the gateway’s at cost');
  assert.ok(lines.every((l) => ['sale', 'gateway_fee', 'gateway_fee_tax', 'transfer', 'shipping_charge'].includes(l.kind)), `Unexpected statement lines: ${lines.map((l) => l.kind)}`);
  const api = need(await shop.send('GET', `/settlements?orderId=${row.id}`), 200, 'The statement').json();
  const credit = sum(api.items, (l) => l.creditPaise);
  const debit = sum(api.items.filter((l) => l.kind !== 'transfer'), (l) => l.debitPaise);
  assert.equal(credit - debit, transfer.amount, 'The statement does not add up to what the seller is paid');
  for (const l of api.items) assert.ok(l.creditPaise === 0 || l.debitPaise === 0, 'A statement line is both a credit and a debit');
});

test('S-71: the gateway’s checkout and the success page carry the seller’s name, logo and colour, never the platform', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const logo = await shop.upload('#17694A', { width: 256, height: 256 });
  const kit = await shop.must('PATCH', '/brand-kit', { logoUrl: logo, colors: { primary: '#17694A' } });
  const primary = kit?.colors?.primary || '#17694A';
  const product = await shop.item({ name: 'Monstera' });
  const b = buyer(world, shop);
  const page = need(await b.open('/checkout'), 200, 'The checkout page');
  assertSellerBrandOnly(page, 'The checkout page');
  const p = await b.order({ lines: [line(product)] });
  assert.equal(p.gateway.display.name, 'Leafy Corner');
  assert.equal(p.gateway.display.color.toLowerCase(), primary.toLowerCase(), 'The gateway does not show the seller’s colour');
  assert.ok(p.gateway.display.image, 'No logo for the gateway’s checkout');
  noPlatformName('What the gateway is told to show', p.gateway.display);
  const img = new URL(p.gateway.display.image, `https://${shop.host}`);
  assert.equal(img.hostname, shop.host, 'The logo is not served from the seller’s own domain');
  const [gwCall] = (await world.rzp.calls({ method: 'POST', path: '/v1/orders' })).filter((c) => c.body?.receipt === p.orderNumber);
  noPlatformName('The gateway order’s notes', gwCall.body.notes ?? {});
  await b.pay(p);
  await shop.orderWhen(p.orderNumber, (o) => o.payment_status === 'paid');
  const done = need(await b.open(`/order/${p.token}`), 200, 'The success page');
  assertSellerBrandOnly(done, 'The success page');
  assert.ok(textOf(done.text).includes('Leafy Corner'));
  assert.ok(textOf(done.text).includes(p.orderNumber), 'The success page does not show the order');
  assert.equal(done.headers.location, undefined);
});

test('S-74: a failed payment opens the seller’s own failure page with a retry that reuses the order', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const { b, p, order } = await placed(shop);
  const failed = await world.rzp.post('/pay', { orderId: p.gateway.gatewayOrderId, outcome: 'failed', webhook: true });
  noCrash(await b.paymentReturn(p, failed), 'Coming back from a failed payment');
  await world.quiet(800);
  const page = need(await b.open(`/order/${p.token}`), 200, 'The failure page');
  assertSellerBrandOnly(page, 'The failure page');
  assert.match(textOf(page.text), /fail|didn.t go through|not complete|unsuccessful/i, 'The page does not say the payment failed');
  assert.match(page.text, /retry|try again/i, 'No retry button');
  assert.doesNotMatch(page.text, /razorpay\.com|api\.razorpay|cashfree\.com/i, 'The failure page sends the shopper to the gateway’s own page');
  const retry = ok(await b.api('POST', `/api/store/orders/${p.token}/retry`, {}), 'Retrying');
  assert.equal(retry.data.orderNumber, p.orderNumber, 'A retry made another order');
  assert.ok(retry.data.gateway?.gatewayOrderId);
  assert.equal((await shop.orders()).length, 1);
  await b.pay({ ...p, ...retry.data, token: retry.data.token ?? p.token });
  const row = await shop.orderWhen(p.orderNumber, (o) => o.payment_status === 'paid');
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.idempotency_key, order.idempotency_key, 'The retry changed the order’s idempotency key');
  const again = noCrash(await b.api('POST', `/api/store/orders/${p.token}/retry`, {}), 'Retrying a paid order');
  assert.ok(again.status >= 400 || again.data.next === 'done', 'A paid order offered another payment');
  refused(await buyer(world, await addP4Shop(world)).api('POST', `/api/store/orders/${p.token}/retry`, {}), 'Retrying this order on another store', 404);
});

test('S-72: switching to the seller’s own account applies to new orders; earlier ones keep settling through Route', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 100000, stock: 5 });
  const early = buyer(world, shop);
  const before = await early.order({ lines: [line(product)] });
  // The owner connects their own Razorpay account (Partner OAuth) and saves its key for checkout signatures.
  const { url } = need(await shop.send('POST', '/payment-account/connect'), 200, 'Starting the own-account connection').json();
  const state = new URL(url).searchParams.get('state');
  assert.ok(state, 'The connection link has no state');
  const own = await world.rzp.post('/oauth/code', { accountId: `acc_own${unique()}` });
  need(await shop.open(`${STORE_PROVIDER_PATHS.razorpayOauth.path}?code=${own.code}&state=${encodeURIComponent(state)}`), [200, 302, 303], 'The gateway coming back');
  need(await shop.send('PATCH', '/settings/payment', { razorpayKeyId: `rzp_test_own${unique().replace(/[^A-Za-z0-9]/g, '')}`, razorpayKeySecret: own.keySecret }), 200, 'Saving the own key');
  const account = need(await shop.send('PUT', '/payment-account/mode', { mode: 'own' }), 200, 'Switching to own mode').json();
  assert.equal(account.mode, 'own');
  assert.ok(!account.linkedAccount.includes(shop.linkedAccount.slice(4)), 'The linked account id is shown unmasked');
  const late = buyer(world, shop);
  const after = await late.order({ lines: [line(product)] });
  assert.equal((await shop.order(before.orderNumber)).gateway_mode, 'managed', 'The earlier order changed mode');
  assert.equal((await shop.order(after.orderNumber)).gateway_mode, 'own');
  const calls = await world.rzp.calls({ method: 'POST', path: '/v1/orders' });
  const platformAuth = `Basic ${Buffer.from(`${world.rzp.keyId}:${world.rzp.keySecret}`).toString('base64')}`;
  const newCall = calls.find((c) => c.body?.receipt === after.orderNumber);
  assert.notEqual(newCall.headers.authorization, platformAuth, 'The new order was made on the platform’s account');
  assert.equal(newCall.body.transfers, undefined, 'An own-account order carries a Route transfer');
  // The earlier order, paid now, still settles to the linked account.
  const paidEarly = await early.pay(before);
  await shop.orderWhen(before.orderNumber, (o) => o.payment_status === 'paid');
  const state1 = await world.rzp.get('/state');
  assert.ok(state1.transfers.some((t) => t.source === paidEarly.payment.id && t.recipient === shop.linkedAccount), 'The earlier order no longer settles through Route');
  const paidLate = await late.pay(after);
  await shop.orderWhen(after.orderNumber, (o) => o.payment_status === 'paid');
  assert.ok(!state1.transfers.some((t) => t.source === paidLate.payment.id) && !(await world.rzp.get('/state')).transfers.some((t) => t.source === paidLate.payment.id), 'An own-account payment was split');
  const [p2] = await shop.payments((await shop.order(after.orderNumber)).id);
  assert.equal(p2.mode, 'own');
  assert.equal(Number(p2.transfer_paise), 0);
});

test('S-73: a managed event naming A’s order but B’s linked account is stored, ignored and flagged', async () => {
  const a = await addP4Shop(world);
  const b = await addP4Shop(world);
  const atA = await placed(a);
  const atB = await placed(b);
  const paid = await atA.b.pay(atA.p, { back: false, webhook: false });
  const beforeA = (await a.securityEvents()).length;
  const payment = { ...paid.payment, order_id: atA.p.gateway.gatewayOrderId, notes: { linked_account: b.linkedAccount } };
  const envelope = (event, payload) => ({ entity: 'event', account_id: b.linkedAccount, event, contains: Object.keys(payload), payload, created_at: Math.floor(Date.now() / 1000) });
  const eventId = `evt_mismatch_${unique()}`;
  const res = await world.razorpayHook(envelope('payment.captured', { payment: { entity: payment } }), { eventId });
  assert.ok(res.status >= 200 && res.status < 300, `A correctly signed event was refused: ${res.status}`);
  const transferEvent = await world.razorpayHook(envelope('transfer.processed', { transfer: { entity: { id: `trf_x${unique()}`, source: paid.payment.id, recipient: b.linkedAccount, amount: 1000 } } }));
  assert.ok(transferEvent.status < 300);
  await world.quiet(2000);
  const [stored] = await world.sql(`SELECT * FROM provider_webhook_events WHERE provider = 'razorpay' AND event_id = $1`, [eventId]);
  assert.ok(stored, 'The event was not stored');
  assert.equal(stored.status, 'ignored');
  assert.equal(stored.security, true, 'The event was not flagged as a security event');
  assert.match(stored.outcome, /tenant_mismatch|mismatch/);
  assert.equal((await a.order(atA.p.orderNumber)).payment_status, 'unpaid', 'A’s order changed on an event naming B’s account');
  assert.equal((await b.order(atB.p.orderNumber)).payment_status, 'unpaid', 'B’s order changed');
  assert.equal((await a.payments(atA.order.id)).filter((x) => x.status === 'captured').length, 0);
  assert.equal((await b.settlement(atB.order.id)).length, 0);
  assert.ok((await a.securityEvents()).length > beforeA || stored.security);
});

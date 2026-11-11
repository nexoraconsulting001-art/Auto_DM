// Managed mode (PRD 9.6, 9.7): Bhava's Razorpay account with Route. Paying, the checkout's return, webhooks that come twice,
// late, out of order or forged, and the statement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorld } from './support.js';

const paidEvents = (shop, orderId) => shop.sql(`SELECT * FROM order_events WHERE tenant_id = $1 AND order_id = $2 AND type = 'order.paid'`, [shop.tenant.id, orderId]);

test('KYC through the linked-account flow turns online payment on; until then only cash on delivery shows', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.api('PATCH', '/payment-settings', { cod: true });
  let quote = await shop.run((p) => p.settings.checkout({ orderPaise: 50000, pincode: '411001' }));
  assert.deepEqual(quote.paymentModes.map((m) => [m.mode, m.available]), [['prepaid', false], ['cod', true], ['part_advance', false]]);
  assert.equal((await shop.api('GET', '/payment-settings')).json.onlineReady, false);

  await shop.payReady();
  const account = (await shop.api('GET', '/payment-account')).json;
  assert.equal(account.kycStatus, 'verified');
  assert.equal(account.mode, 'managed');
  assert.match(account.linkedAccount, /^acc_\.\.\.[A-Za-z0-9]{4}$/, 'the linked account is masked');
  assert.equal((await shop.api('GET', '/payment-settings')).json.onlineReady, true);
  quote = await shop.run((p) => p.settings.checkout({ orderPaise: 50000, pincode: '411001' }));
  assert.equal(quote.paymentModes.find((m) => m.mode === 'prepaid').available, true);
  // Asking again answers with the account it has.
  const again = await shop.api('POST', '/payment-account/linked', { legalName: 'Lamp House Traders', contactName: 'Meera Shah', email: 'x@seller.example', phone: '+919811100000', businessType: 'proprietorship' });
  assert.equal(again.status, 200);
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM payment_settings WHERE tenant_id = $1', [shop.tenant.id]))[0].n, 1);
});

test('S-19, S-71: the gateway order holds the exact amount, the order number and the seller brand; paid only after the server checks', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.repos.settings.update({ store_name: 'Lamp House' });
  await shop.payReady();
  const order = await shop.placeOrder({ totalPaise: 99900 });
  const placed = await shop.start(order.id);
  assert.equal(placed.done, false);
  assert.equal(placed.gateway.amountPaise, 99900);
  assert.equal(placed.gateway.display.name, 'Lamp House');
  assert.doesNotMatch(JSON.stringify(placed.gateway), /bhava/i);
  const state = await world.rzp.get('/state');
  const gatewayOrder = state.orders.find((o) => o.id === placed.gateway.gatewayOrderId);
  assert.equal(gatewayOrder.amount, 99900);
  assert.equal(gatewayOrder.receipt, order.order_number);
  // Starting again (a retry, a reload) answers with the same gateway order.
  assert.equal((await shop.start(order.id)).gateway.gatewayOrderId, placed.gateway.gatewayOrderId);

  // The shopper pays; no webhook arrives. Until the page's return is checked, nothing is paid.
  const paid = await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, webhook: false });
  assert.equal((await shop.order(order.id)).payment_status, 'unpaid');
  const res = await shop.store('POST', '/api/store/payments/return', { orderToken: order.public_token, gatewayOrderId: placed.gateway.gatewayOrderId, gatewayPaymentId: paid.payment.id, signature: paid.signature });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.status, 'paid');
  assert.equal(res.json.next, `/order/${order.public_token}`);
  const now = await shop.order(order.id);
  assert.equal(now.payment_status, 'paid');
  assert.equal(now.fulfilment_status, 'new');
  assert.equal(Number(now.paid_paise), 99900);
  const [payment] = await shop.payments(order.id);
  assert.equal(payment.status, 'captured');
  assert.equal(payment.method, 'upi');
});

test('S-20: a forged success callback changes nothing and is logged as a security event', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder();
  const placed = await shop.start(order.id);
  const paid = await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, outcome: 'failed', webhook: false });
  const forged = await shop.store('POST', '/api/store/payments/return', { orderToken: order.public_token, gatewayOrderId: placed.gateway.gatewayOrderId, gatewayPaymentId: paid.payment.id, signature: 'a'.repeat(64) });
  assert.equal(forged.status, 403);
  assert.doesNotMatch(forged.text, /bhava|razorpay/i);
  // A made-up payment with no signature at all is refused the same way.
  const madeUp = await shop.store('POST', '/api/store/payments/return', { orderToken: order.public_token, gatewayOrderId: placed.gateway.gatewayOrderId, gatewayPaymentId: 'pay_madeup0001', signature: '' });
  assert.equal(madeUp.status, 403);
  // A body with fields of its own, or a NUL in an id, is refused before anything is looked up.
  assert.equal((await shop.store('POST', '/api/store/payments/return', { orderToken: order.public_token, gatewayOrderId: 'order\u0000x', gatewayPaymentId: paid.payment.id, signature: '' })).status, 400);
  assert.equal((await shop.store('POST', '/api/store/payments/return', { orderToken: order.public_token, gatewayOrderId: placed.gateway.gatewayOrderId, gatewayPaymentId: paid.payment.id, signature: '', amountPaise: 1 })).status, 400);

  const now = await shop.order(order.id);
  assert.equal(now.payment_status, 'unpaid');
  assert.equal(now.fulfilment_status, 'pending');
  assert.equal((await shop.payments(order.id))[0].status, 'created');
  const audit = await shop.sql(`SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'payment.forged_callback'`, [shop.tenant.id]);
  assert.ok(audit.length >= 1);
  assert.equal((await shop.sql(`SELECT * FROM alerts WHERE tenant_id = $1 AND audience = 'ops' AND kind = 'payment.forged_callback'`, [shop.tenant.id])).length, 1);
});

test('S-23, S-24, S-25: three deliveries of one capture change it once; a late failure keeps it paid; a bad signature is 401', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder();
  const placed = await shop.start(order.id);
  const before = (await world.webhookRows()).length;
  await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, duplicates: 3 });
  await world.settle();
  const rows = (await world.webhookRows()).slice(before);
  assert.deepEqual(rows.map((r) => r.event_type).sort(), ['order.paid', 'payment.captured'], 'each event stored once however often it came');
  assert.equal((await paidEvents(shop, order.id)).length, 1, 'one status change');
  assert.equal((await shop.order(order.id)).payment_status, 'paid');

  // "Failed" for the same order, arriving after "captured".
  const late = await world.hook('payment.failed', { payment: { entity: { id: 'pay_late00000001', entity: 'payment', order_id: placed.gateway.gatewayOrderId, amount: 99900, currency: 'INR', status: 'failed', method: 'upi', error_code: 'BAD_REQUEST_ERROR' } } });
  assert.equal(late.status, 200);
  await world.settle();
  assert.equal((await shop.order(order.id)).payment_status, 'paid');
  assert.equal((await shop.payments(order.id))[0].status, 'captured');
  const lateRow = (await world.webhookRows()).at(-1);
  assert.equal(lateRow.status, 'ignored');
  assert.equal(lateRow.outcome, 'stale');

  // A bad signature, no signature, or a body that isn't the signed one: 401 and nothing stored.
  const count = (await world.webhookRows()).length;
  const payload = { payment: { entity: { id: 'pay_x', order_id: placed.gateway.gatewayOrderId, amount: 99900, currency: 'INR', status: 'captured' } } };
  assert.equal((await world.hook('payment.captured', payload, { signature: 'b'.repeat(64) })).status, 401);
  assert.equal((await world.hook('payment.captured', payload, { signature: null })).status, 401);
  assert.equal((await world.hook('payment.captured', payload, { secret: 'not-the-secret' })).status, 401);
  assert.equal((await world.hook('payment.captured', payload, { signature: 'é'.repeat(64) })).status, 401);
  assert.equal((await world.webhookRows()).length, count);
});

test('S-24: out of order, a failed attempt then a captured retry on the same gateway order ends paid', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder();
  const placed = await shop.start(order.id);
  await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, outcome: 'failed', hold: true });
  await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, outcome: 'captured', hold: true });
  await world.rzp.post('/webhooks/flush', { order: 'reverse' });
  await world.settle();
  const now = await shop.order(order.id);
  assert.equal(now.payment_status, 'paid');
  assert.equal((await shop.payments(order.id))[0].status, 'captured');
  assert.equal((await paidEvents(shop, order.id)).length, 1);
});

test('S-68, S-74: a failed advance leaves the order pending; the retry reuses the same gateway order and then pays', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.api('PATCH', '/payment-settings', { partAdvance: true, advanceKind: 'fixed', advanceValue: 10000 });
  await shop.payReady();
  const order = await shop.placeOrder({ mode: 'part_advance', totalPaise: 99900, advancePaise: 10000 });
  const placed = await shop.start(order.id);
  assert.equal(placed.gateway.amountPaise, 10000, 'S-21: the advance is what is charged online');
  const failed = await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, outcome: 'failed' });
  await world.settle();
  let now = await shop.order(order.id);
  assert.equal(now.fulfilment_status, 'pending');
  assert.equal(now.payment_status, 'unpaid');
  assert.equal((await shop.payments(order.id))[0].status, 'failed');
  const back = await shop.store('POST', '/api/store/payments/return', { orderToken: order.public_token, gatewayOrderId: placed.gateway.gatewayOrderId, gatewayPaymentId: failed.payment.id, signature: '' });
  assert.equal(back.status, 200);
  assert.equal(back.json.status, 'failed');

  const retry = await shop.store('POST', `/api/store/orders/${order.public_token}/retry`);
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.next, 'pay');
  assert.equal(retry.json.gateway.gatewayOrderId, placed.gateway.gatewayOrderId, 'the retry reuses the same order');
  await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId });
  await world.settle();
  now = await shop.order(order.id);
  assert.equal(now.payment_status, 'advance_paid');
  assert.equal(now.fulfilment_status, 'new');
  assert.equal(Number(now.balance_paise), 89900, 'S-21: the label collects the balance');
  assert.equal((await shop.payments(order.id)).length, 1);
  // Once paid, the retry says there is nothing more to pay.
  assert.equal((await shop.store('POST', `/api/store/orders/${order.public_token}/retry`)).json.next, 'done');
  assert.equal((await shop.store('POST', '/api/store/orders/not-a-real-token/retry')).status, 404);
});

test('an amount that does not match the order holds it for review and leaves it unpaid', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder({ totalPaise: 99900 });
  const placed = await shop.start(order.id);
  await world.rzp.post('/pay', { orderId: placed.gateway.gatewayOrderId, amount: 100 });
  await world.settle();
  const now = await shop.order(order.id);
  assert.equal(now.payment_status, 'unpaid');
  assert.equal(now.hold_reason, 'payment_mismatch');
  const [payment] = await shop.payments(order.id);
  assert.equal(payment.needs_review, true);
  assert.notEqual(payment.status, 'captured');
  assert.equal((await shop.alerts('payment.mismatch')).length, 2, 'the owner and ops are told, once each');
  assert.equal((await shop.sql(`SELECT * FROM reconciliation_gaps WHERE tenant_id = $1 AND kind = 'amount_mismatch'`, [shop.tenant.id])).length, 1);
});

test('S-70: a managed capture transfers the whole amount to the linked account; the statement shows the sale and the fee at cost', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 100000 });
  let [payment] = await shop.payments(order.id);
  assert.equal(Number(payment.transfer_paise), 100000);
  assert.equal(payment.transfer_status, 'created');
  assert.equal(Number(payment.fee_paise), 2000, 'the gateway fee, at cost');
  assert.equal(Number(payment.fee_tax_paise), 360, 'GST on the fee');
  const { transfers } = await world.rzp.get('/state');
  const transfer = transfers.find((x) => x.source === payment.gateway_payment_id);
  assert.equal(transfer.recipient, shop.linkedAccount);
  assert.equal(transfer.amount, 100000, 'Bhava keeps nothing');

  await world.rzp.post('/transfers/settle', { id: transfer.id });
  await world.settle();
  [payment] = await shop.payments(order.id);
  assert.equal(payment.transfer_status, 'processed');
  assert.equal(payment.transfer_id, transfer.id);
  const lines = await shop.lines(order.id);
  assert.deepEqual(lines.map((l) => [l.kind, Number(l.amount_paise)]), [['sale', 100000], ['gateway_fee', -2000], ['gateway_fee_tax', -360], ['transfer', 100000]]);
  const summary = (await shop.api('GET', '/settlements/summary')).json;
  assert.equal(summary.salesPaise, 100000);
  assert.equal(summary.gatewayFeesPaise, 2360);
  assert.equal(summary.payablePaise, 100000 - 2360);
  const list = (await shop.api('GET', `/settlements?orderId=${order.id}`)).json;
  assert.equal(list.items.length, 4);
  assert.equal(list.items.find((l) => l.kind === 'gateway_fee').debitPaise, 2000);
  const forOrder = (await shop.api('GET', `/orders/${order.id}/payments`)).json;
  assert.equal(forOrder.items[0].status, 'captured');
  assert.equal(forOrder.items[0].transferPaise, 100000);
});

test('a failed transfer holds the statement lines for review and tells the owner and ops', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 50000 });
  const [payment] = await shop.payments(order.id);
  const transfer = (await world.rzp.get('/state')).transfers.find((x) => x.source === payment.gateway_payment_id);
  await world.rzp.post('/transfers/fail', { id: transfer.id });
  await world.settle();
  const [after] = await shop.payments(order.id);
  assert.equal(after.transfer_status, 'failed');
  assert.equal(after.needs_review, true);
  assert.ok((await shop.lines(order.id)).every((l) => l.status === 'review'));
  assert.equal((await shop.alerts('payment.transfer_review')).length, 2);
  assert.equal((await shop.sql(`SELECT * FROM reconciliation_gaps WHERE tenant_id = $1 AND kind = 'transfer_failed'`, [shop.tenant.id])).length, 1);
  // A late "processed" after the failure is the transfer tried again, and it is recorded.
  await world.rzp.post('/transfers/settle', { id: transfer.id });
  await world.settle();
  assert.equal((await shop.payments(order.id))[0].transfer_status, 'processed');
});

test('S-73: a managed event naming one business’s order and another business’s linked account is stored, ignored and flagged', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const other = await world.secondBusiness();
  await other.payReady();
  const order = await shop.placeOrder();
  const placed = await shop.start(order.id);

  const res = await world.hook('payment.captured', {
    payment: { entity: { id: 'pay_mixed0000001', entity: 'payment', order_id: placed.gateway.gatewayOrderId, amount: 99900, currency: 'INR', status: 'captured', method: 'upi', notes: { account: other.linkedAccount } } },
  });
  assert.equal(res.status, 200);
  await world.settle();
  const row = (await world.webhookRows()).at(-1);
  assert.equal(row.status, 'ignored');
  assert.equal(row.outcome, 'tenant_mismatch');
  assert.equal(row.security, true);
  assert.equal((await shop.order(order.id)).payment_status, 'unpaid');
  assert.equal((await shop.payments(order.id))[0].status, 'created');
  assert.equal((await shop.sql(`SELECT * FROM alerts WHERE audience = 'ops' AND kind = 'payment.webhook_mismatch'`)).length, 1);

  // The envelope's account naming the other business is the same.
  await world.hook('payment.captured', { payment: { entity: { id: 'pay_mixed0000002', order_id: placed.gateway.gatewayOrderId, amount: 99900, currency: 'INR', status: 'captured' } } }, { accountId: other.linkedAccount });
  await world.settle();
  assert.equal((await world.webhookRows()).at(-1).outcome, 'tenant_mismatch');
  assert.equal((await shop.order(order.id)).payment_status, 'unpaid');

  // An event for an order nobody has is stored and ignored, with no alarm.
  await world.hook('payment.captured', { payment: { entity: { id: 'pay_nobody000001', order_id: 'order_nobody00001', amount: 100, currency: 'INR', status: 'captured' } } });
  await world.settle();
  const last = (await world.webhookRows()).at(-1);
  assert.equal(last.outcome, 'unknown_order');
  assert.equal(last.security, false);
});

test('no card, VPA, email or phone is kept from a payment event, and none reaches the logs', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder();
  const placed = await shop.start(order.id);
  const { setLogSink } = await import('../../../src/platform/log.js');
  const logged = [];
  setLogSink((line) => logged.push(String(line)));
  t.after(() => setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)));
  await world.hook('payment.captured', {
    payment: {
      entity: {
        id: 'pay_card00000001', entity: 'payment', order_id: placed.gateway.gatewayOrderId, amount: 99900, currency: 'INR', status: 'captured', method: 'card', fee: 2360, tax: 360,
        card: { id: 'card_1', last4: '4242', network: 'Visa', name: 'Asha Rao', number: '4111111111111111', expiry_month: 12 }, vpa: 'asha@upi', email: 'asha@example.com', contact: '+919876543210', bank: 'HDFC',
      },
    },
  });
  await world.settle();
  assert.equal((await shop.order(order.id)).payment_status, 'paid');
  const stored = JSON.stringify((await world.webhookRows()).at(-1).payload);
  for (const secret of ['4242', '4111111111111111', 'Asha', 'asha@upi', 'asha@example.com', '9876543210', 'Visa', 'HDFC']) {
    assert.equal(stored.includes(secret), false, `the stored event holds ${secret}`);
    assert.equal(logged.some((l) => l.includes(secret)), false, `the logs hold ${secret}`);
  }
  const [payment] = await shop.payments(order.id);
  assert.equal(payment.method, 'card');
  assert.doesNotMatch(JSON.stringify(payment), /4242|asha|9876543210/i);
});

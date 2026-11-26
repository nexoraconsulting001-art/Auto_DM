// Final attack on the money area: checkout bodies, refunds, Razorpay webhooks and the Route transfer, against the real app
// on a fresh database, with the Razorpay simulator (tools/sim) for the gateway. A failing test here is a bug, not a test to
// loosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openWorld, raw, refundBody } from '../../p4/payments/support.js';
import { hit, payments as payOptions, placeBody, product, q, storeApp } from '../../p4/checkout/support.js';
import { STORE_PROVIDER_PATHS, SIGNATURE_HEADERS } from '../../../src/contracts/store-routes.js';

const is4xx = (res) => res.status >= 400 && res.status < 500;

// ---------------------------------------------------------------------------------------------------------------------
// Checkout: hostile bodies
// ---------------------------------------------------------------------------------------------------------------------

test('atk-money: checkout and quote refuse hostile bodies with a 4xx, never a 5xx, and no order is made', async () => {
  const app = await storeApp();
  try {
    await payOptions(app, { cod: true });
    const lamp = await product(app, { pricePaise: 49900, stock: 50 });
    const base = () => placeBody(lamp.id);
    const line = (over) => ({ ...base(), lines: [{ productId: lamp.id, variantId: null, qty: 1, ...over }] });
    const bodies = [
      ['qty negative', line({ qty: -1 })],
      ['qty zero', line({ qty: 0 })],
      ['qty fraction', line({ qty: 1.5 })],
      ['qty past 32 bits', line({ qty: 2 ** 31 })],
      ['qty as text', line({ qty: '1' })],
      ['qty null', line({ qty: null })],
      ['productId zero', line({ productId: 0 })],
      ['productId negative', line({ productId: -5 })],
      ['productId past int4', line({ productId: 2 ** 31 })],
      ['productId past 2^53', line({ productId: 2 ** 53 + 2 })],
      ['productId as text', line({ productId: String(lamp.id) })],
      ['variantId past int4', line({ variantId: 2 ** 31 })],
      ['no lines', { ...base(), lines: [] }],
      ['too many lines', { ...base(), lines: Array.from({ length: 500 }, (_, i) => ({ productId: i + 1, variantId: null, qty: 1 })) }],
      ['a price in the body', { ...base(), totalPaise: 1 }],
      ['a unit price on the line', line({ unitPaise: 1 })],
      ['coupon with NUL', { ...base(), couponCode: '\u0000OFF' }],
      ['coupon too long', { ...base(), couponCode: 'A'.repeat(41) }],
      ['points negative', { ...base(), redeemPoints: -1 }],
      ['points fraction', { ...base(), redeemPoints: 1.5 }],
      ['points huge', { ...base(), redeemPoints: 2 ** 40 }],
      ['unknown way to pay', { ...base(), paymentMode: 'free' }],
      ['key with NUL', { ...base(), idempotencyKey: '\u0000abcdefgh' }],
      ['key with unicode', { ...base(), idempotencyKey: 'ключ-ключ-ключ' }],
      ['key too long', { ...base(), idempotencyKey: 'k'.repeat(81) }],
      ['name with NUL', { ...base(), address: { ...base().address, name: 'Asha\u0000Rao' } }],
      ['city with NUL', { ...base(), address: { ...base().address, city: 'Pu\u0000ne' } }],
      ['terms not accepted', { ...base(), acceptTerms: false }],
      ['body is an array', [base()]],
      ['body is a number', 42],
    ];
    for (const [name, body] of bodies) {
      for (const path of ['/api/store/checkout', '/api/store/checkout/quote']) {
        const res = await hit(app, path, { method: 'POST', body });
        assert.ok(is4xx(res), `${name} at ${path}: ${res.status} ${res.text.slice(0, 200)}`);
      }
    }
    // Bytes that are not JSON at all, a huge string and an integer past 2^53 written out in the JSON itself.
    const rawBodies = [
      ['broken JSON', '{"lines":[{"productId":'],
      ['qty past 2^53 in the text', JSON.stringify(base()).replace('"qty":1', '"qty":9007199254740993')],
      ['qty 1e400', JSON.stringify(base()).replace('"qty":1', '"qty":1e400')],
      ['5 MB of name', JSON.stringify({ ...base(), address: { ...base().address, name: 'x'.repeat(5 * 1024 * 1024) } })],
    ];
    for (const [name, text] of rawBodies) {
      const res = await hit(app, '/api/store/checkout', { method: 'POST', body: text, headers: { 'content-type': 'application/json' } });
      assert.ok(is4xx(res), `${name}: ${res.status} ${res.text.slice(0, 200)}`);
    }
    const [{ n }] = await q(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]);
    assert.equal(n, 0, 'no hostile body made an order');
    const [stock] = await q(app, 'SELECT stock, reserved FROM products WHERE tenant_id = $1 AND id = $2', [app.tenant.id, lamp.id]);
    assert.deepEqual([stock.stock, stock.reserved], [50, 0], 'and nothing was held');
  } finally {
    app.close();
  }
});

test('atk-money: one product split over many lines is one line; the per-line cap of 10 still holds and no order is made', async () => {
  const app = await storeApp();
  try {
    await payOptions(app, {});
    const lamp = await product(app, { pricePaise: 1000, stock: 100 });
    const lines = Array.from({ length: 11 }, () => ({ productId: lamp.id, variantId: null, qty: 1 }));
    const res = await hit(app, '/api/store/checkout', { method: 'POST', body: placeBody(lamp.id, { lines }) });
    assert.equal(res.status, 409, res.text);
    const many = Array.from({ length: 2 }, () => ({ productId: lamp.id, variantId: null, qty: 1000 }));
    const big = await hit(app, '/api/store/checkout', { method: 'POST', body: placeBody(lamp.id, { lines: many }) });
    assert.equal(big.status, 409, big.text);
    const [{ n }] = await q(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [app.tenant.id]);
    assert.equal(n, 0);
  } finally {
    app.close();
  }
});

test('atk-money: another business’s product id at this store is not sold, and no amount of it is charged', async () => {
  const app = await storeApp();
  try {
    await payOptions(app, {});
    const { otherStore } = await import('../../p4/checkout/support.js');
    const other = await otherStore(app, { slug: 'atk-other' });
    const theirs = await product(app, { pricePaise: 100, stock: 5, tenant: other.tenant });
    const res = await hit(app, '/api/store/checkout', { method: 'POST', body: placeBody(theirs.id) });
    assert.equal(res.status, 409, res.text);
    const quote = await hit(app, '/api/store/checkout/quote', { method: 'POST', body: { lines: [{ productId: theirs.id, variantId: null, qty: 1 }] } });
    assert.equal(quote.status, 200, quote.text);
    assert.equal(quote.json.lines[0].state, 'inactive');
    assert.equal(quote.json.lines[0].name, '', 'another business’s product name never shows');
    assert.equal(quote.json.totalPaise, 0);
  } finally {
    app.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Refunds: hostile input, races, faults
// ---------------------------------------------------------------------------------------------------------------------

test('atk-money: the refund API refuses hostile amounts, keys and ids with a 4xx and refunds nothing', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  const path = `/orders/${order.id}/refunds`;
  const bodies = [
    ['amount as text', refundBody('100')],
    ['amount fraction', refundBody(1.5)],
    ['amount negative', refundBody(-1)],
    ['amount zero', refundBody(0)],
    ['amount past 32 bits', refundBody(2 ** 31)],
    ['amount past 2^53', refundBody(2 ** 53 + 2)],
    ['amount 1e21', refundBody(1e21)],
    ['amount null', refundBody(null)],
    ['amount true', refundBody(true)],
    ['amount array', refundBody([100])],
    ['amount object', refundBody({ value: 100 })],
    ['no key', { amountPaise: 100, reason: 'x' }],
    ['key with NUL', refundBody(100, { idempotencyKey: 'rf-\u0000-12345678' })],
    ['key with unicode', refundBody(100, { idempotencyKey: 'возврат-12345678' })],
    ['key too long', refundBody(100, { idempotencyKey: 'r'.repeat(81) })],
    ['reason with NUL', refundBody(100, { reason: 'bad\u0000reason' })],
    ['reason too long', refundBody(100, { reason: 'r'.repeat(301) })],
    ['payment id past int4', refundBody(100, { paymentId: 2 ** 31 })],
    ['payment id negative', refundBody(100, { paymentId: -1 })],
    ['return id fraction', refundBody(100, { returnId: 1.5 })],
    ['more than was paid', refundBody(99901)],
  ];
  for (const [name, body] of bodies) {
    const res = await shop.api('POST', path, body);
    assert.ok(is4xx(res), `${name}: ${res.status} ${res.text.slice(0, 200)}`);
  }
  const textRes = await raw(world.port, `/api/v1${path}`, { method: 'POST', host: shop.host, body: '{"amountPaise": 100, "idempotencyKey": "rf-123456789", ', headers: { authorization: `Bearer ${shop.token}` } });
  assert.ok(is4xx(textRes), `broken JSON: ${textRes.status}`);
  const big = '9'.repeat(400);
  const bigRes = await raw(world.port, `/api/v1${path}`, { method: 'POST', host: shop.host, body: `{"amountPaise": ${big}, "idempotencyKey": "rf-123456789"}`, headers: { authorization: `Bearer ${shop.token}` } });
  assert.ok(is4xx(bigRes), `a 400-digit amount: ${bigRes.status}`);
  // An order id past int4 in the path, and one that is not a number.
  for (const id of ['2147483648', '-1', '1.5', 'abc', '9'.repeat(30)]) {
    const res = await shop.api('POST', `/orders/${id}/refunds`, refundBody(100));
    assert.ok(is4xx(res), `order id ${id}: ${res.status} ${res.text.slice(0, 120)}`);
  }
  assert.equal((await shop.refunds(order.id)).length, 0, 'no refund row');
  assert.equal((await world.rzp.get('/state')).refunds.length, 0, 'nothing refunded at the gateway');
});

test('atk-money: eight refunds at once while the gateway makes some then fails to answer never refund more than was captured, and our books match the gateway', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order, paid } = await shop.paidOrder({ totalPaise: 99900 });
  // The first three refunds take effect at the gateway, then the answer is lost.
  await world.rzp.post('/faults', { kind: 'partial', then: 'server_error', times: 3, match: { method: 'POST', path: '/v1/payments/*/refund' } });
  const answers = await Promise.all(Array.from({ length: 8 }, () => shop.api('POST', `/orders/${order.id}/refunds`, refundBody(15000))));
  for (const a of answers) assert.ok([201, 400].includes(a.status), `${a.status} ${a.text.slice(0, 200)}`);
  await world.rzp.delete('/faults');
  // Time passes; the sweep asks again with each refund's own key.
  await world.age(5 * 60_000);
  await shop.run((p) => p.refunds.sweep());
  await world.settle();

  const rows = await shop.refunds(order.id);
  const held = rows.filter((r) => r.status !== 'failed');
  const processed = rows.filter((r) => r.status === 'processed').reduce((s, r) => s + Number(r.amount_paise), 0);
  assert.ok(held.reduce((s, r) => s + Number(r.amount_paise), 0) <= 99900, 'never more than captured is held');
  assert.equal(held.length, 6, '6 x Rs 150 fit in Rs 999; the other two are refused');
  assert.equal(rows.filter((r) => r.status === 'requested').length, 0, 'the sweep finished every lost answer');
  const gateway = (await world.rzp.get('/state')).payments.find((p) => p.id === paid.payment.id);
  assert.equal(gateway.amount_refunded, processed, 'what the gateway refunded is what our books say');
  assert.equal((await world.rzp.get('/state')).refunds.filter((r) => r.payment_id === paid.payment.id).length, 6, 'one gateway refund per refund row');
  const after = await shop.order(order.id);
  assert.equal(Number(after.refunded_paise), processed);
  const [payment] = await shop.payments(order.id);
  assert.equal(Number(payment.refunded_paise), processed);
  const refundLines = (await shop.lines(order.id)).filter((l) => l.kind === 'refund');
  assert.equal(refundLines.reduce((s, l) => s + Number(l.amount_paise), 0), -processed, 'the statement shows each refund once');
});

test('atk-money: one refund key sent six times at once with different amounts makes one refund and no 5xx', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  const key = `rf-${crypto.randomUUID()}`;
  const amounts = [10000, 20000, 10000, 30000, 10000, 40000];
  const answers = await Promise.all(amounts.map((a) => shop.api('POST', `/orders/${order.id}/refunds`, refundBody(a, { idempotencyKey: key }))));
  for (const a of answers) assert.ok(a.status === 201 || a.status === 409, `${a.status} ${a.text.slice(0, 200)}`);
  const rows = await shop.refunds(order.id);
  assert.equal(rows.length, 1, 'one key, one refund');
  const winners = answers.filter((a) => a.status === 201);
  assert.ok(winners.every((a) => a.json.id === Number(rows[0].id) && a.json.amountPaise === Number(rows[0].amount_paise)), 'every 201 is that refund, at its own amount');
  assert.equal((await world.rzp.get('/state')).refunds.length, 1);
});

test('atk-money: a refund the gateway reports failed, replaced by a new refund, then reported processed late, is recorded as a gap at once and not retried for hours', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order, paid } = await shop.paidOrder({ totalPaise: 99900 });
  const gwPay = paid.payment.id;
  // The first refund's answer is lost.
  await world.rzp.post('/faults', { kind: 'timeout', times: 3, match: { method: 'POST', path: '/v1/payments/*/refund' } });
  const first = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(99900));
  assert.ok(first.status < 300, first.text);
  await world.rzp.delete('/faults');
  const entity = (status) => ({ refund: { entity: { id: 'rfnd_late0000000001', entity: 'refund', payment_id: gwPay, amount: 99900, currency: 'INR', status, notes: { refund: String(first.json.id) } } } });
  // The gateway says it failed: the amount is free again, and the owner refunds it once more.
  assert.equal((await world.hook('refund.failed', entity('failed'))).status, 200);
  await world.settle();
  assert.equal((await shop.refunds(order.id))[0].status, 'failed');
  const second = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(99900));
  assert.equal(second.status, 201, second.text);
  assert.equal(second.json.status, 'processed');
  // Then the gateway changes its mind about the first: the shopper has had the money twice.
  assert.equal((await world.hook('refund.processed', entity('processed'))).status, 200);
  await world.settle();

  const events = (await world.webhookRows()).filter((e) => e.event_type === 'refund.processed');
  assert.equal(events.length, 1);
  assert.notEqual(events[0].status, 'received', `the event is worked through, not left failing (last_error: ${events[0].last_error})`);
  assert.equal(events[0].last_error, '', 'no error');
  const gaps = await shop.sql(`SELECT kind, ref FROM reconciliation_gaps WHERE tenant_id = $1 AND kind = 'refund_mismatch'`, [shop.tenant.id]);
  assert.ok(gaps.length >= 1, 'ops are told the gateway refunded more than was captured');
  const after = await shop.order(order.id);
  assert.ok(Number(after.refunded_paise) <= 99900);
});

test('atk-money: a refund webhook naming our refund but a different amount does not record our amount as refunded', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order, paid } = await shop.paidOrder({ totalPaise: 99900 });
  await world.rzp.post('/faults', { kind: 'timeout', times: 3, match: { method: 'POST', path: '/v1/payments/*/refund' } });
  const asked = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(30000));
  assert.ok(asked.status < 300, asked.text);
  await world.rzp.delete('/faults');
  // The gateway says it refunded Rs 1 against our refund of Rs 300.
  const res = await world.hook('refund.processed', { refund: { entity: { id: 'rfnd_less0000000001', entity: 'refund', payment_id: paid.payment.id, amount: 100, currency: 'INR', status: 'processed', notes: { refund: String(asked.json.id) } } } });
  assert.equal(res.status, 200);
  await world.settle();
  const [row] = await shop.refunds(order.id);
  const after = await shop.order(order.id);
  const gaps = await shop.sql(`SELECT kind FROM reconciliation_gaps WHERE tenant_id = $1 AND kind IN ('refund_mismatch', 'amount_mismatch')`, [shop.tenant.id]);
  assert.ok(row.status !== 'processed' || gaps.length > 0, `the refund is processed for ${row.amount_paise} paise while the gateway gave back 100, with no gap for ops`);
  assert.ok(Number(after.refunded_paise) === 0 || Number(after.refunded_paise) === 100 || gaps.length > 0, `the order says ${after.refunded_paise} paise refunded`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Webhooks: forged, replayed, wrong currency
// ---------------------------------------------------------------------------------------------------------------------

test('atk-money: forged, oversized and malformed payment webhooks are refused and store nothing', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder({ totalPaise: 99900 });
  const placed = await shop.start(order.id);
  const payload = { payment: { entity: { id: 'pay_forged00000001', order_id: placed.gateway.gatewayOrderId, amount: 99900, currency: 'INR', status: 'captured', method: 'upi' } } };
  const path = STORE_PROVIDER_PATHS.razorpayManaged.path;
  const before = (await world.webhookRows()).length;
  const forged = [
    await world.hook('payment.captured', payload, { secret: 'not-the-secret' }),
    await world.hook('payment.captured', payload, { signature: null }),
    await world.hook('payment.captured', payload, { signature: '' }),
    await world.hook('payment.captured', payload, { signature: 'zz'.repeat(32) }),
    await world.hook('payment.captured', payload, { signature: crypto.createHmac('sha256', world.rzp.webhookSecret).update('{}').digest('hex') }),
  ];
  for (const res of forged) assert.equal(res.status, 401, res.text);
  // Signed correctly, but not an event.
  const sign = (body) => crypto.createHmac('sha256', world.rzp.webhookSecret).update(body).digest('hex');
  for (const body of ['not json', '[1,2,3]', '{"event": 5}', 'null', '"x"']) {
    const res = await raw(world.port, path, { method: 'POST', body, headers: { [SIGNATURE_HEADERS.razorpay]: sign(body), [SIGNATURE_HEADERS.razorpayEventId]: `evt_${crypto.randomBytes(4).toString('hex')}` } });
    assert.ok(is4xx(res), `${body}: ${res.status}`);
  }
  // 6 MB, signed: refused by size, never a 5xx.
  const huge = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: { ...payload, pad: 'x'.repeat(6 * 1024 * 1024) } });
  const big = await raw(world.port, path, { method: 'POST', body: huge, headers: { [SIGNATURE_HEADERS.razorpay]: sign(huge) } });
  assert.ok(is4xx(big), `6 MB: ${big.status}`);
  assert.equal((await world.webhookRows()).length, before, 'nothing refused was stored');
  await world.settle();
  const after = await shop.order(order.id);
  assert.equal(after.payment_status, 'unpaid');
});

test('atk-money: one capture replayed under five event ids at once pays the order once, writes one sale and sends one transfer', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order, paid } = await shop.paidOrder({ totalPaise: 99900 });
  const gp = paid.payment;
  const entity = { id: gp.id, entity: 'payment', order_id: gp.order_id, amount: gp.amount, currency: 'INR', status: 'captured', method: 'upi', fee: gp.fee, tax: gp.tax };
  const answers = await Promise.all(Array.from({ length: 5 }, () => world.hook('payment.captured', { payment: { entity } })));
  for (const a of answers) assert.equal(a.status, 200);
  // And the same while the transfer call is slow: the replay must not send a second one.
  await Promise.all([world.settle(), world.settle()]);
  const after = await shop.order(order.id);
  assert.equal(after.payment_status, 'paid');
  assert.equal(Number(after.paid_paise), 99900);
  const lines = await shop.lines(order.id);
  assert.equal(lines.filter((l) => l.kind === 'sale').length, 1);
  assert.equal(lines.filter((l) => l.kind === 'gateway_fee').length, gp.fee ? 1 : 0);
  const transfers = (await world.rzp.get('/state')).transfers.filter((x) => x.source === gp.id);
  assert.equal(transfers.length, 1, 'the seller is paid once');
  const [payment] = await shop.payments(order.id);
  assert.equal(payment.needs_review, false, 'the same payment again is not a duplicate');
});

test('atk-money: a capture in another currency, or below the order amount, holds the order unpaid', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  for (const [currency, amount] of [['USD', 99900], ['INR', 99899], ['INR', 0]]) {
    const order = await shop.placeOrder({ totalPaise: 99900 });
    const placed = await shop.start(order.id);
    const res = await world.hook('payment.captured', { payment: { entity: { id: `pay_cur${crypto.randomBytes(6).toString('hex')}`, order_id: placed.gateway.gatewayOrderId, amount, currency, status: 'captured', method: 'upi' } } });
    assert.equal(res.status, 200);
    await world.settle();
    const after = await shop.order(order.id);
    assert.equal(after.payment_status, 'unpaid', `${currency} ${amount}`);
    assert.equal(after.hold_reason, 'payment_mismatch', `${currency} ${amount}`);
    assert.equal(Number(after.paid_paise), 0);
    const transfers = (await world.rzp.get('/state')).transfers.filter((x) => x.notes?.payment);
    assert.equal(transfers.length, 0, 'nothing is paid out on a mismatch');
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// A shopper charged twice on one gateway order
// ---------------------------------------------------------------------------------------------------------------------

test('atk-money: a shopper charged twice on one gateway order can have the extra charge refunded, without touching the sale', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const order = await shop.placeOrder({ totalPaise: 99900 });
  const placed = await shop.start(order.id);
  const G = placed.gateway.gatewayOrderId;
  // Two attempts on one gateway order: the first is authorised, the second captured; then the first is captured too.
  const first = await world.rzp.post('/pay', { orderId: G, outcome: 'authorized' });
  await world.settle();
  const second = await world.rzp.post('/pay', { orderId: G, outcome: 'captured' });
  await world.settle();
  assert.equal((await shop.order(order.id)).payment_status, 'paid');
  await world.rzp.post('/capture', { paymentId: first.payment.id });
  await world.settle();
  const alerts = await shop.alerts('payment.duplicate_capture');
  assert.ok(alerts.length >= 1, 'the owner is told the shopper paid twice');
  const invoicesBefore = await shop.sql(`SELECT doc_type FROM invoices WHERE tenant_id = $1 AND order_id = $2`, [shop.tenant.id, order.id]);

  // The owner does what the alert says: refund the extra payment, from the order.
  const res = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(99900, { reason: 'Charged twice' }));
  assert.equal(res.status, 201, res.text);
  await world.settle();
  const state = await world.rzp.get('/state');
  const extra = state.payments.find((p) => p.id === first.payment.id);
  const sale = state.payments.find((p) => p.id === second.payment.id);
  const transfer = state.transfers.find((x) => x.source === second.payment.id);
  const docs = await shop.sql('SELECT doc_type, total_paise FROM invoices WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [shop.tenant.id, order.id]);
  const after = await shop.order(order.id);
  const problems = [];
  if (extra.amount_refunded !== 99900) problems.push(`the extra charge was given back ${extra.amount_refunded} of 99900 paise`);
  if (sale.amount_refunded !== 0) problems.push(`the payment for the goods was refunded ${sale.amount_refunded} paise`);
  if ((transfer?.amount_reversed ?? 0) !== 0) problems.push(`the seller's payout for the sale was reversed by ${transfer.amount_reversed} paise`);
  const notes = docs.filter((d) => d.doc_type === 'credit_note');
  if (notes.length) problems.push(`a GST credit note of ${notes.map((n) => n.total_paise)} paise was issued against the sale (documents before: ${invoicesBefore.map((i) => i.doc_type)})`);
  if (after.payment_status !== 'paid') problems.push(`the order now says ${after.payment_status}`);
  assert.deepEqual(problems, []);
});

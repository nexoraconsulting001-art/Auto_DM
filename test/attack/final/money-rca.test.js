// Final money attack, root-cause follow-ups: the other paths with the same cause as atk-money-1..4, each held by a test.
//   atk-money-1: the renewals job queues an add-on line while the owner's purchase is still queuing it.
//   atk-money-2: a second attempt's own payment row captured after the sale (not only a second payment on the sale's row).
//   atk-money-4: the gateway's own answer to our refund (not a webhook) names another amount.
// Real app, real HTTP, the Razorpay simulator for the gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { item, openBilling } from '../../p7/billing/support.js';
import { openWorld, refundBody } from '../../p4/payments/support.js';

/** Straight to the simulator's API with Bhava's own keys: what the gateway itself did, not something Bhava asked for. */
async function gateway(world, method, path, body, headers = {}) {
  const res = await fetch(`${world.rzp.url}${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${world.rzp.keyId}:${world.rzp.keySecret}`).toString('base64')}`, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  assert.ok(res.ok, JSON.stringify(json));
  return json;
}

test('atk-money rca: the renewals job running while one add-on request is sent four times at once still queues one provider line', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const body = item('extra_seat', { quantity: 2 });
  const [answers] = await Promise.all([
    Promise.all(Array.from({ length: 4 }, () => shop.api('POST', '/billing/items', body))),
    w.billing.renewals(),
    w.billing.renewals(),
  ]);
  for (const a of answers) assert.ok(a.status === 201 || a.status === 200, `${a.status} ${a.text.slice(0, 200)}`);
  await w.billing.renewals();
  const s = await shop.sub();
  const queued = (await w.rzp.get('/state')).addons.filter((a) => a.subscription_id === s.provider_subscription_id);
  const [row] = await w.sql(`SELECT provider_item_id FROM subscription_items WHERE tenant_id = $1 AND addon_code = 'extra_seat'`, [shop.tenant.id]);
  assert.equal(queued.length, 1, 'one line at the provider');
  assert.equal(row.provider_item_id, queued[0].id, 'and it is the line Bhava knows');
  const out = await shop.charge();
  const invoice = (await shop.invoices()).at(-1);
  assert.equal(out.payment.amount, Number(invoice.total_paise), 'the seller is charged what the invoice says');
});

test('atk-money rca: a second attempt captured after the sale is kept as a duplicate: never paid out, never a sale, and refunded first', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order, paid } = await shop.paidOrder({ totalPaise: 99900 });
  const [sale] = await shop.sql('SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2', [shop.tenant.id, order.id]);
  assert.equal(sale.status, 'captured');
  // Another attempt for the same order on its own gateway order (an older checkout the shopper still had open).
  const other = await gateway(world, 'POST', '/v1/orders', { amount: 99900, currency: 'INR', receipt: order.order_number, notes: { account: sale.account_ref } });
  await shop.sql(
    `INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, account_ref, gateway_order_id, amount_paise) VALUES ($1, $2, 'full', 'razorpay', 'managed', $3, $4, 99900)`,
    [shop.tenant.id, order.id, sale.account_ref, other.id],
  );
  const extra = await world.rzp.post('/pay', { orderId: other.id, outcome: 'captured' });
  await world.settle();
  // The same capture told again changes nothing more.
  await world.hook('payment.captured', { payment: { entity: { ...extra.payment, status: 'captured' } } });
  await world.settle();

  const rows = await shop.sql('SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [shop.tenant.id, order.id]);
  const dup = rows.find((r) => r.gateway_payment_id === extra.payment.id);
  assert.equal(rows.length, 2);
  assert.equal(dup?.purpose, 'duplicate', 'the extra capture is kept as a duplicate');
  assert.equal(dup.status, 'captured');
  assert.equal(dup.needs_review, true);
  assert.equal(Number((await shop.order(order.id)).paid_paise), 99900, 'the order was paid once');
  const saleLines = await shop.sql(`SELECT ref FROM settlement_lines WHERE tenant_id = $1 AND order_id = $2 AND kind = 'sale'`, [shop.tenant.id, order.id]);
  assert.deepEqual(saleLines.map((l) => l.ref), [`payment:${sale.id}`], 'one sale on the seller statement');
  const state = await world.rzp.get('/state');
  assert.equal(state.transfers.filter((x) => x.source === extra.payment.id).length, 0, 'the extra money is never paid out to the seller');
  assert.ok((await shop.alerts('payment.duplicate_capture')).length >= 1, 'the owner is told');
  const gaps = await shop.sql(`SELECT details FROM reconciliation_gaps WHERE tenant_id = $1 AND kind = 'amount_mismatch' AND ref = $2`, [shop.tenant.id, `payment:${dup.id}`]);
  assert.equal(gaps[0]?.details?.gatewayPaymentId, extra.payment.id, 'the gap names the extra gateway payment');

  const res = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(99900, { reason: 'Charged twice' }));
  assert.equal(res.status, 201, res.text);
  await world.settle();
  const after = await world.rzp.get('/state');
  assert.equal(after.payments.find((p) => p.id === extra.payment.id).amount_refunded, 99900, 'the extra payment is given back');
  assert.equal(after.payments.find((p) => p.id === paid.payment.id).amount_refunded, 0, 'the sale is not refunded');
  assert.equal(after.transfers.find((x) => x.source === paid.payment.id)?.amount_reversed ?? 0, 0, 'the seller keeps the payout');
  const notes = await shop.sql(`SELECT id FROM invoices WHERE tenant_id = $1 AND order_id = $2 AND doc_type = 'credit_note'`, [shop.tenant.id, order.id]);
  assert.equal(notes.length, 0, 'no GST credit note');
  const o = await shop.order(order.id);
  assert.equal(o.payment_status, 'paid');
  assert.equal(Number(o.refunded_paise), 0);
});

test('atk-money rca: the gateway answering our refund with another amount is held for ops, never recorded as ours', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order, paid } = await shop.paidOrder({ totalPaise: 99900 });
  await world.rzp.post('/faults', { kind: 'timeout', times: 3, match: { method: 'POST', path: '/v1/payments/*/refund' } });
  const asked = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(30000));
  assert.ok(asked.status < 300, asked.text);
  await world.rzp.delete('/faults');
  // The gateway made a refund under our key, but for Rs 1: asked again with the key, it answers that one.
  await gateway(world, 'POST', `/v1/payments/${paid.payment.id}/refund`, { amount: 100 }, { 'x-refund-idempotency': `t${shop.tenant.id}-r${asked.json.id}` });
  for (let i = 0; i < 2; i++) await shop.run((p) => p.refunds.submit(asked.json.id, 'job:refund-check'));
  await world.settle();
  const [row] = await shop.refunds(order.id);
  assert.equal(row.status, 'requested', 'not recorded as refunded');
  assert.equal(row.error_code, 'gateway_mismatch', 'held for a person, out of the sweep');
  assert.match(String(row.gateway_refund_id), /^rfnd_/, 'the gateway refund is kept with it');
  assert.equal(Number((await shop.order(order.id)).refunded_paise), 0);
  const gaps = await shop.sql(`SELECT details FROM reconciliation_gaps WHERE tenant_id = $1 AND kind = 'refund_mismatch'`, [shop.tenant.id]);
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0].details.oursPaise, gaps[0].details.gatewayPaise], [30000, 100]);
  // Still holding its amount: no more than the rest can be refunded meanwhile.
  const more = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(99900 - 30000 + 1));
  assert.ok(more.status >= 400 && more.status < 500, more.text);
});

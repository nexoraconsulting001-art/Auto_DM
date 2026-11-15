// The monthly settlement statement and pass-through charges (PRD 5.12: F-83, F-84, F-113, F-114), reconciled against the
// Razorpay simulator's settlement report and the courier's charges.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRazorpay } from '../../../src/adapters/razorpay/index.js';
import { SettlementStatement } from '../../../src/contracts/api/billing.js';
import { page } from '../../../src/contracts/api/common.js';
import { createQueue } from '../../../src/platform/queue.js';
import { createStorage } from '../../../src/platform/storage.js';
import { withTenant } from '../../../src/tenancy.js';
import { statementsApi } from '../../../src/modules/usage/index.js';
import { USAGE_JOBS, createUsage } from '../../../src/modules/usage/service.js';
import { createRazorpay as createRazorpaySim } from '../../../tools/sim/razorpay/index.mjs';
import { setup } from '../../helpers.js';

const MONTH = '2026-11-01';
const SOLD_AT = '2026-11-12T06:00:00.000Z';
const DEC_2 = Date.parse('2026-12-02T06:00:00.000Z');
const DEC_5 = Date.parse('2026-12-05T06:00:00.000Z');
const SHOPPER = { name: 'Asha Rao', phone: '+919876543210' };
let seq = 0;
let fixture = null;
after(() => fixture?.close());

/** One database, the Razorpay simulator, and three businesses: A and B on Bhava's default paths, C on its own providers. */
async function world() {
  if (fixture) return fixture;
  const base = await setup();
  const sim = createRazorpaySim();
  await sim.start();
  await sim.post('/clock', { now: Date.parse(SOLD_AT), freeze: true });
  const razorpay = createRazorpay({ razorpayBaseUrl: sim.url, razorpayKeyId: sim.keyId, razorpayKeySecret: sim.keySecret }, { env: {} });
  const clock = { t: DEC_2, now: () => clock.t };
  const storage = createStorage({ storageDriver: 'memory' });
  const queue = createQueue({ queueDriver: 'pg' }, { db: base.db });
  const service = createUsage({ db: base.db, config: { usageNow: clock.now }, providers: { razorpay }, platform: { storage, queue } });

  async function business(name, { payment = 'managed', shipping = 'managed', chargeBilling = 'payout' } = {}) {
    const tenant = await base.platform.tenants.create({ slug: `statement-${process.pid}-${++seq}`, name });
    const q = (sql, params) => withTenant(tenant, () => base.db.query(sql, params));
    let account = null;
    if (payment === 'managed') {
      const linked = await razorpay.route.createLinkedAccount({ email: `t${tenant.id}@example.test`, phone: '9000000001', legalName: name, businessType: 'proprietorship', contactName: 'Owner', reference: `t${tenant.id}` });
      await sim.post('/accounts/kyc', { id: linked.id, status: 'activated' });
      account = { linkedAccountId: linked.id };
    }
    await q('INSERT INTO payment_settings (tenant_id, mode, linked_account_id) VALUES ($1, $2, $3)', [tenant.id, payment, account?.linkedAccountId ?? null]);
    await q('INSERT INTO shipping_settings (tenant_id, mode, charge_billing) VALUES ($1, $2, $3)', [tenant.id, shipping, chargeBilling]);
    const b = { tenant, account, q, inBusiness: (fn) => withTenant(tenant, fn), paid: [], n: 0 };

    b.order = async (totalPaise) => {
      const [row] = await q(
        `INSERT INTO orders (tenant_id, order_number, public_token, customer_name, phone, address, city, state, pincode, subtotal_paise, shipping_paise, total_paise, status)
         VALUES ($1, $2, $3, $4, $5, '12 Lake Road', 'Pune', 'MH', '411001', $6, 0, $6, 'paid') RETURNING id, order_number`,
        [tenant.id, `${name.slice(0, 1)}${1000 + ++b.n}`, crypto.randomUUID(), SHOPPER.name, SHOPPER.phone, totalPaise],
      );
      return row;
    };
    const line = (orderId, kind, amountPaise, ref, at = SOLD_AT) => q('INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref, occurred_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)', [tenant.id, orderId, kind, amountPaise, ref, at]);
    b.line = line;

    /** Paid on Bhava's default path: the gateway order, the payment and its Route transfer in the simulator; ours as Phase 4 writes them. */
    b.sell = async (amount) => {
      const order = await b.order(amount);
      const gateway = await razorpay.route.createOrder(account, { amountPaise: amount, receipt: `R${tenant.id}-${b.n}` });
      const payment = (await sim.post('/pay', { orderId: gateway.id, webhook: false })).payment;
      // Phase 4 sends the seller the sale less the gateway fee, after capture (S-70, F-113).
      await razorpay.route.transferPayment(account, payment.id, { amountPaise: amount - payment.fee });
      b.paid.push({ order, amount, gatewayOrderId: gateway.id, payment });
    };
    /** Our rows for every sale so far, once the simulator has given each its transfer, settled. */
    b.book = async ({ settle = true } = {}) => {
      const transfers = (await sim.get('/state')).transfers;
      for (const sale of b.paid.filter((s) => !s.paymentId)) {
        const transfer = transfers.find((x) => x.source === sale.payment.id);
        if (settle) await sim.post('/transfers/settle', { id: transfer.id });
        const [p] = await q(
          `INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, account_ref, gateway_order_id, gateway_payment_id, amount_paise, status, method, fee_paise, fee_tax_paise, transfer_id, transfer_status, transfer_paise, captured_at)
           VALUES ($1, $2, 'full', 'razorpay', 'managed', $3, $4, $5, $6, 'captured', 'upi', $7, $8, $9, 'processed', $11, $10::timestamptz) RETURNING id`,
          [tenant.id, sale.order.id, account.linkedAccountId, sale.gatewayOrderId, sale.payment.id, sale.amount, sale.payment.fee - sale.payment.tax, sale.payment.tax, transfer.id, SOLD_AT, transfer.amount],
        );
        Object.assign(sale, { paymentId: Number(p.id), transferId: transfer.id, fee: sale.payment.fee });
        const ref = `payment:${p.id}`;
        await line(sale.order.id, 'sale', sale.amount, ref);
        await line(sale.order.id, 'gateway_fee', -(sale.payment.fee - sale.payment.tax), ref);
        await line(sale.order.id, 'gateway_fee_tax', -sale.payment.tax, ref);
        await line(sale.order.id, 'transfer', transfer.amount, ref);
      }
    };
    /** A full refund through the gateway, which takes the payout back from the seller's account. */
    b.refund = async (sale) => {
      const result = await razorpay.route.refund(account, sale.payment.id, { amountPaise: sale.amount, idempotencyKey: `refund-${sale.paymentId}-x` });
      const [r] = await q(
        `INSERT INTO refunds (tenant_id, order_id, payment_id, amount_paise, status, method, gateway_refund_id, reversal_status, reversal_paise, reversal_id, requested_by, idempotency_key, processed_at)
         VALUES ($1, $2, $3, $4, 'processed', 'gateway', $5, 'reversed', $6, $7, 'user:1', $8, $9::timestamptz) RETURNING id`,
        [tenant.id, sale.order.id, sale.paymentId, sale.amount, result.id, result.reversal.amountPaise, result.reversal.id, `refund-${sale.paymentId}-key`, SOLD_AT],
      );
      await line(sale.order.id, 'refund', -sale.amount, `refund:${r.id}`);
      await line(sale.order.id, 'transfer_reversal', -result.reversal.amountPaise, `refund:${r.id}`);
      return result.reversal.amountPaise;
    };
    /** A parcel on a courier account: on Bhava's, the charge also goes on the statement (Phase 4 writes that line). */
    b.ship = async (orderId, chargePaise, { mode = 'managed', withLine = true } = {}) => {
      const [s] = await q(
        `INSERT INTO shipments (tenant_id, order_id, mode, weight_grams, length_cm, breadth_cm, height_cm, charge_paise, created_at) VALUES ($1, $2, $3, 500, 10, 10, 10, $4, $5::timestamptz) RETURNING id`,
        [tenant.id, orderId, mode, chargePaise, SOLD_AT],
      );
      if (mode === 'managed' && withLine) await line(orderId, 'shipping_charge', -chargePaise, `shipment:${s.id}`);
      return Number(s.id);
    };
    return b;
  }

  const a = await business('Asha Sarees');
  const b = await business('Bindu Bakes', { chargeBilling: 'monthly' });
  const c = await business('Chai Corner', { payment: 'own', shipping: 'own' });
  let closed = false;
  const close = async () => {
    if (!closed) await sim.close();
    closed = true;
  };
  fixture = { base, sim, razorpay, clock, storage, queue, service, a, b, c, close };
  return fixture;
}

test('F-83, F-113: a month of 120 orders, 5 refunds and 80 shipments: every line type, no commission, and payouts equal to the settlement report', async () => {
  const f = await world();
  const { a, service } = f;
  for (let i = 0; i < 120; i++) await a.sell(10000 + (i % 9) * 2500);
  await a.book();
  let reversed = 0;
  for (const sale of a.paid.slice(0, 5)) reversed += await a.refund(sale);
  for (const sale of a.paid.slice(0, 80)) await a.ship(sale.order.id, 4900);
  // A payment on the seller's own gateway account is not money through Bhava, and does not appear.
  const own = await a.order(77700);
  await a.q(`INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, amount_paise, status, captured_at) VALUES ($1, $2, 'full', 'razorpay', 'own', 77700, 'captured', $3::timestamptz) RETURNING id`, [a.tenant.id, own.id, SOLD_AT])
    .then(([p]) => a.line(own.id, 'sale', 77700, `payment:${p.id}`));

  const row = await a.inBusiness(() => service.statements.run(MONTH, { at: new Date(DEC_2) }));
  const sales = a.paid.reduce((sum, s) => sum + s.amount, 0);
  const fees = a.paid.reduce((sum, s) => sum + s.fee, 0);
  const refunds = a.paid.slice(0, 5).reduce((sum, s) => sum + s.amount, 0);
  const statement = (await a.inBusiness(() => service.statements.list({}))).items[0];
  assert.equal(statement.month, MONTH);
  assert.deepEqual(statement.counts, { orders: 120, refunds: 5, shipments: 80 });
  assert.equal(statement.salesPaise, sales, 'F-113: the sales in full');
  assert.equal(statement.gatewayFeesPaise, fees, 'the gateway fee and its GST, at cost');
  assert.equal(statement.refundsPaise, refunds);
  assert.equal(statement.shippingPaise, 80 * 4900);
  assert.equal(statement.commissionPaise, 0, 'Bhava takes no share');
  assert.equal(statement.payoutsPaise, sales - fees - reversed, 'F-113: each payout is the sale less the gateway fee');
  assert.equal(statement.payouts.length, 120);
  assert.ok(statement.payouts.every((p) => /^trf_/.test(p.transferId)), 'each payout with its Route transfer reference');
  const closing = sales - refunds - fees - 80 * 4900 - (sales - fees - reversed);
  assert.deepEqual(statement.closingBalance, { amountPaise: Math.abs(closing), owedTo: closing >= 0 ? 'business' : 'bhava' });

  // Reconciled to Razorpay's settlement report for this business and month, and to the courier's charges.
  assert.equal(statement.reconciliation, 'matched', JSON.stringify(row.reconciliation_details?.differences?.slice(0, 3)));
  const report = await f.razorpay.route.settlementReport(a.account, { year: 2026, month: 11 });
  const reportPayouts = report.filter((r) => r.kind === 'transfer' && r.settled).reduce((s, r) => s + r.amountPaise, 0) - report.filter((r) => r.kind === 'reversal').reduce((s, r) => s + r.amountPaise, 0);
  assert.equal(statement.payoutsPaise, reportPayouts, 'the payout total is the settlement report\'s');
  assert.equal(row.reconciliation_details.payments.reportPayoutsPaise, reportPayouts);
  assert.ok(statement.sentAt, 'a statement that matches is sent at once');
  page(SettlementStatement).parse(await a.inBusiness(() => service.statements.list({})));

  // Both files, through the storage module, with every line and no shopper in them.
  assert.ok(statement.hasPdf && statement.hasCsv);
  const csv = (await a.inBusiness(() => service.statements.file(statement.id, 'csv'))).buffer.toString();
  for (const label of ['Sale', 'Gateway fee', 'GST on gateway fee', 'Refund', 'Payout', 'Payout reversed', 'Shipping charge', 'Commission,0', 'Closing balance']) assert.ok(csv.includes(label), label);
  assert.equal((csv.match(/\r\n\d+,Sale,/g) ?? []).length, 121, 'every sale line is listed, the own-account one marked as not in the statement');
  assert.match(csv, /\r\n\d+,Sale,A\d+,payment:\d+,77700,[^,]+,no\r\n/);
  const pdf = (await a.inBusiness(() => service.statements.file(statement.id, 'pdf'))).buffer;
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  for (const file of [csv, pdf.toString('latin1')]) {
    assert.ok(!file.includes(SHOPPER.name) && !file.includes(SHOPPER.phone.slice(3)), 'no shopper name or number in the files');
  }

  // Once sent, the figures are frozen: a late line changes nothing.
  await a.line(a.paid[6].order.id, 'adjustment', 100, 'late:1');
  const again = await a.inBusiness(() => service.statements.run(MONTH, { at: new Date(DEC_5) }));
  assert.equal(Number(again.sales_paise), sales);
  assert.equal(again.reconciliation, 'matched');
});

test('a difference from the report is shown, never hidden: the statement says mismatch, waits for its day, and keeps our figures', async () => {
  const f = await world();
  const { b, service } = f;
  for (const amount of [20000, 30000, 40000]) await b.sell(amount);
  await b.book();
  // Our side records a payout the gateway has not settled, and a courier charge has no line.
  await b.sell(5000);
  await b.book({ settle: false });
  await b.ship(b.paid[0].order.id, 6100);
  await b.ship(b.paid[1].order.id, 5200, { withLine: false });

  let row = await b.inBusiness(() => service.statements.run(MONTH, { at: new Date(DEC_2) }));
  assert.equal(row.reconciliation, 'mismatch');
  const kinds = row.reconciliation_details.differences.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['payout_not_in_report', 'payout_total', 'shipping_line_missing']);
  const total = row.reconciliation_details.differences.find((d) => d.kind === 'payout_total');
  const feeOf = (list) => list.reduce((s, sale) => s + sale.fee, 0);
  assert.deepEqual([total.ourPaise, total.reportPaise], [95000 - feeOf(b.paid), 90000 - feeOf(b.paid.slice(0, 3))]);
  assert.equal(Number(row.payouts_paise), 95000 - feeOf(b.paid), 'our figure, not adjusted to agree');
  assert.equal(Number(row.shipping_paise), 0, 'its courier charges are billed on the invoice, so the payout does not take them');
  assert.equal(row.sent_at, null, 'not sent before the statement day');
  const csv = (await b.inBusiness(() => service.statements.file(Number(row.id), 'csv'))).buffer.toString();
  assert.match(csv, /Reconciliation,mismatch/);
  assert.match(csv, new RegExp(`Difference,payout_total,,${95000 - feeOf(b.paid)},${90000 - feeOf(b.paid.slice(0, 3))}`));
  assert.match(csv, /Shipping charge,B\d+,shipment:\d+,-6100,[^,]+,billed on invoice/);

  row = await b.inBusiness(() => service.statements.run(MONTH, { at: new Date(DEC_5) }));
  assert.ok(row.sent_at, 'sent on the statement day, differences and all');
  assert.equal(row.reconciliation, 'mismatch');
});

test('F-84, F-114: pass-through charges at cost with counts, once each; none for a seller on its own providers', async () => {
  const f = await world();
  const { a, b, c, service } = f;
  // A month of WhatsApp messages and AI usage for A.
  await a.inBusiness(() => service.meter.record({ meter: 'whatsapp_messages', quantity: 2000, costPaise: 156000, key: 'wa:batch:1', at: new Date(SOLD_AT) }));
  await a.inBusiness(() => service.meter.record({ meter: 'ai_units', quantity: 4800, costPaise: 2400, key: 'ai:batch:1', at: new Date(SOLD_AT) }));
  // C sells on its own gateway and ships on its own courier account.
  const order = await c.order(50000);
  const [p] = await c.q(`INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, amount_paise, status, fee_paise, captured_at) VALUES ($1, $2, 'full', 'razorpay', 'own', 50000, 'captured', 1000, $3::timestamptz) RETURNING id`, [c.tenant.id, order.id, SOLD_AT]);
  await c.line(order.id, 'sale', 50000, `payment:${p.id}`);
  await c.line(order.id, 'gateway_fee', -1000, `payment:${p.id}`);
  await c.ship(order.id, 4000, { mode: 'own' });

  const added = await a.inBusiness(() => service.passThrough.collect(MONTH));
  assert.ok(added > 0);
  assert.equal(await a.inBusiness(() => service.passThrough.collect(MONTH)), 0, 'running again charges nothing twice');
  const summary = await a.inBusiness(() => service.passThrough.summary(MONTH));
  const fees = a.paid.reduce((sum, s) => sum + s.fee, 0);
  assert.deepEqual(summary, [
    { kind: 'ai', collectedBy: 'invoice', rows: 1, quantity: 4800, amountPaise: 2400 },
    { kind: 'gateway_fee', collectedBy: 'payout', rows: 120, quantity: 120, amountPaise: fees },
    { kind: 'shipping', collectedBy: 'payout', rows: 80, quantity: 80, amountPaise: 80 * 4900 },
    { kind: 'whatsapp', collectedBy: 'invoice', rows: 1, quantity: 2000, amountPaise: 156000 },
  ]);
  await b.inBusiness(() => service.passThrough.collect(MONTH));
  assert.deepEqual((await b.inBusiness(() => service.passThrough.summary(MONTH))).find((s) => s.kind === 'shipping'), { kind: 'shipping', collectedBy: 'invoice', rows: 1, quantity: 1, amountPaise: 6100 }, 'B pays its courier charges on the invoice');

  assert.equal(await c.inBusiness(() => service.passThrough.collect(MONTH)), 0);
  assert.deepEqual(await c.inBusiness(() => service.passThrough.summary(MONTH)), [], 'no gateway or shipping lines on its own providers');

  // More usage in the month before it is invoiced updates its line; once an invoice carries it, it never changes.
  await a.inBusiness(() => service.meter.record({ meter: 'whatsapp_messages', quantity: 10, costPaise: 780, key: 'wa:batch:2', at: new Date(SOLD_AT) }));
  await service.sweepPassThrough();
  assert.equal((await a.inBusiness(() => service.passThrough.summary(MONTH))).find((s) => s.kind === 'whatsapp').quantity, 2010);
});

test('statements are made through the queue for the businesses on the default path only, and one business never sees another\'s', async () => {
  const f = await world();
  const { a, b, c, service, queue, base } = f;
  const demo = await base.platform.tenants.create({ slug: `statement-demo-${process.pid}`, name: 'Demo' });
  await base.db.platform.query('UPDATE tenants SET is_demo = false WHERE is_demo');
  await base.db.platform.query('UPDATE tenants SET is_demo = true WHERE id = $1', [demo.id]);
  await withTenant(demo, () => base.db.query(`INSERT INTO shipping_settings (tenant_id, mode) VALUES ($1, 'managed')`, [demo.id]));

  // A's November is sent; B's has been sent with differences. Next month's run finds nothing left to make for them...
  assert.equal(await service.sweepStatements(), 0, 'November is done for both, and C and the demo business never get one');
  // ...but a new business on the default path gets its statement made by the worker, inside its own business.
  const d = await base.platform.tenants.create({ slug: `statement-new-${process.pid}`, name: 'Durga Decor' });
  await withTenant(d, () => base.db.query(`INSERT INTO shipping_settings (tenant_id, mode) VALUES ($1, 'managed')`, [d.id]));
  assert.equal(await service.sweepStatements(), 1);
  assert.equal(await queue.drain(USAGE_JOBS.statement, (job) => service.statements.run(job.payload.month)), 1);
  const made = await withTenant(d, () => service.statements.list({}));
  assert.deepEqual(made.items.map((s) => [s.month, s.salesPaise, s.reconciliation, s.hasPdf, s.hasCsv]), [[MONTH, 0, 'matched', true, true]]);
  await base.db.platform.query('UPDATE tenants SET is_demo = false WHERE id = $1', [demo.id]);

  // Isolation: inside B, A's statement does not exist, by list, by id, or by file.
  const aStatement = (await a.inBusiness(() => service.statements.list({}))).items[0];
  const bList = await b.inBusiness(() => service.statements.list({}));
  assert.ok(bList.items.every((s) => s.id !== aStatement.id));
  assert.equal(await b.inBusiness(() => service.statements.get(aStatement.id)), null);
  assert.equal(await b.inBusiness(() => service.statements.file(aStatement.id, 'pdf')), null);
  assert.equal(await b.inBusiness(() => service.statements.fileLink(aStatement.id, 'csv')), null);
  assert.equal(await c.inBusiness(() => service.statements.list({})).then((r) => r.items.length), 0);
  const [seen] = await b.q('SELECT count(*)::int AS n FROM settlement_statements');
  assert.equal(seen.n, 1, 'even a query that forgets its WHERE sees only B');

  // The routes the billing module answers with these handlers.
  const ctx = { db: base.db, config: { usageNow: f.clock.now }, providers: { razorpay: f.razorpay }, platform: { storage: f.storage, queue } };
  const api = statementsApi(ctx);
  const listed = await a.inBusiness(() => api['billing.statements']({ query: { limit: 25 } }));
  assert.equal(listed.items[0].id, aStatement.id);
  const link = await a.inBusiness(() => api['billing.statementFile']({ params: { id: String(aStatement.id) }, query: { format: 'csv' } }));
  assert.deepEqual([link.fileUrl, link.fileName], [`/billing/statement-files/s${aStatement.id}.csv`, 'bhava-statement-2026-11.csv']);
  assert.equal(await b.inBusiness(() => api['billing.statementFile']({ params: { id: String(aStatement.id) }, query: { format: 'pdf' } })), null, 'another business\'s is a 404');

  // A report that can't be fetched leaves a statement pending, to be tried again, not matched.
  await f.close();
  const e = await base.platform.tenants.create({ slug: `statement-down-${process.pid}`, name: 'Esha Eats' });
  const linked = a.account.linkedAccountId;
  await withTenant(e, () => base.db.query(`INSERT INTO payment_settings (tenant_id, mode, linked_account_id) VALUES ($1, 'managed', $2)`, [e.id, `${linked}x`]));
  const pending = await withTenant(e, () => service.statements.run(MONTH, { at: new Date(DEC_2) }));
  assert.equal(pending.reconciliation, 'pending');
  assert.equal(pending.sent_at, null);
});

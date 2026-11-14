// The monthly settlement statement and the pass-through charges taken at payout (PRD 5.12: F-83, F-84, F-113): every line
// type, no commission, the gateway fee and shipping at cost; a seller on its own gateway and courier gets none of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { usageMonthOf } from '../../../src/contracts/billing.js';
import { hit } from '../../p0/spec-p0/support.js';
import { item, openBilling } from './support.js';

const lastMonth = () => {
  const d = new Date(`${usageMonthOf(new Date())}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
};

async function order(w, shop, totalPaise) {
  shop.product ??= await shop.in(() => shop.repos.products.create({ name: 'Brass lamp', price: '1000', active: 'on' }));
  return shop.in(() => w.app.db.tx(async (t) => {
    const [o] = await t.query(
      `INSERT INTO orders (tenant_id, order_number, public_token, flow, payment_mode, customer_name, phone, address, city, state, pincode, subtotal_paise, discount_paise, shipping_paise, tax_paise, total_paise,
         advance_paise, balance_paise, idempotency_key, shipping_address)
       VALUES ($1, $2, $3, 'checkout', 'prepaid', 'A buyer', '+919800000000', '1 Road', 'Pune', 'Maharashtra', '411001', $4, 0, 0, 0, $4, 0, 0, $5, '{}') RETURNING id`,
      [shop.tenant.id, `T-${crypto.randomInt(1e9)}`, crypto.randomBytes(12).toString('base64url'), totalPaise, crypto.randomUUID()],
    );
    await t.query(`INSERT INTO order_items (tenant_id, order_id, product_id, name, price_paise, qty) VALUES ($1, $2, $3, 'Brass lamp', $4, 1)`, [shop.tenant.id, o.id, shop.product.id, totalPaise]);
    return o.id;
  }));
}

const line = (w, shop, orderId, kind, amount, ref, at) => shop.in(() => w.app.db.query(
  'INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref, occurred_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)', [shop.tenant.id, orderId, kind, amount, ref, at],
));

test('F-83 and F-113: the statement shows every line type and no commission; fees and shipping are passed through at cost', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29', plan: 't3' });
  const month = lastMonth();
  const at = `${month}T10:00:00+05:30`;
  for (let i = 1; i <= 3; i++) {
    const id = await order(w, shop, 100000);
    await line(w, shop, id, 'sale', 100000, `payment:${i}`, at);
    await line(w, shop, id, 'gateway_fee', -2360, `payment:${i}`, at);
    await line(w, shop, id, 'shipping_charge', -5000, `shipment:${i}`, at);
    await line(w, shop, id, 'transfer', 100000, `trf_${i}`, at);
    if (i === 1) {
      await line(w, shop, id, 'refund', -20000, 'refund:1', at);
      await line(w, shop, id, 'transfer_reversal', -20000, 'refund:1', at);
    }
  }
  const built = await shop.in(() => w.billing.statements.build(month));
  assert.deepEqual(
    [built.sales_paise, built.refunds_paise, built.gateway_fees_paise, built.shipping_paise, built.commission_paise, built.payouts_paise, built.closing_balance_paise].map(Number),
    [300000, 20000, 7080, 15000, 0, 280000, -22080],
  );
  assert.deepEqual(built.counts, { orders: 3, refunds: 1, shipments: 3 });
  assert.equal(built.payouts.length, 3);
  assert.equal(built.reconciliation, 'pending', 'no linked account to check against');
  assert.equal((await shop.in(() => w.billing.statements.build(month))).id, built.id, 'once a month');
  const passed = await w.sql('SELECT kind, amount_paise, quantity, collected_by FROM pass_through_charges WHERE tenant_id = $1 ORDER BY kind', [shop.tenant.id]);
  assert.deepEqual(passed.map((p) => [p.kind, Number(p.amount_paise), Number(p.quantity), p.collected_by]), [['gateway_fee', 7080, 3, 'payout'], ['shipping', 15000, 3, 'payout']]);
  await assert.rejects(w.sql('UPDATE settlement_statements SET commission_paise = 1 WHERE id = $1', [built.id]), /check/i, 'a commission can never be recorded');

  const list = await shop.api('GET', '/billing/statements');
  assert.equal(list.status, 200, list.text);
  const [s] = list.json.items;
  assert.deepEqual([s.commissionPaise, s.closingBalance.amountPaise, s.closingBalance.owedTo, s.month], [0, 22080, 'bhava', month]);
  const link = await shop.api('GET', `/billing/statements/${s.id}/file?format=csv`);
  assert.equal(link.status, 200, link.text);
  const csv = await hit(w.app, link.json.fileUrl, { host: shop.host, token: shop.token });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Commission \(paise\),0/);
  assert.match(csv.text, /trf_2/);
  const pdf = await shop.api('GET', `/billing/statements/${s.id}/file?format=pdf`);
  assert.equal((await hit(w.app, pdf.json.fileUrl, { host: shop.host, token: shop.token })).raw.subarray(0, 4).toString(), '%PDF');
});

test('F-84: on its own gateway and courier a seller gets no statement and no gateway or shipping lines; its invoice still lists plan and add-ons', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29', plan: 't3' });
  await w.sql(`INSERT INTO payment_settings (tenant_id, mode) VALUES ($1, 'own') ON CONFLICT (tenant_id) DO UPDATE SET mode = 'own'`, [shop.tenant.id]);
  await w.sql(`INSERT INTO shipping_settings (tenant_id, mode) VALUES ($1, 'own') ON CONFLICT (tenant_id) DO UPDATE SET mode = 'own'`, [shop.tenant.id]);
  const month = lastMonth();
  const id = await order(w, shop, 50000);
  await line(w, shop, id, 'sale', 50000, 'payment:1', `${month}T10:00:00+05:30`);
  assert.equal(await shop.in(() => w.billing.statements.build(month)), null);
  assert.equal((await w.sql('SELECT 1 FROM pass_through_charges WHERE tenant_id = $1', [shop.tenant.id])).length, 0);

  await shop.subscribe('t3');
  assert.equal((await shop.api('POST', '/billing/items', item('loyalty'))).status, 201);
  await shop.charge();
  const invoices = await shop.invoices();
  const kinds = (await shop.lines(invoices.at(-1).id)).map((l) => l.kind);
  assert.deepEqual(kinds, ['plan', 'addon']);
});

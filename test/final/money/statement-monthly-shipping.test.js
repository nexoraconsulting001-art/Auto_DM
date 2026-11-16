// money-3 (the same cause, in the second statement writer): a seller whose courier charges are billed on Bhava's invoice
// (shipping_settings.charge_billing 'monthly', PRD 9.10) pays them there. billing's monthly settlement statement must not
// also take them off the balance, nor record them again as a pass-through charge collected from the payout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { usageMonthOf } from '../../../src/contracts/billing.js';
import { openBilling } from '../../p7/billing/support.js';

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

test('money-3: billing\'s statement of a seller billed monthly for courier charges leaves them off the balance and off the payout charges', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29', plan: 't3' });
  await w.sql(`INSERT INTO shipping_settings (tenant_id, charge_billing) VALUES ($1, 'monthly') ON CONFLICT (tenant_id) DO UPDATE SET charge_billing = 'monthly'`, [shop.tenant.id]);
  const month = lastMonth();
  const at = `${month}T10:00:00+05:30`;
  for (let i = 1; i <= 2; i++) {
    const id = await order(w, shop, 100000);
    await line(w, shop, id, 'sale', 100000, `payment:${i}`, at);
    await line(w, shop, id, 'gateway_fee', -2360, `payment:${i}`, at);
    await line(w, shop, id, 'shipping_charge', -5000, `shipment:${i}`, at);
    await line(w, shop, id, 'transfer', 97640, `trf_${i}`, at);
  }
  const built = await shop.in(() => w.billing.statements.build(month));
  assert.equal(Number(built.shipping_paise), 0, 'the courier charges are on Bhava\'s invoice, not taken from the payout');
  assert.equal(Number(built.closing_balance_paise), 200000 - 4720 - 195280, 'so the balance does not take them either');
  assert.equal(built.counts.shipments, 2, 'the shipments are still counted');
  const passed = await w.sql(`SELECT kind, collected_by FROM pass_through_charges WHERE tenant_id = $1 AND kind = 'shipping' AND collected_by = 'payout'`, [shop.tenant.id]);
  assert.deepEqual(passed, [], 'no courier charge recorded as collected from the payout');
});

test('money-3: a seller whose courier charges are taken from the payout still has them on the statement', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29', plan: 't3' });
  await w.sql(`INSERT INTO shipping_settings (tenant_id, charge_billing) VALUES ($1, 'payout') ON CONFLICT (tenant_id) DO UPDATE SET charge_billing = 'payout'`, [shop.tenant.id]);
  const month = lastMonth();
  const at = `${month}T10:00:00+05:30`;
  const id = await order(w, shop, 100000);
  await line(w, shop, id, 'sale', 100000, 'payment:1', at);
  await line(w, shop, id, 'shipping_charge', -5000, 'shipment:1', at);
  await line(w, shop, id, 'transfer', 95000, 'trf_1', at);
  const built = await shop.in(() => w.billing.statements.build(month));
  assert.equal(Number(built.shipping_paise), 5000);
  assert.equal(Number(built.closing_balance_paise), 0);
});

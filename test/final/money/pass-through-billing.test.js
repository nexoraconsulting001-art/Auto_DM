// money-2, money-3: pass-through charges are charged at the provider and invoiced by one path. The hourly usage job's rows
// must not stop the provider charge (money-2), the current month is never frozen on an invoice part way through, and a
// monthly-billed courier charge is charged and labelled as shipping, and not also taken off the payout (money-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageFor } from '../../../src/modules/usage/index.js';
import { openBilling } from '../../p7/billing/support.js';
import { openWorld } from '../../p4/payments/support.js';

const passLines = async (shop) => {
  const invoices = await shop.invoices();
  return (await shop.lines(invoices.at(-1).id)).filter((l) => l.kind === 'pass_through');
};
const mismatches = (w) => w.one(`SELECT count(*)::int AS n FROM alerts WHERE kind = 'billing.amount_mismatch'`);

test('money-2: rows the hourly usage job wrote are still charged at the provider, and this month waits for its own renewal', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  await shop.in(async () => {
    await w.app.db.query(`INSERT INTO usage_events (tenant_id, meter, quantity, cost_paise, idempotency_key, occurred_at) VALUES ($1, 'whatsapp_messages', 2000, 157000, 'wa:last', date_trunc('month', now()) - interval '10 days')`, [shop.tenant.id]);
    await w.app.db.query(`INSERT INTO usage_events (tenant_id, meter, quantity, cost_paise, idempotency_key, occurred_at) VALUES ($1, 'whatsapp_messages', 100, 7850, 'wa:now', now())`, [shop.tenant.id]);
  });
  // The hourly job runs first, as it does in production: last month (final) and this month (so far).
  await usageFor(w.app.ctx).sweepPassThrough();
  const written = await w.sql(`SELECT kind, source_ref, amount_paise FROM pass_through_charges WHERE tenant_id = $1 ORDER BY id`, [shop.tenant.id]);
  assert.equal(written.length, 2, JSON.stringify(written));

  await w.sql(`UPDATE subscriptions SET current_period_end = now() + interval '1 hour' WHERE tenant_id = $1`, [shop.tenant.id]);
  const done = await w.billing.renewals();
  assert.equal(done.passThrough, 1, 'last month is charged at the provider; this month is not yet');
  const addons = (await w.rzp.get('/state')).addons.filter((a) => /WhatsApp/i.test(a.item?.name ?? ''));
  assert.equal(addons.length, 1, 'the provider was asked for last month’s WhatsApp cost');
  assert.equal((await w.billing.renewals()).passThrough, 0, 'once');

  const out = await shop.charge();
  const lines = await passLines(shop);
  assert.deepEqual(lines.map((l) => [l.code, Number(l.quantity), Number(l.gross_paise)]), [['whatsapp', 2000, 157000]], 'only the closed month is invoiced');
  assert.equal(Number((await shop.invoices()).at(-1).total_paise), out.payment.amount, 'the invoice is what the provider took');
  assert.equal((await mismatches(w)).n, 0);
  const current = await w.one(`SELECT invoice_id FROM pass_through_charges WHERE tenant_id = $1 AND source_ref = 'usage:whatsapp_messages:' || to_char(now(), 'YYYY-MM')`, [shop.tenant.id]);
  assert.equal(current.invoice_id, null, 'this month keeps counting until it closes');
});

test('money-3: a courier charge billed monthly is charged at the provider as shipping, not printed as AI usage', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  await w.sql(`INSERT INTO pass_through_charges (tenant_id, kind, amount_paise, quantity, period, collected_by, source_ref) VALUES
    ($1, 'shipping', 8500, 1, date_trunc('month', now() - interval '1 month')::date, 'invoice', 'shipment:1'),
    ($1, 'shipping', 6000, 1, date_trunc('month', now() - interval '1 month')::date, 'invoice', 'shipment:2')`, [shop.tenant.id]);
  await w.sql(`UPDATE subscriptions SET current_period_end = now() + interval '1 hour' WHERE tenant_id = $1`, [shop.tenant.id]);
  const done = await w.billing.renewals();
  assert.equal(done.passThrough, 1, 'one shipping line for the month');
  const out = await shop.charge();
  const lines = await passLines(shop);
  assert.deepEqual(lines.map((l) => [l.code, Number(l.quantity), Number(l.gross_paise)]), [['shipping', 2, 14500]]);
  assert.match(lines[0].description, /^Shipping at cost/);
  assert.equal(Number((await shop.invoices()).at(-1).total_paise), out.payment.amount);
  assert.equal((await mismatches(w)).n, 0);
});

test('money-3: the settlement summary does not take a monthly-billed courier charge off the payout', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 100000 });
  await shop.sql(`INSERT INTO shipping_settings (tenant_id, charge_billing) VALUES ($1, 'monthly') ON CONFLICT (tenant_id) DO UPDATE SET charge_billing = 'monthly'`, [shop.tenant.id]);
  await shop.sql(`INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref) VALUES ($1, $2, 'shipping_charge', -8500, 'shipment:77')`, [shop.tenant.id, order.id]);
  const summary = (await shop.api('GET', '/settlements/summary')).json;
  assert.equal(summary.payablePaise, 100000 - 2360, 'billed on the invoice, so not also taken from the payout');
});

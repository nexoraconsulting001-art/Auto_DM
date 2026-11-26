// Final attack on Bhava's own billing: add-ons bought twice at once, hostile quantities, a charge replayed under new event
// ids, and items removed twice at once. Real app, real HTTP, the Razorpay simulator for the provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { item, openBilling } from '../../p7/billing/support.js';

const is4xx = (res) => res.status >= 400 && res.status < 500;
const providerAddons = async (w, shop) => {
  const s = await shop.sub();
  return (await w.rzp.get('/state')).addons.filter((a) => a.subscription_id === s.provider_subscription_id);
};

test('atk-money billing: six purchases of a one-only add-on at once, each with its own key, make one item and one provider charge', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const answers = await Promise.all(Array.from({ length: 6 }, () => shop.api('POST', '/billing/items', item('reel_management'))));
  const statuses = answers.map((a) => a.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409], answers.map((a) => `${a.status} ${a.text.slice(0, 120)}`).join(' | '));
  const rows = await w.sql(`SELECT * FROM subscription_items WHERE tenant_id = $1 AND addon_code = 'reel_management'`, [shop.tenant.id]);
  assert.equal(rows.length, 1);
  assert.equal((await providerAddons(w, shop)).length, 1, 'charged once at the next renewal');
});

test('atk-money billing: one request key sent six times at once is one item and one provider charge', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const body = item('extra_seat', { quantity: 2 });
  const answers = await Promise.all(Array.from({ length: 6 }, () => shop.api('POST', '/billing/items', body)));
  for (const a of answers) assert.ok(a.status === 201 || a.status === 200, `${a.status} ${a.text.slice(0, 200)}`);
  assert.equal(new Set(answers.map((a) => a.json.item.id)).size, 1, 'every answer is the same item');
  const rows = await w.sql(`SELECT * FROM subscription_items WHERE tenant_id = $1 AND addon_code = 'extra_seat'`, [shop.tenant.id]);
  assert.equal(rows.length, 1);
  const queued = await providerAddons(w, shop);
  // The next renewal charges what the provider holds: it must be what Bhava's invoice for it lists.
  const out = await shop.charge();
  const invoice = (await shop.invoices()).at(-1);
  assert.deepEqual(
    { providerLines: queued.length, charged: out.payment.amount },
    { providerLines: 1, charged: Number(invoice.total_paise) },
    'one provider line, and the seller is charged what the invoice says',
  );
  // The same key for a different quantity is refused.
  const other = await shop.api('POST', '/billing/items', { ...body, quantity: 3 });
  assert.equal(other.status, 409, other.text);
});

test('atk-money billing: hostile add-on bodies and item ids are a 4xx and buy nothing', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const bodies = [
    item('extra_seat', { quantity: 0 }), item('extra_seat', { quantity: -1 }), item('extra_seat', { quantity: 1.5 }), item('extra_seat', { quantity: 1001 }),
    item('extra_seat', { quantity: 2 ** 31 }), item('extra_seat', { quantity: '2' }), item('extra_seat', { quantity: null }),
    item('reel_management', { quantity: 2 }), item('nope'), item('extra\u0000seat'), item(''), item('x'.repeat(5000)),
    { code: 'extra_seat' }, { code: 'extra_seat', requestKey: '' }, { code: 'extra_seat', requestKey: 'k\u0000'.repeat(10) }, { code: 'extra_seat', requestKey: 'k'.repeat(500) },
  ];
  for (const body of bodies) {
    const res = await shop.api('POST', '/billing/items', body);
    assert.ok(is4xx(res), `${JSON.stringify(body).slice(0, 100)}: ${res.status} ${res.text.slice(0, 160)}`);
  }
  for (const id of ['2147483648', '-1', '1.5', 'abc', '9'.repeat(30)]) {
    const res = await shop.api('DELETE', `/billing/items/${id}`);
    assert.ok(is4xx(res), `delete ${id}: ${res.status} ${res.text.slice(0, 120)}`);
  }
  const rows = await w.sql('SELECT addon_code, quantity, unit_price_paise FROM subscription_items WHERE tenant_id = $1', [shop.tenant.id]);
  assert.deepEqual(rows, [], 'nothing was bought');
  assert.equal((await providerAddons(w, shop)).length, 0);
  // A price in the body is never the price: the catalogue's is (the body schema drops unknown keys).
  const priced = await shop.api('POST', '/billing/items', item('extra_seat', { unitPricePaise: 1, pricePaise: 0, amountPaise: 1 }));
  assert.ok(priced.status === 201 || is4xx(priced), `${priced.status} ${priced.text.slice(0, 160)}`);
  if (priced.status === 201) assert.equal(priced.json.item.unitPricePaise, 19900, 'the catalogue price, not the body’s');
  const [line] = await providerAddons(w, shop);
  if (line) assert.ok(line.item.amount >= 19900, `the provider line is ${line.item.amount} paise`);
});

test('atk-money billing: a subscription charge replayed under four new event ids at once is one payment and one invoice', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const sent = (await w.rzp.get('/webhooks')).deliveries.filter((d) => d.body?.event === 'subscription.charged');
  assert.equal(sent.length, 1);
  const answers = await Promise.all(Array.from({ length: 4 }, () => w.hook(sent[0].body, { eventId: `evt_${crypto.randomBytes(6).toString('hex')}` })));
  for (const a of answers) assert.equal(a.status, 200, a.text);
  await Promise.all([w.settle(), w.settle()]);
  const payments = (await shop.payments()).filter((p) => p.status === 'captured');
  assert.equal(payments.length, 1, 'one payment');
  const invoices = await shop.invoices();
  assert.equal(invoices.length, 1, 'one invoice');
  const numbers = await w.sql(`SELECT count(*)::int AS n FROM bhava_invoices`);
  assert.equal(numbers[0].n, 1, 'no invoice number is spent on a replay');
});

test('atk-money billing: one item removed five times at once is removed once; the others are 404, never 5xx', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const added = await shop.api('POST', '/billing/items', item('extra_seat', { quantity: 1 }));
  assert.equal(added.status, 201, added.text);
  const answers = await Promise.all(Array.from({ length: 5 }, () => shop.api('DELETE', `/billing/items/${added.json.item.id}`)));
  assert.deepEqual(answers.map((a) => a.status).sort(), [204, 404, 404, 404, 404], answers.map((a) => `${a.status} ${a.text.slice(0, 120)}`).join(' | '));
  assert.equal((await providerAddons(w, shop)).length, 0, 'nothing left to charge');
  const audits = await w.sql(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'billing.item_removed'`, [shop.tenant.id]);
  assert.equal(audits[0].n, 1, 'removed once');
});

test('atk-money billing: another business cannot remove, or learn about, this business’s add-on by its id', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  const other = await w.business({ state: '29' });
  await shop.subscribe('t1');
  await other.subscribe('t1');
  const added = await shop.api('POST', '/billing/items', item('extra_seat'));
  assert.equal(added.status, 201, added.text);
  const res = await other.api('DELETE', `/billing/items/${added.json.item.id}`);
  assert.equal(res.status, 404, res.text);
  const [row] = await w.sql('SELECT ends_at FROM subscription_items WHERE id = $1', [added.json.item.id]);
  assert.equal(row.ends_at, null, 'still running');
  assert.equal((await providerAddons(w, shop)).length, 1);
});

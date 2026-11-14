// Add-ons, DM packs, managed services and one-time setup, each its own line (PRD 3, 5.12: F-81, F-85, F-116), WhatsApp and AI
// passed through at cost with counts (F-114), what may not be bought, and a provider timeout retried only with the same key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { item, openBilling } from './support.js';

const linesOf = async (shop) => {
  const invoices = await shop.invoices();
  return shop.lines(invoices.at(-1).id);
};

test('F-85, F-116, F-81: an add-on, a service, a pack and a setup bought mid-period each appear as their own line on the next invoice', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');

  const bought = {};
  for (const code of ['whatsapp', 'reel_management', 'dm_pack', 'setup_automation']) {
    // A price, an amount or a discount from the client is not read: the row's price is the price.
    const res = await shop.api('POST', '/billing/items', item(code, { pricePaise: 1, unitPricePaise: 1, amountPaise: 1, discountPaise: 99999 }));
    assert.equal(res.status, 201, `${code}: ${res.text}`);
    bought[code] = res.json.item;
  }
  assert.deepEqual(Object.values(bought).map((i) => i.unitPricePaise), [99900, 300000, 29900, 499900]);
  // The add-on switches its feature on for this business.
  assert.equal((await w.one(`SELECT enabled FROM tenant_features WHERE tenant_id = $1 AND feature = 'whatsapp_automation'`, [shop.tenant.id])).enabled, true);

  // The same request again is the same purchase.
  const key = `rk-same-${shop.tenant.id}-0001`;
  const first = await shop.api('POST', '/billing/items', { code: 'extra_seat', quantity: 2, requestKey: key });
  const again = await shop.api('POST', '/billing/items', { code: 'extra_seat', quantity: 2, requestKey: key });
  assert.deepEqual([first.status, again.status, again.json.item.id], [201, 201, first.json.item.id]);

  const out = await shop.charge();
  const lines = await linesOf(shop);
  assert.deepEqual(lines.map((l) => [l.kind, l.code]), [['plan', 't1'], ['addon', 'whatsapp'], ['service', 'reel_management'], ['pack', 'dm_pack'], ['setup', 'setup_automation'], ['addon', 'extra_seat']]);
  const pack = lines.find((l) => l.code === 'dm_pack');
  assert.deepEqual([Number(pack.quantity), Number(pack.unit_paise), Number(pack.gross_paise)], [1, 29900, 29900], 'one pack at Rs 299');
  const seat = lines.find((l) => l.code === 'extra_seat');
  assert.deepEqual([Number(seat.quantity), Number(seat.gross_paise)], [2, 39800]);
  assert.equal(Number((await shop.invoices()).at(-1).total_paise), out.payment.amount, 'the provider took exactly what the invoice lists');
  assert.equal((await w.one(`SELECT count(*)::int AS n FROM alerts WHERE kind = 'billing.amount_mismatch'`)).n, 0);

  // The next renewal: the monthly lines again, the one-time setup never again.
  await w.sql(`UPDATE subscriptions SET current_period_end = now() + interval '1 hour' WHERE tenant_id = $1`, [shop.tenant.id]);
  await w.sql(`UPDATE subscription_items i SET billed_through = s.current_period_end FROM subscriptions s WHERE s.tenant_id = i.tenant_id AND i.tenant_id = $1`, [shop.tenant.id]);
  const queued = await w.billing.renewals();
  assert.equal(queued.queued, 4, 'whatsapp, reel management, the pack and the seats');
  assert.equal((await w.billing.renewals()).queued, 0, 'running it again queues nothing more');
  const next = await shop.charge();
  const renewal = await linesOf(shop);
  assert.deepEqual(renewal.map((l) => l.code), ['t1', 'whatsapp', 'reel_management', 'dm_pack', 'extra_seat']);
  assert.equal(Number((await shop.invoices()).at(-1).total_paise), next.payment.amount);

  // Removed: runs to the end of what is paid, then the feature goes.
  const removed = await shop.api('DELETE', `/billing/items/${bought.whatsapp.id}`);
  assert.equal(removed.status, 204, removed.text);
  assert.ok((await w.one('SELECT ends_at FROM subscription_items WHERE id = $1', [bought.whatsapp.id])).ends_at);
  assert.equal((await shop.api('DELETE', `/billing/items/${bought.setup_automation.id}`)).status, 409, 'a one-time purchase is not removed');
  assert.equal((await shop.api('DELETE', '/billing/items/999999')).status, 404);
});

test('what may not be bought is refused: an unknown code, a plan too low, something included, a second of one, Free with no subscription', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const code = async (c, extra) => {
    const res = await shop.api('POST', '/billing/items', item(c, extra));
    return [res.status, res.json?.code ?? null];
  };
  assert.deepEqual(await code('no_such_addon'), [400, 'validation_failed']);
  assert.deepEqual(await code('NOT VALID'), [400, 'validation_failed']);
  assert.deepEqual(await code('loyalty'), [403, 'plan.feature_off'], 'loyalty is from tier 3');
  assert.deepEqual(await code('whatsapp', { quantity: 2 }), [400, 'validation_failed'], 'one of these only');
  assert.equal((await shop.api('POST', '/billing/items', item('whatsapp'))).status, 201);
  assert.deepEqual(await code('whatsapp'), [409, 'conflict']);
  await w.sql(`UPDATE addons SET active = false WHERE code = 'ai_replies'`);
  assert.deepEqual(await code('ai_replies'), [400, 'validation_failed'], 'switched off in the price list');
  // A plan or an add-on the price list does not have.
  assert.equal((await shop.change('t9')).status, 400);

  const store = await w.business({ state: '29', plan: 't3' });
  await store.subscribe('t3');
  const res = await store.api('POST', '/billing/items', item('story_dm_triggers'));
  assert.deepEqual([res.status, res.json.code], [409, 'conflict'], 'included from tier 3');

  const free = await w.business({ state: '29' });
  assert.equal((await free.api('POST', '/billing/items', item('whatsapp'))).json.code, 'plan.feature_off');
  assert.equal((await free.api('POST', '/billing/items', item('dm_pack'))).json.code, 'plan.feature_off', 'Free buys no packs while the setting says so');
  assert.equal((await free.api('POST', '/billing/items', item('setup_automation'))).status, 409, 'nothing to charge it to yet');
  const catalog = (await free.api('GET', '/billing/catalog')).json;
  assert.deepEqual(['whatsapp', 'dm_pack', 'story_dm_triggers'].map((c) => catalog.addons.find((a) => a.code === c).unavailable), ['needs_plan', 'needs_plan', 'needs_plan']);
});

test('a provider timeout with delivery unknown: the line is retried only with the same key, so it is charged once', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  await w.rzp.post('/faults', { kind: 'partial', then: 'timeout', match: { method: 'POST', path: '/v1/subscriptions/*/addons' } });
  const res = await shop.api('POST', '/billing/items', item('reel_management'));
  assert.equal(res.status, 201, res.text);
  const row = await w.one('SELECT * FROM subscription_items WHERE id = $1', [res.json.item.id]);
  assert.equal(row.provider_item_id, null, 'the answer was lost');
  assert.equal((await w.billing.renewals()).queued, 1);
  assert.ok((await w.one('SELECT provider_item_id FROM subscription_items WHERE id = $1', [res.json.item.id])).provider_item_id);
  const posts = (await w.rzp.get('/calls')).calls.filter((c) => c.method === 'POST' && /\/addons$/.test(c.path));
  assert.equal(posts.length, 1, 'no second line was made');
  const out = await shop.charge();
  assert.equal(Number((await shop.invoices()).at(-1).total_paise), out.payment.amount, 'charged once, invoiced once');
});

test('F-114: WhatsApp messages and AI usage are billed on the next invoice at cost, with counts', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '27' });
  await shop.subscribe('t1');
  await shop.in(async () => {
    await w.app.db.query(`INSERT INTO usage_events (tenant_id, meter, quantity, cost_paise, idempotency_key, occurred_at) VALUES ($1, 'whatsapp_messages', 2000, 157000, 'wa:test', now() - interval '40 days')`, [shop.tenant.id]);
    await w.app.db.query(`INSERT INTO usage_events (tenant_id, meter, quantity, cost_paise, idempotency_key, occurred_at) VALUES ($1, 'ai_units', 300, 4501, 'ai:test', now() - interval '40 days')`, [shop.tenant.id]);
    await w.app.db.query(`INSERT INTO usage_events (tenant_id, meter, quantity, cost_paise, idempotency_key, occurred_at) VALUES ($1, 'dms', 900, 0, 'dm:test', now() - interval '40 days')`, [shop.tenant.id]);
  });
  await w.sql(`UPDATE subscriptions SET current_period_end = now() + interval '1 hour' WHERE tenant_id = $1`, [shop.tenant.id]);
  const done = await w.billing.renewals();
  assert.equal(done.passThrough, 2);
  assert.equal((await w.billing.renewals()).passThrough, 0, 'once per month and kind');
  const out = await shop.charge();
  const lines = (await linesOf(shop)).filter((l) => l.kind === 'pass_through');
  assert.deepEqual(lines.map((l) => [l.code, Number(l.quantity), Number(l.gross_paise), Number(l.discount_paise)]).sort(), [['ai', 300, 4501, 0], ['whatsapp', 2000, 157000, 0]], 'at cost, no markup, no offer');
  assert.ok(lines.every((l) => Number(l.igst_paise) > 0 && Number(l.cgst_paise) === 0), 'IGST for another state');
  assert.equal(Number((await shop.invoices()).at(-1).total_paise), out.payment.amount);
  const charges = await w.sql('SELECT kind, invoice_id FROM pass_through_charges WHERE tenant_id = $1 ORDER BY id', [shop.tenant.id]);
  assert.ok(charges.every((c) => c.invoice_id), 'each charge names the invoice that carries it');
});

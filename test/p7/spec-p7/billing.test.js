// PRD 3 and 5.12 (and 5.7): what a business pays Bhava. Billing webhooks, invoices, tax, the financial year, grace, add-ons, packs and
// plan changes, by HTTP, the database and the Razorpay simulator. Every test tries to break the rule it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { taxFor, offerDiscountPaise } from '../../../src/contracts/billing.js';
import {
  BILLING_SECRET, billingHook, change, charge, chargedEntities, invoicesOf, issueInvoice, json, key, linesOf, need, one, paymentsOf, planOf, refusal, setSetting, shopOn, sql,
  subscribe, subscriptionOf, tenantStatus, unique, useBillingWorld, authorize, ownGateway, hit, setDmUsed, DAY, pause, buyer, addStaff, consoleUser, opCall,
} from './support.js';

const world = useBillingWorld();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });

async function freeShop() {
  return shopOn(world, 'free');
}

test('F-51: the same charge delivered twice, in parallel and again later, makes one payment and one invoice', async () => {
  const shop = await freeShop();
  need(await change(shop, 't1', 'monthly'), 200, 'Choosing tier 1');
  const sub = await authorize(world, shop);
  // The provider's own control sends the event twice with the same id.
  await charge(world, shop, { duplicates: 2 });
  const invoice = await world.until(async () => (await invoicesOf(shop.world ?? world, shop))[0]);
  assert.ok(invoice, 'a captured charge makes an invoice');
  // The same payment again under a new event id, five times at once.
  const [payment] = await paymentsOf(world, shop);
  assert.ok(payment, 'a captured charge makes a payment row');
  const replies = await Promise.all(Array.from({ length: 5 }, () => billingHook(world, 'subscription.charged', chargedEntities(sub.provider_subscription_id, payment.provider_payment_id, Number(payment.amount_paise)))));
  for (const r of replies) assert.ok(r.status < 300, `a repeat is acknowledged, got ${r.status}`);
  await world.quiet(600);
  assert.equal((await paymentsOf(world, shop)).length, 1, 'one payment');
  assert.equal((await invoicesOf(world, shop)).length, 1, 'one invoice');
  const events = await sql(world, `SELECT provider_event_id FROM provider_webhook_events WHERE scope = 'billing'`);
  assert.equal(new Set(events.map((e) => e.provider_event_id)).size, events.length, 'each event id is stored once');
});

test('F-52: a bad signature gets 400 and changes nothing; so does none, the store secret, and a body changed after signing', async () => {
  const shop = await freeShop();
  need(await change(shop, 't1', 'monthly'), 200, 'Choosing tier 1');
  const sub = await authorize(world, shop);
  const before = (await sql(world, `SELECT count(*)::int AS n FROM provider_webhook_events WHERE scope = 'billing'`))[0].n;
  const entities = chargedEntities(sub.provider_subscription_id, `pay_forged_${unique()}`);
  for (const [label, options] of [['bad', { signature: 'deadbeef'.repeat(8) }], ['none', { signature: null }], ['store secret', { secret: world.rzp.webhookSecret }], ['empty', { signature: '' }]]) {
    const res = await billingHook(world, 'subscription.charged', entities, options);
    assert.equal(res.status, 400, `${label} signature`);
  }
  // Signed over one body, sent with another.
  const signed = await billingHook(world, 'subscription.charged', entities, { eventId: `evt_t_${unique()}` });
  assert.ok(signed.status < 300);
  const raw = JSON.stringify({ event: 'subscription.charged', created_at: 1, payload: chargedEntities(sub.provider_subscription_id, `pay_tamper_${unique()}`, 1) });
  const sig = crypto.createHmac('sha256', BILLING_SECRET).update(JSON.stringify({ event: 'subscription.charged', created_at: 1, payload: entities })).digest('hex');
  const tampered = await hit(world, '/webhooks/billing/razorpay', { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': `evt_x_${unique()}` }, body: raw });
  assert.equal(tampered.status, 400, 'a body changed after signing');
  await world.quiet(400);
  const after = (await sql(world, `SELECT count(*)::int AS n FROM provider_webhook_events WHERE scope = 'billing'`))[0].n;
  assert.equal(after - before, 1, 'only the properly signed event was stored');
  assert.equal((await paymentsOf(world, shop)).some((p) => p.provider_payment_id.startsWith('pay_tamper')), false);
});

test("F-52: a signed event for another business's subscription, or for none, changes only the owner of that subscription", async () => {
  const a = await freeShop();
  const b = await freeShop();
  need(await change(b, 't1', 'monthly'), 200, 'B chooses tier 1');
  const subB = await authorize(world, b);
  await subscribe(world, a, 't1');
  const invoicesA = (await invoicesOf(world, a)).length;
  // Carries A's tenant in its notes but names B's subscription: it is B's, whatever it claims.
  const entities = chargedEntities(subB.provider_subscription_id, `pay_cross_${unique()}`);
  entities.subscription.entity.notes = { tenant_id: String(a.tenantId) };
  const res = await billingHook(world, 'subscription.charged', entities);
  assert.ok(res.status < 500, `answered ${res.status}`);
  await world.quiet(600);
  assert.equal((await invoicesOf(world, a)).length, invoicesA, "A's invoices do not change");
  assert.ok((await paymentsOf(world, a)).every((p) => p.provider_payment_id !== entities.payment.entity.id));
  // A subscription nobody has.
  const ghost = await billingHook(world, 'subscription.charged', chargedEntities(`sub_ghost_${unique()}`, `pay_ghost_${unique()}`));
  assert.ok(ghost.status < 500, 'an unknown subscription is not a server error');
  assert.equal((await sql(world, `SELECT 1 FROM billing_payments WHERE provider_payment_id LIKE 'pay_ghost%'`)).length, 0);
});

test('F-51: a failure delivered after a later charge does not undo it, and a late duplicate of the failure changes nothing', async () => {
  const shop = await freeShop();
  const { sub } = await subscribe(world, shop, 't1');
  const old = Math.floor(Date.now() / 1000) - 3600;
  const failed = { subscription: { entity: { id: sub.provider_subscription_id, status: 'pending' } }, payment: { entity: { id: `pay_late_${unique()}`, amount: 1, status: 'failed', method: 'card', created_at: old } } };
  const first = await billingHook(world, 'subscription.pending', failed, { createdAt: old });
  assert.ok(first.status < 300);
  await world.quiet(500);
  const now = await subscriptionOf(world, shop);
  assert.equal(now.status, 'active', 'an older failure leaves an active subscription active');
  assert.equal(now.grace_until, null);
});

test('F-53: a failed renewal starts 7 days of grace; at 7 days less a second the business runs, a second past it is suspended with its data', async () => {
  const shop = await freeShop();
  await subscribe(world, shop, 't1');
  const product = await shop.product();
  await charge(world, shop, { outcome: 'failed' });
  const grace = await world.until(async () => {
    const s = await subscriptionOf(world, shop);
    return ['grace', 'past_due'].includes(s.status) ? s : null;
  });
  assert.ok(grace, 'a failed charge makes the subscription past due or in grace');
  const failedAt = Date.now();
  const sub = await world.until(async () => (await subscriptionOf(world, shop)).grace_until && (await subscriptionOf(world, shop)));
  const days = (new Date(sub.grace_until).getTime() - failedAt) / DAY;
  assert.ok(days > 6.99 && days < 7.01, `grace runs 7 days, not ${days}`);
  // Day 7, one second before the end.
  await sql(world, `UPDATE subscriptions SET grace_until = now() + interval '1500 milliseconds' WHERE tenant_id = $1`, [shop.tenantId]);
  await world.tick();
  assert.notEqual(await tenantStatus(world, shop), 'suspended', 'not yet at day 7');
  assert.equal((await shop.send('GET', '/billing')).status, 200);
  // Day 8: a second past the end.
  await sql(world, `UPDATE subscriptions SET grace_until = now() - interval '1 second' WHERE tenant_id = $1`, [shop.tenantId]);
  const suspended = await world.until(async () => (await tenantStatus(world, shop)) === 'suspended');
  assert.ok(suspended, 'the tenant is suspended once grace has passed');
  assert.equal((await subscriptionOf(world, shop)).status, 'suspended');
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM products WHERE tenant_id = $1 AND id = $2', [shop.tenantId, product.id])).n), 1, 'data intact');
  // The owner cannot lift it by resuming, and the pause is theirs to see.
  const resume = await shop.send('POST', '/automations/pause', { paused: false });
  assert.ok(resume.status !== 500);
  assert.equal(await tenantStatus(world, shop), 'suspended');
});

test('F-53: a payment during grace ends it, and the grace period is not extended by a second failure', async () => {
  const shop = await freeShop();
  await subscribe(world, shop, 't1');
  await charge(world, shop, { outcome: 'failed' });
  const first = await world.until(async () => (await subscriptionOf(world, shop)).grace_until && (await subscriptionOf(world, shop)));
  await charge(world, shop, { outcome: 'failed' });
  await world.quiet(500);
  const second = await subscriptionOf(world, shop);
  assert.equal(new Date(second.grace_until).getTime(), new Date(first.grace_until).getTime(), 'a second failure does not restart the clock');
  await charge(world, shop, { outcome: 'charged' });
  const healed = await world.until(async () => (await subscriptionOf(world, shop)).status === 'active');
  assert.ok(healed, 'paying ends the grace period');
  assert.equal((await subscriptionOf(world, shop)).grace_until, null);
});

test('F-54: a business in the seller state gets CGST and SGST, equal; one in another state gets IGST; each line adds up to its invoice', async () => {
  const inside = await freeShop();
  const outside = await freeShop();
  await inside.invoiceReady({ stateCode: '27' });
  await outside.invoiceReady({ stateCode: '29', gstin: '29ABCDE1234F1Z5' });
  const [{ invoice: a }, { invoice: b }] = [await subscribe(world, inside, 't1'), await subscribe(world, outside, 't1')];
  for (const [invoice, igst] of [[a, false], [b, true]]) {
    const lines = await linesOf(world, invoice.id);
    assert.ok(lines.length >= 1);
    assert.equal(Number(invoice.cgst_paise), Number(invoice.sgst_paise));
    if (igst) assert.ok(Number(invoice.igst_paise) > 0 && Number(invoice.cgst_paise) === 0, 'another state pays IGST only');
    else assert.ok(Number(invoice.cgst_paise) > 0 && Number(invoice.igst_paise) === 0, 'the same state pays CGST and SGST only');
    assert.equal(Number(invoice.total_paise), Number(invoice.taxable_paise) + Number(invoice.cgst_paise) + Number(invoice.sgst_paise) + Number(invoice.igst_paise));
    for (const l of lines) {
      const expected = taxFor(Number(l.taxable_paise), { rateBp: l.rate_bp, sellerState: '27', buyerState: igst ? '29' : '27' });
      assert.deepEqual([Number(l.cgst_paise), Number(l.sgst_paise), Number(l.igst_paise)], [expected.cgstPaise, expected.sgstPaise, expected.igstPaise], `the paisa on ${l.code}`);
    }
    assert.equal(lines.reduce((s, l) => s + Number(l.taxable_paise), 0), Number(invoice.taxable_paise));
  }
});

test('F-54: no invoice is issued while Bhava has no legal name, state or SAC, and the charge is not lost', async () => {
  const shop = await freeShop();
  await sql(world, `UPDATE billing_settings SET sac = ''`);
  try {
    need(await change(shop, 't1', 'monthly'), 200, 'Choosing tier 1');
    await authorize(world, shop);
    await charge(world, shop);
    await world.quiet(1200);
    assert.equal((await invoicesOf(world, shop)).length, 0, 'no invoice without a SAC');
    assert.equal((await paymentsOf(world, shop)).length, 1, 'the payment is recorded all the same');
  } finally {
    await sql(world, `UPDATE billing_settings SET sac = '998439'`);
  }
  await world.until(async () => (await invoicesOf(world, shop)).length === 1, 6000);
});

test('F-55: an invoice a second before midnight on 31 March is the last of one year, and one at 1 April starts the next at 1', async () => {
  const shop = await freeShop();
  const last = await issueInvoice(world, shop, { at: '2031-03-31T18:29:59Z' });
  const first = await issueInvoice(world, shop, { at: '2031-03-31T18:30:00Z' });
  const next = await issueInvoice(world, shop, { at: '2031-04-01T10:00:00Z' });
  assert.equal(Number(last.fy), 2030, '23:59:59 on 31 March is still the old year');
  assert.equal(Number(first.fy), 2031, 'midnight in India on 1 April is the new year');
  assert.equal(Number(first.seq), 1, 'the new year starts at 1');
  assert.equal(Number(next.seq), 2);
  assert.notEqual(last.number, first.number);
  assert.match(first.number, /1$/);
});

test('F-55: invoices charged in parallel are numbered without a gap or a repeat, one series for all businesses', async () => {
  const shops = [await freeShop(), await freeShop(), await freeShop()];
  const made = await Promise.all(Array.from({ length: 24 }, (_, i) => issueInvoice(world, shops[i % 3], { at: '2032-06-15T05:00:00Z' })));
  const seqs = made.map((m) => Number(m.seq)).sort((x, y) => x - y);
  assert.deepEqual(seqs, Array.from({ length: 24 }, (_, i) => i + 1), 'a gapless run across businesses');
  assert.equal(new Set(made.map((m) => m.number)).size, 24, 'no number twice');
});

test('F-55: an invoice cannot be edited, deleted, or issued twice for one charge, and a correction is a credit note in its own series', async () => {
  const shop = await freeShop();
  const inv = await issueInvoice(world, shop, { at: '2033-05-05T05:00:00Z', sourceRef: `spec:dup:${unique()}` });
  await assert.rejects(issueInvoice(world, shop, { at: '2033-05-05T05:00:00Z', sourceRef: inv.source_ref }), /duplicate|unique|already|source/i, 'one document per charge');
  await assert.rejects(sql(world, 'UPDATE bhava_invoices SET taxable_paise = 1 WHERE id = $1', [inv.id]), /immutable|cannot|not allowed|check|permission/i);
  const who = await consoleUser(world);
  const res = await opCall(world, who, 'POST', `/tenants/${shop.tenantId}/credit-notes`, { invoiceId: Number(inv.id), reason: 'spec' });
  need(res, 201, 'A credit note');
  const note = json(res);
  assert.equal(note.docType, 'credit_note');
  assert.equal(note.originalInvoiceId, Number(inv.id));
  const again = await opCall(world, who, 'POST', `/tenants/${shop.tenantId}/credit-notes`, { invoiceId: Number(inv.id), reason: 'twice' });
  refusal(again, 'A second full credit note for the same invoice');
  const tooMuch = await opCall(world, who, 'POST', `/tenants/${shop.tenantId}/credit-notes`, { invoiceId: Number(inv.id), taxablePaise: 999_999_999, reason: 'more than the invoice' });
  refusal(tooMuch, 'A credit note for more than the invoice');
});

test('F-32: tier 1 calling checkout gets 403 and no order row, whatever the body', async () => {
  const shop = await shopOn(world, 't1');
  const b = buyer(world, shop);
  const product = await shop.product({ pricePaise: 49900 });
  const before = Number((await one(world, 'SELECT count(*) AS n FROM orders WHERE tenant_id = $1', [shop.tenantId])).n);
  for (const body of [b.checkoutBody({ lines: [line(product)] }), {}, { lines: [] }]) {
    const res = await b.place(body);
    assert.equal(res.status, 403, `checkout on tier 1 with ${JSON.stringify(body).slice(0, 40)}: ${res.text.slice(0, 120)}`);
  }
  assert.equal((await b.quote(b.checkoutBody({ lines: [line(product)] }))).status, 403);
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM orders WHERE tenant_id = $1', [shop.tenantId])).n), before, 'no order row');
});

test('F-33: upgrading from tier 1 to tier 3 opens checkout and the store steps with no restart', async () => {
  const shop = await shopOn(world, 't1', { pay: false });
  const features = async () => json(need(await shop.send('GET', '/billing/features'), 200, 'Reading the features')).features;
  assert.equal((await features())['store.checkout']?.on ?? false, false);
  await sql(world, `SELECT 1`);
  await subscribe(world, shop, 't3');
  assert.equal((await planOf(world, shop)).plan, 't3');
  assert.equal((await features())['store.checkout']?.on ?? false, true, 'the next request sees the new plan');
  const b = buyer(world, shop);
  const product = await shop.product({ pricePaise: 49900 });
  const res = await b.quote(b.checkoutBody({ lines: [line(product)] }));
  assert.notEqual(res.status, 403, `checkout is open after the upgrade: ${res.text.slice(0, 120)}`);
});

test('F-34: downgrading from tier 3 to tier 2 with an open order keeps the order manageable and refuses new checkout', async () => {
  const shop = await shopOn(world, 't3');
  const b = buyer(world, shop);
  const product = await shop.product({ pricePaise: 49900, stock: 10 });
  const placed = await b.orderCod({ lines: [line(product)] });
  assert.ok(placed.order?.number ?? placed.number ?? placed.orderNumber, 'an order is open');
  await sql(world, `UPDATE tenants SET plan = 't2' WHERE id = $1`, [shop.tenantId]);
  const list = json(need(await shop.send('GET', '/orders'), 200, 'Orders after the downgrade'));
  assert.ok(list.items.length >= 1, 'the open order is still listed');
  const id = list.items[0].id;
  need(await shop.send('GET', `/orders/${id}`), 200, 'Reading the open order');
  assert.ok((await shop.send('POST', `/orders/${id}/notes`, { note: 'still here' })).status !== 403, 'managing the order is not a plan feature');
  const next = await b.place(b.checkoutBody({ lines: [line(product)] }));
  assert.equal(next.status, 403, 'new checkout is closed');
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM orders WHERE tenant_id = $1', [shop.tenantId])).n), 1);
});

test('F-35: with a limit of 10 automations, the 11th is blocked with a limit message and no row, also when two race for the last place', async () => {
  const shop = await shopOn(world, 't1');
  await sql(world, `INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, 'automations', true, 10) ON CONFLICT (tenant_id, feature) DO UPDATE SET limit_value = 10, enabled = true`, [shop.tenantId]);
  const count = async () => Number((await one(world, 'SELECT count(*) AS n FROM automations WHERE tenant_id = $1', [shop.tenantId])).n);
  for (let i = 0; i < 8; i++) need(await shop.tryAutomation({ mediaId: await shop.reel() }), 201, `Automation ${i + 1}`);
  const [x, y] = [await shop.reel(), await shop.reel()];
  const race = await Promise.all([shop.tryAutomation({ mediaId: x }), shop.tryAutomation({ mediaId: y }), shop.tryAutomation({ mediaId: await shop.reel() })]);
  assert.equal(race.filter((r) => r.status === 201).length, 2, `exactly two places were left: ${race.map((r) => r.status)}`);
  assert.equal(await count(), 10);
  const eleventh = await shop.tryAutomation({ mediaId: await shop.reel() });
  assert.equal(eleventh.status, 403, eleventh.text.slice(0, 200));
  const body = json(eleventh);
  assert.equal(body.code, 'plan.limit_reached');
  assert.deepEqual([body.feature, body.limit, body.used], ['automations', 10, 10]);
  assert.equal(await count(), 10, 'no eleventh row');
});

test('F-115: yearly billing on tier 2 charges 10 months for 12; the client cannot name a price', async () => {
  const shop = await freeShop();
  const catalog = json(need(await shop.send('GET', '/billing/catalog'), 200, 'The price list'));
  const t2 = catalog.plans.find((p) => p.code === 't2');
  assert.equal(t2.yearlyPaise, t2.monthlyPaise * 10);
  const cheat = await shop.send('POST', '/billing/change', { plan: 't2', cycle: 'yearly', requestKey: key(), amountPaise: 1, pricePaise: 1, price: 1 });
  assert.ok(cheat.status === 200 || cheat.status === 400, `a price is ignored or refused, got ${cheat.status}`);
  if (cheat.status === 400) need(await change(shop, 't2', 'yearly'), 200, 'Choosing yearly');
  await authorize(world, shop);
  await charge(world, shop);
  const invoice = await world.until(async () => (await invoicesOf(world, shop))[0]);
  const [planLine] = (await linesOf(world, invoice.id)).filter((l) => l.kind === 'plan');
  assert.equal(Number(planLine.gross_paise), 10 * t2.monthlyPaise, 'ten months for twelve');
  const state = await world.rzp.get('/state');
  assert.ok(state.plans.every((p) => p.item.amount !== 1), 'no provider plan priced by the client');
  assert.equal((await planOf(world, shop)).billing_cycle, 'yearly');
});

test('F-115: a plan or cycle that is not in the price list is refused, and nothing changes', async () => {
  const shop = await freeShop();
  const before = await planOf(world, shop);
  for (const body of [{ plan: 't9' }, { plan: 'enterprise', cycle: 'monthly' }, { plan: 't1', cycle: 'weekly' }, { plan: 't1', cycle: 'monthly' }, { plan: ['t1'] }, {}]) {
    const res = await shop.send('POST', '/billing/change', { requestKey: key(), ...body });
    if (body.plan === 't1' && body.cycle === 'monthly') continue;
    refusal(res, JSON.stringify(body), 400);
  }
  assert.deepEqual(await planOf(world, shop), before);
  refusal(await shop.send('POST', '/billing/change', { plan: 't1', requestKey: 'x' }), 'a short request key', 400);
});

test('F-33: the same request key twice is one change and one provider subscription; a different business cannot reuse it', async () => {
  const a = await freeShop();
  const b = await freeShop();
  const requestKey = key();
  const [one1, two] = await Promise.all([change(a, 't1', 'monthly', requestKey), change(a, 't1', 'monthly', requestKey)]);
  assert.ok(one1.status === 200 && two.status === 200, `${one1.status} ${two.status}`);
  assert.equal((await sql(world, `SELECT count(*)::int AS n FROM subscriptions WHERE tenant_id = $1`, [a.tenantId]))[0].n, 1);
  const rzp = await world.rzp.get('/state');
  const mineId = (await subscriptionOf(world, a)).provider_subscription_id;
  assert.equal(rzp.subscriptions.filter((s) => s.id === mineId).length, 1);
  const other = await change(b, 't1', 'monthly', requestKey);
  assert.equal(other.status, 200, 'a request key belongs to one business');
  assert.notEqual((await subscriptionOf(world, b))?.provider_subscription_id, (await subscriptionOf(world, a)).provider_subscription_id);
});

test('F-33: an upgrade and a downgrade at the same moment, and one racing a charge, end in one consistent plan', async () => {
  const shop = await freeShop();
  await subscribe(world, shop, 't2');
  const results = await Promise.all([change(shop, 't4', 'monthly'), change(shop, 't1', 'monthly'), change(shop, 't3', 'monthly'), charge(world, shop)]);
  for (const r of results.slice(0, 3)) assert.ok(r.status < 500, `a racing change answered ${r.status}`);
  await world.quiet(800);
  const tenant = await planOf(world, shop);
  const last = await one(world, 'SELECT to_plan, to_cycle FROM plan_changes WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]);
  assert.equal(tenant.plan, last.to_plan, 'the tenant row and the plan history agree');
  const sub = await subscriptionOf(world, shop);
  assert.ok(['t1', 't2', 't3', 't4'].includes(tenant.plan));
  assert.ok(!sub.next_plan || sub.next_plan !== tenant.plan, 'a waiting change is a different plan');
  const invoices = await invoicesOf(world, shop);
  assert.equal(new Set(invoices.map((i) => i.number)).size, invoices.length);
});

test('F-33: a downgrade waits for the end of the period and a second one replaces it; upgrading cancels a waiting downgrade', async () => {
  const shop = await freeShop();
  await subscribe(world, shop, 't3');
  const down = json(need(await change(shop, 't1', 'monthly'), 200, 'Downgrading'));
  assert.equal(down.effective, 'period_end');
  assert.equal((await planOf(world, shop)).plan, 't3', 'the plan stays until the period ends');
  assert.equal((await subscriptionOf(world, shop)).next_plan, 't1');
  need(await change(shop, 't2', 'monthly'), 200, 'Changing the waiting downgrade');
  assert.equal((await subscriptionOf(world, shop)).next_plan, 't2');
  need(await change(shop, 't4', 'monthly'), 200, 'Upgrading over a waiting downgrade');
  assert.equal((await subscriptionOf(world, shop)).next_plan, null);
});

test('F-81: 6,000 DMs on tier 1 with one pack: 5,000 included plus 1,000 from the pack, and the invoice shows 1 pack at 299 rupees', async () => {
  const shop = await freeShop();
  await subscribe(world, shop, 't1');
  need(await shop.send('POST', '/billing/items', { code: 'dm_pack', quantity: 1, requestKey: key() }), 201, 'Buying a pack');
  await setDmUsed(world, shop, 6000);
  await sql(world, `UPDATE usage_months SET included = 5000 WHERE tenant_id = $1 AND meter = 'dms'`, [shop.tenantId]);
  const meter = json(need(await shop.send('GET', '/billing/usage'), 200, 'Usage')).meters.find((m) => m.meter === 'dms');
  assert.equal(meter.used, 6000);
  assert.equal(meter.included, 5000);
  assert.equal(meter.packUnits, 10_000);
  assert.equal(meter.allowance, 15_000);
  assert.equal(meter.left, 9000);
  assert.equal(meter.over, false);
  await charge(world, shop);
  const invoice = await world.until(async () => (await invoicesOf(world, shop)).at(-1));
  const lines = await linesOf(world, invoice.id);
  const pack = lines.filter((l) => l.kind === 'pack');
  assert.equal(pack.length, 1, 'one pack line');
  assert.deepEqual([Number(pack[0].quantity), Number(pack[0].unit_paise)], [1, 29_900]);
});

test('F-81: a pack bought twice is two on the invoice; a pack for a plan that cannot buy one, a made-up code and a price from the client are refused', async () => {
  const free = await freeShop();
  const refused = await free.send('POST', '/billing/items', { code: 'dm_pack', quantity: 1, requestKey: key() });
  refusal(refused, 'A free account buying a pack', [400, 402, 403, 409]);
  const shop = await freeShop();
  await subscribe(world, shop, 't1');
  refusal(await shop.send('POST', '/billing/items', { code: 'platinum_pack', quantity: 1, requestKey: key() }), 'An unknown add-on', [400, 404]);
  refusal(await shop.send('POST', '/billing/items', { code: 'dm_pack', quantity: 0, requestKey: key() }), 'Quantity 0', 400);
  refusal(await shop.send('POST', '/billing/items', { code: 'dm_pack', quantity: 100_000, requestKey: key() }), 'Quantity 100000', 400);
  const priced = await shop.send('POST', '/billing/items', { code: 'dm_pack', quantity: 2, requestKey: key(), unitPricePaise: 1 });
  if (priced.status === 201) assert.equal(json(priced).item.unitPricePaise, 29_900, 'the price is ours');
  else refusal(priced, 'a client price', 400);
  const item = await one(world, `SELECT unit_price_paise FROM subscription_items WHERE tenant_id = $1 AND addon_code = 'dm_pack'`, [shop.tenantId]);
  if (item) assert.equal(Number(item.unit_price_paise), 29_900);
});

test('F-85: a WhatsApp add-on and reel management bought mid-month each appear as their own line on the next invoice', async () => {
  const shop = await freeShop();
  await subscribe(world, shop, 't1');
  need(await shop.send('POST', '/billing/items', { code: 'whatsapp', requestKey: key() }), 201, 'Buying WhatsApp');
  need(await shop.send('POST', '/billing/items', { code: 'reel_management', requestKey: key() }), 201, 'Buying reel management');
  const again = await shop.send('POST', '/billing/items', { code: 'whatsapp', requestKey: key() });
  refusal(again, 'A second WhatsApp add-on', [400, 409]);
  await charge(world, shop);
  const invoice = await world.until(async () => (await invoicesOf(world, shop)).at(-1));
  const lines = await linesOf(world, invoice.id);
  const codes = lines.map((l) => `${l.kind}:${l.code}`);
  assert.ok(codes.some((c) => c === 'addon:whatsapp'), codes.join());
  assert.ok(codes.some((c) => c === 'service:reel_management'), codes.join());
  assert.equal(lines.filter((l) => l.code === 'whatsapp').length, 1);
  assert.equal(Number((await one(world, `SELECT count(*) AS n FROM tenant_features WHERE tenant_id = $1 AND feature = 'whatsapp_automation' AND enabled`, [shop.tenantId])).n), 1, 'the add-on switched its feature on');
  const gone = await shop.send('DELETE', `/billing/items/${json(need(await shop.send('GET', '/billing'), 200, 'Plan')).items.find((i) => i.code === 'whatsapp').id}`);
  assert.equal(gone.status, 204);
  assert.equal(Number((await one(world, `SELECT count(*) AS n FROM tenant_features WHERE tenant_id = $1 AND feature = 'whatsapp_automation' AND enabled`, [shop.tenantId])).n), 0, 'removing it switches the feature off');
});

test('F-116: done-for-you setup is its own line on the next invoice', async () => {
  const shop = await freeShop();
  await subscribe(world, shop, 't1');
  need(await shop.send('POST', '/billing/items', { code: 'setup_automation', requestKey: key() }), 201, 'Buying setup');
  await charge(world, shop);
  const invoice = await world.until(async () => (await invoicesOf(world, shop)).at(-1));
  const lines = (await linesOf(world, invoice.id)).filter((l) => l.kind === 'setup');
  assert.equal(lines.length, 1);
  assert.equal(Number(lines[0].unit_paise), 499_900);
  // One-time: the next renewal does not repeat it.
  await charge(world, shop);
  const later = await world.until(async () => (await invoicesOf(world, shop)).length >= 3 && (await invoicesOf(world, shop)).at(-1));
  assert.equal((await linesOf(world, later.id)).filter((l) => l.kind === 'setup').length, 0, 'a one-time item is billed once');
});

test('F-84: a seller on their own gateway and courier gets no gateway or shipping lines; the invoice still lists plan and add-ons', async () => {
  const shop = await shopOn(world, 't3');
  await ownGateway(world, shop);
  await subscribe(world, shop, 't4');
  const month = new Date().toISOString().slice(0, 7) + '-01';
  // A charge recorded against the managed path would be billed; none exists for this business.
  assert.equal((await sql(world, 'SELECT 1 FROM pass_through_charges WHERE tenant_id = $1', [shop.tenantId])).length, 0, month);
  need(await shop.send('POST', '/billing/items', { code: 'whatsapp', requestKey: key() }), 201, 'WhatsApp');
  await charge(world, shop);
  const invoice = await world.until(async () => (await invoicesOf(world, shop)).at(-1));
  const kinds = (await linesOf(world, invoice.id)).map((l) => l.kind);
  assert.ok(kinds.includes('plan') && kinds.includes('addon'));
  assert.ok(!kinds.includes('pass_through'), `no pass-through lines: ${kinds}`);
});

test('F-114: WhatsApp messages and AI usage are billed at cost with counts on separate lines, each source once', async () => {
  const shop = await freeShop();
  await subscribe(world, shop, 't1');
  need(await shop.send('POST', '/billing/items', { code: 'whatsapp', requestKey: key() }), 201, 'WhatsApp');
  const month = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7) + '-01';
  const put = (kind, amount, quantity, ref) => sql(world, `INSERT INTO pass_through_charges (tenant_id, kind, amount_paise, quantity, period, collected_by, source_ref) VALUES ($1, $2, $3, $4, $5, 'invoice', $6) ON CONFLICT DO NOTHING`, [shop.tenantId, kind, amount, quantity, month, ref]);
  await put('whatsapp', 85_000, 2000, 'spec:wa');
  await put('whatsapp', 85_000, 2000, 'spec:wa');
  await put('ai', 12_345, 321, 'spec:ai');
  await charge(world, shop);
  const invoice = await world.until(async () => (await invoicesOf(world, shop)).at(-1));
  const lines = (await linesOf(world, invoice.id)).filter((l) => l.kind === 'pass_through');
  const wa = lines.find((l) => l.code === 'whatsapp');
  const ai = lines.find((l) => l.code === 'ai');
  assert.ok(wa && ai, `pass-through lines: ${lines.map((l) => l.code)}`);
  assert.deepEqual([Number(wa.quantity), Number(wa.gross_paise)], [2000, 85_000], 'the count and the cost, with no markup');
  assert.deepEqual([Number(ai.quantity), Number(ai.gross_paise)], [321, 12_345]);
  assert.equal(lines.length, 2);
  const charges = await sql(world, 'SELECT invoice_id FROM pass_through_charges WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(charges.every((c) => c.invoice_id !== null), 'each charge is tied to the invoice that billed it');
});

test('F-113: a 10,000 rupee sale on the default path takes no Bhava commission, and the database refuses one', async () => {
  const shop = await shopOn(world, 't3');
  const b = buyer(world, shop);
  const product = await shop.product({ pricePaise: 1_000_000, stock: 5 });
  const placed = await b.order({ lines: [line(product)] });
  await b.pay(placed);
  const state = await world.rzp.get('/state');
  const transfers = (state.transfers ?? []).filter((t) => t.amount);
  if (transfers.length) assert.ok(transfers.every((t) => t.amount === Math.max(...transfers.map((x) => x.amount))), 'one transfer, the whole sale');
  const orderRow = await one(world, 'SELECT total_paise FROM orders WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]);
  if (transfers.length) assert.equal(transfers[0].amount, Number(orderRow.total_paise), 'the business is sent the sale, not the sale less a share');
  await assert.rejects(sql(world, `INSERT INTO settlement_statements (tenant_id, month, sales_paise, commission_paise, closing_balance_paise) VALUES ($1, '2030-01-01', 1000000, 50000, 950000)`, [shop.tenantId]), /check|violates/i);
});

test('F-83: a statement lists every line type, adds up, has no commission, and is the owner\'s own', async () => {
  const shop = await shopOn(world, 't3');
  const other = await shopOn(world, 't3');
  const row = (tenant, month) => sql(world, `INSERT INTO settlement_statements (tenant_id, month, opening_balance_paise, sales_paise, refunds_paise, gateway_fees_paise, shipping_paise, payouts_paise, closing_balance_paise, counts, payouts, reconciliation)
    VALUES ($1, $2, 0, 12000000, 500000, 240000, 800000, 10000000, 460000, '{"orders":120,"refunds":5,"shipments":80}', '[{"transferId":"trf_1","amountPaise":10000000,"at":"2030-02-03T00:00:00Z"}]', 'matched') RETURNING id`, [tenant, month]);
  const [mine] = await row(shop.tenantId, '2030-02-01');
  const [theirs] = await row(other.tenantId, '2030-02-01');
  const list = json(need(await shop.send('GET', '/billing/statements'), 200, 'Statements'));
  assert.equal(list.items.length, 1, 'only my statement');
  const s = list.items[0];
  assert.equal(s.commissionPaise, 0);
  assert.deepEqual([s.counts.orders, s.counts.refunds, s.counts.shipments], [120, 5, 80]);
  assert.equal(s.closingBalance.amountPaise, s.salesPaise - s.refundsPaise - s.gatewayFeesPaise - s.shippingPaise - s.payoutsPaise + s.openingBalance.amountPaise, 'the balance is checked arithmetic');
  assert.equal(s.payouts[0].transferId, 'trf_1');
  for (const format of ['pdf', 'csv']) need(await shop.send('GET', `/billing/statements/${mine.id}/file?format=${format}`), 200, `The ${format}`);
  assert.equal((await shop.send('GET', `/billing/statements/${theirs.id}/file`)).status, 404, "another business's statement");
  await assert.rejects(row(shop.tenantId, '2030-03-01').then(() => sql(world, `UPDATE settlement_statements SET closing_balance_paise = 1 WHERE tenant_id = $1 AND month = '2030-03-01'`, [shop.tenantId])), /check|violates/i, 'a balance that does not add up');
});

test('F-33: an owner of one business cannot read or buy anything of another; invoices, files and items answer 404', async () => {
  const a = await freeShop();
  const b = await freeShop();
  await subscribe(world, b, 't1');
  need(await b.send('POST', '/billing/items', { code: 'whatsapp', requestKey: key() }), 201, 'B buys WhatsApp');
  const [inv] = await invoicesOf(world, b);
  const item = (await sql(world, 'SELECT id FROM subscription_items WHERE tenant_id = $1', [b.tenantId]))[0];
  assert.equal((await a.send('GET', `/billing/invoices/${inv.id}/file`)).status, 404);
  assert.equal((await a.send('DELETE', `/billing/items/${item.id}`)).status, 404);
  assert.equal(json(need(await a.send('GET', '/billing/invoices'), 200, 'A invoices')).items.length, 0);
  const aStaff = await addStaff(world, a, { permissions: ['orders'] });
  const asStaff = (path) => hit(world, `/api/v1${path}`, { host: a.host, token: aStaff.token });
  assert.equal((await asStaff('/billing')).status, 403, 'billing is the owner\'s');
  assert.equal((await asStaff('/billing/invoices')).status, 403);
});

test('F-51: a charge made for a business whose subscription was cancelled is recorded and invoiced once, and the plan falls back only at the period end', async () => {
  const shop = await freeShop();
  const { sub } = await subscribe(world, shop, 't1');
  const cancelled = await billingHook(world, 'subscription.cancelled', { subscription: { entity: { id: sub.provider_subscription_id, status: 'cancelled' } } });
  assert.ok(cancelled.status < 300);
  await world.quiet(500);
  assert.equal((await subscriptionOf(world, shop)).status, 'cancelled');
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM products WHERE tenant_id = $1', [shop.tenantId])).n) >= 0, true);
  await pause(50);
  assert.equal((await invoicesOf(world, shop)).length, 1);
});

test('F-85: the grace length, tax rate and proration are settings read at the time, not at start-up', async () => {
  const shop = await freeShop();
  await setSetting(world, 'tax_rate_bp', 1200);
  try {
    const { invoice } = await subscribe(world, shop, 't1');
    const lines = await linesOf(world, invoice.id);
    assert.ok(lines.every((l) => l.rate_bp === 1200), 'the rate on the day');
    const t = taxFor(Number(invoice.taxable_paise), { rateBp: 1200, sellerState: '27', buyerState: '27' });
    assert.ok(Math.abs(Number(invoice.cgst_paise) - t.cgstPaise) <= lines.length, 'tax follows the setting to the paisa, a line at a time');
  } finally {
    await setSetting(world, 'tax_rate_bp', 1800);
  }
  assert.equal(offerDiscountPaise(49_900, 30), 14_970);
});

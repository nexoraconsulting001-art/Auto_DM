// What must hold when things happen at once (PRD 5.12): invoice numbers never repeat or skip under concurrent charges and
// start again at 1 on 1 April (F-55); an issued invoice never changes; the launch offer's last place goes to one account;
// two plan changes at once leave one plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingFor } from '../../../src/modules/billing/index.js';
import { taxedLine } from '../../../src/modules/billing/money.js';
import { cleanBillingEvent, createBillingWebhooks } from '../../../src/modules/billing/webhooks.js';
import { BILLING_WEBHOOK } from '../../../src/contracts/billing.js';
import { openBilling } from './support.js';

test('invoice numbers: concurrent charges take 1..n with no gap and no repeat; 1 April starts the year again at 1 (F-55)', async (t) => {
  const w = await openBilling(t);
  const shops = [];
  for (let i = 0; i < 5; i++) shops.push(await w.business({ state: i % 2 ? '27' : '29' }));
  for (const shop of shops) assert.equal((await shop.change('t1')).status, 200);
  const subs = await Promise.all(shops.map((s) => s.sub()));
  for (const s of subs) await w.rzp.post('/subscriptions/authorize', { id: s.provider_subscription_id });
  await Promise.all(subs.map((s) => w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, duplicates: 2 })));
  await w.settle();
  const all = await w.sql(`SELECT fy, seq, number FROM bhava_invoices WHERE doc_type = 'invoice' ORDER BY seq`);
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((r) => r.seq), [1, 2, 3, 4, 5]);
  assert.equal(new Set(all.map((r) => r.number)).size, 5);

  // 31 March and 1 April in India: the second is number 1 of the new financial year. The caller's own number is ignored.
  const shop = shops[0];
  const service = billingFor(w.app.ctx);
  const settings = await service.settingsOf(w.app.db.platform);
  const buyer = { legalName: 'Shop', gstin: '', stateCode: '29', address: '' };
  const line = taxedLine({ kind: 'setup', code: 'setup_automation', description: 'Done for you', grossPaise: 499900, rateBp: 1800, sellerState: '29', placeOfSupply: '29' });
  const issueAt = (sourceRef, issuedAt) => shop.in(() => w.app.db.tx((tx) => service.issue(tx, { sourceRef, lines: [line], settings, buyer, placeOfSupply: '29', issuedAt })));
  const march = await issueAt('test:march', '2027-03-31T23:30:00+05:30');
  const april = await issueAt('test:april', '2027-04-01T00:15:00+05:30');
  const april2 = await issueAt('test:april2', '2027-04-01T09:00:00+05:30');
  assert.deepEqual([march.fy, april.fy, april.seq, april2.seq], [2026, 2027, 1, 2]);
  assert.match(april.number, /^BH\/27-28\/00001$/);
  // The same source twice is refused before a number is taken: the next one is still 3.
  await assert.rejects(issueAt('test:april2', '2027-04-02T09:00:00+05:30'), /already a document|duplicate|unique/i);
  assert.equal((await issueAt('test:april3', '2027-04-02T10:00:00+05:30')).seq, 3);

  // Issued is final: no column but the file can change, and a line added later breaks the sum and is refused.
  await assert.rejects(shop.in(() => w.app.db.query('UPDATE bhava_invoices SET total_paise = total_paise + 1 WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, march.id])), /cannot be changed|frozen|check/i);
  await assert.rejects(shop.in(() => w.app.db.query(`UPDATE bhava_invoices SET number = 'BH/26-27/99999' WHERE tenant_id = $1 AND id = $2`, [shop.tenant.id, march.id])), /cannot be changed|frozen|check/i);
  await assert.rejects(shop.in(() => w.app.db.query('DELETE FROM bhava_invoices WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, march.id])), /permission|denied|42501|policy|row-level/i);
  await assert.rejects(shop.in(() => w.app.db.query(
    `INSERT INTO bhava_invoice_lines (tenant_id, invoice_id, position, kind, code, description, gross_paise, taxable_paise, rate_bp) VALUES ($1, $2, 9, 'addon', 'x', 'later', 100, 100, 0)`,
    [shop.tenant.id, march.id],
  )), /add up|check/i);
  // There is no such thing as a commission line.
  await assert.rejects(shop.in(() => w.app.db.tx(async (tx) => {
    const [doc] = await tx.query(`INSERT INTO bhava_invoices (tenant_id, doc_type, fy, seq, number, source_ref, seller, buyer, place_of_supply, taxable_paise, total_paise) VALUES ($1, 'invoice', 0, 0, '', 'test:commission', '{}', '{}', '29', 100, 100) RETURNING id`, [shop.tenant.id]);
    await tx.query(`INSERT INTO bhava_invoice_lines (tenant_id, invoice_id, position, kind, code, description, gross_paise, taxable_paise, rate_bp) VALUES ($1, $2, 1, 'commission', 'sales', 'Commission', 100, 100, 0)`, [shop.tenant.id, doc.id]);
  })), /check|kind/i);
});

test('the launch offer: when one place is left and two accounts pay at once, exactly one gets it', async (t) => {
  const w = await openBilling(t);
  const shops = [];
  for (let i = 0; i < 4; i++) shops.push(await w.business({ state: '29' }));
  // 99 places already taken by earlier accounts: the 100th and the 101st arrive together, with two more behind them.
  await w.sql(`UPDATE offers SET claimed = max_accounts - 1 WHERE code = 'launch'`);
  const answers = await Promise.all(shops.map((s) => s.change('t1')));
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200]);
  const offers = (await Promise.all(shops.map((s) => s.sub()))).map((s) => s.offer_code);
  assert.equal(offers.filter((o) => o === 'launch').length, 1, 'one place, one account');
  assert.equal((await w.one(`SELECT claimed, max_accounts FROM offers WHERE code = 'launch'`)).claimed, 100);
  assert.equal((await w.one(`SELECT count(*)::int AS n FROM offer_claims`)).n, 1);
  // The ones without it are charged the full price.
  const full = shops[offers.findIndex((o) => o !== 'launch')];
  const out = await full.charge();
  const [line] = await full.lines((await full.invoices())[0].id);
  assert.equal(Number(line.discount_paise), 0);
  assert.equal(Number((await full.invoices())[0].total_paise), out.payment.amount);
  // The catalog says no offer is left.
  assert.equal((await full.api('GET', '/billing/catalog')).json.offer, null);
});

test('two plan changes at once leave one plan: the subscription’s and the business’s agree, and every change is recorded', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const [a, b] = await Promise.all([shop.change('t2'), shop.change('t3')]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const s = await shop.sub();
  const tenant = await shop.tenantRow();
  assert.ok(['t2', 't3'].includes(s.plan));
  assert.equal(tenant.plan, s.plan, 'one plan');
  const last = await w.one('SELECT to_plan FROM plan_changes WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenant.id]);
  assert.equal(last.to_plan, tenant.plan);
  const provider = await w.rzp.get(`/v1/subscriptions/${s.provider_subscription_id}`).catch(() => null);
  if (provider?.plan_id) {
    const p = await w.one('SELECT plan_code FROM provider_plans WHERE provider_plan_id = $1', [provider.plan_id]);
    assert.equal(p.plan_code, s.plan, 'and the provider charges for the same plan');
  }

  // A downgrade waits for the period's end; the same request again changes nothing more.
  const down = await shop.change('t1');
  assert.deepEqual([down.status, down.json.effective, down.json.plan.nextPlan], [200, 'period_end', 't1']);
  assert.equal((await shop.change('t1')).json.effective, 'period_end');
  assert.equal((await shop.tenantRow()).plan, s.plan, 'still on the paid plan until the period ends');
  // The renewal charges the lower plan, and the plan follows.
  await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id });
  await w.settle();
  assert.equal((await shop.tenantRow()).plan, 't1');
  assert.equal((await shop.sub()).next_plan, null);
});

test('two drainers at once (the web app and the worker) apply each billing event once and in order: a failure older than the charge before it stays stale (F-51)', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business();
  assert.equal((await shop.change('t1')).status, 200);
  const s = await shop.sub();
  await w.rzp.post('/subscriptions/authorize', { id: s.provider_subscription_id });
  await w.settle();
  // Two events stored and not yet worked through, as a busy minute leaves them: a charge, then a failure from an hour earlier.
  const nowSecs = Math.floor(Date.now() / 1000);
  const store = (event, createdAt, entities) => w.sql(
    `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload) VALUES ('razorpay', $1, $2, $3, $4::jsonb) RETURNING id`,
    [BILLING_WEBHOOK.scope, `evt_race_${event}_${createdAt}`, event, JSON.stringify(cleanBillingEvent({ event, created_at: createdAt, payload: entities }))],
  );
  await store('subscription.charged', nowSecs, {
    subscription: { entity: { id: s.provider_subscription_id, status: 'active', current_start: nowSecs, current_end: nowSecs + 30 * 86_400 } },
    payment: { entity: { id: 'pay_race_charge', amount: 59_882, currency: 'INR', status: 'captured', method: 'card', created_at: nowSecs } },
  });
  await store('subscription.pending', nowSecs - 3600, {
    subscription: { entity: { id: s.provider_subscription_id, status: 'pending' } },
    payment: { entity: { id: 'pay_race_failed', amount: 1, status: 'failed', method: 'card', created_at: nowSecs - 3600 } },
  });
  const app = billingFor(w.app.ctx);
  const worker = createBillingWebhooks(w.app.ctx, app);
  await Promise.all([app.webhooks.drain(), worker.drain(), app.webhooks.drain(), worker.drain()]);
  await w.settle();

  const events = (await w.events()).filter((e) => String(e.event_id).startsWith('evt_race_')).map((e) => [e.event_type, e.status, e.outcome]);
  assert.deepEqual(events, [['subscription.charged', 'processed', 'processed'], ['subscription.pending', 'ignored', 'stale']], 'each event worked through once, the charge first');
  const payments = (await shop.payments()).map((p) => [p.provider_payment_id, p.status]);
  assert.deepEqual(payments.filter(([id]) => id.startsWith('pay_race_')), [['pay_race_charge', 'captured'], ['pay_race_failed', 'failed']]);
  const after = await shop.sub();
  assert.deepEqual([after.status, after.grace_until], ['active', null], 'the older failure leaves the charged subscription active');
});

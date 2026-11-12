// The Phase 7 tables (migrations 700 and 701): the price list as data with the PRD's current values, the fence on every
// business table, and each rule the database holds behind the code, tried with SQL that goes round the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, SIGNUP_STEPS, financialYearOf, usageMonthOf } from '../../../src/contracts/billing.js';
import { withTenant } from '../../../src/tenancy.js';
import { otherBusiness, refusal, world } from '../../p4/contract/support.js';

const TENANT_TABLES = [
  'subscriptions', 'subscription_items', 'plan_changes', 'offer_claims', 'tenant_flags', 'bhava_invoices', 'bhava_invoice_lines', 'billing_payments', 'usage_events',
  'usage_months', 'pass_through_charges', 'settlement_statements', 'seller_referral_codes', 'seller_referrals',
];
/** Business code may read these and nothing more: they are written through db.platform or by the database itself. */
const READ_ONLY = ['plan_changes', 'offer_claims', 'tenant_flags', 'seller_referrals'];
const NEVER_DELETED = ['subscriptions', 'subscription_items', 'bhava_invoices', 'bhava_invoice_lines', 'billing_payments', 'usage_events', 'usage_months', 'pass_through_charges', 'settlement_statements'];
const READABLE_PLATFORM = ['plan_prices', 'addons', 'offers', 'billing_settings', 'feature_flags'];
const HIDDEN_PLATFORM = ['provider_plans', 'signup_settings', 'signup_invites', 'signup_steps', 'bhava_invoice_sequences'];

const sql = (w, text, params) => w.db.platform.query(text, params);
const asBusiness = (w, text, params, tenant = w.tenant) => withTenant(tenant, () => w.db.query(text, params));
const PARTY = JSON.stringify({ legalName: 'A', gstin: '', stateCode: '27', address: '' });

/** One invoice with one line, written in one transaction as the business, as the billing module will. `over` changes the invoice row. */
async function invoice(w, { tenant = w.tenant, sourceRef, issuedAt = '2026-11-12T10:00:00+05:30', taxable = 49900, igst = 8982, lines = 1, over = {} } = {}) {
  return withTenant(tenant, () => w.db.tx(async (t) => {
    const row = { tenant_id: tenant.id, doc_type: 'invoice', source_ref: sourceRef, issued_at: issuedAt, seller: PARTY, buyer: PARTY, place_of_supply: '29', taxable_paise: taxable, igst_paise: igst, total_paise: taxable + igst, fy: 1, seq: 999, number: 'CHOSEN', ...over };
    const columns = Object.keys(row);
    const [created] = await t.query(`INSERT INTO bhava_invoices (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, columns.map((c) => row[c]));
    for (let i = 1; i <= lines; i++) {
      await t.query(
        `INSERT INTO bhava_invoice_lines (tenant_id, invoice_id, position, kind, code, description, gross_paise, taxable_paise, rate_bp, igst_paise) VALUES ($1, $2, $3, 'plan', 't1', 'Automation plan', $4, $4, 1800, $5)`,
        [tenant.id, created.id, i, taxable / lines, igst / lines],
      );
    }
    return created;
  }));
}

test('the price list is data, with the current values of PRD 3 and 5.12 as its defaults', async () => {
  const w = await world();
  const prices = Object.fromEntries((await sql(w, 'SELECT plan_code, cycle, amount_paise FROM plan_prices')).map((r) => [`${r.plan_code}.${r.cycle}`, Number(r.amount_paise)]));
  assert.deepEqual(Object.keys(prices).sort(), PLANS.flatMap((p) => [`${p}.monthly`, `${p}.yearly`]).sort());
  assert.deepEqual(PLANS.map((p) => prices[`${p}.monthly`]), [0, 49900, 149900, 399900, 699800, 999700]);
  const [settings] = await sql(w, 'SELECT * FROM billing_settings');
  for (const plan of PLANS) assert.equal(prices[`${plan}.yearly`], prices[`${plan}.monthly`] * settings.yearly_months, `F-115: ${plan} yearly is 10 months' fee`);
  assert.deepEqual(
    [settings.yearly_months, settings.tax_rate_bp, settings.statement_day, settings.grace_days, settings.after_grace, settings.proration, settings.free_can_buy_packs, settings.dm_alert_percents, Number(settings.referral_reward_paise)],
    [10, 1800, 5, 7, 'suspend', 'none', false, [80, 100], 0],
  );
  assert.deepEqual([settings.legal_name, settings.sac, settings.state_code], ['', '', ''], 'the legal entity and the SAC are set in the console, not guessed');

  const addons = Object.fromEntries((await sql(w, 'SELECT * FROM addons')).map((r) => [r.code, r]));
  const row = (code) => [addons[code].kind, Number(addons[code].price_paise), addons[code].cycle, addons[code].feature, addons[code].min_plan, addons[code].included_from];
  assert.deepEqual(row('story_dm_triggers'), ['addon', 19900, 'monthly', 'triggers.story_dm', 't1', 't3']);
  assert.deepEqual(row('whatsapp'), ['addon', 99900, 'monthly', 'whatsapp_automation', 't1', null]);
  assert.deepEqual(row('ai_replies'), ['addon', 99900, 'monthly', 'ai_replies', 't1', null]);
  assert.deepEqual(row('loyalty'), ['addon', 49900, 'monthly', 'loyalty', 't3', 't4']);
  assert.deepEqual(row('extra_seat'), ['addon', 19900, 'monthly', 'staff.seats', 't1', null]);
  assert.deepEqual([...row('dm_pack'), addons.dm_pack.meter, addons.dm_pack.units, addons.dm_pack.many], ['pack', 29900, 'monthly', null, 't1', null, 'dms', 10000, true]);
  assert.deepEqual(row('reel_management'), ['service', 300000, 'monthly', 'service.reel_management', 't1', null]);
  assert.deepEqual(row('reel_backlog'), ['service', 1500000, 'one_time', 'service.reel_backlog', 't1', null]);
  assert.deepEqual(row('merchandising'), ['service', 300000, 'monthly', 'service.merchandising', 't2', null]);
  assert.deepEqual(row('catalog_management'), ['service', 400000, 'monthly', 'service.catalog_management', 't3', null]);
  assert.deepEqual(row('performance_report'), ['service', 100000, 'monthly', 'service.performance_report', 't1', 't2']);
  assert.deepEqual(['setup_automation', 'setup_catalog', 'setup_store', 'setup_app_android', 'setup_app_ios'].map((c) => [addons[c].kind, Number(addons[c].price_paise), addons[c].cycle]),
    [['setup', 499900, 'one_time'], ['setup', 1499900, 'one_time'], ['setup', 4999900, 'one_time'], ['setup', 4999900, 'one_time'], ['setup', 4999900, 'one_time']]);
  assert.deepEqual([addons.whatsapp.pass_through, addons.ai_replies.pass_through], ['whatsapp', 'ai'], 'billed at cost on top of the price');

  const [offer] = await sql(w, `SELECT * FROM offers WHERE code = 'launch'`);
  assert.deepEqual([offer.percent_off, offer.max_accounts, offer.claimed, offer.for_life], [30, 100, 0, true]);
  assert.deepEqual((await sql(w, 'SELECT mode, free_per_instagram FROM signup_settings')), [{ mode: 'invite', free_per_instagram: 1 }]);
  assert.deepEqual((await sql(w, 'SELECT code FROM plans ORDER BY rank')).map((r) => r.code), PLANS, 'the ladder is ranked in the database');
  assert.equal(await refusal(sql(w, `INSERT INTO signup_steps (run_id, step) VALUES (1, 'imagined')`)) !== null, true);
  assert.equal(SIGNUP_STEPS.length, 7);
});

test('which plan has which Phase 7 feature', async () => {
  const w = await world();
  const plansOf = async (feature) => (await sql(w, 'SELECT plan_code FROM plan_features WHERE feature = $1 ORDER BY plan_code', [feature])).map((r) => r.plan_code);
  assert.deepEqual(await plansOf('badge.made_with'), ['free'], 'U-07, U-08: the mark is on the free plan only');
  assert.deepEqual(await plansOf('service.performance_report'), ['t2', 't3', 't4', 't5'], 'included from tier 2');
  assert.deepEqual(await plansOf('staff.seats'), [...PLANS].sort());
  for (const addonOnly of ['ai_replies', 'whatsapp_automation', 'service.reel_management', 'service.reel_backlog', 'service.merchandising', 'service.catalog_management']) {
    assert.deepEqual(await plansOf(addonOnly), [], `${addonOnly} is in no plan: an add-on turns it on`);
    assert.equal((await sql(w, 'SELECT 1 FROM addons WHERE feature = $1', [addonOnly])).length, 1, `${addonOnly} has its add-on`);
  }
  const limits = Object.fromEntries((await sql(w, `SELECT plan_code, limit_value FROM plan_features WHERE feature = 'dms.monthly'`)).map((r) => [r.plan_code, r.limit_value]));
  assert.deepEqual(PLANS.map((p) => limits[p]), [500, 5000, 15000, 50000, 50000, 50000], 'included DMs a month');
});

test('every business table is fenced; the price list is read-only to business code; the rest of the platform tables are out of reach', async () => {
  const w = await world();
  const other = await otherBusiness(w);
  for (const table of TENANT_TABLES) {
    const [column] = await sql(w, `SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id'`, [table]);
    assert.equal(column?.is_nullable, 'NO', `${table}.tenant_id`);
    const [policy] = await sql(w, `SELECT 1 AS ok FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_fence'`, [table]);
    assert.ok(policy, `${table} has the fence`);
    const grants = (await sql(w, `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'bhava_app' AND table_name = $1`, [table])).map((r) => r.privilege_type);
    assert.ok(grants.includes('SELECT'), `${table} can be read`);
    if (READ_ONLY.includes(table)) assert.deepEqual(grants, ['SELECT'], `${table} is read-only to business code`);
    if (NEVER_DELETED.includes(table)) assert.equal(grants.includes('DELETE'), false, `${table} is never deleted by business code`);
  }
  for (const table of READABLE_PLATFORM) {
    assert.ok(Array.isArray(await asBusiness(w, `SELECT * FROM ${table} LIMIT 1`)), `${table} can be read`);
    assert.match(String(await refusal(asBusiness(w, `DELETE FROM ${table}`))), /42501|permission denied/, `${table} cannot be written`);
  }
  for (const table of HIDDEN_PLATFORM) assert.match(String(await refusal(asBusiness(w, `SELECT * FROM ${table} LIMIT 1`))), /42501|permission denied/, `${table} is out of reach`);
  assert.match(String(await refusal(asBusiness(w, `UPDATE plan_prices SET amount_paise = 1`))), /42501|permission denied/, 'a business cannot change a price');

  // One business never sees another's rows.
  await invoice(w, { sourceRef: 'charge:pay_a' });
  await asBusiness(w, `INSERT INTO subscriptions (tenant_id, plan) VALUES ($1, 't1')`, [w.tenant.id]);
  for (const table of ['bhava_invoices', 'bhava_invoice_lines', 'subscriptions']) {
    assert.equal((await asBusiness(w, `SELECT 1 FROM ${table}`)).length, 1, table);
    assert.deepEqual(await asBusiness(w, `SELECT 1 FROM ${table}`, [], other.tenant), [], `${table}: nothing of another business`);
  }
  assert.notEqual(await refusal(asBusiness(w, `INSERT INTO subscriptions (tenant_id, plan) VALUES ($1, 't1')`, [other.tenant.id])), null, 'and cannot write a row for another');
  assert.equal(await refusal(sql(w, `INSERT INTO provider_webhook_events (provider, scope, event_id, payload) VALUES ('razorpay', 'billing', 'evt_1', '{}')`)), null, 'billing webhooks have their own scope');
  assert.notEqual(await refusal(sql(w, `INSERT INTO provider_webhook_events (provider, scope, event_id, payload) VALUES ('razorpay', 'billing', 'evt_1', '{}')`)), null, 'and an event id is stored once');
});

test('every plan change is recorded: a plan_changes row moves the plan, and a plan moved directly still gets its row', async () => {
  const w = await world();
  await sql(w, `INSERT INTO plan_changes (tenant_id, from_plan, to_plan, from_cycle, to_cycle, actor, source, reason) VALUES ($1, 't5', 't3', 'yearly', 'yearly', 'platform:7', 'console', 'trial')`, [w.tenant.id]);
  assert.deepEqual(await sql(w, 'SELECT plan, billing_cycle FROM tenants WHERE id = $1', [w.tenant.id]), [{ plan: 't3', billing_cycle: 'yearly' }], 'F-33: the plan the entitlements read moved with it');
  assert.equal(await w.inTenant(() => w.repos.entitlements.can('store.checkout')), true, 'and applies to the next read');
  await sql(w, `UPDATE tenants SET plan = 't2' WHERE id = $1`, [w.tenant.id]);
  const rows = await sql(w, 'SELECT from_plan, to_plan, from_cycle, to_cycle, actor, source FROM plan_changes WHERE tenant_id = $1 ORDER BY id', [w.tenant.id]);
  assert.deepEqual(rows, [
    { from_plan: 'free', to_plan: 't3', from_cycle: 'monthly', to_cycle: 'yearly', actor: 'platform:7', source: 'console' },
    { from_plan: 't3', to_plan: 't2', from_cycle: 'yearly', to_cycle: 'yearly', actor: 'system:direct', source: 'direct' },
  ], 'the database reads where the plan came from itself; nobody can misreport it');
  assert.match(String(await refusal(asBusiness(w, `INSERT INTO plan_changes (tenant_id, from_plan, to_plan, from_cycle, to_cycle, actor, source) VALUES ($1, 't2', 't5', 'monthly', 'monthly', 'user:1', 'owner')`, [w.tenant.id]))), /42501|permission denied/, 'a business cannot give itself a plan');
  assert.equal((await asBusiness(w, 'SELECT 1 FROM plan_changes')).length, 2, 'but can read its own history');
});

test('the launch offer is counted in the database: the place after the last gets nothing', async () => {
  const w = await world();
  await sql(w, `UPDATE offers SET max_accounts = 2 WHERE code = 'launch'`);
  const claim = (tenant) => withTenant(tenant, async () => (await w.db.query(`SELECT claim_offer('launch') AS ok`))[0].ok);
  const b = (await otherBusiness(w, 'second')).tenant;
  const c = (await otherBusiness(w, 'third')).tenant;
  assert.equal(await claim(w.tenant), true);
  assert.equal(await claim(w.tenant), true, 'asking again is the same place');
  assert.deepEqual(await Promise.all([claim(b), claim(c)]).then((r) => r.sort()), [false, true], 'two at once for the last place: one gets it');
  assert.equal((await sql(w, `SELECT claimed FROM offers WHERE code = 'launch'`))[0].claimed, 2);
  assert.equal((await sql(w, 'SELECT 1 FROM offer_claims')).length, 2);
  assert.equal(await refusal(sql(w, `UPDATE offers SET claimed = 3 WHERE code = 'launch'`)), 'offers_not_over_claimed');
  assert.match(String(await refusal(asBusiness(w, `INSERT INTO offer_claims (tenant_id, offer_code) VALUES ($1, 'launch')`, [c.id], c))), /42501|permission denied/, 'no way round the count');
  await assert.rejects(() => w.db.platform.query(`SELECT claim_offer('launch')`), /current business/);
});

test('invoices: one series for all of us per financial year with no gap, immutable, and equal to their lines', async () => {
  const w = await world();
  const other = await otherBusiness(w);
  const first = await invoice(w, { sourceRef: 'charge:pay_1' });
  const second = await invoice(w, { tenant: other.tenant, sourceRef: 'charge:pay_2' });
  assert.deepEqual([first.number, second.number], ['BH/26-27/00001', 'BH/26-27/00002'], 'the caller chooses no number, and two businesses share the one series');
  assert.equal(first.fy, financialYearOf(new Date('2026-11-12T10:00:00+05:30')));

  // F-51: the same charge again is refused before a number is used.
  assert.equal(await refusal(invoice(w, { sourceRef: 'charge:pay_1' })), 'bhava_invoices_tenant_id_source_ref_key');
  assert.equal((await invoice(w, { sourceRef: 'charge:pay_3' })).number, 'BH/26-27/00003', 'no gap after the refusal');

  // F-55: 31 March and 1 April.
  const march = await invoice(w, { sourceRef: 'charge:pay_mar', issuedAt: '2027-03-31T23:30:00+05:30' });
  const april = await invoice(w, { sourceRef: 'charge:pay_apr', issuedAt: '2027-04-01T00:30:00+05:30' });
  assert.deepEqual([march.number, april.number], ['BH/26-27/00004', 'BH/27-28/00001']);

  // The totals are the lines' sum at commit.
  assert.equal(await refusal(invoice(w, { sourceRef: 'charge:no_lines', lines: 0 })), 'bhava_invoice_adds_up');
  assert.equal(await refusal(invoice(w, { sourceRef: 'charge:wrong', over: { taxable_paise: 50000, total_paise: 58982 } })), 'bhava_invoice_adds_up');
  assert.equal(await refusal(asBusiness(w, `INSERT INTO bhava_invoice_lines (tenant_id, invoice_id, position, kind, code, description, gross_paise, taxable_paise, rate_bp) VALUES ($1, $2, 9, 'addon', 'whatsapp', 'Added later', 100, 100, 1800)`, [w.tenant.id, first.id])), 'bhava_invoice_adds_up', 'a line cannot be added later');
  assert.equal((await invoice(w, { sourceRef: 'charge:after' })).number, 'BH/26-27/00005', 'none of the three refusals used a number');

  // Immutable: only the file may be written. A correction is a credit note that names the invoice.
  assert.equal(await refusal(asBusiness(w, 'UPDATE bhava_invoices SET total_paise = 1, taxable_paise = 1, igst_paise = 0 WHERE id = $1', [first.id])), 'bhava_invoices_frozen');
  assert.equal(await refusal(asBusiness(w, `UPDATE bhava_invoices SET file_key = 'invoices/1.pdf' WHERE id = $1`, [first.id])), null);
  assert.match(String(await refusal(asBusiness(w, 'DELETE FROM bhava_invoices WHERE id = $1', [first.id]))), /42501|permission denied/);
  assert.match(String(await refusal(asBusiness(w, 'UPDATE bhava_invoice_lines SET taxable_paise = 1'))), /42501|permission denied/);
  assert.notEqual(await refusal(invoice(w, { sourceRef: 'credit:x', over: { doc_type: 'credit_note' } })), null, 'a credit note names its invoice');
  const credit = await invoice(w, { sourceRef: `credit:${first.id}:1`, over: { doc_type: 'credit_note', original_invoice_id: first.id, reason: 'Charged twice' } });
  assert.equal(credit.number, 'BCN/26-27/00001', 'credit notes are their own series');
  assert.notEqual(await refusal(invoice(w, { sourceRef: `credit:${second.id}:1`, over: { doc_type: 'credit_note', original_invoice_id: second.id } })), null, 'and never another business’s invoice');

  // F-54: CGST and SGST together and equal, or IGST, never both.
  assert.notEqual(await refusal(invoice(w, { sourceRef: 'tax:both', over: { cgst_paise: 10, sgst_paise: 10, total_paise: 49900 + 8982 + 20 } })), null);
  assert.notEqual(await refusal(invoice(w, { sourceRef: 'tax:uneven', igst: 0, over: { cgst_paise: 4491, sgst_paise: 4490, total_paise: 49900 + 8981 } })), null);
});

test('a provider payment is one row, and a usage event is counted once', async () => {
  const w = await world();
  const other = await otherBusiness(w);
  const pay = (tenant, id) => asBusiness(w, `INSERT INTO billing_payments (tenant_id, provider_payment_id, amount_paise, status) VALUES ($1, $2, 58882, 'captured')`, [tenant.id, id], tenant);
  assert.equal(await refusal(pay(w.tenant, 'pay_1')), null);
  assert.equal(await refusal(pay(w.tenant, 'pay_1')), 'billing_payments_provider_provider_payment_id_key', 'F-51');
  assert.equal(await refusal(pay(other.tenant, 'pay_1')), 'billing_payments_provider_provider_payment_id_key', 'a payment id belongs to one business');

  const at = new Date('2026-11-30T20:00:00Z'); // already 1 December in India
  const count = (key, tenant = w.tenant, meter = 'dms', quantity = 1, cost = 0) => asBusiness(w,
    `INSERT INTO usage_events (tenant_id, meter, quantity, cost_paise, idempotency_key, occurred_at, month) VALUES ($1, $2, $3, $4, $5, $6, '1999-01-01') ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING month::text`,
    [tenant.id, meter, quantity, cost, key, at], tenant);
  assert.deepEqual(await count('dm:1'), [{ month: usageMonthOf(at) }], 'the database sets the month, in India');
  assert.equal(usageMonthOf(at), '2026-12-01');
  assert.deepEqual(await count('dm:1'), [], 'the same send reported again is not counted');
  await count('dm:2');
  await count('dm:1', other.tenant);
  await count('wa:1', w.tenant, 'whatsapp_messages', 40, 3200);
  const months = await asBusiness(w, 'SELECT meter, month::text, used, cost_paise, included, alert_80_at FROM usage_months ORDER BY meter');
  assert.deepEqual(months, [
    { meter: 'dms', month: '2026-12-01', used: 2, cost_paise: 0, included: null, alert_80_at: null },
    { meter: 'whatsapp_messages', month: '2026-12-01', used: 40, cost_paise: 3200, included: null, alert_80_at: null },
  ]);
  assert.deepEqual(await asBusiness(w, `SELECT used FROM usage_months WHERE meter = 'dms'`, [], other.tenant), [{ used: 1 }], 'each business has its own meter');
  assert.match(String(await refusal(asBusiness(w, 'DELETE FROM usage_events'))), /42501|permission denied/);

  const charge = (ref) => asBusiness(w, `INSERT INTO pass_through_charges (tenant_id, kind, amount_paise, quantity, period, collected_by, source_ref) VALUES ($1, 'whatsapp', 3200, 40, '2026-12-01', 'invoice', $2)`, [w.tenant.id, ref]);
  assert.equal(await refusal(charge('usage:whatsapp_messages:2026-12')), null);
  assert.equal(await refusal(charge('usage:whatsapp_messages:2026-12')), 'pass_through_charges_tenant_id_kind_source_ref_key', 'a charge is passed through once');
});

test('statements take no commission, and a business is referred once and never by itself', async () => {
  const w = await world();
  const other = await otherBusiness(w);
  const statement = (over = {}) => {
    const row = { tenant_id: w.tenant.id, month: '2026-11-01', sales_paise: 1000000, refunds_paise: 50000, gateway_fees_paise: 23600, shipping_paise: 40000, payouts_paise: 800000, closing_balance_paise: 86400, ...over };
    const columns = Object.keys(row);
    return asBusiness(w, `INSERT INTO settlement_statements (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, columns.map((c) => row[c]));
  };
  assert.notEqual(await refusal(statement({ commission_paise: 100 })), null, 'F-113: there is no commission to record');
  assert.notEqual(await refusal(statement({ closing_balance_paise: 1 })), null, 'the closing balance is the arithmetic of the lines');
  assert.equal(await refusal(statement()), null);
  assert.equal(await refusal(statement()), 'settlement_statements_tenant_id_month_key', 'one statement a month');

  const third = (await otherBusiness(w, 'third')).tenant;
  const refer = (referrer, referred) => sql(w, 'INSERT INTO seller_referrals (tenant_id, referred_tenant_id) VALUES ($1, $2)', [referrer.id, referred.id]);
  assert.equal(await refusal(refer(w.tenant, other.tenant)), null);
  assert.notEqual(await refusal(refer(third, other.tenant)), null, 'F-129: a business is referred once');
  assert.notEqual(await refusal(refer(third, third)), null, 'never by itself');
  assert.notEqual(await refusal(sql(w, `UPDATE seller_referrals SET state = 'credited' WHERE tenant_id = $1`, [w.tenant.id])), null, 'credited means credited_at is set');
  assert.equal((await asBusiness(w, 'SELECT state FROM seller_referrals')).length, 1, 'the referrer sees its referral');
  assert.deepEqual(await asBusiness(w, 'SELECT 1 FROM seller_referrals', [], other.tenant), [], 'the referred business does not');
  assert.match(String(await refusal(asBusiness(w, `UPDATE seller_referrals SET state = 'blocked'`))), /42501|permission denied/);

  // A sign-up run starts with no business; once it has one, that business alone may read it, and nobody may write it.
  await sql(w, `INSERT INTO signup_runs (token_hash) VALUES ($1)`, ['b'.repeat(64)]);
  await sql(w, `INSERT INTO signup_runs (token_hash, tenant_id, account_type) VALUES ($1, $2, 'creator')`, ['c'.repeat(64), w.tenant.id]);
  assert.deepEqual(await asBusiness(w, 'SELECT account_type FROM signup_runs'), [{ account_type: 'creator' }]);
  assert.deepEqual(await asBusiness(w, 'SELECT 1 FROM signup_runs', [], other.tenant), []);
  assert.match(String(await refusal(asBusiness(w, 'UPDATE signup_runs SET finished_at = now()'))), /42501|permission denied/);

  await sql(w, `INSERT INTO signup_invites (code_hash, max_uses) VALUES ($1, 1)`, ['a'.repeat(64)]);
  assert.equal(await refusal(sql(w, 'UPDATE signup_invites SET uses = uses + 1')), null);
  assert.equal(await refusal(sql(w, 'UPDATE signup_invites SET uses = uses + 1')), 'signup_invites_not_over_used', 'an invite is used as often as it allows');
});

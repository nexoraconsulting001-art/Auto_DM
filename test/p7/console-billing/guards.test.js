// An upgrade prompt is never the only guard (PRD 5.7, F-33 to F-35): every call a console screen makes is also made straight
// to the API here, and the server refuses it by itself. The same for money: no call takes an amount, a change needs a fresh
// check, and a payment goes to the provider's hosted page. Runs the real app with the Razorpay simulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSessionToken } from '../../../src/repos/sessions.js';
import { BillingChangeResult, BillingPlan, PaymentMethodPage } from '../../../src/contracts/api/billing.js';
import { addStaff } from '../../p0/spec-p0/support.js';
import { openBilling } from '../../p7/billing/support.js';

const REPLY = { question: 'When does it arrive?', answer: 'Three days.', active: true };
const KEYWORDS = { items: [{ keywords: ['link'], reelId: null, linkUrl: 'https://kesar.example/p', message: '', active: true }] };

test('a business on Free calling the add-on routes directly is refused by the router, and what it has stays readable', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ plan: 'free' });

  const closed = [
    ['POST', '/faq', REPLY, 'ai_replies'],
    ['PATCH', '/faq/1', { active: false }, 'ai_replies'],
    ['POST', '/ai-replies/test', { question: 'Do you ship to Pune?' }, 'ai_replies'],
    ['POST', '/whatsapp/connect', undefined, 'whatsapp_automation'],
    ['POST', '/whatsapp/connect/finish', { code: 'c', state: 's', wabaId: '12345678', phoneNumberId: '87654321' }, 'whatsapp_automation'],
    ['PUT', '/whatsapp/keywords', KEYWORDS, 'whatsapp_automation'],
  ];
  for (const [method, path, body, feature] of closed) {
    const res = await shop.api(method, path, body);
    assert.deepEqual([res.status, res.json.code, res.json.feature], [403, 'plan.feature_off', feature], `${method} ${path}`);
    assert.ok(res.json.plan === undefined || typeof res.json.plan === 'string', 'the plan that has it is named when a plan has it; an add-on-only feature names none');
  }

  // Reading and removing are never gated, so a business whose add-on ended can still manage what it has.
  for (const path of ['/faq', '/ai-replies', '/ai-replies/log', '/whatsapp', '/whatsapp/keywords', '/whatsapp/optins']) {
    const res = await shop.api('GET', path);
    assert.equal(res.status, 200, `GET ${path}`);
  }
  assert.notEqual((await shop.api('DELETE', '/faq/999')).json?.code, 'plan.feature_off');
  assert.notEqual((await shop.api('DELETE', '/whatsapp')).json?.code, 'plan.feature_off');
});

test('a limit is enforced by the server with the numbers the prompt shows', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ plan: 't2' });
  await w.sql(`INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, 'staff.seats', true, 0) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = true, limit_value = 0`, [shop.tenant.id]);
  const res = await shop.api('POST', '/team/invites', { phone: '9876500001', role: 'staff', permissions: ['orders'] });
  assert.deepEqual([res.status, res.json.code, res.json.feature, res.json.limit, res.json.used], [403, 'plan.limit_reached', 'staff.seats', 0, 0]);
});

test('plan changes need the owner, a fresh check and a request key, take no amount, and open the provider’s own page', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ plan: 'free' });
  const other = await w.business({ plan: 'free' });
  const catalog = (await shop.api('GET', '/billing/catalog')).json;
  const t1 = catalog.plans.find((plan) => plan.code === 't1');
  assert.ok(t1.monthlyPaise > 0, 'the server prices the plan');

  // A manager reads nothing and changes nothing of the billing.
  const manager = await addStaff(w.app, shop, { permissions: [] });
  await w.sql(`UPDATE users SET role = 'manager' WHERE id = $1`, [manager.user.id]);
  assert.equal((await shop.api('GET', '/billing', undefined, { token: manager.token })).status, 403);
  assert.equal((await shop.api('POST', '/billing/change', { plan: 't1', requestKey: shop.key() }, { token: manager.token })).status, 403);

  // No request key, and no amount: the body has nowhere to put one.
  assert.equal((await shop.api('POST', '/billing/change', { plan: 't1' })).status, 400);
  const sneaky = await shop.api('POST', '/billing/change', { plan: 't1', cycle: 'monthly', requestKey: shop.key(), pricePaise: 1, amountPaise: 1, totalPaise: 1 });
  const plain = await other.api('POST', '/billing/change', { plan: 't1', cycle: 'monthly', requestKey: other.key() });
  assert.equal(sneaky.status, 200, sneaky.text);
  assert.equal(plain.status, 200, plain.text);
  assert.equal(BillingChangeResult.parse(sneaky.json).plan.nextChargePaise, BillingChangeResult.parse(plain.json).plan.nextChargePaise, 'an amount sent along changes nothing');
  assert.ok(sneaky.json.checkoutUrl && /^https?:\/\//.test(sneaky.json.checkoutUrl), 'the payment is on the provider’s hosted page');
  assert.doesNotMatch(sneaky.text, /card|cvv|pan\b/i, 'no card data in an answer');

  // The same request key is the same change, not a second one.
  const key = shop.key();
  const first = await shop.api('POST', '/billing/change', { plan: 't2', requestKey: key });
  const again = await shop.api('POST', '/billing/change', { plan: 't2', requestKey: key });
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(first.json.checkoutUrl, again.json.checkoutUrl);

  // The payment method too is the provider's own page.
  const page = await shop.api('POST', '/billing/payment-method');
  assert.equal(page.status, 200, page.text);
  assert.ok(PaymentMethodPage.parse(page.json).url.length > 0);

  // A session that is not fresh may read but never change money.
  await w.sql(`UPDATE sessions SET fresh_until = now() - interval '1 minute' WHERE id = $1`, [hashSessionToken(shop.token)]);
  assert.equal((await shop.api('GET', '/billing')).status, 200);
  for (const [method, path, body] of [['POST', '/billing/change', { plan: 't3', requestKey: shop.key() }], ['POST', '/billing/payment-method'], ['POST', '/whatsapp/connect'], ['PUT', '/setup/own-keys', { provider: 'razorpay', keyId: 'k', keySecret: 's' }]]) {
    const res = await shop.api(method, path, body);
    assert.deepEqual([res.status, res.json.code], [403, 'reauth_required'], `${method} ${path}`);
  }
  assert.ok(BillingPlan.safeParse((await shop.api('GET', '/billing')).json).success);
});

test('one business never reads another’s plan, invoices or feed through these screens’ routes', async (t) => {
  const w = await openBilling(t);
  const a = await w.business({ plan: 'free' });
  const b = await w.business({ plan: 'free' });
  assert.equal((await a.api('POST', '/billing/change', { plan: 't1', requestKey: a.key() })).status, 200);
  assert.equal((await b.api('GET', '/billing')).json.plan, 'free');
  assert.equal((await b.api('GET', '/billing/invoices')).json.items.length, 0);
  assert.equal((await b.api('GET', '/billing/invoices/1/file')).status, 404);
  assert.equal((await b.api('POST', '/team-feed/999999/undo')).status, 404);
  assert.equal((await b.api('POST', '/team-feed/999999/approve')).status, 404);
  assert.equal((await b.api('POST', '/team-feed/999999/reject')).status, 404);
  assert.equal((await b.api('GET', '/team-feed')).json.items.length, 0);
});

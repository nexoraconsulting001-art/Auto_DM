// The Platform Console's billing (PRD 5.7, 5.12): Bhava's own invoice details, a plan override with its actor and reason,
// credit notes that never give back more than was charged, and a billing hold only payment or the team lifts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleUser, onConsole } from '../../p0/spec-p0/support.js';
import { openBilling } from './support.js';

const call = async (w, op, method, path, body) => {
  const res = await onConsole(w.app, op, path, { method, body });
  return { status: res.status, json: res.text ? JSON.parse(res.text) : null, text: res.text };
};

test('settings, overrides, credit notes and holds from the console, each with its actor and reason', async (t) => {
  const w = await openBilling(t);
  const admin = await consoleUser(w.app, 'super_admin');
  const support = await consoleUser(w.app, 'support');
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');

  // Bhava's own details: anyone reads, only a super admin saves.
  const got = await call(w, support, 'GET', '/billing-settings');
  assert.deepEqual([got.status, got.json.stateCode, got.json.graceDays, got.json.yearlyMonths], [200, '29', 2, 10]); // grace 2 days by default: user decision 2026-11-26
  assert.equal((await call(w, support, 'PUT', '/billing-settings', { sac: '998315', reason: 'CA confirmed' })).status, 403);
  const saved = await call(w, admin, 'PUT', '/billing-settings', { sac: '998315', graceDays: 7, reason: 'CA confirmed' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.sac, '998315');
  assert.equal((await call(w, admin, 'PUT', '/billing-settings', { gstin: 'not a gstin', reason: 'x' })).status, 400);
  assert.equal((await w.one(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id IS NULL AND action = 'billing.settings_saved'`)).n, 1);

  // A business's billing, then an override without payment.
  const view = await call(w, support, 'GET', `/tenants/${shop.tenant.id}/billing`);
  assert.equal(view.status, 200, view.text);
  assert.deepEqual([view.json.plan, view.json.status, view.json.offerCode], ['t1', 'active', 'launch']);
  assert.ok(view.json.changes.some((c) => c.toPlan === 't1' && c.source === 'billing'));
  assert.equal((await call(w, support, 'POST', `/tenants/${shop.tenant.id}/plan`, { plan: 't3', reason: 'pilot' })).status, 403);
  const override = await call(w, admin, 'POST', `/tenants/${shop.tenant.id}/plan`, { plan: 't3', reason: 'pilot account' });
  assert.equal(override.status, 200, override.text);
  assert.equal(override.json.plan, 't3');
  assert.deepEqual((({ source, reason }) => [source, reason])(override.json.changes[0]), ['console', 'pilot account']);
  assert.match(override.json.changes[0].actor, /^platform:\d+$/);
  assert.equal((await call(w, admin, 'GET', '/tenants/999999/billing')).status, 404);

  // Credit notes: part, then the rest, then nothing more. The tax given back is exactly the tax charged.
  const [invoice] = await shop.invoices();
  const part = await call(w, admin, 'POST', `/tenants/${shop.tenant.id}/credit-notes`, { invoiceId: Number(invoice.id), taxablePaise: 10001, reason: 'goodwill' });
  assert.equal(part.status, 201, part.text);
  assert.deepEqual([part.json.docType, part.json.originalInvoiceId, part.json.taxablePaise], ['credit_note', Number(invoice.id), 10001]);
  assert.match(part.json.number, /^BCN\/\d{2}-\d{2}\/00001$/);
  assert.equal(part.json.cgstPaise, part.json.sgstPaise);
  assert.equal((await call(w, admin, 'POST', `/tenants/${shop.tenant.id}/credit-notes`, { invoiceId: Number(invoice.id), taxablePaise: Number(invoice.taxable_paise), reason: 'too much' })).status, 400);
  const rest = await call(w, admin, 'POST', `/tenants/${shop.tenant.id}/credit-notes`, { invoiceId: Number(invoice.id), reason: 'cancelled' });
  assert.equal(rest.status, 201, rest.text);
  assert.equal(part.json.taxablePaise + rest.json.taxablePaise, Number(invoice.taxable_paise));
  assert.equal(part.json.cgstPaise + rest.json.cgstPaise, Number(invoice.cgst_paise), 'no rounding drift');
  assert.equal(part.json.totalPaise + rest.json.totalPaise, Number(invoice.total_paise));
  assert.equal((await call(w, admin, 'POST', `/tenants/${shop.tenant.id}/credit-notes`, { invoiceId: Number(invoice.id), reason: 'again' })).status, 400);
  const other = await w.business({ state: '29' });
  assert.equal((await call(w, admin, 'POST', `/tenants/${other.tenant.id}/credit-notes`, { invoiceId: Number(invoice.id), reason: 'wrong business' })).status, 404);
  assert.equal((await call(w, admin, 'POST', `/tenants/${shop.tenant.id}/credit-notes`, { invoiceId: Number(invoice.id), taxablePaise: -5, reason: 'x' })).status, 400);
  const original = (await shop.invoices())[0];
  assert.equal(Number(original.total_paise), Number(invoice.total_paise), 'the invoice itself never changed');

  // A hold from the console, which the owner cannot lift; the team lifts it.
  const held = await call(w, support, 'POST', `/tenants/${shop.tenant.id}/billing/suspend`, { reason: 'chargeback' });
  assert.equal(held.status, 200, held.text);
  assert.equal(held.json.status, 'suspended');
  assert.equal((await w.one('SELECT paused_by FROM compliance_settings WHERE tenant_id = $1', [shop.tenant.id])).paused_by, 'billing');
  assert.equal((await shop.api('POST', '/compliance/resume')).status, 403);
  const lifted = await call(w, support, 'POST', `/tenants/${shop.tenant.id}/billing/resume`, { reason: 'resolved' });
  assert.equal(lifted.status, 200, lifted.text);
  assert.equal(lifted.json.status, 'active');
  assert.equal((await w.one('SELECT paused FROM compliance_settings WHERE tenant_id = $1', [shop.tenant.id])).paused, false);
  const actions = (await w.sql('SELECT action FROM audit_log WHERE tenant_id = $1 ORDER BY id', [shop.tenant.id])).map((r) => r.action);
  for (const action of ['billing.plan_override', 'billing.credit_note', 'billing.suspended', 'billing.resumed']) assert.ok(actions.includes(action), action);
});

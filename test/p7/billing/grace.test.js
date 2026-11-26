// A failed renewal (PRD 5.12, F-53): billing_settings.grace_days of grace (2 by default, user decision 2026-11-26) with reminders, then an owner-locked pause of every send with all
// data kept; only a payment or Bhava's team lifts it. 'move_to_free' instead ends the subscription.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBilling } from '../../../src/modules/billing/service.js';
import { DAY, openBilling } from './support.js';

const later = (w, ms) => createBilling(w.app.ctx, { now: () => new Date(Date.now() + ms) });
const ownerAlerts = (w, shop, kind) => w.sql(`SELECT * FROM alerts WHERE tenant_id = $1 AND audience = 'owner' AND kind = $2 ORDER BY id`, [shop.tenant.id, kind]);
const told = async (w, shop, kind) => (await ownerAlerts(w, shop, kind)).length + (await w.sql('SELECT 1 FROM notification_events WHERE tenant_id = $1 AND kind = $2', [shop.tenant.id, kind])).length;

test('F-53: unpaid after grace the business is suspended, its sends held as an owner-locked pause and its data intact; a payment lifts it', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');
  const product = await shop.in(() => shop.repos.products.create({ name: 'Brass lamp', price: '999', active: 'on' }));
  const s = await shop.sub();

  await w.rzp.post('/clock', { advanceMs: 1000 });
  await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, outcome: 'failed' });
  await w.settle();
  const grace = await shop.sub();
  assert.equal(grace.status, 'grace');
  const days = (new Date(grace.grace_until) - Date.now()) / DAY;
  assert.ok(days > 1.9 && days <= 2.01, `two days of grace by default (user decision 2026-11-26), got ${days}`);
  assert.equal(await told(w, shop, 'billing.payment_failed'), 1, 'the owner is told');
  assert.equal((await shop.payments()).filter((p) => p.status === 'failed').length, 1);
  assert.equal((await shop.tenantRow()).plan, 't1', 'grace keeps the plan');
  // A second failure in grace does not move the end of grace.
  await w.rzp.post('/clock', { advanceMs: 1000 });
  await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, outcome: 'halted' });
  await w.settle();
  assert.equal(+new Date((await shop.sub()).grace_until), +new Date(grace.grace_until));

  // Reminders: one a day, however often the job runs.
  const halfDay = later(w, DAY / 2);
  assert.equal((await halfDay.graceSweep()).reminded, 1);
  await halfDay.graceSweep();
  assert.equal(await told(w, shop, 'billing.grace_reminder'), 1);
  await later(w, 1.5 * DAY).graceSweep();
  assert.equal(await told(w, shop, 'billing.grace_reminder'), 2);
  assert.equal((await shop.sub()).status, 'grace');

  // A day after grace ended.
  const afterGrace = later(w, 3 * DAY);
  assert.equal((await afterGrace.graceSweep()).suspended, 1);
  assert.equal((await afterGrace.graceSweep()).suspended, 0, 'once');
  const held = await shop.sub();
  assert.equal(held.status, 'suspended');
  const pause = await w.one('SELECT paused, paused_by FROM compliance_settings WHERE tenant_id = $1', [shop.tenant.id]);
  assert.deepEqual([pause.paused, pause.paused_by], [true, 'billing']);
  assert.equal(await told(w, shop, 'billing.suspended'), 1);
  // The owner cannot lift it, cannot change the plan around it, and loses nothing.
  const resume = await shop.api('POST', '/compliance/resume');
  assert.equal(resume.status, 403, resume.text);
  assert.equal((await shop.change('t2')).status, 409);
  const ownPause = await shop.api('POST', '/compliance/pause', { pauseStore: false });
  assert.ok([200, 403].includes(ownPause.status));
  assert.equal((await w.one('SELECT paused_by FROM compliance_settings WHERE tenant_id = $1', [shop.tenant.id])).paused_by, 'billing', 'an owner’s pause does not take it over');
  assert.equal((await w.one('SELECT name FROM products WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, product.id])).name, 'Brass lamp');
  assert.equal((await shop.tenantRow()).plan, 't1', 'data and plan kept');
  // The provider's hosted page is how the owner pays.
  const page = await shop.api('POST', '/billing/payment-method');
  assert.equal(page.status, 200, page.text);
  assert.match(page.json.url, /^https:\/\/rzp\.io\//);

  // Paying lifts it.
  await w.rzp.post('/clock', { advanceMs: 1000 });
  await w.rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, outcome: 'charged' });
  await w.settle();
  const back = await shop.sub();
  assert.deepEqual([back.status, back.grace_until, back.suspended_at], ['active', null, null]);
  assert.equal((await w.one('SELECT paused FROM compliance_settings WHERE tenant_id = $1', [shop.tenant.id])).paused, false);
  assert.equal(await told(w, shop, 'billing.resumed'), 1);
});

test('move_to_free after grace ends the subscription and moves the business to Free', async (t) => {
  const w = await openBilling(t);
  await w.sql(`UPDATE billing_settings SET after_grace = 'move_to_free', grace_days = 3`);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t2');
  await w.rzp.post('/clock', { advanceMs: 1000 });
  await w.rzp.post('/subscriptions/charge', { id: (await shop.sub()).provider_subscription_id, outcome: 'failed' });
  await w.settle();
  assert.equal((await later(w, 2 * DAY).graceSweep()).freed, 0);
  assert.equal((await later(w, 4 * DAY).graceSweep()).freed, 1);
  assert.equal((await shop.sub()).status, 'cancelled');
  assert.equal((await shop.tenantRow()).plan, 'free');
  const change = await w.one('SELECT actor, source FROM plan_changes WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenant.id]);
  assert.deepEqual([change.actor, change.source], ['billing', 'billing']);
  assert.equal((await w.one('SELECT paused FROM compliance_settings WHERE tenant_id = $1', [shop.tenant.id]))?.paused ?? false, false);
});

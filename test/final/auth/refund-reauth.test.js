// auth-1 (PRD 5.11, 9.8): a refund needs a fresh re-auth (a WhatsApp code or the device unlock), not a password. An owner
// who signed up without one (every Phase 5 owner) can refund, and a session that has not re-authed lately cannot refund
// or retry a refund at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, refundBody } from '../../p4/payments/support.js';

/** The owner's sessions stop being fresh, as they do FRESH_MINUTES after the last sign-in or re-auth. */
const goStale = (world, shop) => shop.sql(`UPDATE sessions SET fresh_until = now() - interval '1 minute' WHERE tenant_id = $1`, [shop.tenant.id]);

test('auth-1: an owner with no password refunds on a fresh session, sending no password', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  // Exactly what a first sign-in by WhatsApp, Google or Apple writes: no password at all.
  await shop.sql(`UPDATE users SET password_hash = '!' WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenant.id]);
  const { password: _unused, ...body } = refundBody(20000);
  const res = await shop.api('POST', `/orders/${order.id}/refunds`, body);
  assert.equal(res.status, 201, res.text);
  assert.equal((await shop.refunds(order.id)).length, 1);
  const audit = await shop.sql(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'refund.request'`, [shop.tenant.id]);
  assert.equal(audit.length, 1, 'the refund is audited');
});

test('auth-1: a session that has not re-authed lately can neither refund nor retry a refund', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  const made = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(10000));
  assert.equal(made.status, 201, made.text);
  await world.settle();

  await goStale(world, shop);
  // Even with the right password, which is no longer what proves it is the owner.
  const stale = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(10000));
  assert.equal(stale.status, 403, stale.text);
  assert.equal(stale.json.code ?? stale.json.error?.code ?? stale.json.error, 'reauth_required');
  assert.equal((await shop.refunds(order.id)).length, 1, 'no second refund');

  const retried = await shop.api('POST', `/refunds/${made.json.id}/retry`);
  assert.equal(retried.status, 403, retried.text);
  assert.equal(retried.json.code ?? retried.json.error?.code ?? retried.json.error, 'reauth_required');
  const audit = await shop.sql(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'refund.retry'`, [shop.tenant.id]);
  assert.equal(audit.length, 0, 'a stale session never reaches the retry');
});

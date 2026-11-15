// D-2: an owner's refund is guarded by the fresh re-auth every sensitive route uses (PRD 5.11), not by a password. Every
// self-serve owner signs in without one (password_hash '!'), so a password check would refuse every refund they make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { routes } from '../../../src/contracts/api/index.js';
import { RefundCreate } from '../../../src/contracts/api/payments.js';
import { openWorld } from '../../p4/payments/support.js';

const body = (amountPaise) => ({ amountPaise, reason: 'Returned', idempotencyKey: `rf-${crypto.randomUUID()}` });

test('D-2: refunds.create is a fresh route and takes no password', () => {
  const route = (Array.isArray(routes) ? routes : Object.entries(routes).map(([id, r]) => ({ id, ...r }))).find((r) => r.id === 'refunds.create');
  assert.equal(route.fresh, true, 'refunds.create needs a fresh re-auth');
  assert.equal(RefundCreate.safeParse(body(20000)).success, true, 'no password in the body');
  assert.equal('password' in RefundCreate.shape, false);
});

test('D-2: an owner who signed in without a password refunds after a fresh check, and a stale session refunds nothing', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  // The owner, as sign-up writes every self-serve owner: no password at all.
  await shop.sql(`UPDATE users SET password_hash = '!' WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenant.id]);

  const ok = await shop.api('POST', `/orders/${order.id}/refunds`, body(20000));
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.status, 'processed');
  assert.equal(ok.json.amountPaise, 20000);

  // The re-auth has run out: refused before anything is written or sent.
  await shop.sql(`UPDATE sessions SET fresh_until = now() - interval '1 minute' WHERE tenant_id = $1`, [shop.tenant.id]);
  const stale = await shop.api('POST', `/orders/${order.id}/refunds`, body(10000));
  assert.equal(stale.status, 403);
  assert.equal(stale.json.code, 'reauth_required');
  assert.equal((await shop.refunds(order.id)).length, 1);
  assert.equal((await world.rzp.get('/state')).refunds.length, 1);
});

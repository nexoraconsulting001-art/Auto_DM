// money-13: a refund the gateway already knows (its id is recorded) is looked up, never created again, when the sweep asks
// about it; and the sweep backs off for refunds that stay pending a long time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, refundBody } from '../../p4/payments/support.js';

test('money-13: the sweep looks up a refund whose gateway id is known instead of asking for it again', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 100000 });
  // The gateway makes the refund but its answer is lost on the way back.
  await world.rzp.fault({ kind: 'partial', then: 'timeout', times: 3, match: { method: 'POST', path: '/v1/payments/*/refund' } });
  const res = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(30000));
  assert.ok(res.status < 300, res.text);
  await world.rzp.delete('/faults');
  let [refund] = await shop.refunds(order.id);
  assert.equal(refund.status, 'requested');
  // As a 'pending' answer or a refund.created webhook would have: the gateway's id is now known.
  const [made] = (await world.rzp.get('/state')).refunds;
  await shop.sql('UPDATE refunds SET gateway_refund_id = $3 WHERE tenant_id = $1 AND id = $2', [shop.tenant.id, refund.id, made.id]);

  const posts = async () => (await world.rzp.calls({ method: 'POST', path: '/v1/payments/*/refund' })).length;
  const before = await posts();
  await shop.run((p) => p.refunds.submit(Number(refund.id)));
  assert.equal(await posts(), before, 'no second refund was asked for');
  const lookups = await world.rzp.calls({ method: 'GET', path: `/v1/payments/*/refunds/${made.id}` });
  assert.ok(lookups.length >= 1, 'the refund was looked up by its id');
  [refund] = await shop.refunds(order.id);
  assert.equal(refund.status, 'processed');
  assert.equal((await world.rzp.get('/state')).refunds.length, 1);
});

test('money-13: a refund pending for over a day is asked about every few hours, not every two minutes', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 100000 });
  await world.rzp.fault({ kind: 'timeout', times: 3, match: { method: 'POST', path: '/v1/payments/*/refund' } });
  await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(30000));
  await world.rzp.delete('/faults');
  const [refund] = await shop.refunds(order.id);
  // Times set as they would be after two days, with the triggers that stamp updated_at held off for the moment.
  const times = (set) => world.db.platform.tx(async (tx) => {
    await tx.exec('ALTER TABLE refunds DISABLE TRIGGER USER');
    await tx.exec(`UPDATE refunds SET ${set} WHERE tenant_id = ${Number(shop.tenant.id)} AND id = ${Number(refund.id)}`);
    await tx.exec('ALTER TABLE refunds ENABLE TRIGGER USER');
  });
  await times(`created_at = now() - interval '2 days', updated_at = now() - interval '10 minutes'`);
  const swept = await world.ctx.payments.refunds.sweep();
  assert.equal(swept.filter((r) => r.refundId === Number(refund.id)).length, 0, 'asked ten minutes ago: not yet');
  await times(`updated_at = now() - interval '7 hours'`);
  const later = await world.ctx.payments.refunds.sweep();
  assert.equal(later.filter((r) => r.refundId === Number(refund.id)).length, 1);
});

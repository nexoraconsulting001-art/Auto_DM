// Courier webhooks worked by two processes at once (R4-WH-2): the web app works an event as it arrives and the worker's
// sweep works whatever is left, from the same table. Each event must be applied once, one parcel's events in turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCourierEvent, createWebhooks } from '../../../src/modules/shipping/webhooks.js';
import { openWorld } from './support.js';

const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

test('two drainers at once (the web app and the worker) apply each tracking event once, one parcel’s events one after the other', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder();
  await shop.ship(order);
  await world.settle();
  const [s] = await shop.shipments(order.id);

  // Stored and not yet worked through, as a busy minute leaves them: picked up, then delivered.
  const store = (status, at) => {
    const ev = cleanCourierEvent({ awb: s.awb, current_status: status, current_timestamp: at, sr_order_id: s.provider_order_id, pickup_location: s.pickup_location, scans: [] });
    return world.db.platform.query(
      `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload) VALUES ('shiprocket', 'managed', $1, $2, $3::jsonb)`,
      [`${ev.awb}|${ev.status}|${ev.at}`, ev.status, JSON.stringify(ev)],
    );
  };
  await store('PICKED UP', stamp(Date.now() - 2 * 3_600_000));
  await store('DELIVERED', stamp(Date.now() - 3_600_000));

  const calls = [];
  const { tracking } = world.ctx.shipping;
  const real = tracking.apply;
  tracking.apply = async (...args) => {
    calls.push(`start:${args[1].at(-1)?.providerStatus}`);
    try {
      return await real.apply(tracking, args);
    } finally {
      calls.push('end');
    }
  };
  t.after(() => { tracking.apply = real; });
  const worker = createWebhooks(world.ctx, { tracking });
  await Promise.all([world.ctx.shipping.webhooks.drain(), worker.drain(), world.ctx.shipping.webhooks.drain(), worker.drain()]);
  await world.settle();

  assert.deepEqual(calls, ['start:PICKED UP', 'end', 'start:DELIVERED', 'end'], 'each event applied once, in turn, in the order it came');
  const rows = (await world.courierRows()).filter((r) => r.payload?.awb === s.awb && ['PICKED UP', 'DELIVERED'].includes(r.event_type));
  assert.deepEqual(rows.map((r) => [r.event_type, r.status, r.outcome, r.attempts]), [['PICKED UP', 'processed', 'processed', 1], ['DELIVERED', 'processed', 'processed', 1]]);
  assert.equal((await shop.order(order.id)).fulfilment_status, 'delivered');
  assert.equal((await shop.scans(s.id)).filter((e) => e.status === 'delivered').length, 1);
});

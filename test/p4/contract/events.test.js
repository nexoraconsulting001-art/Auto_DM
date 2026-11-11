// The order event bus (src/modules/orders/events.js): the outbox the database writes with every change, handed to listeners
// at least once, in order per order; and the Phase 2 traffic order link, now one of those listeners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EMITTED_EVENTS, ORDER_EVENTS } from '../../../src/contracts/orders.js';
import { MAX_ATTEMPTS, createOrderEvents } from '../../../src/modules/orders/events.js';
import { changeOrder, changeRow } from '../../../src/modules/orders/state.js';
import { currentTenant, withTenant } from '../../../src/tenancy.js';
import { OWNER, startApp } from '../../helpers.js';
import { otherBusiness, placeOrder, query, tx, world } from './support.js';

const pay = (w, id) => tx(w, (t) => changeOrder(t, id, { payment: 'paid', fulfilment: 'new', actor: 'webhook:razorpay' }));
const deliveries = (w, listener) => w.db.platform.query('SELECT d.status, d.attempts, e.type FROM order_event_deliveries d JOIN order_events e ON e.id = d.event_id WHERE d.listener = $1 ORDER BY d.event_id', [listener]);
/** Lets a delivery that is waiting out its backoff be tried now. */
const due = (w) => w.db.platform.query(`UPDATE order_event_deliveries SET next_attempt_at = now() WHERE status = 'pending'`);

test('every change is delivered to each listener that asked for it, once, as the business it belongs to', async () => {
  const w = await world();
  const bus = createOrderEvents({ db: w.db });
  const seen = [];
  bus.on(['order.created', 'order.paid'], 'test.money', (event) => seen.push(['money', event.type, event.orderId, currentTenant().id]));
  bus.on('*', 'test.all', (event) => seen.push(['all', event.type, event.orderId]));

  const order = await placeOrder(w);
  await pay(w, order.id);
  assert.deepEqual(await bus.drain(), { events: 3, delivered: 5, failed: 0 });
  assert.deepEqual(seen.filter((s) => s[0] === 'money'), [['money', 'order.created', order.id, w.tenant.id], ['money', 'order.paid', order.id, w.tenant.id]]);
  assert.deepEqual(seen.filter((s) => s[0] === 'all').map((s) => s[1]), ['order.created', 'order.paid', 'order.confirmed']);
  assert.deepEqual(await bus.drain(), { events: 0, delivered: 0, failed: 0 }, 'nothing is handed out twice');

  // A second process with the same listeners finds nothing left to do either.
  const twin = createOrderEvents({ db: w.db });
  twin.on('*', 'test.all', () => seen.push(['twin']));
  assert.equal((await twin.drain()).delivered, 0);
  assert.equal(seen.some((s) => s[0] === 'twin'), false);
});

test('an event carries ids and statuses only', async () => {
  const w = await world();
  const bus = createOrderEvents({ db: w.db });
  const got = [];
  bus.on('order.paid', 'test.shape', (event) => got.push(event));
  const order = await placeOrder(w);
  await pay(w, order.id);
  await bus.drain();
  const [event] = got;
  assert.deepEqual(Object.keys(event).sort(), ['createdAt', 'data', 'entity', 'entityId', 'from', 'id', 'orderId', 'tenantId', 'to', 'type']);
  assert.deepEqual([event.type, event.entity, event.entityId, event.from, event.to, event.data], ['order.paid', 'order', order.id, 'unpaid', 'paid', {}]);
  const text = JSON.stringify(event);
  for (const personal of ['Asha', '9876543210', 'Lake Road']) assert.equal(text.includes(personal), false, `${personal} is not in the event`);
});

test('at least once: a listener that fails is tried again, and the events of one order arrive in order', async () => {
  const w = await world();
  const bus = createOrderEvents({ db: w.db });
  const seen = [];
  let failures = 2;
  let failFor = null;
  bus.on('*', 'test.flaky', (event) => {
    if (event.type === 'order.paid' && event.orderId === failFor && failures-- > 0) throw Object.assign(new Error('Asha Rao +919876543210 could not be reached'), { code: 'EFLAKY' });
    seen.push(`${event.orderId}:${event.type}`);
  });
  const first = await placeOrder(w);
  const second = await placeOrder(w);
  failFor = first.id;
  await pay(w, first.id);
  await pay(w, second.id);
  await tx(w, (t) => changeOrder(t, first.id, { fulfilment: 'packed', actor: 'user:1' }));

  await bus.drain();
  // The first order is stuck behind its failed 'order.paid'; the second order is not held up by it.
  assert.deepEqual(seen, [`${first.id}:order.created`, `${second.id}:order.created`, `${second.id}:order.paid`, `${second.id}:order.confirmed`]);
  const [stuck] = await w.db.platform.query(`SELECT attempts, last_error, status FROM order_event_deliveries WHERE listener = 'test.flaky' AND status = 'pending' ORDER BY event_id LIMIT 1`);
  assert.deepEqual([stuck.attempts, stuck.last_error], [1, 'EFLAKY'], 'the error’s code is kept, never its message');

  await due(w);
  await bus.drain();
  assert.equal(seen.length, 4, 'still failing: nothing later of that order has gone ahead');
  await due(w);
  await bus.drain();
  assert.deepEqual(seen.slice(4), [`${first.id}:order.paid`, `${first.id}:order.confirmed`, `${first.id}:order.packed`], 'then everything, in order');
  assert.ok((await deliveries(w, 'test.flaky')).every((d) => d.status === 'done'));
});

test('a listener that never succeeds is given up on, ops are told, and later events of that order go ahead', async () => {
  const w = await world();
  const bus = createOrderEvents({ db: w.db });
  const seen = [];
  bus.on('*', 'test.broken', (event) => {
    if (event.type === 'order.created') throw new Error('always');
    seen.push(event.type);
  });
  const order = await placeOrder(w);
  await pay(w, order.id);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await bus.drain();
    await due(w);
  }
  await bus.drain();
  const rows = await deliveries(w, 'test.broken');
  assert.deepEqual(rows.map((d) => [d.type, d.status]), [['order.created', 'failed'], ['order.paid', 'done'], ['order.confirmed', 'done']]);
  assert.equal(rows[0].attempts, MAX_ATTEMPTS);
  assert.deepEqual(seen, ['order.paid', 'order.confirmed']);
  const alerts = await w.db.platform.query(`SELECT audience, kind, severity FROM alerts WHERE kind = 'order_events.delivery_failed'`);
  assert.deepEqual(alerts, [{ audience: 'ops', kind: 'order_events.delivery_failed', severity: 'critical' }]);
});

test('listeners are named and typed; a module may emit only what the database does not', async () => {
  const w = await world();
  const bus = createOrderEvents({ db: w.db });
  bus.on('order.paid', 'test.one', () => {});
  assert.throws(() => bus.on('order.paid', 'test.one', () => {}), /both named/);
  assert.throws(() => bus.on('order.paid', 'NoDots', () => {}), /<module>\.<what>/);
  assert.throws(() => bus.on('order.exploded', 'test.two', () => {}), /not an order event/);
  assert.throws(() => bus.on('order.paid', 'test.three'), /needs a handler/);
  assert.deepEqual(bus.listeners(), ['test.one']);
  for (const type of EMITTED_EVENTS) assert.ok(ORDER_EVENTS.includes(type), type);

  const order = await placeOrder(w);
  await assert.rejects(() => tx(w, (t) => bus.emit(t, { type: 'order.paid', orderId: order.id })), /not an event a module may emit/);
  const first = await tx(w, (t) => bus.emit(t, { type: 'invoice.issued', orderId: order.id, entityId: 9, data: { number: 'INV/26-27/00001' }, dedupeKey: `invoice:${order.id}` }));
  const again = await tx(w, (t) => bus.emit(t, { type: 'invoice.issued', orderId: order.id, entityId: 9, dedupeKey: `invoice:${order.id}` }));
  assert.ok(first > 0);
  assert.equal(again, null, 'the same key is dropped');
  const got = [];
  bus.on('invoice.issued', 'test.invoices', (event) => got.push(event));
  await bus.drain();
  assert.deepEqual(got.map((e) => [e.entity, e.entityId, e.data.number]), [['invoice', 9, 'INV/26-27/00001']]);
});

test('payments, refunds, shipments and returns write their events too, and one business’s events never reach another’s listener run', async () => {
  const w = await world();
  const other = await otherBusiness(w);
  const bus = createOrderEvents({ db: w.db });
  const seen = [];
  bus.on('*', 'test.rows', (event) => seen.push([currentTenant().id, event.type, event.entity]));
  const order = await placeOrder(w);
  await pay(w, order.id);
  const [payment] = await query(w, `INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, amount_paise, status) VALUES ($1, $2, 'full', 'razorpay', 'managed', 50000, 'captured') RETURNING id`, [w.tenant.id, order.id]);
  const [refund] = await query(w, `INSERT INTO refunds (tenant_id, order_id, payment_id, amount_paise, method, requested_by, idempotency_key) VALUES ($1, $2, $3, 20000, 'gateway', 'user:1', 'refund-key-1') RETURNING id`, [w.tenant.id, order.id, payment.id]);
  await tx(w, (t) => changeRow(t, 'refunds', refund.id, 'processed'));
  const [shipment] = await query(w, `INSERT INTO shipments (tenant_id, order_id, mode, weight_grams, length_cm, breadth_cm, height_cm) VALUES ($1, $2, 'managed', 500, 10, 10, 10) RETURNING id`, [w.tenant.id, order.id]);
  await tx(w, (t) => changeRow(t, 'shipments', shipment.id, 'awb_assigned', { set: { awb: 'SIM000002001', courier_name: 'Simulated Courier' } }));
  await assert.rejects(() => tx(w, (t) => changeRow(t, 'shipments', shipment.id, 'delivered')), (err) => err.code === 'not_allowed');
  const [ret] = await query(w, `INSERT INTO returns (tenant_id, order_id) VALUES ($1, $2) RETURNING id`, [w.tenant.id, order.id]);
  await tx(w, (t) => changeRow(t, 'returns', ret.id, 'approved'));

  // Another business has an order of its own.
  const theirProduct = await other.inTenant(() => w.platform.products.create({ name: 'Other lamp', price: '100', active: 'on' }));
  const theirs = await placeOrder({ ...w, tenant: other.tenant, product: theirProduct, inTenant: other.inTenant });
  await bus.drain();
  const mine = seen.filter(([tenant]) => tenant === w.tenant.id).map(([, type]) => type);
  assert.deepEqual(mine, ['order.created', 'order.paid', 'order.confirmed', 'payment.captured', 'refund.requested', 'refund.processed', 'shipment.created', 'shipment.awb_assigned', 'return.requested', 'return.approved']);
  assert.deepEqual(seen.filter(([tenant]) => tenant === other.tenant.id), [[other.tenant.id, 'order.created', 'order']]);
  assert.ok(theirs.id);
  for (const [, type] of seen) assert.ok(ORDER_EVENTS.includes(type), `${type} is in the catalogue`);
});

test('the Phase 0 order route no longer has a wrapper: the order carries its visitor, and traffic links it from the event', async () => {
  const app = await startApp();
  try {
    assert.ok(app.ctx.orderEvents.listeners().includes('traffic.order-link'));
    const product = await app.repos.products.create({ name: 'Brass lamp', price: '500', active: 'on' });
    const visitor = crypto.randomUUID();
    const signIn = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) });
    const { token } = await signIn.json();
    const res = await fetch(`${app.base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, cookie: `_vid=${visitor}` },
      body: JSON.stringify({ items: [{ productId: product.id, qty: 1 }], customer: { name: 'Asha Rao', phone: '9876543210', address: '12 Lake Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' } }),
    });
    assert.equal(res.status, 201);
    const { token: orderToken } = await res.json();
    const order = await app.repos.orders.getByToken(orderToken);
    assert.equal(order.visitor_id, visitor);
    assert.equal(order.flow, 'manual');
    await app.ctx.orderEvents.settle();
    const rows = await app.db.platform.query(`SELECT d.status, e.type FROM order_event_deliveries d JOIN order_events e ON e.id = d.event_id WHERE d.listener = 'traffic.order-link' AND e.order_id = $1`, [order.id]);
    assert.deepEqual(rows, [{ status: 'done', type: 'order.created' }]);
    // No traffic visit existed for this visitor, so there was nothing to tie: the listener ran and did no harm.
    const src = (await import('node:fs')).readFileSync(new URL('../../../src/modules/traffic/index.js', import.meta.url), 'utf8');
    assert.equal(/app\.post\('\/api\/orders'/.test(src), false, 'traffic wraps no route');
  } finally {
    app.close();
  }
});

test('S-18: a limit holds across instances, because it is counted in the database', async () => {
  const w = await world();
  const { createRateLimit } = await import('../../../src/platform/rate-limit.js');
  const one = createRateLimit({ db: w.db });
  const two = createRateLimit({ db: w.db });
  const limit = { limit: 20, windowMs: 600_000 };
  const answers = [];
  for (let i = 0; i < 20; i++) answers.push(await (i % 2 ? one : two).hit('order_attempts', '203.0.113.9', limit));
  assert.ok(answers.every((a) => a.allowed));
  const over = await one.hit('order_attempts', '203.0.113.9', limit);
  assert.deepEqual([over.allowed, over.hits], [false, 21], 'the 21st across both');
  assert.ok(over.retryAfterMs > 0 && over.retryAfterMs <= 600_000);
  assert.equal((await two.hit('order_attempts', '198.51.100.7', limit)).allowed, true, 'another address has its own count');
  assert.equal((await two.peek('order_attempts', '203.0.113.9', limit)).allowed, false);
  // Only a hash is stored.
  const rows = await w.db.platform.query('SELECT key FROM rate_limit_hits');
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.key)));
  // The window passes and the count starts again.
  await w.db.platform.query(`UPDATE rate_limit_hits SET window_start = now() - interval '11 minutes'`);
  assert.deepEqual([(await one.hit('order_attempts', '203.0.113.9', limit)).hits], [1]);
  await withTenant(w.tenant, () => assert.rejects(() => w.db.query('SELECT 1 FROM rate_limit_hits'), /permission denied/));
});

// The order state machine (PRD 9.9): the moves in src/contracts/orders.js, the functions in src/modules/orders/state.js, and the
// database triggers of migrations 402 to 408 that refuse what the code would not do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FULFILMENT_STATUSES, MACHINES, PAYMENT_STATUSES, TRANSITIONS, eventTypeFor, financialYear, findTransition, legacyStatus, nextStatuses, orderTotal, passesGuard, splitGst, taxInside,
} from '../../../src/contracts/orders.js';
import { OrderStateError, addOrderNote, changeOrder, changeRow, holdOrder, releaseOrder, setManualStatus } from '../../../src/modules/orders/state.js';
import { otherBusiness, placeOrder, query, refusal, tx, world } from './support.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const history = (w, orderId) => query(w, 'SELECT machine, from_status, to_status, actor, reason, note FROM order_status_history WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [w.tenant.id, orderId]);
const events = (w, orderId) => query(w, 'SELECT type, entity, from_status, to_status FROM order_events WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [w.tenant.id, orderId]);
const reload = async (w, id) => (await query(w, 'SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [w.tenant.id, id]))[0];
const pay = (w, id, extra = {}) => tx(w, (t) => changeOrder(t, id, { payment: 'paid', fulfilment: 'new', actor: 'webhook:razorpay', ...extra }));

test('the moves in the database are exactly the moves in the code', async () => {
  const w = await world();
  const rows = await w.db.query('SELECT machine, from_status, to_status, guard FROM status_transitions ORDER BY machine, from_status, to_status');
  const inCode = MACHINES.flatMap((machine) => TRANSITIONS[machine].map((m) => ({ machine, from_status: m.from, to_status: m.to, guard: m.guard })))
    .sort((a, b) => `${a.machine} ${a.from_status} ${a.to_status}`.localeCompare(`${b.machine} ${b.from_status} ${b.to_status}`));
  assert.deepEqual(rows.sort((a, b) => `${a.machine} ${a.from_status} ${a.to_status}`.localeCompare(`${b.machine} ${b.from_status} ${b.to_status}`)), inCode);
  for (const machine of MACHINES) assert.equal(new Set(TRANSITIONS[machine].map((m) => `${m.from}>${m.to}`)).size, TRANSITIONS[machine].length, `${machine} lists a move twice`);
});

test('the Phase 0 status is derived the same way in the code and in the database', async () => {
  const w = await world();
  for (const f of FULFILMENT_STATUSES) {
    for (const p of PAYMENT_STATUSES) {
      const [{ status }] = await w.db.query('SELECT legacy_order_status($1, $2) AS status', [f, p]);
      assert.equal(status, legacyStatus(f, p), `${f} / ${p}`);
    }
  }
});

test('nothing moves backwards, and the guards say what they need', () => {
  assert.equal(findTransition('fulfilment', 'new', 'delivered'), null, 'S-30');
  assert.equal(findTransition('fulfilment', 'delivered', 'shipped'), null);
  assert.equal(findTransition('payment', 'paid', 'unpaid'), null);
  assert.equal(findTransition('payment_attempt', 'captured', 'failed'), null, 'S-24');
  assert.equal(findTransition('shipment', 'delivered', 'in_transit'), null);
  assert.deepEqual(nextStatuses('fulfilment', 'delivered'), []);
  assert.equal(findTransition('fulfilment', 'pending', 'new').guard, 'confirmed_payment');
  assert.equal(passesGuard('confirmed_payment', { payment_status: 'unpaid' }), false);
  assert.equal(passesGuard('confirmed_payment', { payment_status: 'cod_due' }), true);
  assert.equal(passesGuard('late_payment', { payment_status: 'paid', cancel_reason: 'seller' }), false);
  assert.equal(passesGuard('late_payment', { payment_status: 'paid', cancel_reason: 'hold_expired' }), true);
  assert.equal(passesGuard('no_such_guard', {}), false);
  assert.equal(eventTypeFor('order.fulfilment', 'pending', 'new'), 'order.confirmed');
  assert.equal(eventTypeFor('order.fulfilment', 'cancelled', 'new'), 'order.reinstated');
  assert.equal(eventTypeFor('order.payment', 'unpaid', 'cod_due'), 'order.cod_confirmed');
  assert.equal(eventTypeFor('shipment', 'in_transit', 'delivered'), 'shipment.delivered');
});

test('a prepaid order: paid confirms it, and each change writes its timeline row and its event in the same transaction', async () => {
  const w = await world();
  const order = await placeOrder(w);
  assert.deepEqual([order.fulfilment_status, order.payment_status, order.status], ['pending', 'unpaid', 'awaiting_payment']);

  const { order: paid, changed } = await pay(w, order.id, { reason: 'payment.captured' });
  assert.deepEqual(changed, { fulfilment: true, payment: true });
  assert.deepEqual([paid.fulfilment_status, paid.payment_status, paid.status], ['new', 'paid', 'paid'], 'the Phase 0 column follows');
  assert.ok(paid.paid_at && paid.confirmed_at);

  await tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'packed', actor: 'user:7' }));
  await tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'shipped', actor: 'user:7' }));
  const delivered = await tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'delivered', actor: 'webhook:shiprocket' }));
  assert.equal(delivered.order.status, 'delivered');

  assert.deepEqual((await history(w, order.id)).map((h) => [h.machine, h.from_status, h.to_status, h.actor]), [
    ['created', '', 'pending', 'system'],
    ['payment', 'unpaid', 'paid', 'webhook:razorpay'],
    ['fulfilment', 'pending', 'new', 'webhook:razorpay'],
    ['fulfilment', 'new', 'packed', 'user:7'],
    ['fulfilment', 'packed', 'shipped', 'user:7'],
    ['fulfilment', 'shipped', 'delivered', 'webhook:shiprocket'],
  ]);
  assert.equal((await history(w, order.id))[1].reason, 'payment.captured');
  assert.deepEqual((await events(w, order.id)).map((e) => e.type), ['order.created', 'order.paid', 'order.confirmed', 'order.packed', 'order.shipped', 'order.delivered'], 'money first, then what it caused');
});

test('a change that rolls back leaves no status, no timeline row and no event', async () => {
  const w = await world();
  const order = await placeOrder(w);
  await assert.rejects(() => tx(w, async (t) => {
    await changeOrder(t, order.id, { payment: 'paid', fulfilment: 'new', actor: 'webhook:razorpay' });
    throw new Error('something else in the same transaction failed');
  }), /something else/);
  assert.equal((await reload(w, order.id)).payment_status, 'unpaid');
  assert.equal((await history(w, order.id)).length, 1);
  assert.deepEqual((await events(w, order.id)).map((e) => e.type), ['order.created']);
});

test('S-30: a move that is not allowed is refused by the code, and by the database when the code is bypassed', async () => {
  const w = await world();
  const order = await placeOrder(w);
  await pay(w, order.id);
  await assert.rejects(() => tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'delivered', actor: 'user:7' })), (err) => err instanceof OrderStateError && err.code === 'not_allowed' && err.from === 'new' && err.to === 'delivered');
  assert.equal(await refusal(query(w, `UPDATE orders SET fulfilment_status = 'delivered' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, order.id])), 'orders_transition');
  assert.equal(await refusal(query(w, `UPDATE orders SET payment_status = 'unpaid' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, order.id])), 'orders_transition');
  assert.equal(await refusal(query(w, `UPDATE orders SET total_paise = 1, subtotal_paise = 1 WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, order.id])), 'orders_fixed', 'totals are fixed once placed');
  assert.equal(await refusal(query(w, `UPDATE orders SET flow = 'manual' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, order.id])), 'orders_fixed', 'an order cannot leave the machine');
  assert.equal((await reload(w, order.id)).fulfilment_status, 'new');
  // Writing the Phase 0 column of a checkout order changes nothing: it is derived.
  await query(w, `UPDATE orders SET status = 'delivered' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, order.id]);
  assert.deepEqual([(await reload(w, order.id)).status, (await reload(w, order.id)).fulfilment_status], ['paid', 'new']);
});

test('S-68: an unpaid order cannot be confirmed, in the code or in the database', async () => {
  const w = await world();
  const order = await placeOrder(w, { mode: 'part_advance' });
  await assert.rejects(() => tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'new', actor: 'user:7' })), (err) => err.code === 'guard' && err.guard === 'confirmed_payment');
  assert.equal(await refusal(query(w, `UPDATE orders SET fulfilment_status = 'new' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, order.id])), 'orders_guard');
  // The wrong kind of payment for how the order was placed is refused too.
  await assert.rejects(() => tx(w, (t) => changeOrder(t, order.id, { payment: 'cod_due', actor: 'system' })), (err) => err.guard === 'mode_cod');
  assert.equal(await refusal(query(w, `UPDATE orders SET payment_status = 'paid' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, order.id])), 'orders_guard');
  const { order: advanced } = await tx(w, (t) => changeOrder(t, order.id, { payment: 'advance_paid', fulfilment: 'new', actor: 'webhook:razorpay' }));
  assert.deepEqual([advanced.payment_status, advanced.fulfilment_status], ['advance_paid', 'new']);
  assert.ok(advanced.advance_paise > 0 && advanced.advance_paise + advanced.balance_paise === advanced.total_paise, 'S-21: the two parts are stored apart and add up');
});

test('cash on delivery is confirmed at once, collected at the door, and voided when it comes back', async () => {
  const w = await world();
  const order = await placeOrder(w, { mode: 'cod' });
  assert.equal(order.balance_paise, order.total_paise);
  const { order: confirmed } = await tx(w, (t) => changeOrder(t, order.id, { payment: 'cod_due', fulfilment: 'new', actor: 'shopper:1' }));
  assert.deepEqual([confirmed.payment_status, confirmed.fulfilment_status, confirmed.status], ['cod_due', 'new', 'paid']);
  await tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'shipped', actor: 'user:7' }));
  await tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'rto_initiated', actor: 'webhook:shiprocket' }));
  const { order: back } = await tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'rto_delivered', payment: 'voided', actor: 'webhook:shiprocket' }));
  assert.deepEqual([back.payment_status, back.status], ['voided', 'cancelled']);
  assert.deepEqual((await events(w, order.id)).map((e) => e.type), ['order.created', 'order.cod_confirmed', 'order.confirmed', 'order.shipped', 'order.rto_initiated', 'order.cod_voided', 'order.rto_delivered']);
});

test('S-24, S-23: a late or repeated provider event is skipped, never thrown and never a second change', async () => {
  const w = await world();
  const order = await placeOrder(w);
  await pay(w, order.id);
  const again = await pay(w, order.id, { ifAllowed: true });
  assert.deepEqual([again.changed, again.skipped], [{ fulfilment: false, payment: false }, []], 'the same status again is nothing');
  const stale = await tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'pending', ifAllowed: true, actor: 'webhook:razorpay' }));
  assert.deepEqual(stale.skipped.map((s) => [s.machine, s.from, s.to]), [['fulfilment', 'new', 'pending']]);
  assert.equal((await history(w, order.id)).filter((h) => h.machine === 'payment').length, 1, 'one status change');

  // The same for a payment attempt: captured, then a late "failed".
  const [payment] = await query(w, `INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, amount_paise, gateway_order_id) VALUES ($1, $2, 'full', 'razorpay', 'managed', 50000, 'order_x') RETURNING *`, [w.tenant.id, order.id]);
  await tx(w, (t) => changeRow(t, 'payments', payment.id, 'captured', { set: { gateway_payment_id: 'pay_x', method: 'upi', fee_paise: 1180 } }));
  const late = await tx(w, (t) => changeRow(t, 'payments', payment.id, 'failed', { ifAllowed: true }));
  assert.deepEqual([late.changed, late.row.status, late.skipped.length], [false, 'captured', 1]);
  await assert.rejects(() => tx(w, (t) => changeRow(t, 'payments', payment.id, 'failed')), (err) => err.code === 'not_allowed');
  assert.equal(await refusal(query(w, `UPDATE payments SET status = 'failed' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, payment.id])), 'payments_transition');
  assert.deepEqual((await events(w, order.id)).filter((e) => e.entity === 'payment').map((e) => e.type), ['payment.created', 'payment.captured']);
  await assert.rejects(() => tx(w, (t) => changeRow(t, 'payments', payment.id, 'captured', { set: { order_id: 1 } })), /can't be written/);
  await assert.rejects(() => tx(w, (t) => changeRow(t, 'orders', order.id, 'captured')), /no status machine/);
});

test('S-31, S-41: cancelling keeps its reason, and only a late payment brings a cancelled order back', async () => {
  const w = await world();
  const paidOrder = await placeOrder(w);
  await pay(w, paidOrder.id);
  await tx(w, (t) => changeOrder(t, paidOrder.id, { fulfilment: 'packed', actor: 'user:7' }));
  const { order: cancelled } = await tx(w, (t) => changeOrder(t, paidOrder.id, { fulfilment: 'cancelled', cancelReason: 'seller', actor: 'user:7' }));
  assert.deepEqual([cancelled.fulfilment_status, cancelled.cancel_reason, cancelled.payment_status, cancelled.status], ['cancelled', 'seller', 'paid', 'cancelled'], 'still paid: the refund is the owner’s to make');
  assert.ok(cancelled.cancelled_at);
  await assert.rejects(() => tx(w, (t) => changeOrder(t, paidOrder.id, { fulfilment: 'new', actor: 'user:7' })), (err) => err.guard === 'late_payment');
  assert.equal(await refusal(query(w, `UPDATE orders SET fulfilment_status = 'new' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, paidOrder.id])), 'orders_guard');

  const expired = await placeOrder(w);
  await tx(w, (t) => changeOrder(t, expired.id, { fulfilment: 'cancelled', cancelReason: 'hold_expired', actor: 'job:hold-expiry' }));
  const { order: late } = await tx(w, (t) => changeOrder(t, expired.id, { payment: 'paid', actor: 'webhook:razorpay' }));
  assert.deepEqual([late.fulfilment_status, late.payment_status], ['cancelled', 'paid']);
  const { order: held } = await tx(w, (t) => holdOrder(t, expired.id, 'paid_out_of_stock', { actor: 'webhook:razorpay' }));
  assert.equal(held.hold_reason, 'paid_out_of_stock');
  const { order: reinstated } = await tx(w, (t) => changeOrder(t, expired.id, { fulfilment: 'new', actor: 'user:7' }));
  assert.deepEqual([reinstated.fulfilment_status, reinstated.cancel_reason, reinstated.cancelled_at], ['new', null, null]);
  await tx(w, (t) => releaseOrder(t, expired.id, { actor: 'user:7' }));
  assert.deepEqual((await events(w, expired.id)).map((e) => e.type), ['order.created', 'order.cancelled', 'order.paid', 'order.held', 'order.reinstated', 'order.released']);
  await assert.rejects(() => tx(w, (t) => holdOrder(t, expired.id, 'because', { actor: 'user:7' })), /Unknown hold reason/);
});

test('the timeline takes notes, and an actor is an id, never a name', async () => {
  const w = await world();
  const order = await placeOrder(w);
  await tx(w, (t) => addOrderNote(t, order.id, { actor: 'user:7', note: '  Customer asked for gift wrap  ' }));
  assert.deepEqual((await history(w, order.id)).at(-1), { machine: 'note', from_status: '', to_status: '', actor: 'user:7', reason: '', note: 'Customer asked for gift wrap' });
  await assert.rejects(() => tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'cancelled', actor: 'Asha Rao' })), /actor must be an id/);
  await assert.rejects(() => tx(w, (t) => addOrderNote(t, order.id, { actor: 'user:7', note: ' ' })), /Write a note/);
  await assert.rejects(() => tx(w, (t) => changeOrder(t, 999999, { fulfilment: 'cancelled', actor: 'user:7' })), (err) => err.code === 'not_found');
});

test('the database checks an order’s money against its lines and against itself', async () => {
  const w = await world();
  // Two lines with a coupon share: 2 x 500 + 1 x 250, less 100.
  const good = await placeOrder(w, { lines: [{ pricePaise: 50000, qty: 2, discountPaise: 8000 }, { pricePaise: 25000, qty: 1, discountPaise: 2000 }], shippingPaise: 4900 });
  assert.deepEqual([good.subtotal_paise, good.discount_paise, good.total_paise], [125000, 10000, 119900]);

  assert.equal(await refusal(placeOrder(w, { order: { subtotal_paise: 1, total_paise: 1 } })), 'orders_lines_match', 'a subtotal that is not the lines');
  assert.equal(await refusal(placeOrder(w, { lines: [] })), 'orders_lines_match', 'an order with no lines');
  assert.equal(await refusal(placeOrder(w, { order: { discount_paise: 100, total_paise: 49900 } })), 'orders_lines_match', 'a discount no line carries');
  assert.equal(await refusal(placeOrder(w, { order: { total_paise: 1 } })), 'orders_total_adds_up');
  assert.equal(await refusal(placeOrder(w, { order: { shipping_paise: -1, total_paise: 49999 } })), 'orders_money_not_negative');
  assert.equal(await refusal(placeOrder(w, { mode: 'cod', order: { balance_paise: 1 } })), 'orders_split_adds_up');
  assert.equal(await refusal(placeOrder(w, { order: { idempotency_key: null } })), 'orders_checkout_complete');
  assert.equal(await refusal(placeOrder(w, { order: { fulfilment_status: 'delivered' } })), 'orders_transition', 'a new order starts pending');

  // A line cannot be slipped in or changed afterwards without the totals noticing.
  assert.equal(await refusal(query(w, `INSERT INTO order_items (tenant_id, order_id, name, price_paise, qty) VALUES ($1, $2, 'Extra', 100, 1)`, [w.tenant.id, good.id])), 'orders_lines_match');
  assert.equal(await refusal(query(w, 'UPDATE order_items SET qty = 9 WHERE tenant_id = $1 AND order_id = $2', [w.tenant.id, good.id])), 'orders_lines_match');
  // An order above a 32-bit amount of paise is still an order.
  const big = await placeOrder(w, { lines: [{ pricePaise: 3_000_000_000, qty: 2 }] });
  assert.equal(big.total_paise, 6_000_000_000);
  // The same idempotency key is one order (S-15).
  assert.equal(await refusal(placeOrder(w, { order: { idempotency_key: good.idempotency_key } })), 'orders_idempotency_idx');
});

test('a Phase 0 order keeps its own column and rule, and the two new statuses follow it', async () => {
  const w = await world();
  const settings = await w.repos.settings.getAll();
  const customer = { name: 'Asha Rao', phone: '9876543210', address: '12 Lake Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' };
  const order = await w.repos.orders.create({ items: [{ productId: w.product.id, qty: 1 }], customer }, settings);
  assert.deepEqual([order.flow, order.status, order.fulfilment_status, order.payment_status], ['manual', 'awaiting_payment', 'pending', 'unpaid']);
  await w.repos.orders.markPaymentSubmitted(order.public_token);
  assert.deepEqual([(await reload(w, order.id)).status, (await reload(w, order.id)).payment_status], ['payment_submitted', 'submitted']);
  await w.repos.orders.setStatus(order.id, 'shipped');
  assert.deepEqual([(await reload(w, order.id)).fulfilment_status, (await reload(w, order.id)).payment_status], ['shipped', 'paid'], 'no machine for a Phase 0 order');
  await w.repos.orders.setStatus(order.id, 'cancelled', 'changed their mind');
  await assert.rejects(() => w.repos.orders.setStatus(order.id, 'paid'), /can’t be reopened/);
  assert.equal(await refusal(query(w, `UPDATE orders SET status = 'paid' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, order.id])), 'orders_transition');
  assert.equal(await refusal(query(w, `UPDATE orders SET status = 'nonsense' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, order.id])), 'orders_status_known');
  assert.deepEqual((await events(w, order.id)).map((e) => e.type), ['order.created', 'order.paid', 'order.shipped', 'order.cancelled'], 'its changes are events too');

  // The two kinds of order never borrow each other's door.
  await assert.rejects(() => tx(w, (t) => changeOrder(t, order.id, { fulfilment: 'new', actor: 'user:7' })), (err) => err.code === 'manual_order');
  const checkout = await placeOrder(w);
  await assert.rejects(() => tx(w, (t) => setManualStatus(t, checkout.id, 'paid')), (err) => err.code === 'checkout_order');
  await assert.rejects(() => w.repos.orders.setStatus(checkout.id, 'paid'), /its own actions/);
});

test('this file is the only one in src that writes a status', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !full.endsWith(path.join('modules', 'orders', 'state.js'))) {
        const source = fs.readFileSync(full, 'utf8');
        if (/UPDATE\s+orders\b[^`'"]*\bSET\b[^`'"]*\b(fulfilment_status|payment_status|hold_reason|status)\s*=/i.test(source)) offenders.push(`${path.relative(repoRoot, full)} (orders)`);
        if (/UPDATE\s+(payments|refunds|shipments|returns)\b[^`'"]*\bSET\b[^`'"]*\bstatus\s*=/i.test(source)) offenders.push(`${path.relative(repoRoot, full)} (child row)`);
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  assert.deepEqual(offenders, [], 'change an order through src/modules/orders/state.js');
});

test('S-28: refunds can never add up to more than was captured, even two at once', async () => {
  const w = await world();
  const order = await placeOrder(w, { lines: [{ pricePaise: 99900, qty: 1 }] });
  await pay(w, order.id);
  const [payment] = await query(w, `INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, amount_paise) VALUES ($1, $2, 'full', 'razorpay', 'managed', 99900) RETURNING *`, [w.tenant.id, order.id]);
  const refund = (amount, key) => query(w, `INSERT INTO refunds (tenant_id, order_id, payment_id, amount_paise, method, requested_by, idempotency_key) VALUES ($1, $2, $3, $4, 'gateway', 'user:1', $5) RETURNING id`, [w.tenant.id, order.id, payment.id, amount, key]);
  assert.equal(await refusal(refund(20000, 'refund-key-0')), 'refunds_payment_captured', 'nothing to refund before the money arrived');
  await tx(w, (t) => changeRow(t, 'payments', payment.id, 'captured'));
  const [first] = await refund(20000, 'refund-key-1');
  assert.equal(await refusal(refund(100, 'refund-key-1')), 'refunds_tenant_id_idempotency_key_key', 'the same key is the same refund');
  assert.equal(await refusal(refund(100000, 'refund-key-2')), 'refunds_within_captured', 'Rs 1,000 on Rs 999');
  assert.equal(await refusal(refund(79901, 'refund-key-3')), 'refunds_within_captured');
  const racing = await Promise.allSettled([refund(79900, 'refund-key-4'), refund(79900, 'refund-key-5')]);
  assert.deepEqual(racing.map((r) => r.status).sort(), ['fulfilled', 'rejected'], 'one of two racing refunds for the rest');
  // A failed refund gives its amount back.
  await tx(w, (t) => changeRow(t, 'refunds', first.id, 'failed'));
  assert.equal((await refund(20000, 'refund-key-6')).length, 1);
  assert.equal(await refusal(query(w, 'UPDATE refunds SET amount_paise = 1 WHERE tenant_id = $1 AND id = $2', [w.tenant.id, first.id])), 'refunds_fixed');
});

test('S-43, S-44: invoice numbers are the database’s, consecutive, with no gap, and start again each April', async () => {
  const w = await world();
  const invoice = (orderId, extra = {}) => {
    const row = { doc_type: 'invoice', seller: '{}', buyer: '{}', place_of_supply: '27', lines: '[{"description":"Brass lamp"}]', taxable_paise: 100000, cgst_paise: 2500, sgst_paise: 2500, total_paise: 105000, ...extra };
    const columns = Object.keys(row);
    return query(w, `INSERT INTO invoices (tenant_id, order_id, ${columns.join(', ')}) VALUES ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id, number, fy, seq`, [w.tenant.id, orderId, ...columns.map((c) => row[c])]);
  };
  const orders = [];
  for (let i = 0; i < 5; i++) orders.push(await placeOrder(w));

  // Whatever number the caller asks for is ignored.
  const [first] = await invoice(orders[0].id, { issued_at: '2026-11-11T10:00:00+05:30', number: 'MINE/1', seq: 77, fy: 1999 });
  assert.deepEqual([first.number, first.fy, first.seq], ['INV/26-27/00001', 2026, 1]);
  // A second invoice for the same order is refused before a number is taken, even when the caller says to ignore conflicts.
  assert.equal(await refusal(invoice(orders[0].id, { issued_at: '2026-11-11T10:00:01+05:30' })), 'invoices_order_idx');
  assert.equal(await refusal(query(w, `INSERT INTO invoices (tenant_id, order_id, doc_type, seller, buyer, place_of_supply, lines, taxable_paise, total_paise)
    VALUES ($1, $2, 'invoice', '{}', '{}', '27', '[{}]', 1, 1) ON CONFLICT DO NOTHING`, [w.tenant.id, orders[0].id])), 'invoices_order_idx');
  // One that fails for another reason gives its number back.
  assert.equal(await refusal(invoice(orders[1].id, { issued_at: '2026-11-11T10:00:02+05:30', total_paise: 1 })) !== null, true);
  // Two issued in the same second.
  const pair = await Promise.all([invoice(orders[1].id, { issued_at: '2026-11-11T10:00:03+05:30' }), invoice(orders[2].id, { issued_at: '2026-11-11T10:00:03+05:30' })]);
  assert.deepEqual(pair.map(([r]) => r.seq).sort(), [2, 3], 'consecutive, no gap');
  // 31 March 23:59 India time is still the old year; 1 April 00:00 starts a new series.
  const [march] = await invoice(orders[3].id, { issued_at: '2027-03-31T23:59:59+05:30' });
  const [april] = await invoice(orders[4].id, { issued_at: '2027-04-01T00:00:00+05:30' });
  assert.deepEqual([march.number, april.number], ['INV/26-27/00004', 'INV/27-28/00001']);
  assert.equal(financialYear(new Date('2027-03-31T23:59:59+05:30')), 2026);
  assert.equal(financialYear(new Date('2027-04-01T00:00:00+05:30')), 2027);
  // Credit notes have their own series, and an issued document cannot be changed or deleted.
  const [note] = await invoice(orders[0].id, { doc_type: 'credit_note', original_invoice_id: first.id, issued_at: '2026-11-12T10:00:00+05:30' });
  assert.equal(note.number, 'CN/26-27/00001');
  assert.equal(await refusal(query(w, 'UPDATE invoices SET total_paise = 1, taxable_paise = 1, cgst_paise = 0, sgst_paise = 0 WHERE tenant_id = $1 AND id = $2', [w.tenant.id, first.id])), 'invoices_frozen');
  await query(w, `UPDATE invoices SET file_key = 'invoices/1.pdf', buyer = '{"name":"-"}', buyer_masked_at = now() WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, first.id]);
  await assert.rejects(() => query(w, 'DELETE FROM invoices WHERE tenant_id = $1 AND id = $2', [w.tenant.id, first.id]), /permission denied/);
  assert.equal(await refusal(invoice(orders[4].id, { doc_type: 'bill_of_supply', issued_at: '2027-04-02T00:00:00+05:30' })) !== null, true, 'tax on a bill of supply is refused');
});

test('S-42 and the money rules: paise in, paise out, nothing lost to rounding', () => {
  assert.deepEqual(taxInside(105000, 500), { taxablePaise: 100000, taxPaise: 5000 });
  assert.deepEqual(splitGst(5000, { sellerState: '07', buyerState: '07' }), { cgstPaise: 2500, sgstPaise: 2500, igstPaise: 0 });
  assert.deepEqual(splitGst(5000, { sellerState: '07', buyerState: '27' }), { cgstPaise: 0, sgstPaise: 0, igstPaise: 5000 });
  assert.deepEqual(splitGst(5001, { sellerState: '07', buyerState: '07' }), { cgstPaise: 2500, sgstPaise: 2501, igstPaise: 0 }, 'an odd paisa is never dropped');
  for (const [gross, rate] of [[1, 500], [99999, 1800], [123457, 1200], [1050, 0], [9_007_199_254_740, 2800]]) {
    const { taxablePaise, taxPaise } = taxInside(gross, rate);
    assert.equal(taxablePaise + taxPaise, gross, `${gross} at ${rate}`);
    assert.ok(Number.isSafeInteger(taxablePaise) && taxPaise >= 0);
  }
  assert.equal(orderTotal({ subtotalPaise: 200000, discountPaise: 15000, shippingPaise: 4900, codFeePaise: 2000 }), 191900);
  assert.throws(() => orderTotal({ subtotalPaise: 100, discountPaise: 200 }), /can’t be more/);
  assert.throws(() => orderTotal({ subtotalPaise: 10.5 }), /whole paise/);
  assert.throws(() => taxInside(-1, 500), /whole paise/);
  assert.throws(() => taxInside(100, 500.5), /basis points/);
});

test('S-47, S-16: the limits that must hold under simultaneous checkouts are the database’s', async () => {
  const w = await world();
  const [coupon] = await query(w, `INSERT INTO coupons (tenant_id, code, kind, percent_bp, max_uses) VALUES ($1, 'REEL10', 'percent', 1000, 2) RETURNING id`, [w.tenant.id]);
  const use = () => query(w, 'UPDATE coupons SET used_count = used_count + 1 WHERE tenant_id = $1 AND id = $2', [w.tenant.id, coupon.id]);
  const uses = await Promise.allSettled([use(), use(), use(), use()]);
  assert.equal(uses.filter((u) => u.status === 'fulfilled').length, 2, 'only the allowed number get the discount');
  assert.equal(await refusal(query(w, `INSERT INTO coupons (tenant_id, code, kind, percent_bp) VALUES ($1, 'REEL10', 'percent', 500)`, [w.tenant.id])), 'coupons_tenant_id_code_key');
  assert.equal(await refusal(query(w, `INSERT INTO coupons (tenant_id, code, kind, amount_paise) VALUES ($1, 'BAD', 'percent', 500)`, [w.tenant.id])) !== null, true, 'a percent coupon needs a percent');

  await query(w, 'UPDATE products SET stock = 1 WHERE tenant_id = $1 AND id = $2', [w.tenant.id, w.product.id]);
  const hold = () => query(w, 'UPDATE products SET reserved = reserved + 1 WHERE tenant_id = $1 AND id = $2', [w.tenant.id, w.product.id]);
  const holds = await Promise.allSettled([hold(), hold()]);
  assert.deepEqual(holds.map((h) => h.status).sort(), ['fulfilled', 'rejected'], 'the last unit goes to one shopper');
  assert.equal(await refusal(query(w, 'UPDATE products SET stock = -1, reserved = 0 WHERE tenant_id = $1 AND id = $2', [w.tenant.id, w.product.id])), 'products_stock_check', 'stock never goes below zero');

  const [shopper] = await query(w, `INSERT INTO shoppers (tenant_id, phone) VALUES ($1, '+919876543210') RETURNING id`, [w.tenant.id]);
  await query(w, 'INSERT INTO loyalty_accounts (tenant_id, shopper_id, balance) VALUES ($1, $2, 10)', [w.tenant.id, shopper.id]);
  const spend = () => query(w, 'UPDATE loyalty_accounts SET balance = balance - 10 WHERE tenant_id = $1 AND shopper_id = $2', [w.tenant.id, shopper.id]);
  assert.deepEqual((await Promise.allSettled([spend(), spend()])).map((s) => s.status).sort(), ['fulfilled', 'rejected'], 'points are spent once');
  assert.equal(await refusal(query(w, `INSERT INTO shopper_addresses (tenant_id, shopper_id, name, phone, line1, city, state_code, pincode) VALUES ($1, $2, 'Asha Rao', '+919876543210', '12 Lake Road', 'Pune', '27', '012345')`, [w.tenant.id, shopper.id])) !== null, true, 'S-12');
});

test('every Phase 4 table of a business is fenced, and one business cannot see or link to another’s rows', async () => {
  const w = await world();
  const tables = await w.db.query(
    `SELECT c.relname AS name, c.relrowsecurity AS fenced, EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
            has_table_privilege('bhava_app', c.oid, 'SELECT') AS app_reads
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
  );
  const PLATFORM_ONLY = ['provider_webhook_events', 'rate_limit_hits', 'shared_addresses', 'shared_cod_signals', 'shared_consent_log', 'shared_consent_notices', 'shared_profile_links', 'shared_profiles'];
  const PHASE4 = ['shoppers', 'shopper_sessions', 'shopper_otps', 'shopper_addresses', 'carts', 'cart_lines', 'order_status_history', 'order_events', 'order_event_deliveries', 'payment_settings', 'payments', 'refunds',
    'settlement_lines', 'reconciliation_gaps', 'inventory_settings', 'stock_reservations', 'stock_movements', 'coupons', 'coupon_redemptions', 'shipping_settings', 'shipments', 'shipment_events', 'serviceability_cache',
    'invoice_settings', 'invoice_sequences', 'invoices', 'whatsapp_accounts', 'whatsapp_templates', 'alert_settings', 'order_alerts', 'cart_reminders', 'return_settings', 'returns', 'return_items', 'return_proofs',
    'consent_notices', 'consent_records', 'policy_pages', 'privacy_settings', 'data_requests', 'reviews', 'review_photos', 'product_ratings', 'wishlist_items', 'loyalty_settings', 'loyalty_accounts', 'loyalty_ledger',
    'referral_codes', 'referrals', 'shopify_connections', 'shopify_links', 'shopify_order_pushes', 'shopify_conflicts'];
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const name of PHASE4) {
    const table = byName.get(name);
    assert.ok(table, `${name} exists`);
    assert.deepEqual([table.has_tenant, table.fenced, table.app_reads], [true, true, true], `${name} has tenant_id, row-level security and a grant`);
  }
  for (const name of PLATFORM_ONLY) assert.equal(byName.get(name)?.app_reads, false, `${name} is the platform's alone: business code cannot read it`);
  // Every table with a tenant_id is either fenced or deliberately the platform's.
  for (const table of tables) if (table.has_tenant && !PLATFORM_ONLY.includes(table.name)) assert.equal(table.fenced, true, `${table.name} has tenant_id but no fence`);

  const other = await otherBusiness(w);
  const order = await placeOrder(w);
  assert.deepEqual(await other.inTenant(() => w.db.query('SELECT id FROM orders')), [], 'the fence, with no WHERE');
  assert.deepEqual(await other.inTenant(() => w.db.query('SELECT id FROM order_events')), []);
  assert.deepEqual(await other.inTenant(() => w.db.query('SELECT id FROM order_status_history')), []);
  // A payment in one business cannot point at another business's order.
  assert.match(String(await refusal(other.inTenant(() => w.db.query(`INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, amount_paise) VALUES ($1, $2, 'full', 'razorpay', 'managed', 100)`, [other.tenant.id, order.id])))), /fkey/);
  await assert.rejects(() => other.inTenant(() => w.db.query('SELECT 1 FROM shared_profiles')), /permission denied/);
  await assert.rejects(() => other.inTenant(() => w.db.query('SELECT 1 FROM provider_webhook_events')), /permission denied/);
  await assert.rejects(() => query(w, 'DELETE FROM order_status_history WHERE tenant_id = $1', [w.tenant.id]), /permission denied/, 'the timeline is insert-only');
  await assert.rejects(() => query(w, 'UPDATE order_events SET type = $2 WHERE tenant_id = $1', [w.tenant.id, 'order.paid']), /permission denied/, 'so is the outbox');
});

/**
 * Razorpay, base routes only: orders, payments and refunds with Basic auth; amounts are integer paise.
 * POST /__sim/pay { orderId } plays the shopper paying and returns the payment and its checkout signature.
 * Later phases add Route transfers and webhooks.
 */
import crypto from 'node:crypto';
import { SimError, createSim } from '../base.mjs';

const razorpayError = (status, description, code = 'BAD_REQUEST_ERROR') => new SimError(status, { error: { code, description, source: 'NA', step: 'NA', reason: 'NA', metadata: {} } });
const seconds = (ms) => Math.floor(ms / 1000);

export function createRazorpay({ keyId = 'rzp_test_sim', keySecret = 'sim-key-secret' } = {}) {
  let orders;
  let payments;
  let refunds;
  let seq;
  const clear = () => {
    orders = new Map();
    payments = new Map();
    refunds = new Map();
    seq = 0;
  };
  clear();
  const nextId = (prefix) => `${prefix}_sim${String(++seq).padStart(10, '0')}`;

  function requireAuth(req) {
    const [kind, value] = String(req.headers.authorization ?? '').split(' ');
    const expected = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    if (kind?.toLowerCase() !== 'basic' || value !== expected) throw razorpayError(401, 'The API key provided is invalid', 'BAD_REQUEST_ERROR');
  }

  const sim = createSim({
    name: 'razorpay',
    errorBody: ({ kind, fault }) => ({ error: { code: fault.code ?? (kind === 'rate_limit' ? 'TOO_MANY_REQUESTS' : 'SERVER_ERROR'), description: `Simulated ${kind}.`, source: 'NA', step: 'NA', reason: 'NA', metadata: {} } }),
    reset: clear,
    routes: (on) => {
      on('POST', '/v1/orders', (req) => {
        requireAuth(req);
        const { amount, currency = 'INR', receipt, notes = {} } = req.body ?? {};
        if (!Number.isInteger(amount) || amount < 100) throw razorpayError(400, 'The amount must be an integer of at least 100 paise.');
        if (currency !== 'INR') throw razorpayError(400, 'Only INR is simulated.');
        const order = { id: nextId('order'), entity: 'order', amount, amount_paid: 0, amount_due: amount, currency, receipt, status: 'created', attempts: 0, notes, created_at: seconds(sim.clock.now()) };
        orders.set(order.id, order);
        return order;
      });
      on('GET', '/v1/orders/:id', (req) => {
        requireAuth(req);
        const order = orders.get(req.params.id);
        if (!order) throw razorpayError(400, 'The id provided does not exist');
        return order;
      });
      on('GET', '/v1/payments/:id', (req) => {
        requireAuth(req);
        const payment = payments.get(req.params.id);
        if (!payment) throw razorpayError(400, 'The id provided does not exist');
        return payment;
      });
      on('POST', '/v1/payments/:id/refund', (req) => {
        requireAuth(req);
        const payment = payments.get(req.params.id);
        if (!payment) throw razorpayError(400, 'The id provided does not exist');
        const amount = req.body?.amount ?? payment.amount - payment.amount_refunded;
        if (!Number.isInteger(amount) || amount < 1) throw razorpayError(400, 'The refund amount must be a positive integer.');
        if (amount > payment.amount - payment.amount_refunded) throw razorpayError(400, 'The total refund amount is greater than the refund payment amount');
        payment.amount_refunded += amount;
        const refund = { id: nextId('rfnd'), entity: 'refund', amount, currency: payment.currency, payment_id: payment.id, status: 'processed', created_at: seconds(sim.clock.now()) };
        refunds.set(refund.id, refund);
        return refund;
      });
    },
    controls: (on) => {
      on('POST', '/pay', ({ body }) => {
        const order = orders.get(body.orderId);
        if (!order) throw new SimError(404, { error: 'No such order.' });
        if (order.status === 'paid') throw new SimError(409, { error: 'That order is already paid.' });
        const payment = { id: nextId('pay'), entity: 'payment', amount: order.amount, currency: order.currency, status: 'captured', order_id: order.id, method: body.method ?? 'upi', amount_refunded: 0, captured: true, created_at: seconds(sim.clock.now()) };
        payments.set(payment.id, payment);
        Object.assign(order, { status: 'paid', amount_paid: order.amount, amount_due: 0, attempts: order.attempts + 1 });
        const signature = crypto.createHmac('sha256', keySecret).update(`${order.id}|${payment.id}`).digest('hex');
        return { payment, signature };
      });
    },
  });
  return sim;
}

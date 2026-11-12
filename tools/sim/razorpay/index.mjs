/**
 * Razorpay: orders, payments and refunds with Basic auth (Bhava's own keys) or a Bearer token (a seller's own account, by
 * Partner OAuth); Route linked accounts and transfers; and the webhooks Razorpay sends. Amounts are integer paise.
 *
 * API (what src/adapters/razorpay calls):
 *   POST /v1/orders { amount, currency, receipt, notes, transfers? }     transfers: [{ account, amount }] is Route
 *   GET  /v1/orders/:id            GET /v1/orders/:id/payments
 *   GET  /v1/payments/:id
 *   POST /v1/payments/:id/refund { amount?, reverse_all? }               X-Refund-Idempotency repeats the same refund
 *   GET  /v1/payments/:id/refunds/:refundId
 *   POST /v2/accounts              GET /v2/accounts/:id                  linked accounts (Route)
 *   GET  /v1/transfers/:id
 *   POST /token                                                          Partner OAuth: authorization_code or refresh_token
 *   POST /v1/customers   POST /v1/plans { period, interval, item: { name, amount } }                 Bhava's own billing (PRD 5.12)
 *   POST /v1/subscriptions { plan_id, customer_id, total_count, notes }      GET /v1/subscriptions/:id
 *   PATCH /v1/subscriptions/:id { plan_id, schedule_change_at: 'now' | 'cycle_end' }                 POST /v1/subscriptions/:id/cancel
 *   POST /v1/subscriptions/:id/addons { item: { name, amount }, quantity, notes }    GET /v1/addons?subscription_id=
 *   GET  /v1/settlements/recon/combined?year=&month=    with X-Razorpay-Account: what was settled to one linked account in a month
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults, calls, the clock):
 *   POST /pay { orderId, method?, outcome?: 'captured' | 'failed' | 'authorized', webhook?, hold?, duplicates?, signature?, amount? }
 *       Plays the shopper paying. Returns { payment, signature } with the checkout signature the browser would bring back.
 *       With webhook true (the default when a webhook URL is set) it also sends payment.captured or payment.failed (and
 *       order.paid), signed with the webhook secret. `amount` pays a different amount than the order's, for the mismatch case.
 *   POST /capture { paymentId }                 an authorized payment is captured
 *   POST /accounts/kyc { id, status }           moves a linked account: created, under_review, activated, rejected
 *   POST /transfers/settle { id } | /transfers/fail { id }                sends transfer.processed / transfer.failed
 *   POST /oauth/code { accountId }              -> { code }: what the seller's consent screen would send back
 *   POST /webhooks/send { event, payload?, accountId?, ...delivery }     any event by hand, signed like the rest
 *   POST /billing/webhook-url { url }           where subscription events go: their own address, signed with billingWebhookSecret
 *   POST /subscriptions/authorize { id }        the payer finished the hosted page: active, subscription.activated
 *   POST /subscriptions/charge { id, outcome?: 'charged' | 'failed' | 'halted', ...delivery }
 *       A renewal on the controlled clock. charged: a captured payment for the plan's amount plus every add-on waiting, the
 *       period moves on one cycle from the clock's now, subscription.charged. failed: a failed payment, status pending,
 *       subscription.pending. halted: Razorpay gave up retrying, status halted, subscription.halted.
 *   POST /subscriptions/cancel { id }           subscription.cancelled
 *   POST /webhooks/url { url }    POST /webhooks/flush { order? }    POST /webhooks/redeliver { id, times? }    GET /webhooks
 *
 * Delivery options on every control that sends a webhook: duplicates (the same event id again), hold (keep it back, then
 * flush in another order: a "failed" after its "captured"), signature 'good' | 'bad' | 'none'. Each event has its own id
 * in X-Razorpay-Event-Id; a duplicate carries the same id. A partial fault (base.mjs) makes a call take effect and then
 * fail, which is how a refund or an order ends up existing when the caller saw an error.
 *
 * An event for a seller's own account is sent to that account's webhook URL (set with POST /webhooks/url { url, accountId }),
 * signed with that account's secret.
 */
import crypto from 'node:crypto';
import { SimError, createSim } from '../base.mjs';
import { createWebhooks, webhookControls } from '../webhooks.mjs';

const razorpayError = (status, description, code = 'BAD_REQUEST_ERROR') => new SimError(status, { error: { code, description, source: 'NA', step: 'NA', reason: 'NA', metadata: {} } });
const seconds = (ms) => Math.floor(ms / 1000);
const FEE_BP = 200; // 2% gateway fee
const FEE_TAX_BP = 1800; // 18% GST on the fee

export function createRazorpay({ keyId = 'rzp_test_sim', keySecret = 'sim-key-secret', webhookSecret = 'sim-webhook-secret', webhookUrl = null, billingWebhookSecret = 'sim-billing-webhook-secret', billingWebhookUrl = null, partner = { clientId: 'sim-partner-client', clientSecret: 'sim-partner-secret' } } = {}) {
  let customers;
  let plans;
  let subscriptions;
  let addons;
  let billingUrl = billingWebhookUrl;
  let orders;
  let payments;
  let refunds;
  let refundKeys;
  let accounts;
  let transfers;
  let tokens;
  let codes;
  let ownWebhooks;
  let seq;
  const clear = () => {
    orders = new Map();
    payments = new Map();
    refunds = new Map();
    refundKeys = new Map();
    accounts = new Map();
    transfers = new Map();
    tokens = new Map();
    codes = new Map();
    ownWebhooks = new Map();
    customers = new Map();
    plans = new Map();
    subscriptions = new Map();
    addons = new Map();
    billingUrl = billingWebhookUrl;
    seq = 0;
  };
  clear();
  const nextId = (prefix) => `${prefix}_sim${String(++seq).padStart(10, '0')}`;

  /** Who is calling: Bhava's own keys ('platform'), or a seller's account by its OAuth token. */
  function caller(req) {
    const [kind, value] = String(req.headers.authorization ?? '').split(' ');
    if (kind?.toLowerCase() === 'basic' && value === Buffer.from(`${keyId}:${keySecret}`).toString('base64')) return 'platform';
    if (kind?.toLowerCase() === 'bearer' && tokens.has(value)) return tokens.get(value);
    throw razorpayError(401, 'The API key provided is invalid', 'BAD_REQUEST_ERROR');
  }
  const owned = (map, id, owner) => {
    const item = map.get(id);
    if (!item || item.owner !== owner) throw razorpayError(400, 'The id provided does not exist');
    return item;
  };
  const publicView = ({ owner: _owner, ...rest }) => rest;

  let sim = null;
  /** Signs with the platform's webhook secret, or with a seller's own when the event is for its own account. */
  const hooks = createWebhooks({
    clock: { now: () => sim.clock.now() },
    url: webhookUrl,
    sign: (raw, payload, { bad }) => ({
      'x-razorpay-signature': crypto.createHmac('sha256', `${payload?.__secret ?? webhookSecret}${bad ? '-wrong' : ''}`).update(raw).digest('hex'),
      'x-razorpay-event-id': payload?.__eventId ?? '',
    }),
  });

  sim = createSim({
    name: 'razorpay',
    errorBody: ({ kind, fault }) => ({ error: { code: fault.code ?? (kind === 'rate_limit' ? 'TOO_MANY_REQUESTS' : 'SERVER_ERROR'), description: `Simulated ${kind}.`, source: 'NA', step: 'NA', reason: 'NA', metadata: {} } }),
    reset: () => {
      clear();
      hooks.reset();
    },
    routes: (on) => {
      on('POST', '/v1/orders', (req) => {
        const owner = caller(req);
        const { amount, currency = 'INR', receipt, notes = {}, transfers: wanted } = req.body ?? {};
        if (!Number.isInteger(amount) || amount < 100) throw razorpayError(400, 'The amount must be an integer of at least 100 paise.');
        if (currency !== 'INR') throw razorpayError(400, 'Only INR is simulated.');
        if (wanted !== undefined) {
          if (owner !== 'platform') throw razorpayError(400, 'Route is not enabled for this account.');
          if (!Array.isArray(wanted) || !wanted.length) throw razorpayError(400, 'transfers must be a list.');
          let total = 0;
          for (const t of wanted) {
            const account = accounts.get(t?.account);
            if (!account) throw razorpayError(400, 'The linked account does not exist.');
            if (account.status !== 'activated') throw razorpayError(400, 'The linked account is not activated.');
            if (!Number.isInteger(t.amount) || t.amount < 100) throw razorpayError(400, 'A transfer amount must be an integer of at least 100 paise.');
            total += t.amount;
          }
          if (total > amount) throw razorpayError(400, 'The sum of transfers exceeds the order amount.');
        }
        const order = { id: nextId('order'), entity: 'order', amount, amount_paid: 0, amount_due: amount, currency, receipt, status: 'created', attempts: 0, notes, created_at: seconds(sim.clock.now()), owner, wanted: wanted ?? [] };
        orders.set(order.id, order);
        const { wanted: _wanted, ...view } = publicView(order);
        return view;
      });
      on('GET', '/v1/orders/:id', (req) => {
        const { wanted: _wanted, ...view } = publicView(owned(orders, req.params.id, caller(req)));
        return view;
      });
      on('GET', '/v1/orders/:id/payments', (req) => {
        const order = owned(orders, req.params.id, caller(req));
        const items = [...payments.values()].filter((p) => p.order_id === order.id).map(publicView);
        return { entity: 'collection', count: items.length, items };
      });
      on('GET', '/v1/payments/:id', (req) => publicView(owned(payments, req.params.id, caller(req))));
      on('POST', '/v1/payments/:id/refund', (req) => {
        const owner = caller(req);
        const payment = owned(payments, req.params.id, owner);
        const key = req.headers['x-refund-idempotency'];
        if (key && refundKeys.has(`${payment.id}:${key}`)) return publicView(refunds.get(refundKeys.get(`${payment.id}:${key}`)));
        if (payment.status !== 'captured') throw razorpayError(400, 'Only a captured payment can be refunded.');
        const amount = req.body?.amount ?? payment.amount - payment.amount_refunded;
        if (!Number.isInteger(amount) || amount < 1) throw razorpayError(400, 'The refund amount must be a positive integer.');
        if (amount > payment.amount - payment.amount_refunded) throw razorpayError(400, 'The total refund amount is greater than the refund payment amount');
        payment.amount_refunded += amount;
        payment.refund_status = payment.amount_refunded === payment.amount ? 'full' : 'partial';
        const refund = { id: nextId('rfnd'), entity: 'refund', amount, currency: payment.currency, payment_id: payment.id, status: 'processed', created_at: seconds(sim.clock.now()), owner };
        // Route: take the same amount back from the transfer, when asked to.
        const transfer = [...transfers.values()].find((t) => t.source === payment.id);
        if (transfer && req.body?.reverse_all) {
          const reverse = Math.min(amount, transfer.amount - transfer.amount_reversed);
          if (reverse > 0) {
            transfer.amount_reversed += reverse;
            refund.reversal = { id: nextId('rvrsl'), entity: 'reversal', transfer_id: transfer.id, amount: reverse };
          }
        }
        refunds.set(refund.id, refund);
        if (key) refundKeys.set(`${payment.id}:${key}`, refund.id);
        return publicView(refund);
      });
      on('GET', '/v1/payments/:id/refunds/:refundId', (req) => {
        const payment = owned(payments, req.params.id, caller(req));
        const refund = refunds.get(req.params.refundId);
        if (!refund || refund.payment_id !== payment.id) throw razorpayError(400, 'The id provided does not exist');
        return publicView(refund);
      });
      on('POST', '/v2/accounts', (req) => {
        if (caller(req) !== 'platform') throw razorpayError(400, 'Route is not enabled for this account.');
        const { email, phone, legal_business_name: name, reference_id: reference } = req.body ?? {};
        if (!email || !name) throw razorpayError(400, 'email and legal_business_name are required.');
        const existing = [...accounts.values()].find((a) => reference && a.reference_id === reference);
        if (existing) return existing;
        const account = { id: nextId('acc'), entity: 'account', type: 'route', status: 'created', email, phone: phone ?? '', legal_business_name: name, reference_id: reference ?? '', created_at: seconds(sim.clock.now()) };
        accounts.set(account.id, account);
        return account;
      });
      on('GET', '/v2/accounts/:id', (req) => {
        if (caller(req) !== 'platform') throw razorpayError(400, 'Route is not enabled for this account.');
        const account = accounts.get(req.params.id);
        if (!account) throw razorpayError(400, 'The id provided does not exist');
        return account;
      });
      on('GET', '/v1/transfers/:id', (req) => {
        if (caller(req) !== 'platform') throw razorpayError(400, 'Route is not enabled for this account.');
        const transfer = transfers.get(req.params.id);
        if (!transfer) throw razorpayError(400, 'The id provided does not exist');
        return transfer;
      });
      // ---- Subscriptions: what a business pays Bhava. Bhava's own keys only.
      const billingOnly = (req) => {
        if (caller(req) !== 'platform') throw razorpayError(400, 'Subscriptions are not enabled for this account.');
      };
      const subscriptionOf = (id) => {
        const subscription = subscriptions.get(id);
        if (!subscription) throw razorpayError(400, 'The id provided does not exist');
        return subscription;
      };
      on('POST', '/v1/customers', (req) => {
        billingOnly(req);
        const { name = '', email = '', contact = '', notes = {} } = req.body ?? {};
        const existing = [...customers.values()].find((c) => c.email === email && c.contact === contact && (email || contact));
        if (existing) return existing;
        const customer = { id: nextId('cust'), entity: 'customer', name, email, contact, notes, created_at: seconds(sim.clock.now()) };
        customers.set(customer.id, customer);
        return customer;
      });
      on('POST', '/v1/plans', (req) => {
        billingOnly(req);
        const { period, interval = 1, item, notes = {} } = req.body ?? {};
        if (!['monthly', 'yearly'].includes(period)) throw razorpayError(400, 'period is monthly or yearly.');
        if (!Number.isInteger(item?.amount) || item.amount < 100) throw razorpayError(400, 'The amount must be an integer of at least 100 paise.');
        const plan = { id: nextId('plan'), entity: 'plan', period, interval, item: { name: item.name ?? '', amount: item.amount, currency: 'INR' }, notes, created_at: seconds(sim.clock.now()) };
        plans.set(plan.id, plan);
        return plan;
      });
      on('POST', '/v1/subscriptions', (req) => {
        billingOnly(req);
        const { plan_id: planId, customer_id: customerId, total_count: totalCount = 120, quantity = 1, start_at: startAt = null, notes = {} } = req.body ?? {};
        if (!plans.has(planId)) throw razorpayError(400, 'The plan does not exist.');
        if (customerId && !customers.has(customerId)) throw razorpayError(400, 'The customer does not exist.');
        const id = nextId('sub');
        const subscription = { id, entity: 'subscription', plan_id: planId, customer_id: customerId ?? null, status: 'created', quantity, total_count: totalCount, paid_count: 0, current_start: null, current_end: null, start_at: startAt, ended_at: null, has_scheduled_changes: false, scheduled_plan_id: null, short_url: `https://rzp.io/i/${id}`, notes, created_at: seconds(sim.clock.now()) };
        subscriptions.set(id, subscription);
        return subscriptionView(subscription);
      });
      on('GET', '/v1/subscriptions/:id', (req) => {
        billingOnly(req);
        return subscriptionView(subscriptionOf(req.params.id));
      });
      on('PATCH', '/v1/subscriptions/:id', (req) => {
        billingOnly(req);
        const subscription = subscriptionOf(req.params.id);
        const { plan_id: planId, schedule_change_at: at = 'now' } = req.body ?? {};
        if (!plans.has(planId)) throw razorpayError(400, 'The plan does not exist.');
        if (['cancelled', 'completed', 'expired'].includes(subscription.status)) throw razorpayError(400, 'The subscription has ended.');
        if (at === 'cycle_end') Object.assign(subscription, { has_scheduled_changes: true, scheduled_plan_id: planId });
        else Object.assign(subscription, { plan_id: planId, has_scheduled_changes: false, scheduled_plan_id: null });
        return subscriptionView(subscription);
      });
      on('POST', '/v1/subscriptions/:id/cancel', (req) => {
        billingOnly(req);
        const subscription = subscriptionOf(req.params.id);
        if (req.body?.cancel_at_cycle_end) subscription.cancel_at_cycle_end = true;
        else Object.assign(subscription, { status: 'cancelled', ended_at: seconds(sim.clock.now()) });
        return subscriptionView(subscription);
      });
      on('POST', '/v1/subscriptions/:id/addons', (req) => {
        billingOnly(req);
        const subscription = subscriptionOf(req.params.id);
        const { item, quantity = 1, notes = {} } = req.body ?? {};
        if (!Number.isInteger(item?.amount) || item.amount < 0) throw razorpayError(400, 'The amount must be whole paise.');
        const addon = { id: nextId('ao'), entity: 'addon', subscription_id: subscription.id, item: { name: item.name ?? '', amount: item.amount, currency: 'INR' }, quantity, notes, invoice_id: null, created_at: seconds(sim.clock.now()) };
        addons.set(addon.id, addon);
        return addon;
      });
      on('GET', '/v1/addons', (req) => {
        billingOnly(req);
        const items = [...addons.values()].filter((a) => !req.query?.subscription_id || a.subscription_id === req.query.subscription_id);
        return { entity: 'collection', count: items.length, items };
      });
      on('GET', '/v1/settlements/recon/combined', (req) => {
        if (caller(req) !== 'platform') throw razorpayError(400, 'Route is not enabled for this account.');
        const account = req.headers['x-razorpay-account'];
        if (!accounts.has(account)) throw razorpayError(400, 'The linked account does not exist.');
        const year = Number(req.query?.year);
        const month = Number(req.query?.month);
        const inMonth = (at) => {
          const d = new Date(at * 1000 + 330 * 60_000);
          return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month;
        };
        const items = [];
        for (const transfer of transfers.values()) {
          if (transfer.recipient !== account) continue;
          const payment = payments.get(transfer.source);
          const settled = transfer.status === 'processed';
          if (inMonth(transfer.created_at)) items.push({ entity_id: transfer.id, type: 'transfer', amount: transfer.amount, fee: payment?.fee ?? 0, tax: payment?.tax ?? 0, payment_id: transfer.source, transfer_id: transfer.id, settled, settlement_id: settled ? `setl_${transfer.id.slice(4)}` : null, created_at: transfer.created_at });
          for (const refund of refunds.values()) {
            if (refund.reversal?.transfer_id === transfer.id && inMonth(refund.created_at)) items.push({ entity_id: refund.reversal.id, type: 'reversal', amount: refund.reversal.amount, fee: 0, tax: 0, payment_id: refund.payment_id, transfer_id: transfer.id, settled: true, settlement_id: null, created_at: refund.created_at });
          }
        }
        return { entity: 'collection', count: items.length, items };
      });
      on('POST', '/token', (req) => {
        const body = req.body ?? {};
        if (body.client_id !== partner.clientId || body.client_secret !== partner.clientSecret) throw razorpayError(401, 'The client is not recognised.');
        let accountId;
        if (body.grant_type === 'authorization_code') {
          accountId = codes.get(body.code);
          if (!accountId) throw razorpayError(400, 'The code is invalid or was already used.');
          codes.delete(body.code);
        } else if (body.grant_type === 'refresh_token') {
          accountId = [...tokens.entries()].find(([token]) => token === `refresh:${body.refresh_token}`)?.[1];
          if (!accountId) throw razorpayError(400, 'The refresh token is invalid.');
        } else throw razorpayError(400, 'Unsupported grant_type.');
        const access = `rzp_at_${crypto.randomBytes(12).toString('hex')}`;
        const refresh = `rzp_rt_${crypto.randomBytes(12).toString('hex')}`;
        tokens.set(access, accountId);
        tokens.set(`refresh:${refresh}`, accountId);
        return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 7776000, razorpay_account_id: accountId, public_token: `rzp_test_oauth_${accountId}` };
      });
    },
    controls: (on) => {
      // Registered before the shared webhook controls, so a seller's own account can have its own address and secret.
      on('POST', '/webhooks/url', ({ body }) => {
        if (body.accountId) {
          ownWebhooks.set(body.accountId, { url: body.url, secret: body.secret ?? `sim-own-webhook-${body.accountId}` });
          return { url: body.url, accountId: body.accountId, secret: ownWebhooks.get(body.accountId).secret };
        }
        hooks.setUrl(body.url);
        return { url: hooks.url };
      });
      webhookControls(on, hooks);
      on('POST', '/webhooks/send', ({ body }) => sendEvent(body.event, body.payload ?? {}, body.accountId ?? 'platform', body));
      on('POST', '/billing/webhook-url', ({ body }) => {
        billingUrl = body.url || null;
        return { url: billingUrl, secret: billingWebhookSecret };
      });
      const controlled = (id) => {
        const subscription = subscriptions.get(id);
        if (!subscription) throw new SimError(404, { error: 'No such subscription.' });
        return subscription;
      };
      const subscriptionEvent = (event, subscription, payment, options) => sendEvent(event, { subscription: { entity: subscriptionView(subscription) }, ...(payment ? { payment: { entity: payment } } : {}) }, 'billing', options);
      on('POST', '/subscriptions/authorize', async ({ body }) => {
        const subscription = controlled(body.id);
        if (subscription.status === 'created') subscription.status = 'authenticated';
        return { subscription: subscriptionView(subscription), webhook: await subscriptionEvent('subscription.authenticated', subscription, null, body) };
      });
      on('POST', '/subscriptions/charge', async ({ body }) => {
        const subscription = controlled(body.id);
        if (['cancelled', 'completed', 'expired'].includes(subscription.status)) throw new SimError(409, { error: 'That subscription has ended.' });
        const outcome = body.outcome ?? 'charged';
        if (!['charged', 'failed', 'halted'].includes(outcome)) throw new SimError(400, { error: 'outcome is charged, failed or halted.' });
        const now = seconds(sim.clock.now());
        if (outcome === 'halted') {
          subscription.status = 'halted';
          return { subscription: subscriptionView(subscription), webhooks: [await subscriptionEvent('subscription.halted', subscription, null, body)] };
        }
        if (outcome === 'charged' && subscription.has_scheduled_changes) Object.assign(subscription, { plan_id: subscription.scheduled_plan_id, has_scheduled_changes: false, scheduled_plan_id: null });
        const plan = plans.get(subscription.plan_id);
        const waiting = [...addons.values()].filter((a) => a.subscription_id === subscription.id && !a.invoice_id);
        const amount = plan.item.amount * subscription.quantity + waiting.reduce((sum, a) => sum + a.item.amount * a.quantity, 0);
        const invoiceId = nextId('inv');
        const payment = {
          id: nextId('pay'), entity: 'payment', amount, currency: 'INR', status: outcome === 'charged' ? 'captured' : 'failed', order_id: null, invoice_id: invoiceId, method: body.method ?? 'card',
          captured: outcome === 'charged', error_code: outcome === 'failed' ? 'BAD_REQUEST_ERROR' : null, error_description: outcome === 'failed' ? 'Payment failed' : null, created_at: now,
        };
        payments.set(payment.id, { ...payment, amount_refunded: 0, refund_status: null, fee: 0, tax: 0, owner: 'platform' });
        if (outcome === 'failed') {
          subscription.status = 'pending';
          return { subscription: subscriptionView(subscription), payment, webhooks: [await subscriptionEvent('subscription.pending', subscription, payment, body)] };
        }
        for (const addon of waiting) addon.invoice_id = invoiceId;
        const end = new Date(now * 1000);
        if (plan.period === 'yearly') end.setUTCFullYear(end.getUTCFullYear() + plan.interval);
        else end.setUTCMonth(end.getUTCMonth() + plan.interval);
        Object.assign(subscription, { status: 'active', paid_count: subscription.paid_count + 1, current_start: now, current_end: seconds(+end) });
        const webhooks = [];
        if (subscription.paid_count === 1) webhooks.push(await subscriptionEvent('subscription.activated', subscription, null, body));
        webhooks.push(await subscriptionEvent('subscription.charged', subscription, payment, body));
        if (subscription.cancel_at_cycle_end) Object.assign(subscription, { status: 'cancelled', ended_at: subscription.current_end });
        return { subscription: subscriptionView(subscription), payment, addons: waiting, webhooks };
      });
      on('POST', '/subscriptions/cancel', async ({ body }) => {
        const subscription = controlled(body.id);
        Object.assign(subscription, { status: 'cancelled', ended_at: seconds(sim.clock.now()) });
        return { subscription: subscriptionView(subscription), webhook: await subscriptionEvent('subscription.cancelled', subscription, null, body) };
      });
      on('POST', '/pay', async ({ body }) => {
        const order = orders.get(body.orderId);
        if (!order) throw new SimError(404, { error: 'No such order.' });
        if (order.status === 'paid') throw new SimError(409, { error: 'That order is already paid.' });
        const outcome = body.outcome ?? 'captured';
        if (!['captured', 'failed', 'authorized'].includes(outcome)) throw new SimError(400, { error: 'outcome is captured, failed or authorized.' });
        const amount = Number.isInteger(body.amount) ? body.amount : order.amount;
        const fee = Math.round((amount * FEE_BP) / 10000);
        const tax = Math.round((fee * FEE_TAX_BP) / 10000);
        const payment = {
          id: nextId('pay'), entity: 'payment', amount, currency: order.currency, status: outcome, order_id: order.id, method: body.method ?? 'upi', amount_refunded: 0, refund_status: null,
          captured: outcome === 'captured', fee: outcome === 'captured' ? fee + tax : 0, tax: outcome === 'captured' ? tax : 0,
          error_code: outcome === 'failed' ? 'BAD_REQUEST_ERROR' : null, error_description: outcome === 'failed' ? 'Payment failed' : null, created_at: seconds(sim.clock.now()), owner: order.owner,
        };
        payments.set(payment.id, payment);
        order.attempts += 1;
        if (outcome === 'captured') settle(order, payment);
        const secret = order.owner === 'platform' ? keySecret : `sim-own-key-secret-${order.owner}`;
        const signature = crypto.createHmac('sha256', secret).update(`${order.id}|${payment.id}`).digest('hex');
        const wantsWebhook = body.webhook ?? Boolean(order.owner === 'platform' ? hooks.url : ownWebhooks.get(order.owner));
        const webhooks = wantsWebhook ? await paymentEvents(order, payment, body) : [];
        return { payment: publicView(payment), signature, webhooks };
      });
      on('POST', '/capture', async ({ body }) => {
        const payment = payments.get(body.paymentId);
        if (!payment) throw new SimError(404, { error: 'No such payment.' });
        if (payment.status !== 'authorized') throw new SimError(409, { error: 'Only an authorized payment can be captured.' });
        const order = orders.get(payment.order_id);
        Object.assign(payment, { status: 'captured', captured: true });
        settle(order, payment);
        return { payment: publicView(payment), webhooks: await paymentEvents(order, payment, body) };
      });
      on('POST', '/accounts/kyc', async ({ body }) => {
        const account = accounts.get(body.id);
        if (!account) throw new SimError(404, { error: 'No such linked account.' });
        if (!['created', 'under_review', 'needs_clarification', 'activated', 'rejected', 'suspended'].includes(body.status)) throw new SimError(400, { error: 'Unknown account status.' });
        account.status = body.status;
        const webhook = await sendEvent(`account.${body.status}`, { account: { entity: account } }, 'platform', body);
        return { account, webhook };
      });
      on('POST', '/transfers/settle', ({ body }) => moveTransfer(body, 'processed', 'transfer.processed'));
      on('POST', '/transfers/fail', ({ body }) => moveTransfer(body, 'failed', 'transfer.failed'));
      on('POST', '/oauth/code', ({ body }) => {
        const accountId = body.accountId ?? nextId('acc');
        const code = `code_${crypto.randomBytes(8).toString('hex')}`;
        codes.set(code, accountId);
        return { code, accountId, keySecret: `sim-own-key-secret-${accountId}` };
      });
      on('GET', '/state', () => ({ subscriptions: [...subscriptions.values()].map(subscriptionView), addons: [...addons.values()], plans: [...plans.values()], customers: [...customers.values()], orders: [...orders.values()].map(publicView), payments: [...payments.values()].map(publicView), refunds: [...refunds.values()].map(publicView), transfers: [...transfers.values()], accounts: [...accounts.values()] }));
    },
  });

  const subscriptionView = ({ scheduled_plan_id: _scheduled, cancel_at_cycle_end: _atEnd, ...rest }) => rest;

  function settle(order, payment) {
    Object.assign(order, { status: 'paid', amount_paid: payment.amount, amount_due: Math.max(0, order.amount - payment.amount) });
    for (const wanted of order.wanted) {
      const transfer = { id: nextId('trf'), entity: 'transfer', source: payment.id, recipient: wanted.account, amount: wanted.amount, amount_reversed: 0, currency: 'INR', status: 'created', created_at: seconds(sim.clock.now()) };
      transfers.set(transfer.id, transfer);
    }
  }

  /** One event, in Razorpay's envelope. The bytes are made without the helper fields, and signed exactly as sent. */
  async function sendEvent(event, payload, owner = 'platform', { duplicates, hold, signature, eventId } = {}) {
    // 'billing' is Bhava's own account too, at its own address with its own secret.
    const own = owner === 'platform' ? null : owner === 'billing' ? (billingUrl ? { url: billingUrl, secret: billingWebhookSecret } : null) : ownWebhooks.get(owner);
    if (owner !== 'platform' && !own) return { delivered: false, reason: 'no_webhook_url' };
    const id = eventId ?? nextId('evt');
    const envelope = { entity: 'event', account_id: owner === 'platform' || owner === 'billing' ? 'acc_platform' : owner, event, contains: Object.keys(payload), payload, created_at: seconds(sim.clock.now()) };
    const raw = JSON.stringify(envelope);
    const marked = { ...envelope };
    Object.defineProperties(marked, { __secret: { value: own?.secret ?? webhookSecret, enumerable: false }, __eventId: { value: id, enumerable: false } });
    const sent = await hooks.send(marked, { raw, duplicates, hold, signature, url: own ? own.url : hooks.url });
    return { ...sent, eventId: id, event };
  }

  async function paymentEvents(order, payment, options) {
    const entity = { payment: { entity: publicView(payment) } };
    const out = [];
    if (payment.status === 'captured') {
      out.push(await sendEvent('payment.captured', entity, order.owner, options));
      const { wanted: _wanted, ...orderView } = publicView(order);
      out.push(await sendEvent('order.paid', { ...entity, order: { entity: orderView } }, order.owner, options));
    } else if (payment.status === 'failed') out.push(await sendEvent('payment.failed', entity, order.owner, options));
    else out.push(await sendEvent('payment.authorized', entity, order.owner, options));
    return out;
  }

  async function moveTransfer(body, status, event) {
    const transfer = transfers.get(body.id);
    if (!transfer) throw new SimError(404, { error: 'No such transfer.' });
    transfer.status = status;
    return { transfer, webhook: await sendEvent(event, { transfer: { entity: transfer } }, 'platform', body) };
  }

  return Object.assign(sim, { webhooks: hooks, keyId, keySecret, webhookSecret, billingWebhookSecret, partner });
}

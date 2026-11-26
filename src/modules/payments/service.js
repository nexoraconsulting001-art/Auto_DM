import { ProviderError } from '../../adapters/http.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { changeOrder, changeRow, holdOrder } from '../orders/state.js';
import { createRefunds } from '../refunds/service.js';
import { createReconcile } from './reconcile.js';
import { createSettings } from './settings.js';
import { createStatement } from './statement.js';
import { PaymentError, isGatewayId, lockOrder, methodOf, paiseOf, raiseAlert, rupees, writeGap, writeLine } from './util.js';
import { createWebhooks } from './webhooks.js';

/**
 * Payments (PRD 9.6, 9.7), built once per process and set as ctx.payments by the module's setup. Other tracks call:
 *
 *   ctx.payments.settings.checkout({ orderPaise, pincode, phone })   ways to pay with reasons, the COD fee and the advance
 *       split (checkout's quote, S-21, S-22)
 *   ctx.payments.start(orderId, { baseUrl })                         after the order commits: the gateway order for a prepaid
 *       or part-advance order -> { paymentId, done, gateway } where gateway is PlacedOrder.gateway. Calling it again answers
 *       with the same gateway order, so a retry reuses it (9.7).
 *   ctx.payments.recordCodCollected(orderId, { actor })              cash was collected at the door (also on order.delivered)
 *   ctx.refunds                                                      refunds (src/modules/refunds)
 *
 * An order is marked paid in one place, applyGatewayPayment, and only from what the gateway itself said to this server: a
 * webhook whose signature passed, or a payment fetched with the account's own credentials. Nothing the browser sends is
 * believed beyond naming which payment to go and fetch. The amount and currency must be the payment row's, which was made
 * from the order's own total; anything else holds the order for a person (9.7). No card number, expiry, name, VPA, email or
 * phone is read, stored or logged: the gateway's answer is cut down to ids, amounts and statuses before anything else sees it.
 */
const ACTIVE = ['created', 'authorized', 'failed'];
const TRANSFER_RANK = Object.freeze({ none: 0, created: 1, processed: 2, settled: 3 });
const TRANSFER_EVENT = Object.freeze({ 'transfer.processed': 'processed', 'transfer.settled': 'settled', 'transfer.failed': 'failed', 'transfer.reversed': 'reversed' });

/** A gateway payment as this module reads one, from the adapter or a webhook: ids, amounts and statuses only. */
export function toGatewayPayment(p) {
  if (!p || !isGatewayId(p.id)) return null;
  return {
    id: p.id,
    orderId: isGatewayId(p.orderId) ? p.orderId : null,
    status: String(p.status ?? ''),
    amountPaise: paiseOf(p.amountPaise),
    currency: typeof p.currency === 'string' ? p.currency : 'INR',
    method: methodOf(p.method),
    feePaise: paiseOf(p.feePaise) ?? 0,
    taxPaise: paiseOf(p.taxPaise) ?? 0,
    errorCode: typeof p.errorCode === 'string' ? p.errorCode.replace(/[^A-Za-z0-9_]/g, '').slice(0, 80) : '',
  };
}

export function createPayments(ctx) {
  const { db, repos, config, providers } = ctx;
  const secrets = ctx.platform?.secrets;
  const metrics = ctx.platform?.metrics;
  const settings = createSettings({ db, repos, config, providers, secrets });
  const statement = createStatement({ db });
  const kick = () => ctx.orderEvents?.kick?.();

  async function sumCaptured(t, orderId) {
    const [{ paid }] = await t.query(`SELECT COALESCE(sum(amount_paise), 0) AS paid FROM payments WHERE tenant_id = $1 AND order_id = $2 AND status = 'captured' AND purpose <> 'duplicate'`, [tenantId(), orderId]);
    return Number(paid);
  }

  /** The statement's lines for a captured payment (9.6): the sale, and the gateway's fee and the GST on it, each at cost. */
  async function writeCaptureLines(t, payment) {
    // A shopper's second payment for the same part of an order is not a sale: it is given back, never paid out (atk-money-2).
    if (payment.purpose === 'duplicate') return;
    const ref = `payment:${payment.id}`;
    const at = payment.captured_at ?? null;
    const status = payment.needs_review ? 'review' : 'ok';
    await writeLine(t, { orderId: payment.order_id, kind: 'sale', amountPaise: Number(payment.amount_paise), ref, at, status });
    if (Number(payment.fee_paise) > 0) await writeLine(t, { orderId: payment.order_id, kind: 'gateway_fee', amountPaise: -Number(payment.fee_paise), ref, at, status });
    if (Number(payment.fee_tax_paise) > 0) await writeLine(t, { orderId: payment.order_id, kind: 'gateway_fee_tax', amountPaise: -Number(payment.fee_tax_paise), ref, at, status });
  }

  /** The seller's name, logo and colour for the gateway's checkout (S-71). Never the platform's. */
  async function display(baseUrl) {
    const [shop, kit] = await Promise.all([repos.settings.getAll(), repos.brandKit.get()]);
    const logo = kit?.logoUrl || '';
    const image = /^https:\/\//i.test(logo) ? logo : logo.startsWith('/') && /^https?:\/\//.test(baseUrl) ? `${baseUrl}${logo}` : '';
    return { name: String(shop.store_name ?? '').slice(0, 100), image, color: /^#[0-9a-f]{6}$/i.test(kit?.colors?.primary ?? '') ? kit.colors.primary : '' };
  }

  /** Both statuses of an order, for answers. */
  async function orderNow(orderId) {
    const [row] = await db.query('SELECT payment_status, fulfilment_status, hold_reason FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
    return row;
  }

  /**
   * One gateway order per payment row, however many starts arrive at once (S-15). Starts in this process for the same row
   * share one call; starts in other processes wait on the row's lock and then read the stored id, so the gateway is asked
   * exactly once. The lock is held across the gateway call (bounded by the provider timeout) by at most one start per row
   * per process, so a burst of taps holds one connection, not one per tap. A managed order names the linked account in its
   * notes. -> the payment row with its gateway_order_id
   */
  const gatewayStarts = new Map();
  function gatewayOrderFor(row, order, creds, mode) {
    const key = `${tenantId()}:${row.id}`;
    const running = gatewayStarts.get(key);
    if (running) return running;
    const call = db.tx(async (t) => {
      const [locked] = await t.query('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), row.id]);
      if (!locked) throw new PaymentError('not_found', 'We couldn’t find that order.');
      if (locked.gateway_order_id) return locked;
      const amount = Number(locked.amount_paise);
      const created = await creds.adapter.createOrder(creds.account, { amountPaise: amount, receipt: order.order_number, notes: mode === 'managed' ? { account: creds.accountRef } : {} });
      if (!isGatewayId(created?.id) || created.amountPaise !== amount) throw new ProviderError({ provider: 'razorpay', kind: 'malformed', delivery: 'unknown' });
      const [stored] = await t.query('UPDATE payments SET gateway_order_id = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId(), row.id, created.id]);
      return stored;
    }).finally(() => gatewayStarts.delete(key));
    gatewayStarts.set(key, call);
    return call;
  }

  /**
   * The gateway order for an order that is to be paid online, made with the exact amount in paise and the order number as
   * its receipt. One payment row per gateway order; a failed attempt and its retry share both (9.7).
   */
  async function start(orderId, { baseUrl = '', actor = 'system' } = {}) {
    const [seen] = await db.query('SELECT id, gateway_mode FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(orderId) || 0]);
    if (!seen) throw new PaymentError('not_found', 'We couldn’t find that order.');
    const mode = seen.gateway_mode ?? (await settings.effectiveMode());
    if (!seen.gateway_mode && !((await repos.entitlements.can('store.payments')) && (await settings.ready(mode)))) {
      throw new PaymentError('conflict', 'Online payment isn’t available at this store right now.', 'online_unavailable');
    }
    const creds = await settings.credentials(mode);

    const prepared = await db.tx(async (t) => {
      const order = await lockOrder(t, orderId);
      if (!order) throw new PaymentError('not_found', 'We couldn’t find that order.');
      if (order.flow !== 'checkout' || !['prepaid', 'part_advance'].includes(order.payment_mode)) throw new PaymentError('conflict', 'This order isn’t paid online.', 'not_payable');
      if (order.payment_status !== 'unpaid') return { order, done: true };
      if (order.fulfilment_status !== 'pending') throw new PaymentError('conflict', 'This order can no longer be paid for. Please place it again.', 'not_payable');
      if (order.hold_reason === 'payment_mismatch') throw new PaymentError('conflict', 'A payment for this order is being checked. Please wait for the store to contact you.', 'in_review');
      if (order.gateway_mode && order.gateway_mode !== mode) throw new PaymentError('conflict', 'Please try again.', 'retry');
      const purpose = order.payment_mode === 'part_advance' ? 'advance' : 'full';
      const amount = Number(purpose === 'advance' ? order.advance_paise : order.total_paise);
      if (!Number.isSafeInteger(amount) || amount < 100) throw new PaymentError('conflict', 'There is nothing to pay online for this order.', 'not_payable');
      // The account is fixed with the order: a later switch of mode changes new orders only (S-72).
      if (!order.gateway_mode) await changeOrder(t, order.id, { set: { gateway_mode: mode }, actor });
      const [existing] = await t.query(
        `SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 AND provider = 'razorpay' AND purpose = $3 AND mode = $4 AND amount_paise = $5 AND status = ANY($6::text[])
         ORDER BY id DESC LIMIT 1`,
        [tenantId(), order.id, purpose, mode, amount, ACTIVE],
      );
      if (existing) return { order, row: existing };
      const [row] = await t.query(
        `INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, account_ref, amount_paise) VALUES ($1, $2, $3, 'razorpay', $4, $5, $6) RETURNING *`,
        [tenantId(), order.id, purpose, mode, String(creds.accountRef ?? '').slice(0, 60), amount],
      );
      return { order, row };
    });
    if (prepared.done) return { paymentId: null, done: true, gateway: null };

    let { row } = prepared;
    if (!row.gateway_order_id) row = await gatewayOrderFor(row, prepared.order, creds, mode);
    const options = creds.adapter.checkoutOptions(creds.account, { gatewayOrderId: row.gateway_order_id, amountPaise: Number(row.amount_paise), display: await display(baseUrl) });
    return {
      paymentId: Number(row.id),
      done: false,
      gateway: { provider: 'razorpay', keyId: options.key ?? '', gatewayOrderId: row.gateway_order_id, amountPaise: Number(row.amount_paise), display: { name: options.name, image: options.image, color: options.theme.color } },
    };
  }

  /**
   * Money taken twice for one part of an order (atk-money-2). The extra capture is its own payment row, purpose 'duplicate':
   * captured and held for review, but never counted in what the order was paid, never a sale line and never sent to the
   * seller, so the order's refund gives exactly it back by its own gateway payment id and the sale, its Route transfer and its
   * GST invoice stay as they are. `gp` is the extra capture; `row` is the payment row it came in on: the sale's own row (a
   * second payment on the sale's gateway order) or another attempt's row (then that row becomes the duplicate). The owner and
   * ops are told once per duplicate, and its gap names the gateway payment. A capture that can't be kept as a row (not INR,
   * no amount) is still a gap and an alert, for a person. -> the duplicate's row, or null
   */
  async function recordDuplicate(t, order, row, gp, salePaymentId) {
    const amount = paiseOf(gp.amountPaise);
    const keepable = Boolean(amount && amount > 0 && gp.currency === 'INR');
    const tax = Math.min(gp.taxPaise, gp.feePaise);
    const fields = { gateway_payment_id: gp.id, method: gp.method, fee_paise: gp.feePaise - tax, fee_tax_paise: tax, needs_review: true, error_code: 'duplicate_capture', transfer_paise: 0 };
    let dup = null;
    if (keepable && Number(row.id) !== Number(salePaymentId)) {
      // Another attempt's own row, captured after the sale's: it is the duplicate, for what the gateway took on it.
      const moved = await changeRow(t, 'payments', row.id, 'captured', { ifAllowed: true, set: { ...fields, purpose: 'duplicate', amount_paise: amount, captured_at: new Date() } });
      dup = moved.changed ? moved.row : null;
    } else if (keepable) {
      [dup] = await t.query(
        `INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, account_ref, gateway_order_id, gateway_payment_id, amount_paise, status, method, fee_paise, fee_tax_paise, needs_review, error_code, captured_at)
         VALUES ($1, $2, 'duplicate', $3, $4, $5, $6, $7, $8, 'captured', $9, $10, $11, true, 'duplicate_capture', now()) ON CONFLICT DO NOTHING RETURNING *`,
        [tenantId(), order.id, row.provider, row.mode, row.account_ref, row.gateway_order_id, gp.id, amount, fields.method, fields.fee_paise, fields.fee_tax_paise],
      );
      // The same extra capture told again: already kept.
      if (!dup) [dup] = await t.query(`SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 AND purpose = 'duplicate' AND gateway_payment_id = $3`, [tenantId(), order.id, gp.id]);
    }
    const key = dup ? dup.id : `gw-${gp.id}`;
    const message = dup
      ? `Order ${order.order_number} was paid twice at the gateway: ${rupees(dup.amount_paise)} too much. Refund it from the order: the extra payment is given back first, and the sale stays as it is.`
      : `Order ${order.order_number} was paid twice at the gateway, in a way that can't be refunded from the order. We are checking it.`;
    for (const audience of dup ? ['owner', 'ops'] : ['ops']) await raiseAlert(t, { kind: 'payment.duplicate_capture', severity: 'critical', message, target: `order:${order.id}`, dedupeKey: `payment-dup:${key}`, audience });
    await writeGap(t, { kind: 'amount_mismatch', ref: `payment:${key}`, details: { reason: 'duplicate_capture', gatewayPaymentId: gp.id, salePaymentId: Number(salePaymentId), amountPaise: amount ?? 0, currencyOk: gp.currency === 'INR' } });
    log.warn('payments.duplicate_capture', { orderId: order.id, paymentId: dup ? Number(dup.id) : null });
    return dup;
  }

  /**
   * Applies what the gateway says about one payment to its row and its order, in one transaction. `gp` is a gateway payment
   * (toGatewayPayment). `actor` is where it came from: 'webhook:razorpay', 'job:payment-check', 'gateway:razorpay'. Safe to
   * call any number of times, in any order: a repeat changes nothing, and a late "failed" never undoes "captured" (S-23, S-24).
   * -> { outcome: 'processed' | 'stale' | 'amount_mismatch' | 'duplicate_capture' | 'unknown_order' | 'not_handled', order? }
   */
  async function applyGatewayPayment({ paymentId, gp: given, actor }) {
    const gp = toGatewayPayment(given);
    const result = await db.tx(async (t) => {
      const [found] = await t.query('SELECT order_id FROM payments WHERE tenant_id = $1 AND id = $2', [tenantId(), paymentId]);
      if (!found || !gp) return { outcome: 'unknown_order' };
      const order = await lockOrder(t, found.order_id);
      const [row] = await t.query('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), paymentId]);
      if (!row.gateway_order_id || gp.orderId !== row.gateway_order_id) return { outcome: 'unknown_order' };

      if (gp.status === 'authorized') {
        if (row.status === 'authorized' && row.gateway_payment_id && row.gateway_payment_id !== gp.id) return { outcome: 'stale' };
        const moved = await changeRow(t, 'payments', row.id, 'authorized', { ifAllowed: true, set: row.status === 'captured' ? {} : { gateway_payment_id: gp.id, method: gp.method } });
        return { outcome: moved.changed ? 'processed' : 'stale' };
      }
      if (gp.status === 'failed') {
        // Captured stays captured, and one attempt failing says nothing about another still in progress.
        if (row.status === 'captured' || (row.status === 'authorized' && row.gateway_payment_id && row.gateway_payment_id !== gp.id)) return { outcome: 'stale' };
        const moved = await changeRow(t, 'payments', row.id, 'failed', { ifAllowed: true, set: { gateway_payment_id: gp.id, method: gp.method, error_code: gp.errorCode || 'payment_failed' } });
        return { outcome: moved.changed ? 'processed' : 'stale' };
      }
      if (gp.status !== 'captured') return { outcome: 'not_handled' };

      if (row.status === 'captured') {
        if (row.purpose !== 'duplicate' && row.gateway_payment_id && row.gateway_payment_id !== gp.id) {
          await recordDuplicate(t, order, row, gp, row.id);
          return { outcome: 'duplicate_capture' };
        }
        return { outcome: 'stale' };
      }

      // Another attempt for the same part of this order was captured already: the shopper paid twice, and this is the extra.
      const [twin] = await t.query(
        `SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 AND purpose = $3 AND status = 'captured' AND id <> $4 ORDER BY id LIMIT 1`,
        [tenantId(), order.id, row.purpose, row.id],
      );
      if (twin) {
        await recordDuplicate(t, order, row, gp, twin.id);
        return { outcome: 'duplicate_capture' };
      }

      if (gp.amountPaise !== Number(row.amount_paise) || gp.currency !== row.currency) {
        // What was captured is not what the order asks for (9.7): the order is held and stays unpaid, for a person.
        if (!row.needs_review) await changeRow(t, 'payments', row.id, row.status, { set: { needs_review: true, error_code: 'amount_mismatch', gateway_payment_id: gp.id } });
        await holdOrder(t, order.id, 'payment_mismatch', { actor, reason: 'captured amount or currency differs from the order' });
        const message = `A payment for order ${order.order_number} doesn’t match the order: ${rupees(row.amount_paise)} was due. The order is on hold until someone checks it.`;
        for (const audience of ['owner', 'ops']) await raiseAlert(t, { kind: 'payment.mismatch', severity: 'critical', message, target: `order:${order.id}`, dedupeKey: `payment-mismatch:${row.id}`, audience });
        await writeGap(t, { kind: 'amount_mismatch', ref: `payment:${row.id}`, details: { expectedPaise: Number(row.amount_paise), gotPaise: gp.amountPaise ?? 0, currencyOk: gp.currency === row.currency } });
        log.warn('payments.amount_mismatch', { orderId: order.id, paymentId: Number(row.id) });
        return { outcome: 'amount_mismatch' };
      }

      const tax = Math.min(gp.taxPaise, gp.feePaise);
      const set = { gateway_payment_id: gp.id, method: gp.method, fee_paise: gp.feePaise - tax, fee_tax_paise: tax, captured_at: new Date(), error_code: '' };
      // Managed: the seller's transfer is the sale less the gateway's fee and its GST (S-70, F-113). It is made right after
      // this commits (sendTransfer), and the payments check sends it again if that answer is lost.
      if (row.mode === 'managed') set.transfer_paise = Math.max(0, Number(row.amount_paise) - gp.feePaise);
      const moved = await changeRow(t, 'payments', row.id, 'captured', { ifAllowed: true, set });
      if (!moved.changed) return { outcome: 'stale' };
      await writeCaptureLines(t, moved.row);

      const paid = await sumCaptured(t, order.id);
      const target = row.purpose === 'advance' ? 'advance_paid' : 'paid';
      // Money after the hold ran out (S-41) moves the money only. Whether the order comes back is the stock's call: the
      // order.paid listener (inventory/stock.js) brings it back when every line is still on hand, and otherwise keeps it
      // cancelled as "Paid, out of stock" for the owner to reinstate once stock arrives (orders.reinstate) or to refund.
      const lateAfterHold = order.fulfilment_status === 'cancelled' && order.cancel_reason === 'hold_expired';
      const changed = await changeOrder(t, order.id, { payment: target, ...(lateAfterHold ? {} : { fulfilment: 'new' }), actor, reason: 'payment captured', set: { paid_paise: paid }, ifAllowed: true });
      if (changed.order.fulfilment_status === 'cancelled' && !lateAfterHold) {
        // The money arrived for an order that was cancelled and cannot come back: the owner has it to give back.
        await holdOrder(t, order.id, 'review', { actor, reason: 'paid after the order was cancelled' });
        await raiseAlert(t, { kind: 'payment.after_cancel', severity: 'critical', message: `Order ${order.order_number} was paid after it was cancelled. Refund ${rupees(row.amount_paise)} to the shopper.`, target: `order:${order.id}`, dedupeKey: `payment-late:${row.id}` });
      }
      return { outcome: 'processed', order: changed.order, transferFor: row.mode === 'managed' ? Number(row.id) : null };
    });
    const { transferFor, ...answer } = result;
    if (transferFor) await sendTransfer(transferFor).catch((err) => log.warn('payments.transfer_unsent', { paymentId: transferFor, kind: err?.kind ?? err?.code ?? 'error' }));
    if (answer.outcome === 'processed' || answer.outcome === 'amount_mismatch' || answer.outcome === 'duplicate_capture') kick();
    return answer;
  }

  /**
   * Managed: the Route transfer of one captured payment to the seller's linked account, for transfer_paise (the sale less
   * the gateway fee). Outside any transaction. The adapter answers a transfer already made from this payment instead of a
   * second one, so calling this again after a lost answer never pays the seller twice. A payment held for review, or a
   * second capture of the same part of an order (purpose duplicate), is left for a person. -> the payment row
   */
  async function sendTransfer(paymentId) {
    const [row] = await db.query(`SELECT * FROM payments WHERE tenant_id = $1 AND id = $2 AND mode = 'managed' AND status = 'captured'`, [tenantId(), paymentId]);
    if (!row || row.transfer_id || row.needs_review || !row.gateway_payment_id || row.purpose === 'duplicate') return row ?? null;
    const net = Number(row.transfer_paise);
    if (net < 100) return row; // Route moves at least a rupee
    let made;
    try {
      const creds = await settings.credentials('managed', { accountRef: row.account_ref });
      made = await creds.adapter.transferPayment(creds.account, row.gateway_payment_id, { amountPaise: net, notes: { payment: String(row.id) } });
    } catch (err) {
      if (!(err instanceof ProviderError) && !(err instanceof PaymentError)) throw err;
      log.warn('payments.transfer_unsent', { paymentId: Number(row.id), kind: err.kind ?? err.code });
      return row;
    }
    if (!made || !isGatewayId(made.id)) return row;
    await db.tx(async (t) => {
      await lockOrder(t, row.order_id);
      const [now] = await t.query('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), row.id]);
      if (now.transfer_id) return;
      const sent = Math.min(Number(now.amount_paise), paiseOf(made.amountPaise) ?? net);
      if (sent !== net) await writeGap(t, { kind: 'amount_mismatch', ref: `payment:${now.id}`, details: { reason: 'transfer_amount', expectedPaise: net, gotPaise: sent } });
      await changeRow(t, 'payments', now.id, now.status, { set: { transfer_id: made.id, transfer_paise: Math.max(sent, Number(now.reversed_paise)), transfer_status: now.transfer_status === 'none' ? 'created' : now.transfer_status } });
    });
    await takeShipping(row.order_id);
    return (await db.query('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2', [tenantId(), row.id]))[0];
  }

  /**
   * Courier charges on Bhava's account that are taken from the payout (shipping_settings.charge_billing 'payout', 9.10):
   * each is taken back from the order's Route transfer once, as a transfer reversal, and shown as a transfer_reversal line
   * with the shipment's ref. The line is written first, so a charge is never taken twice; a gateway that definitely refused
   * gives it back, and an answer that was lost is left for ops. An order whose transfer is still to be made is taken when it
   * is (sendTransfer); one with no managed online payment, or not enough left on it, is a gap for ops. -> what was taken
   */
  async function takeShipping(orderId) {
    const [cfg] = await db.query('SELECT charge_billing FROM shipping_settings WHERE tenant_id = $1', [tenantId()]);
    if (cfg?.charge_billing === 'monthly') return [];
    const due = await db.query(
      `SELECT l.ref, -l.amount_paise - COALESCE(c.amount_paise, 0) AS paise FROM settlement_lines l
       LEFT JOIN settlement_lines c ON c.tenant_id = l.tenant_id AND c.kind = 'adjustment' AND c.ref = l.ref || ':cancelled'
       WHERE l.tenant_id = $1 AND l.order_id = $2 AND l.kind = 'shipping_charge'
         AND NOT EXISTS (SELECT 1 FROM settlement_lines r WHERE r.tenant_id = l.tenant_id AND r.kind = 'transfer_reversal' AND r.ref = l.ref)
       ORDER BY l.id`,
      [tenantId(), orderId],
    );
    const taken = [];
    for (const { ref, paise } of due) {
      const amount = Number(paise);
      if (!(amount > 0)) continue;
      const claim = await db.tx(async (t) => {
        await lockOrder(t, orderId);
        const online = await t.query(`SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 AND mode = 'managed' AND status = 'captured' ORDER BY id DESC FOR UPDATE`, [tenantId(), orderId]);
        if (!online.length) return null;
        if (online.some((p) => !p.transfer_id && !p.needs_review)) return null; // taken once the transfer is made
        const p = online.find((x) => x.transfer_id && Number(x.transfer_paise) - Number(x.reversed_paise) >= amount);
        if (!p) {
          await writeGap(t, { kind: 'settlement_missing', ref, details: { reason: 'shipping_uncollected', amountPaise: amount } });
          return null;
        }
        const [line] = await t.query(
          `INSERT INTO settlement_lines (tenant_id, order_id, kind, amount_paise, ref) VALUES ($1, $2, 'transfer_reversal', $3, $4) ON CONFLICT (tenant_id, kind, ref) DO NOTHING RETURNING id`,
          [tenantId(), orderId, -amount, ref],
        );
        if (!line) return null;
        const reversed = Number(p.reversed_paise) + amount;
        await changeRow(t, 'payments', p.id, p.status, { set: { reversed_paise: reversed, ...(reversed >= Number(p.transfer_paise) ? { transfer_status: 'reversed' } : {}) } });
        return { payment: p, lineId: line.id };
      });
      if (!claim) continue;
      try {
        const creds = await settings.credentials('managed', { accountRef: claim.payment.account_ref });
        await creds.adapter.reverseTransfer(creds.account, claim.payment.transfer_id, { amountPaise: amount, notes: { charge: ref } });
        taken.push({ ref, amountPaise: amount });
      } catch (err) {
        if (!(err instanceof ProviderError) && !(err instanceof PaymentError)) throw err;
        if (err instanceof PaymentError || err.delivery === 'none') {
          // Definitely not taken: undone, and tried again with the next check.
          await db.tx(async (t) => {
            await lockOrder(t, orderId);
            const [p] = await t.query('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), claim.payment.id]);
            await t.query('DELETE FROM settlement_lines WHERE tenant_id = $1 AND id = $2', [tenantId(), claim.lineId]);
            await changeRow(t, 'payments', p.id, p.status, { set: { reversed_paise: Math.max(0, Number(p.reversed_paise) - amount), transfer_status: p.transfer_status === 'reversed' ? 'created' : p.transfer_status } });
          });
        } else {
          await writeGap(db, { kind: 'settlement_missing', ref, details: { reason: 'shipping_reversal_unanswered', amountPaise: amount } });
        }
        log.warn('payments.shipping_not_taken', { orderId: Number(orderId), kind: err.kind ?? err.code });
      }
    }
    return taken;
  }

  /**
   * Managed mode: what Route says about the transfer of a captured payment to the seller's linked account (9.7). Never moves
   * backwards. A failed transfer, or one reversed by more than this business's own refunds explain, holds the payment's
   * statement lines for review and tells ops and the owner.
   */
  async function applyTransfer({ paymentId, transfer, type }) {
    const result = await db.tx(async (t) => {
      const [found] = await t.query('SELECT order_id FROM payments WHERE tenant_id = $1 AND id = $2', [tenantId(), paymentId]);
      if (!found) return { outcome: 'unknown_order' };
      const order = await lockOrder(t, found.order_id);
      const [row] = await t.query('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), paymentId]);
      if (row.mode !== 'managed' || row.status !== 'captured') return { outcome: 'not_handled' };
      const to = TRANSFER_EVENT[type] ?? null;
      if (!to) return { outcome: 'not_handled' };
      const from = row.transfer_status;
      // Route's amount_reversed is the transfer's running total: a later reversed event with a larger total is news (money-7).
      const grew = to === 'reversed' && (paiseOf(transfer?.amountReversedPaise) ?? 0) > Number(row.reversed_paise);
      const forward = from === 'failed' ? to !== 'failed' : Object.hasOwn(TRANSFER_RANK, to) ? TRANSFER_RANK[to] > (TRANSFER_RANK[from] ?? 99) : (from !== 'reversed' && from !== to) || grew;
      if (!forward) return { outcome: 'stale' };

      const transferPaise = Math.min(Number(row.amount_paise), paiseOf(transfer?.amountPaise) ?? Number(row.transfer_paise));
      const set = { transfer_status: to, transfer_paise: Math.max(transferPaise, Number(row.reversed_paise)) };
      if (isGatewayId(transfer?.id)) set.transfer_id = transfer.id;
      const ref = `payment:${row.id}`;
      let review = to === 'failed';
      if (to === 'reversed') {
        const atGateway = Math.min(set.transfer_paise, paiseOf(transfer?.amountReversedPaise) ?? set.transfer_paise);
        // First what this business's own refunds explain: a refund finished without its reversal in hand (a webhook, or an
        // answer still to come) waits with reversal_status pending, and this is that reversal. Only the rest is unexplained.
        let unexplained = atGateway - Number(row.reversed_paise);
        if (unexplained > 0) {
          const waiting = await t.query(
            `SELECT * FROM refunds WHERE tenant_id = $1 AND payment_id = $2 AND method = 'gateway' AND status IN ('requested', 'processed') AND reversal_status IN ('pending', 'recover')
             ORDER BY id FOR UPDATE`,
            [tenantId(), row.id],
          );
          for (const refund of waiting) {
            const take = Math.min(Number(refund.amount_paise), unexplained);
            if (take <= 0) break;
            await t.query(`UPDATE refunds SET reversal_status = 'reversed', reversal_paise = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId(), refund.id, take]);
            await writeLine(t, { orderId: row.order_id, kind: 'transfer_reversal', amountPaise: -take, ref: `refund:${refund.id}` });
            unexplained -= take;
          }
        }
        review = unexplained > 0;
        set.reversed_paise = Math.max(Number(row.reversed_paise), atGateway);
      }
      if (to === 'processed' || to === 'settled') await writeLine(t, { orderId: row.order_id, kind: 'transfer', amountPaise: set.transfer_paise, ref });
      if (review) {
        set.needs_review = true;
        await t.query(`UPDATE settlement_lines SET status = 'review' WHERE tenant_id = $1 AND ref = $2`, [tenantId(), ref]);
        await writeGap(t, { kind: 'transfer_failed', ref, details: { transfer: to } });
        const message = to === 'failed'
          ? `The payout for order ${order.order_number} to the seller account failed. It is held for review.`
          : `The payout for order ${order.order_number} was taken back by the gateway. It is held for review.`;
        for (const audience of ['owner', 'ops']) await raiseAlert(t, { kind: 'payment.transfer_review', severity: 'critical', message, target: `order:${order.id}`, dedupeKey: `transfer-${to}:${row.id}`, audience });
      }
      await changeRow(t, 'payments', row.id, 'captured', { set });
      return { outcome: 'processed' };
    });
    return result;
  }

  /**
   * The gateway's checkout handed the shopper's browser back to the seller's page (S-19, S-20). The browser's word is not
   * taken for anything: the signature is checked with the account's secret where there is one, and the payment is then
   * fetched from the gateway with the account's credentials. Only that answer can mark the order paid. A return with no
   * signature (the checkout's failure handler) is only a hint to go and look.
   * -> { http, status: 'paid' | 'pending' | 'failed' | 'review' | 'refused', orderNumber?, token? }
   */
  async function confirmReturn({ orderToken, gatewayOrderId, gatewayPaymentId, signature }) {
    const [order] = await db.query(`SELECT id, order_number, public_token FROM orders WHERE tenant_id = $1 AND public_token = $2 AND flow = 'checkout'`, [tenantId(), String(orderToken)]);
    if (!order) return { http: 404, status: 'refused' };
    const answer = (status, http = 200) => ({ http, status, orderNumber: order.order_number, token: order.public_token });
    const forged = async (why) => {
      log.warn('payments.forged_return', { orderId: order.id, why });
      metrics?.inc?.('payment_forged_returns_total', {});
      await writeAudit(db, { actor: 'shopper', action: 'payment.forged_callback', target: `order:${order.id}`, details: { why } });
      await raiseAlert(db, { kind: 'payment.forged_callback', audience: 'ops', message: `A payment confirmation for order ${order.order_number} did not check out and was refused.`, target: `order:${order.id}`, dedupeKey: `payment-forged:${order.id}` });
      return { http: 403, status: 'refused' };
    };
    const [row] = await db.query(`SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 AND provider = 'razorpay' AND gateway_order_id = $3`, [tenantId(), order.id, String(gatewayOrderId)]);
    if (!row) return forged('order');
    let creds;
    try {
      creds = await settings.credentials(row.mode, { accountRef: row.account_ref });
    } catch (err) {
      if (!(err instanceof PaymentError)) throw err;
      return answer('pending', 202);
    }
    const signed = Boolean(signature);
    if (signed && creds.checkoutSecret && !providers.razorpay.verifyCheckout({ gatewayOrderId, gatewayPaymentId, signature }, creds.checkoutSecret)) return forged('signature');

    let gp;
    try {
      gp = toGatewayPayment(await creds.adapter.fetchPayment(creds.account, gatewayPaymentId));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      // The gateway says there is no such payment on this account, and nothing vouched for it: a forgery.
      if (err.delivery === 'none' && err.kind === 'rejected' && !(signed && creds.checkoutSecret)) return forged('payment');
      // Otherwise the gateway did not answer: the webhook or the pending check will finish this.
      return answer('pending', 202);
    }
    if (!gp || gp.orderId !== row.gateway_order_id) return forged('payment');
    const applied = await applyGatewayPayment({ paymentId: row.id, gp, actor: 'gateway:razorpay' });
    const now = await orderNow(order.id);
    if (['paid', 'advance_paid', 'partially_refunded', 'refunded'].includes(now.payment_status)) return answer('paid');
    if (applied.outcome === 'amount_mismatch' || now.hold_reason === 'payment_mismatch') return answer('review');
    const [latest] = await db.query('SELECT status FROM payments WHERE tenant_id = $1 AND id = $2', [tenantId(), row.id]);
    return answer(latest.status === 'failed' ? 'failed' : 'pending');
  }

  /** The order page's "Try again" (S-74): the same order and, while it can take money, the same gateway order. */
  async function retry(orderToken, { baseUrl = '' } = {}) {
    const [order] = await db.query(`SELECT id, order_number, public_token FROM orders WHERE tenant_id = $1 AND public_token = $2 AND flow = 'checkout'`, [tenantId(), String(orderToken)]);
    if (!order) throw new PaymentError('not_found', 'We couldn’t find that order.');
    const started = await start(order.id, { baseUrl, actor: 'shopper' });
    return { orderNumber: order.order_number, token: order.public_token, next: started.done ? 'done' : 'pay', gateway: started.gateway };
  }

  /** Cash was collected at the door: the balance of a cash-on-delivery or part-advance order. Calling it twice records it once. */
  async function recordCodCollected(orderId, { actor = 'system' } = {}) {
    const result = await db.tx(async (t) => {
      const order = await lockOrder(t, orderId);
      if (!order || order.flow !== 'checkout' || !['cod', 'part_advance'].includes(order.payment_mode)) return { recorded: false };
      // A part-advance order whose advance was partly refunded still has its balance collected at the door.
      const due = ['cod_due', 'advance_paid'].includes(order.payment_status) || (order.payment_mode === 'part_advance' && order.payment_status === 'partially_refunded');
      if (!due || Number(order.balance_paise) <= 0) return { recorded: false };
      let [row] = await t.query(`SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2 AND purpose = 'cod' ORDER BY id LIMIT 1`, [tenantId(), order.id]);
      if (!row) [row] = await t.query(`INSERT INTO payments (tenant_id, order_id, purpose, provider, mode, amount_paise, method) VALUES ($1, $2, 'cod', 'cod', 'cod', $3, 'cod') RETURNING *`, [tenantId(), order.id, Number(order.balance_paise)]);
      const moved = await changeRow(t, 'payments', row.id, 'captured', { ifAllowed: true, set: row.status === 'captured' ? {} : { captured_at: new Date() } });
      if (moved.changed) await writeCaptureLines(t, moved.row);
      await changeOrder(t, order.id, { payment: 'paid', actor, reason: 'cash collected on delivery', set: { paid_paise: await sumCaptured(t, order.id) }, ifAllowed: true });
      return { recorded: moved.changed, paymentId: Number(row.id) };
    });
    if (result.recorded) kick();
    return result;
  }

  /** Nothing was or will be collected at the door: the order was cancelled or came back (S-69 clears the balance this way). */
  async function voidCod(orderId, { actor = 'system' } = {}) {
    const result = await db.tx(async (t) => {
      const order = await lockOrder(t, orderId);
      if (!order || order.flow !== 'checkout' || order.payment_status !== 'cod_due') return { voided: false };
      const moved = await changeOrder(t, order.id, { payment: 'voided', actor, reason: 'nothing to collect', ifAllowed: true });
      return { voided: moved.changed.payment };
    });
    if (result.voided) kick();
    return result;
  }

  /** The statement lines of a captured payment, written again harmlessly: for a row some other code captured. */
  async function ensureLines(paymentId) {
    await db.tx(async (t) => {
      const [row] = await t.query(`SELECT * FROM payments WHERE tenant_id = $1 AND id = $2 AND status = 'captured'`, [tenantId(), paymentId]);
      if (row) await writeCaptureLines(t, row);
    });
  }

  const service = { settings, statement, start, retry, applyGatewayPayment, applyTransfer, sendTransfer, takeShipping, confirmReturn, recordCodCollected, voidCod, ensureLines, writeCaptureLines };
  service.refunds = createRefunds(ctx, service);
  service.webhooks = createWebhooks(ctx, service);
  service.reconcile = createReconcile(ctx, service);
  return service;
}

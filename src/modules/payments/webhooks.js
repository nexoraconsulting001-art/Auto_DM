import crypto from 'node:crypto';
import { hmac, sameBytes } from '../../adapters/http.js';
import { SIGNATURE_HEADERS } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { isGatewayId, methodOf, opsAlert, paiseOf } from './util.js';

/**
 * Payment webhooks (PRD 9.7). Every delivery is verified on its exact bytes before anything is read (a bad signature is 401
 * and nothing is stored), cut down to ids, amounts and statuses, stored in provider_webhook_events, and only then answered
 * 2xx. The work is done afterwards from that table: in this process straight away (kick), and by the worker's sweep for
 * anything left over. The same event again is the same row (unique provider, scope and event id), and every change it can
 * make is guarded so that a repeat or a late, older event changes nothing (S-23, S-24).
 *
 *   managed  POST /webhooks/razorpay        Bhava's own account. The business is found by the gateway order stored at
 *                                           checkout and checked against every linked account the event names (S-73).
 *   own      POST /webhooks/razorpay/:key   one business's own account: the key names it and its secret verifies it. An
 *                                           event naming another business's order is stored, ignored and flagged.
 *   cashfree POST /webhooks/cashfree/:key   verified and stored; there is no Cashfree adapter yet, so it is not acted on.
 *
 * An event that names another business is a security event: stored with security set, ignored, logged with ids only, and
 * ops are told. It never changes any order.
 */
const BATCH = 50;
const MAX_ATTEMPTS = 8;
const LINK_KEYS = new Set(['account', 'account_id', 'recipient', 'linked_account', 'linked_account_id']);
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

const sha256 = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const word = (value, max) => (typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max) : '');
const gid = (value) => (isGatewayId(value) ? value : null);

/** Every linked account an event names, wherever it names one: Route ids start acc_. */
function linkedRefs(body) {
  const found = new Set();
  let budget = 2000;
  const walk = (value, depth) => {
    if (budget-- <= 0 || depth > 6 || value === null || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner === 'string' && LINK_KEYS.has(key) && /^acc_[A-Za-z0-9]{1,76}$/.test(inner)) found.add(inner);
      else if (typeof inner === 'object') walk(inner, depth + 1);
    }
  };
  walk(body, 0);
  return [...found].slice(0, 20);
}

/** What is kept of a Razorpay event: ids, amounts, statuses and the accounts it names. Never a card, VPA, email, phone or name. */
export function cleanRazorpayEvent(body) {
  const p = body?.payload && typeof body.payload === 'object' ? body.payload : {};
  const entity = (name) => (p[name]?.entity && typeof p[name].entity === 'object' ? p[name].entity : null);
  const payment = entity('payment');
  const order = entity('order');
  const refund = entity('refund');
  const transfer = entity('transfer');
  const account = entity('account');
  return {
    event: word(body?.event, 100),
    accountId: gid(body?.account_id),
    createdAt: Number.isSafeInteger(body?.created_at) ? body.created_at : null,
    payment: payment && {
      id: gid(payment.id), orderId: gid(payment.order_id), status: word(payment.status, 30), amountPaise: paiseOf(payment.amount), currency: word(payment.currency, 3),
      method: methodOf(payment.method), feePaise: paiseOf(payment.fee) ?? 0, taxPaise: paiseOf(payment.tax) ?? 0, amountRefundedPaise: paiseOf(payment.amount_refunded) ?? 0, errorCode: word(payment.error_code, 80),
    },
    order: order && { id: gid(order.id), status: word(order.status, 30), amountPaise: paiseOf(order.amount), amountPaidPaise: paiseOf(order.amount_paid) },
    refund: refund && { id: gid(refund.id), paymentId: gid(refund.payment_id), status: word(refund.status, 30), amountPaise: paiseOf(refund.amount), noteRefund: /^[0-9]{1,18}$/.test(String(refund.notes?.refund ?? '')) ? String(refund.notes.refund) : null },
    transfer: transfer && { id: gid(transfer.id), source: gid(transfer.source), recipient: gid(transfer.recipient), status: word(transfer.status, 30), amountPaise: paiseOf(transfer.amount), amountReversedPaise: paiseOf(transfer.amount_reversed) ?? 0 },
    account: account && { id: gid(account.id), status: word(account.status, 40) },
    linked: linkedRefs(body),
  };
}

export function createWebhooks(ctx, service) {
  const { db, config, providers, repos } = ctx;
  const platformDb = db.platform ?? db;
  const metrics = ctx.platform?.metrics;

  async function store({ provider, scope, eventId, eventType, payload, tenantId = null }) {
    const [row] = await platformDb.query(
      `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload, tenant_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (provider, scope, event_id) DO NOTHING RETURNING id`,
      [provider, scope, eventId, eventType.slice(0, 100), JSON.stringify(payload), tenantId],
    );
    return row ? Number(row.id) : null;
  }

  const refuse = (res, scope) => {
    log.warn('payments.webhook_refused', { scope });
    metrics?.inc?.('payment_webhooks_refused_total', {});
    return res.status(401).end();
  };

  const eventIdOf = (req, raw) => {
    const header = req.get(SIGNATURE_HEADERS.razorpayEventId);
    return typeof header === 'string' && EVENT_ID.test(header) ? header : `sha256:${sha256(raw)}`;
  };

  async function receiveRazorpay(req, res, { scope, tenantId = null, secret }) {
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    if (!raw || !secret || !providers.razorpay.verifyWebhook(raw, req.get(SIGNATURE_HEADERS.razorpay) ?? '', secret)) return refuse(res, scope);
    let body = null;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.event !== 'string') return res.status(400).json({ error: 'That event could not be read.' });
    const payload = cleanRazorpayEvent(body);
    const id = await store({ provider: 'razorpay', scope, eventId: eventIdOf(req, raw), eventType: payload.event, payload, tenantId });
    res.status(200).json({ ok: true });
    metrics?.inc?.('payment_webhooks_total', { result: id ? 'stored' : 'duplicate' });
    if (id) kick();
  }

  /** Bhava's own account. */
  const managed = (req, res) => receiveRazorpay(req, res, { scope: 'managed', secret: config.razorpayWebhookSecret });

  /** One business's own account, named by the key in the address. */
  async function own(req, res) {
    const found = await service.settings.byWebhookKey(req.params.key);
    if (!found) return refuse(res, 'own');
    return receiveRazorpay(req, res, { scope: `tenant:${found.tenantId}`, tenantId: found.tenantId, secret: found.secret });
  }

  /** Cashfree signs base64(HMAC-SHA256(timestamp + body)) with the business's own secret key. Stored, not yet acted on. */
  async function cashfree(req, res) {
    const found = await service.settings.byWebhookKey(req.params.key);
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    const stamp = req.get(SIGNATURE_HEADERS.cashfreeTimestamp) ?? '';
    if (!found || !raw || !/^[0-9]{1,20}$/.test(stamp)) return refuse(res, 'cashfree');
    const keys = await withTenant(found.tenantId, () => repos.gatewayKeys.get('cashfree')).catch(() => null);
    if (!keys?.keySecret || !sameBytes(req.get(SIGNATURE_HEADERS.cashfree) ?? '', hmac(keys.keySecret, Buffer.concat([Buffer.from(stamp), raw]), 'base64'))) return refuse(res, 'cashfree');
    let type = '';
    try {
      type = word(JSON.parse(raw.toString('utf8'))?.type, 100);
    } catch {
      return res.status(400).json({ error: 'That event could not be read.' });
    }
    await store({ provider: 'cashfree', scope: `tenant:${found.tenantId}`, eventId: `sha256:${sha256(raw)}`, eventType: type, payload: { event: type }, tenantId: found.tenantId });
    res.status(200).json({ ok: true });
    kick();
  }

  // ---- working through what was stored ----

  async function finish(row, { status, outcome, security = false, tenantId = null }) {
    await platformDb.query(
      `UPDATE provider_webhook_events SET status = $2, outcome = $3, security = $4, tenant_id = COALESCE($5, tenant_id), attempts = attempts + 1, last_error = '', processed_at = now()
       WHERE id = $1 AND status = 'received'`,
      [row.id, status, String(outcome).slice(0, 60), security, tenantId],
    );
    metrics?.inc?.('payment_webhook_events_total', { status });
    return { id: Number(row.id), status, outcome, security };
  }

  async function failed(row, err) {
    const why = `${err?.name ?? 'Error'}${err?.code ? `:${err.code}` : ''}${err?.kind ? `:${err.kind}` : ''}`.slice(0, 300);
    const [after] = await platformDb.query(
      `UPDATE provider_webhook_events SET attempts = attempts + 1, last_error = $2, status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END
       WHERE id = $1 AND status = 'received' RETURNING status, attempts, tenant_id`,
      [row.id, why, MAX_ATTEMPTS],
    );
    reportError(err, { msg: 'payments.webhook_failed', event: Number(row.id) });
    if (after?.status === 'failed') {
      await opsAlert(platformDb, { tenantId: after.tenant_id, kind: 'payment.webhook_failed', message: `A payment event could not be worked through after ${MAX_ATTEMPTS} tries (event ${row.id}).`, target: `webhook:${row.id}`, dedupeKey: `webhook-failed:${row.id}` });
    }
    return { id: Number(row.id), status: after?.status ?? 'received', outcome: 'error' };
  }

  /** The payment an event is about, by its gateway order, else its gateway payment, on any account. */
  async function paymentOf(gatewayOrderId, gatewayPaymentId) {
    const columns = 'tenant_id, id, order_id, mode, account_ref';
    if (gatewayOrderId) {
      const [row] = await platformDb.query(`SELECT ${columns} FROM payments WHERE provider = 'razorpay' AND gateway_order_id = $1 ORDER BY id LIMIT 1`, [gatewayOrderId]);
      if (row) return row;
    }
    if (gatewayPaymentId) {
      const [row] = await platformDb.query(`SELECT ${columns} FROM payments WHERE provider = 'razorpay' AND gateway_payment_id = $1 ORDER BY id LIMIT 1`, [gatewayPaymentId]);
      if (row) return row;
    }
    return null;
  }

  /** Works out which business an event belongs to, or why it is ignored. -> { tenantId, run } | { ignore, security?, ... } */
  async function route(row) {
    const ev = row.payload ?? {};
    const type = row.event_type;
    const isManaged = row.scope === 'managed';
    const urlTenant = isManaged ? null : Number(row.scope.slice('tenant:'.length));
    if (row.provider !== 'razorpay') return { ignore: 'not_handled', tenantId: urlTenant };

    if (type.startsWith('account.')) {
      if (!isManaged || !ev.account?.id) return { ignore: 'not_handled', tenantId: urlTenant };
      const [owner] = await platformDb.query('SELECT tenant_id FROM payment_settings WHERE linked_account_id = $1', [ev.account.id]);
      if (!owner) return { ignore: 'unknown_account' };
      return { tenantId: owner.tenant_id, run: async () => ((await service.settings.setKyc(ev.account.status || type.slice('account.'.length))).changed ? 'processed' : 'stale') };
    }

    const family = type.startsWith('payment.') || type === 'order.paid' ? 'payment' : type.startsWith('refund.') ? 'refund' : type.startsWith('transfer.') ? 'transfer' : null;
    if (!family || (family === 'transfer' && !isManaged)) return { ignore: 'not_handled', tenantId: urlTenant };
    const gatewayOrderId = family === 'payment' ? ev.payment?.orderId ?? ev.order?.id ?? null : null;
    const gatewayPaymentId = family === 'payment' ? ev.payment?.id : family === 'refund' ? ev.refund?.paymentId : ev.transfer?.source;
    const payment = await paymentOf(gatewayOrderId, gatewayPaymentId);
    if (!payment) return { ignore: 'unknown_order', tenantId: urlTenant };

    // Every business the event names: the order's, the address's, and each linked account's (S-73).
    const named = new Set([payment.tenant_id]);
    if (urlTenant !== null) named.add(urlTenant);
    const refs = [...new Set([...(ev.linked ?? []), ...(isManaged && payment.mode === 'managed' ? [payment.account_ref] : [])].filter(isGatewayId))];
    if (refs.length) {
      for (const r of await platformDb.query('SELECT tenant_id FROM payment_settings WHERE linked_account_id = ANY($1::text[])', [refs])) named.add(r.tenant_id);
    }
    if (named.size > 1) return { ignore: 'tenant_mismatch', security: true, orderTenant: payment.tenant_id };
    if (payment.mode !== (isManaged ? 'managed' : 'own')) return { ignore: 'unknown_order', tenantId: urlTenant };

    const tenantId = payment.tenant_id;
    const paymentId = Number(payment.id);
    if (family === 'payment') {
      if (!ev.payment?.id) return { ignore: 'not_handled', tenantId };
      return { tenantId, run: async () => (await service.applyGatewayPayment({ paymentId, gp: ev.payment, actor: 'webhook:razorpay' })).outcome };
    }
    if (family === 'refund') {
      if (!ev.refund?.id) return { ignore: 'not_handled', tenantId };
      return { tenantId, run: async () => service.refunds.applyGatewayRefund({ paymentId, refund: ev.refund, type }) };
    }
    return { tenantId, run: async () => (await service.applyTransfer({ paymentId, transfer: ev.transfer, type })).outcome };
  }

  async function securityEvent(row, routed) {
    log.warn('payments.webhook_security', { event: Number(row.id), scope: row.scope, type: row.event_type, orderTenant: routed.orderTenant ?? null });
    metrics?.inc?.('payment_webhook_security_total', {});
    await opsAlert(platformDb, {
      tenantId: routed.orderTenant ?? null,
      kind: 'payment.webhook_mismatch',
      message: `A payment event naming one business’s order and another business’s account was stored and ignored (event ${row.id}). No order was changed.`,
      target: `webhook:${row.id}`,
      dedupeKey: `webhook-mismatch:${row.id}`,
    });
  }

  async function processOne(row) {
    try {
      const routed = await route(row);
      if (routed.ignore) {
        if (routed.security) await securityEvent(row, routed);
        return await finish(row, { status: 'ignored', outcome: routed.ignore, security: Boolean(routed.security), tenantId: routed.security ? null : routed.tenantId ?? null });
      }
      const outcome = await withTenant(routed.tenantId, routed.run);
      return await finish(row, { status: outcome === 'processed' ? 'processed' : 'ignored', outcome, tenantId: routed.tenantId });
    } catch (err) {
      return failed(row, err);
    }
  }

  /** One pass over what is waiting, oldest first. A failure waits longer before each try (5 s, 20 s, 80 s, ... up to an hour). */
  async function dispatch({ limit = BATCH } = {}) {
    const rows = await platformDb.query(
      `SELECT * FROM provider_webhook_events
       WHERE provider IN ('razorpay', 'cashfree') AND status = 'received'
         AND (attempts = 0 OR received_at < now() - make_interval(secs => least(3600, 5 * power(4, attempts - 1))))
       ORDER BY id LIMIT $1`,
      [limit],
    );
    const results = [];
    for (const row of rows) results.push(await processOne(row));
    return results;
  }

  /** Runs passes until nothing is waiting that can be done now. */
  async function drain() {
    const all = [];
    for (let pass = 0; pass < 100; pass++) {
      const results = await dispatch();
      all.push(...results);
      if (results.length < BATCH) break;
    }
    return all;
  }

  let running = null;
  let again = false;
  /** Work through new events soon, in this process. Safe to call from anywhere; one run at a time. */
  function kick() {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await drain();
        } while (again);
      } catch (err) {
        reportError(err, { msg: 'payments.webhooks_drain_failed' });
      } finally {
        running = null;
      }
    })();
  }

  /** For tests and the worker: waits for a run in progress, then drains what is left. */
  async function settle() {
    while (running) await running;
    return drain();
  }

  return { managed, own, cashfree, store, dispatch, drain, kick, settle, route };
}

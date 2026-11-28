import crypto from 'node:crypto';
import { BILLING_EVENTS, BILLING_WEBHOOK } from '../../contracts/billing.js';
import { SIGNATURE_HEADERS } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { opsAlert } from '../payments/util.js';
import { countWebhookProcessed, countWebhookStored } from '../../platform/metrics.js';
import { createWebhookDrain } from '../../platform/webhook-drain.js';

/**
 * The billing provider's webhooks (PRD 5.12, F-51, F-52), at BILLING_WEBHOOK.path, before any business is known.
 *
 * A delivery is verified on its exact bytes with the billing secret before anything is read: a missing, malformed or wrong
 * signature is 400 and nothing is stored. A good one is cut down to ids, amounts, statuses and times (never a card, a VPA,
 * an email, a phone or a name), stored in provider_webhook_events under scope 'billing', and only then answered 200. The
 * work is done from that table, here at once and by the worker's sweep for anything left: each event id once, each payment
 * id one payment and one invoice, and an event older than the state already applied changes no status ('stale').
 *
 * The web app (at once) and the worker (each minute) both work through the table through the one shared drainer
 * (platform/webhook-drain.js): a drainer first takes an event (while 'received', processed_at is when a drainer took it;
 * LEASE for one that died), and an event whose subscription has an earlier event in another drainer's hands waits for it,
 * so events are applied in the order they came and each one is finished (and so counted by lastApplied) before the next is
 * weighed (R4-MONEY-2, R4-WH-1). The order is 'strict': an earlier event waiting for its retry holds the later ones too (M-5).
 */
const BATCH = 50;
const MAX_ATTEMPTS = 8;
const LEASE = '5 minutes';
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const SIGNATURE = /^[0-9a-f]{64}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_]{1,80}$/;

const word = (value, max) => (typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max) : '');
const pid = (value) => (typeof value === 'string' && PROVIDER_ID.test(value) ? value : null);
const secs = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const paise = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/** What is kept of a billing event: ids, amounts, statuses and times. */
export function cleanBillingEvent(body) {
  const p = body?.payload && typeof body.payload === 'object' ? body.payload : {};
  const entity = (name) => (p[name]?.entity && typeof p[name].entity === 'object' ? p[name].entity : null);
  const sub = entity('subscription');
  const pay = entity('payment');
  const tenant = sub?.notes && /^[0-9]{1,10}$/.test(String(sub.notes.tenant ?? '')) ? Number(sub.notes.tenant) : null;
  return {
    event: word(body?.event, 100),
    createdAt: secs(body?.created_at),
    subscription: sub && {
      id: pid(sub.id), status: word(sub.status, 30), planId: pid(sub.plan_id), customerId: pid(sub.customer_id), currentStart: secs(sub.current_start), currentEnd: secs(sub.current_end),
      paidCount: Number.isSafeInteger(sub.paid_count) ? sub.paid_count : null, tenant,
    },
    payment: pay && {
      id: pid(pay.id), status: word(pay.status, 30), amountPaise: paise(pay.amount), currency: word(pay.currency, 3), method: word(pay.method, 20), errorCode: word(pay.error_code, 80),
      invoiceId: pid(pay.invoice_id), createdAt: secs(pay.created_at),
      // The card's own id (not the per-customer token) or the UPI handle: an opaque id, noted only as a keyed hash (referrals.notePaymentMethod).
      methodMark: word(pay.card_id ?? pay.card?.id ?? pay.vpa, 120),
    },
  };
}

export function createBillingWebhooks(ctx, service) {
  const { providers } = ctx;
  const platformDb = ctx.db.platform ?? ctx.db;
  const metrics = ctx.platform?.metrics;

  const refuse = (res) => {
    log.warn('billing.webhook_refused', {});
    metrics?.inc?.('billing_webhooks_refused_total', {});
    return res.status(BILLING_WEBHOOK.badSignatureStatus).json({ error: 'That event could not be verified.' });
  };

  /** POST /webhooks/billing/razorpay */
  async function receive(req, res) {
    try {
      const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
      const signature = req.get(SIGNATURE_HEADERS.razorpay);
      if (!raw || typeof signature !== 'string' || !SIGNATURE.test(signature) || !providers.razorpay.billing.verifyWebhook(raw, signature)) return refuse(res);
      let body = null;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = null;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.event !== 'string') return res.status(400).json({ error: 'That event could not be read.' });
      const payload = cleanBillingEvent(body);
      const header = req.get(SIGNATURE_HEADERS.razorpayEventId);
      const eventId = typeof header === 'string' && EVENT_ID.test(header) ? header : `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
      const row = await store(eventId, payload);
      res.status(200).json({ ok: true });
      countWebhookStored(metrics, 'razorpay_billing');
      metrics?.inc?.('billing_webhooks_total', { result: row ? 'stored' : 'duplicate' });
      if (row) kick();
      return undefined;
    } catch (err) {
      reportError(err, { msg: 'billing.webhook_store_failed' });
      // Not stored: a 5xx makes the provider send it again.
      if (!res.headersSent) res.status(503).json({ error: 'Try again.' });
      return undefined;
    }
  }

  /**
   * Keeps one cleaned event to be worked from the table: the webhook's, or one the reconcile read from the provider
   * (reconcile.js). The same event id again is a duplicate. With `redrive`, an event of that id that failed for good is put
   * back to be tried again from its first back-off (the reconcile still finds the provider disagreeing with what is kept).
   * -> { id } when stored or put back, else null
   */
  async function store(eventId, payload, { redrive = false } = {}) {
    const [row] = await platformDb.query(
      `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload) VALUES ('razorpay', $1, $2, $3, $4::jsonb)
       ON CONFLICT (provider, scope, event_id) DO ${redrive
    ? `UPDATE SET status = 'received', outcome = '', attempts = 0, processed_at = NULL, last_attempt_at = NULL, payload = EXCLUDED.payload
         WHERE provider_webhook_events.status = 'failed'`
    : 'NOTHING'} RETURNING id`,
      [BILLING_WEBHOOK.scope, eventId, payload.event.slice(0, 100), JSON.stringify(payload)],
    );
    return row ?? null;
  }

  async function finish(row, { status, outcome, security = false, tenantId = null }) {
    await platformDb.query(
      `UPDATE provider_webhook_events SET status = $2, outcome = $3, security = $4, tenant_id = COALESCE($5, tenant_id), attempts = attempts + 1, last_error = '', processed_at = now()
       WHERE id = $1 AND status = 'received'`,
      [row.id, status, String(outcome).slice(0, 60), security, tenantId],
    );
    metrics?.inc?.('billing_webhook_events_total', { status });
    countWebhookProcessed(metrics, 'razorpay_billing', status);
    return { id: Number(row.id), status, outcome, security };
  }

  async function failed(row, err) {
    const why = `${err?.name ?? 'Error'}${err?.code ? `:${err.code}` : ''}${err?.kind ? `:${err.kind}` : ''}`.slice(0, 300);
    const [after] = await platformDb.query(
      `UPDATE provider_webhook_events SET attempts = attempts + 1, last_error = $2, status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END,
         processed_at = CASE WHEN attempts + 1 >= $3 THEN now() ELSE NULL END
       WHERE id = $1 AND status = 'received' RETURNING status, tenant_id`,
      [row.id, why, MAX_ATTEMPTS],
    );
    reportError(err, { msg: 'billing.webhook_failed', event: Number(row.id) });
    countWebhookProcessed(metrics, 'razorpay_billing', after?.status === 'failed' ? 'failed' : 'retry');
    if (err?.code === 'billing_not_ready') {
      await opsAlert(platformDb, { tenantId: null, kind: 'billing.not_ready', message: 'A Bhava charge arrived but Bhava’s legal name, state or SAC is not set, so no invoice could be issued. Set them in Billing settings.', target: 'billing-settings', dedupeKey: 'billing-not-ready' });
    }
    if (after?.status === 'failed') {
      await opsAlert(platformDb, { tenantId: after.tenant_id, kind: 'billing.webhook_failed', message: `A billing event could not be worked through after ${MAX_ATTEMPTS} tries (event ${row.id}).`, target: `webhook:${row.id}`, dedupeKey: `billing-webhook-failed:${row.id}` });
    }
    return { id: Number(row.id), status: after?.status ?? 'received', outcome: 'error' };
  }

  /** Which business an event is for, or why it is ignored. The subscription id is the only key; the notes must agree with it. */
  async function route(row) {
    const ev = row.payload ?? {};
    const kind = BILLING_EVENTS[row.event_type];
    if (!kind) return { ignore: 'not_handled' };
    const subId = ev.subscription?.id;
    if (!subId) return { ignore: 'not_handled' };
    const [sub] = await platformDb.query('SELECT tenant_id, id FROM subscriptions WHERE provider_subscription_id = $1', [subId]);
    if (!sub) return { ignore: 'unknown_subscription' };
    if (ev.subscription.tenant !== null && ev.subscription.tenant !== undefined && ev.subscription.tenant !== Number(sub.tenant_id)) {
      return { ignore: 'tenant_mismatch', security: true, tenantId: Number(sub.tenant_id) };
    }
    const tenantId = Number(sub.tenant_id);
    const eventAtMs = ev.createdAt ? ev.createdAt * 1000 : null;
    const lastMs = await service.lastApplied(tenantId);
    if (kind === 'charged') {
      if (!ev.payment?.id || ev.payment.status !== 'captured') return { ignore: 'not_handled', tenantId };
      const planInfo = await service.planByProviderId(ev.subscription.planId);
      return { tenantId, run: () => service.applyCharge({ ev, planInfo, eventAtMs, lastMs }) };
    }
    if (kind === 'failed') return { tenantId, run: () => service.applyFailure({ ev, eventAtMs, lastMs }) };
    if (kind === 'halted') return { tenantId, run: () => service.applyFailure({ ev: { ...ev, payment: null }, eventAtMs, lastMs, halted: true }) };
    if (kind === 'cancelled') return { tenantId, run: () => service.applyCancel({ ev, eventAtMs, lastMs }) };
    return { tenantId, run: () => service.applyPeriod({ ev, eventAtMs, lastMs }) };
  }

  /** One claimed event (webhook-drain.js has it alone, and nothing of its subscription is ahead of it in another's hands). */
  async function processOne(row) {
    try {
      const routed = await route(row);
      if (routed.ignore) {
        if (routed.security) {
          log.warn('billing.webhook_security', { event: Number(row.id), type: row.event_type });
          await opsAlert(platformDb, { tenantId: routed.tenantId ?? null, kind: 'billing.webhook_mismatch', message: `A billing event named one business’s subscription and another business in its notes. It was stored and ignored (event ${row.id}).`, target: `webhook:${row.id}`, dedupeKey: `billing-webhook-mismatch:${row.id}` });
        }
        return await finish(row, { status: 'ignored', outcome: routed.ignore, security: Boolean(routed.security), tenantId: routed.security ? null : routed.tenantId ?? null });
      }
      const outcome = await withTenant(routed.tenantId, routed.run);
      return await finish(row, { status: outcome === 'processed' ? 'processed' : 'ignored', outcome, tenantId: routed.tenantId });
    } catch (err) {
      return failed(row, err);
    }
  }

  // Only the billing scope's rows: the store's managed account is provider 'razorpay' too.
  const { dispatch, drain, kick, settle } = createWebhookDrain({
    db: platformDb, name: 'billing.webhooks', providers: [BILLING_WEBHOOK.provider], scopes: [BILLING_WEBHOOK.scope], lease: LEASE, batch: BATCH, process: processOne,
    // 'strict' (M-5, R6-RECON-3): an event waiting for its retry still holds back the later events of its subscription. With
    // 'in_hand' a later event went first and was counted by lastApplied, and the retried charge was then 'stale': paid, but
    // left in grace until graceSweep suspended the business.
    order: 'strict',
    subjects: { sql: `array_remove(ARRAY[payload->'subscription'->>'id'], NULL)`, of: (row) => [row.payload?.subscription?.id] },
  });

  return { receive, store, dispatch, drain, kick, settle, route };
}

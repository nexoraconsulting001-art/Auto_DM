import { opsAlert } from '../payments/util.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { cleanBillingEvent } from './webhooks.js';

/**
 * The billing reconcile (M-3, R6-RECON-1): what a business pays Bhava must not hang on webhooks alone. A subscription event
 * Razorpay never delivered, or one that failed every try, used to leave the business as it was: on its paid plan with no
 * charge (free service), or in grace and then suspended although it had paid.
 *
 * Each run reads from Razorpay every live subscription that may have moved without us: one in grace or past due, one whose
 * period has ended (a renewal charges, fails or ends the subscription then), and one waiting for its first payment. What
 * Razorpay holds and we do not becomes an event in provider_webhook_events, in the shape a webhook leaves there
 * (cleanBillingEvent), under its own event id, and is worked by the one billing drain: the same route and the same
 * applyCharge / applyFailure / applyCancel, the same order behind the subscription's earlier events, the same once-only
 * rules. So the reconcile never changes billing state itself, and running it twice, or while the webhooks arrive, changes
 * nothing twice:
 *
 *   a paid invoice whose payment we have not recorded   subscription.charged   reconcile:charged:<payment id>
 *     (its period is the invoice's; applyCharge records each payment id once, whichever of webhook and reconcile is first)
 *   Razorpay ended the subscription and we have not     subscription.cancelled reconcile:cancelled:<subscription id>
 *   Razorpay holds it 'halted' and we hold it active    subscription.halted    reconcile:halted:<subscription id>:<paid count>
 *   Razorpay holds it 'pending' and we hold it active   subscription.pending   reconcile:pending:<subscription id>:<paid count>
 *
 * A state read now is newer than every event already applied (each of those was created before it reached us), so its time
 * is now, or the last applied event's time if Razorpay's clock is ahead. A reconcile event that failed for good is put back
 * by the next run that still finds the disagreement (after billing_not_ready is cleared, say). Every event found is told to
 * Bhava's team: each one is a webhook we missed.
 *
 * Each run also settles every Razorpay cancel Bhava still owes (provider_cancel_pending, M-6: a subscription ended here
 * after grace whose cancel call failed), so an ended subscription does not go on charging; one still owed is told to ops.
 */
const PAID_INVOICES_READ = 10;
const ENDED = new Set(['cancelled', 'completed', 'expired']);

export function createBillingReconcile(ctx, service, webhooks) {
  const platformDb = ctx.db.platform ?? ctx.db;
  const provider = () => ctx.providers.razorpay.billing;
  const metrics = ctx.platform?.metrics;

  /** Live subscriptions that may have moved at Razorpay without an event reaching us (a platform read across businesses). */
  const due = () => platformDb.query(
    `SELECT s.tenant_id, s.id, s.status, s.provider_subscription_id FROM subscriptions s
     WHERE s.status IN ('active', 'past_due', 'grace') AND s.provider_subscription_id IS NOT NULL
       AND (s.status <> 'active' OR s.current_period_end IS NULL OR s.current_period_end <= $1::timestamptz
         OR NOT EXISTS (SELECT 1 FROM billing_payments p WHERE p.tenant_id = s.tenant_id AND p.provider_subscription_id = s.provider_subscription_id AND p.status = 'captured'))
     ORDER BY s.tenant_id`,
    [service.at().toISOString()],
  );

  const recorded = async (business, paymentId) => Boolean((await platformDb.query(
    `SELECT 1 FROM billing_payments WHERE tenant_id = $1 AND provider = 'razorpay' AND provider_payment_id = $2`,
    [business, paymentId],
  ))[0]);

  /** What Razorpay holds for one subscription and we do not, as webhook bodies. */
  async function missed(s) {
    const subscriptionId = s.provider_subscription_id;
    const entity = await provider().entity(subscriptionId);
    if (!entity || entity.id !== subscriptionId) return [];
    const found = [];
    const paid = (await provider().invoices(subscriptionId, { count: PAID_INVOICES_READ })).filter((i) => i?.status === 'paid' && i.payment_id).reverse();
    for (const invoice of paid) {
      if (await recorded(Number(s.tenant_id), invoice.payment_id)) continue;
      const payment = await provider().fetchPayment(invoice.payment_id);
      if (payment?.status !== 'captured') continue;
      const period = { ...entity, current_start: invoice.billing_start ?? entity.current_start, current_end: invoice.billing_end ?? entity.current_end };
      found.push({ eventId: `reconcile:charged:${payment.id}`, body: { event: 'subscription.charged', created_at: payment.created_at, payload: { subscription: { entity: period }, payment: { entity: payment } } } });
    }
    const lastMs = await service.lastApplied(Number(s.tenant_id));
    const observed = Math.max(Math.floor(+service.at() / 1000), lastMs === null ? 0 : Math.ceil(lastMs / 1000));
    const stateEvent = (event, eventId) => found.push({ eventId, body: { event, created_at: observed, payload: { subscription: { entity } } } });
    if (ENDED.has(entity.status)) stateEvent('subscription.cancelled', `reconcile:cancelled:${subscriptionId}`);
    else if (entity.status === 'halted' && s.status === 'active') stateEvent('subscription.halted', `reconcile:halted:${subscriptionId}:${entity.paid_count ?? 0}`);
    else if (entity.status === 'pending' && s.status === 'active') stateEvent('subscription.pending', `reconcile:pending:${subscriptionId}:${entity.paid_count ?? 0}`);
    return found;
  }

  /** Razorpay cancels still owed, tried again. -> how many are still owed */
  async function settleCancels() {
    let owed = 0;
    const rows = await platformDb.query('SELECT tenant_id, id, provider_cancel_pending FROM subscriptions WHERE provider_cancel_pending IS NOT NULL ORDER BY tenant_id');
    for (const row of rows) {
      const business = Number(row.tenant_id);
      const settled = await withTenant(business, () => service.settleProviderCancel()).catch((err) => {
        reportError(err, { msg: 'billing.cancel_retry_failed', tenantId: business });
        return false;
      });
      if (settled) continue;
      owed += 1;
      await opsAlert(platformDb, {
        tenantId: business, kind: 'billing.cancel_pending', target: `subscription:${row.id}`, dedupeKey: `billing-cancel-pending:${row.provider_cancel_pending}`,
        message: `Bhava ended subscription ${row.provider_cancel_pending} but Razorpay has not cancelled it yet; it is tried again every run. Cancel it in Razorpay if this stays.`,
      });
    }
    return owed;
  }

  /** One run over every due subscription. -> { checked, stored, failed, cancelsOwed } */
  async function run() {
    const done = { checked: 0, stored: 0, failed: 0, cancelsOwed: await settleCancels() };
    for (const s of await due()) {
      done.checked += 1;
      try {
        for (const { eventId, body } of await missed(s)) {
          const row = await webhooks.store(eventId, cleanBillingEvent(body), { redrive: true });
          if (!row) continue;
          done.stored += 1;
          log.warn('billing.reconcile_missed', { tenantId: Number(s.tenant_id), event: body.event, row: Number(row.id) });
          metrics?.inc?.('billing_reconcile_missed_total', { event: body.event });
          await opsAlert(platformDb, {
            tenantId: Number(s.tenant_id), kind: 'billing.reconcile_missed', severity: 'warning', target: `webhook:${row.id}`, dedupeKey: `billing-reconcile:${eventId}`,
            message: `Razorpay showed a ${body.event} for subscription ${s.provider_subscription_id} that no webhook had brought in. It was put through billing (event ${row.id}).`,
          });
        }
      } catch (err) {
        done.failed += 1;
        reportError(err, { msg: 'billing.reconcile_failed', tenantId: Number(s.tenant_id) });
      }
    }
    if (done.stored) await webhooks.drain();
    return done;
  }

  return { run };
}

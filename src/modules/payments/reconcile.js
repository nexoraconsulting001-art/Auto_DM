import { ProviderError } from '../../adapters/http.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { PaymentError, raiseAlert, writeGap } from './util.js';

/**
 * Payments that got stuck between states, found and put right (PRD 9.7).
 *
 *   pendingCheck()  every couple of minutes: a payment still not captured 15 minutes after its gateway order was made is
 *                   looked up at the gateway, and what the gateway says is applied exactly as a webhook would be (S-26). It
 *                   is asked again every 90 s for the first hour, every 30 min for the first day, then every 6 h for a week:
 *                   a payment that arrives after the hold ran out is still found.
 *   daily()         once a day, per business: every payment captured in the last three days is matched with the gateway
 *                   (amount and refunds), Route transfers that never arrived or failed are flagged, statement lines that are
 *                   missing are written, and refunds or reversals stuck for over a day are flagged. What can't be put right
 *                   is written to reconciliation_gaps for the Platform Console.
 */
const RANK = Object.freeze({ captured: 3, authorized: 2, failed: 1 });

export function createReconcile(ctx, service) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;

  /** Asks the gateway about one payment of the current business and applies the answer. -> the outcome */
  async function checkPayment(paymentId) {
    const [row] = await db.query('SELECT * FROM payments WHERE tenant_id = $1 AND id = $2', [tenantId(), paymentId]);
    if (!row?.gateway_order_id) return 'unknown_order';
    // Marks the check, so the next one waits its turn whatever the gateway answers.
    await db.query('UPDATE payments SET updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), row.id]);
    let creds;
    let found;
    try {
      creds = await service.settings.credentials(row.mode, { accountRef: row.account_ref });
      found = await creds.adapter.orderPayments(creds.account, row.gateway_order_id);
    } catch (err) {
      if (!(err instanceof ProviderError) && !(err instanceof PaymentError)) throw err;
      log.warn('payments.check_failed', { paymentId: Number(row.id), kind: err.kind ?? err.reason ?? err.code });
      return 'unanswered';
    }
    const ranked = (found ?? []).filter((p) => Object.hasOwn(RANK, p?.status)).sort((a, b) => RANK[b.status] - RANK[a.status]);
    if (!ranked.length) return 'nothing';
    const best = await service.applyGatewayPayment({ paymentId: row.id, gp: ranked[0], actor: 'job:payment-check' });
    // A second captured payment on one gateway order is money taken twice: applying it flags it.
    for (const extra of ranked.slice(1).filter((p) => p.status === 'captured')) await service.applyGatewayPayment({ paymentId: row.id, gp: extra, actor: 'job:payment-check' });
    return best.outcome;
  }

  async function pendingCheck({ limit = 100 } = {}) {
    const due = await platformDb.query(
      `SELECT p.tenant_id, p.id FROM payments p JOIN orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id
       WHERE p.provider = 'razorpay' AND p.status IN ('created', 'authorized', 'failed') AND p.gateway_order_id IS NOT NULL AND NOT p.needs_review
         AND o.payment_status = 'unpaid'
         AND p.created_at < now() - make_interval(mins => $1) AND p.created_at > now() - interval '7 days'
         AND p.updated_at < now() - CASE WHEN p.created_at > now() - interval '1 hour' THEN interval '90 seconds'
                                         WHEN p.created_at > now() - interval '1 day' THEN interval '30 minutes' ELSE interval '6 hours' END
       ORDER BY p.updated_at LIMIT $2`,
      [STORE_LIMITS.pendingCheckAfterMinutes, limit],
    );
    const results = [];
    for (const { tenant_id: tid, id } of due) {
      try {
        results.push({ tenantId: tid, paymentId: Number(id), outcome: await withTenant(tid, () => checkPayment(Number(id))) });
      } catch (err) {
        reportError(err, { msg: 'payments.check_failed', tenantId: tid, paymentId: Number(id) });
      }
    }
    return results;
  }

  /** The daily match for the current business. -> { checked, gaps, repaired } */
  async function reconcileBusiness() {
    let gaps = 0;
    let repaired = 0;
    let checked = 0;
    const gap = async (entry) => {
      if (await writeGap(db, entry)) gaps++;
    };

    // Captured here and captured there, for the same amount, with the same refunds.
    const captured = await db.query(
      `SELECT * FROM payments WHERE tenant_id = $1 AND provider = 'razorpay' AND status = 'captured' AND captured_at > now() - interval '3 days' ORDER BY id LIMIT 500`,
      [tenantId()],
    );
    for (const row of captured) {
      checked++;
      let gp;
      try {
        const creds = await service.settings.credentials(row.mode, { accountRef: row.account_ref });
        gp = await creds.adapter.fetchPayment(creds.account, row.gateway_payment_id);
      } catch (err) {
        if (err instanceof ProviderError && err.delivery === 'none' && err.kind === 'rejected') {
          await gap({ kind: 'payment_missing', ref: `payment:${row.id}`, details: { status: err.status } });
        } else if (!(err instanceof ProviderError) && !(err instanceof PaymentError)) throw err;
        continue;
      }
      if (gp.amountPaise !== Number(row.amount_paise) || !['captured', 'refunded'].includes(gp.status)) {
        await gap({ kind: 'amount_mismatch', ref: `payment:${row.id}`, details: { expectedPaise: Number(row.amount_paise), gatewayPaise: Number(gp.amountPaise) || 0, gatewayStatus: String(gp.status ?? '').slice(0, 20) } });
      } else if (Number(gp.amountRefundedPaise ?? 0) !== Number(row.refunded_paise)) {
        await gap({ kind: 'refund_mismatch', ref: `payment:${row.id}`, details: { oursPaise: Number(row.refunded_paise), gatewayPaise: Number(gp.amountRefundedPaise) || 0 } });
      }
    }

    // Statement lines a capture should have written: written now (they are keyed, so this is harmless).
    const missing = await db.query(
      `SELECT p.* FROM payments p WHERE p.tenant_id = $1 AND p.status = 'captured'
         AND NOT EXISTS (SELECT 1 FROM settlement_lines l WHERE l.tenant_id = p.tenant_id AND l.kind = 'sale' AND l.ref = 'payment:' || p.id)
       ORDER BY p.id LIMIT 500`,
      [tenantId()],
    );
    for (const row of missing) {
      await db.tx((t) => service.writeCaptureLines(t, row));
      repaired++;
    }

    // Route: a captured payment whose transfer never reached the seller in a day, or failed.
    const transfers = await db.query(
      `SELECT id, transfer_status FROM payments WHERE tenant_id = $1 AND mode = 'managed' AND status = 'captured'
         AND (transfer_status = 'failed' OR (transfer_status IN ('none', 'created') AND captured_at < now() - interval '1 day'))
       ORDER BY id LIMIT 500`,
      [tenantId()],
    );
    for (const row of transfers) {
      await gap({ kind: row.transfer_status === 'failed' ? 'transfer_failed' : 'transfer_missing', ref: `payment:${row.id}`, details: { transfer: row.transfer_status } });
    }

    // Refunds still with the gateway after a day, and managed refunds whose transfer was not taken back.
    const refunds = await db.query(
      `SELECT id, status, reversal_status FROM refunds WHERE tenant_id = $1 AND created_at < now() - interval '1 day' AND created_at > now() - interval '30 days'
         AND (status = 'requested' OR (status = 'processed' AND reversal_status IN ('pending', 'failed', 'recover')))
       ORDER BY id LIMIT 500`,
      [tenantId()],
    );
    for (const row of refunds) await gap({ kind: 'refund_mismatch', ref: `refund:${row.id}`, details: { status: row.status, reversal: row.reversal_status } });

    if (gaps) {
      await raiseAlert(db, { kind: 'payment.reconciliation', audience: 'ops', severity: 'warning', message: `The daily payment match found ${gaps} thing${gaps === 1 ? '' : 's'} to check.`, target: 'reconciliation', dedupeKey: `reconcile:${new Date().toISOString().slice(0, 10)}` });
    }
    return { checked, gaps, repaired };
  }

  async function daily() {
    const businesses = await platformDb.query(
      `SELECT DISTINCT tenant_id FROM payments WHERE provider IN ('razorpay', 'cod') AND status = 'captured' AND (captured_at > now() - interval '3 days' OR (mode = 'managed' AND transfer_status IN ('none', 'created', 'failed')))
       UNION SELECT DISTINCT tenant_id FROM refunds WHERE created_at > now() - interval '30 days' AND (status = 'requested' OR reversal_status IN ('pending', 'failed', 'recover'))`,
    );
    const results = [];
    for (const { tenant_id: tid } of businesses) {
      try {
        results.push({ tenantId: tid, ...(await withTenant(tid, reconcileBusiness)) });
      } catch (err) {
        reportError(err, { msg: 'payments.reconcile_failed', tenantId: tid });
      }
    }
    return results;
  }

  return { checkPayment, pendingCheck, reconcileBusiness, daily };
}

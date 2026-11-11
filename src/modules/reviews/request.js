import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { esc } from '../../views/html.js';
import { buyerBaseUrl } from '../admin-api/urls.js';
import { consentLinks } from '../consent/index.js';
import { REVIEWS_FEATURE } from './repo.js';

/**
 * The review request (PRD 9.19): after a delivery, one message per channel asking how the order was, as marketing, through
 * the shopper-message gate only (ctx.shopperMessages). So it goes only on a channel the shopper said yes to for marketing,
 * never between 9 pm and 9 am (it waits instead), and carries the seller's brand only. The link is the product's own page,
 * direct, on the business's address.
 *
 * order.delivered queues it (REVIEW_REQUEST_JOB) a while later, so the parcel has been opened. order_alerts holds one row per
 * order and channel for the event 'review_request': that key is what makes it at most once, however often the event or the
 * job runs. The row is written before the send and finished after, never left 'queued' with a time, so no other sender's
 * retry ever picks it up; a send that may or may not have happened is never repeated (the gate's own rule).
 */
export const REVIEW_REQUEST_JOB = 'reviews.request';
export const REVIEW_REQUEST_DELAY_MS = 2 * 24 * 3_600_000;
const EVENT = 'review_request';

export function reviewRequests(ctx) {
  const { db, platform } = ctx;

  async function queue(orderId) {
    const delayMs = Number.isFinite(ctx.config?.reviewRequestDelayMs) ? ctx.config.reviewRequestDelayMs : REVIEW_REQUEST_DELAY_MS;
    await platform.queue.enqueue(REVIEW_REQUEST_JOB, { orderId }, { tenantId: tenantId(), delayMs, dedupeKey: `review-request:${tenantId()}:${orderId}` });
  }

  /** Claims the order and channel. False when another run already has it. */
  async function claim(orderId, channel) {
    const [row] = await db.query(
      `INSERT INTO order_alerts (tenant_id, order_id, event, channel, status, attempts) VALUES ($1, $2, '${EVENT}', $3, 'queued', 1)
       ON CONFLICT (tenant_id, order_id, event, channel) DO NOTHING RETURNING id`,
      [tenantId(), orderId, channel],
    );
    return row?.id ?? null;
  }

  async function finish(id, result) {
    const status = { sent: 'sent', skipped: 'skipped', failed: 'failed' }[result.outcome] ?? 'failed';
    await db.query(
      `UPDATE order_alerts SET status = $3, skip_reason = $4, error_code = $5, provider_message_id = $6, sent_at = CASE WHEN $3 = 'sent' THEN now() END, next_attempt_at = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), id, status, status === 'skipped' ? String(result.reason ?? '').slice(0, 40) : '', status === 'failed' ? String(result.reason ?? '').slice(0, 80) : '', result.messageId ?? null],
    );
  }

  function message(channel, { order, product, store, link, unsubscribeUrl }) {
    const to = { shopperId: order.shopper_id ?? undefined, phone: order.phone || undefined, email: order.email || undefined };
    if (channel === 'whatsapp') {
      return { channel, purpose: 'marketing', to, orderId: order.id, template: { purpose: EVENT, params: [store, product.name, link] } };
    }
    const subject = `How is your ${product.name}?`;
    const text = `Thank you for shopping with ${store}. How is your ${product.name}? Tell other buyers what you think: ${link}\n\nTo stop these emails: ${unsubscribeUrl}`;
    const htmlBody = `<p>Thank you for shopping with ${esc(store)}.</p><p>How is your ${esc(product.name)}? <a href="${esc(link)}">Tell other buyers what you think</a>.</p>`
      + `<p style="font-size:12px;color:#666"><a href="${esc(unsubscribeUrl)}">Stop these emails</a></p>`;
    return { channel, purpose: 'marketing', to, orderId: order.id, email: { subject, html: htmlBody, text, unsubscribeUrl }, dedupeKey: `review-request-${tenantId()}-${order.id}` };
  }

  /** The job: asks once per channel, if there is still something on the order to review. */
  async function send(orderId) {
    if (!(await ctx.repos.entitlements.can(REVIEWS_FEATURE))) return { sent: 0 };
    const [order] = await db.query('SELECT id, shopper_id, phone, email, fulfilment_status FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
    if (!order || order.fulfilment_status !== 'delivered') return { sent: 0 };
    const [product] = await db.query(
      `SELECT p.id, p.name, p.slug FROM order_items i JOIN products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id
       WHERE i.tenant_id = $1 AND i.order_id = $2 AND p.active
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.tenant_id = i.tenant_id AND r.order_id = i.order_id AND r.product_id = i.product_id)
       ORDER BY i.price_paise * i.qty DESC, i.id LIMIT 1`,
      [tenantId(), orderId],
    );
    if (!product) return { sent: 0 };
    const tenant = await ctx.repos.tenants.get(tenantId());
    const settings = await ctx.repos.settings.getAll();
    const store = String(settings.store_name || tenant?.name || '').slice(0, 80);
    const base = tenant ? buyerBaseUrl(tenant, ctx.config) : '';
    if (!base) return { sent: 0 };
    const link = `${base}/p/${encodeURIComponent(product.slug)}`;
    let sent = 0;
    for (const channel of ['whatsapp', 'email']) {
      if (channel === 'whatsapp' ? !order.phone : !order.email) continue;
      const id = await claim(orderId, channel);
      if (!id) continue;
      let result;
      try {
        const unsubscribeUrl = channel === 'email' ? consentLinks(ctx).unsubscribeUrl({ origin: base, shopperId: order.shopper_id ?? undefined, email: order.email, channel }) : '';
        result = await ctx.shopperMessages.send(message(channel, { order, product, store, link, unsubscribeUrl }));
      } catch (err) {
        reportError(err, { msg: 'reviews.request_failed', orderId, channel });
        result = { outcome: 'failed', reason: 'error' };
      }
      if (result.outcome === 'deferred') {
        // Quiet hours: let go of the claim and ask again when they end.
        await db.query('DELETE FROM order_alerts WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
        const delayMs = Math.max(60_000, new Date(result.until).getTime() - Date.now());
        await platform.queue.enqueue(REVIEW_REQUEST_JOB, { orderId }, { tenantId: tenantId(), delayMs, dedupeKey: `review-request:${tenantId()}:${orderId}:${new Date(result.until).getTime()}` });
        continue;
      }
      await finish(id, result);
      if (result.outcome === 'sent') sent++;
      log.info('reviews.request', { orderId, channel, outcome: result.outcome, reason: result.reason });
    }
    return { sent };
  }

  return { queue, send };
}

import { ApiError } from '../../contracts/api/errors.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { consentLinks } from '../consent/index.js';
import { businessOf } from './business.js';
import { orderMessage } from './messages.js';

/**
 * Order alerts to shoppers (PRD 9.16): one row per order event and channel in order_alerts, whose unique key is what makes
 * "sent once per channel" hold however many times an event arrives (S-54). Every send goes through ctx.shopperMessages,
 * which asks the shopper's consent for order updates on that channel, checks the WhatsApp template's review and the
 * business's brand, and never sends twice on a guess.
 *
 * Which order events speak (a prepaid order says nothing until it is paid, so nobody hears "order placed" for an order
 * whose payment never went through):
 *   placed     order.confirmed of a cash-on-delivery or part-advance order: it is going ahead
 *   paid       order.paid from unpaid: a prepaid order's payment arrived (money collected at the door says nothing)
 *   shipped    order.shipped           delivered  order.delivered
 *   cancelled  order.cancelled of an order that had gone ahead (an unpaid order that lapses says nothing)
 *   refunded   order.refunded or order.partially_refunded: the first refund
 *
 * A row's life: queued -> sent -> delivered (WhatsApp's delivery report), or skipped with a reason ('off', 'no_consent',
 * 'template_pending' (S-53), 'no_channel', 'no_address'), or failed. A failure WhatsApp or the mail service says may be
 * retried is tried again with backoff, MAX_ATTEMPTS times in all, then shows as failed in the admin. A send whose answer was
 * lost is failed at once and never repeated on a guess (email repeats only with its idempotency key, which the provider
 * answers with the same message).
 *
 * Claiming a row (attempts + 1, a five-minute lease, error_code 'in_flight') is one statement, so two workers never send the
 * same row. A row found still 'in_flight' after its lease is one whose sender died mid-send: WhatsApp may have taken it, so
 * it is failed as 'unknown_delivery'; an email is sent again with the same key.
 */
export const MAX_ATTEMPTS = 5;
const LEASE = "interval '5 minutes'";
const BACKOFF_SECONDS = [60, 300, 1800, 7200];
const CHANNELS = Object.freeze(['whatsapp', 'email']);
const ORDER_COLUMNS = 'id, order_number, public_token, customer_name, phone, email, shopper_id, total_paise, refunded_paise, flow, payment_mode, confirmed_at, erased_at';

/** The alert an order event makes, or null for none. `order` is the row as it is now. */
export function alertKindFor(event, order) {
  if (!order || order.flow !== 'checkout') return null;
  switch (event.type) {
    case 'order.confirmed': return order.payment_mode === 'prepaid' ? null : 'placed';
    case 'order.paid': return event.from === 'unpaid' ? 'paid' : null;
    case 'order.shipped': return 'shipped';
    case 'order.delivered': return 'delivered';
    case 'order.cancelled': return order.confirmed_at ? 'cancelled' : null;
    case 'order.refunded':
    case 'order.partially_refunded': return 'refunded';
    default: return null;
  }
}
export const ALERT_ORDER_EVENTS = Object.freeze(['order.confirmed', 'order.paid', 'order.shipped', 'order.delivered', 'order.cancelled', 'order.refunded', 'order.partially_refunded']);

/** The gate's reason as the table's skip_reason. */
const skipReasonOf = (reason) => ({ no_consent: 'no_consent', consent_unknown: 'no_consent', 'content.platform_name': 'platform_name', 'content.no_unsubscribe': 'invalid' })[reason] ?? String(reason ?? '').slice(0, 40);

const toAlert = (r) => ({
  id: Number(r.id), orderId: r.order_id, orderNumber: r.order_number ?? '', event: r.event, channel: r.channel, status: r.status,
  skipReason: r.skip_reason, attempts: r.attempts, createdAt: r.created_at, sentAt: r.sent_at ?? null,
});

export function createOrderAlerts(ctx, settings) {
  const { db, repos, shopperMessages } = ctx;
  const platformDb = db.platform ?? db;

  async function loadOrder(orderId) {
    const [order] = await db.query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE tenant_id = $1 AND id = $2`, [tenantId(), orderId]);
    return order ?? null;
  }

  /** The order event listener: works out the alert, if any, and raises it. */
  async function onOrderEvent(event) {
    const order = await loadOrder(event.orderId);
    const kind = alertKindFor(event, order);
    if (!kind) return null;
    return raise(order, kind, event.id);
  }

  /**
   * Makes the alert's rows, one per channel, and sends the new ones. A row that already exists (the event came again) is
   * left alone, so nothing goes twice. Returns the rows as they ended up.
   */
  async function raise(order, kind, sourceEventId = null) {
    const s = await settings.row();
    const included = await repos.entitlements.can('store.order_alerts').catch(() => false);
    const eventOn = included && s.events.includes(kind);
    const fresh = {};
    for (const channel of CHANNELS) {
      const on = eventOn && s[channel];
      const [row] = await db.query(
        `INSERT INTO order_alerts (tenant_id, order_id, event, channel, status, skip_reason, next_attempt_at, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'queued' THEN now() END, $7)
         ON CONFLICT (tenant_id, order_id, event, channel) DO NOTHING RETURNING id, status`,
        [tenantId(), order.id, kind, channel, on ? 'queued' : 'skipped', on ? '' : 'off', sourceEventId],
      );
      if (row) fresh[channel] = row;
    }
    const outcome = {};
    if (fresh.whatsapp?.status === 'queued') outcome.whatsapp = await attempt(fresh.whatsapp.id);
    // S-53: a WhatsApp template still in review falls back to email, even where the owner had email alerts off.
    if (fresh.email?.status === 'skipped' && eventOn && outcome.whatsapp?.skip_reason === 'template_pending') {
      await db.query(`UPDATE order_alerts SET status = 'queued', skip_reason = '', next_attempt_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'skipped' AND skip_reason = 'off'`, [tenantId(), fresh.email.id]);
      fresh.email.status = 'queued';
    }
    if (fresh.email?.status === 'queued') outcome.email = await attempt(fresh.email.id);
    return outcome;
  }

  /** Takes the row for sending, or null when it isn't due or another worker has it. `was` is its error_code before. */
  async function claim(id) {
    const [row] = await db.query(
      `WITH due AS (
         SELECT id, error_code FROM order_alerts
         WHERE tenant_id = $1 AND id = $2 AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         FOR UPDATE SKIP LOCKED)
       UPDATE order_alerts a SET attempts = a.attempts + 1, next_attempt_at = now() + ${LEASE}, error_code = 'in_flight'
       FROM due WHERE a.tenant_id = $1 AND a.id = due.id
       RETURNING a.*, due.error_code AS was`,
      [tenantId(), id],
    );
    return row ?? null;
  }

  async function finish(id, fields) {
    const names = Object.keys(fields);
    const [row] = await db.query(
      `UPDATE order_alerts SET ${names.map((n, i) => `${n} = $${i + 3}`).join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId(), id, ...names.map((n) => fields[n])],
    );
    return row;
  }

  /** Sends one queued row if it is due. Returns the row as it ended up, or null when it wasn't taken. */
  async function attempt(id) {
    const row = await claim(id);
    if (!row) return null;
    if (row.was === 'in_flight' && row.channel === 'whatsapp') {
      log.warn('order_alert.unknown_delivery', { alert: Number(row.id), order: row.order_id });
      return finish(row.id, { status: 'failed', error_code: 'unknown_delivery', next_attempt_at: null });
    }
    let result;
    try {
      result = await send(row);
    } catch (err) {
      // Our own fault (the database, a bad row): put it back for the next try with nothing sent.
      reportError(err, { msg: 'order_alert.send_error', alert: Number(row.id) });
      return finish(row.id, retryOrFail(row, 'error'));
    }
    return record(row, result);
  }

  async function send(row) {
    const order = await loadOrder(row.order_id);
    if (!order || order.erased_at) return { outcome: 'skipped', reason: 'no_address' };
    const business = await businessOf(ctx);
    const items = row.channel === 'email' ? await db.query('SELECT name, option_value, qty FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenantId(), order.id]) : [];
    let unsubscribeUrl = '';
    if (row.channel === 'email' && business.base && order.email) {
      try {
        unsubscribeUrl = consentLinks(ctx).unsubscribeUrl({ origin: business.base, shopperId: order.shopper_id ?? undefined, email: order.email, channel: 'email', purpose: 'order_updates' });
      } catch (err) {
        reportError(err, { msg: 'order_alert.unsubscribe_link_failed' });
      }
    }
    const message = orderMessage({ channel: row.channel, event: row.event, order, items, business, unsubscribeUrl });
    message.dedupeKey = `order-alert-${tenantId()}-${row.id}`;
    return shopperMessages.send(message);
  }

  function retryOrFail(row, code) {
    if (row.attempts >= MAX_ATTEMPTS) return { status: 'failed', error_code: String(code).slice(0, 80), next_attempt_at: null };
    const wait = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length) - 1] ?? BACKOFF_SECONDS.at(-1);
    return { status: 'queued', error_code: String(code).slice(0, 80), next_attempt_at: new Date(Date.now() + wait * 1000) };
  }

  async function record(row, result) {
    const ids = { alert: Number(row.id), order: row.order_id, channel: row.channel, event: row.event };
    if (result.outcome === 'sent') {
      log.info('order_alert.sent', ids);
      try {
        return await finish(row.id, { status: 'sent', sent_at: new Date(), provider_message_id: result.messageId ? String(result.messageId).slice(0, 120) : null, error_code: '', next_attempt_at: null });
      } catch (err) {
        // The same message id twice (a provider answering a repeat with the first message) still means it was sent.
        if (err?.code !== '23505') throw err;
        return finish(row.id, { status: 'sent', sent_at: new Date(), error_code: '', next_attempt_at: null });
      }
    }
    if (result.outcome === 'skipped') {
      log.info('order_alert.skipped', { ...ids, reason: result.reason });
      return finish(row.id, { status: 'skipped', skip_reason: skipReasonOf(result.reason), error_code: '', next_attempt_at: null });
    }
    if (result.outcome === 'deferred') return finish(row.id, { status: 'queued', error_code: '', next_attempt_at: result.until ?? new Date(Date.now() + 3_600_000) });
    const code = result.reason === 'unknown_delivery' ? 'unknown_delivery' : `${result.reason ?? 'provider'}:${result.kind ?? ''}:${result.code ?? ''}`;
    const next = result.retryable ? retryOrFail(row, code) : { status: 'failed', error_code: code.slice(0, 80), next_attempt_at: null };
    log.warn('order_alert.not_sent', { ...ids, status: next.status, reason: result.reason, kind: result.kind ?? null });
    const done = await finish(row.id, next);
    if (done.status === 'failed') {
      await repos.alerts.raise({
        kind: 'order_alerts.failed',
        severity: 'warning',
        message: 'Some order messages to your customers could not be sent. See Order alerts to try them again.',
        target: 'order_alerts',
        dedupeKey: `order-alerts-failed:${new Date().toISOString().slice(0, 10)}`,
      }).catch((err) => reportError(err, { msg: 'order_alert.owner_alert_failed' }));
    }
    return done;
  }

  /** Every row that is due, across businesses: retries after backoff, deferred ones, and any a crash left behind. */
  async function sweep({ limit = 200 } = {}) {
    const due = await platformDb.query(
      `SELECT tenant_id, id FROM order_alerts WHERE status = 'queued' AND next_attempt_at <= now() ORDER BY next_attempt_at, id LIMIT $1`,
      [limit],
    );
    let sent = 0;
    for (const { tenant_id: tenant, id } of due) {
      try {
        const done = await withTenant(tenant, () => attempt(id));
        if (done?.status === 'sent') sent++;
      } catch (err) {
        reportError(err, { msg: 'order_alert.sweep_failed', alert: Number(id) });
      }
    }
    return { due: due.length, sent };
  }

  async function list({ status = 'all', orderId, cursor, limit = 25 }) {
    const where = ['a.tenant_id = $1'];
    const params = [tenantId()];
    if (status === 'sent') where.push(`a.status IN ('sent', 'delivered')`);
    else if (status !== 'all') {
      params.push(status);
      where.push(`a.status = $${params.length}`);
    }
    if (orderId) {
      params.push(orderId);
      where.push(`a.order_id = $${params.length}`);
    }
    if (cursor) {
      if (!/^[1-9][0-9]{0,17}$/.test(cursor)) throw new ApiError('validation_failed', 'That page link has expired. Go back to the first page.', { fields: { cursor: 'Invalid cursor' } });
      params.push(cursor);
      where.push(`a.id < $${params.length}::bigint`);
    }
    params.push(limit + 1);
    const rows = await db.query(
      `SELECT a.*, o.order_number FROM order_alerts a JOIN orders o ON o.tenant_id = a.tenant_id AND o.id = a.order_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.slice(0, limit).map(toAlert);
    return { items, nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
  }

  async function one(id) {
    const [row] = await db.query(
      `SELECT a.*, o.order_number FROM order_alerts a JOIN orders o ON o.tenant_id = a.tenant_id AND o.id = a.order_id WHERE a.tenant_id = $1 AND a.id = $2`,
      [tenantId(), id],
    );
    return row ?? null;
  }

  /** The owner asks for a failed or skipped alert to go again: it goes through the gate like the first time. */
  async function retry(id, actor) {
    const row = await one(id);
    if (!row) return null;
    if (['sent', 'delivered'].includes(row.status)) throw new ApiError('conflict', 'This message was already sent.');
    if (row.status === 'queued') throw new ApiError('conflict', 'This message is already waiting to be sent.');
    await db.query(
      `UPDATE order_alerts SET status = 'queued', skip_reason = '', error_code = '', attempts = 0, next_attempt_at = now() WHERE tenant_id = $1 AND id = $2 AND status IN ('failed', 'skipped')`,
      [tenantId(), id],
    );
    log.info('order_alert.retry', { alert: Number(id), actor });
    await attempt(id);
    return toAlert(await one(id));
  }

  return { onOrderEvent, raise, attempt, sweep, list, retry, one: async (id) => { const r = await one(id); return r ? toAlert(r) : null; } };
}

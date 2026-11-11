import { INDIAN_STATES } from '../../contracts/orders.js';
import { ProviderError } from '../../adapters/http.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';

/**
 * What goes from here to Shopify (PRD 9.11).
 *
 * Orders (both modes, S-37): an order that goes ahead (order.confirmed, or order.reinstated after a late payment) gets one
 * shopify_order_pushes row, its primary key the order, so the event arriving twice is one push. The push creates the
 * order in Shopify with the store's order number in its idempotency key, so repeating a push whose answer was lost (a
 * timeout, a dropped connection, a 5xx) is the same Shopify order, and Shopify takes its stock down once. A push Shopify
 * refuses for a while (429, 5xx) waits and tries again with backoff; one it refuses outright (a variant it doesn't know)
 * fails and the owner is told. An order cancelled before it was pushed is not pushed. Only lines linked to Shopify go.
 *
 * Claiming a row is one statement (attempts + 1 and a two-minute lease on next_attempt_at), so two workers never push the
 * same order at once; a lease that runs out with nothing recorded is simply pushed again, with the same key.
 *
 * Two-way mode only: a price the owner changed here since the last sync is sent to Shopify (latest wins; products.js keeps
 * the clashes). Stock moves the other way only: Shopify's count is the one both sides sell from.
 */
export const MAX_PUSH_ATTEMPTS = 12;
const LEASE = "interval '2 minutes'";
const backoffSeconds = (attempt) => Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1)); // 30 s, 1 min, 2 min, 4 min ... an hour

export function createPushes(ctx, { connection, products }) {
  const { db, repos } = ctx;
  const platformDb = db.platform ?? db;

  /** The order event listener: an order that goes ahead is queued for Shopify, and pushed straight away. */
  async function onOrderConfirmed(event) {
    const conn = await connection.row();
    if (!conn || conn.status === 'reconnect') return;
    const [order] = await db.query('SELECT id, flow FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), event.orderId]);
    if (!order || order.flow !== 'checkout') return;
    const [made] = await db.query(
      // An order brought back after it was cancelled before its push (a late payment) is queued again.
      `INSERT INTO shopify_order_pushes (tenant_id, order_id) VALUES ($1, $2)
       ON CONFLICT (tenant_id, order_id) DO UPDATE SET status = 'pending', next_attempt_at = now(), last_error = ''
         WHERE shopify_order_pushes.status = 'skipped' AND shopify_order_pushes.last_error = 'cancelled'
       RETURNING order_id`,
      [tenantId(), order.id],
    );
    if (made && conn.status === 'active') await pushOne(order.id);
  }

  /** order.cancelled: an order not yet in Shopify stays out of it. One already there is left for the owner to cancel there. */
  async function onOrderCancelled(event) {
    await db.query(`UPDATE shopify_order_pushes SET status = 'skipped', last_error = 'cancelled' WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending'`, [tenantId(), event.orderId]);
  }

  async function claim(orderId) {
    const [row] = await db.query(
      `WITH due AS (SELECT order_id FROM shopify_order_pushes WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending' AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED)
       UPDATE shopify_order_pushes p SET attempts = p.attempts + 1, next_attempt_at = now() + ${LEASE}
       FROM due WHERE p.tenant_id = $1 AND p.order_id = due.order_id RETURNING p.*`,
      [tenantId(), orderId],
    );
    return row ?? null;
  }

  const finish = (orderId, fields) => {
    const names = Object.keys(fields);
    return db.query(`UPDATE shopify_order_pushes SET ${names.map((n, i) => `${n} = $${i + 3}`).join(', ')} WHERE tenant_id = $1 AND order_id = $2`, [tenantId(), orderId, ...names.map((n) => fields[n])]);
  };

  /** The Shopify variant of each order line, or null for a line not linked to Shopify. */
  async function shopifyLines(orderId) {
    const items = await db.query(
      `SELECT oi.product_id, oi.variant_id, oi.qty, oi.price_paise, (v.id IS NOT NULL AND v.option_values <> '{}') AS has_options
       FROM order_items oi LEFT JOIN product_variants v ON v.tenant_id = oi.tenant_id AND v.id = oi.variant_id
       WHERE oi.tenant_id = $1 AND oi.order_id = $2 ORDER BY oi.id`,
      [tenantId(), orderId],
    );
    const lines = [];
    for (const item of items) {
      if (!item.product_id) continue;
      const local = item.has_options ? item.variant_id : -item.product_id;
      const [link] = await db.query(`SELECT shopify_id FROM shopify_links WHERE tenant_id = $1 AND kind = 'variant' AND local_id = $2`, [tenantId(), local]);
      if (link) lines.push({ variantId: Number(link.shopify_id), qty: item.qty, pricePaise: Number(item.price_paise) });
    }
    return lines;
  }

  function shipToOf(order) {
    const a = order.shipping_address;
    if (!a || typeof a !== 'object') return null;
    return { name: a.name ?? order.customer_name, line1: a.line1 ?? '', line2: [a.line2, a.landmark].filter(Boolean).join(', '), city: a.city ?? '', state: INDIAN_STATES[a.stateCode] ?? a.state ?? '', pincode: a.pincode ?? '', phone: a.phone ?? '' };
  }

  /** Pushes one order now, if it is due and nobody else has it. Returns the row's status after. */
  async function pushOne(orderId) {
    const row = await claim(orderId);
    if (!row) return null;
    const conn = await connection.active();
    if (!conn) {
      await finish(orderId, { next_attempt_at: new Date(Date.now() + 3_600_000), last_error: 'not_connected' });
      return 'pending';
    }
    const [order] = await db.query(
      `SELECT id, order_number, customer_name, email, shipping_address, total_paise, payment_status, fulfilment_status FROM orders WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), orderId],
    );
    if (!order) return 'gone';
    if (order.fulfilment_status === 'cancelled') {
      await finish(orderId, { status: 'skipped', last_error: 'cancelled' });
      return 'skipped';
    }
    const lines = await shopifyLines(orderId);
    if (!lines.length) {
      await finish(orderId, { status: 'skipped', last_error: 'no_shopify_items' });
      return 'skipped';
    }
    try {
      const made = await conn.client.createOrder({
        orderNumber: order.order_number,
        lines,
        shipTo: shipToOf(order),
        email: order.email ?? '',
        totalPaise: lines.reduce((sum, l) => sum + l.pricePaise * l.qty, 0),
        paid: ['paid', 'partially_refunded', 'refunded'].includes(order.payment_status),
        idempotencyKey: `order-${tenantId()}-${order.order_number}`,
      });
      const shopifyId = /^[0-9]{1,20}$/.test(String(made.id)) ? String(made.id) : null;
      await finish(orderId, { status: 'pushed', shopify_order_id: shopifyId, pushed_at: new Date(), last_error: '' });
      if (shopifyId) await products.setLink('order', orderId, shopifyId);
      log.info('shopify.order_pushed', { orderId, attempts: row.attempts });
      return 'pushed';
    } catch (err) {
      if (!(err instanceof ProviderError)) {
        reportError(err, { msg: 'shopify.push_error', orderId });
        await finish(orderId, { next_attempt_at: new Date(Date.now() + backoffSeconds(row.attempts) * 1000), last_error: 'error' });
        return 'pending';
      }
      const why = `${err.kind}:${err.status}:${err.code}`.slice(0, 200);
      log.warn('shopify.push_failed', { orderId, kind: err.kind, status: err.status, attempt: row.attempts, delivery: err.delivery });
      if (err.kind === 'auth') {
        await connection.needsReconnect('auth');
        await finish(orderId, { next_attempt_at: new Date(Date.now() + 3_600_000), last_error: why });
        return 'pending';
      }
      if (err.retryable && row.attempts < MAX_PUSH_ATTEMPTS) {
        await finish(orderId, { next_attempt_at: new Date(Date.now() + backoffSeconds(row.attempts) * 1000), last_error: why });
        return 'pending';
      }
      await finish(orderId, { status: 'failed', last_error: why });
      await repos.alerts.raise({
        kind: 'shopify.order_not_pushed', severity: 'warning',
        message: `Order ${order.order_number} could not be added to your Shopify store. Add it there by hand so your Shopify stock stays right.`,
        target: `order:${orderId}`, dedupeKey: `shopify-push-failed:${orderId}`,
      }).catch((alertErr) => reportError(alertErr, { msg: 'shopify.alert_failed' }));
      return 'failed';
    }
  }

  /** Every push that is due, across businesses. */
  async function sweep({ limit = 100 } = {}) {
    const due = await platformDb.query(
      `SELECT p.tenant_id, p.order_id FROM shopify_order_pushes p JOIN shopify_connections c ON c.tenant_id = p.tenant_id AND c.status = 'active'
       WHERE p.status = 'pending' AND p.next_attempt_at <= now() ORDER BY p.next_attempt_at LIMIT $1`,
      [limit],
    );
    let pushed = 0;
    for (const { tenant_id: tenant, order_id: orderId } of due) {
      try {
        if ((await withTenant(tenant, () => pushOne(orderId))) === 'pushed') pushed++;
      } catch (err) {
        reportError(err, { msg: 'shopify.push_sweep_failed', orderId });
      }
    }
    return { due: due.length, pushed };
  }

  /** The reconcile gives a push that failed for a reason that may have passed (Shopify was down, the limit) one more day of tries. */
  async function retryFailed() {
    await db.query(
      `UPDATE shopify_order_pushes SET status = 'pending', attempts = 0, next_attempt_at = now()
       WHERE tenant_id = $1 AND status = 'failed' AND split_part(last_error, ':', 1) IN ('timeout', 'network', 'throttled', 'server')`,
      [tenantId()],
    );
  }

  /** Two-way mode: prices the owner changed here since the last sync go to Shopify. */
  async function pushPrices(conn) {
    if (conn.mode !== 'two_way') return 0;
    const changed = await db.query(
      `SELECT l.local_id AS product_id, l.shopify_id, p.updated_at, p.price_paise, p.mrp_paise FROM shopify_links l
       JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.local_id
       WHERE l.tenant_id = $1 AND l.kind = 'product' AND (l.local_updated_at IS NULL OR p.updated_at > l.local_updated_at) LIMIT 50`,
      [tenantId()],
    );
    let sent = 0;
    for (const p of changed) {
      const variants = await db.query(
        `SELECT l.local_id, l.shopify_id, v.price_paise AS v_price, v.mrp_paise AS v_mrp FROM shopify_links l
         LEFT JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.local_id
         WHERE l.tenant_id = $1 AND l.kind = 'variant' AND (l.local_id = $2 OR v.product_id = $3)`,
        [tenantId(), -Number(p.product_id), Number(p.product_id)],
      );
      try {
        for (const v of variants) {
          const own = Number(v.local_id) < 0;
          await conn.client.updateVariant(v.shopify_id, {
            pricePaise: Number(own ? p.price_paise : v.v_price),
            compareAtPricePaise: (own ? p.mrp_paise : v.v_mrp) === null ? null : Number(own ? p.mrp_paise : v.v_mrp),
          });
        }
        await db.query(`UPDATE shopify_links SET local_updated_at = $3, synced_at = now() WHERE tenant_id = $1 AND kind = 'product' AND local_id = $2`, [tenantId(), p.product_id, p.updated_at]);
        sent++;
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        log.warn('shopify.price_push_failed', { productId: Number(p.product_id), kind: err.kind, status: err.status });
        if (err.kind === 'auth') {
          await connection.needsReconnect('auth');
          break;
        }
      }
    }
    return sent;
  }

  return { onOrderConfirmed, onOrderCancelled, pushOne, sweep, retryFailed, pushPrices };
}

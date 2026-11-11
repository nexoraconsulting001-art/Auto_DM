import { ApiError } from '../../contracts/api/errors.js';
import { STORE_PROVIDER_PATHS } from '../../contracts/store-routes.js';
import { ProviderError } from '../../adapters/http.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { createConnection } from './connection.js';
import { createProductSync } from './products.js';
import { createPushes } from './push.js';
import { createShopifyWebhook } from './webhook.js';

/**
 * PRD 9.11: Shopify sync, for a business whose catalogue lives in Shopify. Each business connects its own Shopify app.
 *   mode 'source'   Shopify is the source: products, prices and stock come from it, and orders placed here are pushed to it
 *   mode 'two_way'  as source, and a price the owner changes here goes to Shopify; the later change wins, clashes are logged
 *
 * Tables (migration 414): shopify_connections, shopify_links, shopify_order_pushes, shopify_conflicts, and
 * provider_webhook_events for shopify.
 * Console routes (src/contracts/api/store.js): shopify.get, connect, setMode, disconnect, reconcile, conflicts.
 * Provider route, in beforeTenant: POST /webhooks/shopify (webhook.js): HMAC-verified, deduped by webhook id (S-38).
 * Order events: order.confirmed and order.reinstated queue the order for Shopify and push it (push.js, S-37);
 * order.cancelled keeps an order not yet pushed out of Shopify.
 * Jobs: shopify-sync.push every minute (webhooks left over, pushes due, two-way prices), shopify-sync.reconcile on demand
 * (the first sync and the console's "sync now"), shopify-sync.nightly once a day (what a missed webhook would have said).
 * Every Admin call keeps to Shopify's per-shop limit (connection.js). Nothing here talks to Shopify while a shopper waits.
 */
export const SHOPIFY_JOBS = Object.freeze({ push: 'shopify-sync.push', reconcile: 'shopify-sync.reconcile', nightly: 'shopify-sync.nightly' });
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const OVERLAP_MS = 60 * MINUTE;

const built = new WeakMap();
export function shopifyFor(ctx) {
  let found = built.get(ctx);
  if (!found) {
    const connection = createConnection(ctx);
    const products = createProductSync(ctx);
    const pushes = createPushes(ctx, { connection, products });
    const webhook = createShopifyWebhook(ctx, { products, connection });
    found = { connection, products, pushes, webhook };
    found.reconcile = (options) => reconcileTenant(ctx, found, options);
    found.conflicts = (query) => conflicts(ctx, query);
    built.set(ctx, found);
  }
  return found;
}

/** One business's reconcile: products changed since the last one (or all), then the pushes and prices waiting. */
async function reconcileTenant(ctx, { connection, products, pushes }, { full = false } = {}) {
  const conn = await connection.active();
  if (!conn) return null;
  const since = full || !conn.lastReconciledAt ? null : new Date(new Date(conn.lastReconciledAt).getTime() - OVERLAP_MS);
  const started = new Date();
  try {
    const counts = await products.reconcile(conn, { since });
    await pushes.retryFailed();
    await pushes.pushPrices(conn);
    await ctx.db.query(`UPDATE shopify_connections SET last_reconciled_at = $2, last_error = '', updated_at = now() WHERE tenant_id = $1`, [tenantId(), started]);
    log.info('shopify.reconciled', { tenantId: tenantId(), full, ...counts });
    return counts;
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    log.warn('shopify.reconcile_failed', { tenantId: tenantId(), kind: err.kind, status: err.status });
    if (err.kind === 'auth') await connection.needsReconnect('auth');
    else await connection.recordError(`reconcile:${err.kind}:${err.status}`);
    return null;
  }
}

async function conflicts(ctx, { cursor, limit = 25 }) {
  if (cursor && !/^[1-9][0-9]{0,17}$/.test(cursor)) throw new ApiError('validation_failed', 'That page link has expired. Go back to the first page.', { fields: { cursor: 'Invalid cursor' } });
  const rows = await ctx.db.query(
    `SELECT * FROM shopify_conflicts WHERE tenant_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`,
    [tenantId(), cursor ?? null, limit + 1],
  );
  const items = rows.slice(0, limit).map((r) => ({
    id: Number(r.id), kind: r.kind, localId: Math.abs(Number(r.local_id)), shopifyId: r.shopify_id, field: r.field, localValue: r.local_value, remoteValue: r.remote_value, winner: r.winner, at: r.created_at,
  }));
  return { items, nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
}

const actorOf = (user) => `user:${user.id}`;

export const shopifySync = {
  name: 'shopify-sync',

  setup(ctx) {
    const { pushes } = shopifyFor(ctx);
    const events = ctx.orderEvents;
    if (!events) return;
    events.on(['order.confirmed', 'order.reinstated'], 'shopify-sync.push-order', (event) => pushes.onOrderConfirmed(event));
    events.on('order.cancelled', 'shopify-sync.skip-cancelled', (event) => pushes.onOrderCancelled(event));
  },

  beforeTenant(app, ctx) {
    const { webhook } = shopifyFor(ctx);
    app.post(STORE_PROVIDER_PATHS.shopify.path, (req, res, next) => webhook.receive(req, res).catch((err) => {
      reportError(err, { msg: 'shopify.webhook_error' });
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on our side.' });
      else next();
    }));
  },

  api: (ctx) => {
    const sync = shopifyFor(ctx);
    return {
      'shopify.get': () => sync.connection.view(),
      'shopify.connect': async ({ body, user }) => {
        if (!(await ctx.repos.entitlements.can('shopify.sync'))) throw new ApiError('forbidden', 'Shopify sync isn’t on your plan.', { reason: 'plan' });
        const view = await sync.connection.connect(body, actorOf(user));
        await queueReconcile(ctx);
        return view;
      },
      'shopify.setMode': ({ body, user }) => sync.connection.setMode(body, actorOf(user)),
      'shopify.disconnect': async ({ user }) => {
        await sync.connection.disconnect(actorOf(user));
      },
      'shopify.reconcile': async () => {
        const view = await sync.connection.view();
        if (!view.connected) throw new ApiError('conflict', 'Connect your Shopify store first.');
        await queueReconcile(ctx);
        return view;
      },
      'shopify.conflicts': ({ query }) => sync.conflicts(query),
    };
  },

  jobs(ctx) {
    const { queue } = ctx.platform;
    const sync = shopifyFor(ctx);
    const platformDb = ctx.db.platform ?? ctx.db;
    queue.work(SHOPIFY_JOBS.reconcile, (job) => sync.reconcile({ full: job.payload?.full !== false }));
    queue.work(SHOPIFY_JOBS.nightly, async () => {
      for (const { tenant_id: tenant } of await platformDb.query(`SELECT tenant_id FROM shopify_connections WHERE status = 'active'`)) {
        await withTenant(tenant, () => sync.reconcile({ full: false })).catch((err) => reportError(err, { msg: 'shopify.nightly_failed', tenantId: tenant }));
      }
    });
    queue.work(SHOPIFY_JOBS.push, async () => {
      await sync.webhook.drain();
      await sync.pushes.sweep();
      for (const { tenant_id: tenant } of await platformDb.query(`SELECT tenant_id FROM shopify_connections WHERE status = 'active' AND mode = 'two_way'`)) {
        await withTenant(tenant, async () => {
          const conn = await sync.connection.active();
          if (conn) await sync.pushes.pushPrices(conn);
        }).catch((err) => reportError(err, { msg: 'shopify.price_push_failed', tenantId: tenant }));
      }
    });
    return async function schedule() {
      await queue.every(SHOPIFY_JOBS.push, MINUTE);
      await queue.every(SHOPIFY_JOBS.nightly, DAY);
    };
  },
};

/** The first sync, or "sync now": one job per business per minute, whoever asks. */
function queueReconcile(ctx) {
  const slot = Math.floor(Date.now() / MINUTE);
  return ctx.platform.queue.enqueue(SHOPIFY_JOBS.reconcile, { full: true }, { tenantId: tenantId(), dedupeKey: `shopify-reconcile:${tenantId()}:${slot}`, maxAttempts: 3, retryInFlight: true });
}

import { notBuilt } from '../not-built.js';

/**
 * PRD 9.11. Not built yet: this folder is the shopify-sync track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): shopify_connections, shopify_links, shopify_order_pushes, shopify_conflicts, and
 * provider_webhook_events for shopify.
 * Provider routes, mounted in beforeTenant: POST /webhooks/shopify.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): order.confirmed makes the shopify_order_pushes row;
 * a job pushes it with the order number as the idempotency key (S-37).
 * ctx.providers.shopify.forShop(...). Webhooks are verified by HMAC and deduped by webhook id (S-38); a nightly
 * reconcile catches what was missed.
 */
export const shopifySync = {
  name: 'shopify-sync',
  api: () => notBuilt(
    'shopify.get',
    'shopify.connect',
    'shopify.setMode',
    'shopify.disconnect',
    'shopify.reconcile',
    'shopify.conflicts',
  ),
};

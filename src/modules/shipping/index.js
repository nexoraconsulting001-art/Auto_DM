import { notBuilt } from '../not-built.js';

/**
 * PRD 9.10. Not built yet: this folder is the shipping track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): shipping_settings, shipments, shipment_events, serviceability_cache, and
 * provider_webhook_events for shiprocket.
 * Buyer routes (src/contracts/store-routes.js): GET /track/:token, GET /api/store/serviceability.
 * Provider routes, mounted in beforeTenant: POST /webhooks/courier.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): shipment.* moves the order: picked_up or in_transit
 * -> shipped, out_for_delivery, delivered, rto_initiated, rto_delivered, always with ifAllowed.
 * ctx.providers.shiprocket. The label’s COD amount is the order’s balance_paise (S-21). The tracking page is the
 * seller’s own (S-78).
 */
export const shipping = {
  name: 'shipping',
  api: () => notBuilt(
    'shippingSettings.get',
    'shippingSettings.update',
    'shipping.serviceability',
    'shipments.forOrder',
    'shipments.create',
    'shipments.get',
    'shipments.cancel',
    'shipments.label',
  ),
};

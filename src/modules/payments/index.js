import { notBuilt } from '../not-built.js';

/**
 * PRD 9.6, 9.7. Not built yet: this folder is the payments track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): payment_settings, payments, settlement_lines, reconciliation_gaps, and
 * provider_webhook_events for razorpay and cashfree.
 * Buyer routes (src/contracts/store-routes.js): POST /api/store/payments/return, POST /api/store/orders/:token/retry.
 * Provider routes, mounted in beforeTenant: POST /webhooks/razorpay, POST /webhooks/razorpay/:key, POST
 * /webhooks/cashfree/:key, GET /oauth/razorpay/callback.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): payment.captured writes the statement lines.
 * ctx.providers.razorpay.forMode(order.gateway_mode). A webhook is verified on the raw bytes, stored in
 * provider_webhook_events (unique provider event id) before the 2xx, then worked from the queue; marking an order
 * paid is changeRow(payments -> captured) and changeOrder({ payment, fulfilment }) in one transaction, with ifAllowed
 * for late and repeated events (S-23, S-24). An event naming another business’s order or account is stored, ignored
 * and flagged security (S-73).
 */
export const payments = {
  name: 'payments',
  api: () => notBuilt(
    'paymentSettings.get',
    'paymentSettings.update',
    'paymentAccount.get',
    'paymentAccount.startLinked',
    'paymentAccount.connectUrl',
    'paymentAccount.setMode',
    'paymentAccount.disconnect',
    'payments.forOrder',
    'settlements.list',
    'settlements.summary',
  ),
};

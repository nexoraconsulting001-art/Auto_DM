import { notBuilt } from '../not-built.js';

/**
 * PRD 9.16. Not built yet: this folder is the order-alerts track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): whatsapp_accounts, whatsapp_templates, alert_settings, order_alerts, and
 * provider_webhook_events for whatsapp.
 * Provider routes, mounted in beforeTenant: POST /webhooks/whatsapp, GET /webhooks/whatsapp.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): order.created, order.paid, order.shipped,
 * order.delivered, order.cancelled and order.refunded each make one order_alerts row per channel (unique per order,
 * event and channel: S-54) and send through ctx.shopperMessages.
 * WhatsApp and email only; there is no SMS (S-96). A template still in review falls back to email and shows "Template
 * pending" (S-53).
 */
export const orderAlerts = {
  name: 'order-alerts',
  api: () => notBuilt(
    'alertSettings.get',
    'alertSettings.update',
    'whatsappAccount.get',
    'whatsappAccount.connect',
    'whatsappAccount.disconnect',
    'whatsappTemplates.all',
    'whatsappTemplates.sync',
    'orderAlerts.list',
    'orderAlerts.retry',
  ),
};

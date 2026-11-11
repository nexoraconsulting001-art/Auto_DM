import { STORE_PROVIDER_PATHS } from '../../contracts/store-routes.js';
import { reportError } from '../../platform/log.js';
import { ALERT_ORDER_EVENTS, createOrderAlerts } from './alerts.js';
import { createAlertSettings } from './settings.js';
import { createWhatsappWebhook } from './webhook.js';

/**
 * PRD 9.16: order alerts to shoppers by WhatsApp and email. There is no SMS (S-96).
 *
 * Tables (migration 409): whatsapp_accounts, whatsapp_templates, alert_settings, order_alerts, and provider_webhook_events
 * for whatsapp.
 * Console routes (src/contracts/api/store.js): alertSettings.*, whatsappAccount.*, whatsappTemplates.*, orderAlerts.*.
 * Provider routes, in beforeTenant: POST /webhooks/whatsapp (delivery reports, STOP replies), GET /webhooks/whatsapp.
 * Order events: order.confirmed, order.paid, order.shipped, order.delivered, order.cancelled, order.refunded and
 * order.partially_refunded, as alerts.js says which of them speak. One order_alerts row per event and channel (S-54), sent
 * through ctx.shopperMessages; a template still in review falls back to email and shows "Template pending" (S-53).
 * Jobs: order-alerts.sweep every minute (retries, deferred sends, anything a crash left, and webhooks left over).
 *
 * For other modules: alertSettingsFor(ctx) is the settings service (the abandoned-cart module reads cart_reminders and the
 * template status through it). The template catalogue, with each template's values in order, is templates.js.
 */
export const ORDER_ALERT_JOBS = Object.freeze({ sweep: 'order-alerts.sweep' });
const MINUTE = 60_000;

const built = new WeakMap();
/** The services of one process's context, made once. */
export function orderAlertsFor(ctx) {
  let found = built.get(ctx);
  if (!found) {
    const settings = createAlertSettings(ctx);
    found = { settings, alerts: createOrderAlerts(ctx, settings), webhook: createWhatsappWebhook(ctx) };
    built.set(ctx, found);
  }
  return found;
}
export const alertSettingsFor = (ctx) => orderAlertsFor(ctx).settings;

const actorOf = (user) => `user:${user.id}`;

export const orderAlerts = {
  name: 'order-alerts',

  setup(ctx) {
    const { alerts } = orderAlertsFor(ctx);
    ctx.orderEvents?.on(ALERT_ORDER_EVENTS, 'order-alerts.send', (event) => alerts.onOrderEvent(event));
  },

  beforeTenant(app, ctx) {
    const { webhook } = orderAlertsFor(ctx);
    const guard = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch((err) => {
      reportError(err, { msg: 'whatsapp.webhook_error' });
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on our side.' });
      else next();
    });
    app.get(STORE_PROVIDER_PATHS.whatsappVerify.path, guard(webhook.verify));
    app.post(STORE_PROVIDER_PATHS.whatsapp.path, guard(webhook.receive));
  },

  api: (ctx) => {
    const { settings, alerts } = orderAlertsFor(ctx);
    return {
      'alertSettings.get': () => settings.view(),
      'alertSettings.update': ({ body, user }) => settings.update(body, actorOf(user)),
      'whatsappAccount.get': () => settings.account(),
      'whatsappAccount.connect': ({ body, user }) => settings.connect(body, actorOf(user)),
      'whatsappAccount.disconnect': async ({ user }) => {
        await settings.disconnect(actorOf(user));
        return null;
      },
      'whatsappTemplates.all': () => settings.templates(),
      'whatsappTemplates.sync': () => settings.syncTemplates(),
      'orderAlerts.list': ({ query }) => alerts.list(query),
      'orderAlerts.retry': ({ params, user }) => alerts.retry(params.id, actorOf(user)),
    };
  },

  jobs(ctx) {
    const { queue } = ctx.platform;
    const { alerts, webhook } = orderAlertsFor(ctx);
    queue.work(ORDER_ALERT_JOBS.sweep, async () => {
      await webhook.drain();
      await alerts.sweep();
    });
    return async function schedule() {
      await queue.every(ORDER_ALERT_JOBS.sweep, MINUTE);
    };
  },
};

import { createCartReminders } from './reminders.js';
import { mountRestore } from './restore.js';

/**
 * PRD 9.15: abandoned-cart reminders (reminders.js), and the link that brings the cart back (restore.js).
 *
 * Tables (migration 409): cart_reminders; the on/off switch is alert_settings.cart_reminders, read through the order-alerts
 * module's settings. carts.episode counts the times one cart was left.
 * Buyer route (src/contracts/store-routes.js): GET /cart/restore/:token.
 * Console routes (src/contracts/api/store.js): cartReminders.get, cartReminders.update, cartReminders.stats.
 * Order events: order.created stops the reminders of that shopper (S-49).
 * Jobs: abandoned-cart.run every minute plans what is due and sends what is due, through ctx.shopperMessages as marketing,
 * which holds it outside 9 pm to 9 am (S-50). WhatsApp or email only, never an Instagram DM (S-51).
 */
export const CART_REMINDER_JOBS = Object.freeze({ run: 'abandoned-cart.run' });
const MINUTE = 60_000;

const built = new WeakMap();
export function cartRemindersFor(ctx) {
  let found = built.get(ctx);
  if (!found) {
    found = createCartReminders(ctx);
    built.set(ctx, found);
  }
  return found;
}

export const abandonedCart = {
  name: 'abandoned-cart',

  setup(ctx) {
    const reminders = cartRemindersFor(ctx);
    ctx.orderEvents?.on('order.created', 'abandoned-cart.stop-on-order', (event) => reminders.onOrderCreated(event));
  },

  routes(app, ctx) {
    mountRestore(app, ctx, cartRemindersFor(ctx));
  },

  api: (ctx) => {
    const reminders = cartRemindersFor(ctx);
    return {
      'cartReminders.get': () => reminders.view(),
      'cartReminders.update': ({ body, user }) => reminders.setEnabled(body.enabled, `user:${user.id}`),
      'cartReminders.stats': ({ query }) => reminders.stats(query.days),
    };
  },

  jobs(ctx) {
    const { queue } = ctx.platform;
    const reminders = cartRemindersFor(ctx);
    queue.work(CART_REMINDER_JOBS.run, () => reminders.run());
    return async function schedule() {
      await queue.every(CART_REMINDER_JOBS.run, MINUTE);
    };
  },
};

import { inventoryApi } from './api.js';
import { expireHolds, stockListeners } from './stock.js';

/**
 * PRD 9.12: stock with reservations. This folder is the inventory track's.
 *
 * Tables: stock_reservations, stock_movements, inventory_settings, and stock/reserved on products and product_variants.
 * stock.js is what checkout and the orders screens call inside their own transaction: reserve, commit and giveBack.
 *
 * Order events: order.paid, order.advance_paid and order.cod_confirmed commit a hold; order.cancelled and
 * order.rto_delivered give stock back; return.received restocks a good return. Each is safe to hear twice.
 * The job cancels an order whose hold ran out and returns its stock (S-39), every minute.
 */
export const HOLD_EXPIRY_QUEUE = 'inventory.hold-expiry';

export const inventory = {
  name: 'inventory',
  api: inventoryApi,
  setup(ctx) {
    const on = stockListeners(ctx);
    ctx.orderEvents.on(['order.paid', 'order.advance_paid', 'order.cod_confirmed'], 'inventory.commit', on.commit);
    ctx.orderEvents.on(['order.cancelled', 'order.rto_delivered'], 'inventory.give-back', on.giveBack);
    ctx.orderEvents.on('return.received', 'inventory.restock-return', on.returned);
  },
  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(HOLD_EXPIRY_QUEUE, () => expireHolds(ctx));
    return async function schedule() {
      await queue.every(HOLD_EXPIRY_QUEUE, 60_000);
    };
  },
};

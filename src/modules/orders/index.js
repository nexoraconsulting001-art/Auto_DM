import { ordersApi } from './api.js';
import { ordersRepo } from './legacy.js';
import { ordersRoutes } from './routes.js';

/**
 * PRD 9.9 and the shopper's side of 9.17. Two files here are the Phase 4 contract and stay as they are for every track:
 *
 *   state.js    the one order state machine: the only code that changes the status of an order, payment, refund, shipment
 *               or return. Read its header before writing anything that moves an order.
 *   events.js   the order event bus, ctx.orderEvents.
 *
 * Built here:
 *   api.js      orders.timeline, .advance, .cancel, .releaseHold, .reinstate, .addNote and orderDownloads.*, and through
 *               takesOver orders.list, .get and .setStatus with the Phase 4 fields (setStatus is for Phase 0 orders only).
 *   cancel.js   cancelling before shipment, from the console or by the shopper: the stock and the coupon come back in the same
 *               transaction, and a paid order answers with refundDuePaise for the owner (S-31, S-56).
 *   routes.js   POST /api/store/orders/:orderNumber/cancel, and the CSV file at /orders/downloads/:id/file.
 *
 * legacy.js is the Phase 0 order repo (repos.orders), kept for Phase 0 orders and businesses without the store.
 * Tables: orders and order_items (migration 402), order_status_history (the timeline, written by the database),
 * status_transitions, and order_downloads (430).
 */
export const orders = {
  name: 'orders',
  repos: (db) => ({ orders: ordersRepo(db) }),
  api: (ctx) => {
    const { takesOver: _phase0, ...handlers } = ordersApi(ctx);
    return handlers;
  },
  takesOver: (ctx) => ordersApi(ctx).takesOver,
  routes: (app, ctx) => ordersRoutes(app, ctx),
};

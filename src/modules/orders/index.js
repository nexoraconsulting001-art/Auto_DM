import { notBuilt } from '../not-built.js';
import { ordersRepo } from './legacy.js';

/**
 * PRD 9.9 and the shopper's side of 9.17. This folder is the orders track's, with two files that are the Phase 4 contract and
 * stay as they are for every track:
 *
 *   state.js    the one order state machine: the only code that changes the status of an order, payment, refund, shipment
 *               or return. Read its header before writing anything that moves an order.
 *   events.js   the order event bus, ctx.orderEvents.
 *
 * legacy.js is the Phase 0 order repo (repos.orders), moved here so this track can replace it; its create() is the Phase 0
 * store's and goes when checkout lands.
 *
 * Not built yet: the Phase 4 order routes below. orders.list, .get and .setStatus are still answered by admin-api; take them
 * over with takesOver(ctx), with the Phase 4 fields of the Order schema filled in.
 *
 * Tables (already migrated): orders and order_items grown in migration 402, order_status_history (the timeline: the
 * database writes it), status_transitions.
 * Buyer routes (src/contracts/store-routes.js): POST /api/store/orders/:orderNumber/cancel.
 * Cancelling before shipment (S-31, S-56) is changeOrder(t, id, { fulfilment: 'cancelled', cancelReason }): stock, the coupon
 * and points come back through their own listeners on order.cancelled, and a paid order is returned with refundDuePaise.
 */
export const orders = {
  name: 'orders',
  repos: (db) => ({ orders: ordersRepo(db) }),
  api: () => notBuilt(
    'orders.timeline',
    'orders.advance',
    'orders.cancel',
    'orders.releaseHold',
    'orders.reinstate',
    'orders.addNote',
    'orderDownloads.list',
    'orderDownloads.create',
    'orderDownloads.get',
  ),
};

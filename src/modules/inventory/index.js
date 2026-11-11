import { notBuilt } from '../not-built.js';

/**
 * PRD 9.12. Not built yet: this folder is the inventory track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): stock_reservations, stock_movements, inventory_settings, and stock/reserved on products
 * and product_variants.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): order.paid, order.advance_paid and
 * order.cod_confirmed commit a hold; order.cancelled and order.rto_delivered give stock back; return.received
 * restocks when the condition is good. Each through stock_movements’ unique (reason, ref), so twice is once.
 * Checkout calls reserve(t, lines) inside the order’s transaction; the database refuses a hold beyond what is on hand
 * (S-16). A job releases holds past orders.hold_expires_at and cancels the order with reason hold_expired (S-39).
 */
export const inventory = {
  name: 'inventory',
  api: () => notBuilt(
    'inventory.list',
    'inventory.adjust',
    'inventory.movements',
    'inventorySettings.get',
    'inventorySettings.update',
  ),
};

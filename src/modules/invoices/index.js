import { notBuilt } from '../not-built.js';

/**
 * PRD 9.13. Not built yet: this folder is the invoices track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): invoice_settings, invoice_sequences, invoices.
 * Buyer routes (src/contracts/store-routes.js): GET /order/:token/invoice/:number.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): order.paid (or order.delivered for cash on delivery)
 * issues the invoice; refund.processed issues the credit note. The database numbers them, gapless, and refuses a
 * second one for the same order or refund.
 * Never insert with ON CONFLICT, and never choose a number: the trigger does. Money rules are taxInside and splitGst
 * in src/contracts/orders.js (S-42).
 */
export const invoices = {
  name: 'invoices',
  api: () => notBuilt(
    'invoiceSettings.get',
    'invoiceSettings.update',
    'invoices.list',
    'invoices.get',
  ),
};

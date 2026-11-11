import { notBuilt } from '../not-built.js';

/**
 * PRD 9.8. Not built yet: this folder is the refunds track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): refunds.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): refund.processed moves the order to
 * partially_refunded or refunded and writes the statement line.
 * Owner only, after the password is checked again on the call, and every refund is in the audit log. The database
 * holds refunds inside the captured amount (S-28). Managed mode reverses the Route transfer; own mode never does
 * (S-76).
 */
export const refunds = {
  name: 'refunds',
  api: () => notBuilt(
    'refunds.forOrder',
    'refunds.create',
    'refunds.get',
    'refunds.retry',
  ),
};

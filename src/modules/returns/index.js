import { notBuilt } from '../not-built.js';

/**
 * PRD 9.17. Not built yet: this folder is the returns track's, and nothing outside it should need editing.
 *
 * Tables (already migrated): return_settings, returns, return_items, return_proofs.
 * Buyer routes (src/contracts/store-routes.js): GET /account/orders/:orderNumber/return, POST
 * /api/store/orders/:orderNumber/returns.
 * Order events (register in setup(ctx) with ctx.orderEvents.on): shipment.delivered of a reverse shipment marks the
 * return received-pending; refund.processed with a return closes it.
 * Proof files go to platform.storage under a private key, never to /media.
 */
export const returns = {
  name: 'returns',
  api: () => notBuilt(
    'returnSettings.get',
    'returnSettings.update',
    'returns.list',
    'returns.get',
    'returns.approve',
    'returns.decline',
    'returns.receive',
    'returns.close',
  ),
};

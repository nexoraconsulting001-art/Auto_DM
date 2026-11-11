// The order repo moved to the orders module, which owns it from Phase 4. Earlier code still imports these names from here.
export { MAX_QTY_PER_LINE, ORDER_STATUSES, normalizeCustomer, ordersRepo } from '../modules/orders/legacy.js';

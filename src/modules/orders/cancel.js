import { canCancelBeforeShipment } from '../../contracts/orders.js';
import { release } from '../coupons/rules.js';
import { giveBack } from '../inventory/stock.js';
import { OrderStateError, addOrderNote, changeOrder } from './state.js';

/**
 * Cancelling a checkout order before it ships (PRD 9.9, 9.17; S-31, S-56, S-69), from the console or by the shopper, in one
 * transaction: the order moves to cancelled through the state machine, cash on delivery has nothing left to collect, the
 * stock and the coupon come back at once, and the note lands on the timeline. The order.cancelled event the database writes
 * tells the refunds, loyalty and alert listeners; theirs and the stock and coupon listeners are safe to hear it again.
 * A paid order comes back with what is to be refunded, for the owner to act on.
 */
export async function cancelOrder(t, orderId, { actor, cancelReason, note = '', events = null }) {
  // Asking for no move locks the row and changes nothing; a Phase 0 order is refused here with code manual_order.
  const { order: before } = await changeOrder(t, orderId, { actor });
  if (!canCancelBeforeShipment(before)) {
    throw new OrderStateError('not_allowed', before.fulfilment_status === 'cancelled' ? 'This order is already cancelled.' : 'This order has shipped, so it can’t be cancelled now.', { from: before.fulfilment_status, to: 'cancelled' });
  }
  const payment = before.payment_status === 'cod_due' ? 'voided' : undefined;
  const { order: after } = await changeOrder(t, orderId, { fulfilment: 'cancelled', payment, cancelReason, actor, reason: 'Cancelled before shipment' });
  await giveBack(t, orderId, 'cancel', { actor, events });
  await release(t, orderId);
  if (note) await addOrderNote(t, orderId, { actor, note });
  return after;
}

/** What a cancelled order still owes the shopper: captured money not yet refunded. */
export const refundDue = (order) => (order.fulfilment_status === 'cancelled' ? Math.max(0, Number(order.paid_paise) - Number(order.refunded_paise)) : 0);

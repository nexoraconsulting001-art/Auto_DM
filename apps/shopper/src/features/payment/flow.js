/**
 * What the app does with a payment's result. The rule: an order is Paid only when the server says so (packages/pay asks the
 * server for the order's state after the payment page or SDK returns, whatever that said), and the bag is emptied only then.
 * A payment that was cancelled, failed or is still being confirmed leaves the bag as it was.
 *
 *   outcomeOf(result)   'paid' | 'failed' | 'confirming' | 'cancelled'
 */
export function outcomeOf(result) {
  if (result?.status === 'paid') return 'paid';
  if (result?.status === 'failed') return 'failed';
  return result?.state?.next === 'pending' ? 'confirming' : 'cancelled';
}

/** Takes the shopper through payment and settles the bag by the outcome. `order` is checkout's answer ({ token, gateway }). */
export async function payAndSettle({ pay, order, cart, attempt }) {
  const result = await pay(order);
  const outcome = outcomeOf(result);
  if (outcome === 'paid') {
    await cart?.clear();
    attempt?.reset();
  }
  return { outcome, state: result.state };
}

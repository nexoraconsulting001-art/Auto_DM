/**
 * Paying for an order in the shopper app. Physical goods are paid through the gateway, never through in-app purchase.
 *
 *   const { pay } = createPay({ driver, pageUrl, returnUrl, orderState, submitReturn });
 *   const result = await pay(order);      // order: what checkout answered ({ token, gateway })
 *   result.status                         // 'paid' | 'failed' | 'cancelled'
 *   result.state                          // the server's last word on the order (AppOrderState), or null if it could not be asked
 *
 * Two drivers, one interface:
 *
 *   hosted (the default)   opens the store's own payment page, on the seller's address, in a system browser tab, and comes
 *                          back by the app's link. hosted.js
 *   native                 the gateway's SDK inside the app. Built in only when the build setting PAY_DRIVER is `native`, and
 *                          left off until it has been tried on a device. native.js
 *
 * Neither driver decides that an order is paid. Whatever the browser or the SDK says, the driver then asks the server for the
 * order's state, and the server marks an order paid only from the provider's signed webhook or a signature it checked itself:
 *
 *   paid        the server says the order is done
 *   failed      the server says the payment failed
 *   cancelled   the server still waits for payment: the shopper closed the page, or nothing was paid. When the server is
 *               still confirming after a few asks, the result is also `cancelled` with state.next 'pending', and the order's
 *               screen shows that state; the money is never taken twice, because retrying goes through the same order.
 */
import { createHostedDriver } from './hosted.js';
import { createNativeDriver } from './native.js';

export const PAY_RESULTS = Object.freeze(['paid', 'failed', 'cancelled']);
export const PAY_DRIVERS = Object.freeze(['hosted', 'native']);
export const DEFAULT_PAY_DRIVER = 'hosted';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks the server what became of the order, a few times while it is still confirming. Answers { status, state }.
 * `orderState(token)` answers AppOrderState ({ next: 'pay' | 'pending' | 'done' | 'failed', ... }).
 */
export async function settle(order, { orderState, attempts = 5, waitMs = 1500, wait = sleep } = {}) {
  let state = null;
  for (let i = 0; i < attempts; i++) {
    try {
      state = await orderState(order.token);
    } catch {
      state = null;
    }
    if (state?.next === 'done') return Object.freeze({ status: 'paid', state });
    if (state?.next === 'failed') return Object.freeze({ status: 'failed', state });
    if (state?.next === 'pay') break;
    if (i < attempts - 1) await wait(waitMs);
  }
  return Object.freeze({ status: 'cancelled', state });
}

/**
 * @param {object} options
 * @param {'hosted' | 'native'} [options.driver] anything but `native` is the hosted driver
 * @param {(token: string) => Promise<object>} options.orderState the order's state from the server (route appOrderByToken)
 * @param {(order: object) => string} options.pageUrl the order's payment page on the store's own address (hosted)
 * @param {(order: object) => string} options.returnUrl the app link the page comes back by (hosted)
 * @param {(body: object) => Promise<unknown>} [options.submitReturn] sends the SDK's signed answer to the server (native; route paymentReturn)
 * @param {object} [options.browser] expo-web-browser, or a stand-in (hosted)
 * @param {() => object} [options.loadSdk] the gateway's SDK, loaded only when used (native)
 */
export function createPay({ driver = DEFAULT_PAY_DRIVER, orderState, attempts, waitMs, wait, ...rest } = {}) {
  if (typeof orderState !== 'function') throw new Error('pay needs a way to ask the server for the order’s state');
  const name = driver === 'native' ? 'native' : DEFAULT_PAY_DRIVER;
  const confirm = (order) => settle(order, { orderState, attempts, waitMs, wait });
  const run = name === 'native' ? createNativeDriver({ confirm, ...rest }) : createHostedDriver({ confirm, ...rest });
  /** Takes the shopper through payment for one order. Never throws for a payment that did not happen: that is a result. */
  async function pay(order) {
    if (!order || typeof order.token !== 'string' || !order.token) throw new Error('pay needs the order checkout answered');
    return run(order);
  }
  return Object.freeze({ driver: name, pay });
}

/**
 * The native driver: the gateway's SDK inside the app. Built in only when the build setting PAY_DRIVER is `native`; in every
 * other build the SDK is not linked, so it is loaded here only when a payment starts, never when the app starts.
 *
 * The SDK is given the gateway's public key id and the gateway order the server made; it never sees a secret. Its signed
 * answer goes to the server (`submitReturn`), which checks the signature itself. The result is then the server's.
 */
const loadGatewaySdk = () => require('react-native-razorpay').default;

export function createNativeDriver({ confirm, submitReturn, loadSdk = loadGatewaySdk } = {}) {
  if (typeof submitReturn !== 'function') throw new Error('The native pay driver needs a way to send the gateway’s answer to the server');
  return async function payNative(order) {
    const gateway = order.gateway;
    if (!gateway || gateway.provider !== 'razorpay') return confirm(order);
    let answer = null;
    try {
      answer = await loadSdk().open({
        key: gateway.keyId,
        order_id: gateway.gatewayOrderId,
        amount: gateway.amountPaise,
        currency: 'INR',
        name: gateway.display?.name ?? '',
        ...(gateway.display?.image ? { image: gateway.display.image } : {}),
        ...(gateway.display?.color ? { theme: { color: gateway.display.color } } : {}),
      });
    } catch {
      // Closed by the shopper, or the payment failed inside the SDK: the server says which.
    }
    if (answer?.razorpay_payment_id && answer?.razorpay_signature) {
      await Promise.resolve(submitReturn({ orderToken: order.token, gatewayOrderId: gateway.gatewayOrderId, gatewayPaymentId: answer.razorpay_payment_id, signature: answer.razorpay_signature })).catch(() => {});
    }
    return confirm(order);
  };
}

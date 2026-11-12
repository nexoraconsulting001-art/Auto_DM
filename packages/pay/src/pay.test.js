import { DEFAULT_PAY_DRIVER, PAY_DRIVERS, PAY_RESULTS, createPay, settle } from './index.js';

const order = { token: 'tok_1', orderNumber: 'A-1', gateway: { provider: 'razorpay', keyId: 'key_public', gatewayOrderId: 'order_9', amountPaise: 49900, display: { name: 'A shop', image: '', color: '' } } };
const states = (...list) => {
  const asked = [];
  const orderState = async (token) => {
    asked.push(token);
    const next = list[Math.min(asked.length - 1, list.length - 1)];
    if (next instanceof Error) throw next;
    return { orderNumber: 'A-1', next };
  };
  return { orderState, asked };
};
const noWait = async () => {};
const browserThat = (result) => {
  const opened = [];
  return { opened, openAuthSessionAsync: async (...args) => { opened.push(args); if (result instanceof Error) throw result; return result; } };
};
const hosted = (extra) => createPay({ pageUrl: (o) => `http://localhost/order/${o.token}`, returnUrl: (o) => `shop://order/${o.token}`, wait: noWait, ...extra });

test('there are three results and two drivers, and hosted is the default', () => {
  expect(PAY_RESULTS).toEqual(['paid', 'failed', 'cancelled']);
  expect(PAY_DRIVERS).toEqual(['hosted', 'native']);
  expect(DEFAULT_PAY_DRIVER).toBe('hosted');
  expect(hosted({ orderState: states('done').orderState }).driver).toBe('hosted');
  expect(hosted({ driver: 'something-else', orderState: states('done').orderState }).driver).toBe('hosted');
});

test('hosted: the store’s own page opens in a browser tab with the app’s link to come back by', async () => {
  const browser = browserThat({ type: 'success', url: 'shop://order/tok_1' });
  const { orderState, asked } = states('done');
  const result = await hosted({ browser, orderState }).pay(order);
  expect(browser.opened[0].slice(0, 2)).toEqual(['http://localhost/order/tok_1', 'shop://order/tok_1']);
  expect(result.status).toBe('paid');
  expect(asked).toEqual(['tok_1']);
});

test('hosted: coming back by the link is not proof: the server decides, and it can say failed', async () => {
  const browser = browserThat({ type: 'success', url: 'shop://order/tok_1?status=paid' });
  expect((await hosted({ browser, orderState: states('failed').orderState }).pay(order)).status).toBe('failed');
  expect((await hosted({ browser, orderState: states('pay').orderState }).pay(order)).status).toBe('cancelled');
});

test('hosted: closing the tab is cancelled when nothing was paid, and paid when the server says it was', async () => {
  const closed = browserThat({ type: 'dismiss' });
  expect((await hosted({ browser: closed, orderState: states('pay').orderState }).pay(order)).status).toBe('cancelled');
  expect((await hosted({ browser: closed, orderState: states('pending', 'done').orderState }).pay(order)).status).toBe('paid');
  expect((await hosted({ browser: browserThat(new Error('no browser')), orderState: states('done').orderState }).pay(order)).status).toBe('paid');
});

test('while the server is still confirming it is asked again, a set number of times, then the result is cancelled with the pending state', async () => {
  const waits = [];
  const { orderState, asked } = states('pending');
  const result = await settle(order, { orderState, attempts: 4, waitMs: 20, wait: async (ms) => waits.push(ms) });
  expect(asked).toHaveLength(4);
  expect(waits).toEqual([20, 20, 20]);
  expect(result).toMatchObject({ status: 'cancelled', state: { next: 'pending' } });
  const offline = await settle(order, { orderState: states(new Error('offline')).orderState, attempts: 2, wait: noWait });
  expect(offline).toEqual({ status: 'cancelled', state: null });
});

test('native: the SDK gets the public key id and the gateway order, its signed answer goes to the server, and the server decides', async () => {
  const opened = [];
  const sent = [];
  const sdk = { open: async (options) => { opened.push(options); return { razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_9', razorpay_signature: 'sig' }; } };
  const pay = createPay({ driver: 'native', loadSdk: () => sdk, submitReturn: async (body) => sent.push(body), orderState: states('pending', 'done').orderState, wait: noWait });
  expect(pay.driver).toBe('native');
  const result = await pay.pay(order);
  expect(opened[0]).toMatchObject({ key: 'key_public', order_id: 'order_9', amount: 49900, currency: 'INR' });
  expect(JSON.stringify(opened[0])).not.toMatch(/secret/i);
  expect(sent).toEqual([{ orderToken: 'tok_1', gatewayOrderId: 'order_9', gatewayPaymentId: 'pay_1', signature: 'sig' }]);
  expect(result.status).toBe('paid');
});

test('native: an SDK that says paid is not believed when the server says otherwise, and closing it is cancelled', async () => {
  const lying = { open: async () => ({ razorpay_payment_id: 'pay_1', razorpay_signature: 'forged' }) };
  const refused = createPay({ driver: 'native', loadSdk: () => lying, submitReturn: async () => { throw new Error('bad signature'); }, orderState: states('pay').orderState, wait: noWait });
  expect((await refused.pay(order)).status).toBe('cancelled');
  const sent = [];
  const closing = { open: async () => { throw Object.assign(new Error('closed'), { code: 0 }); } };
  const closed = createPay({ driver: 'native', loadSdk: () => closing, submitReturn: async (b) => sent.push(b), orderState: states('pay').orderState, wait: noWait });
  expect((await closed.pay(order)).status).toBe('cancelled');
  expect(sent).toEqual([]);
});

test('native: the SDK is loaded only when a payment starts', () => {
  let loads = 0;
  createPay({ driver: 'native', loadSdk: () => { loads += 1; return {}; }, submitReturn: async () => {}, orderState: states('done').orderState });
  expect(loads).toBe(0);
});

test('a driver without what it needs, or an order without a token, is refused at once', async () => {
  expect(() => createPay({ pageUrl: () => '', returnUrl: () => '' })).toThrow('order’s state');
  expect(() => createPay({ orderState: async () => ({}) })).toThrow('payment page');
  expect(() => createPay({ driver: 'native', orderState: async () => ({}) })).toThrow('gateway’s answer');
  await expect(hosted({ orderState: states('done').orderState, browser: browserThat({}) }).pay({})).rejects.toThrow('order checkout answered');
});

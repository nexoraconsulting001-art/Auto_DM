// Final review, buyer-1: the buyer's browser scripts, run together the way the store's pages load them. The order page's
// Pay button and the checkout page's Place order must reach the gateway's checkout through window.StorePay (PAY_JS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CHECKOUT_JS } from '../../../src/modules/checkout/assets.js';
import { ORDER_JS } from '../../../src/modules/checkout/pages.js';
import { PAY_JS } from '../../../src/modules/storefront/views/pay.js';

const GATEWAY = Object.freeze({ provider: 'razorpay', keyId: 'rzp_test_sim', gatewayOrderId: 'order_sim1', amountPaise: 54800, display: { name: 'Leafy Corner', image: '', color: '#2F6B3F' } });
const TOKEN = 'tok_ABCDEFGHIJKLMNOP';
const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** A stand-in element: any child it is asked for exists, and listeners are kept so a test can fire them. */
function element(extra = {}) {
  const children = new Map();
  const listeners = {};
  const self = {
    hidden: false, disabled: false, textContent: '', value: '', checked: false, dataset: {}, attrs: {},
    listeners,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    setAttribute(k, v) { self.attrs[k] = v; },
    querySelector(s) { if (!children.has(s)) children.set(s, element()); return children.get(s); },
    querySelectorAll: () => [],
    replaceChildren() {}, append() {}, focus() {},
    async fire(name, event = {}) { for (const fn of listeners[name] ?? []) await fn({ preventDefault() {}, target: {}, ...event }); },
    ...extra,
  };
  return self;
}

/** A browser holding the given scripts, with the store's api answering `answers[path]` and a gateway that opens. */
function browser({ scripts, answers, page }) {
  const calls = [];
  const went = [];
  const opened = [];
  function FakeGateway(options) { opened.push(options); }
  FakeGateway.prototype.on = function on() {};
  FakeGateway.prototype.open = function open() {};
  const window = {};
  const document = {
    title: 'Leafy Corner',
    head: { appendChild(script) { setImmediate(() => { window.Razorpay = FakeGateway; script.onload(); }); } },
    querySelector: (s) => page[s] ?? null,
    getElementById: (id) => (id === 'store-data' ? { textContent: '{"noticeVersion":1}' } : null),
    createElement: () => element(),
    addEventListener() {},
  };
  const location = { origin: 'https://leafy.example', assign: (to) => went.push(to), reload: () => went.push('reload') };
  window.StoreBag = {
    read: () => ({ lines: [{ productId: 1, variantId: null, qty: 1 }], ref: {} }),
    clear() {},
    money: (p) => String(p),
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      const answer = answers[path] ?? { ok: false, status: 500, data: {} };
      return typeof answer === 'function' ? answer(body) : answer;
    },
  };
  const sessionStorage = { getItem: () => 'key-1', setItem() {}, removeItem() {} };
  const context = vm.createContext({ window, document, location, sessionStorage, crypto: { randomUUID: () => 'key-1' }, confirm: () => true, setTimeout, clearTimeout, setImmediate, Promise, Number, String, Boolean, Object, Error, JSON, encodeURIComponent });
  Object.assign(window, { document, location, setTimeout });
  for (const [name, source] of scripts) vm.runInContext(source, context, { filename: name });
  return { window, calls, went, opened };
}

test('buyer-1: on the order page, Pay opens the gateway with the payment script loaded beside the order script', async () => {
  const root = element({ dataset: { token: TOKEN, number: 'LC-1001' } });
  const payButton = root.querySelector('[data-pay]');
  const page = { '[data-order-page]': root, '[data-pay]': payButton, '[data-pay-error]': root.querySelector('[data-pay-error]') };
  const b = browser({ scripts: [['pay.js', PAY_JS], ['order.js', ORDER_JS]], page, answers: { [`/api/store/orders/${TOKEN}/retry`]: { ok: true, status: 200, data: { gateway: GATEWAY } } } });
  payButton.fire('click'); // not awaited: the gateway's screen stays open until the shopper pays or closes it
  await settle();
  assert.equal(b.opened.length, 1, `The gateway did not open; the message said: ${root.querySelector('[data-pay-error]').textContent}`);
  assert.equal(b.opened[0].order_id, GATEWAY.gatewayOrderId);
  assert.equal(b.opened[0].amount, GATEWAY.amountPaise);
});

function checkoutPage() {
  const values = { paymentMode: 'prepaid', acceptTerms: true, name: 'Asha Rao', phone: '9876543210', line1: '12 Lake Road', city: 'Pune', stateCode: '27', pincode: '411001' };
  const form = element({ elements: new Proxy({}, { get: (_, name) => (name in values ? { value: values[name] === true ? 'on' : values[name], checked: values[name] === true } : undefined) }) });
  form.querySelector = (s) => (s === 'input[name="paymentMode"]:checked' ? { value: 'prepaid' } : s.startsWith('input[name="addressId"]') ? null : element());
  const root = element();
  const place = element();
  const children = { 'form[data-checkout-form]': form, '[data-place]': place };
  const base = root.querySelector.bind(root);
  root.querySelector = (s) => children[s] ?? base(s);
  return { page: { '[data-checkout-page]': root }, form, root };
}

const quoteAnswer = { ok: false, status: 503, data: {} };

test('buyer-1: placing an online order at checkout opens the gateway for it, and a closed payment screen goes to the order page', async () => {
  const { page, form } = checkoutPage();
  const placed = { ok: true, status: 201, data: { orderNumber: 'LC-1001', token: TOKEN, next: 'pay', gateway: GATEWAY } };
  const b = browser({ scripts: [['pay.js', PAY_JS], ['checkout.js', CHECKOUT_JS]], page, answers: { '/api/store/checkout/quote': quoteAnswer, '/api/store/checkout': placed } });
  const opens = [];
  const real = b.window.StorePay.open;
  b.window.StorePay = { open: (gateway, token) => { opens.push({ gateway: plain(gateway), token }); return Promise.resolve('dismissed'); } };
  assert.equal(typeof real, 'function');
  await form.fire('submit');
  await settle();
  assert.ok(b.calls.some((c) => c.path === '/api/store/checkout'), 'Place order sent nothing');
  assert.deepEqual(opens, [{ gateway: plain(GATEWAY), token: TOKEN }], 'Checkout went to the order page without opening the gateway');
  assert.deepEqual(b.went, [`/order/${TOKEN}`], 'After the payment screen closed the shopper should see the order page, where Pay can be tapped again');
});

test('buyer-1: a paid gateway answer is left to the payment script, which brings the shopper back itself', async () => {
  const { page, form } = checkoutPage();
  const placed = { ok: true, status: 201, data: { orderNumber: 'LC-1001', token: TOKEN, next: 'pay', gateway: GATEWAY } };
  const b = browser({ scripts: [['pay.js', PAY_JS], ['checkout.js', CHECKOUT_JS]], page, answers: { '/api/store/checkout/quote': quoteAnswer, '/api/store/checkout': placed } });
  b.window.StorePay = { open: () => Promise.resolve('paid') };
  await form.fire('submit');
  await settle();
  assert.deepEqual(b.went, [], 'Checkout navigated over the payment script’s own return');
});

test('buyer-1: a cash-on-delivery order placed at checkout goes straight to its order page, with no gateway', async () => {
  const { page, form } = checkoutPage();
  const placed = { ok: true, status: 201, data: { orderNumber: 'LC-1002', token: TOKEN, next: 'done', gateway: null } };
  const b = browser({ scripts: [['pay.js', PAY_JS], ['checkout.js', CHECKOUT_JS]], page, answers: { '/api/store/checkout/quote': quoteAnswer, '/api/store/checkout': placed } });
  let opened = 0;
  b.window.StorePay = { open: () => { opened += 1; return Promise.resolve('paid'); } };
  await form.fire('submit');
  await settle();
  assert.equal(opened, 0);
  assert.deepEqual(b.went, [`/order/${TOKEN}`]);
});

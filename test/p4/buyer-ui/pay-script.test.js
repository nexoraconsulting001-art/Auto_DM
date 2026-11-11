// The store's payment screen script, PAY_JS in src/modules/storefront/views/pay.js (PRD 9.6): it opens the gateway's
// checkout in the seller's name, sends the gateway's signed answer to the server and nothing else, and only ever sends the
// shopper to this store's own pages. Run in a small stand-in for the browser: a vm context with just the parts of window
// and document it touches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { GATEWAY_ORIGINS, GATEWAY_SCRIPT_URL, PAY_JS as SOURCE, PAY_SCRIPT } from '../../../src/modules/storefront/views/pay.js';

const GATEWAY = Object.freeze({ provider: 'razorpay', keyId: 'rzp_test_sim', gatewayOrderId: 'order_sim1', amountPaise: 54800, display: { name: 'Leafy Corner', image: '/media/logo-1', color: '#2F6B3F' } });
// Objects made inside the vm have its own prototypes: compare them as plain data.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A page with the order page's button and message box, a gateway that behaves as `gateway` says, and a recorded network. */
function browser({ gateway = 'loads', answer = { status: 200, body: { status: 'paid', next: '/order/the-order-page-token' } }, storeBag = true } = {}) {
  const elements = {
    '[data-pay]': { disabled: true },
    '[data-pay-error]': { hidden: true, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    'meta[name="csrf-token"]': { content: 'csrf-1' },
    'meta[name="shopper-csrf"]': null,
  };
  const loaded = [];
  const opened = [];
  const calls = [];
  const went = [];
  const handlers = {};
  function FakeGateway(options) {
    this.options = options;
    opened.push(options);
  }
  FakeGateway.prototype.on = function on(name, fn) { handlers[name] = fn; };
  FakeGateway.prototype.open = function open() {};

  const window = {};
  const document = {
    title: 'Order LC-1001 · Leafy Corner',
    head: {
      appendChild(script) {
        loaded.push(script.src);
        setImmediate(() => {
          if (gateway === 'loads') {
            window.Razorpay = FakeGateway;
            script.onload();
          } else if (gateway === 'empty') script.onload();
          else script.onerror();
        });
      },
    },
    querySelector: (s) => elements[s] ?? null,
    createElement: () => ({}),
  };
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  const location = { origin: 'https://leafy.example', assign: (to) => went.push(to) };
  Object.assign(window, { document, location, fetch, setTimeout: (fn) => fn() });
  if (storeBag) {
    window.StoreBag = {
      api: async (method, url, body) => {
        calls.push({ url, method, body, via: 'StoreBag' });
        return { ok: answer.status < 300, status: answer.status, data: answer.body };
      },
    };
  }
  const context = vm.createContext({ window, document, location, fetch, setTimeout: window.setTimeout, Promise, Number, String, Boolean, Object, Error, JSON, encodeURIComponent });
  vm.runInContext(SOURCE, context, { filename: 'pay.js' });
  return { window, elements, loaded, opened, calls, went, handlers, FakeGateway };
}

test('the payment screen opens on the gateway’s own checkout with the order, the amount and the seller’s name, logo and colour', async () => {
  const b = browser();
  assert.equal(typeof b.window.StorePay?.open, 'function');
  const done = b.window.StorePay.open(GATEWAY, 'the-order-page-token');
  await settle();
  await settle();
  assert.deepEqual(b.loaded, ['https://checkout.razorpay.com/v1/checkout.js'], 'The gateway’s script is loaded from the gateway, once');
  assert.equal(b.opened.length, 1);
  const o = b.opened[0];
  assert.equal(o.key, 'rzp_test_sim');
  assert.equal(o.order_id, 'order_sim1');
  assert.equal(o.amount, 54800);
  assert.equal(o.currency, 'INR');
  assert.equal(o.name, 'Leafy Corner');
  assert.equal(o.image, 'https://leafy.example/media/logo-1', 'A logo on the store is given to the gateway as a full address');
  assert.deepEqual(plain(o.theme), { color: '#2F6B3F' });
  assert.doesNotMatch(JSON.stringify(o), /bhava/i);
  o.modal.ondismiss();
  assert.equal(await done, 'dismissed');
  assert.equal(b.elements['[data-pay]'].disabled, false, 'Closing the payment screen lets the shopper tap Pay again');
  assert.deepEqual(b.calls, [], 'Closing the screen tells the server nothing');
});

test('the gateway’s signed answer goes to the server as it is, and the shopper lands on the page the server names', async () => {
  const b = browser();
  const done = b.window.StorePay.open(GATEWAY, 'the-order-page-token');
  await settle();
  await settle();
  b.opened[0].handler({ razorpay_payment_id: 'pay_sim9', razorpay_order_id: 'order_sim1', razorpay_signature: 'sig-abc' });
  assert.equal(await done, 'paid');
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].url, '/api/store/payments/return');
  assert.deepEqual(plain(b.calls[0].body), { orderToken: 'the-order-page-token', gatewayOrderId: 'order_sim1', gatewayPaymentId: 'pay_sim9', signature: 'sig-abc' },
    'Exactly the fields of PaymentReturn: no amount, no status');
  assert.deepEqual(b.went, ['/order/the-order-page-token']);
});

test('an answer naming another site, or "//host", never takes the shopper off the store', async () => {
  for (const next of ['https://elsewhere.example/order/x', '//elsewhere.example/x', '/\\elsewhere.example', 'javascript:alert(1)', '', null]) {
    const b = browser({ answer: { status: 200, body: { status: 'paid', next } } });
    const done = b.window.StorePay.open(GATEWAY, 'another-order-token');
    await settle();
    await settle();
    b.opened[0].handler({ razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_sim1', razorpay_signature: 's' });
    await done;
    assert.deepEqual(b.went, ['/order/another-order-token'], `next = ${JSON.stringify(next)}`);
  }
});

test('when the server refuses the answer the shopper still lands on the order page, which shows what the server knows', async () => {
  const b = browser({ answer: { status: 400, body: { error: 'That payment couldn’t be checked.', code: 'validation_failed' } } });
  const done = b.window.StorePay.open(GATEWAY, 'another-order-token');
  await settle();
  await settle();
  b.opened[0].handler({ razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_sim1', razorpay_signature: 'forged' });
  await done;
  assert.deepEqual(b.went, ['/order/another-order-token']);
});

test('a failed payment says so in words and lets the shopper try again', async () => {
  const b = browser();
  b.window.StorePay.open(GATEWAY, 'another-order-token');
  await settle();
  await settle();
  b.handlers['payment.failed']({ error: { code: 'BAD_REQUEST_ERROR', description: 'Payment failed' } });
  assert.equal(b.elements['[data-pay-error]'].hidden, false);
  assert.match(b.elements['[data-pay-error]'].textContent, /didn’t go through/);
  assert.equal(b.elements['[data-pay]'].disabled, false);
  assert.deepEqual(b.calls, [], 'A failure reported by the browser is never sent as a result: the server hears it from the gateway');
});

test('a gateway that can’t be reached, or answers no checkout, is a plain message and Pay can be tapped again', async () => {
  for (const gateway of ['unreachable', 'empty']) {
    const b = browser({ gateway });
    assert.equal(await b.window.StorePay.open(GATEWAY, 'another-order-token'), 'unavailable', gateway);
    assert.match(b.elements['[data-pay-error]'].textContent, /isn’t available right now/);
    assert.equal(b.elements['[data-pay]'].disabled, false);
  }
});

test('a payment start that isn’t complete never loads the gateway', async () => {
  const broken = [null, {}, { ...GATEWAY, provider: 'other' }, { ...GATEWAY, keyId: '' }, { ...GATEWAY, gatewayOrderId: '' }, { ...GATEWAY, amountPaise: 0 }, { ...GATEWAY, amountPaise: 12.5 }];
  for (const gateway of broken) {
    const b = browser();
    assert.equal(await b.window.StorePay.open(gateway, 'another-order-token'), 'unavailable', JSON.stringify(gateway));
    assert.deepEqual(b.loaded, []);
  }
  const b = browser();
  assert.equal(await b.window.StorePay.open(GATEWAY, ''), 'unavailable', 'no order token');
});

test('a logo or colour that isn’t safe is left out rather than passed to the gateway', async () => {
  const b = browser();
  b.window.StorePay.open({ ...GATEWAY, display: { name: 'Leafy Corner', image: 'javascript:alert(1)', color: 'red;background:url(x)' } }, 'another-order-token');
  await settle();
  await settle();
  assert.equal(b.opened[0].image, undefined);
  assert.equal(b.opened[0].theme, undefined);
});

test('without the bag script the answer is still sent as JSON with this store’s CSRF token', async () => {
  const b = browser({ storeBag: false });
  b.window.StorePay.open(GATEWAY, 'another-order-token');
  await settle();
  await settle();
  b.opened[0].handler({ razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_sim1', razorpay_signature: 's' });
  await settle();
  await settle();
  assert.equal(b.calls[0].url, '/api/store/payments/return');
  assert.equal(b.calls[0].init.method, 'POST');
  assert.equal(b.calls[0].init.headers['content-type'], 'application/json');
  assert.equal(b.calls[0].init.headers['x-csrf-token'], 'csrf-1');
  assert.equal(b.calls[0].init.credentials, 'same-origin');
});

test('the script names no platform and loads nothing but the gateway’s checkout', () => {
  assert.doesNotMatch(SOURCE, /bhava/i);
  const hosts = [...SOURCE.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual([...new Set(hosts)], ['checkout.razorpay.com']);
  assert.ok(SOURCE.includes(GATEWAY_SCRIPT_URL));
  assert.ok(GATEWAY_ORIGINS.script.includes(new URL(GATEWAY_SCRIPT_URL).origin), 'The policy origins name where the script comes from');
  assert.ok(PAY_SCRIPT.startsWith('/store/'), 'Served beside the store’s other scripts');
});

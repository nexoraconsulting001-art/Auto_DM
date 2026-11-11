/**
 * The payment screen for the store's order page (PRD 9.6), as the script a buyer page loads (PAY_SCRIPT).
 *
 * The order page's script (src/modules/checkout/pages.js, ORDER_JS) asks for a payment with POST /api/store/orders/:token/retry
 * and hands what it gets back to window.StorePay.open(gateway, orderToken). PAY_JS defines that: it opens the gateway's own
 * checkout with the seller's name, logo and colour (never the platform's) and, when the gateway answers, sends its signed
 * result to POST /api/store/payments/return. The server checks the signature and the amount before anything is marked paid
 * (S-19, S-20); nothing here decides that an order is paid, and no amount is worked out here.
 *
 *   gateway = { provider: 'razorpay', keyId, gatewayOrderId, amountPaise, display: { name, image, color } }
 *
 * The gateway's script is loaded only when the shopper taps Pay, from the gateway's own address (GATEWAY_SCRIPT_URL), so a
 * page that loads PAY_JS needs GATEWAY_ORIGINS in its Content-Security-Policy. Card details never touch the store's page:
 * they are typed into the gateway's frame. Afterwards the shopper lands on this store's order page, or on the path the
 * server answered when it is one of this store's own paths. A failed or closed payment screen lets Pay be tapped again,
 * with the reason in words in the page's [data-pay-error] box.
 *
 * Not mounted yet: serving it needs a route beside the order page's own script, and the order page's scripts list
 * (both in src/modules/checkout/pages.js, outside this folder).
 */
export const PAY_SCRIPT = '/store/pay.js';
export const GATEWAY_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
/** Where the gateway's checkout runs, for the order page's Content-Security-Policy (script-src and frame-src). */
export const GATEWAY_ORIGINS = Object.freeze({ script: Object.freeze(['https://checkout.razorpay.com']), frame: Object.freeze(['https://api.razorpay.com', 'https://checkout.razorpay.com']) });

// Written with String.raw so its regular expressions keep their backslashes; it has no backtick and no "${".
export const PAY_JS = String.raw`(function () {
  'use strict';

  var GATEWAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
  var MESSAGES = {
    unavailable: 'Payment isn’t available right now. Please try again in a few minutes.',
    failed: 'The payment didn’t go through. No money was taken for this try. You can try again.',
    checking: 'Checking your payment…',
    returnFailed: 'We couldn’t confirm your payment just now. If money left your account, this page will show it shortly.',
  };
  var loading = null;

  function $(selector) {
    return document.querySelector(selector);
  }

  /** The order page's own button and message box, when they are there. */
  function say(text, role) {
    var box = $('[data-pay-error]');
    if (box) {
      box.textContent = text || '';
      box.hidden = !text;
      if (text) box.setAttribute('role', role || 'alert');
    }
  }
  function ready(on) {
    var button = $('[data-pay]');
    if (button) button.disabled = !on;
  }

  /** A path on this store ("/order/x"), never another site's address or "//host". */
  function ownPath(value) {
    var text = String(value || '');
    return /^\/(?![/\\])[^\s]*$/.test(text) ? text : '';
  }
  /** A picture the gateway may show: an https address, or a path on this store made absolute. */
  function imageFor(value) {
    var text = String(value || '');
    if (/^https:\/\/[^\s"'<>]+$/i.test(text)) return text;
    if (ownPath(text)) return location.origin + text;
    return '';
  }
  function hexColour(value) {
    return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : '';
  }

  function usable(gateway) {
    return Boolean(gateway && gateway.provider === 'razorpay' && typeof gateway.keyId === 'string' && gateway.keyId &&
      typeof gateway.gatewayOrderId === 'string' && gateway.gatewayOrderId && Number.isInteger(gateway.amountPaise) && gateway.amountPaise > 0);
  }

  /** The gateway's checkout script, once per page. A failed load can be tried again. */
  function loadGateway() {
    if (typeof window.Razorpay === 'function') return Promise.resolve(window.Razorpay);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = GATEWAY_SCRIPT;
      script.async = true;
      script.onload = function () {
        if (typeof window.Razorpay === 'function') resolve(window.Razorpay);
        else {
          loading = null;
          reject(new Error('gateway_missing'));
        }
      };
      script.onerror = function () {
        loading = null;
        reject(new Error('gateway_unreachable'));
      };
      document.head.appendChild(script);
    });
    return loading;
  }

  function api(method, path, body) {
    if (window.StoreBag && typeof window.StoreBag.api === 'function') return window.StoreBag.api(method, path, body);
    var headers = { accept: 'application/json', 'content-type': 'application/json' };
    var csrf = $('meta[name="csrf-token"]');
    var shopperCsrf = $('meta[name="shopper-csrf"]');
    if (csrf && csrf.content) headers['x-csrf-token'] = csrf.content;
    if (shopperCsrf && shopperCsrf.content) headers['x-shopper-csrf'] = shopperCsrf.content;
    return fetch(path, { method: method, headers: headers, credentials: 'same-origin', body: JSON.stringify(body) }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, status: res.status, data: data || {} }; });
    });
  }

  /** The gateway's signed answer goes to the server, which alone decides; then the shopper sees the order's own page. */
  function bringBack(orderToken, gateway, answer) {
    say(MESSAGES.checking, 'status');
    var orderPage = '/order/' + encodeURIComponent(orderToken);
    return api('POST', '/api/store/payments/return', {
      orderToken: String(orderToken),
      gatewayOrderId: String(answer.razorpay_order_id || gateway.gatewayOrderId),
      gatewayPaymentId: String(answer.razorpay_payment_id || ''),
      signature: String(answer.razorpay_signature || ''),
    }).then(function (res) {
      location.assign((res.ok && ownPath(res.data && res.data.next)) || orderPage);
      return res;
    }, function () {
      say(MESSAGES.returnFailed);
      setTimeout(function () { location.assign(orderPage); }, 4000);
      return null;
    });
  }

  /**
   * Opens the payment screen. Resolves to 'paid' once the gateway's answer has been handed to the server, 'dismissed' when the
   * shopper closes the screen, or 'unavailable' when it could not open.
   */
  function open(gateway, orderToken) {
    if (!usable(gateway) || !orderToken) {
      say(MESSAGES.unavailable);
      ready(true);
      return Promise.resolve('unavailable');
    }
    say('');
    return loadGateway().then(function (Gateway) {
      return new Promise(function (resolve) {
        var display = gateway.display || {};
        var options = {
          key: gateway.keyId,
          order_id: gateway.gatewayOrderId,
          amount: gateway.amountPaise,
          currency: 'INR',
          name: String(display.name || '').slice(0, 80) || document.title.split(' · ').pop(),
          handler: function (answer) {
            bringBack(orderToken, gateway, answer || {}).then(function () { resolve('paid'); });
          },
          modal: {
            ondismiss: function () {
              ready(true);
              resolve('dismissed');
            },
          },
        };
        var image = imageFor(display.image);
        if (image) options.image = image;
        var colour = hexColour(display.color);
        if (colour) options.theme = { color: colour };
        var screen = new Gateway(options);
        if (typeof screen.on === 'function') {
          screen.on('payment.failed', function () {
            say(MESSAGES.failed);
            ready(true);
          });
        }
        screen.open();
      });
    }, function () {
      say(MESSAGES.unavailable);
      ready(true);
      return 'unavailable';
    });
  }

  window.StorePay = Object.freeze({ open: open });
})();
`;

import express from 'express';
import { formatRupees } from '../../contracts/catalog.js';
import { INDIAN_STATES, canCancelBeforeShipment } from '../../contracts/orders.js';
import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { tenantId } from '../../tenancy.js';
import { html, raw } from '../../views/html.js';
import { safeHref, section } from '../../views/buyer/index.js';
import { shopperFrom, storeOn } from '../storefront/http.js';
import { CHECKOUT_SCRIPT, policyLinks, sendStoreNotFound, sendStorePage } from '../storefront/shell.js';
import { CHECKOUT_JS } from './assets.js';

/**
 * The checkout page and the order's own page (PRD 9.5, 9.6), for a business with the Phase 4 store, in the seller's brand
 * only (S-71). Guest checkout is the default (S-93): no sign-in is asked for. A signed-in shopper's default address is
 * chosen for them (S-13). Every amount on the page comes from the server's quote.
 *
 * The order page is found by its unguessable token. Paying, waiting, success, failure and cancelled are all states of it
 * (S-74). A Phase 0 order (flow 'manual') is still drawn by the Phase 0 page in legacy.js.
 */
const STATE_OPTIONS = Object.entries(INDIAN_STATES).sort((a, b) => a[1].localeCompare(b[1]));
const KIND_LABEL = { home: 'Home', work: 'Work', other: 'Other' };

async function savedAddresses(db, shopper) {
  if (!shopper) return [];
  return db.query('SELECT * FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY is_default DESC, id LIMIT 20', [tenantId(), shopper.id]);
}

async function noticeVersion(platform) {
  if (!platform.consent?.built) return 1;
  try {
    return (await platform.consent.notice())?.version ?? 1;
  } catch {
    return 1;
  }
}

const errorFor = (name) => html`<span class="error" data-field-error="${name}" hidden></span>`;

function addressFields(shopper) {
  return html`<div class="stack" data-address-fields>
<label>Full name <input name="name" autocomplete="name" maxlength="80" required value="${shopper?.name ?? ''}">${errorFor('name')}</label>
<label>Mobile number <input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" required value="${shopper?.phone ?? ''}">${errorFor('phone')}</label>
<label>Address <input name="line1" autocomplete="address-line1" maxlength="200" required>${errorFor('line1')}</label>
<label>Area, street (optional) <input name="line2" autocomplete="address-line2" maxlength="200"></label>
<label>Landmark (optional) <input name="landmark" maxlength="120"></label>
<div class="two"><label>City <input name="city" autocomplete="address-level2" maxlength="60" required>${errorFor('city')}</label>
<label>PIN code <input name="pincode" inputmode="numeric" autocomplete="postal-code" maxlength="6" pattern="[1-9][0-9]{5}" required>${errorFor('pincode')}</label></div>
<label>State <select name="stateCode" required><option value="">Pick your state</option>${STATE_OPTIONS.map(([code, name]) => html`<option value="${String(code).padStart(2, '0')}">${name}</option>`)}</select>${errorFor('stateCode')}</label>
</div>`;
}

function savedChoice(addresses) {
  if (!addresses.length) return '';
  const chosen = addresses.find((a) => a.is_default) ?? addresses[0];
  return html`<fieldset class="stack" style="border:0;padding:0;margin:0"><legend class="small">Deliver to</legend>
${addresses.map((a) => html`<label class="check"><input type="radio" name="addressId" value="${a.id}" data-phone="${a.phone}"${a.id === chosen.id ? raw(' checked') : ''}><span><b>${a.name}</b> · ${KIND_LABEL[a.kind] ?? ''}${a.is_default ? ' · Default' : ''}<br><span class="muted small">${[a.line1, a.line2, a.city, INDIAN_STATES[a.state_code] ?? '', a.pincode].filter(Boolean).join(', ')}</span></span></label>`)}
<label class="check"><input type="radio" name="addressId" value="new"><span>Use a new address</span></label></fieldset>`;
}

const totalRow = (name, label, hidden = false, grand = false) =>
  html`<div data-row="${name}" style="display:contents"${hidden ? raw(' hidden') : ''}><span${grand ? raw(' class="grand"') : ''}>${label}</span><span${grand ? raw(' class="grand"') : ''} data-amount></span></div>`;

function checkoutMain({ shopper, addresses }) {
  const terms = policyLinks().filter((l) => !l.href.endsWith('/privacy'));
  return ({ theme }) => html`<div data-checkout-page>
${section({ theme, id: 'checkout-h', kicker: 'Checkout', title: 'Your order', body: html`
<p class="notice-box" data-empty hidden>Your bag is empty. <a href="/shop">Keep shopping</a></p>
<form class="stack" data-checkout-form novalidate>
<div class="panel"><ul class="lines" data-lines></ul><p class="notice-box" data-notices hidden></p></div>
<div class="panel"><h2 style="font-size:20px">Delivery</h2>
${savedChoice(addresses)}
${addressFields(shopper)}
<label>Email for your receipt (optional) <input name="email" type="email" autocomplete="email" maxlength="254" value="${shopper?.email ?? ''}">${errorFor('email')}</label>
</div>
<div class="panel"><h2 style="font-size:20px">Pay with</h2>
<label class="check"><input type="radio" name="paymentMode" value="prepaid"><span>UPI, card or netbanking<br><span class="muted small" data-mode-reason="prepaid" hidden></span></span></label>
<label class="check"><input type="radio" name="paymentMode" value="cod"><span>Cash on delivery<br><span class="muted small">We’ll send a code on WhatsApp to confirm your number.</span><br><span class="muted small" data-mode-reason="cod" hidden></span></span></label>
<label class="check"><input type="radio" name="paymentMode" value="part_advance"><span>Pay part now, the rest on delivery<br><span class="muted small" data-mode-reason="part_advance" hidden></span></span></label>
${errorFor('paymentMode')}
</div>
<div class="panel"><label>Discount code <span class="row"><input name="couponCode" maxlength="40" autocomplete="off" style="flex:1;text-transform:uppercase"><button class="btn" type="button" data-apply-coupon>Apply</button></span></label>
<p class="small" data-coupon-message hidden></p>${errorFor('couponCode')}</div>
<div class="panel"><div class="totals">
${totalRow('subtotal', 'Items')}${totalRow('discount', 'Discount', true)}${totalRow('loyalty', 'Points', true)}${totalRow('shipping', 'Delivery')}${totalRow('codFee', 'Cash on delivery fee', true)}
${totalRow('total', 'Total', false, true)}
${totalRow('advance', 'Pay now', true)}${totalRow('balance', 'Pay on delivery', true)}${totalRow('tax', 'Includes GST', true)}
</div></div>
<div class="panel">
<label class="check"><input type="checkbox" name="acceptTerms" required><span>I accept the ${terms.map((l, i) => html`${i ? (i === terms.length - 1 ? ' and ' : ', ') : ''}<a href="${l.href}">${l.label.toLowerCase()}</a>`)} policies.</span></label>
<label class="check"><input type="checkbox" name="updatesWhatsapp"><span>Send me order updates on WhatsApp</span></label>
<label class="check"><input type="checkbox" name="updatesEmail"><span>Send me order updates by email</span></label>
<label class="check"><input type="checkbox" name="offersWhatsapp"><span>Send me offers on WhatsApp</span></label>
<label class="check"><input type="checkbox" name="offersEmail"><span>Send me offers by email</span></label>
${shopper ? html`<label class="check"><input type="checkbox" name="saveDetails"><span>Save this address to my account</span></label>` : ''}
<p class="small muted"><a href="/policies/privacy">How we use your details</a></p>
</div>
<p class="error" data-error role="alert" hidden></p>
<div class="panel" data-verify hidden><h2 style="font-size:20px">Confirm your number</h2><p class="small" data-verify-status role="status"></p>
<label>6-digit code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"></label>
<div class="row"><button class="btn" type="button" data-verify-submit>Confirm and place order</button><button class="chip" type="button" data-verify-resend>Send a new code</button><button class="chip" type="button" data-verify-online>Pay online instead</button></div></div>
<button class="btn wide" type="submit" data-place>Place order</button>
</form>` })}
</div>`;
}

// ---- the order page ----

function orderState(order, latestPayment) {
  const total = formatRupees(Number(order.total_paise));
  if (order.fulfilment_status === 'cancelled') {
    return order.cancel_reason === 'hold_expired'
      ? { title: 'Order cancelled', body: 'The payment wasn’t completed in time, so this order was cancelled. If money left your account, it will come back to you.' }
      : { title: 'Order cancelled', body: Number(order.paid_paise) > Number(order.refunded_paise) ? 'This order was cancelled. Your money is being refunded.' : 'This order was cancelled.' };
  }
  if (order.hold_reason === 'paid_out_of_stock') return { title: 'Payment received', body: 'We have your payment, but an item ran out. We’ll be in touch about it shortly.' };
  if (order.fulfilment_status === 'pending') {
    const amount = order.payment_mode === 'part_advance' ? formatRupees(Number(order.advance_paise)) : total;
    if (latestPayment?.status === 'failed') return { title: 'Payment didn’t go through', body: `No order is confirmed yet. You can try paying ${amount} again.`, pay: true };
    return { title: 'Waiting for payment', body: `Pay ${amount} to confirm your order.`, pay: true };
  }
  if (order.fulfilment_status === 'delivered') return { title: 'Delivered', body: 'Your order was delivered. Thank you for shopping with us.' };
  if (['shipped', 'out_for_delivery'].includes(order.fulfilment_status)) return { title: order.fulfilment_status === 'shipped' ? 'On its way' : 'Out for delivery', body: 'Your order has left us.' };
  if (['rto_initiated', 'rto_delivered'].includes(order.fulfilment_status)) return { title: 'Returning to us', body: 'This parcel couldn’t be delivered and is coming back to us.' };
  if (order.payment_status === 'cod_due') return { title: 'Order confirmed', body: `Pay ${formatRupees(Number(order.balance_paise))} in cash when it arrives.` };
  if (order.payment_status === 'advance_paid') return { title: 'Order confirmed', body: `We have your ${formatRupees(Number(order.advance_paise))}. Pay ${formatRupees(Number(order.balance_paise))} when it arrives.` };
  return { title: 'Order confirmed', body: 'Thank you! We’re getting your order ready.' };
}

function orderMain({ order, items, state, canCancel }) {
  const address = order.shipping_address ?? {};
  const row = (label, paise, show = true) => (show ? html`<span>${label}</span><span>${formatRupees(Number(paise))}</span>` : '');
  return ({ theme }) => html`<div data-order-page data-token="${order.public_token}" data-number="${order.order_number}">
${section({ theme, id: 'order-h', kicker: `Order ${order.order_number}`, title: state.title, body: html`<p>${state.body}</p>
${state.pay ? html`<button class="btn wide" type="button" data-pay>Pay now</button><p class="error" data-pay-error hidden></p>` : ''}
<div class="panel"><ul class="lines">${items.map((i) => html`<li class="line">${safeHref(i.image) ? html`<img src="${safeHref(i.image)}" alt="" width="64" height="76">` : html`<span class="ph"></span>`}<div><b>${i.name}</b><div class="muted small">${[i.option_value, `Qty ${i.qty}`].filter(Boolean).join(' · ')}</div></div><b>${formatRupees(Number(i.price_paise) * i.qty)}</b></li>`)}</ul></div>
<div class="panel"><div class="totals">
${row('Items', order.subtotal_paise)}${row('Discount', -Number(order.discount_paise), Number(order.discount_paise) > 0)}${row('Points', -Number(order.loyalty_paise), Number(order.loyalty_paise) > 0)}
<span>Delivery</span><span>${Number(order.shipping_paise) ? formatRupees(Number(order.shipping_paise)) : 'Free'}</span>
${row('Cash on delivery fee', order.cod_fee_paise, Number(order.cod_fee_paise) > 0)}
<span class="grand">Total</span><span class="grand">${formatRupees(Number(order.total_paise))}</span>
${row('Paid online', order.advance_paise, order.payment_mode === 'part_advance')}${row('Pay on delivery', order.balance_paise, Number(order.balance_paise) > 0)}
</div></div>
<div class="panel"><h2 style="font-size:18px">Delivering to</h2><p>${address.name ?? order.customer_name}<br>${[address.line1, address.line2, address.landmark].filter(Boolean).join(', ')}<br>${[address.city, INDIAN_STATES[address.stateCode] ?? order.state, address.pincode ?? order.pincode].filter(Boolean).join(', ')}</p></div>
${canCancel ? html`<button class="chip" type="button" data-cancel>Cancel this order</button><p class="error" data-cancel-error hidden></p>` : ''}
<a class="btn wide" href="/shop">Keep shopping</a>` })}
</div>`;
}

/** The order page's two buttons. Paying again is the payments module's call; cancelling is the orders module's. */
const ORDER_JS = `(() => {
  const root = document.querySelector('[data-order-page]');
  const B = window.StoreBag;
  if (!root || !B) return;
  const pay = root.querySelector('[data-pay]');
  if (pay) pay.addEventListener('click', async () => {
    pay.disabled = true;
    const res = await B.api('POST', '/api/store/orders/' + encodeURIComponent(root.dataset.token) + '/retry', {});
    const box = root.querySelector('[data-pay-error]');
    if (res.ok && res.data.gateway && typeof window.StorePay?.open === 'function') return window.StorePay.open(res.data.gateway, root.dataset.token);
    if (res.ok && res.data.next === 'done') return location.reload();
    box.textContent = res.data.error || 'Payment isn’t available right now. Please try again in a few minutes.';
    box.hidden = false;
    pay.disabled = false;
  });
  const cancel = root.querySelector('[data-cancel]');
  if (cancel) cancel.addEventListener('click', async () => {
    if (!confirm('Cancel this order?')) return;
    const res = await B.api('POST', '/api/store/orders/' + encodeURIComponent(root.dataset.number) + '/cancel', {});
    if (res.ok) return location.reload();
    const box = root.querySelector('[data-cancel-error]');
    box.textContent = res.data.error || 'This order can’t be cancelled now.';
    box.hidden = false;
  });
})();`;
export const ORDER_SCRIPT = '/store/order.js';

export function checkoutPages(ctx) {
  const { db, repos, platform } = ctx;
  const r = express.Router();

  r.get(CHECKOUT_SCRIPT, async (req, res, next) => {
    if (!(await storeOn(repos))) return next();
    res.set('Cache-Control', 'public, max-age=3600').type('text/javascript').send(CHECKOUT_JS);
  });
  r.get(ORDER_SCRIPT, async (req, res, next) => {
    if (!(await storeOn(repos))) return next();
    res.set('Cache-Control', 'public, max-age=3600').type('text/javascript').send(ORDER_JS);
  });

  r.get(STORE_ROUTES.checkout.path, async (req, res, next) => {
    try {
      if (!(await storeOn(repos))) return next();
      const shopper = await shopperFrom(req, db);
      const [addresses, version] = await Promise.all([savedAddresses(db, shopper), noticeVersion(platform)]);
      res.set('Cache-Control', 'no-store');
      return await sendStorePage(ctx, req, res, {
        kind: 'checkout', ref: 'checkout', title: 'Checkout', scripts: [CHECKOUT_SCRIPT],
        data: { noticeVersion: version }, main: checkoutMain({ shopper, addresses }),
      });
    } catch (err) {
      return next(err);
    }
  });

  r.get(STORE_ROUTES.order.path, async (req, res, next) => {
    try {
      if (!(await storeOn(repos))) return next();
      const token = String(req.params.token ?? '');
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return sendStoreNotFound(ctx, req, res, 'We couldn’t find that order.');
      const [order] = await db.query('SELECT * FROM orders WHERE tenant_id = $1 AND public_token = $2 AND erased_at IS NULL', [tenantId(), token]);
      if (!order) return sendStoreNotFound(ctx, req, res, 'We couldn’t find that order.');
      if (order.flow !== 'checkout') return next(); // a Phase 0 order keeps its own page
      const shopper = await shopperFrom(req, db);
      const [items, [latest]] = await Promise.all([
        db.query('SELECT name, image, option_value, qty, price_paise FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenantId(), order.id]),
        db.query('SELECT status FROM payments WHERE tenant_id = $1 AND order_id = $2 ORDER BY id DESC LIMIT 1', [tenantId(), order.id]),
      ]);
      const canCancel = Boolean(shopper && order.shopper_id === shopper.id && canCancelBeforeShipment(order));
      res.set('Cache-Control', 'no-store');
      return await sendStorePage(ctx, req, res, {
        kind: 'checkout', ref: 'order', title: `Order ${order.order_number}`, scripts: [ORDER_SCRIPT],
        main: orderMain({ order, items, state: orderState(order, latest), canCancel }),
      });
    } catch (err) {
      return next(err);
    }
  });

  return r;
}

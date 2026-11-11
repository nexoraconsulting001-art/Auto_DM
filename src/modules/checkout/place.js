import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/errors.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { log, reportError } from '../../platform/log.js';
import { visitorIdFrom } from '../../platform/visitor.js';
import { tenantId } from '../../tenancy.js';
import { CouponUsedUpError, redeem } from '../coupons/rules.js';
import { OutOfStockError, commit, raiseLowStock, reserve } from '../inventory/stock.js';
import { changeOrder } from '../orders/state.js';
import { addressSnapshot, buildQuote, stateName, toE164 } from './quote.js';

/**
 * Placing an order (PRD 9.5): one transaction in which the product rows are locked, every amount is worked out again from
 * the database, stock is held, the coupon is counted and the order number is taken. Nothing the page sends is an amount.
 *
 *   placeOrder(ctx, req, body) -> { status, body: PlacedOrder }
 *
 * The same idempotency key again answers with the order it made (S-15), and two taps at once still make one: the second
 * insert meets orders_idempotency_idx and is answered with the first. Cash on delivery needs the phone proved first (S-94):
 * until it is, the answer is `verify_phone` and no order exists. Once the order has committed, nothing after it may tell
 * the shopper it failed, or they would order again: a failure starting the payment is reported, and the order page offers
 * the payment again.
 */
const ORDER_NUMBER = (storeName) => (String(storeName).match(/[A-Za-z0-9]+/g) || ['ORD']).map((w) => w[0]).join('').toUpperCase().slice(0, 4) || 'ORD';
const CHECKOUT_ACTOR = (shopper) => (shopper ? `shopper:${shopper.id}` : 'shopper');

export class CheckoutRefused extends ApiError {
  constructor(message, quote = null, fields) {
    super('conflict', message, { fields });
    this.quote = quote;
  }
}

/** Where the order came from (9.5): a landing page of this business, and UTM tags as they arrived, kept short. */
async function sourceOf(q, body) {
  let page = null;
  if (body.pageSlug) {
    [page] = await q.query('SELECT id, ig_media_id FROM reels WHERE tenant_id = $1 AND slug = $2', [tenantId(), String(body.pageSlug).slice(0, 120)]);
  }
  const utm = {};
  for (const [key, value] of Object.entries(body.utm ?? {})) {
    if (/^[a-z_]{1,40}$/.test(key) && Object.keys(utm).length < 10) utm[key] = String(value).replace(/[\0-\x1f\x7f]/g, '').slice(0, 200);
  }
  const medium = String(utm.utm_medium ?? utm.src ?? '').toLowerCase();
  const source = (medium === 'dm' || medium === 'bio' || medium === 'story' ? medium : String(utm.utm_source ?? '').toLowerCase()).replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  return { pageId: page?.id ?? null, reelId: page?.ig_media_id ?? null, source: source || (page ? 'page' : ''), utm };
}

/** The saved address by id (the shopper's own only), or the one typed in. Either way the order keeps a copy (S-14). */
async function addressFor(q, body, shopper) {
  if (body.addressId) {
    if (!shopper) throw new ApiError('validation_failed', 'Enter your delivery address.', { fields: { address: 'Enter your delivery address' } });
    const [row] = await q.query('SELECT * FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2 AND id = $3', [tenantId(), shopper.id, body.addressId]);
    if (!row) throw new ApiError('validation_failed', 'Pick one of your saved addresses, or enter a new one.', { fields: { addressId: 'Pick an address' } });
    return { name: row.name, phone: row.phone, line1: row.line1, line2: row.line2, landmark: row.landmark, city: row.city, stateCode: row.state_code, pincode: row.pincode };
  }
  if (!body.address) throw new ApiError('validation_failed', 'Enter your delivery address.', { fields: { address: 'Enter your delivery address' } });
  const phone = toE164(body.address.phone);
  if (!phone) throw new ApiError('validation_failed', 'Enter a 10-digit mobile number.', { fields: { 'address.phone': 'Enter a 10-digit mobile number' } });
  if (!stateName(body.address.stateCode)) throw new ApiError('validation_failed', 'Pick your state.', { fields: { 'address.stateCode': 'Pick your state' } });
  return { ...body.address, phone };
}

/** Has this phone been proved for this checkout? A shopper signed in with this verified number has; otherwise the cash-on-delivery code (9.3). */
async function phoneProved(ctx, { phone, checkoutKey, shopper }) {
  if (shopper?.phoneVerified && shopper.phone && toE164(shopper.phone) === phone) return true;
  const check = ctx.shoppers?.otps?.codVerified ?? ctx.shoppers?.codVerified;
  if (typeof check !== 'function') return false;
  return Boolean(await check({ phone, checkoutKey }));
}

const placed = (order, next, gateway = null) => ({ orderNumber: order.order_number, token: order.public_token, next, gateway });
const nextFor = (order) => (order.payment_mode === 'cod' ? 'done' : order.payment_status === 'unpaid' && order.fulfilment_status === 'pending' ? 'pay' : 'done');

async function existing(db, key) {
  const [order] = await db.query('SELECT * FROM orders WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId(), key]);
  return order ?? null;
}

/** The order this key already made, if it was made for this phone. Another phone gets nothing back for a key it didn't make. */
function sameAttempt(order, phone) {
  if (!order) return null;
  if (order.phone !== phone) throw new ApiError('conflict', 'This checkout was already used. Refresh the page and try again.');
  return order;
}

async function startPayment(ctx, order, req) {
  if (order.payment_mode === 'cod' || typeof ctx.payments?.start !== 'function') return null;
  try {
    const started = await ctx.payments.start(order.id, { baseUrl: `${req.protocol}://${req.get('host')}`, actor: 'system' });
    return started?.gateway ?? null;
  } catch (err) {
    reportError(err, { msg: 'checkout.payment_start_failed', orderId: order.id });
    return null;
  }
}

export async function placeOrder(ctx, req, body) {
  const { db, platform, config } = ctx;
  const hit = await platform.rateLimit.hit('order_attempts', req.ip ?? '', STORE_LIMITS.orderAttempts);
  if (!hit.allowed) {
    const err = new ApiError('rate_limited', 'Too many attempts. Please wait a few minutes and try again.');
    err.retryAfterMs = hit.retryAfterMs;
    throw err;
  }
  const shopper = req.shopper ?? null;
  const address = await addressFor(db, body, shopper);
  const phone = address.phone;

  const before = sameAttempt(await existing(db, body.idempotencyKey), phone);
  if (before) return { status: 200, body: placed(before, nextFor(before), await startPayment(ctx, before, req)) };

  if (body.paymentMode === 'cod' && !(await phoneProved(ctx, { phone, checkoutKey: body.idempotencyKey, shopper }))) {
    return { status: 200, body: { orderNumber: '', token: '', next: 'verify_phone', gateway: null } };
  }

  const source = await sourceOf(db, body);
  const visitorId = visitorIdFrom(req);
  const settings = await ctx.repos.settings.getAll();
  let low = [];
  let order;
  try {
    order = await db.tx(async (t) => {
      const priced = await buildQuote(t, ctx, {
        lines: body.lines, address, phone, paymentMode: body.paymentMode, couponCode: body.couponCode, redeemPoints: body.redeemPoints, shopperId: shopper?.id ?? null, lock: true,
      });
      const { quote, lines } = priced;
      // The order is exactly what the shopper was shown, or it is not placed: a line that changed is refused with the new quote.
      if (priced.priced.some((l) => l.state !== 'ok')) throw new CheckoutRefused(priced.priced.some((l) => l.state === 'sold_out') ? 'Sold out. Your bag has been updated.' : 'Your bag has changed. Please check it and try again.', quote);
      if (!quote.serviceable) throw new CheckoutRefused('We don’t deliver to this PIN code yet.', quote, { 'address.pincode': 'Not deliverable' });
      const mode = quote.paymentModes.find((m) => m.mode === body.paymentMode);
      if (!mode?.available) throw new CheckoutRefused(mode?.reason || 'Choose another way to pay.', quote, { paymentMode: mode?.reason || 'Not available' });
      if (priced.couponRefused) throw new CheckoutRefused(priced.couponRefused.message, quote, { couponCode: priced.couponRefused.message });
      if (body.redeemPoints > 0 && quote.pointsUsed === 0) throw new CheckoutRefused('Points can’t be used on this order. Remove them to continue.', quote, { redeemPoints: 'Not available' });

      const prepaid = body.paymentMode !== 'cod';
      const holdUntil = prepaid ? new Date(Date.now() + priced.options.holdMinutes * 60_000) : null;
      const [{ n }] = await t.query('UPDATE tenants SET next_order_number = next_order_number + 1 WHERE id = $1 RETURNING next_order_number - 1 AS n', [tenantId()]);
      const snapshot = addressSnapshot(address);
      const [created] = await t.query(
        `INSERT INTO orders (tenant_id, order_number, public_token, flow, payment_mode, reel_id, page_id, source, utm, user_id, shopper_id, visitor_id,
           customer_name, phone, email, address, city, state, pincode, shipping_address,
           subtotal_paise, discount_paise, loyalty_paise, shipping_paise, cod_fee_paise, tax_paise, total_paise, advance_paise, balance_paise,
           coupon_id, coupon_code, loyalty_points, idempotency_key, terms_accepted_at, consent_notice_version, hold_expires_at)
         VALUES ($1, $2, $3, 'checkout', $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb,
           $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, now(), $33, $34) RETURNING *`,
        [tenantId(), `${ORDER_NUMBER(settings.store_name)}-${n}`, crypto.randomBytes(16).toString('base64url'), body.paymentMode,
          source.reelId, source.pageId, source.source, JSON.stringify(source.utm), req.user?.role === 'customer' ? req.user.id : null, shopper?.id ?? null, visitorId,
          address.name, phone, body.email ?? '', [address.line1, address.line2, address.landmark].filter(Boolean).join(', ').slice(0, 300), address.city, stateName(address.stateCode), address.pincode,
          JSON.stringify(snapshot), quote.subtotalPaise, quote.discountPaise, quote.loyaltyPaise, quote.shippingPaise, quote.codFeePaise, quote.taxPaise, quote.totalPaise,
          quote.advancePaise, quote.balancePaise, priced.coupon?.coupon.id ?? null, priced.coupon?.code ?? '', quote.pointsUsed, body.idempotencyKey,
          body.consent.noticeVersion, holdUntil],
      );

      const items = [];
      for (const line of lines) {
        const [item] = await t.query(
          `INSERT INTO order_items (tenant_id, order_id, product_id, variant_id, name, image, price_paise, option_value, qty, sku, hsn_code, gst_rate_bp, discount_paise, tax_paise, weight_grams)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
          [tenantId(), created.id, line.productId, line.variantId ?? null, line.name, line.image, line.unitPaise, line.option, line.qty, line.sku, line.hsnCode, line.gstRateBp,
            line.discountPaise, line.taxPaise, line.weightGrams],
        );
        items.push({ orderItemId: item.id, productId: line.productId, variantId: line.stockVariantId, qty: line.qty });
      }
      await reserve(t, { orderId: created.id, items, expiresAt: holdUntil });
      if (priced.coupon) {
        const saved = priced.coupon.freeShipping ? priced.deliveryFee : priced.coupon.discountPaise;
        await redeem(t, { coupon: priced.coupon.coupon, orderId: created.id, shopperId: shopper?.id ?? null, phone, discountPaise: saved, config });
      }
      if (quote.pointsUsed > 0) await ctx.loyalty.redeem(t, { shopperId: shopper.id, orderId: created.id, points: quote.pointsUsed, valuePaise: quote.loyaltyPaise });

      let result = created;
      if (body.paymentMode === 'cod') {
        // Cash on delivery is confirmed when placed, and its stock is taken at once (9.12).
        ({ order: result } = await changeOrder(t, created.id, { payment: 'cod_due', fulfilment: 'new', actor: CHECKOUT_ACTOR(shopper), reason: 'Cash on delivery, phone verified' }));
        ({ low } = await commit(t, created.id, { actor: CHECKOUT_ACTOR(shopper), events: ctx.orderEvents }));
      }
      if (platform.consent?.built) {
        const c = body.consent;
        await platform.consent.record({
          subject: { shopperId: shopper?.id, phone, email: body.email || undefined },
          choices: [
            { purpose: 'fulfilment', granted: true },
            { purpose: 'order_updates', channel: 'whatsapp', granted: c.orderUpdates.whatsapp }, { purpose: 'order_updates', channel: 'email', granted: c.orderUpdates.email },
            { purpose: 'marketing', channel: 'whatsapp', granted: c.marketing.whatsapp }, { purpose: 'marketing', channel: 'email', granted: c.marketing.email },
          ],
          noticeVersion: c.noticeVersion, source: 'checkout', orderId: created.id,
        }, t);
      }
      return result;
    });
  } catch (err) {
    if (err instanceof OutOfStockError) throw new CheckoutRefused('Sold out. Someone else just bought the last one.', null);
    if (err instanceof CouponUsedUpError) throw new CheckoutRefused('This code has been used up.', null, { couponCode: 'This code has been used up' });
    // The same key placed at the same moment: the other attempt made the order, so this one answers with it.
    if (err?.code === '23505' && String(err.constraint ?? err.message).includes('orders_idempotency_idx')) {
      const made = sameAttempt(await existing(db, body.idempotencyKey), phone);
      if (made) return { status: 200, body: placed(made, nextFor(made), await startPayment(ctx, made, req)) };
    }
    throw err;
  }

  // Committed. From here on nothing may answer a failure.
  ctx.orderEvents?.kick();
  log.info('checkout.placed', { orderId: order.id, mode: order.payment_mode });
  await raiseLowStock(ctx.repos.alerts, low);
  if (body.saveDetails && shopper && body.address && typeof ctx.shoppers?.addresses?.create === 'function') {
    await ctx.shoppers.addresses.create(shopper.id, body.address).catch((err) => reportError(err, { msg: 'checkout.save_address_failed', orderId: order.id }));
  }
  const gateway = await startPayment(ctx, order, req);
  return { status: 201, body: placed(order, nextFor(order), gateway) };
}

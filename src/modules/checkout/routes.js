import express from 'express';
import { CheckoutPlace, CheckoutQuote, PlacedOrder, Quote, STORE_ROUTES } from '../../contracts/store-routes.js';
import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { checkEmailLength, parseBody, storeCall } from '../storefront/http.js';
import { placeOrder } from './place.js';
import { buildQuote, toE164 } from './quote.js';

/**
 * The checkout's JSON calls (PRD 9.5). Both take lines, an address, a way of paying and codes, never an amount, and the
 * bodies are strict, so a price or a total in a request is refused (S-05).
 *
 *   POST /api/store/checkout/quote   every amount, worked out by the server. Changes nothing.
 *   POST /api/store/checkout         places the order (place.js).
 */
async function quoteAddress(ctx, body, shopper) {
  if (body.address) return { ...body.address, phone: toE164(body.address.phone) ?? '' };
  if (body.addressId && shopper) {
    const [row] = await ctx.db.query('SELECT phone, pincode, state_code FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2 AND id = $3', [tenantId(), shopper.id, body.addressId]);
    if (row) return { phone: row.phone, pincode: row.pincode, stateCode: row.state_code };
  }
  return null;
}

export function checkoutRoutes(ctx) {
  const r = express.Router();

  r.post(STORE_ROUTES.checkoutQuote.path, storeCall(ctx, async (req) => {
    checkEmailLength(req.body);
    const body = parseBody(CheckoutQuote, req.body);
    const shopper = req.shopper;
    const address = await quoteAddress(ctx, body, shopper);
    const { quote } = await buildQuote(ctx.db, ctx, {
      lines: body.lines, address, phone: address?.phone || shopper?.phone || '', paymentMode: body.paymentMode, couponCode: body.couponCode,
      redeemPoints: body.redeemPoints, shopperId: shopper?.id ?? null,
    });
    return { body: Quote.parse(quote) };
  }));

  r.post(STORE_ROUTES.checkoutPlace.path, storeCall(ctx, async (req) => {
    checkEmailLength(req.body);
    const body = parseBody(CheckoutPlace, req.body);
    const out = await placeOrder(ctx, req, body);
    // The order is placed by now: an answer the schema doesn't like loses the payment hand-off, never the order.
    const parsed = PlacedOrder.safeParse(out.body);
    if (parsed.success) return { status: out.status, body: parsed.data };
    reportError(new Error('A placed order answer did not match PlacedOrder'), { msg: 'checkout.answer_invalid' });
    return { status: out.status, body: { ...PlacedOrder.parse({ ...out.body, gateway: null }) } };
  }));

  return r;
}

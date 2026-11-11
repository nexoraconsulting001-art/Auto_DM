import express from 'express';
import { ApiError } from '../../contracts/api/errors.js';
import { CartPut, PricedLine, STORE_ROUTES } from '../../contracts/store-routes.js';
import { visitorIdFrom } from '../../platform/visitor.js';
import { tenantId } from '../../tenancy.js';
import { html } from '../../views/html.js';
import { section } from '../../views/buyer/index.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { mergeLines, priceLines, publicLine } from '../checkout/pricing.js';
import { parseBody, shopperFrom, storeCall, storeOn } from '../storefront/http.js';
import { sendStorePage } from '../storefront/shell.js';
import { cartRepo } from './repo.js';

/**
 * PRD 9.2: the cart. The bag lives in the browser (src/modules/storefront/assets.js); once the shopper is signed in it is
 * mirrored here, so the same cart appears on a second device (S-06). It holds no prices: every line is priced from the catalog
 * each time it is shown (S-05), with what changed since the bag was filled.
 *
 *   GET /cart              the bag page, drawn from the browser's bag and the server's prices
 *   GET /api/store/cart    the signed-in shopper's cart, priced -> { lines: PricedLine[], notices }
 *   PUT /api/store/cart    the bag as it is now (CartPut): merged, 10 a line, 50 lines (S-04)
 *
 * order.created closes the shopper's cart, so the next bag starts a new one and no reminder follows an order.
 */
const pricedCart = async (db, lines) => {
  const priced = await priceLines(db, lines);
  return { lines: priced.lines.map((l) => PricedLine.parse(publicLine(l))), notices: priced.notices };
};

const signedInOnly = (req) => {
  if (!req.shopper) throw new ApiError('unauthorized', 'Sign in to keep your bag on every device.');
  return req.shopper;
};

export const cart = {
  name: 'cart',
  setup(ctx) {
    const carts = cartRepo(ctx.db);
    ctx.orderEvents.on('order.created', 'cart.close-on-order', async (event) => {
      const [order] = await ctx.db.query('SELECT shopper_id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), event.orderId]);
      if (order?.shopper_id) await carts.ordered(order.shopper_id);
    });
  },
  routes(app, ctx) {
    const carts = cartRepo(ctx.db);
    const r = express.Router();
    r.get(STORE_ROUTES.cartGet.path, storeCall(ctx, async (req) => {
      const shopper = signedInOnly(req);
      return { body: await pricedCart(ctx.db, await carts.lines(shopper.id)) };
    }));
    r.put(STORE_ROUTES.cartPut.path, storeCall(ctx, async (req) => {
      const body = parseBody(CartPut, req.body);
      const shopper = signedInOnly(req);
      const kept = await carts.replace(shopper.id, body.lines, { visitorId: visitorIdFrom(req) });
      const answer = await pricedCart(ctx.db, kept);
      if (mergeLines(body.lines).some((l) => l.qty > STORE_LIMITS.maxQtyPerLine)) answer.notices.unshift(`You can buy up to ${STORE_LIMITS.maxQtyPerLine} of one item. We kept ${STORE_LIMITS.maxQtyPerLine}.`);
      return { body: answer };
    }));
    r.get(STORE_ROUTES.cartPage.path, async (req, res, next) => {
      if (!(await storeOn(ctx.repos))) return next();
      await shopperFrom(req, ctx.db);
      res.set('Cache-Control', 'no-store');
      return sendStorePage(ctx, req, res, {
        kind: 'checkout', ref: 'cart', title: 'Your bag',
        main: ({ theme }) => section({ theme, id: 'bag-h', kicker: 'Bag', title: 'Your bag', body: html`<div class="stack" data-cart-page>
<p class="notice-box" data-empty hidden>Your bag is empty. <a href="/shop">Start shopping</a></p>
<p class="notice-box" data-notices hidden role="status"></p>
<ul class="lines" data-lines></ul>
<div class="panel" data-summary hidden><div class="totals"><span>Items</span><span data-subtotal></span><span>Delivery</span><span data-shipping></span><span class="grand">Total</span><span class="grand" data-total></span></div>
<a class="btn wide" data-checkout href="/checkout">Checkout</a><p class="muted small">Prices are checked again when you place your order.</p></div>
</div>` }),
      });
    });
    app.use(r);
  },
};

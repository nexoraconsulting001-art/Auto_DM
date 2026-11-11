import express from 'express';
import QRCode from 'qrcode';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { buyerSettings } from '../brand/index.js';
import { reportError } from '../../platform/log.js';
import { visitorIdFrom } from '../../platform/visitor.js';
import { ValidationError } from '../../util.js';
import { checkoutPage, notFoundPage, orderPage } from '../../views/store.js';
import { storeOn } from '../storefront/http.js';

/**
 * The Phase 0 checkout, moved here from src/routes/store.js so the checkout track owns it and replaces it (PRD 9.5, 9.6):
 * signed-in shoppers only, one address, a manual UPI QR and "I've paid". Each order it places is flow 'manual'.
 * Two things changed in the move: the limit on order attempts is counted in the database, so it holds across instances
 * (S-18), and the traffic visit is tied to the order by the order event instead of by wrapping this route.
 *
 * A business with the Phase 4 store has no manual UPI flow (9.6): placing a manual order and "I've paid" answer as not found
 * there. Its older manual orders keep their page.
 */
const page = (res, view, status = 200) => res.status(status).type('html').send(String(view));
const notForStore = (repos) => async (req, res, next) => ((await storeOn(repos)) ? next('router') : next());

export function legacyCheckoutPages({ repos, auth }) {
  const r = express.Router();
  const notFound = async (req, res, message) =>
    page(res, notFoundPage({ settings: await buyerSettings(repos), user: req.user, message }), 404);

  // Browsing is open to everyone; placing an order needs an account.
  r.get('/checkout', auth.requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    page(res, checkoutPage({ settings: await buyerSettings(repos), user: req.user, csrf: req.csrf }));
  });

  r.get('/order/:token', async (req, res) => {
    const order = await repos.orders.getByToken(req.params.token);
    if (!order) return notFound(req, res, 'We couldn’t find that order.');
    const settings = await buyerSettings(repos);
    let qrSvg = '';
    let upiLink = '';
    if (order.status === 'awaiting_payment') {
      const upi = new URLSearchParams({
        pa: settings.upi_id,
        pn: settings.upi_payee || settings.store_name,
        am: (order.total_paise / 100).toFixed(2),
        cu: 'INR',
        tn: `Order ${order.order_number}`,
      });
      upiLink = `upi://pay?${upi}`;
      qrSvg = await QRCode.toString(upiLink, { type: 'svg', margin: 0, color: { dark: '#1d1b16', light: '#ffffff' } });
    }
    res.set('Cache-Control', 'no-store');
    page(res, orderPage({ settings, user: req.user, csrf: req.csrf, order, qrSvg, upiLink }));
  });

  r.post('/order/:token/paid', notForStore(repos), async (req, res) => {
    await repos.orders.markPaymentSubmitted(req.params.token);
    res.redirect(303, `/order/${encodeURIComponent(req.params.token)}`);
  });

  return r;
}

/** POST /api/orders. */
export function legacyOrderApi({ repos, platform, orderEvents }) {
  const r = express.Router();

  // At most 20 order attempts per address in 10 minutes, across every instance.
  const limit = async (req, res, next) => {
    const { allowed } = (await platform.rateLimit?.hit('order_attempts', req.ip, STORE_LIMITS.orderAttempts)) ?? { allowed: true };
    if (!allowed) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    next();
  };

  r.post('/orders', notForStore(repos), limit, async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Please log in to place your order.', login: '/login?next=/checkout' });
      const { items, customer, reelSlug, source } = req.body || {};
      const settings = await repos.settings.getAll();
      const reel = reelSlug ? await repos.reels.getStore(reelSlug) : null;
      const order = await repos.orders.create(
        { items, customer, reelId: reel?.ig_media_id ?? null, source: source || '', userId: req.user.id, visitorId: visitorIdFrom(req) },
        settings,
      );
      // The order is placed. Nothing after this may tell the shopper it failed, or they would order again.
      try {
        // Filled in at the shopper's next checkout.
        await repos.users.saveAddress(req.user.id, {
          name: order.customer_name, phone: order.phone, email: order.email, address: order.address,
          city: order.city, state: order.state, pincode: order.pincode,
        });
      } catch (err) {
        reportError(err, { msg: 'checkout.save_address_failed', orderId: order.id });
      }
      res.status(201).json({ token: order.public_token, orderNumber: order.order_number });
      orderEvents?.kick();
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  return r;
}
